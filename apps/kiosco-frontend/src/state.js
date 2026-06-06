/**
 * =============================================================================
 * State global del kiosco
 * =============================================================================
 *
 * Mantiene:
 *   - config (resultado de /public/bootstrap): clínica, habeas data, FAQ, etc.
 *   - patient (datos del paciente autenticado en la sesión actual)
 *   - lastActivity (para el detector de idle)
 *
 * Web pública (§10): la info del paciente se persiste en sessionStorage para
 * sobrevivir refresh de la pestaña y cambios de app en móvil, en paralelo con
 * el access token (api.js). Se borra al cerrar la pestaña o al hacer logout.
 * El token es lo que realmente autoriza; este objeto solo guarda datos de UI
 * (p. ej. el nombre para saludar) y el backend revalida cada request.
 */

const PATIENT_KEY = 'dk_patient_info';

const listeners = new Set();

function loadPersistedPatient() {
  try {
    const raw = sessionStorage.getItem(PATIENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const state = {
  /** Configuración del kiosco (vacía hasta que bootstrap() resuelva) */
  config: null,
  /** Datos del paciente actual (null si no hay sesión) */
  patient: loadPersistedPatient(),
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
  try {
    if (patient) sessionStorage.setItem(PATIENT_KEY, JSON.stringify(patient));
    else sessionStorage.removeItem(PATIENT_KEY);
  } catch {
    // sessionStorage no disponible (modo privado estricto) — degradar a memoria
  }
  notify();
}

export function clearPatient() {
  state.patient = null;
  try {
    sessionStorage.removeItem(PATIENT_KEY);
  } catch {
    // ignore
  }
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
