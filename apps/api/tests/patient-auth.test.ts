/**
 * =============================================================================
 * Tests integración: patient auth (OTP)
 * =============================================================================
 *
 * Estos tests usan:
 *   - Postgres real (con migraciones aplicadas)
 *   - Redis real (rate limiting)
 *   - Mocks de SMS y Email (capturan el OTP enviado)
 *   - Mock de Dentalink (paciente de prueba fijo)
 *
 * Validan:
 *   - Validación de input
 *   - Aceptación de Habeas Data
 *   - Rate limiting
 *   - Anti-enumeración (respuesta indistinguible)
 *   - Flujo end-to-end OTP request → verify → session
 *   - Que el OTP no aparezca en logs ni respuestas
 *   - Que el código sea single-use
 *   - Que la sesión paciente sea válida tras verify
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { signKioskToken, verifyPatientSession } from '../src/lib/jwt.js';
import { setSmsSender, type SmsSender } from '../src/lib/sms.js';
import { setEmailSender, type EmailSender } from '../src/lib/email.js';

let app: FastifyInstance;
let kioskToken: string;
let revokedKioskToken: string;

// Mock que captura el último mensaje enviado
const captured: {
  sms: Array<{ to: string; body: string }>;
  email: Array<{ to: string; subject: string; text?: string }>;
} = { sms: [], email: [] };

const mockSms: SmsSender = {
  async send(to, body) {
    captured.sms.push({ to, body });
    return { sid: `mock-${Date.now()}` };
  },
};

const mockEmail: EmailSender = {
  async send(input) {
    captured.email.push({ to: input.to, subject: input.subject, text: input.text });
    return { id: `mock-${Date.now()}` };
  },
};

// Constantes del paciente mock (definidas en dentalink.ts)
const MOCK_PATIENT = {
  cedula: '1061700000',
  phone: '+573001234567',
  name: 'María Pérez',
  dentalink_id: '12345',
};

// Texto y hash de política Habeas Data
const POLICY_TEXT = `Aviso de Privacidad - Test
Versión test-v1.0
Sus datos serán tratados según Ley 1581 de 2012.`;
const POLICY_VERSION = 'test-v1.0';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

/**
 * Extrae el OTP del body del SMS capturado.
 * Formato esperado: "...código DentalKiosco es: XXXXXX. Vence..."
 */
function extractOtp(body: string): string | null {
  const match = /es:\s*(\d{6})\./.exec(body);
  return match ? match[1]! : null;
}

beforeAll(async () => {
  // Inyectar mocks ANTES de buildServer (los routes los leen vía getter)
  setSmsSender(mockSms);
  setEmailSender(mockEmail);

  app = await buildServer();
  await app.ready();

  // Asegurar que existe la clínica con un policy_hash conocido
  const existing = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM clinic WHERE id = 1`);
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(`
      INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                         habeas_data_policy_version, habeas_data_policy_hash)
      VALUES (1, 'Test Clinic', 'Test', '000', 'TEST-LICENSE', $1, $2)
    `, [POLICY_VERSION, POLICY_HASH]);
  } else {
    await db.query(`
      UPDATE clinic
      SET habeas_data_policy_version = $1, habeas_data_policy_hash = $2
      WHERE id = 1
    `, [POLICY_VERSION, POLICY_HASH]);
  }

  // Asegurar kiosco activo
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'TEST%'`);
  const kioskRes = await db.query<{ id: string }>(`
    INSERT INTO kiosks (name, token_hash, token_expires_at, is_active)
    VALUES ('TEST Kiosco', $1, now() + interval '1 day', true)
    RETURNING id
  `, [createHash('sha256').update('temp').digest('hex')]);
  const kioskId = kioskRes.rows[0]!.id;

  const k = await signKioskToken({ kioskId, kioskName: 'TEST Kiosco' });
  kioskToken = k.token;

  // Crear también un kiosco revocado para tests
  const revokedRes = await db.query<{ id: string }>(`
    INSERT INTO kiosks (name, token_hash, token_expires_at, is_active, revoked_at)
    VALUES ('TEST Revocado', $1, now() + interval '1 day', false, now())
    RETURNING id
  `, [createHash('sha256').update('revoked').digest('hex')]);
  const revoked = await signKioskToken({
    kioskId: revokedRes.rows[0]!.id,
    kioskName: 'TEST Revocado',
  });
  revokedKioskToken = revoked.token;
});

