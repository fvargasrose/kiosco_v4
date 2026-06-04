import { test, expect, type Page } from '@playwright/test';
import { MOCK_PHONE_LOCAL, getDevOtp, resetOtpRateLimits } from './helpers';

/**
 * E2E núcleo del Hito C: la app arranca SIN token de kiosco, el paciente hace
 * login por OTP en web y llega a home, citas y pago. Corre en Pixel 7 / iPad /
 * Desktop (ver playwright.config.ts).
 */

/** Recorre landing → habeas → OTP hasta dejar al paciente en home. */
async function loginByOtp(page: Page): Promise<void> {
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

test.beforeEach(() => {
  resetOtpRateLimits();
});

test('arranque sin token → login OTP → home → citas', async ({ page }) => {
  await loginByOtp(page);

  await page.locator('.ak-action-card[data-target="appointments"]').click();
  await expect(page.locator('.ak-page-title', { hasText: 'Mis citas' })).toBeVisible();
});

test('la sesión sobrevive a un refresh de la página (sessionStorage + /auth/refresh)', async ({ page }) => {
  await loginByOtp(page);

  // El token persistido en sessionStorage se revalida vía /auth/refresh y el
  // paciente vuelve directo a home, sin re-login.
  await page.reload();
  await expect(page.getByText('Bienvenido de vuelta')).toBeVisible();
});

test('pago móvil: tratamiento con saldo → "Pagar ahora" abre el enlace de Wompi', async ({ page }) => {
  await loginByOtp(page);

  await page.locator('.ak-action-card[data-target="treatments"]').click();
  await expect(page.locator('.ak-page-title', { hasText: 'Mis tratamientos' })).toBeVisible();

  // El mock incluye un tratamiento con saldo pendiente → botón Pagar.
  const payBtn = page.locator('.treatment-pay-btn').first();
  await expect(payBtn).toBeVisible();
  await payBtn.click();

  // Pantalla de pago: botón "Pagar ahora" enlazando al link de Wompi (mock).
  const payNow = page.locator('#pay-now-btn');
  await expect(payNow).toBeVisible();
  await expect(payNow).toHaveAttribute('href', /.+/);
});
