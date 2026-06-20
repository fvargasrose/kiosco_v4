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
import { config } from './config.js';
import { logger, maskEmail, maskPhone } from './logger.js';
import { audit } from './audit.js';
import { getEmailSender, type EmailSender } from './email.js';
import { getSmsSender } from './sms.js';
import { dentalink } from './dentalink.js';
import { decrypt } from './crypto.js';

/**
 * Resuelve el destinatario del correo de notificación a la clínica.
 *
 * Regla: se usa el email configurado en el panel (`panel`). Si está vacío o
 * coincide con el remitente SMTP (`sender` → causaría un envío `from == to` que
 * algunos servidores cuelgan), se cae al alternativo del entorno
 * (`fallback` = `CORREO_NOTIFICACION`). Si tras el fallback el destinatario
 * sigue siendo el remitente, se devuelve `null` (no se envía: evita el loop
 * garantizado). Comparación case-insensitive.
 *
 * Función pura y exportada para poder testearla sin tocar el singleton config.
 */
export function resolveAdminEmail(
  panel: string | null,
  sender: string | null,
  fallback: string | null,
): string | null {
  const senderNorm = sender ? sender.toLowerCase() : null;
  const isSender = (addr: string) => senderNorm !== null && addr.toLowerCase() === senderNorm;

  let email = panel && panel.length > 0 ? panel : null;
  if (!email || isSender(email)) {
    email = fallback && fallback.length > 0 ? fallback : null;
  }
  if (!email || isSender(email)) return null;
  return email;
}

/**
 * Envía un email con un timeout duro. Un SMTP que se cuelga (p. ej. auto-entrega
 * `from == to`) no debe colgar la tarea indefinidamente: al expirar `ms` se
 * rechaza la promesa para que el `try/catch` del llamador deje rastro en logs.
 */
