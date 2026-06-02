/**
 * =============================================================================
 * Tests integración: GET /kiosk/bootstrap — contrato de `clinic.logo_url`
 * =============================================================================
 *
 * Regresión del fix de branding: el frontend del kiosco consume `logo_url` como
 * `<img src>` directo (header global, sidebar apple y standby), SIN pasar por su
 * cliente HTTP (que antepone /api). Por eso la URL debe venir ya bajo /api, igual
 * que la convención del resto del kiosco y que la que usa el admin.
 *
 * Antes del fix el bootstrap emitía `/public/clinic-logo`, que no se enruta a la
 * API (cae en el fallback SPA) → la imagen nunca cargaba. Este test fija que la
 * URL empiece por `/api/public/clinic-logo` y conserve el cache-buster `?v=`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { redis } from '../src/lib/redis.js';
import { signKioskToken } from '../src/lib/jwt.js';

let app: FastifyInstance;
let kioskToken: string;
let kioskId: string;

const POLICY_TEXT = 'Aviso bootstrap logo test';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

// Hash de logo conocido — la URL debe incluir sus primeros 12 chars como ?v=
const LOGO_HASH = createHash('sha256').update('logo-fixture').digest('hex');

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
       VALUES (1, 'BL Test', 'BL', '000', 'TEST', $1, $2, $3, 30)`,
      [POLICY_HASH, POLICY_TEXT],
    );
  }

  await db.query(`DELETE FROM kiosks WHERE name LIKE 'BL-%'`);
  const kioskRes = await db.query<{ id: string }>(
    `INSERT INTO kiosks (name, token_hash, token_expires_at, is_active)
     VALUES ('BL-Test', $1, now() + interval '1 day', true)
     RETURNING id`,
    [createHash('sha256').update('bl-kiosk').digest('hex')],
  );
  kioskId = kioskRes.rows[0]!.id;
  const k = await signKioskToken({ kioskId, kioskName: 'BL-Test' });
  kioskToken = k.token;
});

afterAll(async () => {
  // Restaurar columnas de logo a NULL para no contaminar otros tests / dev DB.
  await db.query(
    `UPDATE clinic SET logo_path = NULL, logo_hash = NULL, logo_mime = NULL,
                       logo_updated_at = NULL WHERE id = 1`,
  );
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'BL-%'`);
  await app.close();
});

const auth = () => ({ authorization: `Bearer ${kioskToken}` });

describe('GET /kiosk/bootstrap — clinic.logo_url', () => {
  it('logo.url_under_api: emite /api/public/clinic-logo con cache-buster cuando hay logo', async () => {
    await db.query(
      `UPDATE clinic SET logo_path = '/tmp/clinic-logo.png', logo_hash = $1,
                         logo_mime = 'image/png' WHERE id = 1`,
      [LOGO_HASH],
    );

    const res = await app.inject({ method: 'GET', url: '/kiosk/bootstrap', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.clinic.logo_url).toMatch(/^\/api\/public\/clinic-logo\?v=/);
    // Cache-buster = primeros 12 chars del hash
    expect(body.clinic.logo_url).toContain(`?v=${LOGO_HASH.slice(0, 12)}`);
  });

  it('logo.null_when_absent: logo_url es null cuando no hay logo subido', async () => {
    await db.query(
      `UPDATE clinic SET logo_path = NULL, logo_hash = NULL WHERE id = 1`,
    );

    const res = await app.inject({ method: 'GET', url: '/kiosk/bootstrap', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.clinic.logo_url).toBeNull();
  });
});
