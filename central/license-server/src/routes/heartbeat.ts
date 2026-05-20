/**
 * POST /licenses/heartbeat
 *
 * La instalación reporta que sigue viva + métricas de salud.
 * El servidor actualiza last_heartbeat_at y devuelve el modo actual.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { computeMode } from './validate.js';

const MetricsSchema = z.object({
  cpu_percent:    z.number().min(0).max(100).optional(),
  memory_mb:      z.number().positive().optional(),
  disk_free_gb:   z.number().min(0).optional(),
  uptime_hours:   z.number().min(0).optional(),
}).optional();

const Body = z.object({
  installation_id:    z.string().min(1).max(64),
  machine_fingerprint: z.string().min(1).max(128),
  version:            z.string().min(1).max(32),
  metrics:            MetricsSchema,
});

export async function heartbeatRoutes(app: FastifyInstance) {
  app.post('/licenses/heartbeat', async (request, reply) => {
    const licenseKey = request.headers['x-license-key'];
    if (!licenseKey || typeof licenseKey !== 'string') {
      return reply.code(401).send({ error: 'LICENSE_KEY_REQUIRED' });
    }

    const parsed = Body.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
    }
    const { installation_id, machine_fingerprint, version, metrics } = parsed.data;

    const licResult = await db.query<{
      license_key: string; clinic_name: string; plan: string;
      features: string[]; expires_at: Date; status: string;
    }>(
      `SELECT license_key, clinic_name, plan, features, expires_at, status
       FROM licenses WHERE license_key = $1`,
      [licenseKey],
    );

    const license = licResult.rows[0];
    if (!license) {
      return reply.code(404).send({ error: 'LICENSE_NOT_FOUND', mode: 'shutdown' });
    }

    const mode = computeMode(license);

    // Actualizar instalación con last_heartbeat_at y métricas
    await db.query(
      `INSERT INTO installations
         (license_key, installation_id, machine_fingerprint, installed_version,
          last_heartbeat_at, health_metrics)
       VALUES ($1, $2, $3, $4, now(), $5::jsonb)
       ON CONFLICT (license_key, installation_id)
       DO UPDATE SET machine_fingerprint = EXCLUDED.machine_fingerprint,
                     installed_version   = EXCLUDED.installed_version,
                     last_heartbeat_at   = now(),
                     health_metrics      = EXCLUDED.health_metrics`,
      [licenseKey, installation_id, machine_fingerprint, version,
       JSON.stringify(metrics ?? null)],
    );

    await db.query(
      `INSERT INTO license_audit (license_key, event, installation_id, ip_address, metadata)
       VALUES ($1, 'heartbeat', $2, $3::inet, $4::jsonb)`,
      [licenseKey, installation_id, request.ip,
       JSON.stringify({ version, mode, metrics: metrics ?? null })],
    );

    logger.debug({ license_key: licenseKey.slice(0, 8) + '…', installation_id, mode }, 'Heartbeat received');

    return reply.send({ ok: true, mode });
  });
}
