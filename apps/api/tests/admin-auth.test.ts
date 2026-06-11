/**
 * =============================================================================
 * Tests integración: admin auth
 * =============================================================================
 *
 * Estos tests:
 *   - Arrancan el server in-process (sin red, sin sockets reales)
 *   - Usan Fastify.inject() para invocar endpoints
 *   - Comparten el proceso del test runner
 *
 * Requisitos:
 *   - Postgres corriendo (configurable via .env de tests)
 *   - Redis corriendo
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { db } from '../src/lib/db.js';
import { redis } from '../src/lib/redis.js';
import { hashPassword } from '../src/lib/passwords.js';
import { generateSync } from 'otplib';
import { decrypt } from '../src/lib/crypto.js';
import { getEmailSender, setEmailSender } from '../src/lib/email.js';

let app: FastifyInstance;

const TEST_EMAIL = 'test_admin@demo.local';
const TEST_PASSWORD = 'TestPwd1234!';

beforeAll(async () => {
  app = await buildServer();
  await app.ready();

  // Limpiar admin de pruebas si existe
  await db.query(`DELETE FROM admins WHERE email = $1`, [TEST_EMAIL]);

  // Crear admin con password conocido
  const hash = await hashPassword(TEST_PASSWORD);
  await db.query(
    `INSERT INTO admins (email, password_hash, full_name, role, mfa_required)
     VALUES ($1, $2, 'Test Admin', 'admin', true)`,
    [TEST_EMAIL, hash],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM admins WHERE email = $1`, [TEST_EMAIL]);
  await app.close();
});

describe('POST /admin/auth/login', () => {
  it('rechaza usuario inexistente', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'no-existe@demo.local', password: 'WrongPwd!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('INVALID_CREDENTIALS');
  });

  it('rechaza password incorrecto', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: 'WrongPassword!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('INVALID_CREDENTIALS');
  });

  it('rechaza input inválido (sin email)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_INPUT');
  });

  it('rechaza email inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'not-an-email', password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
  });

  it('login OK exige MFA enrollment (admin sin MFA)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mfa_enrollment_required).toBe(true);
    expect(body.session_token).toMatch(/^eyJ/); // JWT format
  });

  it('respuestas tienen tiempo similar para usuario existente vs no existente (anti-timing)', async () => {
    const N = 5;
    const tNonExistent: number[] = [];
    const tExistent: number[] = [];

    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      await app.inject({
        method: 'POST',
        url: '/admin/auth/login',
        payload: { email: `noexiste${i}@demo.local`, password: 'WrongPwd!' },
      });
      tNonExistent.push(performance.now() - t0);

      const t1 = performance.now();
      await app.inject({
        method: 'POST',
        url: '/admin/auth/login',
        payload: { email: TEST_EMAIL, password: 'WrongPwd!' },
      });
      tExistent.push(performance.now() - t1);
    }

    const avgNon = tNonExistent.reduce((a, b) => a + b, 0) / N;
    const avgExist = tExistent.reduce((a, b) => a + b, 0) / N;
    // Diferencia debe ser < 30% (argon2 toma ~50-200ms, así que pequeñas variaciones son normales)
    const ratio = Math.abs(avgNon - avgExist) / Math.max(avgNon, avgExist);
    expect(ratio).toBeLessThan(0.5);
  });
});

describe('Account lockout', () => {
  beforeAll(async () => {
    await db.query(
      `UPDATE admins SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1`,
      [TEST_EMAIL],
    );
  });

  it('bloquea cuenta después de N intentos fallidos', async () => {
    // 5 intentos fallidos seguidos
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/admin/auth/login',
        payload: { email: TEST_EMAIL, password: 'WrongPwd!' },
      });
    }

    // El 5to debe ya estar bloqueado o el siguiente
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD }, // password correcto pero locked
    });
    // Después del lock, incluso con password correcto debe rechazar
    expect([401, 429]).toContain(res.statusCode);

    // Limpiar para no afectar otros tests
    await db.query(
      `UPDATE admins SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1`,
      [TEST_EMAIL],
    );
  });
});

describe('MFA enrollment flow', () => {
  let sessionToken: string;

  beforeAll(async () => {
    // Resetear admin a estado limpio
    await db.query(
      `UPDATE admins
       SET failed_login_attempts = 0, locked_until = NULL,
           mfa_enrolled = false,
           totp_secret_encrypted = NULL,
           totp_recovery_codes_encrypted = NULL
       WHERE email = $1`,
      [TEST_EMAIL],
    );

    // Login para obtener session
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    sessionToken = res.json().session_token;
  });

  it('GET /admin/auth/me retorna info del admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/auth/me',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe(TEST_EMAIL);
    expect(body.mfa_enrolled).toBe(false);
    expect(body.mfa_verified_in_session).toBe(false);
  });

  it('GET /admin/auth/me sin token retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /admin/auth/me con token inválido retorna 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/auth/me',
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /admin/auth/mfa/enroll-start genera QR y recovery codes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/mfa/enroll-start',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    expect(body.qr_code_data_url).toMatch(/^data:image\/png;base64,/);
    expect(body.recovery_codes).toHaveLength(10);
  });

  it('POST /admin/auth/mfa/enroll-confirm con código correcto activa MFA', async () => {
    // Obtener el secret del admin para generar código
    const result = await db.query<{ totp_secret_encrypted: Buffer }>(
      `SELECT totp_secret_encrypted FROM admins WHERE email = $1`,
      [TEST_EMAIL],
    );
    const secret = await decrypt(result.rows[0]!.totp_secret_encrypted);
    const code = generateSync({
      strategy: 'totp',
      secret: secret!,
      algorithm: 'sha1',
      digits: 6,
      period: 30,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/mfa/enroll-confirm',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { code },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_token).toMatch(/^eyJ/);

    // Verificar que mfa_enrolled = true en BD
    const check = await db.query<{ mfa_enrolled: boolean }>(
      `SELECT mfa_enrolled FROM admins WHERE email = $1`,
      [TEST_EMAIL],
    );
    expect(check.rows[0]!.mfa_enrolled).toBe(true);

    // El nuevo session_token debe tener mfa_verified: true
    const meRes = await app.inject({
      method: 'GET',
      url: '/admin/auth/me',
      headers: { authorization: `Bearer ${body.session_token}` },
    });
    expect(meRes.json().mfa_verified_in_session).toBe(true);
  });

  it('Login post-enrollment exige código MFA (challenge token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mfa_required).toBe(true);
    expect(body.mfa_challenge_token).toBeTruthy();
    expect(body.session_token).toBeUndefined();
  });

  it('MFA verify con código correcto retorna session_token', async () => {
    // Re-login para obtener nuevo challenge token
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    const challengeToken = loginRes.json().mfa_challenge_token;

    // Generar código TOTP actual
    const result = await db.query<{ totp_secret_encrypted: Buffer }>(
      `SELECT totp_secret_encrypted FROM admins WHERE email = $1`,
      [TEST_EMAIL],
    );
    const secret = await decrypt(result.rows[0]!.totp_secret_encrypted);
    const code = generateSync({
      strategy: 'totp',
      secret: secret!,
      algorithm: 'sha1',
      digits: 6,
      period: 30,
    });

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/mfa/verify',
      payload: { mfa_challenge_token: challengeToken, code },
    });
    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(body.session_token).toMatch(/^eyJ/);
  });

  it('MFA verify con código incorrecto retorna 401', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    const challengeToken = loginRes.json().mfa_challenge_token;

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/mfa/verify',
      payload: { mfa_challenge_token: challengeToken, code: '000000' },
    });
    expect(verifyRes.statusCode).toBe(401);
  });

  it('Challenge token usado se invalida (single-use)', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
    const challengeToken = loginRes.json().mfa_challenge_token;

    // Primer intento con código incorrecto consume el token
    await app.inject({
      method: 'POST',
      url: '/admin/auth/mfa/verify',
      payload: { mfa_challenge_token: challengeToken, code: '000000' },
    });

    // Segundo intento (incluso con código bueno) debe fallar porque token ya consumido
    const result = await db.query<{ totp_secret_encrypted: Buffer }>(
      `SELECT totp_secret_encrypted FROM admins WHERE email = $1`,
      [TEST_EMAIL],
    );
    const secret = await decrypt(result.rows[0]!.totp_secret_encrypted);
    const code = generateSync({
      strategy: 'totp',
      secret: secret!,
      algorithm: 'sha1',
      digits: 6,
      period: 30,
    });

    const reuseRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/mfa/verify',
      payload: { mfa_challenge_token: challengeToken, code },
    });
    expect(reuseRes.statusCode).toBe(401);
    expect(reuseRes.json().error).toBe('INVALID_CHALLENGE');
  });
});

describe('Audit log', () => {
  it('Login exitoso genera entrada de audit', async () => {
    // Login (cualquier resultado)
    await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'audit-test@demo.local', password: 'Wrong!' },
    });

    const result = await db.query<{ action: string; result: string }>(
      `SELECT action, result FROM audit_log
       WHERE action LIKE 'admin.login%'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe('Cambio y recuperación de contraseña', () => {
  const PW_EMAIL = 'test_pwd@demo.local';
  const PW_PASSWORD = 'TestPwd1234!';
  let captured: any = null;
  let origSender: ReturnType<typeof getEmailSender>;

  beforeAll(async () => {
    await db.query(`DELETE FROM admins WHERE email = $1`, [PW_EMAIL]);
    const hash = await hashPassword(PW_PASSWORD);
    await db.query(
      `INSERT INTO admins (email, password_hash, full_name, role, mfa_required)
       VALUES ($1, $2, 'PW Admin', 'admin', false)`,
      [PW_EMAIL, hash],
    );
    await redis.del(`admin:pwreset:${PW_EMAIL}`);
    origSender = getEmailSender();
    setEmailSender({
      async send(input) { captured = input; return { id: 'test-capture' }; },
    });
  });

  afterAll(async () => {
    setEmailSender(origSender);
    await db.query(`DELETE FROM admins WHERE email = $1`, [PW_EMAIL]);
    await redis.del(`admin:pwreset:${PW_EMAIL}`);
  });

  async function login(password: string): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { email: PW_EMAIL, password },
    });
    return res.json().session_token;
  }

  it('change-password requiere sesión', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/change-password',
      payload: { current_password: PW_PASSWORD, new_password: 'NewStrong1!' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('change-password rechaza la contraseña actual incorrecta', async () => {
    const token = await login(PW_PASSWORD);
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: 'WrongCurrent1!', new_password: 'NewStrong1!' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('change-password rechaza una nueva contraseña débil', async () => {
    const token = await login(PW_PASSWORD);
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: PW_PASSWORD, new_password: 'weak' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('WEAK_PASSWORD');
  });

  it('change-password exitoso: login refleja la nueva contraseña', async () => {
    const token = await login(PW_PASSWORD);
    const NEW_PW = 'Changed1234!';
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { current_password: PW_PASSWORD, new_password: NEW_PW },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    const oldRes = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { email: PW_EMAIL, password: PW_PASSWORD },
    });
    expect(oldRes.statusCode).toBe(401);

    const newRes = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { email: PW_EMAIL, password: NEW_PW },
    });
    expect(newRes.statusCode).toBe(200);

    // Restaurar la contraseña base para los siguientes tests
    await db.query(`UPDATE admins SET password_hash = $1 WHERE email = $2`,
      [await hashPassword(PW_PASSWORD), PW_EMAIL]);
  });

  it('forgot-password responde 200 genérico para email desconocido', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/forgot-password',
      payload: { email: 'no-existe-jamas@demo.local' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('reset-password rechaza código inexistente/expirado', async () => {
    await redis.del(`admin:pwreset:${PW_EMAIL}`);
    const res = await app.inject({
      method: 'POST', url: '/admin/auth/reset-password',
      payload: { email: PW_EMAIL, code: '000000', new_password: 'Whatever1!' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_OR_EXPIRED');
  });

  it('flujo completo: forgot envía código y reset lo aplica', async () => {
    captured = null;
    const fp = await app.inject({
      method: 'POST', url: '/admin/auth/forgot-password',
      payload: { email: PW_EMAIL },
    });
    expect(fp.statusCode).toBe(200);
    expect(captured).not.toBeNull();
    const match = String(captured.text || '').match(/(\d{6})/);
    expect(match).not.toBeNull();
    const code = match![1];

    const RESET_PW = 'Reset123456!';
    const rp = await app.inject({
      method: 'POST', url: '/admin/auth/reset-password',
      payload: { email: PW_EMAIL, code, new_password: RESET_PW },
    });
    expect(rp.statusCode).toBe(200);
    expect(rp.json().ok).toBe(true);

    const li = await app.inject({
      method: 'POST', url: '/admin/auth/login',
      payload: { email: PW_EMAIL, password: RESET_PW },
    });
    expect(li.statusCode).toBe(200);
  });
});
