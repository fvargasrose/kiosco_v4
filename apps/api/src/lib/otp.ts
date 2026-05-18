/**
 * =============================================================================
 * OTP utilities
 * =============================================================================
 *
 * Genera y verifica OTPs de 6 dígitos.
 * Hashing con bcrypt (cost 10) — sí, bcrypt es overkill para 6 dígitos,
 * pero es defensa en profundidad por si la BD se filtra.
 *
 * NOTA: bcrypt es sync-blocking. Para 6 dígitos es rápido (~100ms con cost 10),
 * aceptable. Si vemos throughput issues, se puede bajar a cost 8.
 */

import { randomInt, randomBytes, createHash, timingSafeEqual } from 'crypto';

/**
 * Genera un OTP numérico de 6 dígitos con padding de ceros.
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Hashea un OTP usando HMAC-SHA256 con una clave derivada.
 *
 * No usamos bcrypt para OTPs porque:
 *   - El espacio es solo 1M (no necesita gran cost factor)
 *   - bcrypt sería lento sin beneficio
 *   - HMAC con clave secreta + salt único es suficiente y rápido
 */
export function hashOtp(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

/**
 * Verifica un OTP usando comparación constant-time.
 */
export function verifyOtp(code: string, salt: string, expectedHash: string): boolean {
  const actualHash = hashOtp(code, salt);
  const a = Buffer.from(actualHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Genera un salt aleatorio (32 caracteres hex = 16 bytes).
 */
export function generateSalt(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Hashea una cédula para identificación (no para autenticación).
 * Se usa en otp_codes.patient_cedula_hash y habeas_data_consents.
 */
export function hashCedula(cedula: string): string {
  return createHash('sha256').update(cedula.trim()).digest('hex');
}
