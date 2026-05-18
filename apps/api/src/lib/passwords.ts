/**
 * =============================================================================
 * Password hashing con argon2id
 * =============================================================================
 *
 * Parámetros conservadores recomendados por OWASP (2024):
 *   - memory: 64 MB (65536 KB)
 *   - iterations: 3
 *   - parallelism: 4
 *
 * argon2id es resistente tanto a ataques GPU (argon2d) como side-channel (argon2i).
 */

import argon2 from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * Hashea un password. El salt se genera automáticamente.
 * El hash resultante incluye todos los parámetros, es self-describing.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext || plaintext.length < 8) {
    throw new Error('Password debe tener al menos 8 caracteres');
  }
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifica un password contra su hash.
 * Constant-time comparison. Resistente a timing attacks.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // Si el hash es inválido, retornamos false (no exponemos el error)
    return false;
  }
}

/**
 * Verifica si un hash necesita rehash (parámetros desactualizados).
 * Usar para migrar gradualmente cuando se aumentan los parámetros.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/**
 * Validación de fortaleza de password.
 * Reglas conservadoras:
 *   - Mínimo 10 caracteres
 *   - Al menos 1 mayúscula
 *   - Al menos 1 minúscula
 *   - Al menos 1 dígito
 *   - Al menos 1 carácter especial
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < 10) {
    errors.push('Mínimo 10 caracteres');
  }
  if (password.length > 128) {
    errors.push('Máximo 128 caracteres');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Al menos una mayúscula');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Al menos una minúscula');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Al menos un dígito');
  }
  // eslint-disable-next-line no-useless-escape
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) {
    errors.push('Al menos un carácter especial');
  }

  return { valid: errors.length === 0, errors };
}
