import 'dotenv/config';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';

import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { db } from './lib/db.js';
import { healthRoutes } from './routes/health.js';
import { validateRoutes } from './routes/validate.js';
import { heartbeatRoutes } from './routes/heartbeat.js';
import { manageRoutes } from './routes/manage.js';

export async function buildServer() {
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 64 * 1024, // 64 KB — no necesitamos más
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
  });

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: false });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, url: request.url }, 'Request error');
    const status = error.statusCode ?? 500;
    return reply.status(status).send({
      error: status >= 500 ? 'INTERNAL_ERROR' : (error.code ?? 'REQUEST_ERROR'),
      ...(config.NODE_ENV !== 'production' && { message: error.message }),
    });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: 'NOT_FOUND' }),
  );

  await app.register(healthRoutes);
  await app.register(validateRoutes);
  await app.register(heartbeatRoutes);
  await app.register(manageRoutes);

  app.addHook('onClose', async () => { await db.close(); });

  return app;
}

async function start() {
  let app: Awaited<ReturnType<typeof buildServer>> | null = null;
  try {
    app = await buildServer();
    await db.ping();
    logger.info('Database connection OK');

    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'License server ready');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start license server');
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    try { if (app) await app.close(); process.exit(0); }
    catch (err) { logger.error({ err }, 'Error during shutdown'); process.exit(1); }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => { logger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
  process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'Unhandled rejection'); process.exit(1); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void start();
}
