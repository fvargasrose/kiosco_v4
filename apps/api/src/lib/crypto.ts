/**
 * =============================================================================
 * Crypto - Cifrado simétrico delegado a Postgres pgcrypto
 * =============================================================================
 *
 * Toda la criptografía de "datos en reposo" se delega a Postgres pgcrypto
 * (las funciones fn_encrypt/fn_decrypt definidas en migration 001).
 *
 * Ventajas:
 *   - Single source of truth (no hay app que pueda confundirse de algoritmo)
 *   - El cifrado/descifrado ocurre dentro de la BD
 *   - La key se pasa via SET LOCAL (no se transfiere por red)
 *
 * Estos helpers solo orquestan llamadas.
 */

import { db } from './db.js';
import { config } from './config.js';

/**
 * Cifra un valor texto plano usando la encryption key del entorno.
 * Retorna un Buffer (BYTEA en Postgres).
 *
 * Uso típico:
 *   const encrypted = await encrypt('mi_token_dentalink');
 *   await db.query('UPDATE clinic SET dentalink_token_encrypted = $1', [encrypted]);
 */
export async function encrypt(plaintext: string | null): Promise<Buffer | null> {
  if (plaintext === null || plaintext === '') return null;

  // Usamos un client dedicado para poder hacer SET LOCAL en transacción
  return await db.transaction(async (client) => {
    // SET LOCAL no acepta param binding; escapamos validando que no haya quotes
    if (config.ENCRYPTION_KEY.includes("'")) {
      throw new Error('ENCRYPTION_KEY contiene comillas, configuración inválida');
    }
    await client.query(`SET LOCAL app.encryption_key = '${config.ENCRYPTION_KEY}'`);
    const result = await client.query<{ encrypted: Buffer }>(
      `SELECT fn_encrypt($1) AS encrypted`,
      [plaintext],
    );
    return result.rows[0]?.encrypted ?? null;
  });
}

/**
 * Descifra un BYTEA con la encryption key del entorno.
 */
export async function decrypt(encrypted: Buffer | null): Promise<string | null> {
  if (!encrypted) return null;

  return await db.transaction(async (client) => {
    if (config.ENCRYPTION_KEY.includes("'")) {
      throw new Error('ENCRYPTION_KEY contiene comillas, configuración inválida');
    }
    await client.query(`SET LOCAL app.encryption_key = '${config.ENCRYPTION_KEY}'`);
    const result = await client.query<{ decrypted: string }>(
      `SELECT fn_decrypt($1::bytea) AS decrypted`,
      [encrypted],
    );
    return result.rows[0]?.decrypted ?? null;
  });
}
