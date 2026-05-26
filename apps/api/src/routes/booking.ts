/**
 * =============================================================================
 * Routes: /me/booking/*
 * =============================================================================
 *
 * Flujo del Hito 8 (crear cita nueva — independiente de cancelaciones):
 *
 *   1. GET /me/booking/branches → lista sucursales
 *   2. GET /me/booking/dentists?branch_id=N → dentistas de esa sucursal
 *   3. GET /me/booking/slots?dentist_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD&duration=30
 *      → slots disponibles del dentista en ese rango (max 30 días)
 *   4. POST /me/booking/appointments → crea la cita
 *
 * Reagendar = cancelar cita anterior + crear cita nueva (decisión de UX).
 * El cliente decide cuál hacer; el server las trata como operaciones independientes.
 *
 * Seguridad:
 *   - Todos los endpoints requieren patient session.
 *   - El paciente solo puede crear citas para SU patientId del JWT (anti-IDOR).
 *   - Validación estricta de fechas: no en el pasado, no más de 90 días al futuro.
 *   - Rate limiting: max 5 creaciones de cita por paciente por hora.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink, DentalinkError } from '../lib/dentalink.js';
import { handleDentalinkError } from '../lib/dentalink-error-handler.js';
import { requirePatient } from '../lib/patient-middleware.js';

// =============================================================================
// Constantes
// =============================================================================

const MAX_SEARCH_WINDOW_DAYS = 30; // máximo rango de búsqueda de slots
const MAX_FUTURE_DAYS = 90; // máxima distancia al futuro para una cita
const DEFAULT_DURATION_MINUTES = 30;
const BOOKING_RATE_LIMIT_MAX = 5;
const BOOKING_RATE_LIMIT_WINDOW_SECS = 3600; // 1 hora

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

/**
 * Obtiene configuración de booking desde clinic: duración, sillón y sucursal por defecto.
 */
async function getClinicBookingConfig(): Promise<{
  durationMin: number;
  sillonId: number;
  sucursalId: number;
}> {
  const r = await db.query<{
    duracion_cita_minutos: number | null;
    sillon_id: number | null;
    sucursal_id: number | null;
  }>(
    `SELECT duracion_cita_minutos, sillon_id, sucursal_id FROM clinic WHERE id = 1`,
  );
  return {
    durationMin: r.rows[0]?.duracion_cita_minutos ?? DEFAULT_DURATION_MINUTES,
    sillonId: r.rows[0]?.sillon_id ?? 1,
    sucursalId: r.rows[0]?.sucursal_id ?? 1,
  };
}

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD requerido');
const TimeSchema = z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:mm requerido');

function parseDateLocal(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

function isInFuture(yyyyMmDd: string, hhmm: string): boolean {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y!, m! - 1, d!, hh!, mm!).getTime() > Date.now();
}

function withinFutureLimit(yyyyMmDd: string): boolean {
  const target = parseDateLocal(yyyyMmDd);
  const limit = new Date();
  limit.setDate(limit.getDate() + MAX_FUTURE_DAYS);
  return target <= limit;
}

