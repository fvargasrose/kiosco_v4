import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { showModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { renderAppleShell } from './shared/shell.apple.js';

const STEPS = ['branch', 'dentist', 'date', 'slot', 'confirm'];
const DEFAULT_SEARCH_DAYS = 14;

export function renderBookingApple(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  const selection = {
    branch: null,
    dentist: null,
    date: null,
    slot: null,
    notas: '',
  };

  let currentStep = 'branch';
  let mainEl = null;

  const goToStep = (step) => {
    currentStep = step;
    if (mainEl) renderStep(mainEl, step, selection, { next: goToStep, finish: () => navigate('home'), cancel: () => navigate('home') });
  };

  renderAppleShell(container, 'booking', navigate, (main) => {
    mainEl = main;

    main.innerHTML = `
      <div class="ak-page-header" style="margin-bottom:16px;">
        <div>
          <div class="ak-page-title">Agendar cita</div>
          <div class="ak-page-subtitle" id="booking-subtitle">Selecciona la sede</div>
        </div>
        <button type="button" class="ak-btn-outline" id="back-btn">
          <i class="ti ti-arrow-left"></i> Volver
        </button>
      </div>

      <div class="ak-step-bar" id="step-bar"></div>

      <div id="booking-content" style="margin-top:20px;"></div>
    `;

    main.querySelector('#back-btn').addEventListener('click', () => {
      const idx = STEPS.indexOf(currentStep);
      if (idx <= 0) { navigate('home'); return; }
      const prevStep = STEPS[idx - 1];
      clearForwardSelections(selection, prevStep);
      goToStep(prevStep);
    });

    goToStep('branch');
  });

  return null;
}

// ─── Step bar ────────────────────────────────────────────────────────────────

function renderStepBar(el, currentStep) {
  const labels = { branch: 'Sede', dentist: 'Profesional', date: 'Fecha', slot: 'Hora', confirm: 'Confirmar' };
  const idx = STEPS.indexOf(currentStep);
  el.innerHTML = STEPS.map((s, i) => {
    const cls = i < idx ? 'ak-step-item done' : i === idx ? 'ak-step-item active' : 'ak-step-item';
    return `<div class="${cls}"><span>${labels[s]}</span></div>`;
  }).join('');
}

// ─── Step dispatcher ─────────────────────────────────────────────────────────

function renderStep(main, step, selection, actions) {
  const subtitle = { branch: 'Selecciona la sede', dentist: 'Selecciona el profesional', date: 'Elige el día', slot: 'Elige la hora', confirm: 'Confirma tu cita' };
  const subtitleEl = main.querySelector('#booking-subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitle[step] ?? '';

  const stepBar = main.querySelector('#step-bar');
  if (stepBar) renderStepBar(stepBar, step);

  const content = main.querySelector('#booking-content');
  switch (step) {
    case 'branch':  return renderBranchStep(content, selection, actions);
    case 'dentist': return renderDentistStep(content, selection, actions);
    case 'date':    return renderDateStep(content, selection, actions);
    case 'slot':    return renderSlotStep(content, selection, actions);
    case 'confirm': return renderConfirmStep(content, selection, actions);
  }
}

// ─── 1: Sede ─────────────────────────────────────────────────────────────────

async function renderBranchStep(container, selection, { next }) {
  container.innerHTML = spinner({ text: 'Cargando sedes...' });
  try {
    const res = await api.getBranches();
    const branches = res.data ?? [];

    if (branches.length === 0) {
      container.innerHTML = `<div class="ak-empty"><p>No hay sedes configuradas.</p></div>`;
      return;
    }

    container.innerHTML = branches.map((b) => `
      <button type="button" class="ak-card" data-id="${b.id}"
              style="display:flex;align-items:center;gap:16px;width:100%;text-align:left;cursor:pointer;margin-bottom:12px;">
        <div style="width:48px;height:48px;border-radius:14px;background:rgba(0,113,227,.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <i class="ti ti-building-hospital" style="font-size:22px;color:var(--accent);"></i>
        </div>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:15px;color:var(--text1);">${escapeHtml(b.nombre)}</div>
          ${b.direccion ? `<div style="font-size:13px;color:var(--text2);margin-top:2px;">${escapeHtml(b.direccion)}</div>` : ''}
          ${b.horario  ? `<div style="font-size:12px;color:var(--text3);margin-top:2px;">${escapeHtml(b.horario)}</div>` : ''}
        </div>
        <i class="ti ti-chevron-right" style="color:var(--text3);"></i>
      </button>
    `).join('');

    container.querySelectorAll('.ak-card[data-id]').forEach((card) => {
      card.addEventListener('click', () => {
        selection.branch = branches.find((b) => String(b.id) === card.dataset.id);
        next('dentist');
      });
    });
  } catch (err) {
    renderStepError(container, err);
  }
}

// ─── 2: Dentista ─────────────────────────────────────────────────────────────

async function renderDentistStep(container, selection, { next }) {
  if (!selection.branch) return next('branch');
  container.innerHTML = spinner({ text: 'Cargando profesionales...' });
  try {
    const res = await api.getDentists(selection.branch.id);
    const dentists = res.data ?? [];

    if (dentists.length === 0) {
      container.innerHTML = `<div class="ak-empty"><p>No hay profesionales disponibles en ${escapeHtml(selection.branch.nombre)}.</p></div>`;
      return;
    }

    container.innerHTML = dentists.map((d) => {
      const fullName = `${d.nombre} ${d.apellido ?? ''}`.trim();
      const initials = fullName.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
      const specialty = d.especialidad || 'Odontología';
      const isSelected = selection.dentist?.id === d.id;

      const photoHtml = d.photo_url
        ? `<img src="${escapeHtml('/api' + d.photo_url)}"
                alt="${escapeHtml(fullName)}"
                style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : '';
      const avatarHtml = `<div class="ak-doctor-avatar"${d.photo_url ? ' style="display:none"' : ''}>${escapeHtml(initials)}</div>`;

      return `
        <div class="ak-doctor-option${isSelected ? ' selected' : ''}" data-id="${escapeHtml(String(d.id))}">
          <div class="ak-doctor-avatar-wrap">
            ${photoHtml}
            ${avatarHtml}
          </div>
          <div class="ak-doctor-info">
            <div class="ak-doctor-name">${escapeHtml(fullName)}</div>
            <div class="ak-doctor-spec">${escapeHtml(specialty)}</div>
          </div>
          <div class="ak-radio-dot${isSelected ? ' selected' : ''}">
            <div class="ak-radio-inner"></div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.ak-doctor-option').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        selection.dentist = dentists.find((d) => String(d.id) === id);
        next('date');
      });
    });
  } catch (err) {
    renderStepError(container, err);
  }
}

