/**
 * =============================================================================
 * Tests integración: GET /public/* — acceso web público (Hito A, Opción A)
 * =============================================================================
 *
 * Verifican que la configuración de clínica se sirve SIN kiosk_token:
 *   - /public/bootstrap responde 200 sin Authorization y trae el contrato que
 *     el frontend web necesita (clinic, habeas_data, flags, turnstile_sitekey).
 *   - NUNCA expone secretos (tokens cifrados, paths internos).
 *   - /public/standby responde 200 sin auth.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';

let app: FastifyInstance;

const POLICY_TEXT = 'Aviso público bootstrap test';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                          habeas_data_policy_version, habeas_data_policy_hash,
                          habeas_data_policy_text, duracion_cita_minutos)
       VALUES (1, 'Pub Test', 'PubTest', '000', 'TEST', 'pub-v1', $1, $2, 30)`,
      [POLICY_HASH, POLICY_TEXT],
    );
  } else {
    await db.query(
      `UPDATE clinic
       SET habeas_data_policy_version = 'pub-v1',
           habeas_data_policy_hash = $1,
           habeas_data_policy_text = $2
       WHERE id = 1`,
      [POLICY_HASH, POLICY_TEXT],
    );
  }
});

afterAll(async () => {
  await app.close();
});

describe('GET /public/bootstrap', () => {
  it('responde 200 SIN Authorization header (acceso público)', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/bootstrap' });
    expect(res.statusCode).toBe(200);
  });

  it('trae el contrato esperado por el frontend web', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/bootstrap' });
    const body = res.json();

    expect(body.clinic).toBeTruthy();
    expect(typeof body.clinic.display_name).toBe('string');
    expect(body.habeas_data).toBeTruthy();
    expect(body.habeas_data.version).toBe('pub-v1');
    expect(Array.isArray(body.procedures)).toBe(true);
    expect(Array.isArray(body.faq)).toBe(true);
    expect(body.standby).toBeTruthy();
    expect(typeof body.otp_required).toBe('boolean');
    expect(typeof body.feature_registro).toBe('boolean');
    expect('turnstile_sitekey' in body).toBe(true); // hook Turnstile (null en dev)
    expect(typeof body.server_time).toBe('string');
  });

  it('NO expone secretos (token Dentalink, claim de kiosco, paths internos)', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/bootstrap' });
    const raw = res.payload;
    expect(raw).not.toContain('dentalink_token');
    expect(raw).not.toContain('token_encrypted');
    expect(raw).not.toContain('kiosk_token');
    expect(raw).not.toContain('/var/'); // logo_path interno nunca expuesto
  });
});

describe('GET /public/standby', () => {
  it('responde 200 sin auth y trae mode/title/subtitle', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/standby' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.mode).toBe('string');
    expect('title' in body).toBe(true);
    expect('subtitle' in body).toBe(true);
  });
});