// =============================================================================
// Rutas
// =============================================================================

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------------
  // GET /me/booking/branches - Listar sucursales
  // ---------------------------------------------------------------------------
  app.get(
    '/me/booking/branches',
    { preHandler: requirePatient },
    async (request, reply) => {
      try {
        const token = await getDentalinkToken();
        const branches = await dentalink.getSucursales(token);
        return reply.send({ data: branches, total: branches.length });
      } catch (err) {
        return handleDentalinkError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /me/booking/dentists?branch_id=N
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { branch_id?: string } }>(
    '/me/booking/dentists',
    { preHandler: requirePatient },
    async (request, reply) => {
      const branchIdRaw = request.query.branch_id;
      const branchId = Number(branchIdRaw);
      if (!Number.isInteger(branchId) || branchId <= 0) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: 'branch_id requerido y debe ser entero positivo',
        });
      }

      try {
        const token = await getDentalinkToken();
        const dentists = await dentalink.getDentists(branchId, token);

        // Enriquecer con foto local si existe
        const ids = dentists.map((d) => d.id);
        const photoRows = ids.length > 0
          ? (await db.query<{ dentalink_dentist_id: string }>(
              `SELECT dentalink_dentist_id FROM dentist_photos
               WHERE dentalink_dentist_id = ANY($1)`,
              [ids],
            )).rows
          : [];
        const withPhoto = new Set(photoRows.map((r) => r.dentalink_dentist_id));

        const data = dentists.map((d) => ({
          ...d,
          photo_url: withPhoto.has(d.id)
            ? `/public/dentist-photo/${encodeURIComponent(d.id)}`
            : null,
        }));

        return reply.send({ data, total: data.length });
      } catch (err) {
        return handleDentalinkError(err, reply);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /me/booking/slots
  // ---------------------------------------------------------------------------
  const SlotsQuerySchema = z.object({
    dentist_id: z.string().min(1).max(100),
    branch_id: z.coerce.number().int().positive().optional(),
    from: DateOnlySchema,
    to: DateOnlySchema,
    duration: z.coerce.number().int().min(15).max(180).optional(),
  });

  app.get('/me/booking/slots', { preHandler: requirePatient }, async (request, reply) => {
    const parsed = SlotsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: 'Parámetros inválidos',
        details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const { dentist_id, branch_id, from, to, duration } = parsed.data;

    const fromDate = parseDateLocal(from);
    const toDate = parseDateLocal(to);
    const diffMs = toDate.getTime() - fromDate.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    if (diffDays < 0) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: 'to debe ser >= from',
      });
    }
    if (diffDays > MAX_SEARCH_WINDOW_DAYS) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: `Rango máximo de búsqueda: ${MAX_SEARCH_WINDOW_DAYS} días`,
      });
    }
    if (!withinFutureLimit(to)) {
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: `No se pueden buscar citas más allá de ${MAX_FUTURE_DAYS} días`,
      });
    }

    try {
      const token = await getDentalinkToken();
      const { durationMin: defaultDuration, sucursalId: defaultSucursal } =
        await getClinicBookingConfig();
      const durationMin = duration ?? defaultDuration;
      const sucursalId = branch_id ?? defaultSucursal;
      const slots = await dentalink.getAvailableSlots(
        dentist_id,
        sucursalId,
        from,
        to,
        durationMin,
        token,
      );
      return reply.send({ data: slots, total: slots.length, duration_minutes: durationMin });
    } catch (err) {
      return handleDentalinkError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /me/booking/appointments - Crear cita
  // ---------------------------------------------------------------------------
  const CreateAppointmentSchema = z.object({
    dentist_id: z.string().min(1).max(100),
    branch_id: z.number().int().positive(),
    fecha: DateOnlySchema,
    hora_inicio: TimeSchema,
    hora_fin: TimeSchema,
    notas: z.string().max(500).optional(),
  });

  app.post(
    '/me/booking/appointments',
    { preHandler: requirePatient },
    async (request, reply) => {
      const patient = request.patient!;
      const parsed = CreateAppointmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: 'Datos de cita inválidos',
          details: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      const { dentist_id, branch_id, fecha, hora_inicio, hora_fin, notas } = parsed.data;

      // === Validaciones de negocio ===
      if (!isInFuture(fecha, hora_inicio)) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: 'La fecha y hora deben estar en el futuro',
        });
      }
      if (!withinFutureLimit(fecha)) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: `No se pueden agendar citas más allá de ${MAX_FUTURE_DAYS} días`,
        });
      }
      if (hora_inicio >= hora_fin) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: 'hora_fin debe ser posterior a hora_inicio',
        });
      }

      // === Rate limiting ===
      const rl = await db.query<{ allowed: boolean; retry_after_secs: number }>(
        `SELECT * FROM fn_rate_limit_check($1, $2, $3)`,
        [`booking:patient:${patient.sub}`, BOOKING_RATE_LIMIT_MAX, BOOKING_RATE_LIMIT_WINDOW_SECS],
      );
      if (!rl.rows[0]?.allowed) {
        await audit({
          actorType: 'patient',
          actorId: patient.jti,
          action: 'patient.appointment.create',
          resourceType: 'appointment',
          metadata: { reason: 'rate_limit' },
          result: 'denied',
          ip: request.ip,
        });
        return reply.code(429).send({
          error: 'RATE_LIMIT',
          message: 'Has creado muchas citas recientemente. Intenta en unos minutos.',
          retry_after_seconds: rl.rows[0]?.retry_after_secs ?? 60,
        });
      }

      try {
        const token = await getDentalinkToken();
        const { sillonId } = await getClinicBookingConfig();
        const newApt = await dentalink.createAppointment({
          patientId: patient.sub,
          dentistId: dentist_id,
          sucursalId: branch_id,
          sillonId,
          fecha,
          horaInicio: hora_inicio,
          horaFin: hora_fin,
          notas,
          dentalinkToken: token,
        });

        await audit({
          actorType: 'patient',
          actorId: patient.jti,
          action: 'patient.appointment.create',
          resourceType: 'appointment',
          resourceId: newApt.id,
          metadata: {
            fecha,
            hora_inicio,
            id_dentista: dentist_id,
            id_sucursal: branch_id,
            had_notas: !!notas,
          },
          result: 'success',
          ip: request.ip,
        });

        return reply.code(201).send({
          ok: true,
          appointment: {
            id: newApt.id,
            fecha: newApt.fecha,
            hora_inicio: newApt.hora_inicio,
            hora_fin: newApt.hora_fin,
            estado: newApt.estado,
            dentista: newApt.dentista,
            sucursal: newApt.sucursal,
          },
        });
      } catch (err) {
        // CONFLICT = slot ya tomado por otro paciente entre la consulta y el POST
        if (err instanceof DentalinkError && err.code === 'CONFLICT') {
          await audit({
            actorType: 'patient',
            actorId: patient.jti,
            action: 'patient.appointment.create',
            resourceType: 'appointment',
            metadata: { reason: 'slot_conflict', dentist_id, fecha, hora_inicio },
            result: 'denied',
            ip: request.ip,
          });
          return reply.code(409).send({
            error: 'CONFLICT',
            message: 'Este horario ya no está disponible. Por favor escoge otro.',
          });
        }
        if (err instanceof DentalinkError) {
          logger.error(
            { code: err.code, status: err.status, upstreamBody: err.upstreamBody, dentist_id, fecha, hora_inicio, hora_fin },
            'Dentalink rechazó crear cita',
          );
        } else {
          logger.error({ err, patient_id: patient.sub }, 'Error creando cita');
        }
        return handleDentalinkError(err, reply);
      }
    },
  );
}
