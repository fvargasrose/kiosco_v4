/**
 * POST /licenses/validate
 *
 * Llamado por cada instalación de clínica al arrancar y periódicamente.
 * Autentica con X-License-Key en el header.
 * Devuelve estado actual + modo que el cliente debe imponer.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const Body = z.object({
  installation_id: z.string().min(1).max(64),
  machine_fingerprint: z.string().min(1).max(128),
  version: z.string().min(1).max(32),
});

type LicenseRow = {
  license_key: string;
  clinic_name: string;
  plan: string;
  features: string[];
  expires_at: Date;
  status: string;
};

export function computeMode(license: LicenseRow): 'normal' | 'shutdown' {
  if (license.status !== 'active') return 'shutdown';
  if (license.expires_at < new Date()) return 'shutdown';
  return 'normal';
}

export async function validateRoutes(app: FastifyInstance) {
  app.post('/licenses/validate', async (request, reply) => {
    const licenseKey = request.headers['x-license-key'];
    if (!licenseKey || typeof licenseKey !== 'string') {
      return reply.code(401).send({ error: 'LICENSE_KEY_REQUIRED' });
    }

    const parsed = Body.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
    }
    const { installation_id, machine_fingerprint, version } = parsed.data;

    const licResult = await db.query<LicenseRow>(
      `SELECT license_key, clinic_name, plan, features, expires_at, status
       FROM licenses WHERE license_key = $1`,
      [licenseKey],
    );

    const license = licResult.rows[0];
    if (!license) {
      await db.query(
        `INSERT INTO license_audit (license_key, event, installation_id, ip_address, metadata)
         VALUES ($1, 'validate_not_found', $2, $3::inet, $4::jsonb)`,
        [licenseKey, installation_id, request.ip, JSON.stringify({ version })],
      );
      return reply.code(404).send({ error: 'LICENSE_NOT_FOUND', valid: false, mode: 'shutdown' });
    }

    const mode = computeMode(license);
    const valid = mode === 'normal';

    // Upsert instalación
    await db.query(
      `INSERT INTO installations (license_key, installation_id, machine_fingerprint, installed_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (license_key, installation_id)
       DO UPDATE SET machine_fingerprint = EXCLUDED.machine_fingerprint,
                     installed_version   = EXCLUDED.installed_version`,
      [licenseKey, installation_id, machine_fingerprint, version],
    );

    await db.query(
      `INSERT INTO license_audit (license_key, event, installation_id, ip_address, metadata)
       VALUES ($1, 'validated', $2, $3::inet, $4::jsonb)`,
      [licenseKey, installation_id, request.ip, JSON.stringify({ version, mode, valid })],
    );

    logger.info({ license_key: licenseKey.slice(0, 8) + '…', installation_id, mode }, 'License validated');

    return reply.send({
      valid,
      mode,
      status: license.status,
      clinic_name: license.clinic_name,
      plan: license.plan,
      features: license.features ?? [],
      expires_at: license.expires_at.toISOString(),
    });
  });
}
