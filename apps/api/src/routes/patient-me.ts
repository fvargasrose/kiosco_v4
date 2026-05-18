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
 * Mapper de errores Dentalink a respuestas HTTP.
 */
function handleDentalinkError(err: unknown, reply: { code(c: number): { send(b: object): unknown } }) {
  if (err instanceof DentalinkError) {
    if (err.code === 'TIMEOUT') {
      return reply.code(504).send({
        error: 'UPSTREAM_TIMEOUT',
        message: 'El sistema de gestión está tardando en responder. Por favor intenta de nuevo.',
      });
    }
    if (err.code === 'UNAUTHORIZED') {
      logger.error({ err }, 'Dentalink token rejected - clinic config issue');
      return reply.code(503).send({
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'Servicio temporalmente no disponible. Contacte a recepción.',
      });
    }
    if (err.code === 'NOT_FOUND') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    return reply.code(503).send({
      error: 'UPSTREAM_ERROR',
      message: 'Error al consultar el sistema de gestión.',
    });
  }
  logger.error({ err }, 'Unexpected error in /me/* route');
  return reply.code(500).send({ error: 'INTERNAL' });
}

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
}
