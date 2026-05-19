/**
 * =============================================================================
 * Tests integración: /admin/kiosks/*
 * =============================================================================
 *
 * Usa Postgres real + Redis real.
 * Mock mode activo (DEV_MOCK_EXTERNAL_SERVICES=true en vitest.config.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { signAdminSession } from '../src/lib/jwt.js';
import { randomUUID } from 'crypto';

let app: FastifyInstance;
let adminToken: string;

const TEST_EMAIL = 'kiosk-admin-test@demo.local';

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const adminId = randomUUID();
  await db.query(
    `INSERT INTO admins (id, email, password_hash, full_name, role, mfa_required)
     VALUES ($1, $2, 'x', 'Kiosk Test Admin', 'admin', false)
     ON CONFLICT (email) DO UPDATE SET id = $1`,
    [adminId, TEST_EMAIL],
  );
  const row = await db.query<{ id: string }>(`SELECT id FROM admins WHERE email = $1`, [TEST_EMAIL]);
  const { token } = await signAdminSession({
    adminId: row.rows[0]!.id,
    email: TEST_EMAIL,
    role: 'admin',
    mfaVerified: true,
  });
  adminToken = token;
});

afterAll(async () => {
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'Test Kiosk%'`);
  await db.query(`DELETE FROM admins WHERE email = $1`, [TEST_EMAIL]);
  await app.close();
});

beforeEach(async () => {
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'Test Kiosk%'`);
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/kiosks', () => {
  it('devuelve lista vacía cuando no hay kioscos de test', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/kiosks', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('requiere autenticación', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/kiosks' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /admin/kiosks', () => {
  it('crea un kiosco y devuelve kiosk_token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Principal', device_type: 'pc' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Test Kiosk Principal');
    expect(body.device_type).toBe('pc');
    expect(body.is_active).toBe(true);
    expect(typeof body.kiosk_token).toBe('string');
    expect(body.kiosk_token.length).toBeGreaterThan(50);
    expect(body.id).toBeTruthy();
  });

  it('crea un kiosco con ubicación opcional', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Sucursal', location: 'Piso 2', device_type: 'tablet_android' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.location).toBe('Piso 2');
  });

  it('rechaza nombre vacío', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('requiere autenticación', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Sin Auth' }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /admin/kiosks después de crear', () => {
  it('el kiosco creado aparece en la lista', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Lista' }),
    });

    const res = await app.inject({ method: 'GET', url: '/admin/kiosks', headers: auth() });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const found = data.find((k: { name: string }) => k.name === 'Test Kiosk Lista');
    expect(found).toBeTruthy();
    expect(found.is_active).toBe(true);
    // El token NO debe exponerse en el listado
    expect(found.kiosk_token).toBeUndefined();
  });
});

describe('PATCH /admin/kiosks/:id', () => {
  it('desactiva un kiosco activo', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Desactivar' }),
    });
    const { id } = created.json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/kiosks/${id}`,
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().is_active).toBe(false);
  });

  it('reactiva un kiosco inactivo', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Reactivar' }),
    });
    const { id } = created.json();
    await app.inject({
      method: 'PATCH',
      url: `/admin/kiosks/${id}`,
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: false }),
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/kiosks/${id}`,
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().is_active).toBe(true);
  });

  it('devuelve 404 para ID inexistente', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/kiosks/${randomUUID()}`,
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: false }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('requiere autenticación', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/kiosks/${randomUUID()}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: false }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /admin/kiosks/:id', () => {
  it('revoca un kiosco existente', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Revocar' }),
    });
    const { id } = created.json();

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/kiosks/${id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('el kiosco revocado queda inactivo en la lista', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/kiosks',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Kiosk Revocado Check' }),
    });
    const { id } = created.json();

    await app.inject({ method: 'DELETE', url: `/admin/kiosks/${id}`, headers: auth() });

    const list = await app.inject({ method: 'GET', url: '/admin/kiosks', headers: auth() });
    const { data } = list.json();
    const found = data.find((k: { id: string }) => k.id === id);
    expect(found).toBeTruthy();
    expect(found.is_active).toBe(false);
    expect(found.revoked_at).toBeTruthy();
  });

  it('devuelve 404 para ID inexistente', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/kiosks/${randomUUID()}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
