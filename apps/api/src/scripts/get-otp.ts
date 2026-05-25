#!/usr/bin/env tsx
/**
 * CLI dk:otp — inspecciona el OTP activo de un teléfono en desarrollo.
 *
 * Uso: pnpm --filter @dentalkiosco/api dk:otp +573001234567
 *
 * Lee de Redis la clave `otp:dev:<phone>` que escribe POST /auth/request-otp
 * únicamente cuando NODE_ENV !== 'production'. Si NODE_ENV es 'production',
 * este script falla con exit 1.
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';

// Guardia: nunca en producción.
export function refuseInProduction(env: string | undefined): boolean {
  return env === 'production';
}

async function main(): Promise<void> {
  if (refuseInProduction(process.env.NODE_ENV)) {
    process.stderr.write(
      'Error: dk:otp no puede ejecutarse en producción (NODE_ENV=production)\n',
    );
    process.exit(1);
  }

  const arg = process.argv[2];
  if (!arg) {
    process.stderr.write(
      'Uso: pnpm --filter @dentalkiosco/api dk:otp +573001234567\n',
    );
    process.exit(1);
  }

  // Aceptar con o sin '+' inicial. Normalizar a +57XXXXXXXXXX.
  let phone = arg.trim();
  if (!phone.startsWith('+')) phone = '+' + phone;
  if (!/^\+57[3]\d{9}$/.test(phone)) {
    process.stderr.write(
      `Teléfono inválido: "${arg}". Esperado +57XXXXXXXXXX (10 dígitos comenzando en 3).\n`,
    );
    process.exit(1);
  }

  // Import diferido para que la guardia y la validación corran antes de tocar Redis.
  const { redis } = await import('../lib/redis.js');

  try {
    const raw = await redis.get(`otp:dev:${phone}`);
    if (!raw) {
      process.stdout.write(`No hay OTP activo para ${phone}.\n`);
      process.exit(0);
    }
    const data = JSON.parse(raw) as { code: string; request_id: string; expires_at: string };
    process.stdout.write(`OTP activo para ${phone}:\n`);
    process.stdout.write(`  Código:     ${data.code}\n`);
    process.stdout.write(`  Request ID: ${data.request_id}\n`);
    process.stdout.write(`  Expira:     ${data.expires_at}\n`);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

// Sólo ejecutar main() cuando este archivo es el entry point (no al importarlo desde tests).
const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