export async function sendWithTimeout(
  sender: EmailSender,
  msg: { to: string; subject: string; html: string; text?: string },
  ms: number,
): Promise<{ id: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Email send timeout tras ${ms}ms (to=${maskEmail(msg.to)})`)),
      ms,
    );
  });
  try {
    return await Promise.race([sender.send(msg), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

  // === Notificación al administrador — independiente del flujo del paciente ===
  // NUNCA debe lanzar — su try/catch garantiza que un fallo aquí no rompe
  // la idempotencia del envío al paciente (receipt_sent_at ya está persistido).
  try {
    await sendAdminPaymentNotification({
      tx,
      profile,
      reference,
      amountFmt,
      methodLabel,
      dateFmt,
      clinicName,
      clinicNit,
      dentalinkToken,
    });
  } catch (err) {
    logger.error({ err, reference }, 'Admin payment notification failed');
  }

  return { emailSent, smsSent, skipped: false };
}

// =============================================================================
// Envío del ENLACE de pago (modo kiosco) — antes de pagar
// =============================================================================

export interface SendPaymentLinkParams {
  to: string;
  patientName?: string;
  amountCop: number;
  url: string;
  expiresAt: Date;
}

/**
 * Envía por correo el ENLACE de pago temporal (no el comprobante). Se usa en
 * modo kiosco para que el paciente pague desde su propio celular sin teclear
 * datos en el equipo compartido. El correo deja claro que el enlace es temporal
 * y cuándo vence. Nunca lanza: devuelve false si falla.
 */
export async function sendPaymentLinkEmail(p: SendPaymentLinkParams): Promise<boolean> {
  const clinicRes = await db.query<{ display_name: string }>(
    `SELECT display_name FROM clinic WHERE id = 1`,
  );
  const clinicName = clinicRes.rows[0]?.display_name ?? 'Clínica Dental';

  const amountFmt = new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(p.amountCop);

  const minutes = Math.max(1, Math.round((p.expiresAt.getTime() - Date.now()) / 60_000));
  const expiresFmt = p.expiresAt.toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
  });

  try {
    const sender = getEmailSender();
    await sender.send({
      to: p.to,
      subject: `Tu enlace de pago — ${clinicName}`,
      html: renderPaymentLinkHtml({
        clinicName,
        patientName: p.patientName ?? '',
        amountFmt,
        url: p.url,
        minutes,
        expiresFmt,
      }),
      text: renderPaymentLinkText({
        clinicName,
        patientName: p.patientName ?? '',
        amountFmt,
        url: p.url,
        minutes,
        expiresFmt,
      }),
    });
    logger.info({ to: maskEmail(p.to), minutes }, 'Payment link email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: maskEmail(p.to) }, 'Failed to send payment link email');
    return false;
  }
}

// =============================================================================
// Notificación al administrador
// =============================================================================

interface AdminNotificationParams {
  tx: {
    id: string;
    amount_cop: string;
    dentalink_patient_id: string;
    dentalink_treatment_id: string | null;
    wompi_transaction_id: string | null;
    wompi_payment_method_type: string | null;
  };
  profile: { email?: string; celular?: string; nombre?: string } | null;
  reference: string;
  amountFmt: string;
  methodLabel: string;
  dateFmt: string;
  clinicName: string;
  clinicNit: string;
  dentalinkToken: string | null;
}

async function sendAdminPaymentNotification(p: AdminNotificationParams): Promise<void> {
  // ¿Hay email del admin configurado?
  const cfgRes = await db.query<{ notification_email: string | null }>(
    `SELECT notification_email FROM clinic WHERE id = 1`,
  );
  const panelEmail = cfgRes.rows[0]?.notification_email ?? null;
  // Panel primero; fallback a CORREO_NOTIFICACION si está vacío o == remitente
  // (evita el loop from==to que cuelga el envío). Ver resolveAdminEmail.
  const adminEmail = resolveAdminEmail(
    panelEmail,
    config.SENDER_EMAIL ?? null,
    config.CORREO_NOTIFICACION ?? null,
  );
  if (!adminEmail) return; // feature opcional — no es error

  // Resolver datos del tratamiento (best-effort). Si Dentalink no responde,
  // se envía el email con datos parciales — el admin sigue recibiendo la alerta.
  let treatment: { name: string; saldoAntes: number; saldoDespues: number } | null = null;
  if (p.tx.dentalink_treatment_id) {
    try {
      const treatments = await dentalink.getPatientTreatments(
        p.tx.dentalink_patient_id,
        p.dentalinkToken,
      );
      const t = treatments.find((x) => x.id === p.tx.dentalink_treatment_id);
      if (t) {
        const saldoDespues = t.saldo_pendiente;
        const saldoAntes = saldoDespues + Number(p.tx.amount_cop);
        treatment = { name: t.nombre, saldoAntes, saldoDespues };
      }
    } catch (err) {
      logger.warn(
        { err, reference: p.reference },
        'Admin notification: could not fetch treatment details',
      );
    }
  }

  const subject = `Comprobante de pago — ${p.clinicName} — ${p.amountFmt}`;
  const html = renderAdminNotificationHtml({
    clinicName: p.clinicName,
    clinicNit: p.clinicNit,
    patientName: p.profile?.nombre ?? '(desconocido)',
    patientEmailMasked: maskEmail(p.profile?.email) ?? '(sin email)',
    patientPhoneMasked: maskPhone(p.profile?.celular) ?? '(sin teléfono)',
    patientId: p.tx.dentalink_patient_id,
    amountFmt: p.amountFmt,
    reference: p.reference,
    methodLabel: p.methodLabel,
    dateFmt: p.dateFmt,
    wompiTxId: p.tx.wompi_transaction_id ?? '',
    treatmentId: p.tx.dentalink_treatment_id,
    treatmentName: treatment?.name ?? null,
    saldoAntes: treatment?.saldoAntes ?? null,
    saldoDespues: treatment?.saldoDespues ?? null,
  });
  const text = renderAdminNotificationText({
    clinicName: p.clinicName,
    patientName: p.profile?.nombre ?? '(desconocido)',
    patientEmailMasked: maskEmail(p.profile?.email) ?? '(sin email)',
    patientPhoneMasked: maskPhone(p.profile?.celular) ?? '(sin teléfono)',
    amountFmt: p.amountFmt,
    reference: p.reference,
    methodLabel: p.methodLabel,
    dateFmt: p.dateFmt,
    treatmentName: treatment?.name ?? null,
    saldoAntes: treatment?.saldoAntes ?? null,
    saldoDespues: treatment?.saldoDespues ?? null,
  });

  await sendWithTimeout(getEmailSender(), { to: adminEmail, subject, html, text }, 10000);
  logger.info({ reference: p.reference, to: maskEmail(adminEmail) }, 'Admin payment notification sent');
}

interface AdminHtmlData {
  clinicName: string;
  clinicNit: string;
  patientName: string;
  patientEmailMasked: string;
  patientPhoneMasked: string;
  patientId: string;
  amountFmt: string;
  reference: string;
  methodLabel: string;
  dateFmt: string;
  wompiTxId: string;
  treatmentId: string | null;
  treatmentName: string | null;
  saldoAntes: number | null;
  saldoDespues: number | null;
}

function renderAdminNotificationHtml(d: AdminHtmlData): string {
  const escape = (s: string) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

  const treatmentRows = d.treatmentName
    ? `
      <tr><td style="padding:.5rem 0;color:#64748b;">Tratamiento:</td><td style="padding:.5rem 0;text-align:right;">${escape(d.treatmentName)}</td></tr>
      ${d.saldoAntes !== null ? `<tr><td style="padding:.5rem 0;color:#64748b;">Saldo antes:</td><td style="padding:.5rem 0;text-align:right;">${escape(cop(d.saldoAntes))}</td></tr>` : ''}
      ${d.saldoDespues !== null ? `<tr><td style="padding:.5rem 0;color:#64748b;">Saldo después:</td><td style="padding:.5rem 0;text-align:right;font-weight:600;">${escape(cop(d.saldoDespues))}</td></tr>` : ''}
    `
    : d.treatmentId
      ? `<tr><td style="padding:.5rem 0;color:#64748b;">Tratamiento:</td><td style="padding:.5rem 0;text-align:right;font-family:monospace;font-size:.85rem;">${escape(d.treatmentId)} <em style="color:#94a3b8;">(detalle no disponible)</em></td></tr>`
      : `<tr><td style="padding:.5rem 0;color:#64748b;">Tratamiento:</td><td style="padding:.5rem 0;text-align:right;color:#94a3b8;">Pago sin tratamiento asociado</td></tr>`;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"></head>
<body style="font-family: system-ui, sans-serif; color:#0f172a; line-height:1.5; max-width:640px; margin:0 auto; padding:2rem; background:#f8fafc;">
  <div style="background:#0f766e; color:white; padding:1.5rem; border-radius:8px 8px 0 0;">
    <div style="font-size:.75rem; opacity:.85; text-transform:uppercase; letter-spacing:.1em;">Notificación al administrador</div>
    <h1 style="margin:.25rem 0 0; font-size:1.5rem;">Pago aprobado · ${escape(d.amountFmt)}</h1>
    <div style="opacity:.85; margin-top:.5rem;">${escape(d.clinicName)}${d.clinicNit ? ' · NIT ' + escape(d.clinicNit) : ''}</div>
  </div>

  <div style="background:white; padding:1.75rem; border:1px solid #e2e8f0; border-top:0;">
    <h2 style="color:#0f766e; margin-top:0; font-size:1.05rem; text-transform:uppercase; letter-spacing:.05em;">Paciente</h2>
    <table style="width:100%; border-collapse:collapse;">
      <tr><td style="padding:.5rem 0;color:#64748b;width:40%;">Nombre:</td><td style="padding:.5rem 0;text-align:right;">${escape(d.patientName)}</td></tr>
      <tr><td style="padding:.5rem 0;color:#64748b;">Email:</td><td style="padding:.5rem 0;text-align:right;font-family:monospace;font-size:.9rem;">${escape(d.patientEmailMasked)}</td></tr>
      <tr><td style="padding:.5rem 0;color:#64748b;">Teléfono:</td><td style="padding:.5rem 0;text-align:right;font-family:monospace;font-size:.9rem;">${escape(d.patientPhoneMasked)}</td></tr>
      <tr><td style="padding:.5rem 0;color:#64748b;">ID Dentalink:</td><td style="padding:.5rem 0;text-align:right;font-family:monospace;font-size:.85rem;">${escape(d.patientId)}</td></tr>
    </table>
  </div>

  <div style="background:white; padding:1.75rem; border:1px solid #e2e8f0; border-top:0;">
    <h2 style="color:#0f766e; margin-top:0; font-size:1.05rem; text-transform:uppercase; letter-spacing:.05em;">Pago</h2>
    <table style="width:100%; border-collapse:collapse;">
      <tr><td style="padding:.5rem 0;color:#64748b;width:40%;">Monto:</td><td style="padding:.5rem 0;text-align:right;font-weight:bold;font-size:1.15rem;">${escape(d.amountFmt)}</td></tr>
      <tr><td style="padding:.5rem 0;color:#64748b;">Método:</td><td style="padding:.5rem 0;text-align:right;">${escape(d.methodLabel)}</td></tr>
      <tr><td style="padding:.5rem 0;color:#64748b;">Referencia:</td><td style="padding:.5rem 0;text-align:right;font-family:monospace;">${escape(d.reference)}</td></tr>
      <tr><td style="padding:.5rem 0;color:#64748b;">Fecha:</td><td style="padding:.5rem 0;text-align:right;">${escape(d.dateFmt)}</td></tr>
      ${d.wompiTxId ? `<tr><td style="padding:.5rem 0;color:#64748b;">ID Wompi:</td><td style="padding:.5rem 0;text-align:right;font-family:monospace;font-size:.85rem;">${escape(d.wompiTxId)}</td></tr>` : ''}
    </table>
  </div>

  <div style="background:white; padding:1.75rem; border:1px solid #e2e8f0; border-top:0; border-radius:0 0 8px 8px;">
    <h2 style="color:#0f766e; margin-top:0; font-size:1.05rem; text-transform:uppercase; letter-spacing:.05em;">Tratamiento</h2>
    <table style="width:100%; border-collapse:collapse;">
      ${treatmentRows}
    </table>
  </div>

  <div style="text-align:center; color:#94a3b8; font-size:.75rem; margin-top:1rem;">
    Notificación automática · Datos del paciente parcialmente enmascarados por privacidad
  </div>
</body></html>`;
}

