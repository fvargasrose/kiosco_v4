import type { FastifyInstance } from 'fastify';
import { db } from '../lib/db.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/health/ready', async (_req, reply) => {
    const dbStatus = await db.ping();
    reply.status(dbStatus.ok ? 200 : 503);
    return { status: dbStatus.ok ? 'ready' : 'not_ready', database: dbStatus };
  });
}
