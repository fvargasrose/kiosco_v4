import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().default('dk_licenses'),
  POSTGRES_USER: z.string().default('dk_licenses'),
  POSTGRES_PASSWORD: z.string().min(1, 'POSTGRES_PASSWORD requerido'),

  // Clave de superadmin — autentica endpoints de gestión.
  // Generar con: openssl rand -hex 32
  SUPERADMIN_API_KEY: z.string().min(32, 'SUPERADMIN_API_KEY debe ser >= 32 chars'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('json'),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('\n❌ Configuración inválida:\n');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