afterAll(async () => {
  await db.query(`DELETE FROM otp_codes WHERE patient_cedula_hash = $1`, [
    createHash('sha256').update(MOCK_PATIENT.cedula).digest('hex'),
  ]);
  await db.query(`DELETE FROM otp_codes WHERE patient_cedula_hash = $1`, [
    createHash('sha256').update('9999999999').digest('hex'),
  ]);
  await db.query(`DELETE FROM patient_sessions WHERE dentalink_patient_id = $1`, [
    MOCK_PATIENT.dentalink_id,
  ]);
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'TEST%'`);
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
  await app.close();
});

beforeEach(async () => {
  // Limpiar buffers de captura
  captured.sms = [];
  captured.email = [];
  // Limpiar rate limits para no contaminar
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
});

describe('POST /auth/request-otp - validación de input', () => {
  it('rechaza body sin cedula', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_INPUT');
  });

  it('rechaza cédula con formato inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: 'abc123',
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rechaza teléfono sin código país Colombia', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: '3001234567', // sin +57
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rechaza consent = false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: false,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rechaza policy_hash con formato inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: 'no-es-hex',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/request-otp - kiosk token', () => {
  it('rechaza sin Authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('KIOSK_TOKEN_REQUIRED');
  });

  it('rechaza con token inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: 'Bearer invalid.token.here' },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('INVALID_KIOSK_TOKEN');
  });

  it('rechaza con kiosco revocado/inactivo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${revokedKioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('KIOSK_INACTIVE');
  });
});

describe('POST /auth/request-otp - anti-enumeración', () => {
  it('paciente que NO existe recibe la MISMA respuesta que uno que existe', async () => {
    const resReal = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(resReal.statusCode).toBe(200);
    const realBody = resReal.json();

    const resFake = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: '9999999999',
        phone: '+573009999999',
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(resFake.statusCode).toBe(200);
    const fakeBody = resFake.json();

    // Mismo shape de respuesta
    expect(Object.keys(realBody).sort()).toEqual(Object.keys(fakeBody).sort());
    expect(typeof realBody.request_id).toBe('string');
    expect(typeof fakeBody.request_id).toBe('string');
    expect(realBody.expires_in_seconds).toBe(fakeBody.expires_in_seconds);
  });

  it('cedula correcta pero phone no coincide → NO se envía OTP', async () => {
    captured.sms = [];
    captured.email = [];

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: '+573009999999', // phone que no es del paciente
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(200);
    // Esperar fire-and-forget
    await new Promise((r) => setTimeout(r, 300));
    expect(captured.sms).toHaveLength(0);
    expect(captured.email).toHaveLength(0);
  });

  it('paciente válido → envía SMS y Email', async () => {
    captured.sms = [];
    captured.email = [];

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(200);

    // Esperar a que fire-and-forget complete
    await new Promise((r) => setTimeout(r, 300));

    expect(captured.sms).toHaveLength(1);
    expect(captured.sms[0]!.to).toBe(MOCK_PATIENT.phone);
    expect(captured.sms[0]!.body).toMatch(/María/); // primer nombre
    expect(captured.sms[0]!.body).toMatch(/\d{6}/); // OTP de 6 dígitos

    expect(captured.email).toHaveLength(1);
    expect(captured.email[0]!.to).toBe('maria.perez@demo.local');
  });
});

describe('POST /auth/request-otp - registro de Habeas Data', () => {
  it('registra el consentimiento en habeas_data_consents (con IP)', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM habeas_data_consents
       WHERE policy_version = $1 AND patient_phone = $2`,
      [POLICY_VERSION, MOCK_PATIENT.phone],
    );
    const beforeCount = parseInt(before.rows[0]!.count, 10);

    await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });

    const after = await db.query<{
      count: string;
      ip_address: string | null;
      policy_text_hash: string;
    }>(
      `SELECT COUNT(*) AS count, MAX(ip_address::text) AS ip_address,
              MAX(policy_text_hash) AS policy_text_hash
       FROM habeas_data_consents
       WHERE policy_version = $1 AND patient_phone = $2`,
      [POLICY_VERSION, MOCK_PATIENT.phone],
    );
    const afterCount = parseInt(after.rows[0]!.count, 10);
    expect(afterCount).toBe(beforeCount + 1);
    expect(after.rows[0]!.ip_address).toBeTruthy();
    expect(after.rows[0]!.policy_text_hash).toBe(POLICY_HASH);
  });

  it('registra consentimiento incluso si el paciente no existe (intento queda en auditoría)', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM habeas_data_consents
       WHERE patient_phone = '+573009999999'`,
    );
    const beforeCount = parseInt(before.rows[0]!.count, 10);

    await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: '9999999999',
        phone: '+573009999999',
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });

    const after = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM habeas_data_consents
       WHERE patient_phone = '+573009999999'`,
    );
    expect(parseInt(after.rows[0]!.count, 10)).toBe(beforeCount + 1);
  });
});

