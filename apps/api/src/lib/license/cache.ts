/**
 * Estado de licencia en Redis.
 *
 * La clave persiste 30 días para sobrevivir reinicios del proceso.
 * El MODO se computa dinámicamente a partir de last_successful_heartbeat_at
 * para que refleje el tiempo real transcurrido, no el instante en que se escribió.
 */

import { redis } from '../redis.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const REDIS_KEY = 'license:state';
const TTL_SECONDS = 30 * 24 * 3600; // 30 días

export type LicenseMode = 'normal' | 'restrictive' | 'shutdown';

export interface LicenseState {
  valid: boolean;
  status: string;                      // 'active' | 'suspended' | 'revoked'
  clinic_name: string;
  plan: string;
  features: string[];
  expires_at: string;                  // ISO
  last_successful_heartbeat_at: string; // ISO — se usa para computar el modo
  cached_at: string;                   // ISO
}

/** Calcula el modo actual a partir del tiempo sin heartbeat exitoso. */
export function computeMode(state: LicenseState): LicenseMode {
  if (!state.valid || state.status !== 'active') return 'shutdown';

  const lastHeartbeat = new Date(state.last_successful_heartbeat_at).getTime();
  const elapsedDays = (Date.now() - lastHeartbeat) / (1000 * 60 * 60 * 24);

  if (elapsedDays >= config.LICENSE_SHUTDOWN_PERIOD_DAYS) return 'shutdown';
  if (elapsedDays >= config.LICENSE_GRACE_PERIOD_DAYS) return 'restrictive';
  return 'normal';
}

export async function getLicenseState(): Promise<LicenseState | null> {
  try {
    const raw = await redis.get(REDIS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LicenseState;
  } catch (err) {
    logger.error({ err }, 'Error reading license state from Redis');
    return null;
  }
}

export async function setLicenseState(state: LicenseState): Promise<void> {
  try {
    await redis.set(REDIS_KEY, JSON.stringify(state), TTL_SECONDS);
  } catch (err) {
    logger.error({ err }, 'Error writing license state to Redis');
  }
}

export async function clearLicenseState(): Promise<void> {
  await redis.del(REDIS_KEY);
}
