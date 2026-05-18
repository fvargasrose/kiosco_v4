/**
 * =============================================================================
 * Routes: /admin/auth/*
 * =============================================================================
 *
 * Flujo de autenticación admin:
 *
 *   1. POST /admin/auth/login {email, password}
 *      → si MFA enrolled: { mfa_required: true, mfa_challenge_token }
 *      → si MFA no enrolled: { mfa_enrollment_required: true, session_token (sin mfa) }
 *      → si todo ok: { session_token }
 *
 *   2. POST /admin/auth/mfa/verify {mfa_challenge_token, code}
 *      → { session_token }
 *
 *   3. POST /admin/auth/mfa/enroll-start (requires session w/o mfa)
 *      → { otpauth_url, qr_code_data_url, recovery_codes }
 *
 *   4. POST /admin/auth/mfa/enroll-confirm {code} (requires session w/o mfa)
 *      → { session_token (con mfa_verified: true) }
 *
 *   5. GET /admin/auth/me (requires session)
 *      → { admin info }
 *
 *   6. POST /admin/auth/logout (requires session)
 *      → revoca sesión
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import {
  generateTotpSecret,
  buildOtpauthUrl,
  generateTotpQrCode,
  verifyTotpCode,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '../lib/totp.js';
import { signAdminSession, verifyAdminSession } from '../lib/jwt.js';
import { config } from '../lib/config.js';
import { requireAdmin } from '../lib/auth-middleware.js';

// ----- Schemas Zod -----

const LoginBody = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
});

const MfaVerifyBody = z.object({
  mfa_challenge_token: z.string().min(1),
  code: z.string().regex(/^\d{6}$/, 'Código debe tener 6 dígitos'),
});

const MfaEnrollConfirmBody = z.object({
  code: z.string().regex(/^\d{6}$/, 'Código debe tener 6 dígitos'),
});

// ----- DB row types -----

interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: 'admin' | 'viewer';
  totp_secret_encrypted: Buffer | null;
  totp_recovery_codes_encrypted: Buffer | null;
  mfa_enrolled: boolean;
  mfa_required: boolean;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
}

/**
 * MFA challenge tokens: tokens cortos (5 min) emitidos tras password OK
 * cuando MFA está enrolled. Sólo sirven para llamar a /mfa/verify.
 *
 * Los guardamos en memoria local (Map). Si el API se reinicia, los pierde,
 * lo que está bien (el usuario simplemente vuelve a hacer login).
 */
const mfaChallenges = new Map<
  string,
  { adminId: string; expiresAt: Date }
>();

function generateChallengeToken(adminId: string): string {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min
  mfaChallenges.set(token, { adminId, expiresAt });
  return token;
}

function consumeChallengeToken(token: string): string | null {
  const entry = mfaChallenges.get(token);
  if (!entry) return null;
  if (entry.expiresAt < new Date()) {
    mfaChallenges.delete(token);
    return null;
  }
  mfaChallenges.delete(token);
  return entry.adminId;
}

// Limpieza periódica
setInterval(
  () => {
    const now = new Date();
    for (const [k, v] of mfaChallenges.entries()) {
      if (v.expiresAt < now) mfaChallenges.delete(k);
    }
  },
  60 * 1000,
);

// ----- Rutas -----

