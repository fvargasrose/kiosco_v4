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
import { logger, maskCedula, maskPhone, maskEmail } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import { dentalink } from '../lib/dentalink.js';
import { getSmsSender } from '../lib/sms.js';
import { getEmailSender } from '../lib/email.js';
import {
  generateOtpCode,
  hashOtp,
  verifyOtp,
  generateSalt,
  hashCedula,
} from '../lib/otp.js';
import {
  verifyKioskToken,
  signPatientSession,
  verifyPatientSession,
} from '../lib/jwt.js';
import { config } from '../lib/config.js';

// ----- Schemas -----

const RequestOtpBody = z.object({
  cedula: z.string().regex(/^\d{6,12}$/, 'Cédula debe tener 6-12 dígitos'),
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

/**
 * Plantillas de SMS y email para el OTP.
 */
function buildOtpMessages(code: string, firstName: string, ttlMinutes: number) {
  const sms = `Hola ${firstName}, tu código DentalKiosco es: ${code}. Vence en ${ttlMinutes} min. No lo compartas.`;

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #0369a1;">Tu código de acceso</h2>
      <p>Hola ${firstName},</p>
      <p>Tu código de verificación para DentalKiosco es:</p>
      <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px;
                  background: #f1f5f9; padding: 16px; text-align: center;
                  border-radius: 8px; margin: 16px 0;">${code}</div>
      <p style="color: #64748b; font-size: 14px;">
        Este código vence en ${ttlMinutes} minutos. Si no solicitaste este código, ignora este mensaje.
      </p>
    </div>
  `;
  const text = `Hola ${firstName}, tu código DentalKiosco es: ${code}. Vence en ${ttlMinutes} min.`;

  return { sms, html, text };
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
    const { cedula, phone, policy_version, policy_hash } = parsed.data;

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
    const cedulaHash = hashCedula(cedula);
    await db.query(
      `INSERT INTO habeas_data_consents
        (kiosk_id, patient_cedula_hash, patient_phone, policy_version, policy_text_hash, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        kioskId,
        cedulaHash,
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

    logger.info(
      { hasToken: !!dentalinkToken, tokenLen: dentalinkToken?.length ?? 0 },
      'DEBUG decrypt result',
    );

    // 7. Lookup del paciente (servidor-side, sin descargar lista al cliente)
    const patient = await dentalink.lookupPatientByCedula(cedula, dentalinkToken);

    const requestId = randomUUID();
    const expiresIn = config.OTP_TTL_MINUTES * 60;

    // 8. Si paciente no existe O celular no coincide → respuesta indistinguible (anti-enumeración)
    if (!patient || patient.celular !== phone) {
      await audit({
        actorType: 'system',
        action: patient ? 'patient.otp.phone_mismatch' : 'patient.otp.unknown_patient',
        resourceType: 'patient_cedula_hash',
        resourceId: cedulaHash.substring(0, 16),
        result: 'denied',
        ip: request.ip,
      });

      logger.info(
        {
          kiosk: kioskId,
          cedula: maskCedula(cedula),
          phone: maskPhone(phone),
          patient_found: !!patient,
        },
        'OTP request: patient not matched (silent response)',
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        requestId,
        kioskId,
        cedulaHash,
        phone,
        patient.email ?? null,
        storedHash,
        'both',
        expiresAt,
        request.ip,
        request.headers['user-agent'] ?? null,
        patient.id,
        patient.nombre,
      ],
    );

    // 10. Enviar SMS + Email en paralelo (fire-and-forget)
    const firstName = patient.nombre.split(' ')[0] ?? 'paciente';
    const msg = buildOtpMessages(code, firstName, config.OTP_TTL_MINUTES);

    const sms = getSmsSender();
    const email = getEmailSender();

    const sendPromises: Promise<unknown>[] = [
      sms.send(phone, msg.sms).catch((err: unknown) => {
        logger.error({ err, to: maskPhone(phone) }, 'SMS send failed');
      }),
    ];

    if (patient.email) {
      sendPromises.push(
        email
          .send({
            to: patient.email,
            subject: 'Tu código DentalKiosco',
            html: msg.html,
            text: msg.text,
          })
          .catch((err: unknown) => {
            logger.error({ err, to: maskEmail(patient.email!) }, 'Email send failed');
          }),
      );
    }

    void Promise.all(sendPromises);

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
        cedula: maskCedula(cedula),
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
