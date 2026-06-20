/**
 * =============================================================================
 * Routes: POST /me/payments/widget — Widget de Wompi (pago en la misma página)
 * =============================================================================
 *
 * Alternativa al payment link (payments.ts) para que el paciente NO salga del
 * sistema: en vez de redirigir a checkout.wompi.co, el frontend abre el Widget
 * de Wompi (un iframe en un modal sobre nuestra UI). El callback JS del widget
 * nos devuelve el resultado y actualizamos la pantalla in situ.
 *
 * Flujo:
 *   1. POST /me/payments/widget → valida saldo (anti-IDOR), genera reference,
 *      calcula la firma de integridad e inserta la transaction (status=pending).
 *      → retorna { reference, publicKey, currency, amountInCents, signature,
 *                  expires_at } al frontend.
 *   2. El frontend abre el Widget con esos datos.
 *   3. El estado real llega por DOS vías (idénticas a payment links):
 *        - POST /webhooks/wompi  (firma HMAC, en payments.ts — SIN cambios)
 *        - GET /me/payments/:reference (polling, en payments.ts — SIN cambios)
 *
 * Clave: la `reference` que generamos ES la que Wompi reporta en el webhook
 * (a diferencia de los payment links). El webhook ya casa por `wompi_reference`
 * como fallback, así que reconcilia sin tocar el archivo protegido payments.ts.
 *
 * Seguridad:
 *   - requiere patient session (anti-IDOR: filtra por patient.sub del JWT)
 *   - el integrity secret NUNCA sale del backend (solo la firma calculada)
 *   - mismo límite de monto y validación de propiedad del tratamiento
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink, DentalinkError } from '../lib/dentalink.js';
import { wompi, WompiError } from '../lib/wompi.js';
import { requirePatient } from '../lib/patient-middleware.js';

// =============================================================================
// Helpers (locales — el archivo protegido payments.ts no se importa)
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
// Schema de input (idéntico a POST /me/payments)
// =============================================================================

const CreateWidgetPaymentSchema = z.object({
  treatment_id: z.string().min(1).max(100).optional(),
  amount_cop: z.number().int().positive().max(50_000_000), // máx 50M COP
  description: z.string().min(1).max(200),
});

// =============================================================================
// Ruta
// =============================================================================

export async function paymentsWidgetRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/me/payments/widget',
    { preHandler: requirePatient },
    async (request, reply) => {
      const patient = request.patient!;
      const parsed = CreateWidgetPaymentSchema.safeParse(request.body);
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
              metadata: { reason: 'treatment_not_owned', treatment_id, channel: 'widget' },
              result: 'denied',
              ip: request.ip,
            });
            return reply.code(404).send({
              error: 'NOT_FOUND',
              message: 'Tratamiento no encontrado.',
            });
          }
          if (amount_cop > tx.saldo_pendiente) {
            return reply.code(400).send({
              error: 'BAD_REQUEST',
              message: `El monto excede el saldo pendiente (${tx.saldo_pendiente}).`,
            });
          }
        }

        // === Obtener profile para email (recibo) ===
        const token = await getDentalinkToken();
        const profile = await dentalink.getPatientProfile(patient.sub, token);
        if (!profile) {
          return reply.code(404).send({ error: 'PATIENT_NOT_FOUND' });
        }

        // === Generar reference + parámetros del widget (firma de integridad) ===
        const reference = wompi.generateReference();
        const checkout = wompi.buildWidgetCheckout({ amountCop: amount_cop, reference });

        // === Persistir la transaction (status=pending, sin payment_link_id) ===
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
             $1, $2, $3, $4, $5, $6, $7, NULL, $8, 'pending', $9::jsonb, $10
           )`,
          [
            patient.kiosk_id ?? null,
            sessionId,
            patient.sub,
            treatment_id ?? null,
            maskPhone(profile.celular),
            maskEmail(profile.email),
            reference,
            amount_cop,
            JSON.stringify({ channel: 'widget', amount_in_cents: checkout.amountInCents }),
            checkout.expiresAt,
          ],
        );

        await audit({
          actorType: 'patient',
          actorId: patient.jti,
          action: 'patient.payment.create',
          resourceType: 'payment',
          resourceId: reference,
          metadata: { amount_cop, treatment_id: treatment_id ?? null, channel: 'widget' },
          result: 'success',
          ip: request.ip,
        });

        logger.info(
          { reference, amount_cop, patient_id: patient.sub, channel: 'widget' },
          'Widget checkout creado',
        );

        // Solo lo necesario para abrir el widget. NO se expone el integrity secret.
        return reply.send({
          reference,
          public_key: checkout.publicKey,
          currency: checkout.currency,
          amount_in_cents: checkout.amountInCents,
          signature: checkout.signature,
          redirect_url: null,
          amount_cop,
          status: 'pending',
          expires_at: checkout.expiresAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof WompiError) {
          logger.error({ err, code: err.code }, 'Wompi error creando widget checkout');
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
          logger.error({ err }, 'Dentalink error en widget create');
          return reply.code(503).send({
            error: 'UPSTREAM_ERROR',
            message: 'No pudimos validar tu tratamiento. Acude a recepción.',
          });
        }
        logger.error({ err }, 'Unexpected error en POST /me/payments/widget');
        return reply.code(500).send({ error: 'INTERNAL' });
      }
    },
  );
}
