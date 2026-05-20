/**
 * =============================================================================
 * setup.ts — CLI de configuración inicial
 * =============================================================================
 *
 * Uso (dentro del contenedor, llamado por el installer):
 *   node dist/setup.js create-admin --email X --password Y --name Z [--role admin|viewer]
 *
 * Idempotente: si el email ya existe, no hace nada (ON CONFLICT DO NOTHING).
 */

import 'dotenv/config';
import pg from 'pg';
import { hashPassword } from './lib/passwords.js';
import { config } from './lib/config.js';

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key !== undefined && val !== undefined && key.startsWith('--')) {
      result[key.slice(2)] = val;
      i++;
    }
  }
  return result;
}

async function createAdmin(args: Record<string, string>): Promise<void> {
  const { email, password, name, role = 'admin' } = args;

  if (!email || !password || !name) {
    console.error('Error: --email, --password y --name son requeridos');
    process.exit(1);
  }

  if (!['admin', 'viewer'].includes(role)) {
    console.error('Error: --role debe ser "admin" o "viewer"');
    process.exit(1);
  }

  if (password.length < 12) {
    console.error('Error: --password debe tener al menos 12 caracteres');
    process.exit(1);
  }

  const hash = await hashPassword(password);

  const pool = new pg.Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    database: config.POSTGRES_DB,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    ssl: false,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const result = await pool.query(
      `INSERT INTO admins (email, password_hash, full_name, role, mfa_required, must_change_password)
       VALUES ($1, $2, $3, $4, false, true)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, full_name, role`,
      [email.toLowerCase().trim(), hash, name.trim(), role],
    );

    if ((result.rowCount ?? 0) === 0) {
      console.log(`Admin ${email} ya existe — sin cambios.`);
    } else {
      const row = result.rows[0];
      console.log(`Admin creado: ${row.email} (${row.role}) id=${row.id}`);
      console.log('must_change_password=true — el admin deberá cambiar la contraseña en el primer login.');
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'create-admin':
      await createAdmin(args);
      break;
    default:
      console.error(`Comando desconocido: ${command}`);
      console.error('Comandos disponibles: create-admin');
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
