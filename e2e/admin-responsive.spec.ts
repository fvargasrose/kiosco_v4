import { test, expect } from '@playwright/test';
import { adminLogin } from './helpers';

/**
 * E2E del Hito E: el panel admin es usable en móvil/tablet.
 * - Móvil (≤768px, Pixel 7): topbar con hamburguesa + sidebar off-canvas.
 * - Tablet/escritorio (iPad 810 / Desktop 1280): sidebar fijo, sin hamburguesa.
 */

function isMobile(page: import('@playwright/test').Page): boolean {
  return (page.viewportSize()?.width ?? 0) <= 768;
}

test('admin: login y dashboard cargan', async ({ page }) => {
  await adminLogin(page);
  await expect(page.locator('#main-content')).not.toBeEmpty();
});

test('admin móvil: sidebar colapsable con hamburguesa', async ({ page }) => {
  test.skip(!isMobile(page), 'solo en viewport móvil (≤768px)');
  await adminLogin(page);

  const shell = page.locator('.shell');
  const hamburger = page.locator('#nav-toggle');

  // La hamburguesa es visible y el menú arranca cerrado.
  await expect(hamburger).toBeVisible();
  await expect(shell).not.toHaveClass(/nav-open/);

  // Abrir: el sidebar entra en pantalla (x ≈ 0) tras la transición.
  await hamburger.click();
  await expect(shell).toHaveClass(/nav-open/);
  await expect
    .poll(async () => (await page.locator('#sidebar').boundingBox())?.x ?? -999)
    .toBeGreaterThanOrEqual(-1);

  // Navegar a Transacciones cierra el menú y carga la sección.
  await page.locator('.sidebar .nav-link', { hasText: 'Transacciones' }).click();
  await expect(shell).not.toHaveClass(/nav-open/);
  await expect(page.locator('.page-title', { hasText: 'Transacciones' })).toBeVisible();
});

test('admin escritorio/tablet: sidebar fijo, sin hamburguesa', async ({ page }) => {
  test.skip(isMobile(page), 'solo en viewport ancho (>768px)');
  await adminLogin(page);

  await expect(page.locator('#nav-toggle')).toBeHidden();
  const box = await page.locator('#sidebar').boundingBox();
  expect(box && box.x).toBeGreaterThanOrEqual(0); // sidebar dentro de la pantalla
});

test('admin móvil: la tabla de transacciones no desborda el layout', async ({ page }) => {
  test.skip(!isMobile(page), 'solo en viewport móvil (≤768px)');
  await adminLogin(page);

  await page.locator('#nav-toggle').click();
  await page.locator('.sidebar .nav-link', { hasText: 'Transacciones' }).click();
  await expect(page.locator('.page-title', { hasText: 'Transacciones' })).toBeVisible();
  await page.waitForTimeout(500);

  // El <body> no debe tener scroll horizontal (la tabla scrollea en su contenedor).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
