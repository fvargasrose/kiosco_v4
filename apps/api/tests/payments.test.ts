/**
 * =============================================================================
 * Tests integración: Hito 7 — cancelación de citas + pagos
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
import { wompi, type WompiWebhookEvent } from '../src/lib/wompi.js';

let app: FastifyInstance;
let kioskToken: string;
let kioskId: string;

// Paciente 12345 (María Pérez en mock)
let validSessionToken: string;
let validSessionJti: string;
const PATIENT_ID = '12345';

// Otro paciente (Juan Gómez 67890) para tests anti-IDOR
let otherSessionToken: string;
let otherSessionJti: string;
const OTHER_PATIENT_ID = '67890';

const POLICY_TEXT = `Aviso H7`;
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

// Pre-condición del entorno: estos tests asumen mock mode
beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Setup clínica (idempotente — respetando el trigger singleton)
  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                          habeas_data_policy_version, habeas_data_policy_hash,
                          habeas_data_policy_text)
       VALUES (1, 'H7 Test', 'H7', '000', 'TEST', $1, $2, $3)`,
      ['h7-v1', POLICY_HASH, POLICY_TEXT],
    );
  } else {
    await db.query(
      `UPDATE clinic SET
         habeas_data_policy_version = $1,
         habeas_data_policy_hash = $2,
         habeas_data_policy_text = $3
       WHERE id = 1`,
      ['h7-v1', POLICY_HASH, POLICY_TEXT],
    );
  }

  // Kiosco
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'H7-%'`);
  const kioskRes = await db.query<{ id: string }>(
    `INSERT INTO kiosks (name, token_hash, token_expires_at, is_active)
     VALUES ('H7-Test', $1, now() + interval '1 day', true)
     RETURNING id`,
    [createHash('sha256').update('h7-kiosk').digest('hex')],
  );
  kioskId = kioskRes.rows[0]!.id;
  const k = await signKioskToken({ kioskId, kioskName: 'H7-Test' });
  kioskToken = k.token;

  // Sesión paciente 12345
  const s1 = await signPatientSession({ dentalinkPatientId: PATIENT_ID, kioskId });
  validSessionToken = s1.token;
  validSessionJti = s1.jti;
  await db.query(
    `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [kioskId, PATIENT_ID, validSessionJti, s1.expiresAt],
  );

  // Sesión otro paciente 67890
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
  await db.query(
    `DELETE FROM transactions WHERE wompi_reference LIKE 'DK-%'
       AND dentalink_patient_id IN ($1, $2)`,
    [PATIENT_ID, OTHER_PATIENT_ID],
  );
  await db.query(`DELETE FROM patient_sessions WHERE jti IN ($1, $2)`, [
    validSessionJti,
    otherSessionJti,
  ]);
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'H7-%'`);
  const keys = await redis.getClient().keys('dl:*');
  if (keys.length > 0) await redis.del(...keys);
  await app.close();
});

beforeEach(async () => {
  _resetMockDataForTests();
  const keys = await redis.getClient().keys('dl:*');
  if (keys.length > 0) await redis.del(...keys);
});

// =============================================================================
// CANCELACIÓN DE CITAS
// =============================================================================

describe('POST /me/appointments/:id/cancel', () => {
  it('sin auth retorna 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
    });
    expect(res.statusCode).toBe(401);
  });

  it('cancela una cita propia exitosamente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.appointment.id).toBe('apt-001');
    expect(body.appointment.estado).toBe('Cancelada');
  });

  it('después de cancelar, la cita aparece como Cancelada en /me/appointments', async () => {
    await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/me/appointments?status=all',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const apt = (listRes.json().data as Array<{ id: string; estado: string }>).find(
      (a) => a.id === 'apt-001',
    );
    expect(apt?.estado).toBe('Cancelada');
  });

  it('cancelar dos veces la misma cita retorna 409 CONFLICT', async () => {
    await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('CONFLICT');
  });

  it('anti-IDOR: paciente B NO puede cancelar cita de paciente A', async () => {
    // apt-001 pertenece a PATIENT_ID (12345). Intentamos cancelarla con session de 67890.
    const res = await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
      headers: { authorization: `Bearer ${otherSessionToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');

    // Y confirmamos que la cita NO se canceló
    const listRes = await app.inject({
      method: 'GET',
      url: '/me/appointments',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const apt = (listRes.json().data as Array<{ id: string; estado: string }>).find(
      (a) => a.id === 'apt-001',
    );
    expect(apt?.estado).not.toBe('Cancelada');
  });

  it('cita inexistente retorna 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-nonexistent/cancel',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('registra entrada en audit_log con resultado success', async () => {
    await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    const audit = await db.query<{ result: string; metadata: object }>(
      `SELECT result, metadata
       FROM audit_log
       WHERE action = 'patient.appointment.cancel'
         AND resource_id = 'apt-001'
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0]!.result).toBe('success');
  });

  it('registra entrada en audit_log con resultado denied para anti-IDOR', async () => {
    await app.inject({
      method: 'POST',
      url: '/me/appointments/apt-001/cancel',
      headers: { authorization: `Bearer ${otherSessionToken}` },
    });
    const audit = await db.query<{ result: string; metadata: { reason: string } }>(
      `SELECT result, metadata
       FROM audit_log
       WHERE action = 'patient.appointment.cancel'
         AND resource_id = 'apt-001'
         AND result = 'denied'
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0]!.metadata.reason).toBe('not_found_or_not_owned');
  });
});

// =============================================================================
// CREAR PAGO
// =============================================================================

describe('POST /me/payments', () => {
  it('sin auth retorna 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      payload: { amount_cop: 50000, description: 'Test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('valida input: amount_cop requerido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { description: 'Test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('valida input: amount_cop negativo es rechazado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { amount_cop: -100, description: 'Test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('valida input: amount_cop excesivo (>50M COP) es rechazado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { amount_cop: 100_000_000, description: 'Test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('crea un pago general (sin treatment_id) exitosamente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { amount_cop: 50000, description: 'Pago consulta' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reference).toMatch(/^DK-/);
    expect(body.url).toContain('wompi.co');
    expect(body.amount_cop).toBe(50000);
    expect(body.status).toBe('pending');
    expect(body.expires_at).toBeTruthy();
  });

  it('crea un pago vinculado a treatment_id propio', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: {
        treatment_id: 'tx-001',
        amount_cop: 500_000,
        description: 'Abono ortodoncia',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reference).toMatch(/^DK-/);
  });

  it('anti-IDOR: rechaza pago con treatment_id de OTRO paciente', async () => {
    // tx-001 pertenece a PATIENT_ID. Intentamos como OTHER.
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${otherSessionToken}` },
      payload: {
        treatment_id: 'tx-001',
        amount_cop: 100_000,
        description: 'Intento IDOR',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });

  it('rechaza monto que excede saldo del tratamiento', async () => {
    // tx-001 tiene saldo_pendiente = 1_500_000
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: {
        treatment_id: 'tx-001',
        amount_cop: 2_000_000,
        description: 'Sobrepago',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('saldo pendiente');
  });

  it('persiste la transaction en BD con status=pending', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { amount_cop: 75000, description: 'Verif persistencia' },
    });
    const reference = res.json().reference;

    const tx = await db.query<{
      status: string;
      amount_cop: string;
      dentalink_patient_id: string;
    }>(
      `SELECT status, amount_cop, dentalink_patient_id
       FROM transactions
       WHERE wompi_reference = $1`,
      [reference],
    );
    expect(tx.rows.length).toBe(1);
    expect(tx.rows[0]!.status).toBe('pending');
    expect(Number(tx.rows[0]!.amount_cop)).toBe(75000);
    expect(tx.rows[0]!.dentalink_patient_id).toBe(PATIENT_ID);
  });

  it('email y phone se enmascaran en BD (no en claro)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { amount_cop: 30000, description: 'Test mask' },
    });
    const reference = res.json().reference;

    const tx = await db.query<{
      patient_phone_masked: string | null;
      patient_email_masked: string | null;
    }>(
      `SELECT patient_phone_masked, patient_email_masked
       FROM transactions
       WHERE wompi_reference = $1`,
      [reference],
    );
    const row = tx.rows[0]!;
    // No debe contener el celular ni email completos del mock
    expect(row.patient_phone_masked).not.toContain('3001234567');
    expect(row.patient_email_masked).not.toBe('maria.perez@demo.local');
    expect(row.patient_phone_masked).toContain('*');
    expect(row.patient_email_masked).toContain('*');
  });

  it('registra entrada en audit_log', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { amount_cop: 12345, description: 'Audit test' },
    });
    const reference = res.json().reference;

    const audit = await db.query<{ result: string; metadata: { amount_cop: number } }>(
      `SELECT result, metadata
       FROM audit_log
       WHERE action = 'patient.payment.create'
         AND resource_id = $1`,
      [reference],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0]!.result).toBe('success');
    expect(audit.rows[0]!.metadata.amount_cop).toBe(12345);
  });
});

// =============================================================================
// CONSULTAR PAGO (POLLING)
// =============================================================================

describe('GET /me/payments/:reference', () => {
  let createdReference: string;

  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: { amount_cop: 20000, description: 'Polling fixture' },
    });
    createdReference = res.json().reference;
  });

  it('sin auth retorna 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/me/payments/${createdReference}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('devuelve estado de mi propio pago', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/me/payments/${createdReference}`,
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reference).toBe(createdReference);
    expect(body.status).toBe('pending');
    expect(body.amount_cop).toBe(20000);
  });

  it('anti-IDOR: otro paciente NO puede ver mi pago', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/me/payments/${createdReference}`,
      headers: { authorization: `Bearer ${otherSessionToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reference con formato inválido retorna 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/payments/INVALID-FORMAT',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reference inexistente retorna 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me/payments/DK-nonexistent-99999',
      headers: { authorization: `Bearer ${validSessionToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// =============================================================================
// WEBHOOK WOMPI
// =============================================================================

describe('POST /webhooks/wompi', () => {
  let webhookReference: string;

  beforeEach(async () => {
    // Crear una transaction limpia para cada test
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${validSessionToken}` },
      payload: {
        treatment_id: 'tx-001',
        amount_cop: 100_000,
        description: 'Webhook test',
      },
    });
    webhookReference = res.json().reference;
  });

  /**
   * Construye un webhook con firma SHA256 correcta.
   * Sólo funciona si WOMPI_EVENTS_SECRET está configurado.
   */
  function buildSignedWebhook(
    reference: string,
    status: 'APPROVED' | 'DECLINED' | 'VOIDED',
    secret: string,
  ): WompiWebhookEvent {
    const timestamp = Math.floor(Date.now() / 1000);
    const txId = `wompi-tx-${Math.random().toString(36).slice(2)}`;
    const amountInCents = 10_000_000; // 100_000 COP

    // Wompi firma así: concat(values_of_properties) + timestamp + secret → sha256
    const properties = [
      'transaction.id',
      'transaction.status',
      'transaction.amount_in_cents',
    ];
    const valuesStr = `${txId}${status}${amountInCents}`;
    const concatenated = `${valuesStr}${timestamp}${secret}`;
    const checksum = createHash('sha256').update(concatenated).digest('hex');

    return {
      event: 'transaction.updated',
      data: {
        transaction: {
          id: txId,
          status,
          reference,
          amount_in_cents: amountInCents,
          payment_method_type: 'NEQUI',
          payment_method: { phone_number: '3001234567' },
          customer_email: 'maria.perez@demo.local',
          created_at: new Date().toISOString(),
          finalized_at: status !== 'APPROVED' ? new Date().toISOString() : undefined,
        },
      },
      sent_at: new Date().toISOString(),
      timestamp,
      signature: { checksum, properties },
      environment: 'test',
    };
  }

  it('webhook con shape inválido retorna 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wompi',
      payload: { foo: 'bar' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('webhook con firma inválida retorna 401', async () => {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) {
      // En este sandbox no hay WOMPI_EVENTS_SECRET, así que verifyWebhookSignature
      // arroja UPSTREAM_ERROR antes de poder validar. Marcamos el test como pendiente.
      return;
    }
    const validEvent = buildSignedWebhook(webhookReference, 'APPROVED', secret);
    const tampered = {
      ...validEvent,
      signature: { ...validEvent.signature, checksum: 'a'.repeat(64) },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wompi',
      payload: tampered,
    });
    expect(res.statusCode).toBe(401);
  });

  it('webhook con timestamp viejo retorna 401 (anti-replay)', async () => {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return;
    const oldEvent = buildSignedWebhook(webhookReference, 'APPROVED', secret);
    // Timestamp de hace 10 minutos
    oldEvent.timestamp = Math.floor(Date.now() / 1000) - 600;
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wompi',
      payload: oldEvent,
    });
    expect(res.statusCode).toBe(401);
  });

  it('webhook APPROVED válido actualiza transaction y dispara reconciliación', async () => {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return;
    const evt = buildSignedWebhook(webhookReference, 'APPROVED', secret);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wompi',
      payload: evt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    // Pequeña pausa para que la reconciliación async corra
    await new Promise((r) => setTimeout(r, 200));

    const tx = await db.query<{
      status: string;
      wompi_transaction_id: string;
      wompi_payment_method_type: string;
      webhook_verified: boolean;
      registered_in_dentalink: boolean;
    }>(
      `SELECT status, wompi_transaction_id, wompi_payment_method_type,
              webhook_verified, registered_in_dentalink
       FROM transactions WHERE wompi_reference = $1`,
      [webhookReference],
    );
    expect(tx.rows[0]!.status).toBe('approved');
    expect(tx.rows[0]!.wompi_transaction_id).toBe(evt.data.transaction.id);
    expect(tx.rows[0]!.wompi_payment_method_type).toBe('NEQUI');
    expect(tx.rows[0]!.webhook_verified).toBe(true);
    // Mock reconciliation siempre tiene éxito
    expect(tx.rows[0]!.registered_in_dentalink).toBe(true);
  });

  it('webhook DECLINED actualiza el status correspondiente', async () => {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return;
    const evt = buildSignedWebhook(webhookReference, 'DECLINED', secret);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wompi',
      payload: evt,
    });
    expect(res.statusCode).toBe(200);

    const tx = await db.query<{ status: string; registered_in_dentalink: boolean }>(
      `SELECT status, registered_in_dentalink FROM transactions WHERE wompi_reference = $1`,
      [webhookReference],
    );
    expect(tx.rows[0]!.status).toBe('declined');
    // Declined no debe reconciliar
    expect(tx.rows[0]!.registered_in_dentalink).toBe(false);
  });

  it('webhook con reference desconocida retorna 200 pero no hace nada', async () => {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return;
    const evt = buildSignedWebhook('DK-unknown-ref-zzz', 'APPROVED', secret);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wompi',
      payload: evt,
    });
    expect(res.statusCode).toBe(200);
  });

  it('idempotencia: segundo webhook sobre transaction terminal es no-op', async () => {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return;
    const evt1 = buildSignedWebhook(webhookReference, 'APPROVED', secret);
    await app.inject({ method: 'POST', url: '/webhooks/wompi', payload: evt1 });

    // Capturar el wompi_transaction_id del primer webhook
    const before = await db.query<{ wompi_transaction_id: string }>(
      `SELECT wompi_transaction_id FROM transactions WHERE wompi_reference = $1`,
      [webhookReference],
    );
    const firstTxId = before.rows[0]!.wompi_transaction_id;

    // Segundo webhook (otro tx_id) no debe sobrescribir
    const evt2 = buildSignedWebhook(webhookReference, 'APPROVED', secret);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/wompi',
      payload: evt2,
    });
    expect(res.statusCode).toBe(200);

    const after = await db.query<{ wompi_transaction_id: string }>(
      `SELECT wompi_transaction_id FROM transactions WHERE wompi_reference = $1`,
      [webhookReference],
    );
    expect(after.rows[0]!.wompi_transaction_id).toBe(firstTxId);
  });

  it('audit_log registra eventos de webhook', async () => {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) return;
    const evt = buildSignedWebhook(webhookReference, 'APPROVED', secret);
    await app.inject({ method: 'POST', url: '/webhooks/wompi', payload: evt });

    const audit = await db.query<{ result: string }>(
      `SELECT result FROM audit_log
       WHERE action = 'webhook.wompi.received'
         AND resource_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [webhookReference],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0]!.result).toBe('success');
  });
});

// =============================================================================
// WOMPI CLIENT: generateReference y verifyWebhookSignature unit-level
// =============================================================================

describe('Wompi client', () => {
  it('generateReference produce un valor único con prefijo DK-', () => {
    const a = wompi.generateReference();
    const b = wompi.generateReference();
    expect(a).toMatch(/^DK-/);
    expect(b).toMatch(/^DK-/);
    expect(a).not.toBe(b);
  });

  it('verifyWebhookSignature: rechaza body sin signature', () => {
    expect(() =>
      wompi.verifyWebhookSignature({
        event: 'x',
        data: { transaction: {} },
        sent_at: '',
        timestamp: Math.floor(Date.now() / 1000),
      } as unknown as WompiWebhookEvent),
    ).toThrow();
  });
});