describe('POST /auth/request-otp - rate limiting', () => {
  it('4to intento desde mismo phone es bloqueado (limit=3)', async () => {
    // Hacer 3 intentos exitosos
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/request-otp',
        headers: { authorization: `Bearer ${kioskToken}` },
        payload: {
          cedula: MOCK_PATIENT.cedula,
          phone: MOCK_PATIENT.phone,
          consent: true,
          policy_version: POLICY_VERSION,
          policy_hash: POLICY_HASH,
        },
      });
      expect(r.statusCode).toBe(200);
    }

    // El 4to debe ser 429
    const r4 = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(r4.statusCode).toBe(429);
    expect(r4.json().error).toBe('RATE_LIMIT');
    expect(typeof r4.json().retry_after_seconds).toBe('number');
  });
});

describe('POST /auth/verify-otp - happy path', () => {
  it('flujo completo: request → SMS captura OTP → verify → session_token válido', async () => {
    captured.sms = [];

    // 1. Request OTP
    const reqRes = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(reqRes.statusCode).toBe(200);
    const { request_id } = reqRes.json();

    // 2. Esperar SMS y extraer código
    await new Promise((r) => setTimeout(r, 300));
    expect(captured.sms).toHaveLength(1);
    const otpCode = extractOtp(captured.sms[0]!.body);
    expect(otpCode).toMatch(/^\d{6}$/);

    // 3. Verify
    const verRes = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id, code: otpCode },
    });
    expect(verRes.statusCode).toBe(200);

    const body = verRes.json();
    expect(body.session_token).toMatch(/^eyJ/); // JWT
    expect(body.patient.name).toBe(MOCK_PATIENT.name);

    // 4. JWT contiene el paciente correcto
    const claims = await verifyPatientSession(body.session_token);
    expect(claims.sub).toBe(MOCK_PATIENT.dentalink_id);
  });
});

