/**
 * =============================================================================
 * Pantalla booking — agendar cita nueva (Hito 8)
 * =============================================================================
 *
 * Flujo lineal en 5 pasos dentro de la misma pantalla:
 *
 *   1. branch    — escoger sucursal
 *   2. dentist   — escoger dentista de esa sucursal
 *   3. date      — escoger día (calendario 14 días al frente)
 *   4. slot      — escoger hora disponible
 *   5. confirm   — revisar resumen + (opcional) notas + crear
 *
 * Cada paso renderiza dentro del mismo container con animación fade.
 * El botón "← Volver" retrocede de paso (en step 1, vuelve a 'home').
 *
 * Estado interno (no global): se mantiene en una variable `selection`
 * mientras la pantalla esté montada. Si el paciente sale (logout, idle),
 * todo se pierde — deseado en un kiosco compartido.
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { showModal } from '../components/modal.js';
import { toast } from '../components/toast.js';

const STEPS = ['branch', 'dentist', 'treatment', 'date', 'slot', 'confirm'];
const MAX_FUTURE_DAYS = 90;
const CALENDAR_MONTHS = 2; // mes actual + siguiente
const WEEKDAY_LABELS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const MONTH_LABELS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function renderBooking(container, params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  const selection = {
    branch: null, // { id, nombre, direccion?, telefono?, horario? }
    dentist: null, // { id, nombre, apellido?, especialidad? }
    treatment: null, // { id, name, duration_minutes, description? }
    date: null, // 'YYYY-MM-DD'
    slot: null, // { hora_inicio, hora_fin, duracion_minutos, ... }
    notas: '',
  };

  let currentStep = 'branch';

  // ===== Estructura común =====
  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1 id="booking-title">Agendar cita</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Volver
        </button>
      </header>
      <div class="screen-body">
        <div class="booking-progress" id="progress"></div>
        <div id="booking-content"></div>
      </div>
    </div>
  `;

  const content = container.querySelector('#booking-content');
  const progressEl = container.querySelector('#progress');
  const backBtn = container.querySelector('#back-btn');
  const titleEl = container.querySelector('#booking-title');

  // ===== Navegación entre pasos =====
  const goToStep = (step) => {
    currentStep = step;
    renderProgress(progressEl, step);
    updateTitle(titleEl, step, selection);
    renderStep(content, step, selection, {
      next: goToStep,
      finish: () => navigate('home'),
      cancel: () => navigate('home'),
    });
  };

  const goBack = () => {
    const idx = STEPS.indexOf(currentStep);
    if (idx <= 0) {
      navigate('home');
      return;
    }
    // Al retroceder, limpiar selecciones posteriores
    const prevStep = STEPS[idx - 1];
    clearForwardSelections(selection, prevStep);
    goToStep(prevStep);
  };

  backBtn.addEventListener('click', goBack);

  // Arranque
  goToStep('branch');

  return null;
}

// =============================================================================
// Helpers de navegación
// =============================================================================

function clearForwardSelections(selection, fromStep) {
  const idx = STEPS.indexOf(fromStep);
  if (idx <= STEPS.indexOf('dentist') - 1) selection.dentist = null;
  if (idx <= STEPS.indexOf('treatment') - 1) selection.treatment = null;
  if (idx <= STEPS.indexOf('date') - 1) selection.date = null;
  if (idx <= STEPS.indexOf('slot') - 1) selection.slot = null;
  if (idx <= STEPS.indexOf('confirm') - 1) selection.notas = '';
}

function updateTitle(el, step, selection) {
  const titles = {
    branch: 'Agendar cita — Sede',
    dentist: 'Agendar cita — Dentista',
    treatment: 'Agendar cita — Tratamiento',
    date: 'Agendar cita — Fecha',
    slot: 'Agendar cita — Hora',
    confirm: 'Agendar cita — Confirmar',
  };
  el.textContent = titles[step] ?? 'Agendar cita';
}

function renderProgress(el, currentStep) {
  const idx = STEPS.indexOf(currentStep);
  el.innerHTML = STEPS.map((s, i) => {
    const cls =
      i < idx ? 'progress-step done' : i === idx ? 'progress-step active' : 'progress-step';
    return `<div class="${cls}"><span>${i + 1}</span></div>`;
  }).join('<div class="progress-bar"></div>');
}

// =============================================================================
// Renderers por paso
// =============================================================================

function renderStep(container, step, selection, actions) {
  switch (step) {
    case 'branch':
      return renderBranchStep(container, selection, actions);
    case 'dentist':
      return renderDentistStep(container, selection, actions);
    case 'treatment':
      return renderTreatmentStep(container, selection, actions);
    case 'date':
      return renderDateStep(container, selection, actions);
    case 'slot':
      return renderSlotStep(container, selection, actions);
    case 'confirm':
      return renderConfirmStep(container, selection, actions);
  }
}

// ----- 1: Sucursal -----

async function renderBranchStep(container, selection, { next }) {
  container.innerHTML = spinner({ text: 'Cargando sedes...' });
  try {
    const res = await api.getBranches();
    const branches = res.data ?? [];

    if (branches.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🏥</div>
          <p>No hay sedes configuradas.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <p class="subtitle">Selecciona la sede donde quieres tu cita:</p>
      <div class="option-list">
        ${branches.map((b) => optionCardHtml({
          id: `branch-${b.id}`,
          title: b.nombre,
          subtitle: b.direccion || '',
          meta: [b.telefono, b.horario].filter(Boolean).join(' · '),
          icon: '🏥',
        })).join('')}
      </div>
    `;

    container.querySelectorAll('.option-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = Number(card.dataset.id.replace('branch-', ''));
        selection.branch = branches.find((b) => b.id === id);
        next('dentist');
      });
    });
  } catch (err) {
    renderStepError(container, err);
  }
}

// ----- 2: Dentista -----

async function renderDentistStep(container, selection, { next }) {
  if (!selection.branch) return next('branch');

  container.innerHTML = spinner({ text: 'Cargando profesionales...' });
  try {
    const res = await api.getDentists(selection.branch.id);
    const dentists = res.data ?? [];

    if (dentists.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">👨‍⚕️</div>
          <p>No hay profesionales disponibles en ${escapeHtml(selection.branch.nombre)}.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <p class="subtitle">
        <strong>${escapeHtml(selection.branch.nombre)}</strong> ·
        Toca a tu profesional para continuar:
      </p>
      <div class="dentist-grid">
        ${dentists.map((d) => dentistCardHtml(d)).join('')}
      </div>
    `;

    container.querySelectorAll('.dentist-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        selection.dentist = dentists.find((d) => d.id === id);
        next('treatment');
      });
    });
  } catch (err) {
    renderStepError(container, err);
  }
}

// ----- 3: Tratamiento -----

function renderTreatmentStep(container, selection, { next }) {
  if (!selection.dentist) return next('branch');

  const procedures = state.config?.procedures ?? [];

  // Fallback: si no hay procedimientos configurados, ofrecer "Consulta general"
  // con la duración por defecto de la clínica. NO bloquear el flujo.
  const treatments =
    procedures.length > 0
      ? procedures
      : [
          {
            id: '__default__',
            name: 'Consulta general',
            duration_minutes: state.config?.duracion_cita_minutos ?? 30,
          },
        ];

  container.innerHTML = `
    <p class="subtitle">
      <strong>${escapeHtml(fullName(selection.dentist))}</strong> ·
      Selecciona el tipo de consulta o tratamiento:
    </p>
    <div class="treatment-grid">
      ${treatments.map(treatmentCardHtml).join('')}
    </div>
  `;

  container.querySelectorAll('.treatment-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      selection.treatment = treatments.find((t) => String(t.id) === id);
      next('date');
    });
  });
}

function treatmentCardHtml(t) {
  const description = t.description ? `<div class="treatment-card-desc">${escapeHtml(t.description)}</div>` : '';
  return `
    <button type="button" class="treatment-card" data-id="${escapeHtml(String(t.id))}">
      <div class="treatment-card-name">${escapeHtml(t.name)}</div>
      <div class="treatment-card-duration">${t.duration_minutes} min</div>
      ${description}
    </button>
  `;
}

function dentistCardHtml(d) {
  const fullName = `${d.nombre} ${d.apellido ?? ''}`.trim();
  const initials  = fullName.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
  const specialty = d.especialidad || 'Odontología';

  const photoHtml = d.photo_url
    ? `<img src="${escapeHtml('/api' + d.photo_url)}" class="dentist-card-photo"
            alt="${escapeHtml(fullName)}"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : '';
  const avatarHtml = `<div class="dentist-card-avatar" style="${d.photo_url ? 'display:none' : ''}">${escapeHtml(initials)}</div>`;

  return `
    <button type="button" class="dentist-card" data-id="${escapeHtml(d.id)}">
      <div class="dentist-card-photo-wrap">
        ${photoHtml}
        ${avatarHtml}
      </div>
      <div class="dentist-card-name">${escapeHtml(fullName)}</div>
      <div class="dentist-card-spec">${escapeHtml(specialty)}</div>
    </button>
  `;
}

// ----- 4: Fecha -----

async function renderDateStep(container, selection, { next }) {
  if (!selection.dentist) return next('branch');
  if (!selection.treatment) return next('treatment');

  // "Hoy" se trata como día pasado: el primer día seleccionable es mañana.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const minSelectable = new Date(today);
  minSelectable.setDate(minSelectable.getDate() + 1);

  const maxSelectable = new Date(today);
  maxSelectable.setDate(maxSelectable.getDate() + MAX_FUTURE_DAYS);

  container.innerHTML = `
    <p class="subtitle">
      <strong>${escapeHtml(fullName(selection.dentist))}</strong> ·
      Selecciona el día (${selection.treatment.duration_minutes} min):
    </p>
    <div class="calendar-wrap" id="calendar-wrap"></div>
  `;
  const wrap = container.querySelector('#calendar-wrap');

  let busy = false;
  const onSelectDate = async (isoDate) => {
    if (busy) return;
    busy = true;

    // Marcado visual inmediato
    selection.date = isoDate;
    repaint();

    try {
      const res = await api.getSlots({
        dentistId: selection.dentist.id,
        branchId: selection.branch.id,
        from: isoDate,
        to: isoDate,
        duration: selection.treatment.duration_minutes,
      });
      const slots = res.data ?? [];
      if (slots.length === 0) {
        toast('Sin disponibilidad este día, elige otro', 'warning');
        selection.date = null;
        repaint();
        busy = false;
        return;
      }
      next('slot');
    } catch (err) {
      selection.date = null;
      repaint();
      busy = false;
      if (err instanceof ApiError && err.status === 401) {
        toast('Tu sesión expiró.', 'error');
      } else {
        toast('No pudimos consultar la disponibilidad. Intenta de nuevo.', 'error');
      }
    }
  };

  const repaint = () => {
    const months = [];
    for (let i = 0; i < CALENDAR_MONTHS; i += 1) {
      months.push(renderCalendar(i, today, minSelectable, maxSelectable, selection.date));
    }
    wrap.innerHTML = months.join('');
    wrap.querySelectorAll('.calendar-day[data-date]').forEach((cell) => {
      cell.addEventListener('click', () => onSelectDate(cell.dataset.date));
    });
  };

  repaint();
}

/**
 * Renderiza un mes en cuadrícula 7 cols (L M M J V S D).
 * - monthOffset: 0 = mes actual, 1 = siguiente, etc.
 * - today, minSelectable, maxSelectable: límites de selección.
 * - selectedIso: 'YYYY-MM-DD' actualmente marcado, o null.
 *
 * Devuelve HTML. Solo las celdas seleccionables traen data-date.
 */
