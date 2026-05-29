/**
 * =============================================================================
 * Health route
 * =============================================================================
 *
 * Tres niveles de health check:
 *   GET /health         - Liveness (¿el proceso está vivo?) - solo 200/no
 *   GET /health/ready   - Readiness (¿puede atender requests?) - chequea deps
 *   GET /health/info    - Información detallada (versión, uptime, stats)
 *
 * Caddy y Docker usan /health para healthcheck.
 * Load balancers/orquestadores usan /health/ready.
 */

import type { FastifyInstance } from 'fastify';
import { config, features } from '../lib/config.js';
import { db } from '../lib/db.js';
import { redis } from '../lib/redis.js';

const startedAt = Date.now();

export async function healthRoute(app: FastifyInstance): Promise<void> {
  /**
   * Liveness probe - solo verifica que el proceso responde.
   * Si esto falla, el orquestador reinicia el contenedor.
   */
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  /**
   * Readiness probe - verifica que dependencias están operativas.
   * Si esto falla, el orquestador deja de enviar tráfico (sin reiniciar).
   */
  app.get('/health/ready', async (_request, reply) => {
    const [dbStatus, redisStatus] = await Promise.all([db.ping(), redis.ping()]);

    const ready = dbStatus.ok && redisStatus.ok;

    reply.status(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          ok: dbStatus.ok,
          latencyMs: dbStatus.latencyMs,
          error: dbStatus.error,
        },
        redis: {
          ok: redisStatus.ok,
          latencyMs: redisStatus.latencyMs,
          error: redisStatus.error,
        },
      },
    };
  });

  /**
   * Info detallada - útil para soporte y debugging.
   * Solo debería exponerse a admins en producción.
   * Hito 1: pública. En Hito 3 agregamos auth.
   */
  app.get('/health/info', async () => {
    const uptimeMs = Date.now() - startedAt;
    const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
    const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

    return {
      app: {
        version: config.APP_VERSION,
        environment: config.NODE_ENV,
        installation: config.INSTALLATION_ID,
        startedAt: new Date(startedAt).toISOString(),
        uptime: `${uptimeHours}h ${uptimeMinutes}m`,
        uptimeMs,
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      features: {
        wompi: features.wompiConfigured,
        dentalink: features.dentalinkConfigured,
        twilio: features.twilioConfigured,
        smtp: features.smtpConfigured,
        licenseDevMode: config.LICENSE_DEV_MODE,
        mockExternalServices: config.DEV_MOCK_EXTERNAL_SERVICES,
      },
      database: db.getStats(),
    };
  });
}
