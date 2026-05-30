/**
 * =============================================================================
 * Tests integración: GET /kiosk/bootstrap — contrato de `procedures`
 * =============================================================================
 *
 * Verifica el contrato que el frontend (paso "treatment") consume:
 *   - bootstrap.procedures_only_active — array de SOLO los activos.
 *   - bootstrap.procedures_empty_is_array — [] (no null) cuando no hay activos,
 *     que es lo que dispara el fallback "Consulta general" en el frontend.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { redis } from '../src/lib/redis.js';
import { signKioskToken } from '../src/lib/jwt.js';

let app: FastifyInstance;
let kioskToken: string;
let kioskId: string;

const POLICY_TEXT = 'Aviso bootstrap procedures test';
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
       VALUES (1, 'BP Test', 'BP', '000', 'TEST', $1, $2, $3, 30)`,
      [POLICY_HASH, POLICY_TEXT],
    );
  }

  await db.query(`DELETE FROM kiosks WHERE name LIKE 'BP-%'`);
  const kioskRes = await db.query<{ id: string }>(
    `INSERT INTO kiosks (name, token_hash, token_expires_at, is_active)
     VALUES ('BP-Test', $1, now() + interval '1 day', true)
     RETURNING id`,
    [createHash('sha256').update('bp-kiosk').digest('hex')],
  );
  kioskId = kioskRes.rows[0]!.id;
  const k = await signKioskToken({ kioskId, kioskName: 'BP-Test' });
  kioskToken = k.token;
});

afterAll(async () => {
  await db.query(`DELETE FROM clinic_procedures WHERE clinic_id = 1`);
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'BP-%'`);
  const keys = await redis.getClient().keys('dl:*');
  if (keys.length > 0) await redis.del(...keys);
  await app.close();
});

beforeEach(async () => {
  await db.query(`DELETE FROM clinic_procedures WHERE clinic_id = 1`);
});

const auth = () => ({ authorization: `Bearer ${kioskToken}` });

describe('GET /kiosk/bootstrap — procedures', () => {
  it('bootstrap.procedures_only_active: devuelve array de SOLO los activos', async () => {
    await db.query(
      `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes, active) VALUES
        (1, 'Activo A', 30, true),
        (1, 'Activo B', 45, true),
        (1, 'Inactivo C', 60, false)`,
    );

    const res = await app.inject({ method: 'GET', url: '/kiosk/bootstrap', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Array.isArray(body.procedures)).toBe(true);
    expect(body.procedures).toHaveLength(2); // solo los 2 activos
    const names = body.procedures.map((p: { name: string }) => p.name);
    expect(names).toContain('Activo A');
    expect(names).toContain('Activo B');
    expect(names).not.toContain('Inactivo C');
    // Contrato de campos
    expect(body.procedures[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        duration_minutes: expect.any(Number),
      }),
    );
    expect(body.procedures[0]).toHaveProperty('description');
  });

  it('bootstrap.procedures_empty_is_array: devuelve [] (no null) cuando no hay activos', async () => {
    // Sin filas activas (solo una inactiva).
    await db.query(
      `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes, active)
       VALUES (1, 'Inactivo único', 30, false)`,
    );

    const res = await app.inject({ method: 'GET', url: '/kiosk/bootstrap', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Array.isArray(body.procedures)).toBe(true);
    expect(body.procedures).toHaveLength(0);
    expect(body.procedures).not.toBeNull();
  });
});