function renderCalendar(monthOffset, today, minSelectable, maxSelectable, selectedIso) {
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
        ${escapeHtml(MONTH_LABELS[month])} ${year}
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
function isoFromLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ----- 5: Slot -----

async function renderSlotStep(container, selection, { next }) {
  if (!selection.date) return next('date');
  if (!selection.treatment) return next('treatment');

  const formattedDate = formatLongDate(selection.date);
  container.innerHTML = `
    <p class="subtitle">
      <strong>${escapeHtml(formattedDate)}</strong> ·
      Horarios disponibles con ${escapeHtml(fullName(selection.dentist))}
      (${selection.treatment.duration_minutes} min):
    </p>
    <div id="slots-container">${spinner({ text: 'Cargando horarios...' })}</div>
  `;
  const slotsContainer = container.querySelector('#slots-container');

  try {
    const res = await api.getSlots({
      dentistId: selection.dentist.id,
      branchId: selection.branch.id,
      from: selection.date,
      to: selection.date,
      duration: selection.treatment.duration_minutes,
    });
    const slots = res.data ?? [];

    if (slots.length === 0) {
      slotsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📅</div>
          <p>No hay horarios disponibles este día. Por favor escoge otra fecha.</p>
        </div>
      `;
      return;
    }

    // Agrupar por mañana / tarde
    const morning = slots.filter((s) => parseHour(s.hora_inicio) < 12);
    const afternoon = slots.filter((s) => parseHour(s.hora_inicio) >= 12);

    slotsContainer.innerHTML = `
      ${morning.length > 0 ? renderSlotGroup('Mañana', morning) : ''}
      ${afternoon.length > 0 ? renderSlotGroup('Tarde', afternoon) : ''}
    `;

    slotsContainer.querySelectorAll('.slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selection.slot = slots.find((s) => s.hora_inicio === btn.dataset.hora) ?? null;
        if (selection.slot) next('confirm');
      });
    });
  } catch (err) {
    renderStepError(slotsContainer, err);
  }
}

function renderSlotGroup(label, slots) {
  return `
    <div class="slot-group">
      <h3>${escapeHtml(label)}</h3>
      <div class="slot-grid">
        ${slots
          .map(
            (s, i) => `
          <button type="button" class="slot-btn" data-hora="${escapeHtml(s.hora_inicio)}">
            ${escapeHtml(s.hora_inicio)}
          </button>
        `,
          )
          .join('')}
      </div>
    </div>
  `;
}

// ----- 6: Confirmar -----

function renderConfirmStep(container, selection, { finish, cancel, next }) {
  if (!selection.slot) return cancel();

  const fullDate = formatLongDate(selection.date);
  const dentistName = fullName(selection.dentist);
  const duracion = selection.treatment?.duration_minutes ?? selection.slot.duracion_minutos ?? 30;

  container.innerHTML = `
    <p class="subtitle">Revisa los datos antes de confirmar tu cita:</p>

    <div class="booking-summary">
      <div class="booking-summary-row">
        <div class="booking-summary-label">🏥 Sede</div>
        <div class="booking-summary-value">${escapeHtml(selection.branch.nombre)}</div>
      </div>
      ${selection.branch.direccion ? `
        <div class="booking-summary-row">
          <div class="booking-summary-label">📍 Dirección</div>
          <div class="booking-summary-value">${escapeHtml(selection.branch.direccion)}</div>
        </div>
      ` : ''}
      <div class="booking-summary-row">
        <div class="booking-summary-label">👨‍⚕️ Profesional</div>
        <div class="booking-summary-value">${escapeHtml(dentistName)}</div>
      </div>
      ${selection.dentist.especialidad ? `
        <div class="booking-summary-row">
          <div class="booking-summary-label">Especialidad</div>
          <div class="booking-summary-value">${escapeHtml(selection.dentist.especialidad)}</div>
        </div>
      ` : ''}
      ${selection.treatment ? `
        <div class="booking-summary-row">
          <div class="booking-summary-label">🦷 Tratamiento</div>
          <div class="booking-summary-value">${escapeHtml(selection.treatment.name)} (${duracion} min)</div>
        </div>
      ` : ''}
      <div class="booking-summary-row">
        <div class="booking-summary-label">📅 Fecha</div>
        <div class="booking-summary-value">${escapeHtml(fullDate)}</div>
      </div>
      <div class="booking-summary-row">
        <div class="booking-summary-label">🕐 Hora</div>
        <div class="booking-summary-value">${escapeHtml(selection.slot.hora_inicio)} – ${escapeHtml(selection.slot.hora_fin)}</div>
      </div>
      <div class="booking-summary-row">
        <div class="booking-summary-label">⏱ Duración</div>
        <div class="booking-summary-value">${duracion} minutos</div>
      </div>
    </div>

    <div class="form-group" style="margin-top: 1.5rem;">
      <label for="notas-input">Motivo o notas (opcional)</label>
      <input type="text" id="notas-input" maxlength="200"
             placeholder="Ej: Dolor muela inferior izquierda" autocomplete="off">
      <div class="form-help">Máx 200 caracteres. Lo verá el profesional.</div>
    </div>

    <div id="form-error" class="form-error" style="display: none;"></div>

    <button type="button" class="btn btn-primary btn-lg btn-full" id="confirm-btn"
            style="margin-top: 1rem;">
      Confirmar y agendar
    </button>
  `;

  const notasInput = container.querySelector('#notas-input');
  const errorEl = container.querySelector('#form-error');
  const confirmBtn = container.querySelector('#confirm-btn');
  let submitting = false;

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  };

  confirmBtn.addEventListener('click', async () => {
    if (submitting) return;
    submitting = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Agendando...';
    selection.notas = notasInput.value.trim();

    try {
      const result = await api.createBookingAppointment({
        dentistId: selection.dentist.id,
        branchId: selection.branch.id,
        fecha: selection.date,
        horaInicio: selection.slot.hora_inicio,
        horaFin: selection.slot.hora_fin,
        notas: selection.notas || undefined,
        treatmentName:
          selection.treatment && selection.treatment.id !== '__default__'
            ? selection.treatment.name
            : undefined,
      });

      showModal({
        icon: '✅',
        title: '¡Cita agendada!',
        body: `Tu cita con ${dentistName} fue agendada para el ${fullDate} a las ${selection.slot.hora_inicio}. La verás en "Mis citas".`,
        actions: [
          {
            label: 'Entendido',
            variant: 'primary',
            action: () => finish(),
          },
        ],
        dismissible: false,
      });
    } catch (err) {
      submitting = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmar y agendar';

      if (err instanceof ApiError) {
        if (err.status === 409) {
          showError('Este horario ya no está disponible. Elige otro en 3 segundos…');
          setTimeout(() => {
            selection.slot = null;
            next('slot');
          }, 3000);
        } else if (err.status === 429) {
          showError('Has creado muchas citas recientemente. Espera unos minutos.');
        } else if (err.status === 400) {
          showError(err.body?.message ?? 'Datos inválidos.');
        } else if (err.status === 401) {
          showError('Tu sesión expiró. Por favor inicia sesión de nuevo.');
        } else {
          showError('No pudimos agendar la cita. Intenta más tarde o acude a recepción.');
        }
      } else {
        toast('Error de conexión.', 'error');
      }
    }
  });
}

// =============================================================================
// Componentes auxiliares
// =============================================================================

function optionCardHtml({ id, title, subtitle, meta, icon }) {
  return `
    <button type="button" class="option-card" data-id="${escapeHtml(id)}">
      <div class="option-card-icon">${escapeHtml(icon ?? '•')}</div>
      <div class="option-card-body">
        <div class="option-card-title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="option-card-subtitle">${escapeHtml(subtitle)}</div>` : ''}
        ${meta ? `<div class="option-card-meta">${escapeHtml(meta)}</div>` : ''}
      </div>
      <div class="option-card-arrow">›</div>
    </button>
  `;
}

function renderStepError(container, err) {
  let msg = 'No pudimos cargar esta información.';
  if (err instanceof ApiError) {
    if (err.status === 401) msg = 'Tu sesión expiró. Por favor inicia sesión de nuevo.';
    else if (err.status === 503 || err.status === 504)
      msg = 'El sistema de gestión está temporalmente fuera de línea.';
  }
  container.innerHTML = `<div class="alert alert-error">${escapeHtml(msg)}</div>`;
}

// =============================================================================
// Utils
// =============================================================================

function fullName(d) {
  return `${d.nombre} ${d.apellido ?? ''}`.trim();
}

function parseHour(hhmm) {
  return parseInt(hhmm.split(':')[0], 10);
}

function formatLongDate(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
