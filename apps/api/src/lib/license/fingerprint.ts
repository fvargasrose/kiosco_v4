/**
 * Huella de máquina — identifica de forma estable esta instalación.
 *
 * Fuentes en orden de preferencia:
 *   1. /etc/machine-id  (Linux estable, persiste entre reinicios)
 *   2. INSTALLATION_ID del .env  (útil en Docker donde machine-id puede cambiar)
 *   3. hostname como último recurso
 *
 * El installation_id es determinístico: hash(LICENSE_KEY + fingerprint).
 * No necesita almacenamiento porque siempre produce el mismo valor.
 */

import { readFileSync } from 'fs';
import { hostname } from 'os';
import { createHash } from 'crypto';
import { config } from '../config.js';

function readMachineId(): string {
  try {
    return readFileSync('/etc/machine-id', 'utf8').trim();
  } catch {
    return '';
  }
}

export function getMachineFingerprint(): string {
  const parts = [
    readMachineId(),
    config.INSTALLATION_ID,  // estable en Docker si se define en .env
    hostname(),
  ].filter(Boolean);

  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** ID único de esta instalación — derivado de licencia + huella, sin almacenamiento. */
export function getInstallationId(): string {
  const fingerprint = getMachineFingerprint();
  return createHash('sha256')
    .update(`${config.LICENSE_KEY}:${fingerprint}`)
    .digest('hex')
    .slice(0, 32);
}
