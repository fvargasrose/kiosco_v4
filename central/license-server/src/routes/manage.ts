/**
 * Endpoints de gestión — solo para el proveedor (AllCreative).
 * Autenticados con X-Superadmin-Key.
 *
 * POST /licenses              — Emitir nueva licencia
 * POST /licenses/:key/revoke  — Revocar licencia
 * GET  /licenses              — Listar licencias
 * GET  /licenses/:key         — Ver detalle + instalaciones
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';

function requireSuperadmin(key: string | string[] | undefined): boolean {
  if (!key || typeof key !== 'string') return false;
  // Comparación en tiempo constante para evitar timing attacks
  const expected = config.SUPERADMIN_API_KEY;
  if (key.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) {
    diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function generateLicenseKey(): string {
  // Formato: DK-XXXXXXXX-XXXXXXXX-XXXXXXXX  (3 grupos de 8 hex en mayúsculas)
  const hex = randomBytes(12).toString('hex').toUpperCase();
  return `DK-${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16, 24)}`;
}

const IssueBody = z.object({
  clinic_name:  z.string().min(2).max(100),
  plan:         z.enum(['standard', 'professional', 'enterprise']).default('standard'),
  features:     z.array(z.string()).default([]),
  expires_days: z.coerce.number().int().min(1).max(3650),
  notes:        z.string().max(500).optional(),
});

const RevokeBody = z.object({
  reason: z.string().max(200).optional(),
});

export async function manageRoutes(app: FastifyInstance) {
  // Guardia de superadmin para todas las rutas de este plugin
  app.addHook('onRequest', async (request, reply) => {
    if (!requireSuperadmin(request.headers['x-superadmin-key'])) {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });

  /** Emitir nueva licencia */
  app.post('/licenses', async (request, reply) => {
    const parsed = IssueBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
    }
    const { clinic_name, plan, features, expires_days, notes } = parsed.data;

    const licenseKey = generateLicenseKey();
    const expiresAt = new Date(Date.now() + expires_days * 24 * 60 * 60 * 1000);

    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO licenses (license_key, clinic_name, plan, features, expires_at, notes)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [licenseKey, clinic_name, plan, JSON.stringify(features), expiresAt, notes ?? null],
      );
      await client.query(
        `INSERT INTO license_audit (license_key, event, ip_address, metadata)
         VALUES ($1, 'issued', $2::inet, $3::jsonb)`,
        [licenseKey, request.ip,
         JSON.stringify({ clinic_name, plan, expires_days, expires_at: expiresAt })],
      );
    });

    logger.info({ license_key: licenseKey, clinic_name, plan, expires_days }, 'License issued');

    return reply.code(201).send({
      license_key: licenseKey,
      clinic_name,
      plan,
      features,
      expires_at: expiresAt.toISOString(),
      status: 'active',
    });
  });

  /** Revocar licencia */
  app.post('/licenses/:key/revoke', async (request, reply) => {
    const { key } = request.params as { key: string };
    const parsed = RevokeBody.safeParse(request.body);
    const reason = parsed.success ? (parsed.data.reason ?? 'revoked_by_admin') : 'revoked_by_admin';

    const result = await db.query(
      `UPDATE licenses SET status = 'revoked'
       WHERE license_key = $1 AND status != 'revoked'
       RETURNING license_key`,
      [key],
    );

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: 'NOT_FOUND_OR_ALREADY_REVOKED' });
    }

    await db.query(
      `INSERT INTO license_audit (license_key, event, ip_address, metadata)
       VALUES ($1, 'revoked', $2::inet, $3::jsonb)`,
      [key, request.ip, JSON.stringify({ reason })],
    );

    logger.warn({ license_key: key, reason }, 'License revoked');
    return reply.send({ ok: true });
  });

  /** Listar todas las licencias */
  app.get('/licenses', async (_req, reply) => {
    const result = await db.query(
      `SELECT l.license_key, l.clinic_name, l.plan, l.status, l.expires_at,
              l.payment_status, l.issued_at,
              COUNT(i.id) AS installations_count,
              MAX(i.last_heartbeat_at) AS last_heartbeat_at
       FROM licenses l
       LEFT JOIN installations i ON i.license_key = l.license_key
       GROUP BY l.license_key
       ORDER BY l.issued_at DESC`,
    );
    return reply.send({ licenses: result.rows });
  });

  /** Detalle de una licencia + sus instalaciones */
  app.get('/licenses/:key', async (request, reply) => {
    const { key } = request.params as { key: string };

    const licResult = await db.query(
      `SELECT license_key, clinic_name, plan, features, status, expires_at,
              payment_status, issued_at, notes
       FROM licenses WHERE license_key = $1`,
      [key],
    );
    if (!licResult.rows[0]) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }

    const instResult = await db.query(
      `SELECT installation_id, machine_fingerprint, installed_version,
              last_heartbeat_at, health_metrics, first_seen_at
       FROM installations WHERE license_key = $1
       ORDER BY last_heartbeat_at DESC NULLS LAST`,
      [key],
    );

    return reply.send({ license: licResult.rows[0], installations: instResult.rows });
  });
}
