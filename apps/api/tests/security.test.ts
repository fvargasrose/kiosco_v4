/**
 * =============================================================================
 * Tests de seguridad de perímetro (Hito B) — plan_abierto.md §6.2
 * =============================================================================
 *
 * Cubre:
 *   - Rate-limit global por IP: 429 + Retry-After, aislamiento por IP, reset.
 *   - Fuerza bruta de OTP (verify-otp) → 429 TOO_MANY_ATTEMPTS.
 *   - Abuso de SMS: teléfono no registrado → 0 SMS; cooldown no invoca al sender;
 *     sin token o token inválido de Turnstile → bloqueo ANTES del sender.
 *   - Anti-enumeración: registrado vs no registrado → misma forma de respuesta.
 *   - Blocklist admin: token tras logout → 401.
 *
 * La IP del cliente proviene de X-Forwarded-For (trustProxy). El loopback está
 * en allowList del rate-limit, así que para ejercitarlo usamos IPs públicas
 * ficticias en el header.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { redis } from '../src/lib/redis.js';
import { config } from '../src/lib/config.js';
import { hashPassword } from '../src/lib/passwords.js';
import { setSmsSender, type SmsSender } from '../src/lib/sms.js';
import { setEmailSender, type EmailSender } from '../src/lib/email.js';
import { setTurnstileVerifier } from '../src/lib/turnstile.js';

let app: FastifyInstance;

const MOCK_PHONE = '+573001234567';     // María Pérez (registrada en el mock)
const UNKNOWN_PHONE = '+573009999999';  // no registrada
const POLICY_TEXT = 'Aviso seguridad';
const POLICY_VERSION = 'sec-v1';
const POLICY_HASH = createHash('sha256').update(POLICY_TEXT).digest('hex');
const GOOD_TS = 'good'; // token Turnstile que el verifier mock acepta

const ADMIN_EMAIL = 'sec_admin@demo.local';
const ADMIN_PASSWORD = 'SecPwd1234!';

const captured: { sms: Array<{ to: string }>; email: Array<{ to: string }> } = {
  sms: [],
  email: [],
};
const mockSms: SmsSender = {
  async send(to) { captured.sms.push({ to }); return { sid: `m-${Date.now()}` }; },
};
const mockEmail: EmailSender = {
  async send(input) { captured.email.push({ to: input.to }); return { id: `m-${Date.now()}` }; },
};

function otpPayload(phone: string, turnstile?: string) {
  return {
    phone,
    consent: true as const,
    policy_version: POLICY_VERSION,
    policy_hash: POLICY_HASH,
    ...(turnstile !== undefined ? { turnstile_token: turnstile } : {}),
  };
}

async function flushRateLimitRedis() {
  const client = redis.getClient();
  const keys = await client.keys('dk-rl:*');
  if (keys.length) await client.del(...keys);
}

beforeAll(async () => {
  setSmsSender(mockSms);
  setEmailSender(mockEmail);
  // Turnstile ENFORCED para este archivo: secret presente + verifier mock que
  // solo acepta el token GOOD_TS.
  (config as { TURNSTILE_SECRET?: string }).TURNSTILE_SECRET = 'test-secret';
  setTurnstileVerifier({ async verify(token) { return token === GOOD_TS; } });

  app = await buildServer();
  await app.ready();

  const existing = await db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM clinic WHERE id = 1`);
  if (parseInt(existing.rows[0]!.count, 10) === 0) {
    await db.query(
      `INSERT INTO clinic (id, legal_name, display_name, nit, license_key,
                          habeas_data_policy_version, habeas_data_policy_hash, habeas_data_policy_text)
       VALUES (1, 'Sec Test', 'Sec', '000', 'TEST', $1, $2, $3)`,
      [POLICY_VERSION, POLICY_HASH, POLICY_TEXT],
    );
  } else {
    await db.query(
      `UPDATE clinic SET habeas_data_policy_version=$1, habeas_data_policy_hash=$2, habeas_data_policy_text=$3 WHERE id=1`,
      [POLICY_VERSION, POLICY_HASH, POLICY_TEXT],
    );
  }

  await db.query(`DELETE FROM admins WHERE email = $1`, [ADMIN_EMAIL]);
  await db.query(
    `INSERT INTO admins (email, password_hash, full_name, role, mfa_required)
     VALUES ($1, $2, 'Sec Admin', 'admin', true)`,
    [ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD)],
  );
});

afterAll(async () => {
  (config as { TURNSTILE_SECRET?: string }).TURNSTILE_SECRET = undefined;
  await db.query(`DELETE FROM otp_codes WHERE patient_phone IN ($1, $2)`, [MOCK_PHONE, UNKNOWN_PHONE]);
  await db.query(`DELETE FROM patient_sessions WHERE dentalink_patient_id = '12345'`);
  await db.query(`DELETE FROM admins WHERE email = $1`, [ADMIN_EMAIL]);
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
  await flushRateLimitRedis();
  const bl = await redis.getClient().keys('admin:blocklist:*');
  if (bl.length) await redis.getClient().del(...bl);
  await app.close();
});

beforeEach(async () => {
  captured.sms = [];
  captured.email = [];
  await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
  await flushRateLimitRedis();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Rate-limit global por IP', () => {
  const IP_A = '203.0.113.10';
  const IP_B = '203.0.113.99';

  // /me/payments tiene techo 15/min y, sin auth, devuelve 401 antes del handler:
  // sirve para contar peticiones sin efectos colaterales.
  const hit = (ip: string) =>
    app.inject({
      method: 'POST',
      url: '/me/payments',
      headers: { 'x-forwarded-for': ip },
      payload: { amount_cop: 1000, description: 'x' },
    });

  it('bloquea con 429 + Retry-After al superar el techo de la ruta', async () => {
    for (let i = 0; i < 15; i++) {
      const r = await hit(IP_A);
      expect(r.statusCode).not.toBe(429); // dentro del límite (401 sin auth)
    }
    const blocked = await hit(IP_A);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('aísla por IP: otra IP no queda limitada', async () => {
    for (let i = 0; i < 16; i++) await hit(IP_A); // agota IP_A
    const other = await hit(IP_B);
    expect(other.statusCode).not.toBe(429);
  });

  it('se reinicia al expirar la ventana (simulado limpiando el store)', async () => {
    for (let i = 0; i < 16; i++) await hit(IP_A);
    expect((await hit(IP_A)).statusCode).toBe(429);
    await flushRateLimitRedis(); // equivalente a que pase la ventana
    expect((await hit(IP_A)).statusCode).not.toBe(429);
  });

  it('NO afecta a /health', async () => {
    for (let i = 0; i < 25; i++) {
      const r = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-forwarded-for': IP_A },
      });
      expect(r.statusCode).not.toBe(429);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Anti-abuso de OTP y SMS', () => {
  it('teléfono NO registrado → 200 anti-enum y CERO SMS', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/request-otp',
      payload: otpPayload(UNKNOWN_PHONE, GOOD_TS),
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(captured.sms).toHaveLength(0);
    expect(captured.email).toHaveLength(0);
  });

  it('cooldown: 2º envío inmediato → 429 y el sender NO se invoca de nuevo', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/auth/request-otp', payload: otpPayload(MOCK_PHONE, GOOD_TS) });
    expect(r1.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(captured.sms).toHaveLength(1);

    const r2 = await app.inject({ method: 'POST', url: '/auth/request-otp', payload: otpPayload(MOCK_PHONE, GOOD_TS) });
    expect(r2.statusCode).toBe(429);
    await new Promise((r) => setTimeout(r, 250));
    expect(captured.sms).toHaveLength(1); // sigue siendo 1: no se envió en el 2º
  });

  it('sin token Turnstile → 403 ANTES del sender (cero SMS)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/request-otp',
      payload: otpPayload(MOCK_PHONE), // sin turnstile_token
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('TURNSTILE_REQUIRED');
    await new Promise((r) => setTimeout(r, 200));
    expect(captured.sms).toHaveLength(0);
  });

  it('token Turnstile inválido → 403 (cero SMS)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/request-otp',
      payload: otpPayload(MOCK_PHONE, 'bad-token'),
    });
    expect(res.statusCode).toBe(403);
    expect(captured.sms).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Anti-enumeración', () => {
  it('registrado y no registrado devuelven la misma forma de respuesta', async () => {
    const real = await app.inject({ method: 'POST', url: '/auth/request-otp', payload: otpPayload(MOCK_PHONE, GOOD_TS) });
    // limpiar cooldown/buckets entre las dos llamadas del mismo test
    await db.query(`DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%'`);
    const fake = await app.inject({ method: 'POST', url: '/auth/request-otp', payload: otpPayload(UNKNOWN_PHONE, GOOD_TS) });

    expect(real.statusCode).toBe(200);
    expect(fake.statusCode).toBe(200);
    expect(Object.keys(real.json()).sort()).toEqual(Object.keys(fake.json()).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Fuerza bruta de OTP (verify-otp)', () => {
  it('tras 5 códigos incorrectos → 429 TOO_MANY_ATTEMPTS', async () => {
    const req = await app.inject({ method: 'POST', url: '/auth/request-otp', payload: otpPayload(MOCK_PHONE, GOOD_TS) });
    const { request_id } = req.json();

    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/auth/verify-otp', payload: { request_id, code: '000000' } });
    }
    const blocked = await app.inject({ method: 'POST', url: '/auth/verify-otp', payload: { request_id, code: '111111' } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe('TOO_MANY_ATTEMPTS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Blocklist de sesión admin', () => {
  async function loginToken(): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const body = res.json();
    // mfa_required=true + mfa_enrolled=false → sesión de enrollment con token.
    return body.session_token as string;
  }

  it('un token sigue válido antes del logout', async () => {
    const token = await loginToken();
    const me = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
  });

  it('tras /logout, el mismo token → 401 (revocación real)', async () => {
    const token = await loginToken();
    const logout = await app.inject({ method: 'POST', url: '/admin/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/admin/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });
});
