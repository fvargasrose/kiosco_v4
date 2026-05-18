/**
 * =============================================================================
 * TOTP - Time-based One-Time Password (RFC 6238)
 * =============================================================================
 *
 * Compatible con Google Authenticator, Microsoft Authenticator, Authy, etc.
 *
 * Parámetros estándar:
 *   - Algoritmo: SHA1 (default de Google Authenticator)
 *   - Dígitos: 6
 *   - Ventana: 30 segundos
 *   - Tolerancia: ±30s (epochTolerance)
 */

import { generateSecret, verifySync, generateURI } from 'otplib';
import QRCode from 'qrcode';
import { randomBytes, createHash } from 'crypto';

const TOTP_PERIOD = 30; // segundos
const TOTP_EPOCH_TOLERANCE = 30; // ±30s tolerancia de skew

/**
 * Genera un secret TOTP nuevo (Base32, ~32 caracteres).
 */
export function generateTotpSecret(): string {
  return generateSecret({ length: 20 }); // 20 bytes = 160 bits
}

/**
 * Genera la URL otpauth:// para escanear con el app authenticator.
 */
export function buildOtpauthUrl(secret: string, email: string, issuer = 'DentalKiosco'): string {
  return generateURI({
    strategy: 'totp',
    secret,
    label: email,
    issuer,
    algorithm: 'sha1',
    digits: 6,
    period: TOTP_PERIOD,
  });
}

/**
 * Genera un QR code PNG (data URL) para mostrar al usuario en el enrollment.
 */
export async function generateTotpQrCode(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8,
  });
}

/**
 * Verifica un código TOTP. Resistente a timing attacks (verifySync usa
 * constant-time comparison internamente).
 * Acepta tolerancia de ±30s para clock skew.
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  if (!code || !/^\d{6}$/.test(code)) {
    return false;
  }
  try {
    const result = verifySync({
      strategy: 'totp',
      secret,
      token: code,
      algorithm: 'sha1',
      digits: 6,
      period: TOTP_PERIOD,
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    });
    return result.valid === true;
  } catch {
    return false;
  }
}

/**
 * Genera códigos de respaldo (recovery codes).
 * 10 códigos de 10 caracteres en formato XXXXX-XXXXX.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(8);
    const code = bytes.toString('hex').toUpperCase().substring(0, 10);
    codes.push(`${code.substring(0, 5)}-${code.substring(5, 10)}`);
  }
  return codes;
}

/**
 * Hashea un código de recovery (SHA256, alta entropía).
 */
export function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/-/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}
