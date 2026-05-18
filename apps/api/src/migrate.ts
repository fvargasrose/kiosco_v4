/**
 * =============================================================================
 * Migration runner - Aplica migraciones SQL versionadas
 * =============================================================================
 *
 * Diseño:
 *   - Lee archivos .sql del directorio migrations/ ordenados por nombre
 *   - Verifica cuáles ya están aplicados via tabla schema_migrations
 *   - Aplica los pendientes en orden, dentro de transacciones
 *   - Calcula checksum SHA256 de cada migración para detectar modificaciones
 *   - Falla rápido si una migración previa fue modificada
 *
 * Uso:
 *   tsx src/migrate.ts up          - aplica pendientes
 *   tsx src/migrate.ts status      - muestra estado
 *   tsx src/migrate.ts verify      - verifica checksums
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import pg from 'pg';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface Migration {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

interface AppliedMigration {
  version: string;
  name: string;
  applied_at: Date;
  checksum: string | null;
  duration_ms: number | null;
}

/**
 * Carga todas las migraciones del directorio.
 * Formato esperado: NNN_descripcion.sql donde NNN es número de 3 dígitos.
 */
function loadMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && /^\d{3}_/.test(f))
    .sort();

  return files.map((filename) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const match = filename.match(/^(\d{3})_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Formato inválido de migración: ${filename}`);
    }
    return {
      version: match[1]!,
      name: match[2]!,
      filename,
      sql,
      checksum,
    };
  });
}

/**
 * Obtiene migraciones ya aplicadas (si la tabla existe).
 */
async function getApplied(client: pg.PoolClient): Promise<Map<string, AppliedMigration>> {
  // Verificar si la tabla existe
  const tableExists = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'schema_migrations'
    ) AS exists`,
  );

  if (!tableExists.rows[0]?.exists) {
    return new Map();
  }

  const result = await client.query<AppliedMigration>(
    `SELECT version, name, applied_at, checksum, duration_ms
     FROM schema_migrations
     ORDER BY version`,
  );

  return new Map(result.rows.map((r) => [r.version, r]));
}

/**
 * Aplica una migración dentro de una transacción.
 */
async function applyMigration(client: pg.PoolClient, m: Migration): Promise<void> {
  const start = Date.now();

  await client.query('BEGIN');
  try {
    // Setear encryption key si está disponible (algunas migraciones la necesitan)
    // SET LOCAL no acepta parameter binding, así que escapamos manualmente
    if (config.ENCRYPTION_KEY) {
      // Validar que no contenga comillas simples (las generamos nosotros, deberían ser safe)
      if (config.ENCRYPTION_KEY.includes("'")) {
        throw new Error('ENCRYPTION_KEY no debe contener comillas simples');
      }
      await client.query(`SET LOCAL app.encryption_key = '${config.ENCRYPTION_KEY}'`);
    }

    // Ejecutar SQL
    await client.query(m.sql);

    // Actualizar checksum y duración (si la migración insertó el row)
    const duration = Date.now() - start;
    await client.query(
      `UPDATE schema_migrations
       SET checksum = $1, duration_ms = $2
       WHERE version = $3`,
      [m.checksum, duration, m.version],
    );

    await client.query('COMMIT');

    logger.info(
      { version: m.version, name: m.name, durationMs: duration },
      `✓ Aplicada: ${m.version}_${m.name}`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function cmdUp() {
  const pool = new pg.Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
  });

  const client = await pool.connect();
  try {
    const all = loadMigrations();
    const applied = await getApplied(client);

    logger.info(
      { total: all.length, applied: applied.size, pending: all.length - applied.size },
      'Estado de migraciones',
    );

    // Verificar que las ya aplicadas no han sido modificadas
    for (const m of all) {
      const a = applied.get(m.version);
      if (a && a.checksum && a.checksum !== m.checksum) {
        throw new Error(
          `Migración ${m.version}_${m.name} fue modificada después de aplicarse.\n` +
            `  Aplicada: ${a.checksum}\n` +
            `  Actual:   ${m.checksum}\n` +
            `  Las migraciones aplicadas son inmutables. Crea una nueva migración.`,
        );
      }
    }

    // Aplicar pendientes
    const pending = all.filter((m) => !applied.has(m.version));
    if (pending.length === 0) {
      logger.info('No hay migraciones pendientes');
      return;
    }

    for (const m of pending) {
      await applyMigration(client, m);
    }

    logger.info(`✓ ${pending.length} migración(es) aplicada(s) exitosamente`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function cmdStatus() {
  const pool = new pg.Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
  });

  const client = await pool.connect();
  try {
    const all = loadMigrations();
    const applied = await getApplied(client);

    console.log('\n=== Estado de migraciones ===\n');
    for (const m of all) {
      const a = applied.get(m.version);
      const status = a ? '✓ aplicada' : '○ pendiente';
      const when = a ? new Date(a.applied_at).toISOString() : '-';
      const dur = a?.duration_ms ? `${a.duration_ms}ms` : '-';
      console.log(`  ${status}  ${m.version}_${m.name.padEnd(30)} ${when}  ${dur}`);
    }

    console.log(`\nTotal: ${all.length}, Aplicadas: ${applied.size}, Pendientes: ${all.length - applied.size}\n`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function cmdVerify() {
  const pool = new pg.Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
  });

  const client = await pool.connect();
  try {
    const all = loadMigrations();
    const applied = await getApplied(client);

    let allOk = true;
    for (const m of all) {
      const a = applied.get(m.version);
      if (!a) continue;
      if (!a.checksum) {
        console.log(`  ⚠ ${m.version}_${m.name}: sin checksum registrado`);
        continue;
      }
      if (a.checksum === m.checksum) {
        console.log(`  ✓ ${m.version}_${m.name}`);
      } else {
        console.log(`  ✗ ${m.version}_${m.name}: CHECKSUM DIFIERE`);
        console.log(`     BD:     ${a.checksum}`);
        console.log(`     Disco:  ${m.checksum}`);
        allOk = false;
      }
    }

    if (!allOk) {
      console.error('\n✗ Hay migraciones con checksum modificado. Revisa el código.');
      process.exit(1);
    }
    console.log('\n✓ Todas las migraciones aplicadas tienen checksum válido');
  } finally {
    client.release();
    await pool.end();
  }
}

const cmd = process.argv[2] || 'up';

try {
  switch (cmd) {
    case 'up':
      await cmdUp();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'verify':
      await cmdVerify();
      break;
    default:
      console.error(`Comando desconocido: ${cmd}`);
      console.error('Uso: tsx src/migrate.ts [up|status|verify]');
      process.exit(1);
  }
  process.exit(0);
} catch (err) {
  logger.fatal({ err }, 'Migration failed');
  process.exit(1);
}
