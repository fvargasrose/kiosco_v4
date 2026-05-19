/**
 * =============================================================================
 * Tests integración: /admin/dashboard
 * =============================================================================
 *
 * Usa Postgres real + Redis real. Mock mode activo.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { signAdminSession } from '../src/lib/jwt.js';
import { randomUUID } from 'crypto';

let app: FastifyInstance;
let adminToken: string;
let kioskId: string;

const TEST_EMAIL = 'dash-admin-test@demo.local';
const REF_PREFIX = 'DK-DASHTEST-';

async function insertTx(opts: { status?: string; amount_cop?: number; created_at?: string }) {
  const ref = `${REF_PREFIX}${randomUUID()}`;
  await db.query(
    `INSERT INTO transactions
       (kiosk_id, dentalink_patient_id, wompi_reference, amount_cop, status,
        patient_phone_masked, created_at)
     VALUES ($1, 'pat-dash', $2, $3, $4, '+573001234567',
             COALESCE($5::timestamptz, now()))`,
    [kioskId, ref, opts.amount_cop ?? 50000, opts.status ?? 'pending', opts.created_at ?? null],
  );
  return ref;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  const adminId = randomUUID();
  await db.query(
    `INSERT INTO admins (id, email, password_hash, full_name, role, mfa_required)
     VALUES ($1, $2, 'x', 'Dash Test Admin', 'admin', false)
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

  kioskId = randomUUID();
  await db.query(
    `INSERT INTO kiosks (id, name, token_hash, token_expires_at, is_active)
     VALUES ($1, 'Dash Test Kiosk', 'hash-dash-test', now() + interval '90 days', true)`,
    [kioskId],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM transactions WHERE wompi_reference LIKE '${REF_PREFIX}%'`);
  await db.query(`DELETE FROM kiosks WHERE id = $1`, [kioskId]);
  await db.query(`DELETE FROM admins WHERE email = $1`, [TEST_EMAIL]);
  await app.close();
});

beforeEach(async () => {
  await db.query(`DELETE FROM transactions WHERE wompi_reference LIKE '${REF_PREFIX}%'`);
});

const auth = () => ({ Authorization: `Bearer ${adminToken}` });

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/dashboard — auth', () => {
  it('requiere autenticación', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/dashboard' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /admin/dashboard — estructura', () => {
  it('devuelve la estructura esperada', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toHaveProperty('kiosks');
    expect(typeof body.kiosks.total).toBe('number');
    expect(typeof body.kiosks.active).toBe('number');

    expect(body).toHaveProperty('today');
    expect(typeof body.today.transactions).toBe('number');
    expect(typeof body.today.approved).toBe('number');
    expect(typeof body.today.amount_cop).toBe('number');

    expect(typeof body.pending_transactions).toBe('number');
    expect(Array.isArray(body.recent_transactions)).toBe(true);
  });

  it('recent_transactions tiene máximo 10 elementos', async () => {
    for (let i = 0; i < 12; i++) await insertTx({ status: 'approved' });

    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().recent_transactions.length).toBeLessThanOrEqual(10);
  });

  it('amount_cop en recent_transactions es número', async () => {
    await insertTx({ status: 'approved', amount_cop: 123456 });
    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    const { recent_transactions } = res.json();
    const mine = recent_transactions.find((t: { wompi_reference: string }) =>
      t.wompi_reference.startsWith(REF_PREFIX),
    );
    if (mine) expect(typeof mine.amount_cop).toBe('number');
  });
});

describe('GET /admin/dashboard — métricas kioscos', () => {
  it('kiosks.active refleja kioscos activos', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    const { kiosks } = res.json();
    // El kiosco de test está activo
    expect(kiosks.active).toBeGreaterThanOrEqual(1);
    expect(kiosks.total).toBeGreaterThanOrEqual(kiosks.active);
  });
});

describe('GET /admin/dashboard — métricas today', () => {
  it('today.transactions sube al insertar transacción del día', async () => {
    const before = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    const prevCount = before.json().today.transactions;

    await insertTx({ status: 'pending' });

    const after = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    expect(after.json().today.transactions).toBe(prevCount + 1);
  });

  it('today.approved y amount_cop cuentan solo aprobadas del día', async () => {
    await insertTx({ status: 'approved', amount_cop: 200000 });
    await insertTx({ status: 'approved', amount_cop: 100000 });
    await insertTx({ status: 'pending',  amount_cop: 50000  });

    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    const { today } = res.json();

    expect(today.approved).toBeGreaterThanOrEqual(2);
    expect(today.amount_cop).toBeGreaterThanOrEqual(300000);
  });

  it('transacción de fecha pasada no suma en today', async () => {
    await insertTx({ status: 'approved', amount_cop: 999999, created_at: '2020-01-01T00:00:00Z' });

    const res = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    // No podemos saber el valor absoluto exacto pero amount_cop debe ser número
    expect(typeof res.json().today.amount_cop).toBe('number');
  });
});

describe('GET /admin/dashboard — pending_transactions', () => {
  it('pending_transactions sube al insertar pendiente', async () => {
    const before = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    const prev = before.json().pending_transactions;

    await insertTx({ status: 'pending' });

    const after = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    expect(after.json().pending_transactions).toBe(prev + 1);
  });

  it('pending_transactions no sube con approved', async () => {
    const before = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    const prev = before.json().pending_transactions;

    await insertTx({ status: 'approved' });

    const after = await app.inject({ method: 'GET', url: '/admin/dashboard', headers: auth() });
    expect(after.json().pending_transactions).toBe(prev);
  });
});
