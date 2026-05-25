/**
 * =============================================================================
 * Comprobantes de pago — envío por email + SMS
 * =============================================================================
 *
 * Se invoca después de que un pago se reconcilia exitosamente con Dentalink
 * (o, en defecto, después de webhook approved aunque la reconciliación esté
 * pendiente — el paciente recibe el comprobante igualmente).
 *
 * - Email: HTML básico con detalle del pago.
 * - SMS: mensaje corto en texto plano con monto y referencia.
 *
 * NUNCA falla la operación principal. Si envío falla, sólo loguea.
 */

import { db } from './db.js';
import { logger, maskEmail, maskPhone } from './logger.js';
import { audit } from './audit.js';
import { getEmailSender } from './email.js';
import { getSmsSender } from './sms.js';
import { dentalink } from './dentalink.js';
import { decrypt } from './crypto.js';

/**
 * Envía un OTP por SMS y email en paralelo. Usa Promise.allSettled —
 * si un canal falla, el otro sigue. Si falta un canal (ej. paciente sin
 * email), se omite. Nunca lanza: solo loguea y reporta qué canal salió.
 */
export async function sendOtpDual(params: {
  phone: string | null;
  email: string | null;
  code: string;
  firstName: string;
  ttlMinutes: number;
}): Promise<{ smsSent: boolean; emailSent: boolean }> {
  const { phone, email, code, firstName, ttlMinutes } = params;

  const smsBody = `Hola ${firstName}, tu código DentalKiosco es: ${code}. Vence en ${ttlMinutes} min. No lo compartas.`;
  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #0369a1;">Tu código de acceso</h2>
      <p>Hola ${firstName},</p>
      <p>Tu código de verificación para DentalKiosco es:</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px;
                  background: #f1f5f9; padding: 16px; text-align: center;
                  border-radius: 8px; margin: 16px 0;">${code}</div>
      <p style="color: #64748b; font-size: 14px;">
        Este código vence en ${ttlMinutes} minutos. Si no solicitaste este código, ignora este mensaje.
      </p>
    </div>
  `;
  const text = `Hola ${firstName}, tu código DentalKiosco es: ${code}. Vence en ${ttlMinutes} min.`;

  const tasks: Array<Promise<{ channel: 'sms' | 'email'; ok: boolean }>> = [];

  if (phone) {
    tasks.push(
      getSmsSender()
        .send(phone, smsBody)
        .then(() => ({ channel: 'sms' as const, ok: true }))
        .catch((err: unknown) => {
          logger.error({ err, to: maskPhone(phone) }, 'OTP SMS send failed');
          return { channel: 'sms' as const, ok: false };
        }),
    );
  }

  if (email) {
    tasks.push(
      getEmailSender()
        .send({
          to: email,
          subject: 'Tu código DentalKiosco',
          html,
          text,
        })
        .then(() => ({ channel: 'email' as const, ok: true }))
        .catch((err: unknown) => {
          logger.error({ err, to: maskEmail(email) }, 'OTP email send failed');
          return { channel: 'email' as const, ok: false };
        }),
    );
  }

  const results = await Promise.allSettled(tasks);
  let smsSent = false;
  let emailSent = false;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value.channel === 'sms') smsSent = r.value.ok;
      if (r.value.channel === 'email') emailSent = r.value.ok;
    }
  }
  return { smsSent, emailSent };
}

export interface SendReceiptParams {
  reference: string; // wompi_reference
  /**
   * Si true, no falla si el email o SMS falla — solo loguea.
   * Default: true.
   */
  silent?: boolean;
}

/**
 * Envía el comprobante de un pago aprobado al paciente.
 *
 * Idempotente: si ya se envió antes (`receipt_sent_at IS NOT NULL`), no-op.
 */
export async function sendPaymentReceipt(
  params: SendReceiptParams,
): Promise<{ emailSent: boolean; smsSent: boolean; skipped: boolean }> {
  const { reference } = params;

  // Buscar la transaction
  const txRes = await db.query<{
    id: string;
    status: string;
    amount_cop: string;
    dentalink_patient_id: string;
    dentalink_treatment_id: string | null;
    wompi_payment_method_type: string | null;
    wompi_transaction_id: string | null;
    approved_at: Date | null;
    receipt_sent_at: Date | null;
    patient_phone_masked: string | null;
    patient_email_masked: string | null;
  }>(
    `SELECT id, status, amount_cop, dentalink_patient_id, dentalink_treatment_id,
            wompi_payment_method_type, wompi_transaction_id, approved_at,
            receipt_sent_at, patient_phone_masked, patient_email_masked
     FROM transactions
     WHERE wompi_reference = $1`,
    [reference],
  );
  if (txRes.rows.length === 0) {
    logger.warn({ reference }, 'sendPaymentReceipt: transaction not found');
    return { emailSent: false, smsSent: false, skipped: true };
  }
  const tx = txRes.rows[0]!;

  if (tx.status !== 'approved') {
    logger.info({ reference, status: tx.status }, 'sendPaymentReceipt: status not approved, skip');
    return { emailSent: false, smsSent: false, skipped: true };
  }

  if (tx.receipt_sent_at) {
    return { emailSent: false, smsSent: false, skipped: true };
  }

  // Obtener email/phone reales del paciente (vía Dentalink)
  // No los guardamos en BD por privacidad — sólo el masked.
  const dentalinkToken = await getDentalinkToken();
  let profile: { email?: string; celular?: string; nombre?: string } | null = null;
  try {
    profile = await dentalink.getPatientProfile(tx.dentalink_patient_id, dentalinkToken);
  } catch (err) {
    logger.warn({ err, reference }, 'sendPaymentReceipt: could not fetch patient profile');
  }

  if (!profile) {
    return { emailSent: false, smsSent: false, skipped: true };
  }

  // Datos del comprobante
  const clinicRes = await db.query<{ display_name: string; nit: string }>(
    `SELECT display_name, nit FROM clinic WHERE id = 1`,
  );
  const clinicName = clinicRes.rows[0]?.display_name ?? 'Clínica Dental';
  const clinicNit = clinicRes.rows[0]?.nit ?? '';

  const amountFmt = new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(Number(tx.amount_cop));

  const dateFmt = tx.approved_at
    ? tx.approved_at.toLocaleString('es-CO', {
        timeZone: 'America/Bogota',
        dateStyle: 'long',
        timeStyle: 'short',
      })
    : new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

  const methodLabel = friendlyPaymentMethod(tx.wompi_payment_method_type);

  // === Email ===
  let emailSent = false;
  if (profile.email) {
    try {
      const sender = getEmailSender();
      await sender.send({
        to: profile.email,
        subject: `Comprobante de pago — ${clinicName}`,
        html: renderReceiptHtml({
          clinicName,
          clinicNit,
          patientName: profile.nombre ?? '',
          amountFmt,
          reference,
          methodLabel,
          dateFmt,
          wompiTxId: tx.wompi_transaction_id ?? '',
        }),
        text: renderReceiptText({
          clinicName,
          patientName: profile.nombre ?? '',
          amountFmt,
          reference,
          methodLabel,
          dateFmt,
        }),
      });
      emailSent = true;
      logger.info(
        { reference, to: maskEmail(profile.email) },
        'Payment receipt email sent',
      );
    } catch (err) {
      logger.error({ err, reference }, 'Failed to send receipt email');
    }
  }

  // === SMS ===
  let smsSent = false;
  if (profile.celular) {
    try {
      const sender = getSmsSender();
      const smsBody = `${clinicName}: pago de ${amountFmt} recibido. Ref ${reference}. Método: ${methodLabel}. Gracias.`;
      await sender.send(profile.celular, smsBody.slice(0, 160)); // límite SMS estándar
      smsSent = true;
      logger.info(
        { reference, to: maskPhone(profile.celular) },
        'Payment receipt SMS sent',
      );
    } catch (err) {
      logger.error({ err, reference }, 'Failed to send receipt SMS');
    }
  }

  // === Marcar como enviado si al menos uno funcionó ===
  if (emailSent || smsSent) {
    await db.query(
      `UPDATE transactions
       SET receipt_sent_at = now(),
           receipt_channels = $1
       WHERE id = $2`,
      [
        [emailSent ? 'email' : null, smsSent ? 'sms' : null].filter(Boolean).join(','),
        tx.id,
      ],
    );

    await audit({
      actorType: 'system',
      actorId: null,
      action: 'payment.receipt_sent',
      resourceType: 'transaction',
      resourceId: reference,
      metadata: { email: emailSent, sms: smsSent },
      result: 'success',
    });
  } else {
    logger.warn({ reference }, 'Could not send receipt by any channel');
  }

  return { emailSent, smsSent, skipped: false };
}

// =============================================================================
// Helpers
// =============================================================================

function friendlyPaymentMethod(wompiType: string | null): string {
  if (!wompiType) return 'En línea';
  const map: Record<string, string> = {
    NEQUI: 'Nequi',
    PSE: 'PSE',
    CARD: 'Tarjeta',
    BANCOLOMBIA_TRANSFER: 'Transferencia Bancolombia',
    DAVIPLATA: 'Daviplata',
  };
  return map[wompiType] ?? wompiType;
}

interface ReceiptData {
  clinicName: string;
  clinicNit?: string;
  patientName: string;
  amountFmt: string;
  reference: string;
  methodLabel: string;
  dateFmt: string;
  wompiTxId?: string;
}

function renderReceiptHtml(data: ReceiptData): string {
  const escape = (s: string) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; color: #0f172a; line-height: 1.5; max-width: 600px; margin: 0 auto; padding: 2rem;">
  <div style="background: #0369a1; color: white; padding: 1.5rem; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 1.5rem;">${escape(data.clinicName)}</h1>
    ${data.clinicNit ? `<div style="opacity: 0.85; margin-top: 0.5rem;">NIT ${escape(data.clinicNit)}</div>` : ''}
  </div>

  <div style="background: white; padding: 2rem; border: 1px solid #e2e8f0; border-top: 0; border-radius: 0 0 8px 8px;">
    <h2 style="color: #0369a1; margin-top: 0;">Comprobante de pago</h2>
    <p>Hola${data.patientName ? ' <strong>' + escape(data.patientName) + '</strong>' : ''}, hemos recibido tu pago correctamente.</p>

    <table style="width: 100%; border-collapse: collapse; margin: 1.5rem 0;">
      <tr><td style="padding: 0.5rem 0; color: #64748b;">Monto pagado:</td><td style="padding: 0.5rem 0; text-align: right; font-weight: bold; font-size: 1.25rem;">${escape(data.amountFmt)}</td></tr>
      <tr><td style="padding: 0.5rem 0; color: #64748b;">Método:</td><td style="padding: 0.5rem 0; text-align: right;">${escape(data.methodLabel)}</td></tr>
      <tr><td style="padding: 0.5rem 0; color: #64748b;">Referencia:</td><td style="padding: 0.5rem 0; text-align: right; font-family: monospace;">${escape(data.reference)}</td></tr>
      <tr><td style="padding: 0.5rem 0; color: #64748b;">Fecha:</td><td style="padding: 0.5rem 0; text-align: right;">${escape(data.dateFmt)}</td></tr>
      ${data.wompiTxId ? `<tr><td style="padding: 0.5rem 0; color: #64748b;">ID Transacción:</td><td style="padding: 0.5rem 0; text-align: right; font-family: monospace; font-size: 0.85rem;">${escape(data.wompiTxId)}</td></tr>` : ''}
    </table>

    <p style="color: #64748b; font-size: 0.9rem; margin-top: 2rem;">
      Este comprobante es un soporte de tu pago en línea. Para el detalle contable o factura, comunícate con la recepción de la clínica.
    </p>
  </div>

  <div style="text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 1rem;">
    Pago procesado por Wompi · No respondas a este correo
  </div>
</body></html>`;
}

function renderReceiptText(data: Omit<ReceiptData, 'wompiTxId'>): string {
  return [
    `${data.clinicName} - Comprobante de pago`,
    '',
    data.patientName ? `Hola ${data.patientName},` : 'Hola,',
    'Hemos recibido tu pago correctamente.',
    '',
    `Monto: ${data.amountFmt}`,
    `Método: ${data.methodLabel}`,
    `Referencia: ${data.reference}`,
    `Fecha: ${data.dateFmt}`,
    '',
    'Este comprobante es un soporte de tu pago en línea.',
    'Para el detalle contable, comunícate con recepción.',
  ].join('\n');
}

// =============================================================================
// Dentalink token caching (compartido con otros módulos)
// =============================================================================

let cachedToken: { value: string | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};

async function getDentalinkToken(): Promise<string | null> {
  if (cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  const result = await db.query<{ dentalink_token_encrypted: Buffer | null }>(
    `SELECT dentalink_token_encrypted FROM clinic WHERE id = 1`,
  );
  const token = await decrypt(result.rows[0]?.dentalink_token_encrypted ?? null);
  cachedToken = { value: token, expiresAt: Date.now() + 30_000 };
  return token;
}
