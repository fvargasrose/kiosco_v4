/**
 * =============================================================================
 * Modo de operación del frontend del paciente
 * =============================================================================
 *
 * Dos modos, decididos por la presencia del token de kiosco en el link:
 *
 *   - Modo KIOSCO: se entra con `?k=<token>` en la URL (link generado en el
 *     admin). El token se guarda en sessionStorage y se limpia de la URL para
 *     no dejarlo visible ni en el historial. Activa teclado en pantalla, idle
 *     agresivo (~90 s) y, en el backend, los buckets de rate-limit por kiosco.
 *
 *   - Modo WEB (default): sin token. Dispositivo personal (PC/celular). Idle
 *     relajado (30 min), teclado nativo, límites por teléfono/IP.
 *
 * El token de kiosco se envía como `Authorization: Bearer` en /auth/request-otp
 * (ver api.js) para que el backend lo asocie a un `kiosk_id`.
 */

const KIOSK_TOKEN_KEY = 'dk_kiosk_token';

let _mode = 'web';
let _kioskToken = null;

/**
 * Resuelve el modo al arrancar. Debe llamarse una sola vez, antes del bootstrap.
 * @returns {'kiosk'|'web'}
 */
export function initMode() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('k');

  if (fromUrl) {
    // 1. Token recién llegado por el link → persistir y limpiar la URL.
    _kioskToken = fromUrl;
    sessionStorage.setItem(KIOSK_TOKEN_KEY, fromUrl);
    params.delete('k');
    const qs = params.toString();
    const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(null, '', clean);
  } else {
    // 2. Token ya almacenado en esta sesión (navegación interna / refresh).
    _kioskToken = sessionStorage.getItem(KIOSK_TOKEN_KEY);
  }

  _mode = _kioskToken ? 'kiosk' : 'web';
  return _mode;
}

/** @returns {'kiosk'|'web'} */
export function getMode() {
  return _mode;
}

/** @returns {boolean} */
export function isKioskMode() {
  return _mode === 'kiosk';
}

/** Token JWT del kiosco (o null en modo web). */
export function getKioskToken() {
  return _kioskToken;
}
