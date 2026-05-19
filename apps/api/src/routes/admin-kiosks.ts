/**
 * =============================================================================
 * Routes: /admin/kiosks/*
 * =============================================================================
 *
 * Gestión de kioscos desde el panel admin.
 *
 * Endpoints:
 *   GET    /admin/kiosks          — lista todos los kioscos
 *   POST   /admin/kiosks          — crea un kiosco nuevo y devuelve el token JWT
 *   PATCH  /admin/kiosks/:id      — activa o desactiva un kiosco
 *   DELETE /admin/kiosks/:id      — revoca un kiosco (soft delete)
 */

import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { requireAdmin } from '../lib/auth-middleware.js';
import { signKioskToken } from '../lib/jwt.js';

// ─────────────────────────────────────────────────────────────────────────────

const CreateKioskBody = z.object({
  name:        z.string().min(1).max(100),
  location:    z.string().max(200).optional(),
  device_type: z.enum(['pc', 'tablet_android', 'unknown']).default('unknown'),
});

const PatchKioskBody = z.object({
  is_active: z.boolean(),
});

// ─────────────────────────────────────────────────────────────────────────────

export async function adminKioskRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /admin/kiosks ──────────────────────────────────────────────────────
  app.get('/admin/kiosks', { preHandler: requireAdmin }, async (_req, reply) => {
    const { rows } = await db.query<{
      id: string;
      name: string;
      location: string | null;
      device_type: string;
      is_active: boolean;
      last_seen_at: string | null;
      last_ip: string | null;
      token_expires_at: string;
      created_at: string;
      revoked_at: string | null;
      revoked_reason: string | null;
    }>(
      `SELECT id, name, location, device_type, is_active,
              last_seen_at, last_ip, token_expires_at,
              created_at, revoked_at, revoked_reason
       FROM kiosks
       ORDER BY created_at DESC`,
    );

    return reply.send({ data: rows, total: rows.length });
  });

  // ── POST /admin/kiosks ─────────────────────────────────────────────────────
  // Crea un kiosco nuevo, genera su JWT y lo devuelve UNA SOLA VEZ.
  // El token no se puede recuperar después (solo se almacena el hash).
  app.post('/admin/kiosks', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CreateKioskBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
    }

    const { name, location, device_type } = parsed.data;
    const adminId = req.admin!.sub;
    const kioskId = randomUUID();

    const { token, jti, expiresAt } = await signKioskToken({ kioskId, kioskName: name });
    const tokenHash = createHash('sha256').update(token).digest('hex');

    await db.query(
      `INSERT INTO kiosks
         (id, name, location, device_type, token_hash, token_expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [kioskId, name, location ?? null, device_type, tokenHash, expiresAt, adminId],
    );

    logger.info({ kioskId, name, adminId }, 'Kiosk created');

    return reply.code(201).send({
      id:               kioskId,
      name,
      location:         location ?? null,
      device_type,
      is_active:        true,
      token_expires_at: expiresAt.toISOString(),
      created_at:       new Date().toISOString(),
      // El token JWT se devuelve aquí, una sola vez
      kiosk_token: token,
      jti,
    });
  });

  // ── PATCH /admin/kiosks/:id ────────────────────────────────────────────────
  // Activa o desactiva un kiosco.
  app.patch<{ Params: { id: string } }>(
    '/admin/kiosks/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params;
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'ID inválido.' });
      }

      const parsed = PatchKioskBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
      }

      const { is_active } = parsed.data;
      const adminId = req.admin!.sub;

      const result = await db.query(
        `UPDATE kiosks
         SET is_active  = $1,
             revoked_at = CASE WHEN $1 = false THEN now() ELSE NULL END,
             revoked_by = CASE WHEN $1 = false THEN $2::uuid ELSE NULL END
         WHERE id = $3
         RETURNING id, name, is_active`,
        [is_active, adminId, id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Kiosco no encontrado.' });
      }

      logger.info({ kioskId: id, is_active, adminId }, 'Kiosk status updated');
      return reply.send({ ok: true, ...result.rows[0] });
    },
  );

  // ── DELETE /admin/kiosks/:id ───────────────────────────────────────────────
  // Revoca el kiosco: lo desactiva con motivo "revoked_by_admin".
  app.delete<{ Params: { id: string } }>(
    '/admin/kiosks/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params;
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'ID inválido.' });
      }

      const adminId = req.admin!.sub;

      const result = await db.query(
        `UPDATE kiosks
         SET is_active      = false,
             revoked_at     = now(),
             revoked_by     = $1::uuid,
             revoked_reason = 'revoked_by_admin'
         WHERE id = $2
         RETURNING id`,
        [adminId, id],
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Kiosco no encontrado.' });
      }

      logger.info({ kioskId: id, adminId }, 'Kiosk revoked');
      return reply.send({ ok: true });
    },
  );
}