// ─── 3: Fecha ────────────────────────────────────────────────────────────────

function renderDateStep(container, selection, { next }) {
  if (!selection.dentist) return next('branch');

  const dates = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  while (dates.length < DEFAULT_SEARCH_DAYS) {
    if (cursor.getDay() !== 0) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  container.innerHTML = `
    <div class="ak-date-grid">
      ${dates.map((date) => {
        const iso   = date.toISOString().slice(0, 10);
        const dow   = date.toLocaleDateString('es-CO', { weekday: 'short' });
        const day   = date.getDate();
        const month = date.toLocaleDateString('es-CO', { month: 'short' }).replace('.', '');
        const isSelected = selection.date === iso;
        return `
          <button type="button" class="ak-date-card${isSelected ? ' selected' : ''}" data-date="${iso}">
            <div class="ak-date-dow">${escapeHtml(dow)}</div>
            <div class="ak-date-num">${day}</div>
            <div class="ak-date-mon">${escapeHtml(month)}</div>
          </button>
        `;
      }).join('')}
    </div>
  `;

  container.querySelectorAll('.ak-date-card').forEach((card) => {
    card.addEventListener('click', () => {
      selection.date = card.dataset.date;
      next('slot');
    });
  });
}

// ─── 4: Slot ─────────────────────────────────────────────────────────────────

async function renderSlotStep(container, selection, { next }) {
  if (!selection.date) return next('date');
  container.innerHTML = spinner({ text: 'Cargando horarios...' });

  try {
    const res = await api.getSlots({
      dentistId: selection.dentist.id,
      from: selection.date,
      to: selection.date,
    });
    const slots = res.data ?? [];

    if (slots.length === 0) {
      container.innerHTML = `
        <div class="ak-empty">
          <i class="ti ti-calendar-off" style="font-size:48px;color:var(--text3);margin-bottom:12px;"></i>
          <p>No hay horarios disponibles este día. Por favor elige otra fecha.</p>
        </div>
      `;
      return;
    }

    const morning   = slots.filter((s) => parseInt(s.hora_inicio.split(':')[0], 10) < 12);
    const afternoon = slots.filter((s) => parseInt(s.hora_inicio.split(':')[0], 10) >= 12);

    container.innerHTML = `
      ${morning.length   ? slotGroupHtml('Mañana',  morning,   selection.slot)  : ''}
      ${afternoon.length ? slotGroupHtml('Tarde',   afternoon, selection.slot)  : ''}
    `;

    container.querySelectorAll('.ak-slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selection.slot = slots.find((s) => s.hora_inicio === btn.dataset.hora) ?? null;
        if (selection.slot) next('confirm');
      });
    });
  } catch (err) {
    renderStepError(container, err);
  }
}

