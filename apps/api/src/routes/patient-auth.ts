/**
 * =============================================================================
 * Routes: /auth/* (paciente)
 * =============================================================================
 *
 * Flujo del paciente:
 *
 *   1. POST /auth/request-otp
 *      Body: { cedula, phone, consent: true, policy_version, policy_hash }
 *      Header: Authorization: Bearer <kiosk_token>
 *      → 200 { request_id, expires_in_seconds }
 *      Respuesta idéntica si el paciente existe o no (anti-enumeración).
 *
 *   2. POST /auth/verify-otp
 *      Body: { request_id, code }
 *      → 200 { session_token, patient: { name }, expires_at }
 *
 *   3. POST /auth/logout
 *      Header: Authorization: Bearer <patient_session_token>
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { db } from '../lib/db.js';
import { logger, maskPhone, maskEmail } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink } from '../lib/dentalink.js';
import { redis } from '../lib/redis.js';
import { sendOtpDual } from '../lib/notifications.js';
import {
  generateOtpCode,
  hashOtp,
  verifyOtp,
  generateSalt,
} from '../lib/otp.js';
import {
  verifyKioskToken,
  signPatientSession,
  verifyPatientSession,
} from '../lib/jwt.js';
import { config } from '../lib/config.js';

// ----- Schemas -----

const RequestOtpBody = z.object({
  phone: z
    .string()
    .regex(/^\+57[3]\d{9}$/, 'Celular debe ser +57XXXXXXXXXX (10 dígitos comenzando en 3)'),
  consent: z.literal(true, {
    errorMap: () => ({ message: 'Debe aceptar el aviso de Habeas Data' }),
  }),
  policy_version: z.string().min(1).max(20),
  policy_hash: z.string().regex(/^[a-f0-9]{64}$/, 'Hash de política inválido'),
});

const VerifyOtpBody = z.object({
  request_id: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/, 'Código debe tener 6 dígitos'),
});

// ----- Helpers -----

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match ? match[1]! : null;
}

interface OtpRow {
  id: string;
  kiosk_id: string | null;
  patient_phone: string;
  patient_email: string | null;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  consumed_at: Date | null;
  expires_at: Date;
  dentalink_patient_id: string | null;
  dentalink_patient_name: string | null;
}

// ----- Rutas -----

export async function patientAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /auth/request-otp
   */
  app.post('/auth/request-otp', async (request, reply) => {
    // 1. Validar input
    const parsed = RequestOtpBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        details: parsed.error.flatten(),
      });
    }
    const { phone, policy_version, policy_hash } = parsed.data;

    // 2. Validar kiosk_token
    const kioskTokenStr = extractBearer(request.headers.authorization);
    if (!kioskTokenStr) {
      return reply.code(401).send({ error: 'KIOSK_TOKEN_REQUIRED' });
    }

    let kioskClaims;
    try {
      kioskClaims = await verifyKioskToken(kioskTokenStr);
    } catch {
      await audit({
        actorType: 'system',
        action: 'patient.otp.invalid_kiosk_token',
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'INVALID_KIOSK_TOKEN' });
    }

    const kioskId = kioskClaims.sub;

    // 3. Verificar que el kiosco está activo
    const kioskResult = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM kiosks WHERE id = $1`,
      [kioskId],
    );
    if (!kioskResult.rows[0]?.is_active) {
      await audit({
        actorType: 'system',
        action: 'patient.otp.inactive_kiosk',
        resourceType: 'kiosk',
        resourceId: kioskId,
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(403).send({ error: 'KIOSK_INACTIVE' });
    }

    // 4. Rate limiting (3 buckets independientes)
    const buckets = [
      { key: `otp:phone:${phone}`, max: config.RATE_LIMIT_OTP_PER_PHONE_PER_HOUR, secs: 3600 },
      { key: `otp:ip:${request.ip}`, max: config.RATE_LIMIT_OTP_PER_IP_PER_HOUR, secs: 3600 },
      { key: `otp:kiosk:${kioskId}`, max: config.RATE_LIMIT_OTP_PER_KIOSK_PER_HOUR, secs: 3600 },
    ];
    for (const b of buckets) {
      const rl = await db.query<{ allowed: boolean; retry_after_secs: number }>(
        `SELECT * FROM fn_rate_limit_check($1, $2, $3)`,
        [b.key, b.max, b.secs],
      );
      if (!rl.rows[0]?.allowed) {
        await audit({
          actorType: 'system',
          action: 'patient.otp.rate_limit',
          metadata: { bucket_type: b.key.split(':')[1] },
          result: 'denied',
          ip: request.ip,
        });
        return reply.code(429).send({
          error: 'RATE_LIMIT',
          retry_after_seconds: rl.rows[0]?.retry_after_secs ?? b.secs,
        });
      }
    }

    // 5. Registrar consentimiento Habeas Data ANTES de buscar al paciente.
    //    Sin cédula → patient_cedula_hash queda NULL (migración 012).
    await db.query(
      `INSERT INTO habeas_data_consents
        (kiosk_id, patient_cedula_hash, patient_phone, policy_version, policy_text_hash, ip_address, user_agent)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
      [
        kioskId,
        phone,
        policy_version,
        policy_hash,
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    // 6. Cargar token Dentalink de la clínica
    const clinicResult = await db.query<{
      dentalink_token_encrypted: Buffer | null;
      habeas_data_policy_hash: string | null;
    }>(`SELECT dentalink_token_encrypted, habeas_data_policy_hash FROM clinic WHERE id = 1`);
    const dentalinkToken = await decrypt(
      clinicResult.rows[0]?.dentalink_token_encrypted ?? null,
    );

    const clinicPolicyHash = clinicResult.rows[0]?.habeas_data_policy_hash;
    if (clinicPolicyHash && policy_hash !== clinicPolicyHash) {
      logger.warn(
        {
          kiosk: kioskId,
          sent: policy_hash.substring(0, 8),
          expected: clinicPolicyHash.substring(0, 8),
        },
        'Habeas data policy hash mismatch',
      );
    }

    // 7. Lookup del paciente por celular (spike S1: warning + primero si hay duplicados)
    const patient = await dentalink.lookupPatientByCelular(phone, dentalinkToken);

    const requestId = randomUUID();
    const expiresIn = config.OTP_TTL_MINUTES * 60;

    // 8. Si paciente no existe → respuesta indistinguible (anti-enumeración)
    if (!patient) {
      await audit({
        actorType: 'system',
        action: 'patient.otp.unknown_patient',
        resourceType: 'patient_phone',
        resourceId: maskPhone(phone),
        result: 'denied',
        ip: request.ip,
      });

      logger.info(
        { kiosk: kioskId, phone: maskPhone(phone) },
        'OTP request: patient not found (silent response)',
      );

      // Igualar timing con la rama feliz
      await new Promise((resolve) => setTimeout(resolve, 200));

      return reply.send({
        request_id: requestId,
        expires_in_seconds: expiresIn,
      });
    }

    // 9. Paciente válido: generar y persistir OTP
    const code = generateOtpCode();
    const salt = generateSalt();
    const codeHash = hashOtp(code, salt);
    const storedHash = `${salt}:${codeHash}`;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await db.query(
      `INSERT INTO otp_codes
        (id, kiosk_id, patient_cedula_hash, patient_phone, patient_email,
         code_hash, channel, expires_at, request_ip, user_agent,
         dentalink_patient_id, dentalink_patient_name)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        requestId,
        kioskId,
        phone,
        patient.email ?? null,
        storedHash,
        patient.email ? 'both' : 'sms',
        expiresAt,
        request.ip,
        request.headers['user-agent'] ?? null,
        patient.id,
        patient.nombre,
      ],
    );

    // 9b. Solo en NO-producción: guardar código en claro en Redis para el CLI dk:otp
    if (config.NODE_ENV !== 'production') {
      try {
        await redis.set(
          `otp:dev:${phone}`,
          JSON.stringify({
            code,
            request_id: requestId,
            expires_at: expiresAt.toISOString(),
          }),
          expiresIn,
        );
      } catch (err) {
        logger.warn({ err }, 'Failed to write dev OTP cache');
      }
    }

    // 10. Enviar SMS + Email en paralelo (fire-and-forget, allSettled interno)
    const firstName = patient.nombre.split(' ')[0] ?? 'paciente';
    void sendOtpDual({
      phone,
      email: patient.email ?? null,
      code,
      firstName,
      ttlMinutes: config.OTP_TTL_MINUTES,
    });

    await audit({
      actorType: 'kiosk',
      actorId: kioskId,
      action: 'patient.otp.requested',
      resourceType: 'otp',
      resourceId: requestId,
      metadata: {
        channels: patient.email ? ['sms', 'email'] : ['sms'],
        ttl_minutes: config.OTP_TTL_MINUTES,
      },
      result: 'success',
      ip: request.ip,
    });

    logger.info(
      {
        kiosk: kioskId,
        request_id: requestId,
        phone: maskPhone(phone),
        email: patient.email ? maskEmail(patient.email) : null,
      },
      'OTP requested',
    );

    return reply.send({
      request_id: requestId,
      expires_in_seconds: expiresIn,
    });
  });

  /**
   * POST /auth/verify-otp
   */
  app.post('/auth/verify-otp', async (request, reply) => {
    const parsed = VerifyOtpBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        details: parsed.error.flatten(),
      });
    }
    const { request_id, code } = parsed.data;

    const otpResult = await db.query<OtpRow>(
      `SELECT id, kiosk_id, patient_phone, patient_email, code_hash,
              attempts, max_attempts, consumed_at, expires_at,
              dentalink_patient_id, dentalink_patient_name
       FROM otp_codes WHERE id = $1`,
      [request_id],
    );

    const otp = otpResult.rows[0];

    // Caso 1: no existe
    if (!otp) {
      await audit({
        actorType: 'system',
        action: 'patient.otp.verify.not_found',
        resourceType: 'otp',
        resourceId: request_id,
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(400).send({ error: 'INVALID_OR_EXPIRED' });
    }

    // Caso 2: ya consumido
    if (otp.consumed_at) {
      await audit({
        actorType: 'system',
        action: 'patient.otp.verify.already_consumed',
        resourceType: 'otp',
        resourceId: request_id,
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(400).send({ error: 'INVALID_OR_EXPIRED' });
    }

    // Caso 3: expirado
    if (otp.expires_at < new Date()) {
      await audit({
        actorType: 'system',
        action: 'patient.otp.verify.expired',
        resourceType: 'otp',
        resourceId: request_id,
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(400).send({ error: 'INVALID_OR_EXPIRED' });
    }

    // Caso 4: demasiados intentos
    if (otp.attempts >= otp.max_attempts) {
      await audit({
        actorType: 'system',
        action: 'patient.otp.verify.max_attempts',
        resourceType: 'otp',
        resourceId: request_id,
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' });
    }

    // Incrementar attempts SIEMPRE (antes de validar el código)
    await db.query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [
      request_id,
    ]);

    // Verificar código
    const [salt, expectedHash] = otp.code_hash.split(':');
    const codeOk = !!(salt && expectedHash && verifyOtp(code, salt, expectedHash));

    if (!codeOk) {
      await audit({
        actorType: 'system',
        action: 'patient.otp.verify.wrong_code',
        resourceType: 'otp',
        resourceId: request_id,
        metadata: { attempts: otp.attempts + 1, max: otp.max_attempts },
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(400).send({ error: 'INVALID_CODE' });
    }

    // Código OK: validar consistencia interna
    if (!otp.dentalink_patient_id || !otp.dentalink_patient_name) {
      logger.error(
        { request_id },
        'OTP valid but no dentalink_patient_id (inconsistencia interna)',
      );
      return reply.code(500).send({ error: 'INTERNAL_INCONSISTENCY' });
    }

    // Marcar consumido
    await db.query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [request_id]);

    // Crear sesión paciente
    const { token, jti, expiresAt } = await signPatientSession({
      dentalinkPatientId: otp.dentalink_patient_id,
      kioskId: otp.kiosk_id ?? '00000000-0000-0000-0000-000000000000',
    });

    await db.query(
      `INSERT INTO patient_sessions
        (kiosk_id, dentalink_patient_id, patient_phone_masked, jti, expires_at, request_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        otp.kiosk_id,
        otp.dentalink_patient_id,
        maskPhone(otp.patient_phone),
        jti,
        expiresAt,
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    await audit({
      actorType: 'patient',
      actorId: jti,
      action: 'patient.otp.verified',
      resourceType: 'patient',
      resourceId: otp.dentalink_patient_id,
      metadata: { kiosk_id: otp.kiosk_id, jti },
      result: 'success',
      ip: request.ip,
    });

    logger.info(
      {
        request_id,
        jti,
        dentalink_patient_id: otp.dentalink_patient_id,
        kiosk: otp.kiosk_id,
      },
      'Patient authenticated',
    );

    return reply.send({
      session_token: token,
      expires_at: expiresAt.toISOString(),
      patient: {
        name: otp.dentalink_patient_name,
      },
    });
  });

  /**
   * POST /auth/login-direct
   *
   * Autenticación sin OTP: solo cédula + teléfono.
   * Solo disponible cuando OTP_REQUIRED=false en el servidor.
   * Valida que el teléfono coincida con el registrado en Dentalink para esa cédula.
   */
  app.post('/auth/login-direct', async (request, reply) => {
    if (config.OTP_REQUIRED) {
      return reply.code(403).send({ error: 'OTP_REQUIRED' });
    }

    // 1. Validar input (mismo schema que request-otp)
    const parsed = RequestOtpBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        details: parsed.error.flatten(),
      });
    }
    const { phone, policy_version, policy_hash } = parsed.data;

    // 2. Validar kiosk_token
    const kioskTokenStr = extractBearer(request.headers.authorization);
    if (!kioskTokenStr) {
      return reply.code(401).send({ error: 'KIOSK_TOKEN_REQUIRED' });
    }

    let kioskClaims;
    try {
      kioskClaims = await verifyKioskToken(kioskTokenStr);
    } catch {
      return reply.code(401).send({ error: 'INVALID_KIOSK_TOKEN' });
    }

    const kioskId = kioskClaims.sub;

    // 3. Verificar que el kiosco está activo
    const kioskResult = await db.query<{ is_active: boolean }>(
      `SELECT is_active FROM kiosks WHERE id = $1`,
      [kioskId],
    );
    if (!kioskResult.rows[0]?.is_active) {
      return reply.code(403).send({ error: 'KIOSK_INACTIVE' });
    }

    // 4. Rate limiting (reutiliza los mismos buckets que OTP)
    const buckets = [
      { key: `otp:phone:${phone}`, max: config.RATE_LIMIT_OTP_PER_PHONE_PER_HOUR, secs: 3600 },
      { key: `otp:ip:${request.ip}`, max: config.RATE_LIMIT_OTP_PER_IP_PER_HOUR, secs: 3600 },
      { key: `otp:kiosk:${kioskId}`, max: config.RATE_LIMIT_OTP_PER_KIOSK_PER_HOUR, secs: 3600 },
    ];
    for (const b of buckets) {
      const rl = await db.query<{ allowed: boolean; retry_after_secs: number }>(
        `SELECT * FROM fn_rate_limit_check($1, $2, $3)`,
        [b.key, b.max, b.secs],
      );
      if (!rl.rows[0]?.allowed) {
        return reply.code(429).send({
          error: 'RATE_LIMIT',
          retry_after_seconds: rl.rows[0]?.retry_after_secs ?? b.secs,
        });
      }
    }

    // 5. Registrar consentimiento Habeas Data (sin cédula → NULL, migración 012)
    await db.query(
      `INSERT INTO habeas_data_consents
        (kiosk_id, patient_cedula_hash, patient_phone, policy_version, policy_text_hash, ip_address, user_agent)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
      [
        kioskId,
        phone,
        policy_version,
        policy_hash,
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    // 6. Cargar token Dentalink
    const clinicResult = await db.query<{ dentalink_token_encrypted: Buffer | null }>(
      `SELECT dentalink_token_encrypted FROM clinic WHERE id = 1`,
    );
    const dentalinkToken = await decrypt(
      clinicResult.rows[0]?.dentalink_token_encrypted ?? null,
    );

    // 7. Buscar paciente en Dentalink por celular
    const patient = await dentalink.lookupPatientByCelular(phone, dentalinkToken);

    if (!patient) {
      await audit({
        actorType: 'system',
        action: 'patient.direct.unknown_patient',
        resourceType: 'patient_phone',
        resourceId: maskPhone(phone),
        result: 'denied',
        ip: request.ip,
      });
      return reply.code(401).send({ error: 'PATIENT_NOT_FOUND' });
    }

    // 8. Crear sesión directamente
    const { token, jti, expiresAt } = await signPatientSession({
      dentalinkPatientId: patient.id,
      kioskId,
    });

    await db.query(
      `INSERT INTO patient_sessions
        (kiosk_id, dentalink_patient_id, patient_phone_masked, jti, expires_at, request_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        kioskId,
        patient.id,
        maskPhone(phone),
        jti,
        expiresAt,
        request.ip,
        request.headers['user-agent'] ?? null,
      ],
    );

    await audit({
      actorType: 'kiosk',
      actorId: kioskId,
      action: 'patient.direct.authenticated',
      resourceType: 'patient',
      resourceId: patient.id,
      metadata: { jti, otp_required: false },
      result: 'success',
      ip: request.ip,
    });

    logger.info(
      {
        jti,
        dentalink_patient_id: patient.id,
        phone: maskPhone(phone),
        kiosk: kioskId,
      },
      'Patient authenticated (direct, no OTP)',
    );

    return reply.send({
      session_token: token,
      expires_at: expiresAt.toISOString(),
      patient: {
        name: patient.nombre,
      },
    });
  });

  /**
   * POST /auth/logout
   */
  app.post('/auth/logout', async (request, reply) => {
    const token = extractBearer(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }

    try {
      const claims = await verifyPatientSession(token);

      await db.query(
        `UPDATE patient_sessions
         SET revoked_at = now(), revoked_reason = 'user_logout'
         WHERE jti = $1 AND revoked_at IS NULL`,
        [claims.jti],
      );

      await audit({
        actorType: 'patient',
        actorId: claims.jti,
        action: 'patient.logout',
        result: 'success',
        ip: request.ip,
      });

      return reply.send({ ok: true });
    } catch {
      return reply.code(401).send({ error: 'INVALID_TOKEN' });
    }
  });
}
