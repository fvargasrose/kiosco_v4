/**
 * =============================================================================
 * DB - Pool de conexiones PostgreSQL
 * =============================================================================
 */

import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

class Database {
  private pool: pg.Pool;
  private ready = false;

  constructor() {
    this.pool = new Pool({
      host: config.POSTGRES_HOST,
      port: config.POSTGRES_PORT,
      database: config.POSTGRES_DB,
      user: config.POSTGRES_USER,
      password: config.POSTGRES_PASSWORD,
      max: 10, // máximo conexiones simultáneas
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // SSL: requerido en producción, opcional en local
      ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
    });

    this.pool.on('error', (err) => {
      logger.error({ err }, 'Postgres pool error');
    });

    this.pool.on('connect', () => {
      logger.debug('Postgres new connection established');
    });
  }

  /**
   * Verifica conectividad. Usar al arranque y en /health.
   */
  async ping(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const result = await this.pool.query('SELECT 1 AS ok');
      this.ready = result.rows[0]?.ok === 1;
      return { ok: this.ready, latencyMs: Date.now() - start };
    } catch (err) {
      this.ready = false;
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
   * Ejecuta query con parámetros (PARAMETRIZED, jamás interpolar strings).
   */
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    const start = Date.now();
    try {
      const result = await this.pool.query<T>(text, params as never);
      const duration = Date.now() - start;
      if (duration > 1000) {
        logger.warn({ query: text, durationMs: duration }, 'Slow query detected');
      }
      return result;
    } catch (err) {
      logger.error(
        {
          err,
          query: text,
          // NO loguear params si pueden contener secretos
        },
        'Query error',
      );
      throw err;
    }
  }

  /**
   * Ejecuta una transacción. Maneja BEGIN/COMMIT/ROLLBACK automáticamente.
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    logger.info('Closing Postgres pool');
    await this.pool.end();
  }

  getStats() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }
}

export const db = new Database();
