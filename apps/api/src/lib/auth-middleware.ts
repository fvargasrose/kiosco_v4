/**
 * =============================================================================
 * Auth middleware - Verifica JWT de admin en requests
 * =============================================================================
 *
 * Uso:
 *   app.get('/admin/me', { preHandler: requireAdmin }, async (req, reply) => {
 *     // req.admin contiene los claims
 *   });
 *
 *   app.get('/admin/users', { preHandler: [requireAdmin, requireMfa] }, ...);
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAdminSession, type AdminSessionClaims } from '../lib/jwt.js';
import { audit } from '../lib/audit.js';
import { redis } from '../lib/redis.js';

/** Prefijo de la blocklist de sesiones admin revocadas (logout) en Redis. */
export const ADMIN_BLOCKLIST_PREFIX = 'admin:blocklist:';

// Extender el tipo de FastifyRequest para incluir admin
declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminSessionClaims;
  }
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match ? match[1]! : null;
}

/**
 * Verifica que la request tenga un JWT admin válido.
 * No verifica MFA (eso es requireMfa).
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearer(request.headers.authorization);

  if (!token) {
    await audit({
      actorType: 'system',
      action: 'admin.auth.missing_token',
      result: 'denied',
      ip: request.ip,
    });
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Token requerido' });
  }

  try {
    const claims = await verifyAdminSession(token);

    // Blocklist: una sesión cerrada vía /logout se rechaza aunque el JWT siga
    // siendo criptográficamente válido (revocación real de sesiones admin).
    const revoked = await redis.get(`${ADMIN_BLOCKLIST_PREFIX}${claims.jti}`);
    if (revoked) {
      await audit({
        actorType: 'admin',
        actorId: claims.sub,
        actorEmail: claims.email,
        action: 'admin.auth.revoked_token',
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Sesión cerrada' });
    }

    request.admin = claims;
  } catch (err) {
    await audit({
      actorType: 'system',
      action: 'admin.auth.invalid_token',
      metadata: { error: err instanceof Error ? err.message : 'unknown' },
      result: 'denied',
      ip: request.ip,
    });
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Token inválido o expirado' });
  }
}

/**
 * Verifica que el admin haya completado MFA en esta sesión.
 * Debe usarse JUNTO con requireAdmin (después).
 */
export async function requireMfa(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.admin) {
    return reply.code(401).send({ error: 'UNAUTHORIZED' });
  }
  if (!request.admin.mfa_verified) {
    return reply.code(403).send({
      error: 'MFA_REQUIRED',
      message: 'Esta operación requiere verificación MFA reciente',
    });
  }
}

/**
 * Verifica que el admin tenga uno de los roles permitidos.
 */
export function requireRole(...allowedRoles: Array<'admin' | 'viewer'>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.admin) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
    if (!allowedRoles.includes(request.admin.role)) {
      await audit({
        actorType: 'admin',
        actorId: request.admin.sub,
        actorEmail: request.admin.email,
        action: 'admin.auth.insufficient_role',
        metadata: { required: allowedRoles, has: request.admin.role },
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(403).send({ error: 'INSUFFICIENT_ROLE' });
    }
  };
}
