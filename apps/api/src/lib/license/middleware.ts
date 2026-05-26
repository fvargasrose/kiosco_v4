/**
 * Middleware de licencia — aplicado como hook onRequest global.
 *
 * Modos:
 *   normal      → todo pasa
 *   restrictive → solo GET pasa; PUT/POST/PATCH/DELETE → 503
 *   shutdown    → todo falla con 503, salvo /health/*
 *
 * En LICENSE_DEV_MODE=true el middleware siempre deja pasar (modo normal forzado).
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { getLicenseState, computeMode } from './cache.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HEALTH_PREFIX = '/health';
const PUBLIC_PREFIX = '/public/';

export async function licenseMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Activos públicos (logo de la clínica) siempre pasan — no contienen datos sensibles
  // y deben verse incluso si la licencia está apagada (sería confuso para el usuario).
  if (request.url.startsWith(PUBLIC_PREFIX)) return;

  // En dev mode no aplicamos restricciones
  if (config.LICENSE_DEV_MODE) return;

  // Las rutas de health siempre pasan — permiten monitorizar aunque la licencia esté apagada
  if (request.url.startsWith(HEALTH_PREFIX)) return;

  const state = await getLicenseState();

  // Sin estado en caché: el worker aún no corrió (poco probable después del arranque)
  // Dejamos pasar para no bloquear el primer request tras un reinicio muy rápido.
  if (!state) return;

  const mode = computeMode(state);

  if (mode === 'normal') return;

  if (mode === 'restrictive') {
    if (WRITE_METHODS.has(request.method)) {
      return reply.code(503).send({
        error: 'LICENSE_RESTRICTED',
        message: 'La licencia está en período de gracia. Solo se permiten operaciones de lectura. Contacta a soporte.',
      });
    }
    return; // GETs pasan en modo restrictivo
  }

  // mode === 'shutdown'
  return reply.code(503).send({
    error: 'LICENSE_EXPIRED',
    message: 'La licencia ha expirado o fue revocada. Contacta a tu proveedor.',
  });
}
