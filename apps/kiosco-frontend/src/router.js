/**
 * =============================================================================
 * Router — máquina de estados entre pantallas del kiosco
 * =============================================================================
 *
 * Cada "screen" exporta una función render(container, params, navigate) que:
 *   - Dibuja su UI dentro de container
 *   - Recibe los params que le pasó el navegador
 *   - Recibe navigate() para cambiar a otra pantalla
 *   - Puede retornar una función "cleanup" que se llama al salir de la pantalla
 *
 * NO hay URLs — el kiosco siempre vive en "/". Sin history API.
 * Esto evita que el usuario use el back-button del browser para violar el flujo.
 */

import { state } from './state.js';
import { renderClinicHeader } from './components/clinic-header.js';

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
 * Navega a una pantalla. Limpia la anterior antes.
 *
 * @param {string} name    Nombre de la pantalla registrada
 * @param {object} [params] Datos para pasar a la pantalla
 */
export async function navigate(name, params = {}) {
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
            Por favor toca en cualquier lugar para volver al inicio.
          </div>
        </div>
      </div>
    `;
    container.addEventListener('click', () => navigate('standby'), { once: true });
  }
}
