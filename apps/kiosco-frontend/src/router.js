/**
 * =============================================================================
 * Router con History API — URLs reales (deep-link, back/forward, refresh)
 * =============================================================================
 *
 * Cada "screen" exporta render(container, params, navigate) que dibuja su UI y
 * opcionalmente retorna una función cleanup() que se ejecuta al salir.
 *
 * Web (Hito D): a diferencia del kiosco físico (router sin URL), aquí cada
 * pantalla tiene una ruta real. navigate() hace pushState; el botón atrás/adel.
 * del navegador dispara popstate y re-renderiza; un deep-link o un refresh
 * renderiza directamente la pantalla de la URL (con fallback de Caddy/Vite a
 * index.html). Los params se guardan en history.state para sobrevivir
 * back/forward; las pantallas que necesitan params y no los reciben se
 * autoredirigen (p.ej. login-otp sin request_id → habeas-data).
 */

import { state } from './state.js';
import { renderClinicHeader } from './components/clinic-header.js';

// Tabla de rutas: nombre de pantalla ↔ path. Orden no relevante (match exacto).
const ROUTES = [
  ['standby',      '/'],
  ['faq',          '/faq'],
  ['habeas-data',  '/aviso-privacidad'],
  ['login-cedula', '/ingresar'],
  ['login-otp',    '/ingresar/codigo'],
  ['register',     '/registro'],
  ['home',         '/inicio'],
  ['appointments', '/citas'],
  ['treatments',   '/tratamientos'],
  ['booking',      '/agendar'],
  ['payment',      '/pagar'],
  ['profile',      '/perfil'],
];
const PATH_BY_NAME = new Map(ROUTES.map(([n, p]) => [n, p]));
const NAME_BY_PATH = new Map(ROUTES.map(([n, p]) => [p, n]));

export function pathForScreen(name) {
  return PATH_BY_NAME.get(name) ?? '/';
}

export function screenForPath(path) {
  // Normaliza trailing slash (salvo la raíz).
  const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return NAME_BY_PATH.get(clean) ?? null;
}

const screens = new Map();
let currentCleanup = null;
let currentScreenName = null;

// Pantallas con shell apple propio (sidebar con logo) — no necesitan header global.
// Standby usa el logo grande dentro de su layout, también se omite el header.
const SCREENS_WITHOUT_HEADER = new Set([
  'home', 'appointments', 'treatments', 'booking', 'payment',
  'standby',
]);

function updateClinicGlobalHeader(screenName) {
  const headerEl = document.getElementById('clinic-global-header');
  if (!headerEl) return;

  const theme = state.config?.theme;
  if (theme !== 'apple' || SCREENS_WITHOUT_HEADER.has(screenName)) {
    headerEl.hidden = true;
    headerEl.innerHTML = '';
    return;
  }

  const logoUrl = state.config?.clinic?.logo_url ?? null;
  const clinicName = state.config?.clinic?.display_name ?? 'Clínica';
  headerEl.innerHTML = renderClinicHeader(logoUrl, clinicName);
  headerEl.hidden = false;
}

export function registerScreen(name, renderFn) {
  screens.set(name, renderFn);
}

export function getCurrentScreen() {
  return currentScreenName;
}

/**
 * Renderiza una pantalla (sin tocar el historial). Uso interno.
 */
async function renderScreen(name, params) {
  const renderFn = screens.get(name);
  if (!renderFn) {
    console.error(`[router] Pantalla desconocida: ${name}`);
    return;
  }

  // Cleanup pantalla anterior
  if (currentCleanup) {
    try {
      await currentCleanup();
    } catch (err) {
      console.error('[router] cleanup error', err);
    }
    currentCleanup = null;
  }

  const container = document.getElementById('app');
  if (!container) return;
  container.innerHTML = '';

  currentScreenName = name;
  updateClinicGlobalHeader(name);

  try {
    const cleanup = await renderFn(container, params, navigate);
    if (typeof cleanup === 'function') {
      currentCleanup = cleanup;
    }
  } catch (err) {
    console.error(`[router] error rendering ${name}`, err);
    container.innerHTML = `
      <div class="screen">
        <div class="screen-body">
          <div class="alert alert-error">
            <strong>Error al cargar la pantalla.</strong>
            Toca en cualquier lugar para volver al inicio.
          </div>
        </div>
      </div>
    `;
    container.addEventListener('click', () => navigate('standby'), { once: true });
  }
}

/**
 * Navega a una pantalla y actualiza la URL.
 *
 * @param {string} name      Nombre de la pantalla registrada
 * @param {object} [params]  Datos para la pantalla (se guardan en history.state)
 * @param {object} [opts]
 * @param {boolean} [opts.replace]      replaceState en vez de pushState
 * @param {boolean} [opts.fromPopstate] true si lo dispara popstate (no toca history)
 */
export async function navigate(name, params = {}, opts = {}) {
  if (!opts.fromPopstate) {
    const url = pathForScreen(name);
    const histState = { name, params };
    if (opts.replace) {
      history.replaceState(histState, '', url);
    } else {
      history.pushState(histState, '', url);
    }
  }
  await renderScreen(name, params);
}

/**
 * Inicializa el enrutado: instala el listener de popstate (back/forward del
 * navegador). Debe llamarse una vez al arrancar.
 */
export function initRouter() {
  window.addEventListener('popstate', (event) => {
    const st = event.state;
    if (st && st.name) {
      void navigate(st.name, st.params ?? {}, { fromPopstate: true });
    } else {
      // Entrada sin estado (p.ej. la URL inicial): derivar de la ruta.
      const name = screenForPath(window.location.pathname) ?? 'standby';
      void navigate(name, {}, { fromPopstate: true });
    }
  });
}
