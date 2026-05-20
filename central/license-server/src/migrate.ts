import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import pg from 'pg';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface Migration { version: string; name: string; filename: string; sql: string; checksum: string; }
interface AppliedMigration { version: string; name: string; applied_at: Date; checksum: string | null; duration_ms: number | null; }

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && /^\d{3}_/.test(f))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const match = filename.match(/^(\d{3})_(.+)\.sql$/);
      if (!match) throw new Error(`Formato inválido: ${filename}`);
      return { version: match[1]!, name: match[2]!, filename, sql, checksum };
    });
}

async function getApplied(client: pg.PoolClient): Promise<Map<string, AppliedMigration>> {
  const tableExists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations') AS exists`,
  );
  if (!tableExists.rows[0]?.exists) return new Map();
  const result = await client.query<AppliedMigration>(
    `SELECT version, name, applied_at, checksum, duration_ms FROM schema_migrations ORDER BY version`,
  );
  return new Map(result.rows.map((r) => [r.version, r]));
}

async function applyMigration(client: pg.PoolClient, m: Migration): Promise<void> {
  const start = Date.now();
  await client.query('BEGIN');
  try {
    await client.query(m.sql);
    await client.query(
      `UPDATE schema_migrations SET checksum = $1, duration_ms = $2 WHERE version = $3`,
      [m.checksum, Date.now() - start, m.version],
    );
    await client.query('COMMIT');
    logger.info({ version: m.version, name: m.name }, `✓ Aplicada`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

function makePool() {
  return new pg.Pool({
    host: config.POSTGRES_HOST, port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB, user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
  });
}

async function cmdUp() {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const all = loadMigrations();
    const applied = await getApplied(client);
    for (const m of all) {
      const a = applied.get(m.version);
      if (a?.checksum && a.checksum !== m.checksum) {
        throw new Error(`Migración ${m.version} fue modificada después de aplicarse.`);
      }
    }
    const pending = all.filter((m) => !applied.has(m.version));
    if (pending.length === 0) { logger.info('No hay migraciones pendientes'); return; }
    for (const m of pending) await applyMigration(client, m);
    logger.info(`✓ ${pending.length} migración(es) aplicada(s)`);
  } finally { client.release(); await pool.end(); }
}

async function cmdStatus() {
  const pool = makePool();
  const client = await pool.connect();
  try {
    const all = loadMigrations();
    const applied = await getApplied(client);
    console.log('\n=== Estado de migraciones ===\n');
    for (const m of all) {
      const a = applied.get(m.version);
      console.log(`  ${a ? '✓' : '○'}  ${m.version}_${m.name.padEnd(20)} ${a ? new Date(a.applied_at).toISOString() : '-'}`);
    }
    console.log(`\nTotal: ${all.length}, Aplicadas: ${applied.size}, Pendientes: ${all.length - applied.size}\n`);
  } finally { client.release(); await pool.end(); }
}

const cmd = process.argv[2] ?? 'up';
try {
  if (cmd === 'up') await cmdUp();
  else if (cmd === 'status') await cmdStatus();
  else { console.error(`Comando desconocido: ${cmd}`); process.exit(1); }
  process.exit(0);
} catch (err) {
  logger.fatal({ err }, 'Migration failed');
  process.exit(1);
}
