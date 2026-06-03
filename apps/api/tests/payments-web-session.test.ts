/**
 * =============================================================================
 * Tests integración: flujo de pago con sesión de paciente WEB (kiosk_id = NULL)
 * =============================================================================
 *
 * Auditoría Hito A: confirma que ninguna query ni lógica downstream asume
 * kiosk_id no-nulo cuando el pago proviene de una sesión web pública.
 *
 * Cubre, de extremo a extremo:
 *   1. INSERT en `transactions` desde POST /me/payments con kiosk_id NULL.
 *   2. Lectura propia: GET /me/payments/:reference.
 *   3. Lectura downstream del admin (LEFT JOIN kiosks) → kiosk_name NULL, sin error.
 *   4. reconciler.runCycle() leyendo una transacción aprobada con kiosk_id NULL.
 *   5. audit_log registra patient.payment.create (la ruta de auditoría no rompe).
 *
 * Mock mode forzado por vitest.config.ts (DEV_MOCK_EXTERNAL_SERVICES, DEV_MOCK_WOMPI).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { signPatientSession } from '../src/lib/jwt.js';
import { runCycle } from '../src/lib/reconciler.js';
import { _resetMockDataForTests } from '../src/lib/dentalink.js';

let app: FastifyInstance;

// Paciente 12345 (María Pérez en el mock de Dentalink) — tiene email.
const PATIENT_ID = '12345';
let createdReference: string;

const POLICY_TEXT = 'Aviso pago web';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  _resetMockDataForTests();

  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM clinic WHERE id = 1`,
  );
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                          habeas_data_policy_version, habeas_data_policy_hash,
                          habeas_data_policy_text)
       VALUES (1, 'Web Pay Test', 'WebPay', '000', 'TEST', 'wp-v1', $1, $2)`,
      [POLICY_HASH, POLICY_TEXT],
    );
  }

  // Las sesiones web (kiosk_id = NULL) se crean por test con freshWebSession().
});

afterAll(async () => {
  if (createdReference) {
    await db.query(`DELETE FROM transactions WHERE wompi_reference = $1`, [createdReference]);
  }
  await db.query(`DELETE FROM patient_sessions WHERE dentalink_patient_id = $1`, [PATIENT_ID]);
  await app.close();
});

/**
 * Helper: firma una sesión cuyo jti coincide con la fila insertada en BD.
 * (signPatientSession crea un jti aleatorio; para el test insertamos la fila
 *  usando ese mismo jti, así que reusamos el token devuelto.)
 */
async function freshWebSession(): Promise<string> {
  const s = await signPatientSession({ dentalinkPatientId: PATIENT_ID, kioskId: null });
  await db.query(
    `INSERT INTO patient_sessions (kiosk_id, dentalink_patient_id, jti, expires_at)
     VALUES (NULL, $1, $2, $3)`,
    [PATIENT_ID, s.jti, s.expiresAt],
  );
  return s.token;
}

describe('Pago con sesión web (kiosk_id NULL)', () => {
  it('POST /me/payments inserta transactions con kiosk_id NULL', async () => {
    const token = await freshWebSession();
    const res = await app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { authorization: `Bearer ${token}` },
      payload: { amount_cop: 50000, description: 'Pago de prueba web' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.reference).toBe('string');
    expect(body.status).toBe('pending');
    createdReference = body.reference;

    // La transacción quedó con kiosk_id NULL (sin romper el INSERT).
    const row = await db.query<{ kiosk_id: string | null; patient_session_id: string | null }>(
      `SELECT kiosk_id, patient_session_id FROM transactions WHERE wompi_reference = $1`,
      [createdReference],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.kiosk_id).toBeNull();
    expect(row.rows[0]!.patient_session_id).not.toBeNull();
  });

  it('GET /me/payments/:reference lee la transacción (downstream) sin error', async () => {
    const token = await freshWebSession();
    const res = await app.inject({
      method: 'GET',
      url: `/me/payments/${createdReference}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('LEFT JOIN del admin sobre kiosks devuelve la fila con kiosk_name NULL', async () => {
    // Misma forma de query que admin-transactions/admin-dashboard.
    const rows = await db.query<{ kiosk_id: string | null; kiosk_name: string | null }>(
      `SELECT t.kiosk_id, k.name AS kiosk_name
         FROM transactions t
         LEFT JOIN kiosks k ON k.id = t.kiosk_id
        WHERE t.wompi_reference = $1`,
      [createdReference],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.kiosk_id).toBeNull();
    expect(rows.rows[0]!.kiosk_name).toBeNull();
  });

  it('audit_log registró patient.payment.create (la auditoría no rompe con kiosk null)', async () => {
    const r = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_log
        WHERE action = 'patient.payment.create'
          AND resource_id = $1`,
      [createdReference],
    );
    expect(parseInt(r.rows[0]!.count, 10)).toBeGreaterThan(0);
  });

  it('reconciler.runCycle() procesa una transacción aprobada con kiosk_id NULL', async () => {
    // Llevar la transacción al estado que consume el reconciler.
    await db.query(
      `UPDATE transactions
          SET status = 'approved',
              registered_in_dentalink = false,
              reconciliation_attempts = 0,
              last_reconciliation_at = NULL
        WHERE wompi_reference = $1`,
      [createdReference],
    );

    // No debe lanzar; el SELECT del reconciler no referencia kiosk_id.
    await expect(runCycle()).resolves.toBeTruthy();

    // En mock mode el registro en Dentalink tiene éxito → queda registrada.
    const after = await db.query<{ registered_in_dentalink: boolean }>(
      `SELECT registered_in_dentalink FROM transactions WHERE wompi_reference = $1`,
      [createdReference],
    );
    expect(after.rows[0]!.registered_in_dentalink).toBe(true);
  });
});