function slotGroupHtml(label, slots, selectedSlot) {
  return `
    <div class="ak-slot-group">
      <div class="ak-slot-label">${escapeHtml(label)}</div>
      <div class="ak-slot-grid">
        ${slots.map((s) => `
          <button type="button"
                  class="ak-slot-btn${selectedSlot?.hora_inicio === s.hora_inicio ? ' selected' : ''}"
                  data-hora="${escapeHtml(s.hora_inicio)}">
            ${escapeHtml(s.hora_inicio)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

// ─── 5: Confirmar ─────────────────────────────────────────────────────────────

function renderConfirmStep(container, selection, { finish, cancel, next }) {
  if (!selection.slot) return cancel();

  const dentistName = `${selection.dentist.nombre} ${selection.dentist.apellido ?? ''}`.trim();
  const fullDate = formatLongDate(selection.date);
  const duracion = selection.slot.duracion_minutos ?? 30;

  container.innerHTML = `
    <div class="ak-summary">
      <div class="ak-summary-row">
        <div class="ak-summary-label"><i class="ti ti-building-hospital"></i> Sede</div>
        <div class="ak-summary-value">${escapeHtml(selection.branch.nombre)}</div>
      </div>
      ${selection.branch.direccion ? `
        <div class="ak-summary-row">
          <div class="ak-summary-label"><i class="ti ti-map-pin"></i> Dirección</div>
          <div class="ak-summary-value">${escapeHtml(selection.branch.direccion)}</div>
        </div>
      ` : ''}
      <div class="ak-summary-row">
        <div class="ak-summary-label"><i class="ti ti-user-circle"></i> Profesional</div>
        <div class="ak-summary-value">${escapeHtml(dentistName)}</div>
      </div>
      ${selection.dentist.especialidad ? `
        <div class="ak-summary-row">
          <div class="ak-summary-label">Especialidad</div>
          <div class="ak-summary-value">${escapeHtml(selection.dentist.especialidad)}</div>
        </div>
      ` : ''}
      <div class="ak-summary-row">
        <div class="ak-summary-label"><i class="ti ti-calendar"></i> Fecha</div>
        <div class="ak-summary-value">${escapeHtml(fullDate)}</div>
      </div>
      <div class="ak-summary-row">
        <div class="ak-summary-label"><i class="ti ti-clock"></i> Hora</div>
        <div class="ak-summary-value">${escapeHtml(selection.slot.hora_inicio)} – ${escapeHtml(selection.slot.hora_fin)}</div>
      </div>
      <div class="ak-summary-row">
        <div class="ak-summary-label">Duración</div>
        <div class="ak-summary-value">${duracion} minutos</div>
      </div>
    </div>

    <div style="margin-top:20px;">
      <label style="font-size:13px;font-weight:500;color:var(--text2);display:block;margin-bottom:6px;">
        Motivo o notas (opcional)
      </label>
      <input type="text" id="notas-input" maxlength="200"
             class="ak-input" placeholder="Ej: Dolor muela inferior izquierda" autocomplete="off">
      <div style="font-size:12px;color:var(--text3);margin-top:4px;">Máx 200 caracteres.</div>
    </div>

    <div id="form-error" class="ak-form-error" style="display:none;"></div>

    <button type="button" class="ak-btn-primary" id="confirm-btn"
            style="width:100%;margin-top:20px;padding:16px;font-size:16px;">
      <i class="ti ti-check"></i> Confirmar y agendar
    </button>
  `;

  const notasInput = container.querySelector('#notas-input');
  const errorEl    = container.querySelector('#form-error');
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
    confirmBtn.innerHTML = '<i class="ti ti-loader-2"></i> Agendando…';
    selection.notas = notasInput.value.trim();

    try {
      await api.createBookingAppointment({
        dentistId: selection.dentist.id,
        branchId:  selection.branch.id,
        fecha:      selection.date,
        horaInicio: selection.slot.hora_inicio,
        horaFin:    selection.slot.hora_fin,
        notas:      selection.notas || undefined,
      });

      showModal({
        icon: '✅',
        title: '¡Cita agendada!',
        body: `Tu cita con ${dentistName} fue agendada para el ${fullDate} a las ${selection.slot.hora_inicio}. La verás en "Mis citas".`,
        actions: [{ label: 'Entendido', variant: 'primary', action: () => finish() }],
        dismissible: false,
      });
    } catch (err) {
      submitting = false;
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="ti ti-check"></i> Confirmar y agendar';

      if (err instanceof ApiError) {
        if (err.status === 409) {
          showError('Este horario ya no está disponible. Elige otro en 3 segundos…');
          setTimeout(() => { selection.slot = null; next('slot'); }, 3000);
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderStepError(container, err) {
  let msg = 'No pudimos cargar esta información.';
  if (err instanceof ApiError) {
    if (err.status === 401) msg = 'Tu sesión expiró. Por favor inicia sesión de nuevo.';
    else if (err.status === 503 || err.status === 504)
      msg = 'El sistema de gestión está temporalmente fuera de línea.';
  }
  container.innerHTML = `<div class="alert alert-error">${escapeHtml(msg)}</div>`;
}

function clearForwardSelections(selection, fromStep) {
  const idx = STEPS.indexOf(fromStep);
  if (idx <= STEPS.indexOf('dentist') - 1) selection.dentist = null;
  if (idx <= STEPS.indexOf('date')    - 1) selection.date    = null;
  if (idx <= STEPS.indexOf('slot')    - 1) selection.slot    = null;
  if (idx <= STEPS.indexOf('confirm') - 1) selection.notas   = '';
}

function formatLongDate(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
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
