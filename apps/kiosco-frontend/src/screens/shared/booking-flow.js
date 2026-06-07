/**
 * =============================================================================
 * Flujo compartido de booking (sin markup) — consumido por booking.js (tema
 * default) y booking.apple.js (tema apple).
 * =============================================================================
 *
 * Este módulo concentra la LÓGICA DE FLUJO que antes vivía duplicada en ambos
 * temas (causa raíz del drift S1-S3): orden de pasos, navegación, calendario de
 * 2 meses, construcción de la llamada a getSlots (con duration/branch_id) y del
 * payload del POST (con treatment_name). Cada tema aporta SOLO el markup, las
 * clases y el shell.
 *
 * Comportamiento idéntico al previo: esto es reorganización de código, no cambia
 * contratos de API ni textos.
 */

import { buildTreatmentList, DEFAULT_TREATMENT_ID } from './treatment-list.js';

export { buildTreatmentList, DEFAULT_TREATMENT_ID };

// ─── Pasos y navegación ───────────────────────────────────────────────────────

export const STEPS = ['branch', 'dentist', 'treatment', 'date', 'slot', 'confirm'];

/**
 * Pasos activos según la bandera de procedimientos (bootstrap:
 * `procedimientos_activos`). Si está desactivada, se omite el paso 'treatment'
 * (el paciente no elige procedimiento; se usa una "Consulta general" presembrada
 * con la duración por defecto de la clínica).
 */
export function getSteps(proceduresEnabled) {
  return proceduresEnabled ? STEPS : STEPS.filter((s) => s !== 'treatment');
}

/**
 * Limpia las selecciones posteriores a `fromStep` (usado al retroceder).
 * Muta `selection` en sitio. Opera sobre la lista de pasos activos (`steps`),
 * para no borrar el tratamiento presembrado cuando 'treatment' no es un paso.
 */
export function clearForwardSelections(selection, fromStep, steps = STEPS) {
  const idx = steps.indexOf(fromStep);
  const isAfter = (name) => {
    const i = steps.indexOf(name);
    return i !== -1 && idx <= i - 1;
  };
  if (isAfter('dentist')) selection.dentist = null;
  if (isAfter('treatment')) selection.treatment = null;
  if (isAfter('date')) selection.date = null;
  if (isAfter('slot')) selection.slot = null;
  if (isAfter('confirm')) selection.notas = '';
}

// ─── Calendario ────────────────────────────────────────────────────────────────

export const MAX_FUTURE_DAYS = 90;
export const CALENDAR_MONTHS = 2; // mes actual + siguiente
export const WEEKDAY_LABELS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
export const MONTH_LABELS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Límites de selección del calendario.
 * "Hoy" se trata como día pasado: el primer día seleccionable es mañana.
 */
export function getDateBounds() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minSelectable = new Date(today);
  minSelectable.setDate(minSelectable.getDate() + 1);
  const maxSelectable = new Date(today);
  maxSelectable.setDate(maxSelectable.getDate() + MAX_FUTURE_DAYS);
  return { today, minSelectable, maxSelectable };
}

/**
 * Renderiza un mes en cuadrícula 7 cols (L M M J V S D).
 * - monthOffset: 0 = mes actual, 1 = siguiente, etc.
 * - today, minSelectable, maxSelectable: límites de selección.
 * - selectedIso: 'YYYY-MM-DD' actualmente marcado, o null.
 *
 * Devuelve HTML. Solo las celdas seleccionables traen data-date. Las clases CSS
 * (calendar-*) las estiliza cada tema en su hoja de estilos.
 */
export function renderCalendar(monthOffset, today, minSelectable, maxSelectable, selectedIso) {
  const ref = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const year = ref.getFullYear();
  const month = ref.getMonth();

  // Empezamos el grid en lunes. getDay(): 0=Dom, 1=Lun, ..., 6=Sab
  // Queremos que Dom (0) caiga en la última columna; Lun (1) en la primera.
  const firstWeekday = ref.getDay();
  const leadingBlanks = firstWeekday === 0 ? 6 : firstWeekday - 1;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;

  const cells = [];
  for (let i = 0; i < totalCells; i += 1) {
    const dayNum = i - leadingBlanks + 1;
    const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
    if (!inMonth) {
      cells.push(`<div class="calendar-day calendar-day--other-month"></div>`);
      continue;
    }
    const cellDate = new Date(year, month, dayNum);
    const isoDate = isoFromLocal(cellDate);
    const dow = cellDate.getDay(); // 0=Dom
    const isSunday = dow === 0;
    const isPast = cellDate < minSelectable;
    const isBeyond = cellDate > maxSelectable;
    const isToday = cellDate.getTime() === today.getTime();
    const isSelected = isoDate === selectedIso;

    const classes = ['calendar-day'];
    if (isPast || isBeyond) classes.push('calendar-day--past');
    if (isSunday && !isPast && !isBeyond) classes.push('calendar-day--sunday');
    if (isToday) classes.push('calendar-day--today');
    if (isSelected) classes.push('calendar-day--selected');

    const clickable = !isPast && !isBeyond && !isSunday;
    const attrs = clickable
      ? `data-date="${isoDate}" role="button" tabindex="0"`
      : 'aria-disabled="true"';

    cells.push(`
      <div class="${classes.join(' ')}" ${attrs}>
        <span class="calendar-day-num">${dayNum}</span>
      </div>
    `);
  }

  return `
    <div class="calendar-month">
      <div class="calendar-month-header">
        ${escapeMonth(MONTH_LABELS[month])} ${year}
      </div>
      <div class="calendar-weekdays">
        ${WEEKDAY_LABELS.map((w) => `<div class="calendar-weekday">${w}</div>`).join('')}
      </div>
      <div class="calendar-grid">
        ${cells.join('')}
      </div>
    </div>
  `;
}

/** YYYY-MM-DD en zona local (Date.toISOString usa UTC y puede saltar día). */
export function isoFromLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Los nombres de mes son constantes internas controladas (sin entrada de
// usuario); se escapan igualmente por consistencia con el render previo.
function escapeMonth(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Construcción de llamadas a la API ────────────────────────────────────────

/**
 * Parámetros para api.getSlots — incluye duration (del tratamiento) y branchId,
 * que el backend necesita para calcular disponibilidad real (S3).
 */
export function buildSlotsParams(selection, fromIso, toIso) {
  return {
    dentistId: selection.dentist.id,
    branchId: selection.branch.id,
    from: fromIso,
    to: toIso,
    duration: selection.treatment.duration_minutes,
  };
}

/**
 * Parámetros para api.createBookingAppointment. Envía treatment_name (salvo el
 * fallback __default__) y NO envía id_tratamiento (F8). Lee selection.notas.
 */
export function buildBookingParams(selection) {
  return {
    dentistId: selection.dentist.id,
    branchId: selection.branch.id,
    fecha: selection.date,
    horaInicio: selection.slot.hora_inicio,
    horaFin: selection.slot.hora_fin,
    notas: selection.notas || undefined,
    treatmentName:
      selection.treatment && selection.treatment.id !== DEFAULT_TREATMENT_ID
        ? selection.treatment.name
        : undefined,
  };
}
