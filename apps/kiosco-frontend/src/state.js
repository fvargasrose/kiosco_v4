/**
 * =============================================================================
 * State global del kiosco
 * =============================================================================
 *
 * Mantiene:
 *   - config (resultado de /kiosk/bootstrap): clínica, habeas data, FAQ, etc.
 *   - patient (datos del paciente autenticado en la sesión actual)
 *   - lastActivity (para el detector de idle)
 *
 * NO persistir patient en sessionStorage/localStorage. Solo en memoria.
 * Si la pestaña se cierra o refresca, se pierde la sesión (deseado en kiosco).
 *
 * El kiosk_token sí persiste en sessionStorage (manejado por api.js) porque
 * sobrevive a refresh accidental de la pestaña, pero no al cierre del navegador.
 */

const listeners = new Set();

export const state = {
  /** Configuración del kiosco (vacía hasta que bootstrap() resuelva) */
  config: null,
  /** Datos del paciente actual (null si no hay sesión) */
  patient: null,
  /** Timestamp del último evento de interacción */
  lastActivity: Date.now(),
};

/**
 * Suscribirse a cambios del estado.
 * @param {(state) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('[state] listener error', err);
    }
  }
}

export function setConfig(config) {
  state.config = config;
  notify();
}

export function setPatient(patient) {
  state.patient = patient;
  notify();
}

export function clearPatient() {
  state.patient = null;
  notify();
}

export function recordActivity() {
  state.lastActivity = Date.now();
}

/**
 * Helper: ¿hay sesión activa de paciente?
 */
export function isAuthenticated() {
  return state.patient !== null;
}
