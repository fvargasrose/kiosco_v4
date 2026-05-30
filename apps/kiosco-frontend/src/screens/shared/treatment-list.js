/**
 * Lógica pura (sin DOM) de construcción de la lista de tratamientos del paso
 * "treatment" del booking. Extraída para poder testearla en aislamiento.
 *
 * Compartible entre temas (default y apple).
 */

/** Id sentinela del tratamiento de fallback "Consulta general". */
export const DEFAULT_TREATMENT_ID = '__default__';

/**
 * Devuelve la lista de tratamientos a mostrar.
 *
 * - Si hay procedimientos configurados, los devuelve tal cual.
 * - Si NO hay (array vacío o nulo), devuelve UNA tarjeta de fallback
 *   "Consulta general" con la duración por defecto de la clínica. NO bloquea el
 *   flujo ni muestra error.
 *
 * @param {Array<{id:string|number,name:string,duration_minutes:number,description?:string}>} procedures
 * @param {number} [defaultDuration] duración por defecto de la clínica (min)
 * @returns {Array<object>} lista no vacía de tratamientos
 */
export function buildTreatmentList(procedures, defaultDuration) {
  const list = procedures ?? [];
  if (list.length > 0) return list;
  return [
    {
      id: DEFAULT_TREATMENT_ID,
      name: 'Consulta general',
      duration_minutes: defaultDuration ?? 30,
    },
  ];
}
