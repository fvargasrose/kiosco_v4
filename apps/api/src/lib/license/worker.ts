/**
 * Worker de licencia — mismo patrón que reconciler.ts.
 *
 * Ciclo:
 *   - Al arrancar: validate() inmediato → cachea estado en Redis
 *   - Cada LICENSE_HEARTBEAT_INTERVAL_HOURS: sendHeartbeat()
 *     · Si OK: actualiza last_successful_heartbeat_at en caché
 *     · Si falla: no modifica la caché (el modo se degrada solo con el tiempo)
 *   - Cuando se restablece contacto: la caché se actualiza y el modo vuelve a normal
 */

import { config } from '../config.js';
import { logger } from '../logger.js';
import { validateLicense, sendHeartbeat } from './client.js';
import { getLicenseState, setLicenseState, computeMode, type LicenseState } from './cache.js';

const INTERVAL_MS = config.LICENSE_HEARTBEAT_INTERVAL_HOURS * 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export async function startLicenseWorker(): Promise<void> {
  if (config.LICENSE_DEV_MODE) {
    logger.info('License worker disabled (LICENSE_DEV_MODE=true)');
    return;
  }

  // Validate inmediato al arranque — bloquea hasta obtener respuesta o fallar
  await runValidate();

  intervalHandle = setInterval(() => {
    runHeartbeat().catch((err) => logger.error({ err }, 'License heartbeat cycle threw'));
  }, INTERVAL_MS);

  logger.info({ intervalHours: config.LICENSE_HEARTBEAT_INTERVAL_HOURS }, 'License worker started');
}

export function stopLicenseWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('License worker stopped');
  }
}

async function runValidate(): Promise<void> {
  try {
    const result = await validateLicense();
    const now = new Date().toISOString();
    const state: LicenseState = {
      valid: result.valid,
      status: result.status,
      clinic_name: result.clinic_name,
      plan: result.plan,
      features: result.features,
      expires_at: result.expires_at,
      last_successful_heartbeat_at: now,
      cached_at: now,
    };
    await setLicenseState(state);
    const mode = computeMode(state);
    logger.info({ mode, valid: result.valid, plan: result.plan }, 'License validated');
  } catch (err) {
    logger.warn({ err }, 'License validation failed — checking cached state');

    const cached = await getLicenseState();
    if (!cached) {
      // Sin caché y sin contacto: arrancar en modo shutdown como medida de seguridad
      // solo si no hay estado previo en absoluto. En la práctica, una instalación
      // recién instalada siempre tiene conectividad en el primer arranque.
      logger.error('No cached license state and server unreachable — system will start in shutdown mode');
      const fallback: LicenseState = {
        valid: false,
        status: 'unknown',
        clinic_name: 'unknown',
        plan: 'unknown',
        features: [],
        expires_at: new Date(0).toISOString(),
        last_successful_heartbeat_at: new Date(0).toISOString(),
        cached_at: new Date().toISOString(),
      };
      await setLicenseState(fallback);
    } else {
      const mode = computeMode(cached);
      logger.warn({ mode, last_heartbeat: cached.last_successful_heartbeat_at }, 'Using cached license state');
    }
  }
}

async function runHeartbeat(): Promise<void> {
  try {
    const result = await sendHeartbeat();
    const cached = await getLicenseState();
    const now = new Date().toISOString();

    const updated: LicenseState = {
      ...(cached ?? {
        valid: result.mode !== 'shutdown',
        status: 'active',
        clinic_name: 'unknown',
        plan: 'unknown',
        features: [],
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        cached_at: now,
      }),
      last_successful_heartbeat_at: now,
      cached_at: now,
    };

    await setLicenseState(updated);
    const mode = computeMode(updated);
    logger.info({ mode }, 'License heartbeat OK');
  } catch (err) {
    logger.warn({ err }, 'License heartbeat failed — mode will degrade with time if contact is not restored');
  }
}
