/**
 * =============================================================================
 * Idle detector
 * =============================================================================
 *
 * Política web pública (§10) — relajada respecto al kiosco físico:
 *   - Solo se aplica cuando hay sesión de paciente activa.
 *   - 28 minutos sin actividad → mostrar modal de warning (2 min para responder).
 *   - 30 minutos sin actividad → cerrar sesión y volver a la landing.
 *
 * (El idle agresivo de kiosco —60/90 s— era hostil en un dispositivo personal.)
 *
 * Eventos considerados "actividad":
 *   pointerdown, touchstart, keydown
 *
 * (NO se considera mousemove para evitar resets por movimientos accidentales
 *  de un cursor visible que el usuario no controla.)
 */

import { state, recordActivity } from './state.js';
import { showModal, closeActiveModal } from './components/modal.js';

// Defaults web (relajados). En modo kiosco, main.js pasa valores agresivos
// (warnAtMs/logoutAtMs) vía startIdleTimer.
const DEFAULT_WARN_AT_MS = 28 * 60_000; // 28 min
const DEFAULT_LOGOUT_AT_MS = 30 * 60_000; // 30 min

let warnAtMs = DEFAULT_WARN_AT_MS;
let logoutAtMs = DEFAULT_LOGOUT_AT_MS;

let intervalId = null;
let warningShown = false;
let onWarning = null;
let onTimeout = null;

const handler = () => {
  recordActivity();
  if (warningShown) {
    closeActiveModal();
    warningShown = false;
  }
};

/**
 * Arranca el detector. Solo se invoca DESPUÉS de login del paciente.
 *
 * @param {Object} hooks
 * @param {() => void} hooks.onTimeout   Callback al alcanzar 30 min sin actividad.
 *                                       Típicamente: logout + volver a standby.
 * @param {() => void} [hooks.onWarning] Callback al alcanzar el warning. Default: modal.
 * @param {number} [hooks.warnAtMs]   ms sin actividad para el aviso (default 28 min).
 * @param {number} [hooks.logoutAtMs] ms sin actividad para cerrar (default 30 min).
 */
export function startIdleTimer(hooks) {
  onTimeout = hooks.onTimeout;
  onWarning = hooks.onWarning ?? defaultWarning;
  warnAtMs = hooks.warnAtMs ?? DEFAULT_WARN_AT_MS;
  logoutAtMs = hooks.logoutAtMs ?? DEFAULT_LOGOUT_AT_MS;

  recordActivity();
  warningShown = false;

  // Eventos de actividad
  window.addEventListener('pointerdown', handler, { passive: true });
  window.addEventListener('touchstart', handler, { passive: true });
  window.addEventListener('keydown', handler);

  // Tick cada segundo
  intervalId = setInterval(tick, 1000);
}

export function stopIdleTimer() {
  window.removeEventListener('pointerdown', handler);
  window.removeEventListener('touchstart', handler);
  window.removeEventListener('keydown', handler);

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  warningShown = false;
  closeActiveModal();
}

function tick() {
  const elapsed = Date.now() - state.lastActivity;

  if (elapsed >= logoutAtMs) {
    stopIdleTimer();
    onTimeout?.();
    return;
  }

  if (elapsed >= warnAtMs && !warningShown) {
    warningShown = true;
    onWarning?.();
  }
}

function defaultWarning() {
  let remaining = Math.ceil((logoutAtMs - warnAtMs) / 1000);
  const modalHandle = showModal({
    icon: '⏰',
    title: '¿Sigues ahí?',
    body: `Tu sesión se cerrará automáticamente en ${remaining} segundos por inactividad.`,
    actions: [
      {
        label: 'Sí, sigo aquí',
        variant: 'primary',
        action: () => {
          recordActivity();
          warningShown = false;
        },
      },
      {
        label: 'Cerrar sesión',
        variant: 'secondary',
        action: () => {
          stopIdleTimer();
          onTimeout?.();
        },
      },
    ],
  });

  // Actualizar el countdown en el modal
  const bodyEl = document.querySelector('.modal-body');
  const updateBody = setInterval(() => {
    remaining = Math.ceil((logoutAtMs - (Date.now() - state.lastActivity)) / 1000);
    if (remaining <= 0 || !warningShown) {
      clearInterval(updateBody);
      return;
    }
    if (bodyEl && document.body.contains(bodyEl)) {
      bodyEl.textContent = `Tu sesión se cerrará automáticamente en ${remaining} segundos por inactividad.`;
    }
  }, 1000);
}
