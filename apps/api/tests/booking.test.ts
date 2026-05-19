/**
 * =============================================================================
 * Tests integración: Hito 8 — booking + reconciliador
 * =============================================================================
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { redis } from '../src/lib/redis.js';
import { signKioskToken, signPatientSession } from '../src/lib/jwt.js';
import { _resetMockDataForTests } from '../src/lib/dentalink.js';
import { runCycle } from '../src/lib/reconciler.js';

let app: FastifyInstance;
let kioskId: string;
let validSessionToken: string;
let validSessionJti: string;
let otherSessionToken: string;
let otherSessionJti: string;
const PATIENT_ID = '12345';
const OTHER_PATIENT_ID = '67890';

const POLICY_TEXT = 'Aviso H8';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Setup clínica
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                          habeas_data_policy_version, habeas_data_policy_hash,
                          habeas_data_policy_text, duracion_cita_minutos)
       VALUES (1, 'H8 Test', 'H8', '000', 'TEST', $1, $2, $3, 30)`,
      ['h8-v1', POLICY_HASH, POLICY_TEXT],
    );
  } else {
    await db.query(
      `UPDATE clinic SET duracion_cita_minutos = 30 WHERE id = 1`,
    );
  }

  // Kiosco
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'H8-%'`);
  const kioskRes = await db.query<{ id: string }>(
    `INSERT INTO kiosks (name, token_hash, token_expires_at, is_active)
     VALUES ('H8-Test', $1, now() + interval '1 day', true)
     RETURNING id`,
    [createHash('sha256').update('h8-kiosk').digest('hex')],
  );
  kioskId = kioskRes.rows[0]!.id;
  await signKioskToken({ kioskId, kioskName: 'H8-Test' });

  // Sesión paciente 12345
  const s1 = await signPatientSession({ dentalinkPatientId: PATIENT_ID, kioskId });
  validSessionToken = s1.token;
  validSessionJti = s1.jti;
  await db.query(
    `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [kioskId, PATIENT_ID, validSessionJti, s1.expiresAt],
  );

  // Sesión otro paciente
  const s2 = await signPatientSession({ dentalinkPatientId: OTHER_PATIENT_ID, kioskId });
  otherSessionToken = s2.token;
  otherSessionJti = s2.jti;
  await db.query(
    `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [kioskId, OTHER_PATIENT_ID, otherSessionJti, s2.expiresAt],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM transactions WHERE wompi_reference LIKE 'DK-RC-%'`);
  await db.query(`DELETE FROM patient_sessions WHERE jti IN ($1, $2)`, [
    validSessionJti,
    otherSessionJti,
  ]);
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'H8-%'`);
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'booking:patient:%'`);
  const keys = await redis.getClient().keys('dl:*');
  if (keys.length > 0) await redis.del(...keys);
  await app.close();
});

beforeEach(async () => {
  _resetMockDataForTests();
  const keys = await redis.getClient().keys('dl:*');
  if (keys.length > 0) await redis.del(...keys);
  // Reset rate limits para cada test
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'booking:patient:%'`);
});

// =============================================================================
// GET /me/booking/branches
// =============================================================================

describe('GET /me/booking/branches', () => {
  it('sin auth retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/me/booking/branches' });
    expect(res.statusCode).toBe(401);
  });

  it('lista sucursales', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/branches',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0]).toHaveProperty('id');
    expect(body.data[0]).toHaveProperty('nombre');
  });
});

// =============================================================================
// GET /me/booking/dentists
// =============================================================================

describe('GET /me/booking/dentists', () => {
  it('sin branch_id retorna 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/dentists',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('branch_id inválido retorna 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/dentists?branch_id=abc',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lista dentistas de una sucursal específica', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/dentists?branch_id=1',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((d: { id_sucursal: number }) => d.id_sucursal === 1)).toBe(true);
  });

  it('sucursal sin dentistas retorna array vacío', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/dentists?branch_id=999',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});

// =============================================================================
// GET /me/booking/slots
// =============================================================================

describe('GET /me/booking/slots', () => {
  it('sin params retorna 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/slots',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('formato de fecha inválido retorna 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/slots?dentist_id=dr-001&from=tomorrow&to=2026-12-31',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rango > 30 días retorna 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/slots?dentist_id=dr-001&from=2026-07-01&to=2026-09-01',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('30 días');
  });

  it('rango más allá de 90 días futuro retorna 400', async () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 100);
    const to = farFuture.toISOString().slice(0, 10);
    const from = new Date(farFuture.getTime() - 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const res = await app.inject({
      method: 'GET',
      url: `/me/booking/slots?dentist_id=dr-001&from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('90 días');
  });

  it('from > to retorna 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/booking/slots?dentist_id=dr-001&from=2026-07-10&to=2026-07-05',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('devuelve slots dentro del rango', async () => {
    const today = new Date();
    today.setDate(today.getDate() + 1); // mañana
    const from = today.toISOString().slice(0, 10);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 7);
    const to = toDate.toISOString().slice(0, 10);

    const res = await app.inject({
      method: 'GET',
      url: `/me/booking/slots?dentist_id=dr-001&from=${from}&to=${to}`,
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.duration_minutes).toBe(30);

    if (body.data.length > 0) {
      const slot = body.data[0];
      expect(slot).toHaveProperty('fecha');
      expect(slot).toHaveProperty('hora_inicio');
      expect(slot).toHaveProperty('hora_fin');
      expect(slot.id_dentista).toBe('dr-001');
    }
  });

  it('respeta el parámetro duration', async () => {
    const today = new Date();
    today.setDate(today.getDate() + 1);
    const from = today.toISOString().slice(0, 10);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 3);
    const to = toDate.toISOString().slice(0, 10);

    const res = await app.inject({
      method: 'GET',
      url: `/me/booking/slots?dentist_id=dr-001&from=${from}&to=${to}&duration=60`,
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().duration_minutes).toBe(60);
  });
});

// =============================================================================
// POST /me/booking/appointments
// =============================================================================

describe('POST /me/booking/appointments', () => {
  /** Helper para una fecha/hora futura conocida */
  function futurSlot(daysAhead: number, hour: string, duration = 30) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const [hh, mm] = hour.split(':').map(Number);
    d.setHours(hh!, mm!, 0, 0);
    const endMin = mm! + duration;
    const endH = (hh! + Math.floor(endMin / 60)).toString().padStart(2, '0');
    const endM = (endMin % 60).toString().padStart(2, '0');
    return {
      fecha: d.toISOString().slice(0, 10),
      hora_inicio: `${hh!.toString().padStart(2, '0')}:${mm!.toString().padStart(2, '0')}`,
      hora_fin: `${endH}:${endM}`,
    };
  }

  it('sin auth retorna 401', async () => {
    const slot = futurSlot(5, '10:00');
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
    });
    expect(res.statusCode).toBe(401);
  });

  it('crea una cita exitosamente', async () => {
    const slot = futurSlot(5, '10:00');
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: {
        dentist_id: 'dr-001',
        branch_id: 1,
        ...slot,
        notas: 'Limpieza',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.appointment.estado).toBe('Reservada');
    expect(body.appointment.fecha).toBe(slot.fecha);
    expect(body.appointment.hora_inicio).toBe(slot.hora_inicio);
  });

  it('rechaza fecha en el pasado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: {
        dentist_id: 'dr-001',
        branch_id: 1,
        fecha: '2020-01-15',
        hora_inicio: '10:00',
        hora_fin: '10:30',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('futuro');
  });

  it('rechaza hora_fin <= hora_inicio', async () => {
    const slot = futurSlot(3, '10:00');
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: {
        dentist_id: 'dr-001',
        branch_id: 1,
        fecha: slot.fecha,
        hora_inicio: '10:00',
        hora_fin: '09:00',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('hora_fin');
  });

  it('rechaza fecha más allá de 90 días', async () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 100);
    const fecha = farFuture.toISOString().slice(0, 10);
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: {
        dentist_id: 'dr-001',
        branch_id: 1,
        fecha,
        hora_inicio: '10:00',
        hora_fin: '10:30',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('90');
  });

  it('rechaza slot duplicado (CONFLICT)', async () => {
    const slot = futurSlot(7, '14:00');
    // Crear una primera vez
    await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
    });
    // Intentar crear segunda en el mismo slot
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('CONFLICT');
  });

  it('rate limiting: 6ta cita en una hora es bloqueada', async () => {
    // Crear 5 citas (límite)
    for (let i = 0; i < 5; i++) {
      const slot = futurSlot(10 + i, '11:00');
      const res = await app.inject({
        method: 'POST',
        url: '/me/booking/appointments',
        headers: { authorization: `Bearer ${validSessionToken}` },
        payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
      });
      expect([201, 409]).toContain(res.statusCode); // 409 si por azar choca
    }
    // 6ta intento → rate limit
    const slot = futurSlot(20, '11:00');
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('RATE_LIMIT');
  });

  it('audit_log registra la creación', async () => {
    const slot = futurSlot(15, '15:30');
    const res = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
    });
    const aptId = res.json().appointment.id;
    const auditRes = await db.query<{ result: string; metadata: { fecha: string } }>(
      `SELECT result, metadata FROM audit_log
       WHERE action = 'patient.appointment.create' AND resource_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [aptId],
    );
    expect(auditRes.rows[0]?.result).toBe('success');
    expect(auditRes.rows[0]?.metadata.fecha).toBe(slot.fecha);
  });

  it('después de crear, la cita aparece en /me/appointments', async () => {
    const slot = futurSlot(18, '09:00');
    const create = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
    });
    const newId = create.json().appointment.id;

    const list = await app.inject({
      method: 'GET',
      url: '/me/appointments?status=upcoming',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const ids = (list.json().data as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toContain(newId);
  });

  it('citas creadas por paciente A NO son visibles para paciente B', async () => {
    const slot = futurSlot(22, '16:00');
    const create = await app.inject({
      method: 'POST',
      url: '/me/booking/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { dentist_id: 'dr-001', branch_id: 1, ...slot },
    });
    const newId = create.json().appointment.id;

    const list = await app.inject({
      method: 'GET',
      url: '/me/appointments?status=upcoming',
      headers: { authorization: `Bearer ${otherSessionToken}` },
    });
    const ids = (list.json().data as Array<{ id: string }>).map((a) => a.id);
    expect(ids).not.toContain(newId);
  });
});

// =============================================================================
// RECONCILER
// =============================================================================

describe('Reconciler', () => {
  /** Crea una transaction aprobada SIN reconciliar para alimentar al worker */
  async function createApprovedTx(reference: string, registered: boolean): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO transactions (
         kiosk_id, dentalink_patient_id, dentalink_treatment_id,
         wompi_reference, amount_cop, status, wompi_payment_method_type,
         registered_in_dentalink, webhook_received_at, webhook_verified,
         wompi_transaction_id, approved_at
       )
       VALUES (
         $1, $2, 'tx-001', $3, 100000, 'approved', 'NEQUI',
         $4, now() - interval '5 minutes', true,
         'wompi-tx-${Math.random().toString(36).slice(2)}', now()
       )
       RETURNING id`,
      [kioskId, PATIENT_ID, reference, registered],
    );
    return result.rows[0]!.id;
  }

  beforeEach(async () => {
    await db.query(`DELETE FROM transactions WHERE wompi_reference LIKE 'DK-RC-%'`);
  });

  it('reconcileApproved: pago no registrado se intenta reconciliar', async () => {
    await createApprovedTx('DK-RC-test-001', false);
    const stats = await runCycle();
    expect(stats.reconciled).toBeGreaterThanOrEqual(1);

    // Verificar que ahora SÍ está registrado en Dentalink (mock)
    const r = await db.query<{ registered_in_dentalink: boolean; dentalink_payment_id: string | null }>(
      `SELECT registered_in_dentalink, dentalink_payment_id
       FROM transactions WHERE wompi_reference = 'DK-RC-test-001'`,
    );
    expect(r.rows[0]?.registered_in_dentalink).toBe(true);
    expect(r.rows[0]?.dentalink_payment_id).toBeTruthy();
  });

  it('reconcileApproved: ya reconciliados NO son tocados', async () => {
    await createApprovedTx('DK-RC-test-002', true); // ya registrado
    const before = await db.query<{ dentalink_payment_id: string | null }>(
      `SELECT dentalink_payment_id FROM transactions WHERE wompi_reference = 'DK-RC-test-002'`,
    );
    // Ya estaba registered=true sin dentalink_payment_id, no debería tocarse
    await runCycle();

    const after = await db.query<{ reconciliation_attempts: number }>(
      `SELECT reconciliation_attempts FROM transactions WHERE wompi_reference = 'DK-RC-test-002'`,
    );
    expect(after.rows[0]?.reconciliation_attempts).toBe(0);
  });

  it('audit log registra eventos de reconciliación', async () => {
    await createApprovedTx('DK-RC-audit', false);
    await runCycle();

    const audit = await db.query<{ result: string }>(
      `SELECT result FROM audit_log
       WHERE action = 'payment.reconciled' AND resource_id = 'DK-RC-audit'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.result).toBe('success');
  });

  it('runCycle es idempotente: dos ejecuciones no rompen estado', async () => {
    await createApprovedTx('DK-RC-idem', false);
    await runCycle();
    const stats2 = await runCycle();
    // Ya está reconciliado, segundo cycle no debe tocarla
    expect(stats2.reconciled).toBe(0);
  });

  it('expireOldPending: marca como expired transactions pending viejas', async () => {
    // Crear una transaction pending de hace 25 horas
    await db.query(
      `INSERT INTO transactions (
         kiosk_id, dentalink_patient_id, wompi_reference, amount_cop, status,
         created_at
       )
       VALUES ($1, $2, 'DK-RC-old', 50000, 'pending', now() - interval '25 hours')`,
      [kioskId, PATIENT_ID],
    );

    const stats = await runCycle();
    expect(stats.expired).toBeGreaterThanOrEqual(1);

    const r = await db.query<{ status: string }>(
      `SELECT status FROM transactions WHERE wompi_reference = 'DK-RC-old'`,
    );
    expect(r.rows[0]?.status).toBe('expired');
  });
});
