/**
 * =============================================================================
 * Tests integración: patient auth (OTP) — login solo por teléfono
 * =============================================================================
 *
 * Validan:
 *   - Validación de input (sólo phone, ya no cédula)
 *   - Aceptación de Habeas Data
 *   - Rate limiting por teléfono
 *   - Anti-enumeración (respuesta indistinguible para phone no registrado)
 *   - Envío dual SMS + email
 *   - Flujo end-to-end OTP request → verify → session
 *   - El OTP nunca se filtra en logs ni responses
 *   - Sesión paciente válida tras verify
 *   - CLI dk:otp rechaza ejecución en producción
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { verifyPatientSession } from '../src/lib/jwt.js';
import { setSmsSender, type SmsSender } from '../src/lib/sms.js';
import { setEmailSender, type EmailSender } from '../src/lib/email.js';
import { refuseInProduction } from '../src/scripts/get-otp.js';

let app: FastifyInstance;

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

// Paciente mock definido en dentalink.ts
const MOCK_PATIENT = {
  phone: '+573001234567',
  name: 'María Pérez',
  dentalink_id: '12345',
};

const POLICY_TEXT = `Aviso de Privacidad - Test
Versión test-v1.0
Sus datos serán tratados según Ley 1581 de 2012.`;
const POLICY_VERSION = 'test-v1.0';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');

function extractOtp(body: string): string | null {
  const match = /es:\s*(\d{6})\./.exec(body);
  return match ? match[1]! : null;
}

beforeAll(async () => {
  setSmsSender(mockSms);
  setEmailSender(mockEmail);

  app = await buildServer();
  await app.ready();

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

  // Hito A: el flujo es web público; ya no se crean kioscos ni tokens de kiosco.
});

afterAll(async () => {
  await db.query(`DELETE FROM otp_codes WHERE patient_phone IN ($1, $2)`, [
    MOCK_PATIENT.phone,
    '+573009999999',
  ]);
  await db.query(`DELETE FROM patient_sessions WHERE dentalink_patient_id = $1`, [
    MOCK_PATIENT.dentalink_id,
  ]);
  await db.query(`DELETE FROM kiosks WHERE name LIKE 'TEST%'`);
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
  await app.close();
});

beforeEach(async () => {
  captured.sms = [];
  captured.email = [];
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
});

describe('POST /auth/request-otp - validación de input', () => {
  it('rechaza body sin phone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_INPUT');
  });

  it('rechaza teléfono sin código país Colombia', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
        phone: '3001234567',
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rechaza teléfono que no empieza en 3', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
        phone: '+576001234567',
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
      url: '/auth/request-otp',      payload: {
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
      url: '/auth/request-otp',      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: 'no-es-hex',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// Hito A (Opción A): /auth/request-otp es PÚBLICO — ya no exige kiosk_token.
// Las antiguas aserciones de "kiosk token requerido / inválido / kiosco
// revocado" se reemplazan por las del nuevo contrato público. El control de
// acceso ahora recae en rate-limiting + Turnstile (Hito B) + anti-enumeración.
describe('POST /auth/request-otp - acceso público (sin kiosk token)', () => {
  it('acepta la solicitud SIN Authorization header (web pública)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().request_id).toBe('string');
  });

  it('ignora un Authorization header espurio (token ya no se valida)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',
      headers: { authorization: 'Bearer invalid.token.here' },
      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /auth/request-otp - anti-enumeración', () => {
  it('teléfono que NO existe recibe la MISMA respuesta que uno que existe', async () => {
    const resReal = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
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
      url: '/auth/request-otp',      payload: {
        phone: '+573009999999',
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(resFake.statusCode).toBe(200);
    const fakeBody = resFake.json();

    expect(Object.keys(realBody).sort()).toEqual(Object.keys(fakeBody).sort());
    expect(typeof realBody.request_id).toBe('string');
    expect(typeof fakeBody.request_id).toBe('string');
    expect(realBody.expires_in_seconds).toBe(fakeBody.expires_in_seconds);
  });

  it('teléfono que NO existe → NO se envía ningún OTP', async () => {
    captured.sms = [];
    captured.email = [];

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
        phone: '+573009999999',
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(captured.sms).toHaveLength(0);
    expect(captured.email).toHaveLength(0);
  });

  it('paciente válido → envía SMS y Email en paralelo (OTP dual)', async () => {
    captured.sms = [];
    captured.email = [];

    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 300));

    expect(captured.sms).toHaveLength(1);
    expect(captured.sms[0]!.to).toBe(MOCK_PATIENT.phone);
    expect(captured.sms[0]!.body).toMatch(/María/);
    expect(captured.sms[0]!.body).toMatch(/\d{6}/);

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
      url: '/auth/request-otp',      payload: {
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

  it('registra consentimiento incluso si el paciente no existe', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM habeas_data_consents
       WHERE patient_phone = '+573009999999'`,
    );
    const beforeCount = parseInt(before.rows[0]!.count, 10);

    await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
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
  // §7.2: cooldown de 1 solicitud por teléfono cada 60s → el 2º intento
  // inmediato (mismo teléfono) se bloquea con 429 + retry_after.
  it('2º intento inmediato del mismo teléfono es bloqueado por cooldown', async () => {
    const payload = {
      phone: MOCK_PATIENT.phone,
      consent: true,
      policy_version: POLICY_VERSION,
      policy_hash: POLICY_HASH,
    };

    const r1 = await app.inject({ method: 'POST', url: '/auth/request-otp', payload });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({ method: 'POST', url: '/auth/request-otp', payload });
    expect(r2.statusCode).toBe(429);
    expect(r2.json().error).toBe('RATE_LIMIT');
    expect(typeof r2.json().retry_after_seconds).toBe('number');
  });
});

describe('POST /auth/verify-otp - happy path', () => {
  it('flujo completo: request → SMS captura OTP → verify → session_token válido', async () => {
    captured.sms = [];

    const reqRes = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(reqRes.statusCode).toBe(200);
    const { request_id } = reqRes.json();

    await new Promise((r) => setTimeout(r, 300));
    expect(captured.sms).toHaveLength(1);
    const otpCode = extractOtp(captured.sms[0]!.body);
    expect(otpCode).toMatch(/^\d{6}$/);

    const verRes = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id, code: otpCode },
    });
    expect(verRes.statusCode).toBe(200);

    const body = verRes.json();
    expect(body.session_token).toMatch(/^eyJ/);
    expect(body.patient.name).toBe(MOCK_PATIENT.name);

    const claims = await verifyPatientSession(body.session_token);
    expect(claims.sub).toBe(MOCK_PATIENT.dentalink_id);
    // Sesión web pública: sin kiosco de origen.
    expect(claims.kiosk_id).toBeNull();
  });
});

describe('POST /auth/verify-otp - errores', () => {
  let recentRequestId: string;
  let recentCode: string;

  beforeEach(async () => {
    captured.sms = [];
    const r = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
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
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: recentCode },
    });
    expect(ok.statusCode).toBe(200);

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

    const res = await app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { request_id: recentRequestId, code: recentCode },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('TOO_MANY_ATTEMPTS');
  });

  it('OTP expirado es rechazado', async () => {
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
      url: '/auth/request-otp',      payload: {
        phone: '+573009999999',
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });
    expect(req.statusCode).toBe(200);
    const fakeRequestId = req.json().request_id;

    await new Promise((r) => setTimeout(r, 300));
    expect(captured.sms).toHaveLength(0);

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
      url: '/auth/request-otp',      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });

    const bodyStr = JSON.stringify(res.json());
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
      url: '/auth/request-otp',      payload: {
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

    const r = await app.inject({
      method: 'POST',
      url: '/auth/request-otp',      payload: {
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

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${session_token}` },
    });
    expect(logoutRes.statusCode).toBe(200);

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
      url: '/auth/request-otp',      payload: {
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
      url: '/auth/request-otp',      payload: {
        phone: MOCK_PATIENT.phone,
        consent: true,
        policy_version: POLICY_VERSION,
        policy_hash: POLICY_HASH,
      },
    });

    await new Promise((r) => setTimeout(r, 300));
    const code = extractOtp(captured.sms[0]!.body)!;

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

describe('CLI dk:otp - guardia de producción', () => {
  it('refuseInProduction("production") === true', () => {
    expect(refuseInProduction('production')).toBe(true);
  });

  it('refuseInProduction("development") === false', () => {
    expect(refuseInProduction('development')).toBe(false);
  });

  it('refuseInProduction(undefined) === false', () => {
    expect(refuseInProduction(undefined)).toBe(false);
  });
});