interface AdminTextData {
  clinicName: string;
  patientName: string;
  patientEmailMasked: string;
  patientPhoneMasked: string;
  amountFmt: string;
  reference: string;
  methodLabel: string;
  dateFmt: string;
  treatmentName: string | null;
  saldoAntes: number | null;
  saldoDespues: number | null;
}

function renderAdminNotificationText(d: AdminTextData): string {
  const cop = (n: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
  const lines = [
    `${d.clinicName} — Notificación al administrador`,
    `Pago aprobado: ${d.amountFmt}`,
    '',
    'Paciente:',
    `  Nombre:   ${d.patientName}`,
    `  Email:    ${d.patientEmailMasked}`,
    `  Teléfono: ${d.patientPhoneMasked}`,
    '',
    'Pago:',
    `  Monto:      ${d.amountFmt}`,
    `  Método:     ${d.methodLabel}`,
    `  Referencia: ${d.reference}`,
    `  Fecha:      ${d.dateFmt}`,
  ];
  if (d.treatmentName) {
    lines.push('', 'Tratamiento:', `  Nombre:         ${d.treatmentName}`);
    if (d.saldoAntes !== null)   lines.push(`  Saldo antes:    ${cop(d.saldoAntes)}`);
    if (d.saldoDespues !== null) lines.push(`  Saldo después:  ${cop(d.saldoDespues)}`);
  }
  return lines.join('\n');
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

interface PaymentLinkData {
  clinicName: string;
  patientName: string;
  amountFmt: string;
  url: string;
  minutes: number;
  expiresFmt: string;
}

function renderPaymentLinkHtml(data: PaymentLinkData): string {
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
  </div>

  <div style="background: white; padding: 2rem; border: 1px solid #e2e8f0; border-top: 0; border-radius: 0 0 8px 8px;">
    <h2 style="color: #0369a1; margin-top: 0;">Tu enlace de pago</h2>
    <p>Hola${data.patientName ? ' <strong>' + escape(data.patientName) + '</strong>' : ''}, usa el siguiente botón para pagar de forma segura desde tu celular.</p>

    <table style="width: 100%; border-collapse: collapse; margin: 1.5rem 0;">
      <tr><td style="padding: 0.5rem 0; color: #64748b;">Monto a pagar:</td><td style="padding: 0.5rem 0; text-align: right; font-weight: bold; font-size: 1.25rem;">${escape(data.amountFmt)}</td></tr>
    </table>

    <div style="text-align: center; margin: 1.5rem 0;">
      <a href="${escape(data.url)}" style="display: inline-block; background: #0369a1; color: white; text-decoration: none; padding: 0.85rem 2rem; border-radius: 8px; font-weight: bold; font-size: 1.05rem;">
        Pagar ahora
      </a>
    </div>

    <div style="background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; padding: 0.85rem 1rem; border-radius: 8px; font-size: 0.95rem;">
      ⏱️ <strong>Este enlace es temporal:</strong> vence en aproximadamente ${data.minutes} minutos (a las ${escape(data.expiresFmt)}). Si expira, vuelve a generarlo desde el kiosco.
    </div>

    <p style="color: #64748b; font-size: 0.85rem; margin-top: 1.5rem; word-break: break-all;">
      Si el botón no funciona, copia y pega este enlace:<br>${escape(data.url)}
    </p>
  </div>

  <div style="text-align: center; color: #94a3b8; font-size: 0.8rem; margin-top: 1rem;">
    Pago procesado por Wompi · No respondas a este correo
  </div>
</body></html>`;
}

function renderPaymentLinkText(data: PaymentLinkData): string {
  return [
    `${data.clinicName} - Tu enlace de pago`,
    '',
    data.patientName ? `Hola ${data.patientName},` : 'Hola,',
    'Usa este enlace para pagar de forma segura desde tu celular:',
    '',
    data.url,
    '',
    `Monto a pagar: ${data.amountFmt}`,
    `IMPORTANTE: el enlace es temporal y vence en ~${data.minutes} minutos (a las ${data.expiresFmt}).`,
    'Si expira, vuelve a generarlo desde el kiosco.',
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
