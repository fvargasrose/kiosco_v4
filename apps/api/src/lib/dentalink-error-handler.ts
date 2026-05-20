/**
 * Mapper compartido de DentalinkError → respuestas HTTP.
 * Usado por todas las rutas que llaman a Dentalink.
 */

import { DentalinkError } from './dentalink.js';
import { logger } from './logger.js';

type ReplyLike = {
  code(c: number): { send(b: object): unknown };
};

export function handleDentalinkError(err: unknown, reply: ReplyLike): unknown {
  if (err instanceof DentalinkError) {
    if (err.code === 'TIMEOUT') {
      return reply.code(504).send({
        error: 'UPSTREAM_TIMEOUT',
        message: 'El sistema de gestión está tardando en responder. Por favor intenta de nuevo.',
      });
    }
    if (err.code === 'UNAUTHORIZED') {
      logger.error({ err }, 'Dentalink token rejected - clinic config issue');
      return reply.code(503).send({
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'Servicio temporalmente no disponible. Contacte a recepción.',
      });
    }
    if (err.code === 'NOT_FOUND') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    if (err.code === 'CONFLICT') {
      return reply.code(409).send({
        error: 'CONFLICT',
        message: err.message,
      });
    }
    if (err.code === 'BAD_REQUEST') {
      logger.error({ upstreamBody: err.upstreamBody, status: err.status }, 'Dentalink BAD_REQUEST');
      return reply.code(400).send({
        error: 'BAD_REQUEST',
        message: 'La operación no fue aceptada por el sistema de gestión.',
      });
    }
    logger.error({ code: err.code, status: err.status, upstreamBody: err.upstreamBody }, 'Dentalink error');
    return reply.code(503).send({
      error: 'UPSTREAM_ERROR',
      message: 'Error al consultar el sistema de gestión.',
    });
  }
  logger.error({ err }, 'Unexpected error in route handler');
  return reply.code(500).send({ error: 'INTERNAL' });
}
