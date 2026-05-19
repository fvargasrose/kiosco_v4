/**
 * =============================================================================
 * Tests integración: /admin/transactions
 * =============================================================================
 *
 * Usa Postgres real + Redis real. Mock mode activo.
 * Inserta transacciones de prueba directamente en BD.
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

const TEST_EMAIL = 'tx-admin-test@demo.local';
const REF_PREFIX = 'DK-TXTEST-';

async function insertTx(overrides: {
  reference?: string;
  status?: string;
  amount_cop?: number;
  created_at?: string;
  kiosk_id?: string | null;
}) {
  const ref = overrides.reference ?? `${REF_PREFIX}${randomUUID()}`;
  await db.query(
    `INSERT INTO transactions
       (kiosk_id, dentalink_patient_id, wompi_reference, amount_cop, status,
        patient_phone_masked, created_at)
     VALUES ($1, 'pat-test', $2, $3, $4, '+573001234567',
             COALESCE($5::timestamptz, now()))`,
    [
      overrides.kiosk_id ?? kioskId,
      ref,
      overrides.amount_cop ?? 50000,
      overrides.status ?? 'pending',
      overrides.created_at ?? null,
    ],
  );
  return ref;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Admin
  const adminId = randomUUID();
  await db.query(
    `INSERT INTO admins (id, email, password_hash, full_name, role, mfa_required)
     VALUES ($1, $2, 'x', 'TX Test Admin', 'admin', false)
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

  // Kiosco de prueba
  kioskId = randomUUID();
  await db.query(
    `INSERT INTO kiosks (id, name, token_hash, token_expires_at, is_active)
     VALUES ($1, 'TX Test Kiosk', 'hash-tx-test', now() + interval '90 days', true)`,
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

describe('GET /admin/transactions — auth', () => {
  it('requiere autenticación', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/transactions' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /admin/transactions — sin filtros', () => {
  it('devuelve lista vacía cuando no hay transacciones de test', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/transactions', headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.page).toBe(1);
  });

  it('devuelve las transacciones insertadas', async () => {
    await insertTx({ status: 'approved', amount_cop: 100000 });
    await insertTx({ status: 'pending',  amount_cop: 50000  });

    const res = await app.inject({ method: 'GET', url: '/admin/transactions', headers: auth() });
    expect(res.statusCode).toBe(200);
    const { data, total } = res.json();
    expect(total).toBeGreaterThanOrEqual(2);
    const refs = data.map((t: { wompi_reference: string }) => t.wompi_reference);
    expect(refs.some((r: string) => r.startsWith(REF_PREFIX))).toBe(true);
  });

  it('incluye nombre del kiosco', async () => {
    await insertTx({ status: 'approved' });
    const res = await app.inject({ method: 'GET', url: '/admin/transactions', headers: auth() });
    const { data } = res.json();
    const myTx = data.find((t: { wompi_reference: string }) => t.wompi_reference.startsWith(REF_PREFIX));
    expect(myTx).toBeTruthy();
    expect(myTx.kiosk_name).toBe('TX Test Kiosk');
  });

  it('amount_cop es número (no string)', async () => {
    await insertTx({ amount_cop: 75000 });
    const res = await app.inject({ method: 'GET', url: '/admin/transactions', headers: auth() });
    const { data } = res.json();
    const myTx = data.find((t: { wompi_reference: string }) => t.wompi_reference.startsWith(REF_PREFIX));
    expect(typeof myTx.amount_cop).toBe('number');
    expect(myTx.amount_cop).toBe(75000);
  });
});

describe('GET /admin/transactions — filtro por status', () => {
  it('filtra correctamente por approved', async () => {
    await insertTx({ status: 'approved' });
    await insertTx({ status: 'pending'  });
    await insertTx({ status: 'declined' });

    const res = await app.inject({
      method: 'GET', url: '/admin/transactions?status=approved', headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    // Todos los devueltos deben ser approved
    data.forEach((t: { status: string }) => expect(t.status).toBe('approved'));
  });

  it('filtra correctamente por pending', async () => {
    await insertTx({ status: 'approved' });
    await insertTx({ status: 'pending'  });

    const res = await app.inject({
      method: 'GET', url: '/admin/transactions?status=pending', headers: auth(),
    });
    const { data } = res.json();
    data.forEach((t: { status: string }) => expect(t.status).toBe('pending'));
  });

  it('rechaza status inválido', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/transactions?status=pagado', headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /admin/transactions — filtro por fecha', () => {
  it('filtra por date_from y date_to', async () => {
    // Transacción de ayer
    await insertTx({ status: 'approved', created_at: '2020-01-15T10:00:00Z' });
    // Transacción de hoy (sin fecha explícita → now())
    await insertTx({ status: 'pending' });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/transactions?date_from=2020-01-15&date_to=2020-01-15',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    data.forEach((t: { created_at: string }) => {
      const d = new Date(t.created_at);
      expect(d.getFullYear()).toBe(2020);
    });
  });

  it('rechaza formato de fecha inválido', async () => {
    const res = await app.inject({
      method: 'GET', url: '/admin/transactions?date_from=15-01-2024', headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /admin/transactions — paginación', () => {
  it('respeta per_page y devuelve metadata de páginas', async () => {
    // Insertar 3 transacciones
    await insertTx({});
    await insertTx({});
    await insertTx({});

    const res = await app.inject({
      method: 'GET', url: '/admin/transactions?per_page=2&page=1', headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(typeof body.pages).toBe('number');
    expect(body.per_page).toBe(2);
    expect(body.page).toBe(1);
  });

  it('página 2 devuelve elementos distintos', async () => {
    await insertTx({});
    await insertTx({});
    await insertTx({});

    const p1 = await app.inject({
      method: 'GET', url: '/admin/transactions?per_page=2&page=1', headers: auth(),
    });
    const p2 = await app.inject({
      method: 'GET', url: '/admin/transactions?per_page=2&page=2', headers: auth(),
    });
    const refs1 = p1.json().data.map((t: { wompi_reference: string }) => t.wompi_reference);
    const refs2 = p2.json().data.map((t: { wompi_reference: string }) => t.wompi_reference);
    // No debe haber referencias repetidas entre páginas
    const overlap = refs1.filter((r: string) => refs2.includes(r));
    expect(overlap).toHaveLength(0);
  });
});
