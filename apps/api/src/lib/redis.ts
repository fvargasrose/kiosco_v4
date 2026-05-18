/**
 * =============================================================================
 * Redis - Cliente ioredis
 * =============================================================================
 *
 * Usado para:
 *   - Rate limiting
 *   - Caché de validación de licencia
 *   - Sesiones efímeras
 *   - Colas BullMQ
 */

import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

class RedisClient {
  private client: Redis;
  private ready = false;

  constructor() {
    this.client = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: config.REDIS_PASSWORD,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times) => {
        if (times > 10) {
          logger.error('Redis: too many retries, giving up');
          return null;
        }
        return Math.min(times * 200, 3000);
      },
    });

    this.client.on('connect', () => {
      logger.info('Redis connected');
    });

    this.client.on('ready', () => {
      this.ready = true;
      logger.info('Redis ready');
    });

    this.client.on('error', (err) => {
      this.ready = false;
      logger.error({ err: err.message }, 'Redis error');
    });

    this.client.on('close', () => {
      this.ready = false;
      logger.warn('Redis connection closed');
    });
  }

  /**
   * Verifica conectividad. Usar en /health.
   */
  async ping(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const result = await this.client.ping();
      const ok = result === 'PONG';
      return { ok, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Expone el cliente directamente para operaciones avanzadas
   * (BullMQ lo necesita).
   */
  getClient(): Redis {
    return this.client;
  }

  // Wrappers convenientes
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<'OK'> {
    if (ttlSeconds) {
      return this.client.set(key, value, 'EX', ttlSeconds);
    }
    return this.client.set(key, value);
  }

  async del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  async incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    return this.client.expire(key, ttlSeconds);
  }

  async quit(): Promise<void> {
    logger.info('Closing Redis connection');
    await this.client.quit();
  }
}

export const redis = new RedisClient();
