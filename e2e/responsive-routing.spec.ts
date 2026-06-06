import { test, expect } from '@playwright/test';
import { loginByOtp, resetOtpRateLimits } from './helpers';

/**
 * E2E del Hito D: routing real (deep-link, atrás/adelante, refresh mantiene
 * ruta y sesión), teclado nativo (sin teclado en pantalla) y ausencia de scroll
 * horizontal en los breakpoints 360 / 768 / 1280.
 */

test.beforeEach(() => {
  resetOtpRateLimits();
});

test('routing: deep-link, botón atrás y refresh mantienen ruta y sesión', async ({ page }) => {
  await loginByOtp(page);
  expect(new URL(page.url()).pathname).toBe('/inicio');

  // Navegación a "Mis citas" → la URL refleja la ruta.
  await page.locator('.ak-action-card[data-target="appointments"]').click();
  await expect(page.locator('.ak-page-title', { hasText: 'Mis citas' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/citas');

  // Botón atrás del navegador → vuelve a home.
  await page.goBack();
  await expect(page.getByText('Bienvenido de vuelta')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/inicio');

  // Refresh mantiene sesión y ruta.
  await page.reload();
  await expect(page.getByText('Bienvenido de vuelta')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/inicio');

  // Deep-link directo a /tratamientos (sesión persistida en sessionStorage).
  await page.goto('/tratamientos');
  await expect(page.locator('.ak-page-title', { hasText: 'Mis tratamientos' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/tratamientos');
});

test('login usa el teclado nativo (sin teclado en pantalla)', async ({ page }) => {
  await page.goto('/');
  await page.locator('#standby-start').click();
  await page.locator('#consent-check').check();
  await page.locator('#continue-btn').click();
  await expect(page.locator('#phone')).toBeVisible();
  // El teclado táctil del kiosco (.kiosk-keyboard) no debe montarse en web.
  await expect(page.locator('.kiosk-keyboard')).toHaveCount(0);
});

test('sin scroll horizontal en 360 / 768 / 1280', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop', 'chequeo de breakpoints: una sola vez');

  await loginByOtp(page);

  const widths = [360, 768, 1280];
  const paths = ['/', '/aviso-privacidad', '/inicio', '/citas', '/tratamientos', '/agendar'];

  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of paths) {
      await page.goto(path);
      await page.waitForTimeout(350);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `scroll horizontal en ${path} @${width}px`).toBeLessThanOrEqual(1);
    }
  }
});
