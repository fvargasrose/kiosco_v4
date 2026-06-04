import { execSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

/** Paciente mock definido en apps/api/src/lib/dentalink.ts (modo mock). */
export const MOCK_PHONE = '+573001234567';
export const MOCK_PHONE_LOCAL = '3001234567';

const PG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || '5434',
  user: process.env.POSTGRES_USER || 'dentalkiosco',
  db: process.env.POSTGRES_DB || 'dentalkiosco',
  pass: process.env.POSTGRES_PASSWORD || '',
};

/**
 * Limpia los buckets de rate-limit de OTP (tabla rate_limits) para que correr
 * varios perfiles seguidos no choque con el cooldown de 60 s por teléfono.
 */
export function resetOtpRateLimits(): void {
  const sql = "DELETE FROM rate_limits WHERE bucket_key LIKE 'otp:%';";
  execSync(
    `PGPASSWORD='${PG.pass}' psql -h ${PG.host} -p ${PG.port} -U ${PG.user} -d ${PG.db} -tAc "${sql}"`,
    { stdio: 'ignore', shell: '/bin/bash' },
  );
}

/**
 * Lee el OTP de desarrollo desde Redis vía el CLI dk:otp (solo NODE_ENV!=prod).
 * El endpoint escribe la clave otp:dev:<phone> antes de responder, así que para
 * cuando hay inputs de OTP en pantalla el código ya está disponible.
 */
export function getDevOtp(phone: string = MOCK_PHONE): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    let out = '';
    try {
      out = execSync(`pnpm --filter @dentalkiosco/api dk:otp ${phone}`, {
        env: { ...process.env, NODE_ENV: 'development' },
        encoding: 'utf8',
      });
    } catch {
      out = '';
    }
    const m = /Código:\s*(\d{6})/.exec(out);
    if (m) return m[1]!;
    execSync('sleep 0.5');
  }
  throw new Error(`No se pudo leer el OTP de dev para ${phone} desde Redis`);
}

// ── Admin ────────────────────────────────────────────────────────────────────
export const ADMIN_URL = 'http://localhost:5174';
export const ADMIN_EMAIL = 'admin@e2e.local';
export const ADMIN_PASSWORD = 'E2e@Admin2026';

/** Entra al panel admin (admin sin MFA creado por setup.ts) y espera el shell. */
export async function adminLogin(page: Page): Promise<void> {
  await page.goto(`${ADMIN_URL}/`);
  await page.locator('#email').fill(ADMIN_EMAIL);
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.locator('#login-btn').click();
  // El shell autenticado tiene el sidebar con la navegación.
  await expect(
    page.locator('.sidebar .nav-link', { hasText: 'Transacciones' }),
  ).toBeAttached();
}

/** Recorre landing → habeas → OTP hasta dejar al paciente en home. */
export async function loginByOtp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('body')).not.toContainText('no pareado');
  await page.locator('#standby-start').click();

  await page.locator('#consent-check').check();
  await page.locator('#continue-btn').click();

  await page.locator('#phone').fill(MOCK_PHONE_LOCAL);
  await page.locator('#submit-btn').click();

  await expect(page.locator('.otp-inputs')).toBeVisible();
  const code = getDevOtp();
  const digits = page.locator('.otp-digit');
  for (let i = 0; i < 6; i++) {
    await digits.nth(i).fill(code[i]!);
  }
  await expect(page.getByText('Bienvenido de vuelta')).toBeVisible();
}
