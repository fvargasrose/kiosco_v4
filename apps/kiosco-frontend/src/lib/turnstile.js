/**
 * Cloudflare Turnstile — carga perezosa del widget (anti-abuso de OTP).
 *
 * El backend valida el token server-side en /auth/request-otp cuando Turnstile
 * está configurado (producción). En dev sin sitekey el widget no se renderiza y
 * el backend omite la verificación.
 *
 * Nota de infraestructura (Hito F): la CSP de producción debe permitir
 * `https://challenges.cloudflare.com` en script-src y frame-src.
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise = null;

function loadScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar Turnstile'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Renderiza el widget invisible/managed en `el`.
 * @returns {Promise<{ getToken: () => string|null, reset: () => void }>}
 */
export async function renderTurnstile(el, sitekey) {
  await loadScript();
  return new Promise((resolve, reject) => {
    if (!window.turnstile) return reject(new Error('Turnstile no disponible'));
    let token = null;
    const widgetId = window.turnstile.render(el, {
      sitekey,
      callback: (t) => { token = t; },
      'error-callback': () => { token = null; },
      'expired-callback': () => { token = null; },
    });
    resolve({
      getToken: () => token,
      reset: () => {
        token = null;
        try { window.turnstile.reset(widgetId); } catch { /* noop */ }
      },
    });
  });
}
