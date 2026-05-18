/**
 * =============================================================================
 * Patient auth middleware
 * =============================================================================
 *
 * Verifica el JWT de sesión de paciente y carga claims en request.patient.
 * Adicionalmente verifica que la sesión no esté revocada en BD (defensa en
 * profundidad: incluso si el JWT es válido criptográficamente, si fue
 * revocado vía /logout, debe rechazarse).
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyPatientSession, type PatientSessionClaims } from './jwt.js';
import { db } from './db.js';
import { audit } from './audit.js';

declare module 'fastify' {
  interface FastifyRequest {
    patient?: PatientSessionClaims;
  }
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match ? match[1]! : null;
}

/**
 * Verifica que la request tenga un JWT de paciente válido y NO revocado.
 */
export async function requirePatient(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractBearer(request.headers.authorization);

  if (!token) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Sesión de paciente requerida',
    });
  }

  let claims: PatientSessionClaims;
  try {
    claims = await verifyPatientSession(token);
  } catch {
    await audit({
      actorType: 'system',
      action: 'patient.session.invalid_token',
      result: 'denied',
      ip: request.ip,
    });
    return reply
      .code(401)
      .send({ error: 'UNAUTHORIZED', message: 'Sesión inválida o expirada' });
  }

  // Defensa en profundidad: verificar que la sesión no fue revocada
  const sessionRow = await db.query<{
    revoked_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT revoked_at, expires_at
     FROM patient_sessions
     WHERE jti = $1`,
    [claims.jti],
  );

  const session = sessionRow.rows[0];
  if (!session) {
    await audit({
      actorType: 'system',
      action: 'patient.session.not_in_db',
      resourceId: claims.jti,
      result: 'denied',
      ip: request.ip,
    });
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Sesión no encontrada' });
  }

  if (session.revoked_at) {
    await audit({
      actorType: 'system',
      action: 'patient.session.revoked',
      resourceId: claims.jti,
      result: 'denied',
      ip: request.ip,
    });
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Sesión revocada' });
  }

  if (session.expires_at < new Date()) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Sesión expirada' });
  }

  request.patient = claims;
}
