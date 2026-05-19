/**
 * =============================================================================
 * Tests integración: /admin/dentists/* + /public/dentist-photo/:id
 * =============================================================================
 *
 * Usa:
 *   - Postgres real (migraciones aplicadas, tabla dentist_photos disponible)
 *   - Redis real
 *   - Mock de Dentalink (DEV_MOCK_EXTERNAL_SERVICES=true en vitest.config.ts)
 *
 * Mock dentists disponibles (MOCK_DENTISTS en dentalink.ts):
 *   dr-001: Roberto Sánchez  (sucursal 1)
 *   dr-002: Laura Méndez     (sucursal 1)
 *   dr-003: Carlos Vargas    (sucursal 1)
 *   dr-004: Ana Rojas        (sucursal 2)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { signAdminSession } from '../src/lib/jwt.js';
import { randomUUID } from 'crypto';

let app: FastifyInstance;
let adminToken: string;

// PNG 1×1 pixel — mínimo archivo válido para test
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
  '890000000a49444154789c6260000000020001e221bc330000000049454e44ae' +
  '426082',
  'hex',
);

// JPEG minimal header (no válido como imagen real pero suficiente para test de tipo MIME)
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

function buildMultipart(filename: string, mime: string, buf: Buffer) {
  const boundary = '----TestBoundary';
  const parts = [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`,
    `Content-Type: ${mime}\r\n`,
    '\r\n',
  ].join('');
  const end = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(parts), buf, Buffer.from(end)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Admin con MFA verificado
  const adminId = randomUUID();
  await db.query(
    `INSERT INTO admins (id, email, password_hash, full_name, role, mfa_required)
     VALUES ($1, 'denttest@demo.local', 'x', 'Dent Test', 'admin', false)
     ON CONFLICT (email) DO UPDATE SET id = $1`,
    [adminId],
  );
  // Necesitamos el ID real que quedó en BD
  const row = await db.query<{ id: string }>(`SELECT id FROM admins WHERE email = 'denttest@demo.local'`);
  const { token } = await signAdminSession({
    adminId: row.rows[0]!.id,
    email: 'denttest@demo.local',
    role: 'admin',
    mfaVerified: true,
  });
  adminToken = token;
});

afterAll(async () => {
  await db.query(`DELETE FROM dentist_photos WHERE dentalink_dentist_id LIKE 'dr-%'`);
  await db.query(`DELETE FROM admins WHERE email = 'denttest@demo.local'`);
  await app.close();
});

beforeEach(async () => {
  await db.query(`DELETE FROM dentist_photos WHERE dentalink_dentist_id LIKE 'dr-%'`);
});

// ─── helpers ──────────────────────────────────────────────────────────────────

const authHeader = () => ({ Authorization: `Bearer ${adminToken}` });

function uploadPhoto(dentistId: string, mime: string, buf: Buffer) {
  const { body, contentType } = buildMultipart('photo.img', mime, buf);
  return app.inject({
    method: 'POST',
    url: `/admin/dentists/${dentistId}/photo`,
    headers: { ...authHeader(), 'Content-Type': contentType },
    body,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /admin/dentists', () => {
  it('401 sin token', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/dentists' });
    expect(res.statusCode).toBe(401);
  });

  it('retorna lista de dentistas del mock con has_photo=false si no hay fotos', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/dentists', headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const { data, total } = res.json();
    expect(total).toBeGreaterThanOrEqual(4); // MOCK_DENTISTS tiene 4
    expect(data[0]).toMatchObject({ id: expect.any(String), nombre: expect.any(String) });
    expect(data.every((d: any) => d.has_photo === false)).toBe(true);
  });

  it('has_photo=true y photo_url presentes tras subir foto', async () => {
    await uploadPhoto('dr-001', 'image/png', TINY_PNG);

    const res = await app.inject({
      method: 'GET', url: '/admin/dentists', headers: authHeader(),
    });
    const { data } = res.json();
    const dr001 = data.find((d: any) => d.id === 'dr-001');
    expect(dr001.has_photo).toBe(true);
    expect(dr001.photo_url).toContain('dr-001');
    expect(dr001.photo_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('POST /admin/dentists/:id/photo', () => {
  it('401 sin token', async () => {
    const { body, contentType } = buildMultipart('photo.png', 'image/png', TINY_PNG);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/dentists/dr-001/photo',
      headers: { 'Content-Type': contentType },
      body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('201 sube foto PNG exitosamente', async () => {
    const res = await uploadPhoto('dr-001', 'image/png', TINY_PNG);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('201 sube foto JPEG exitosamente', async () => {
    const res = await uploadPhoto('dr-002', 'image/jpeg', TINY_JPEG);
    expect(res.statusCode).toBe(201);
  });

  it('400 tipo de archivo no permitido (GIF)', async () => {
    const gif = Buffer.from('47494638', 'hex'); // GIF89a header
    const res = await uploadPhoto('dr-001', 'image/gif', gif);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_FILE_TYPE');
  });

  it('reemplaza foto anterior al subir de nuevo', async () => {
    await uploadPhoto('dr-001', 'image/png', TINY_PNG);

    const { rows: before } = await db.query<{ photo_hash: string }>(
      `SELECT photo_hash FROM dentist_photos WHERE dentalink_dentist_id = 'dr-001'`,
    );
    const hashBefore = before[0]!.photo_hash;

    // Subir imagen diferente
    const buf2 = Buffer.concat([TINY_JPEG, Buffer.from('extra')]);
    await uploadPhoto('dr-001', 'image/jpeg', buf2);

    const { rows: after } = await db.query<{ photo_hash: string }>(
      `SELECT photo_hash FROM dentist_photos WHERE dentalink_dentist_id = 'dr-001'`,
    );
    expect(after[0]!.photo_hash).not.toBe(hashBefore);
  });
});

describe('DELETE /admin/dentists/:id/photo', () => {
  it('401 sin token', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/admin/dentists/dr-001/photo',
    });
    expect(res.statusCode).toBe(401);
  });

  it('elimina foto y borra registro en BD', async () => {
    await uploadPhoto('dr-001', 'image/png', TINY_PNG);

    const del = await app.inject({
      method: 'DELETE', url: '/admin/dentists/dr-001/photo', headers: authHeader(),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);

    const { rows } = await db.query(
      `SELECT * FROM dentist_photos WHERE dentalink_dentist_id = 'dr-001'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('no falla si el dentista no tenía foto', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/admin/dentists/dr-999/photo', headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /public/dentist-photo/:id', () => {
  it('404 si el dentista no tiene foto', async () => {
    const res = await app.inject({ method: 'GET', url: '/public/dentist-photo/dr-001' });
    expect(res.statusCode).toBe(404);
  });

  it('200 y Content-Type image/png tras subir foto PNG', async () => {
    await uploadPhoto('dr-001', 'image/png', TINY_PNG);

    const res = await app.inject({ method: 'GET', url: '/public/dentist-photo/dr-001' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('no requiere autenticación', async () => {
    await uploadPhoto('dr-002', 'image/jpeg', TINY_JPEG);

    const res = await app.inject({ method: 'GET', url: '/public/dentist-photo/dr-002' });
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /me/booking/dentists incluye photo_url', () => {
  it('photo_url es null sin foto', async () => {
    // Para este test necesitamos kiosk + patient session
    // Usamos el mismo patrón que booking.test.ts: signKioskToken + signPatientSession
    const { signKioskToken, signPatientSession } = await import('../src/lib/jwt.js');
    const { createHash } = await import('crypto');

    await db.query(`DELETE FROM kiosks WHERE name = 'DENT-Test'`);
    const k = await db.query<{ id: string }>(
      `INSERT INTO kiosks (name, token_hash, token_expires_at, is_active)
       VALUES ('DENT-Test', $1, now() + interval '1 day', true) RETURNING id`,
      [createHash('sha256').update('dent-kiosk').digest('hex')],
    );
    const { token: kt } = await signKioskToken({ kioskId: k.rows[0]!.id, kioskName: 'DENT-Test' });
    const { token: pt, jti, expiresAt } = await signPatientSession({ dentalinkPatientId: '12345', kioskId: k.rows[0]!.id });
    await db.query(
      `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at)
       VALUES ($1, '12345', $2, $3)`,
      [k.rows[0]!.id, jti, expiresAt],
    );

    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/dentists?branch_id=1',
      headers: { Authorization: `Bearer ${pt}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((d: any) => d.photo_url === null)).toBe(true);

    // Subir foto y re-consultar
    await uploadPhoto('dr-001', 'image/png', TINY_PNG);

    const res2 = await app.inject({
      method: 'GET',
      url: '/me/booking/dentists?branch_id=1',
      headers: { Authorization: `Bearer ${pt}` },
    });
    const { data: data2 } = res2.json();
    const dr001 = data2.find((d: any) => d.id === 'dr-001');
    expect(dr001.photo_url).toMatch(/\/public\/dentist-photo\/dr-001/);

    await db.query(`DELETE FROM kiosks WHERE name = 'DENT-Test'`);
  });
});
