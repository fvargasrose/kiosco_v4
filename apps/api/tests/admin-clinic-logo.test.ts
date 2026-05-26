/**
 * =============================================================================
 * Tests integración: /admin/clinic/logo (PUT/DELETE) + GET /admin/clinic
 * =============================================================================
 *
 * Cubre:
 *   - PUT acepta PNG, JPG, WEBP (validados por magic bytes)
 *   - PUT rechaza tipo declarado mentiroso (mime=image/png, bytes de PDF)
 *   - PUT rechaza archivo >2MB
 *   - PUT sobreescribe y borra la extensión previa del filesystem
 *   - DELETE limpia columnas y archivo
 *   - GET /admin/clinic refleja logo.has
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, unlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { signAdminSession } from '../src/lib/jwt.js';
import { config } from '../src/lib/config.js';

let app: FastifyInstance;
let adminToken: string;

const TEST_EMAIL = 'logo-admin-test@demo.local';

// PNG 1×1 pixel — header válido reconocido por detectImageMime
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4' +
  '890000000a49444154789c6260000000020001e221bc330000000049454e44ae' +
  '426082',
  'hex',
);

// JPEG mínimo (header FF D8 FF + EOI)
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

// WEBP mínimo (header RIFF????WEBP)
const TINY_WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // tamaño placeholder
  0x57, 0x45, 0x42, 0x50, // "WEBP"
  0x56, 0x50, 0x38, 0x20, // "VP8 "
  0x18, 0x00, 0x00, 0x00, // tamaño chunk
  // payload mínimo (no necesita ser válido para test de magic bytes)
  0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00,
  0x01, 0x00, 0x03, 0x00, 0x34, 0x25, 0xa4, 0x00,
  0x03, 0x70, 0x00, 0xfe, 0xfb, 0x94, 0x00, 0x00,
]);

// PDF (magic %PDF-) — debe ser rechazado aunque venga con mimetype=image/png
const TINY_PDF = Buffer.from(
  '255044462d312e0a25e2e3cfd30a312030206f626a0a3c3c2f54797065202f4361' +
  '74616c6f672f50616765732032203020523e3e0a656e646f626a0a',
  'hex',
);

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

function uploadsDir(): string {
  return path.resolve(process.cwd(), config.UPLOADS_DIR);
}

function cleanLogoFiles() {
  for (const ext of ['png', 'jpg', 'webp']) {
    const p = path.join(uploadsDir(), `clinic-logo.${ext}`);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Asegurar clinic singleton
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key)
       VALUES (1, 'Logo Test', 'LT', '000', 'TEST')`,
    );
  }

  const adminId = randomUUID();
  await db.query(
    `INSERT INTO admins (id, email, password_hash, full_name, role, mfa_required)
     VALUES ($1, $2, 'x', 'Logo Admin', 'admin', false)
     ON CONFLICT (email) DO UPDATE SET id = $1`,
    [adminId, TEST_EMAIL],
  );
  const row = await db.query<{ id: string }>(
    `SELECT id FROM admins WHERE email = $1`,
    [TEST_EMAIL],
  );
  const { token } = await signAdminSession({
    adminId: row.rows[0]!.id,
    email: TEST_EMAIL,
    role: 'admin',
    mfaVerified: true,
  });
  adminToken = token;
});

afterAll(async () => {
  cleanLogoFiles();
  await db.query(
    `UPDATE clinic
     SET logo_path = NULL, logo_hash = NULL, logo_mime = NULL, logo_updated_at = NULL
     WHERE id = 1`,
  );
  await db.query(`DELETE FROM admins WHERE email = $1`, [TEST_EMAIL]);
  await app.close();
});

beforeEach(async () => {
  cleanLogoFiles();
  await db.query(
    `UPDATE clinic
     SET logo_path = NULL, logo_hash = NULL, logo_mime = NULL, logo_updated_at = NULL
     WHERE id = 1`,
  );
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /admin/clinic/logo', () => {
  it('requiere autenticación', async () => {
    const { body, contentType } = buildMultipart('logo.png', 'image/png', TINY_PNG);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { 'Content-Type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('acepta PNG válido', async () => {
    const { body, contentType } = buildMultipart('logo.png', 'image/png', TINY_PNG);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.ext).toBe('png');
    expect(json.mime).toBe('image/png');
    expect(json.hash).toMatch(/^[0-9a-f]{64}$/);

    const r = await db.query<{ logo_path: string; logo_mime: string; logo_hash: string }>(
      `SELECT logo_path, logo_mime, logo_hash FROM clinic WHERE id = 1`,
    );
    expect(r.rows[0]?.logo_mime).toBe('image/png');
    expect(existsSync(r.rows[0]!.logo_path!)).toBe(true);
  });

  it('acepta JPG válido', async () => {
    const { body, contentType } = buildMultipart('logo.jpg', 'image/jpeg', TINY_JPEG);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ext).toBe('jpg');
    expect(res.json().mime).toBe('image/jpeg');
  });

  it('acepta WEBP válido', async () => {
    const { body, contentType } = buildMultipart('logo.webp', 'image/webp', TINY_WEBP);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ext).toBe('webp');
    expect(res.json().mime).toBe('image/webp');
  });

  it('rechaza PDF disfrazado de PNG (magic bytes manda)', async () => {
    const { body, contentType } = buildMultipart('fake.png', 'image/png', TINY_PDF);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_FILE_TYPE');
  });

  it('rechaza archivo >2MB', async () => {
    // 2.5 MB de PNG falso (header válido + padding)
    const padding = Buffer.alloc(2.5 * 1024 * 1024, 0);
    const big = Buffer.concat([TINY_PNG, padding]);
    const { body, contentType } = buildMultipart('big.png', 'image/png', big);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('FILE_TOO_LARGE');
  });

  it('sobreescritura borra archivo de la extensión previa', async () => {
    // Sube PNG
    const m1 = buildMultipart('logo.png', 'image/png', TINY_PNG);
    await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': m1.contentType },
      payload: m1.body,
    });
    expect(existsSync(path.join(uploadsDir(), 'clinic-logo.png'))).toBe(true);

    // Sube JPG (debe borrar el PNG previo)
    const m2 = buildMultipart('logo.jpg', 'image/jpeg', TINY_JPEG);
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': m2.contentType },
      payload: m2.body,
    });
    expect(res.statusCode).toBe(200);

    const files = readdirSync(uploadsDir()).filter((f) => f.startsWith('clinic-logo.'));
    expect(files).toEqual(['clinic-logo.jpg']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /admin/clinic/logo', () => {
  it('limpia columnas y borra archivo', async () => {
    // Subo primero
    const { body, contentType } = buildMultipart('logo.png', 'image/png', TINY_PNG);
    await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': contentType },
      payload: body,
    });
    expect(existsSync(path.join(uploadsDir(), 'clinic-logo.png'))).toBe(true);

    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/clinic/logo',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    expect(existsSync(path.join(uploadsDir(), 'clinic-logo.png'))).toBe(false);
    const r = await db.query<{ logo_path: string | null; logo_hash: string | null }>(
      `SELECT logo_path, logo_hash FROM clinic WHERE id = 1`,
    );
    expect(r.rows[0]?.logo_path).toBeNull();
    expect(r.rows[0]?.logo_hash).toBeNull();
  });

  it('no falla si no hay logo', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/clinic/logo',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/clinic — campo logo', () => {
  it('logo.has=false cuando no hay logo subido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/clinic',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logo.has).toBe(false);
    expect(res.json().logo.hash).toBeNull();
  });

  it('logo.has=true tras subir', async () => {
    const { body, contentType } = buildMultipart('logo.png', 'image/png', TINY_PNG);
    await app.inject({
      method: 'PUT',
      url: '/admin/clinic/logo',
      headers: { ...auth(), 'Content-Type': contentType },
      payload: body,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/clinic',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const logo = res.json().logo;
    expect(logo.has).toBe(true);
    expect(logo.mime).toBe('image/png');
    expect(logo.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(logo.updated_at).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET/PATCH /admin/clinic — standby.video_sound', () => {
  beforeEach(async () => {
    // Reset al default antes de cada caso para no arrastrar estado.
    await db.query(`UPDATE clinic SET standby_video_sound = false WHERE id = 1`);
  });

  it('GET devuelve standby.video_sound=false por defecto', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/clinic',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().standby.video_sound).toBe(false);
  });

  it('PATCH persiste standby_video_sound=true y GET lo refleja', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/clinic',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ standby_video_sound: true }),
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().ok).toBe(true);

    const getRes = await app.inject({
      method: 'GET',
      url: '/admin/clinic',
      headers: auth(),
    });
    expect(getRes.json().standby.video_sound).toBe(true);

    const r = await db.query<{ standby_video_sound: boolean }>(
      `SELECT standby_video_sound FROM clinic WHERE id = 1`,
    );
    expect(r.rows[0]?.standby_video_sound).toBe(true);
  });

  it('PATCH rechaza standby_video_sound no booleano', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/clinic',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      payload: JSON.stringify({ standby_video_sound: 'yes' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
  });
});
