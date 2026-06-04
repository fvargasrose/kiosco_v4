/**
 * =============================================================================
 * Tests integración: POST /auth/refresh (sesión deslizante web móvil, §10)
 * =============================================================================
 *
 * Validan:
 *   - Refresh con sesión válida → nuevo access token (mismo jti), expira más tarde
 *   - El nuevo token es aceptado por las rutas protegidas (no 401)
 *   - Refresh sin token / con token inválido → 401
 *   - Refresh tras logout (sesión revocada) → 401
 *   - Máximo absoluto: superado el techo (created_at + N horas) → 401 y se revoca
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { verifyPatientSession } from '../src/lib/jwt.js';
import { setSmsSender, type SmsSender } from '../src/lib/sms.js';
import { setEmailSender, type EmailSender } from '../src/lib/email.js';

let app: FastifyInstance;

const captured: { sms: Array<{ to: string; body: string }> } = { sms: [] };

const mockSms: SmsSender = {
  async send(to, body) {
    captured.sms.push({ to, body });
    return { sid: `mock-${Date.now()}` };
  },
};
const mockEmail: EmailSender = {
  async send() {
    return { id: `mock-${Date.now()}` };
  },
};

const MOCK_PATIENT = { phone: '+573001234567', name: 'María Pérez', dentalink_id: '12345' };

const POLICY_TEXT = `Aviso de Privacidad - Test
Versión test-v1.0
Sus datos serán tratados según Ley 1581 de 2012.`;
const POLICY_VERSION = 'test-v1.0';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

function extractOtp(body: string): string | null {
  const match = /es:\s*(\d{6})\./.exec(body);
  return match ? match[1]! : null;
}

/** Hace el flujo completo y devuelve { token, jti, expiresAt }. */
async function loginPatient(): Promise<{ token: string; jti: string; expiresAt: string }> {
  captured.sms = [];
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
  const reqRes = await app.inject({
    method: 'POST',
    url: '/auth/request-otp',
    payload: {
      phone: MOCK_PATIENT.phone,
      consent: true,
      policy_version: POLICY_VERSION,
      policy_hash: POLICY_HASH,
    },
  });
  const { request_id } = reqRes.json();
  await new Promise((r) => setTimeout(r, 300));
  const code = extractOtp(captured.sms[0]!.body)!;
  const verRes = await app.inject({
    method: 'POST',
    url: '/auth/verify-otp',
    payload: { request_id, code },
  });
  const body = verRes.json();
  const claims = await verifyPatientSession(body.session_token);
  return { token: body.session_token, jti: claims.jti as string, expiresAt: body.expires_at };
}

beforeAll(async () => {
  setSmsSender(mockSms);
  setEmailSender(mockEmail);

  app = await buildServer();
  await app.ready();

  const existing = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM clinic WHERE id = 1`);
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                         habeas_data_policy_version, habeas_data_policy_hash)
       VALUES (1, 'Test Clinic', 'Test', '000', 'TEST-LICENSE', $1, $2)`,
      [POLICY_VERSION, POLICY_HASH],
    );
  } else {
    await db.query(
      `UPDATE clinic SET habeas_data_policy_version = $1, habeas_data_policy_hash = $2 WHERE id = 1`,
      [POLICY_VERSION, POLICY_HASH],
    );
  }
});

afterAll(async () => {
  await db.query(`DELETE FROM otp_codes WHERE patient_phone = $1`, [MOCK_PATIENT.phone]);
  await db.query(`DELETE FROM patient_sessions WHERE dentalink_patient_id = $1`, [MOCK_PATIENT.dentalink_id]);
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
  await app.close();
});

beforeEach(async () => {
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
});

describe('POST /auth/refresh', () => {
  it('sesión válida → nuevo token (mismo jti) que expira más tarde', async () => {
    const { token, jti, expiresAt } = await loginPatient();

    // Forzamos que la expiración previa quede en el pasado-próximo para que el
    // nuevo expires_at sea estrictamente mayor (el TTL es de minutos).
    await new Promise((r) => setTimeout(r, 1100));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_token).toMatch(/^eyJ/);
    expect(body.session_token).not.toBe(token);

    const newClaims = await verifyPatientSession(body.session_token);
    expect(newClaims.jti).toBe(jti); // mismo jti (sesión deslizante)
    expect(newClaims.sub).toBe(MOCK_PATIENT.dentalink_id);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(new Date(expiresAt).getTime());

    // La fila de sesión refleja la nueva expiración.
    const row = await db.query<{ expires_at: Date }>(
      `SELECT expires_at FROM patient_sessions WHERE jti = $1`,
      [jti],
    );
    expect(new Date(row.rows[0]!.expires_at).getTime()).toBe(new Date(body.expires_at).getTime());
  });

  it('el nuevo token es aceptado por rutas protegidas (no 401)', async () => {
    const { token } = await loginPatient();
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    const newToken = refreshRes.json().session_token;

    const meRes = await app.inject({
      method: 'GET',
      url: '/me/profile',
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(meRes.statusCode).not.toBe(401);
  });

  it('sin token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/refresh' });
    expect(res.statusCode).toBe(401);
  });

  it('token inválido → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('sesión revocada (tras logout) → 401', async () => {
    const { token } = await loginPatient();
    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('SESSION_INVALID');
  });

  it('máximo absoluto superado → 401 SESSION_EXPIRED y la sesión queda revocada', async () => {
    const { token, jti } = await loginPatient();

    // Antigüedad mayor al máximo absoluto (default 8h) sin tocar el JWT (sigue
    // válido criptográficamente porque su TTL es de minutos).
    await db.query(
      `UPDATE patient_sessions SET created_at = now() - interval '9 hours' WHERE jti = $1`,
      [jti],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('SESSION_EXPIRED');

    const row = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      `SELECT revoked_at, revoked_reason FROM patient_sessions WHERE jti = $1`,
      [jti],
    );
    expect(row.rows[0]!.revoked_at).not.toBeNull();
    expect(row.rows[0]!.revoked_reason).toBe('absolute_max_reached');
  });
});
