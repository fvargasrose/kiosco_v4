/**
 * =============================================================================
 * Routes: POST /kiosk/register
 * =============================================================================
 *
 * Registro de paciente nuevo en Dentalink desde la web pública.
 *
 * Modelo web público (Hito A, Opción A): ya NO requiere kiosk_token. La ruta
 * está gobernada por el feature flag FEATURE_REGISTRO; si está desactivado
 * responde 403 FEATURE_DISABLED. El servidor valida que los campos de
 * confirmación coincidan para no depender solo del frontend.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink, DentalinkError } from '../lib/dentalink.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';

/**
 * Gate por feature flag: el registro público solo está disponible si
 * FEATURE_REGISTRO está activo. Se evalúa por request (no en import) para que
 * el flag pueda controlarse por entorno.
 */
async function requireFeatureRegistro(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!config.FEATURE_REGISTRO) {
    return reply.code(403).send({ error: 'FEATURE_DISABLED' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema de validación
// ─────────────────────────────────────────────────────────────────────────────

const RegisterBody = z
  .object({
    // Campos con doble confirmación
    cedula:          z.string().regex(/^\d{6,15}$/, 'Cédula debe tener entre 6 y 15 dígitos'),
    cedula_confirm:  z.string(),
    celular:         z.string().regex(/^3\d{9}$/, 'Celular debe iniciar en 3 y tener 10 dígitos'),
    celular_confirm: z.string(),
    email:           z.string().email('Email inválido').max(255),
    email_confirm:   z.string(),

    // Campos simples obligatorios
    nombres:          z.string().min(2, 'Nombres demasiado cortos').max(100).trim(),
    apellidos:        z.string().min(2, 'Apellidos demasiado cortos').max(100).trim(),
    fecha_nacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD'),
    sexo:             z.enum(['M', 'F'], { errorMap: () => ({ message: 'Sexo debe ser M o F' }) }),
    direccion:        z.string().min(4, 'Dirección demasiado corta').max(200).trim(),
    ciudad:           z.string().min(2, 'Ciudad demasiado corta').max(100).trim(),

    // Opcionales
    comuna:    z.string().max(100).trim().optional().nullable(),
    ocupacion: z.string().max(100).trim().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.cedula !== data.cedula_confirm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cedula_confirm'],
        message: 'Las cédulas no coinciden',
      });
    }
    if (data.celular !== data.celular_confirm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['celular_confirm'],
        message: 'Los celulares no coinciden',
      });
    }
    if (data.email.toLowerCase() !== data.email_confirm.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email_confirm'],
        message: 'Los correos no coinciden',
      });
    }
    // Validar fecha de nacimiento plausible (5–120 años)
    const dob = new Date(data.fecha_nacimiento + 'T00:00:00');
    if (isNaN(dob.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fecha_nacimiento'],
        message: 'Fecha de nacimiento inválida',
      });
    } else {
      const now = new Date();
      const minDate = new Date(now.getFullYear() - 120, now.getMonth(), now.getDate());
      const maxDate = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
      if (dob < minDate || dob > maxDate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fecha_nacimiento'],
          message: 'Fecha de nacimiento fuera de rango (5–120 años)',
        });
      }
    }
  });

// ─────────────────────────────────────────────────────────────────────────────

async function getDentalinkToken(): Promise<string | null> {
  const r = await db.query<{ dentalink_token_encrypted: Buffer | null }>(
    `SELECT dentalink_token_encrypted FROM clinic WHERE id = 1`,
  );
  return decrypt(r.rows[0]?.dentalink_token_encrypted ?? null);
}

// ─────────────────────────────────────────────────────────────────────────────

export async function patientRegisterRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /kiosk/register
   *
   * Registra un paciente nuevo directamente en Dentalink.
   * Respuestas:
   *   201  { ok: true, patient_id: string }
   *   400  Validación fallida
   *   409  Paciente ya existe (por email o celular)
   *   422  Dentalink rechazó los datos
   *   503  Sin configuración de Dentalink
   */
  app.post('/kiosk/register', { preHandler: requireFeatureRegistro }, async (request, reply) => {
    const parsed = RegisterBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        fields: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const {
      cedula, celular, email,
      nombres, apellidos, fecha_nacimiento, sexo,
      direccion, ciudad, comuna, ocupacion,
    } = parsed.data;

    const dlToken = await getDentalinkToken();

    // Verificar existencia previa
    let existing;
    try {
      existing = await dentalink.checkPatientExistsByEmailOrCelular(
        email,
        `+57${celular}`,
        dlToken,
      );
    } catch (err) {
      logger.error({ err }, 'register: checkPatientExists failed');
      return reply.code(502).send({ error: 'UPSTREAM_ERROR', message: 'Error al verificar duplicados.' });
    }

    if (existing) {
      await audit({
        actorType: 'system',
        action: 'patient.register_duplicate',
        result: 'denied',
        ip: request.ip,
        metadata: { cedula_hint: cedula.slice(-4) },
      });
      return reply.code(409).send({
        error: 'PATIENT_EXISTS',
        message: 'Ya existe una cuenta registrada con ese email o celular.',
      });
    }

    // Crear paciente en Dentalink
    let created;
    try {
      created = await dentalink.createPatient(
        {
          nombre: nombres,
          apellidos,
          email,
          celular: `+57${celular}`,
          fecha_nacimiento,
          sexo,
          direccion,
          ciudad,
          comuna: comuna ?? undefined,
          rut: cedula,
          ocupacion: ocupacion ?? undefined,
        },
        dlToken,
      );
    } catch (err) {
      if (err instanceof DentalinkError && err.code === 'BAD_REQUEST') {
        return reply.code(422).send({
          error: 'DENTALINK_REJECTED',
          message: 'Dentalink rechazó los datos del paciente. Verifica los campos.',
        });
      }
      logger.error({ err }, 'register: createPatient failed');
      return reply.code(502).send({ error: 'UPSTREAM_ERROR', message: 'Error al crear el paciente.' });
    }

    await audit({
      actorType: 'system',
      action: 'patient.registered',
      result: 'success',
      ip: request.ip,
      metadata: { patient_id: created.id, cedula_hint: cedula.slice(-4) },
    });

    return reply.code(201).send({ ok: true, patient_id: created.id });
  });
}
