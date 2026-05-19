/**
 * =============================================================================
 * Routes: /me/payments/* y /webhooks/wompi
 * =============================================================================
 *
 * Flujo del Hito 7 (link-to-mobile):
 *
 *   1. POST /me/payments → crea transaction (status=pending) + Wompi payment link
 *      → retorna { url, qr_data, reference, expires_at } al kiosco
 *      → el kiosco muestra QR y un botón "Ya pagué"
 *
 *   2. GET /me/payments/:reference → polling del estado por el kiosco
 *      → mientras pending: el kiosco mantiene mostrando el QR
 *      → al ver approved: el kiosco confirma al paciente y vuelve a home
 *
 *   3. POST /webhooks/wompi → Wompi notifica cambios de estado
 *      → verificamos firma HMAC SHA256
 *      → actualizamos transactions
 *      → disparamos reconciliación con Dentalink (best-effort)
 *
 * Seguridad:
 *   - /me/payments/* requiere patient session (anti-IDOR: filtramos por patient_id del JWT)
 *   - /webhooks/wompi NO requiere auth (es público) pero verifica firma estricta
 *   - Anti-replay: rechaza webhooks con timestamp > 5 min de antigüedad
 *   - Idempotencia: misma reference + status = no-op
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink, DentalinkError } from '../lib/dentalink.js';
import { wompi, WompiError, type WompiStatus, type WompiWebhookEvent } from '../lib/wompi.js';
import { requirePatient } from '../lib/patient-middleware.js';

// =============================================================================
// Helpers
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

function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local!.slice(0, 2)}***@${domain}`;
}

function maskPhone(phone: string | undefined): string | null {
  if (!phone) return null;
  return phone.slice(0, 3) + '****' + phone.slice(-2);
}

// =============================================================================
// Schemas de input
// =============================================================================

const CreatePaymentSchema = z.object({
  treatment_id: z.string().min(1).max(100).optional(),
  amount_cop: z.number().int().positive().max(50_000_000), // máx 50M COP
  description: z.string().min(1).max(200),
});

// =============================================================================
// Rutas
// =============================================================================

export async function paymentsRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // POST /me/payments
  // Crea una transacción + Wompi payment link
  // ---------------------------------------------------------------------------
  app.post(
    '/me/payments',
    { preHandler: requirePatient },
    async (request, reply) => {
      const patient = request.patient!;
      const parsed = CreatePaymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: 'Datos del pago inválidos',
          details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      const { treatment_id, amount_cop, description } = parsed.data;

      try {
        // === Anti-IDOR: si especifica treatment_id, verificar que sea suyo ===
        if (treatment_id) {
          const token = await getDentalinkToken();
          const treatments = await dentalink.getPatientTreatments(patient.sub, token);
          const tx = treatments.find(
            (t) => t.id === treatment_id && t.id_paciente === patient.sub,
          );
          if (!tx) {
            await audit({
              actorType: 'patient',
              actorId: patient.jti,
              action: 'patient.payment.create',
              resourceType: 'payment',
              metadata: { reason: 'treatment_not_owned', treatment_id },
              result: 'denied',
              ip: request.ip,
            });
            return reply.code(404).send({
              error: 'NOT_FOUND',
              message: 'Tratamiento no encontrado.',
            });
          }
          // Validar que el monto no exceda el saldo pendiente
          if (amount_cop > tx.saldo_pendiente) {
            return reply.code(400).send({
              error: 'BAD_REQUEST',
              message: `El monto excede el saldo pendiente (${tx.saldo_pendiente}).`,
            });
          }
        }

        // === Obtener profile para email (Wompi lo necesita para enviar recibo) ===
        const token = await getDentalinkToken();
        const profile = await dentalink.getPatientProfile(patient.sub, token);
        if (!profile) {
          return reply.code(404).send({ error: 'PATIENT_NOT_FOUND' });
        }

        // === Generar reference y crear payment link en Wompi ===
        const reference = wompi.generateReference();
        const link = await wompi.createPaymentLink({
          amountCop: amount_cop,
          reference,
          description,
          customerEmail: profile.email,
        });

        // === Persistir la transaction (status=pending) ===
        // Buscamos el session_id usando el jti (el JWT no lo lleva embebido)
        const sessionResult = await db.query<{ id: string }>(
          `SELECT id FROM patient_sessions WHERE jti = $1`,
          [patient.jti],
        );
        const sessionId = sessionResult.rows[0]?.id ?? null;

        await db.query(
          `INSERT INTO transactions (
             kiosk_id,
             patient_session_id,
             dentalink_patient_id,
             dentalink_treatment_id,
             patient_phone_masked,
             patient_email_masked,
             wompi_reference,
             wompi_payment_link_id,
             amount_cop,
             status,
             raw_creation_response,
             expires_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10::jsonb, $11
           )`,
          [
            patient.kiosk_id ?? null,
            sessionId,
            patient.sub,
            treatment_id ?? null,
            maskPhone(profile.celular),
            maskEmail(profile.email),
            reference,
            link.id,
            amount_cop,
            JSON.stringify({ link_id: link.id, url: link.url }),
            link.expiresAt,
          ],
        );

        await audit({
          actorType: 'patient',
          actorId: patient.jti,
          action: 'patient.payment.create',
          resourceType: 'payment',
          resourceId: reference,
          metadata: {
            amount_cop,
            treatment_id: treatment_id ?? null,
            link_id: link.id,
          },
          result: 'success',
          ip: request.ip,
        });

        logger.info(
          {
            reference,
            amount_cop,
            patient_id: patient.sub,
            link_id: link.id,
          },
          'Payment link creado',
        );

        // Retornamos lo mínimo necesario para el frontend
        return reply.send({
          reference,
          url: link.url,
          amount_cop,
          status: 'pending',
          expires_at: link.expiresAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof WompiError) {
          logger.error({ err, code: err.code }, 'Wompi error creando payment link');
          if (err.code === 'TIMEOUT') {
            return reply.code(504).send({
              error: 'UPSTREAM_TIMEOUT',
              message: 'El servicio de pagos no responde. Intenta de nuevo.',
            });
          }
          return reply.code(503).send({
            error: 'UPSTREAM_ERROR',
            message: 'El servicio de pagos no está disponible. Intenta más tarde.',
          });
        }
        if (err instanceof DentalinkError) {
          logger.error({ err }, 'Dentalink error en payment create');
          return reply.code(503).send({
            error: 'UPSTREAM_ERROR',
            message: 'No pudimos validar tu tratamiento. Acude a recepción.',
          });
        }
        logger.error({ err }, 'Unexpected error en POST /me/payments');
        return reply.code(500).send({ error: 'INTERNAL' });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /me/payments/:reference - Polling del estado
  // ---------------------------------------------------------------------------
  app.get<{ Params: { reference: string } }>(
    '/me/payments/:reference',
    { preHandler: requirePatient },
    async (request, reply) => {
      const patient = request.patient!;
      const { reference } = request.params;

      if (!/^DK-[a-z0-9-]+$/i.test(reference)) {
        return reply.code(400).send({ error: 'BAD_REQUEST' });
      }

      // Anti-IDOR: filtramos por patient_id del JWT (no del query)
      const result = await db.query<{
        status: string;
        amount_cop: string;
        dentalink_treatment_id: string | null;
        wompi_payment_method_type: string | null;
        approved_at: Date | null;
        expires_at: Date | null;
        created_at: Date;
      }>(
        `SELECT status, amount_cop, dentalink_treatment_id, wompi_payment_method_type,
                approved_at, expires_at, created_at
         FROM transactions
         WHERE wompi_reference = $1 AND dentalink_patient_id = $2
         LIMIT 1`,
        [reference, patient.sub],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }

      const tx = result.rows[0]!;
      return reply.send({
        reference,
        status: tx.status,
        amount_cop: Number(tx.amount_cop),
        treatment_id: tx.dentalink_treatment_id,
        payment_method: tx.wompi_payment_method_type,
        approved_at: tx.approved_at?.toISOString() ?? null,
        expires_at: tx.expires_at?.toISOString() ?? null,
        created_at: tx.created_at.toISOString(),
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /webhooks/wompi - Notificación de cambio de estado
  // ---------------------------------------------------------------------------
  app.post('/webhooks/wompi', async (request, reply) => {
    const body = request.body as WompiWebhookEvent | undefined;

    // El webhook DEBE responder 200 rápidamente para que Wompi no reintente
    // en exceso. Pero queremos validar antes de procesar.

    if (!body || typeof body !== 'object' || !body.data?.transaction) {
      logger.warn({ ip: request.ip }, 'Webhook Wompi con shape inválido');
      return reply.code(400).send({ error: 'BAD_REQUEST' });
    }

    // === Verificar firma ===
    try {
      const valid = wompi.verifyWebhookSignature(body);
      if (!valid) {
        logger.warn(
          { ip: request.ip, event: body.event, reference: body.data.transaction.reference },
          'Webhook Wompi con firma inválida',
        );
        await audit({
          actorType: 'webhook',
          actorId: null,
          action: 'webhook.wompi.received',
          resourceType: 'webhook',
          metadata: { reason: 'invalid_signature' },
          result: 'denied',
          ip: request.ip,
        });
        return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      }
    } catch (err) {
      if (err instanceof WompiError && err.code === 'STALE_EVENT') {
        logger.warn(
          { ip: request.ip, timestamp: body.timestamp },
          'Webhook Wompi rechazado: stale event',
        );
        return reply.code(401).send({ error: 'STALE_EVENT' });
      }
      if (err instanceof WompiError && err.code === 'INVALID_SIGNATURE') {
        logger.warn(
          { ip: request.ip, err: err.message },
          'Webhook Wompi con firma malformada',
        );
        return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      }
      logger.error({ err }, 'Error verificando firma de webhook');
      return reply.code(400).send({ error: 'BAD_REQUEST' });
    }

    const tx = body.data.transaction;
    const newStatus = mapWompiStatusToDb(tx.status);

    // === Idempotencia: si la transaction ya está en estado terminal, no-op ===
    const existing = await db.query<{
      id: string;
      status: string;
      dentalink_patient_id: string;
      dentalink_treatment_id: string | null;
      amount_cop: string;
      registered_in_dentalink: boolean;
    }>(
      `SELECT id, status, dentalink_patient_id, dentalink_treatment_id,
              amount_cop, registered_in_dentalink
       FROM transactions
       WHERE wompi_reference = $1
       LIMIT 1`,
      [tx.reference],
    );

    if (existing.rows.length === 0) {
      // Wompi nos manda webhook de una reference que no creamos.
      // Aceptamos 200 para no provocar reintentos pero auditamos.
      logger.warn({ reference: tx.reference }, 'Webhook con reference desconocida');
      await audit({
        actorType: 'webhook',
          actorId: null,
          action: 'webhook.wompi.received',
        resourceType: 'transaction',
        resourceId: tx.reference,
        metadata: { reason: 'unknown_reference', wompi_status: tx.status },
        result: 'denied',
        ip: request.ip,
      });
      return reply.send({ ok: true });
    }

    const txRow = existing.rows[0]!;
    if (isTerminalStatus(txRow.status)) {
      logger.info(
        { reference: tx.reference, current: txRow.status, incoming: newStatus },
        'Webhook idempotente: transaction ya en estado terminal',
      );
      return reply.send({ ok: true });
    }

    // === Actualizar transaction ===
    try {
      await db.query(
        `UPDATE transactions
         SET status = $1,
             status_message = $2,
             wompi_transaction_id = $3,
             wompi_payment_method_type = $4,
             wompi_payment_method_extra = $5::jsonb,
             raw_webhook_payload = $6::jsonb,
             webhook_received_at = now(),
             webhook_verified = true
         WHERE wompi_reference = $7`,
        [
          newStatus,
          tx.status,
          tx.id,
          tx.payment_method_type,
          JSON.stringify(tx.payment_method ?? {}),
          JSON.stringify(body),
          tx.reference,
        ],
      );

      await audit({
        actorType: 'webhook',
          actorId: null,
          action: 'webhook.wompi.received',
        resourceType: 'transaction',
        resourceId: tx.reference,
        metadata: {
          wompi_status: tx.status,
          new_db_status: newStatus,
          wompi_transaction_id: tx.id,
          payment_method: tx.payment_method_type,
        },
        result: 'success',
        ip: request.ip,
      });

      logger.info(
        {
          reference: tx.reference,
          status: newStatus,
          wompi_tx_id: tx.id,
        },
        'Webhook Wompi procesado',
      );

      // === Reconciliación con Dentalink (best-effort, async) ===
      // Si el pago fue aprobado, intentar registrarlo en Dentalink.
      // No bloqueamos la respuesta del webhook con esto.
      if (newStatus === 'approved' && !txRow.registered_in_dentalink) {
        // Fire-and-forget. El reconciler programado lo reintentará si falla.
        reconcileWithDentalink(txRow.id, tx.reference).catch((err) => {
          logger.error(
            { err, reference: tx.reference },
            'Reconciliación inicial Dentalink falló (será reintentada)',
          );
        });
      }

      return reply.send({ ok: true });
    } catch (err) {
      logger.error({ err, reference: tx.reference }, 'Error procesando webhook Wompi');
      // Retornar 500 para que Wompi reintente
      return reply.code(500).send({ error: 'INTERNAL' });
    }
  });
}

// =============================================================================
// Helpers de status / reconciliación
// =============================================================================

function mapWompiStatusToDb(wompiStatus: WompiStatus): string {
  switch (wompiStatus) {
    case 'APPROVED':
      return 'approved';
    case 'DECLINED':
      return 'declined';
    case 'VOIDED':
      return 'voided';
    case 'ERROR':
      return 'error';
    case 'PENDING':
    default:
      return 'pending';
  }
}

function isTerminalStatus(status: string): boolean {
  return ['approved', 'declined', 'voided', 'expired'].includes(status);
}

/**
 * Best-effort: registrar pago en Dentalink.
 *
 * Si falla, el reconciler programado lo reintenta. Por eso este código NO
 * lanza excepciones — solo loguea y actualiza last_reconciliation_error.
 */
