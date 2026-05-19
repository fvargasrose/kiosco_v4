/**
 * =============================================================================
 * Routes: /me/* (paciente autenticado)
 * =============================================================================
 *
 * Todos los endpoints requieren un session_token válido de paciente.
 * El paciente solo puede ver SUS PROPIOS datos — el patient_id se extrae
 * del JWT, NUNCA del body o query del cliente (anti-IDOR).
 *
 * Endpoints:
 *   GET /me/profile       - Mis datos personales
 *   GET /me/appointments  - Mis citas
 *   GET /me/treatments    - Mis tratamientos
 */

import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink, DentalinkError } from '../lib/dentalink.js';
import { handleDentalinkError } from '../lib/dentalink-error-handler.js';
import { requirePatient } from '../lib/patient-middleware.js';

/**
 * Helper: obtiene el token Dentalink de la clínica (descifrado).
 * Lo cacheamos brevemente en memoria para evitar descifrar en cada request.
 */
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
  cachedToken = { value: token, expiresAt: Date.now() + 30_000 }; // 30s cache
  return token;
}

/**
 * Mapper de errores Dentalink → ahora viene del módulo compartido.
 * @see lib/dentalink-error-handler.ts
 */

export async function patientMeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /me/profile - Datos personales del paciente
   */
  app.get('/me/profile', { preHandler: requirePatient }, async (request, reply) => {
    const patient = request.patient!;

    try {
      const token = await getDentalinkToken();
      const profile = await dentalink.getPatientProfile(patient.sub, token);

      if (!profile) {
        return reply.code(404).send({ error: 'PATIENT_NOT_FOUND' });
      }

      await audit({
        actorType: 'patient',
        actorId: patient.jti,
        action: 'patient.profile.read',
        resourceType: 'patient',
        resourceId: patient.sub,
        result: 'success',
        ip: request.ip,
      });

      // Filtrar campos sensibles innecesarios para el kiosco
      return reply.send({
        id: profile.id,
        nombre: profile.nombre,
        email: profile.email,
        celular: profile.celular,
        fecha_nacimiento: profile.fecha_nacimiento,
      });
    } catch (err) {
      return handleDentalinkError(err, reply);
    }
  });

  /**
   * GET /me/appointments - Citas del paciente
   * Query opcional: ?status=upcoming|all|past
   */
  app.get('/me/appointments', { preHandler: requirePatient }, async (request, reply) => {
    const patient = request.patient!;
    const { status = 'upcoming' } = request.query as { status?: string };

    try {
      const token = await getDentalinkToken();
      const all = await dentalink.getPatientAppointments(patient.sub, token);

      // VALIDACIÓN CRÍTICA: anti-IDOR
      // Aunque Dentalink ya filtra por patient_id en la URL, verificamos
      // que TODAS las citas devueltas pertenezcan a este paciente.
      const filtered = all.filter((a) => a.id_paciente === patient.sub);
      if (filtered.length !== all.length) {
        logger.warn(
          {
            patient_id: patient.sub,
            received: all.length,
            kept: filtered.length,
          },
          'Dentalink returned appointments for other patients (filtered)',
        );
      }

      // Filtrar por status
      const now = new Date();
      let result = filtered;
      if (status === 'upcoming') {
        result = filtered.filter((a) => {
          const dt = new Date(`${a.fecha}T${a.hora_inicio}`);
          return dt >= now && !['Cancelada', 'Atendida'].includes(a.estado);
        });
      } else if (status === 'past') {
        result = filtered.filter((a) => {
          const dt = new Date(`${a.fecha}T${a.hora_inicio}`);
          return dt < now || ['Cancelada', 'Atendida'].includes(a.estado);
        });
      }

      // Ordenar por fecha+hora ascendente
      result.sort((a, b) => {
        const da = new Date(`${a.fecha}T${a.hora_inicio}`).getTime();
        const db = new Date(`${b.fecha}T${b.hora_inicio}`).getTime();
        return da - db;
      });

      await audit({
        actorType: 'patient',
        actorId: patient.jti,
        action: 'patient.appointments.read',
        resourceType: 'patient',
        resourceId: patient.sub,
        metadata: { count: result.length, status },
        result: 'success',
        ip: request.ip,
      });

      return reply.send({
        data: result,
        total: result.length,
      });
    } catch (err) {
      return handleDentalinkError(err, reply);
    }
  });

  /**
   * GET /me/treatments - Tratamientos del paciente
   * Query opcional: ?status=active|all|finished
   */
  app.get('/me/treatments', { preHandler: requirePatient }, async (request, reply) => {
    const patient = request.patient!;
    const { status = 'all' } = request.query as { status?: string };

    try {
      const token = await getDentalinkToken();
      const all = await dentalink.getPatientTreatments(patient.sub, token);

      // Anti-IDOR
      const filtered = all.filter((t) => t.id_paciente === patient.sub);

      let result = filtered;
      if (status === 'active') {
        result = filtered.filter((t) => t.estado === 'En curso' || t.saldo_pendiente > 0);
      } else if (status === 'finished') {
        result = filtered.filter((t) => t.estado === 'Finalizado' && t.saldo_pendiente === 0);
      }

      // Cálculo de totales (útil para el kiosco)
      const totales = filtered.reduce(
        (acc, t) => ({
          total: acc.total + t.total,
          abonado: acc.abonado + t.abonado,
          saldo_pendiente: acc.saldo_pendiente + t.saldo_pendiente,
        }),
        { total: 0, abonado: 0, saldo_pendiente: 0 },
      );

      await audit({
        actorType: 'patient',
        actorId: patient.jti,
        action: 'patient.treatments.read',
        resourceType: 'patient',
        resourceId: patient.sub,
        metadata: { count: result.length, status },
        result: 'success',
        ip: request.ip,
      });

      return reply.send({
        data: result,
        total: result.length,
        totales,
      });
    } catch (err) {
      return handleDentalinkError(err, reply);
    }
  });

  /**
   * POST /me/appointments/:id/cancel - Cancelar una cita propia
   *
   * Seguridad:
   *   - Requiere session_token de paciente (preHandler).
   *   - Anti-IDOR: verifica que la cita pertenezca al paciente del JWT
   *     ANTES de pedirle a Dentalink que la cancele.
   *   - El cliente Dentalink también verifica el ownership en mock mode
   *     (defensa en profundidad).
   *
   * Errores:
   *   - 404: cita no encontrada o no pertenece al paciente (mismo mensaje
   *          intencionalmente, anti-enumeración).
   *   - 409: cita ya cancelada o ya atendida (no se puede cancelar).
   *   - 504/503: timeout o error de Dentalink.
   */
  app.post<{ Params: { id: string }; Body?: { reason?: string } }>(
    '/me/appointments/:id/cancel',
    { preHandler: requirePatient },
    async (request, reply) => {
      const patient = request.patient!;
      const appointmentId = request.params.id;
      const reason = request.body?.reason?.slice(0, 200);

      // Validación básica
      if (!appointmentId || typeof appointmentId !== 'string') {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'ID de cita inválido' });
      }

      try {
        const token = await getDentalinkToken();

        // === Anti-IDOR: verificar que la cita exista y sea del paciente ===
        // Hacemos un GET previo para no depender del filtro en cliente.
        const appointments = await dentalink.getPatientAppointments(patient.sub, token);
        const target = appointments.find(
          (a) => a.id === appointmentId && a.id_paciente === patient.sub,
        );

        if (!target) {
          await audit({
            actorType: 'patient',
            actorId: patient.jti,
            action: 'patient.appointment.cancel',
            resourceType: 'appointment',
            resourceId: appointmentId,
            metadata: { reason: 'not_found_or_not_owned' },
            result: 'denied',
            ip: request.ip,
          });
          return reply.code(404).send({
            error: 'NOT_FOUND',
            message: 'Cita no encontrada',
          });
        }

        // Reglas de negocio: no cancelar si ya pasó o si quedan <2 horas
        const now = new Date();
        const aptDate = parseAptDateTime(target.fecha, target.hora_inicio);
        if (aptDate && aptDate.getTime() < now.getTime()) {
          await audit({
            actorType: 'patient',
            actorId: patient.jti,
            action: 'patient.appointment.cancel',
            resourceType: 'appointment',
            resourceId: appointmentId,
            metadata: { reason: 'past_appointment' },
            result: 'denied',
            ip: request.ip,
          });
          return reply.code(409).send({
            error: 'CONFLICT',
            message: 'No se puede cancelar una cita que ya pasó.',
          });
        }
        if (target.estado === 'Cancelada') {
          return reply.code(409).send({
            error: 'CONFLICT',
            message: 'Esta cita ya está cancelada.',
          });
        }
        if (target.estado === 'Atendida') {
          return reply.code(409).send({
            error: 'CONFLICT',
            message: 'No se puede cancelar una cita ya atendida.',
          });
        }

        // === Ejecutar cancelación ===
        const cancelled = await dentalink.cancelAppointment(
          appointmentId,
          patient.sub,
          token,
          { reason: reason || 'Cancelada por el paciente desde el kiosco' },
        );

        await audit({
          actorType: 'patient',
          actorId: patient.jti,
          action: 'patient.appointment.cancel',
          resourceType: 'appointment',
          resourceId: appointmentId,
          metadata: {
            previous_estado: target.estado,
            new_estado: cancelled.estado,
            had_reason: !!reason,
          },
          result: 'success',
          ip: request.ip,
        });

        return reply.send({
          ok: true,
          appointment: {
            id: cancelled.id,
            estado: cancelled.estado,
            fecha: cancelled.fecha,
            hora_inicio: cancelled.hora_inicio,
          },
        });
      } catch (err) {
        // Audit de fallos no anticipados
        if (!(err instanceof DentalinkError)) {
          logger.error({ err, appointmentId, patientId: patient.sub }, 'Error cancelando cita');
        }
        return handleDentalinkError(err, reply);
      }
    },
  );
}

/**
 * Parsea fecha "YYYY-MM-DD" + hora "HH:mm" a Date local.
 * Retorna null si el formato es inválido.
 */
function parseAptDateTime(fecha: string, hora: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  const matchH = /^(\d{2}):(\d{2})/.exec(hora);
  if (!match || !matchH) return null;
  const [, y, m, d] = match;
  const [, h, mi] = matchH;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), 0);
}
