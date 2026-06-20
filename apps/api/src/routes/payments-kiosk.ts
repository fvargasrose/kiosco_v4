/**
 * =============================================================================
 * Routes: POST /me/payments/kiosk — Payment link + QR + envío del link por correo
 * =============================================================================
 *
 * Pensado para el modo KIOSCO (equipo compartido, `?k=<token>`). En vez de abrir
 * el widget en la pantalla del kiosco (donde el paciente tendría que teclear
 * datos sensibles en un equipo común), se genera un payment link de Wompi y:
 *   - el kiosco muestra el QR para escanear con el celular del paciente, y
 *   - en paralelo se envía el enlace (temporal) al CORREO del paciente.
 *
 * El paciente paga en SU celular; Wompi lo redirige a /pago/retorno/<ref> y el
 * kiosco refleja el resultado por polling (GET /me/payments/:reference, en
 * payments.ts — SIN cambios). El webhook (payments.ts) tampoco se toca: este
 * link tiene su `wompi_payment_link_id`, que es justo la vía de match preferente.
 *
 * Seguridad: requiere patient session; valida saldo y propiedad del tratamiento
 * (anti-IDOR), igual que POST /me/payments.
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
import { sendPaymentLinkEmail } from '../lib/notifications.js';

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

const CreateKioskPaymentSchema = z.object({
  treatment_id: z.string().min(1).max(100).optional(),
  amount_cop: z.number().int().positive().max(50_000_000), // máx 50M COP
  description: z.string().min(1).max(200),
});

// =============================================================================
// Ruta
// =============================================================================

export async function paymentsKioskRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/me/payments/kiosk',
    { preHandler: requirePatient },
    async (request, reply) => {
      const patient = request.patient!;
      const parsed = CreateKioskPaymentSchema.safeParse(request.body);
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
              metadata: { reason: 'treatment_not_owned', treatment_id, channel: 'kiosk' },
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

        // === Obtener profile (email para el envío del enlace) ===
        const token = await getDentalinkToken();
        const profile = await dentalink.getPatientProfile(patient.sub, token);
        if (!profile) {
          return reply.code(404).send({ error: 'PATIENT_NOT_FOUND' });
        }

        // === Generar reference + crear payment link en Wompi ===
        const reference = wompi.generateReference();
        const link = await wompi.createPaymentLink({
          amountCop: amount_cop,
          reference,
          description,
          customerEmail: profile.email,
        });

        // === Persistir la transaction (status=pending) ===
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
            JSON.stringify({ channel: 'kiosk', link_id: link.id, url: link.url }),
            link.expiresAt,
          ],
        );

        // === Enviar el enlace por correo (best-effort: el QR es el camino primario) ===
        let emailSent = false;
        if (profile.email) {
          emailSent = await sendPaymentLinkEmail({
            to: profile.email,
            patientName: profile.nombre,
            amountCop: amount_cop,
            url: link.url,
            expiresAt: link.expiresAt,
          });
        }

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
            channel: 'kiosk',
            email_sent: emailSent,
          },
          result: 'success',
          ip: request.ip,
        });

        logger.info(
          { reference, amount_cop, patient_id: patient.sub, channel: 'kiosk', email_sent: emailSent },
          'Payment link (kiosco) creado',
        );

        return reply.send({
          reference,
          url: link.url,
          amount_cop,
          status: 'pending',
          expires_at: link.expiresAt.toISOString(),
          email_sent: emailSent,
          email_masked: maskEmail(profile.email),
        });
      } catch (err) {
        if (err instanceof WompiError) {
          logger.error({ err, code: err.code }, 'Wompi error creando payment link (kiosco)');
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
          logger.error({ err }, 'Dentalink error en kiosk payment create');
          return reply.code(503).send({
            error: 'UPSTREAM_ERROR',
            message: 'No pudimos validar tu tratamiento. Acude a recepción.',
          });
        }
        logger.error({ err }, 'Unexpected error en POST /me/payments/kiosk');
        return reply.code(500).send({ error: 'INTERNAL' });
      }
    },
  );
}