async function reconcileWithDentalink(txId: string, reference: string): Promise<void> {
  const result = await db.query<{
    dentalink_patient_id: string;
    dentalink_treatment_id: string | null;
    amount_cop: string;
    wompi_payment_method_type: string | null;
    registered_in_dentalink: boolean;
  }>(
    `SELECT dentalink_patient_id, dentalink_treatment_id, amount_cop,
            wompi_payment_method_type, registered_in_dentalink
     FROM transactions
     WHERE id = $1`,
    [txId],
  );
  if (result.rows.length === 0) return;
  const tx = result.rows[0]!;
  if (tx.registered_in_dentalink) return; // ya está reconciliado

  // Incrementamos el contador de intentos
  await db.query(
    `UPDATE transactions
     SET reconciliation_attempts = reconciliation_attempts + 1,
         last_reconciliation_at = now()
     WHERE id = $1`,
    [txId],
  );

  try {
    const token = await getDentalinkToken();
    const { paymentId } = await dentalink.registerPaymentInDentalink({
      patientId: tx.dentalink_patient_id,
      treatmentId: tx.dentalink_treatment_id,
      amountCop: Number(tx.amount_cop),
      reference,
      method: tx.wompi_payment_method_type ?? 'OTHER',
      dentalinkToken: token,
    });

    await db.query(
      `UPDATE transactions
       SET registered_in_dentalink = true,
           dentalink_payment_id = $1,
           last_reconciliation_error = NULL
       WHERE id = $2`,
      [paymentId, txId],
    );

    await audit({
      actorType: 'system',
      actorId: null,
      action: 'payment.reconciled',
      resourceType: 'transaction',
      resourceId: reference,
      metadata: { dentalink_payment_id: paymentId },
      result: 'success',
    });

    logger.info({ reference, paymentId }, 'Pago reconciliado en Dentalink');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE transactions
       SET last_reconciliation_error = $1
       WHERE id = $2`,
      [errMsg.slice(0, 500), txId],
    );

    await audit({
      actorType: 'system',
      actorId: null,
      action: 'payment.reconciled',
      resourceType: 'transaction',
      resourceId: reference,
      metadata: { error: errMsg.slice(0, 200) },
      result: 'denied',
    });

    logger.warn({ err, reference }, 'Reconciliación Dentalink falló');
    // No re-lanzamos: el reconciler periódico lo reintenta
  }
}
