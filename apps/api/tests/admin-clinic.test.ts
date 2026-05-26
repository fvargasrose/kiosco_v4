/**
 * =============================================================================
 * Tests integración: /admin/procedures
 * =============================================================================
 *
 * CRUD del catálogo local de procedimientos. La duración debe estar limitada
 * al conjunto que Dentalink acepta: {15, 30, 45, 60, 75, 90, 105, 120}.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { signAdminSession } from '../src/lib/jwt.js';
import { randomUUID } from 'crypto';

let app: FastifyInstance;
let adminToken: string;

const TEST_EMAIL = 'procedures-admin-test@demo.local';

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Asegurar que existe una clinic (id=1). El trigger de singleton lanza
  // excepción al intentar INSERT si ya existe, así que verificamos antes.
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key)
       VALUES (1, 'Procedure Test', 'PT', '000', 'TEST')`,
    );
  }

  const adminId = randomUUID();
  await db.query(
    `INSERT INTO admins (id, email, password_hash, full_name, role, mfa_required)
     VALUES ($1, $2, 'x', 'Procedures Test Admin', 'admin', false)
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
  await db.query(`DELETE FROM clinic_procedures WHERE clinic_id = 1`);
  await db.query(`DELETE FROM admins WHERE email = $1`, [TEST_EMAIL]);
  await app.close();
});

beforeEach(async () => {
  await db.query(`DELETE FROM clinic_procedures WHERE clinic_id = 1`);
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const jsonHeaders = () => ({ ...auth(), 'Content-Type': 'application/json' });

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/procedures', () => {
  it('requiere autenticación', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/procedures' });
    expect(res.statusCode).toBe(401);
  });

  it('devuelve lista vacía cuando no hay procedimientos', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/procedures',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('lista activos e inactivos', async () => {
    await db.query(
      `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes, active)
       VALUES (1, 'Activo', 30, true), (1, 'Inactivo', 60, false)`,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/admin/procedures',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('POST /admin/procedures', () => {
  it('crea un procedimiento con duración válida', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/procedures',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Limpieza dental',
        duration_minutes: 30,
        description: 'Profilaxis',
      }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ok).toBe(true);
    expect(res.json().id).toBeTruthy();

    const r = await db.query<{ name: string; duration_minutes: number; active: boolean }>(
      `SELECT name, duration_minutes, active FROM clinic_procedures WHERE clinic_id = 1`,
    );
    expect(r.rows[0]?.name).toBe('Limpieza dental');
    expect(r.rows[0]?.duration_minutes).toBe(30);
    expect(r.rows[0]?.active).toBe(true);
  });

  it('rechaza duración inválida (40 minutos)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/procedures',
      headers: jsonHeaders(),
      body: JSON.stringify({
        name: 'Cementación de tads',
        duration_minutes: 40,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BAD_REQUEST');
    expect(res.json().message).toMatch(/15, 30, 45, 60, 75, 90, 105, 120/);
  });

  it('rechaza duración inválida (10 minutos)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/procedures',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Demasiado corto', duration_minutes: 10 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rechaza nombre vacío', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/procedures',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: '   ', duration_minutes: 30 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('acepta todas las duraciones válidas', async () => {
    for (const d of [15, 30, 45, 60, 75, 90, 105, 120]) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/procedures',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: `Dur ${d}`, duration_minutes: d }),
      });
      expect(res.statusCode).toBe(201);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /admin/procedures/:id', () => {
  it('actualiza nombre y duración', async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes)
       VALUES (1, 'Original', 30) RETURNING id`,
    );
    const id = ins.rows[0]!.id;

    const res = await app.inject({
      method: 'PUT',
      url: `/admin/procedures/${id}`,
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Renombrado', duration_minutes: 60 }),
    });
    expect(res.statusCode).toBe(200);

    const r = await db.query<{ name: string; duration_minutes: number }>(
      `SELECT name, duration_minutes FROM clinic_procedures WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]?.name).toBe('Renombrado');
    expect(r.rows[0]?.duration_minutes).toBe(60);
  });

  it('rechaza duración inválida al actualizar', async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes)
       VALUES (1, 'Test', 30) RETURNING id`,
    );
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/procedures/${ins.rows[0]!.id}`,
      headers: jsonHeaders(),
      body: JSON.stringify({ duration_minutes: 50 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 si no existe', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/procedures/${randomUUID()}`,
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Nuevo' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /admin/procedures/:id (soft delete)', () => {
  it('marca active=false en vez de eliminar', async () => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO clinic_procedures (clinic_id, name, duration_minutes, active)
       VALUES (1, 'Activo', 30, true) RETURNING id`,
    );
    const id = ins.rows[0]!.id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/procedures/${id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const r = await db.query<{ active: boolean }>(
      `SELECT active FROM clinic_procedures WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]).toBeDefined(); // sigue en la BD
    expect(r.rows[0]?.active).toBe(false);
  });

  it('404 si no existe', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/procedures/${randomUUID()}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});