export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /admin/auth/login
   */
  app.post('/admin/auth/login', async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        details: parsed.error.flatten(),
      });
    }
    const { email, password } = parsed.data;

    // Lookup admin
    const result = await db.query<AdminRow>(
      `SELECT id, email, password_hash, full_name, role,
              totp_secret_encrypted, totp_recovery_codes_encrypted,
              mfa_enrolled, mfa_required, is_active, must_change_password,
              failed_login_attempts, locked_until
       FROM admins
       WHERE email = $1 AND deleted_at IS NULL`,
      [email],
    );

    const admin = result.rows[0];

    // Constant-time: hacemos verify aún si admin no existe, para no exponer timing
    const dummyHash =
      '$argon2id$v=19$m=65536,t=3,p=4$Zm9vYmFyYmF6Zm9vYmFy$ZmFrZWhhc2hmb3J0aW1pbmdjb25zdGFudA';
    const passwordOk = admin
      ? await verifyPassword(admin.password_hash, password)
      : await verifyPassword(dummyHash, password);

    if (!admin || !admin.is_active) {
      await audit({
        actorType: 'system',
        action: 'admin.login.unknown_user',
        metadata: { email },
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    // Cuenta bloqueada
    if (admin.locked_until && admin.locked_until > new Date()) {
      await audit({
        actorType: 'admin',
        actorId: admin.id,
        actorEmail: email,
        action: 'admin.login.locked',
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(429).send({
        error: 'ACCOUNT_LOCKED',
        retry_after: admin.locked_until.toISOString(),
      });
    }

    if (!passwordOk) {
      // Incrementar contador de fallos
      const newAttempts = admin.failed_login_attempts + 1;
      const shouldLock = newAttempts >= config.RATE_LIMIT_LOGIN_ATTEMPTS_BEFORE_LOCK;
      const lockedUntil = shouldLock
        ? new Date(Date.now() + config.RATE_LIMIT_LOGIN_LOCKOUT_MINUTES * 60 * 1000)
        : null;

      await db.query(
        `UPDATE admins
         SET failed_login_attempts = $1,
             locked_until = $2
         WHERE id = $3`,
        [newAttempts, lockedUntil, admin.id],
      );

      await audit({
        actorType: 'admin',
        actorId: admin.id,
        actorEmail: email,
        action: shouldLock ? 'admin.login.locked_after_attempts' : 'admin.login.invalid_password',
        metadata: { attempts: newAttempts },
        result: 'denied',
        ip: request.ip,
      });

      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    }

    // Password OK - resetear contador
    if (admin.failed_login_attempts > 0 || admin.locked_until) {
      await db.query(
        `UPDATE admins SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
        [admin.id],
      );
    }

    // Caso 1: MFA enrolled → emitir challenge token
    if (admin.mfa_enrolled) {
      const challengeToken = generateChallengeToken(admin.id);
      await audit({
        actorType: 'admin',
        actorId: admin.id,
        actorEmail: email,
        action: 'admin.login.password_ok_awaiting_mfa',
        result: 'success',
        ip: request.ip,
      });
      return reply.send({
        mfa_required: true,
        mfa_challenge_token: challengeToken,
        expires_in_seconds: 300,
      });
    }

    // Caso 2: MFA NO enrolled pero es requerido → sesión "limitada"
    // El admin debe enrollar MFA antes de poder hacer otras cosas
    if (admin.mfa_required) {
      const { token, jti, expiresAt } = await signAdminSession({
        adminId: admin.id,
        email: admin.email,
        role: admin.role,
        mfaVerified: false, // NO ha verificado MFA, esta sesión solo sirve para enrollment
      });

      await db.query(
        `UPDATE admins SET last_login_at = now(), last_login_ip = $1 WHERE id = $2`,
        [request.ip, admin.id],
      );

      await audit({
        actorType: 'admin',
        actorId: admin.id,
        actorEmail: email,
        action: 'admin.login.mfa_enrollment_required',
        metadata: { jti },
        result: 'success',
        ip: request.ip,
      });

      return reply.send({
        mfa_enrollment_required: true,
        session_token: token,
        expires_at: expiresAt.toISOString(),
        must_change_password: admin.must_change_password,
      });
    }

    // Caso 3: MFA no requerido (no es nuestro caso por defecto pero soportado)
    const { token, jti, expiresAt } = await signAdminSession({
      adminId: admin.id,
      email: admin.email,
      role: admin.role,
      mfaVerified: true,
    });

    await db.query(
      `UPDATE admins SET last_login_at = now(), last_login_ip = $1 WHERE id = $2`,
      [request.ip, admin.id],
    );

    await audit({
      actorType: 'admin',
      actorId: admin.id,
      actorEmail: email,
      action: 'admin.login.success',
      metadata: { jti, mfa: 'not_required' },
      result: 'success',
      ip: request.ip,
    });

    return reply.send({
      session_token: token,
      expires_at: expiresAt.toISOString(),
      must_change_password: admin.must_change_password,
    });
  });

  /**
   * POST /admin/auth/mfa/verify
   * Verifica el código TOTP usando el challenge_token emitido por /login
   */
  app.post('/admin/auth/mfa/verify', async (request, reply) => {
    const parsed = MfaVerifyBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
    }

    const adminId = consumeChallengeToken(parsed.data.mfa_challenge_token);
    if (!adminId) {
      await audit({
        actorType: 'system',
        action: 'admin.mfa.invalid_challenge',
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'INVALID_CHALLENGE' });
    }

    const result = await db.query<AdminRow>(
      `SELECT id, email, role, totp_secret_encrypted, mfa_enrolled, is_active
       FROM admins WHERE id = $1`,
      [adminId],
    );
    const admin = result.rows[0];

    if (!admin || !admin.is_active || !admin.mfa_enrolled || !admin.totp_secret_encrypted) {
      return reply.code(401).send({ error: 'MFA_NOT_ENROLLED' });
    }

    const secret = await decrypt(admin.totp_secret_encrypted);
    if (!secret) {
      logger.error({ adminId }, 'Cannot decrypt TOTP secret');
      return reply.code(500).send({ error: 'INTERNAL' });
    }

    if (!verifyTotpCode(secret, parsed.data.code)) {
      await audit({
        actorType: 'admin',
        actorId: admin.id,
        actorEmail: admin.email,
        action: 'admin.mfa.invalid_code',
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'INVALID_CODE' });
    }

    // Emitir session token con MFA verificada
    const { token, jti, expiresAt } = await signAdminSession({
      adminId: admin.id,
      email: admin.email,
      role: admin.role,
      mfaVerified: true,
    });

    await db.query(
      `UPDATE admins SET last_login_at = now(), last_login_ip = $1 WHERE id = $2`,
      [request.ip, admin.id],
    );

    await audit({
      actorType: 'admin',
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'admin.login.success',
      metadata: { jti, mfa: 'totp_verified' },
      result: 'success',
      ip: request.ip,
    });

    return reply.send({
      session_token: token,
      expires_at: expiresAt.toISOString(),
    });
  });

  /**
   * POST /admin/auth/mfa/enroll-start
   * Genera un secret TOTP nuevo y retorna el QR para escanear.
   * Requiere sesión válida (incluso sin MFA verificada).
   */
  app.post(
    '/admin/auth/mfa/enroll-start',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const admin = request.admin!;

      // Verificar que el admin existe y no tiene MFA ya enrollada
      const result = await db.query<{ mfa_enrolled: boolean }>(
        `SELECT mfa_enrolled FROM admins WHERE id = $1`,
        [admin.sub],
      );
      if (result.rows[0]?.mfa_enrolled) {
        return reply.code(400).send({
          error: 'ALREADY_ENROLLED',
          message: 'MFA ya está configurado. Use el flujo de reset si lo perdió.',
        });
      }

      // Generar nuevo secret + recovery codes
      const secret = generateTotpSecret();
      const recoveryCodes = generateRecoveryCodes(10);

      // Cifrar y guardar (PROVISIONAL: solo se "activa" tras confirmar el código)
      // Para esto, guardamos en un campo separado o usamos el mismo y marcamos enrolled=false
      // Decisión: guardamos cifrado pero NO marcamos enrolled hasta confirmar
      const secretEncrypted = await encrypt(secret);
      const recoveryHashes = recoveryCodes.map(hashRecoveryCode);
      const recoveryEncrypted = await encrypt(JSON.stringify(recoveryHashes));

      await db.query(
        `UPDATE admins
         SET totp_secret_encrypted = $1,
             totp_recovery_codes_encrypted = $2
         WHERE id = $3`,
        [secretEncrypted, recoveryEncrypted, admin.sub],
      );

      const otpauthUrl = buildOtpauthUrl(secret, admin.email);
      const qrDataUrl = await generateTotpQrCode(otpauthUrl);

      await audit({
        actorType: 'admin',
        actorId: admin.sub,
        actorEmail: admin.email,
        action: 'admin.mfa.enroll_started',
        result: 'success',
        ip: request.ip,
      });

      return reply.send({
        otpauth_url: otpauthUrl,
        qr_code_data_url: qrDataUrl,
        recovery_codes: recoveryCodes, // SOLO se muestran AQUÍ una vez
        message:
          'Escanea el QR con Google Authenticator y guarda los códigos de respaldo en un lugar seguro. NO se mostrarán de nuevo.',
      });
    },
  );

  /**
   * POST /admin/auth/mfa/enroll-confirm
   * Confirma el enrollment ingresando el primer código TOTP.
   */
  app.post(
    '/admin/auth/mfa/enroll-confirm',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const admin = request.admin!;
      const parsed = MfaEnrollConfirmBody.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'INVALID_INPUT', details: parsed.error.flatten() });
      }

      const result = await db.query<{
        totp_secret_encrypted: Buffer | null;
        mfa_enrolled: boolean;
      }>(
        `SELECT totp_secret_encrypted, mfa_enrolled FROM admins WHERE id = $1`,
        [admin.sub],
      );
      const row = result.rows[0];

      if (!row?.totp_secret_encrypted) {
        return reply.code(400).send({
          error: 'NO_ENROLLMENT_IN_PROGRESS',
          message: 'Primero llame a /enroll-start',
        });
      }

      if (row.mfa_enrolled) {
        return reply.code(400).send({ error: 'ALREADY_ENROLLED' });
      }

      const secret = await decrypt(row.totp_secret_encrypted);
      if (!secret || !verifyTotpCode(secret, parsed.data.code)) {
        await audit({
          actorType: 'admin',
          actorId: admin.sub,
          actorEmail: admin.email,
          action: 'admin.mfa.enroll_invalid_code',
          result: 'denied',
          ip: request.ip,
        });
        return reply.code(400).send({ error: 'INVALID_CODE' });
      }

      // Confirmar enrollment
      await db.query(
        `UPDATE admins SET mfa_enrolled = true WHERE id = $1`,
        [admin.sub],
      );

      // Emitir sesión nueva con MFA verificada
      const { token, jti, expiresAt } = await signAdminSession({
        adminId: admin.sub,
        email: admin.email,
        role: admin.role,
        mfaVerified: true,
      });

      await audit({
        actorType: 'admin',
        actorId: admin.sub,
        actorEmail: admin.email,
        action: 'admin.mfa.enroll_confirmed',
        metadata: { jti },
        result: 'success',
        ip: request.ip,
      });

      return reply.send({
        session_token: token,
        expires_at: expiresAt.toISOString(),
        message: 'MFA configurado exitosamente',
      });
    },
  );

  /**
   * GET /admin/auth/me - info de la sesión actual
   */
  app.get('/admin/auth/me', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = request.admin!;

    const result = await db.query<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      mfa_enrolled: boolean;
      last_login_at: Date | null;
      last_login_ip: string | null;
      must_change_password: boolean;
    }>(
      `SELECT id, email, full_name, role, mfa_enrolled, last_login_at, last_login_ip, must_change_password
       FROM admins WHERE id = $1`,
      [admin.sub],
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'ADMIN_NOT_FOUND' });
    }

    return reply.send({
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      mfa_enrolled: row.mfa_enrolled,
      mfa_verified_in_session: admin.mfa_verified,
      last_login_at: row.last_login_at,
      last_login_ip: row.last_login_ip,
      must_change_password: row.must_change_password,
    });
  });

  /**
   * POST /admin/auth/logout
   *
   * Nota: como usamos JWT (stateless), "logout" en el cliente es solo borrar el token.
   * Aquí registramos el evento. Para revocación real, usaríamos una blocklist en Redis.
   */
  app.post('/admin/auth/logout', { preHandler: requireAdmin }, async (request, reply) => {
    const admin = request.admin!;
    await audit({
      actorType: 'admin',
      actorId: admin.sub,
      actorEmail: admin.email,
      action: 'admin.logout',
      result: 'success',
      ip: request.ip,
    });
    return reply.send({ ok: true });
  });
}

/**
 * Función auxiliar exportada para uso del seed (Hito 2) y tests:
 * crea un admin con password hasheado.
 */
export async function createAdmin(input: {
  email: string;
  password: string;
  fullName: string;
  role?: 'admin' | 'viewer';
  phone?: string;
}): Promise<string> {
  const hash = await hashPassword(input.password);
  const result = await db.query<{ id: string }>(
    `INSERT INTO admins (email, password_hash, full_name, phone, role, must_change_password)
     VALUES ($1, $2, $3, $4, $5, false)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [input.email, hash, input.fullName, input.phone ?? null, input.role ?? 'admin'],
  );
  return result.rows[0]!.id;
}
