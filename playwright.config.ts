import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E del front del paciente (Hito C/D).
 *
 * Levanta API (mock de servicios externos) + frontend de Vite y corre los
 * specs en tres perfiles de dispositivo (Pixel 7 / iPad / Desktop). Solo se usa
 * Chromium (forzado también en iPad) para no requerir binarios de WebKit.
 *
 * Requisitos: Postgres y Redis del clon arriba (puertos 5434/6381) y la clínica
 * id=1 configurada con Habeas Data. Ejecutar con:
 *   DOTENV_CONFIG_PATH=$(pwd)/.env pnpm test:e2e
 */

const REPO = process.cwd();
const ENV_PATH = process.env.DOTENV_CONFIG_PATH ?? `${REPO}/.env`;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'Pixel 7', use: { ...devices['Pixel 7'] } },
    // iPad usa WebKit por defecto; lo forzamos a Chromium (mismo viewport táctil).
    { name: 'iPad', use: { ...devices['iPad (gen 7)'], browserName: 'chromium' } },
    { name: 'Desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @dentalkiosco/api dev',
      url: 'http://localhost:3000/health',
      reuseExistingServer: true,
      timeout: 90_000,
      env: {
        DOTENV_CONFIG_PATH: ENV_PATH,
        NODE_ENV: 'development',
        // Mock de Dentalink/Twilio/Resend/Wompi: el paciente +573001234567 existe
        // como mock y no se gastan SMS reales.
        DEV_MOCK_EXTERNAL_SERVICES: 'true',
        DEV_MOCK_WOMPI: 'true',
        OTP_REQUIRED: 'true',
      },
    },
    {
      command: 'pnpm --filter @dentalkiosco/kiosco-frontend dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 90_000,
    },
    {
      command: 'pnpm --filter @dentalkiosco/admin-frontend dev',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
});
