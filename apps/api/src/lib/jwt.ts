/**
 * =============================================================================
 * JWT - Helpers para firmar y verificar tokens
 * =============================================================================
 *
 * Tres tipos de tokens en el sistema:
 *   1. admin_session  - sesiones de admin de clínica (TTL 8h)
 *   2. kiosk_token    - identifica un kiosco (TTL 90 días)
 *   3. patient_session - sesión de paciente autenticado (TTL 10 min)
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomUUID } from 'crypto';
import { config } from './config.js';

const ENCODER = new TextEncoder();
const SECRET = ENCODER.encode(config.JWT_SECRET);

const ISSUER = 'dentalkiosco';
const AUDIENCE_ADMIN = 'admin';
const AUDIENCE_KIOSK = 'kiosk';
const AUDIENCE_PATIENT = 'patient';

// ----- Claims types -----

export interface AdminSessionClaims extends JWTPayload {
  sub: string; // admin id (UUID)
  email: string;
  role: 'admin' | 'viewer';
  mfa_verified: boolean;
  jti: string;
}

export interface KioskClaims extends JWTPayload {
  sub: string; // kiosk id (UUID)
  kiosk_name: string;
  jti: string;
}

export interface PatientSessionClaims extends JWTPayload {
  sub: string; // dentalink patient id
  kiosk_id: string | null; // null en sesiones web públicas (sin kiosco)
  jti: string;
}

// ----- Admin session -----

export async function signAdminSession(payload: {
  adminId: string;
  email: string;
  role: 'admin' | 'viewer';
  mfaVerified: boolean;
}): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + config.JWT_ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000);

  const token = await new SignJWT({
    email: payload.email,
    role: payload.role,
    mfa_verified: payload.mfaVerified,
    jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.adminId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_ADMIN)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(SECRET);

  return { token, jti, expiresAt };
}

export async function verifyAdminSession(token: string): Promise<AdminSessionClaims> {
  const { payload } = await jwtVerify(token, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE_ADMIN,
  });
  return payload as AdminSessionClaims;
}

// ----- Kiosk token (largo plazo) -----

export async function signKioskToken(payload: {
  kioskId: string;
  kioskName: string;
}): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const jti = randomUUID();
  const expiresAt = new Date(
    Date.now() + config.JWT_KIOSK_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const token = await new SignJWT({
    kiosk_name: payload.kioskName,
    jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.kioskId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_KIOSK)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(SECRET);

  return { token, jti, expiresAt };
}

export async function verifyKioskToken(token: string): Promise<KioskClaims> {
  const { payload } = await jwtVerify(token, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE_KIOSK,
  });
  return payload as KioskClaims;
}

// ----- Patient session (corta duración) -----

export async function signPatientSession(payload: {
  dentalinkPatientId: string;
  /**
   * Kiosco de origen. Opcional desde el modelo web público (Hito A): las
   * sesiones iniciadas por la web no provienen de un kiosco físico y van con
   * kiosk_id = null en el claim y en patient_sessions.
   */
  kioskId?: string | null;
}): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const jti = randomUUID();
  const expiresAt = new Date(
    Date.now() + config.JWT_PATIENT_SESSION_TTL_MINUTES * 60 * 1000,
  );

  const token = await new SignJWT({
    kiosk_id: payload.kioskId ?? null,
    jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.dentalinkPatientId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_PATIENT)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(SECRET);

  return { token, jti, expiresAt };
}

export async function verifyPatientSession(token: string): Promise<PatientSessionClaims> {
  const { payload } = await jwtVerify(token, SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE_PATIENT,
  });
  return payload as PatientSessionClaims;
}

/**
 * Re-firma una sesión de paciente CONSERVANDO el mismo jti (sesión deslizante,
 * §10). A diferencia de signPatientSession, no genera un jti nuevo ni una fila
 * nueva: el llamador (POST /auth/refresh) actualiza expires_at de la fila
 * existente en patient_sessions. El máximo absoluto se ancla en created_at, que
 * no cambia entre refrescos.
 */
export async function refreshPatientSession(payload: {
  dentalinkPatientId: string;
  kioskId: string | null;
  jti: string;
  expiresAt: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = await new SignJWT({
    kiosk_id: payload.kioskId ?? null,
    jti: payload.jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.dentalinkPatientId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE_PATIENT)
    .setIssuedAt()
    .setExpirationTime(payload.expiresAt)
    .setJti(payload.jti)
    .sign(SECRET);

  return { token, expiresAt: payload.expiresAt };
}
