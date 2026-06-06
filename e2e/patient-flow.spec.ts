import { test, expect } from '@playwright/test';
import { loginByOtp, resetOtpRateLimits } from './helpers';

/**
 * E2E núcleo del Hito C: la app arranca SIN token de kiosco, el paciente hace
 * login por OTP en web y llega a home, citas y pago. Corre en Pixel 7 / iPad /
 * Desktop (ver playwright.config.ts).
 */

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