describe('POST /auth/verify-otp - errores', () => {
  let recentRequestId: string;
  let recentCode: string;

  beforeEach(async () => {
    captured.sms = [];
    const r = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    recentRequestId = r.json().request_id;
    await new Promise((res) => setTimeout(res, 300));
    recentCode = extractOtp(captured.sms[0]!.body)!;
  });

  it('rechaza request_id inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: randomUUID(), code: '123456' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_OR_EXPIRED');
  });

  it('rechaza código incorrecto', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_CODE');
  });

  it('rechaza código con formato inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: 'abcdef' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_INPUT');
  });

  it('OTP es single-use: segundo verify del mismo request_id falla', async () => {
    // Primer uso OK
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: recentCode },
    });
    expect(ok.statusCode).toBe(200);

    // Segundo uso del mismo code: rechazado
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: recentCode },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('INVALID_OR_EXPIRED');
  });

  it('después de 5 intentos fallidos, bloquea con 429', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/auth/verify-otp',
        payload: { request_id: recentRequestId, code: '000000' },
      });
    }

    // El 6to (incluso con código correcto) debe ser 429
    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: recentCode },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('TOO_MANY_ATTEMPTS');
  });

  it('OTP expirado es rechazado', async () => {
    // Forzar expiración modificando expires_at en BD
    await db.query(
      `UPDATE otp_codes SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [recentRequestId],
    );

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: recentCode },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_OR_EXPIRED');
  });

  it('OTP del rechazo silencioso (paciente no existe) no se puede verificar', async () => {
    captured.sms = [];

    const req = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: '9999999999', // no existe
        phone: '+573009999999',
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(req.statusCode).toBe(200);
    const fakeRequestId = req.json().request_id;

    // No se envió SMS
    await new Promise((r) => setTimeout(r, 300));
    expect(captured.sms).toHaveLength(0);

    // Cualquier código de 6 dígitos es rechazado por request_id no encontrado
    const ver = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: fakeRequestId, code: '123456' },
    });
    expect(ver.statusCode).toBe(400);
    expect(ver.json().error).toBe('INVALID_OR_EXPIRED');
  });
});

describe('OTP nunca aparece en logs ni en responses', () => {
  it('respuesta de request-otp NO contiene el código', async () => {
    captured.sms = [];

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });

    const bodyStr = JSON.stringify(res.json());
    // El body NO debe contener un número de 6 dígitos
    // (request_id es UUID, expires_in_seconds podría ser 300 pero NO es 6 dígitos)
    await new Promise((r) => setTimeout(r, 300));
    if (captured.sms.length > 0) {
      const realCode = extractOtp(captured.sms[0]!.body);
      expect(bodyStr).not.toContain(realCode!);
    }
  });

  it('respuesta de verify-otp con éxito NO contiene el código original', async () => {
    captured.sms = [];

    const reqRes = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
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

    const bodyStr = JSON.stringify(verRes.json());
    expect(bodyStr).not.toContain(code);
  });
});

describe('POST /auth/logout', () => {
  it('logout con token válido revoca la sesión', async () => {
    captured.sms = [];

    // Auth completo para obtener session
    const r = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    const { request_id } = r.json();
    await new Promise((res) => setTimeout(res, 300));
    const code = extractOtp(captured.sms[0]!.body)!;

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id, code },
    });
    const { session_token } = verifyRes.json();
    const claims = await verifyPatientSession(session_token);

    // Logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${session_token}` },
    });
    expect(logoutRes.statusCode).toBe(200);

    // Verificar en BD que está revocada
    const sessionRow = await db.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM patient_sessions WHERE jti = $1`,
      [claims.jti],
    );
    expect(sessionRow.rows[0]!.revoked_at).not.toBeNull();
  });

  it('logout sin token retorna 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(401);
  });

  it('logout con token inválido retorna 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: 'Bearer invalid' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Audit log', () => {
  it('OTP request genera entrada en audit', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });

    const r = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM audit_log
       WHERE action = 'patient.otp.requested'
         AND created_at > now() - interval '5 seconds'`,
    );
    expect(parseInt(r.rows[0]!.count, 10)).toBeGreaterThan(0);
  });

  it('audit log NO contiene el OTP en metadata', async () => {
    captured.sms = [];

    await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: `Bearer ${kioskToken}` },
      payload: {
        cedula: MOCK_PATIENT.cedula,
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });

    await new Promise((r) => setTimeout(r, 300));
    const code = extractOtp(captured.sms[0]!.body)!;

    // Buscar entries recientes y verificar que el código no aparezca
    const r = await db.query<{ metadata: object | null }>(
      `SELECT metadata FROM audit_log
       WHERE action LIKE 'patient.otp%'
         AND created_at > now() - interval '5 seconds'`,
    );

    for (const row of r.rows) {
      const meta = JSON.stringify(row.metadata ?? {});
      expect(meta).not.toContain(code);
    }
  });
});
