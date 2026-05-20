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
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
    });

    this.pool.on('error', (err) => logger.error({ err }, 'Postgres pool error'));
  }

  async ping(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      this.ready = true;
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      this.ready = false;
      return { ok: false, latencyMs: Date.now() - start, error: String(err) };
    }
  }

  isReady() { return this.ready; }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    try {
      return await this.pool.query<T>(text, params as never);
    } catch (err) {
      logger.error({ err, query: text }, 'Query error');
      throw err;
    }
  }

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

  async close() {
    logger.info('Closing Postgres pool');
    await this.pool.end();
  }
}

export const db = new Database();
