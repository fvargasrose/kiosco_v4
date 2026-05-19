/**
 * =============================================================================
 * DentalKiosco API - Servidor principal
 * =============================================================================
 *
 * Hito 1: solo levanta el servidor con /health funcional.
 * Los demás endpoints se agregan en hitos posteriores.
 */

import 'dotenv/config';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { db } from './lib/db.js';
import { redis } from './lib/redis.js';
import { healthRoute } from './routes/health.js';
import { adminAuthRoutes } from './routes/admin-auth.js';
import { patientAuthRoutes } from './routes/patient-auth.js';
import { patientMeRoutes } from './routes/patient-me.js';
import { kioskRoutes } from './routes/kiosk.js';
import { paymentsRoutes } from './routes/payments.js';
import { bookingRoutes } from './routes/booking.js';
import { adminClinicRoutes } from './routes/admin-clinic.js';
import { patientRegisterRoutes } from './routes/patient-register.js';
import { adminDentistRoutes } from './routes/admin-dentists.js';
import { startReconciler, stopReconciler } from './lib/reconciler.js';

/**
 * Construye e inicializa el servidor Fastify.
 * Separado para facilitar testing.
 */
export async function buildServer() {
  const app = Fastify({
    logger,
    trustProxy: true, // Estamos detrás de Caddy
    bodyLimit: 1024 * 1024, // 1 MB por defecto
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    disableRequestLogging: false,
  });

  // Plugins de seguridad y utilidades
  await app.register(sensible);

  await app.register(helmet, {
    contentSecurityPolicy: false, // Lo maneja Caddy
  });

  await app.register(cors, {
    origin: false, // Mismo origen (servido por Caddy)
    credentials: true,
  });

  // Multipart para subida de archivos del admin (standby GIF/video)
  await app.register(multipart, {
    limits: {
      fileSize: config.UPLOADS_MAX_BYTES,
      files: 1,
    },
  });

  // Manejador global de errores
  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      {
        err: error,
        url: request.url,
        method: request.method,
      },
      'Request error',
    );

    if (error.validation) {
      return reply.status(400).send({
        error: 'INVALID_INPUT',
        details: error.validation,
      });
    }

    const status = error.statusCode ?? 500;
    return reply.status(status).send({
      error: status >= 500 ? 'INTERNAL_ERROR' : error.code ?? 'REQUEST_ERROR',
      // En desarrollo mostramos detalle; en prod no
      ...(config.NODE_ENV === 'development' && { message: error.message }),
    });
  });

  // Manejador 404
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: 'NOT_FOUND',
      path: request.url,
    });
  });

  // ----- Rutas -----
  await app.register(healthRoute);
  await app.register(adminAuthRoutes);
  await app.register(patientAuthRoutes);
  await app.register(patientMeRoutes);
  await app.register(kioskRoutes);
  await app.register(paymentsRoutes);
  await app.register(bookingRoutes);
  await app.register(adminClinicRoutes);
  await app.register(patientRegisterRoutes);
  await app.register(adminDentistRoutes);

  // Hook de cierre limpio
  app.addHook('onClose', async () => {
    await Promise.all([db.close(), redis.quit()]);
  });

  return app;
}

/**
 * Arranca el servidor. Maneja errores de inicio y shutdown graceful.
 */
async function start() {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;

  try {
    app = await buildServer();

    // Verificar conexiones críticas antes de aceptar tráfico
    await db.ping();
    await redis.ping();
    logger.info('Database and Redis connections OK');

    await app.listen({
      port: config.API_PORT,
      host: '0.0.0.0',
    });

    // Hito 8: arrancar el reconciliador de pagos
    startReconciler();

    logger.info(
      {
        port: config.API_PORT,
        env: config.NODE_ENV,
        version: config.APP_VERSION,
      },
      'DentalKiosco API ready',
    );
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }

  // Shutdown graceful
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    try {
      stopReconciler();
      if (app) await app.close();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Errores no manejados → log y exit
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });
}

// Arrancar solo si este archivo se ejecuta directamente
// (permite importar buildServer para tests sin arrancar)
if (import.meta.url === `file://${process.argv[1]}`) {
  void start();
}
