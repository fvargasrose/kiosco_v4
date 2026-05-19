/**
 * Pantalla appointments — mis citas.
 *
 * Tabs: Próximas / Pasadas.
 *
 * En el Hito 7:
 *   - Cancelar: implementada de verdad contra el backend (POST /me/appointments/:id/cancel).
 *     Pide confirmación con modal de doble paso, refresca la lista al éxito.
 *   - Reagendar: SIGUE siendo informativa (queda para Hito 8 con selector
 *     de disponibilidad).
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { showModal } from '../components/modal.js';
import { toast } from '../components/toast.js';

export function renderAppointments(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  let currentTab = 'upcoming';

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Mis citas</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Volver
        </button>
      </header>
      <div class="screen-body">
        <div class="tabs">
          <button type="button" class="tab tab-active" data-tab="upcoming">Próximas</button>
          <button type="button" class="tab" data-tab="past">Pasadas</button>
        </div>
        <div id="list-container">${spinner({ text: 'Cargando citas...' })}</div>
      </div>
    </div>
  `;

  const listContainer = container.querySelector('#list-container');
  const tabs = Array.from(container.querySelectorAll('.tab'));

  const loadList = async (status) => {
    listContainer.innerHTML = spinner({ text: 'Cargando citas...' });
    try {
      const res = await api.getAppointments(status);
      renderList(listContainer, res.data ?? [], status, () => loadList(status), navigate);
    } catch (err) {
      renderError(listContainer, err);
    }
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
      currentTab = tab.dataset.tab;
      loadList(currentTab);
    });
  });

  container.querySelector('#back-btn').addEventListener('click', () => navigate('home'));

  loadList(currentTab);

  return null;
}

function renderList(container, items, status, onActionDone, navigate) {
  if (items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <p>${status === 'upcoming' ? 'No tienes citas próximas.' : 'No hay citas anteriores.'}</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `<div class="item-list">${items.map(renderItem).join('')}</div>`;

  // Wiring de acciones por cita
  container.querySelectorAll('.appointment-action').forEach((btn) => {
    btn.addEventListener('click', () => {
      const apt = items.find((a) => a.id === btn.dataset.id);
      if (!apt) return;
      handleAppointmentAction(apt, btn.dataset.action, onActionDone, navigate);
    });
  });
}

function renderItem(apt) {
  const dateStr = formatDate(apt.fecha);
  const timeStr = `${apt.hora_inicio} – ${apt.hora_fin}`;
  const estadoSafe = apt.estado.replace(/\s/g, '_');
  const badge = badgeFor(apt.estado);
  const isUpcoming = !['Cancelada', 'Atendida'].includes(apt.estado);

  const actions = isUpcoming
    ? `
        <button type="button" class="btn btn-secondary appointment-action"
                data-id="${escapeHtml(apt.id)}" data-action="cancel">
          Cancelar
        </button>
        <button type="button" class="btn btn-secondary appointment-action"
                data-id="${escapeHtml(apt.id)}" data-action="reschedule">
          Reagendar
        </button>
      `
    : '';

  return `
    <div class="item-card estado-${escapeHtml(estadoSafe)}">
      <div class="item-info">
        <div class="item-title">${escapeHtml(apt.tratamiento ?? 'Cita odontológica')}</div>
        <div class="item-meta">
          📅 ${escapeHtml(dateStr)} · 🕐 ${escapeHtml(timeStr)}<br>
          👨‍⚕️ ${escapeHtml(apt.dentista ?? 'Por asignar')}<br>
          📍 ${escapeHtml(apt.sucursal ?? '')}
        </div>
      </div>
      <div class="item-aside">
        <span class="item-badge ${badge.cls}">${escapeHtml(apt.estado)}</span>
        <div class="item-actions">${actions}</div>
      </div>
    </div>
  `;
}

/**
 * Maneja clicks en botones de acción de cita.
 *
 * - 'cancel': muestra confirmación + (al confirmar) llama al backend.
 * - 'reschedule': explica el flujo (= crear cita nueva, opcionalmente cancelar
 *   la actual) y navega a booking.
 */
function handleAppointmentAction(apt, action, refreshList, navigate) {
  if (action === 'reschedule') {
    // En el Hito 8 decidimos: reagendar = crear cita nueva (independiente).
    // El paciente decide si quiere cancelar la cita actual o mantenerla.
    showModal({
      icon: '📅',
      title: 'Reagendar cita',
      body: `Para reagendar, vamos a crear una cita nueva. Si quieres cancelar la actual del ${formatDate(apt.fecha)} a las ${apt.hora_inicio}, puedes hacerlo desde "Mis citas" después.`,
      actions: [
        {
          label: 'Cancelar',
          variant: 'secondary',
          action: () => {},
        },
        {
          label: 'Agendar nueva',
          variant: 'primary',
          action: () => navigate('booking'),
        },
      ],
      dismissible: false,
    });
    return;
  }

  // === Cancelar: dos pasos para evitar cancelaciones accidentales ===
  showModal({
    icon: '⚠️',
    title: '¿Cancelar esta cita?',
    body: `Vas a cancelar tu cita del ${formatDate(apt.fecha)} a las ${apt.hora_inicio} con ${apt.dentista ?? 'tu dentista'}. Esta acción no se puede deshacer desde el kiosco.`,
    actions: [
      {
        label: 'No, mantener cita',
        variant: 'secondary',
        action: () => {},
      },
      {
        label: 'Sí, cancelar',
        variant: 'danger',
        action: () => doCancelAppointment(apt, refreshList),
      },
    ],
    dismissible: false,
  });
}

/**
 * Ejecuta la cancelación contra el backend.
 * Muestra un modal de "procesando" mientras corre, y al finalizar
 * muestra el resultado y refresca la lista.
 */
async function doCancelAppointment(apt, refreshList) {
  // Modal de loading no-dismissible
  const loadingModal = showModal({
    icon: '⏳',
    title: 'Cancelando cita…',
    body: 'Por favor espera un momento.',
    actions: [],
    dismissible: false,
  });

  try {
    await api.cancelAppointment(apt.id);
    loadingModal.close();

    showModal({
      icon: '✅',
      title: 'Cita cancelada',
      body: `Tu cita del ${formatDate(apt.fecha)} ha sido cancelada. Recibirás una confirmación por mensaje si tu clínica tiene notificaciones activas.`,
      actions: [{ label: 'Entendido', variant: 'primary', action: () => {} }],
      dismissible: true,
    });

    // Refrescar la lista para mostrar el nuevo estado
    if (refreshList) refreshList();
  } catch (err) {
    loadingModal.close();

    let title = 'No pudimos cancelar la cita';
    let body = 'Por favor intenta de nuevo o acude a recepción.';

    if (err instanceof ApiError) {
      if (err.status === 409) {
        title = 'Esta cita ya no se puede cancelar';
        body =
          err.body?.message ??
          'Es posible que ya esté cancelada, ya haya sido atendida, o que el horario haya pasado.';
      } else if (err.status === 404) {
        title = 'Cita no encontrada';
        body = 'No pudimos encontrar esta cita. Refresca la lista e intenta de nuevo.';
      } else if (err.status === 401) {
        title = 'Sesión expirada';
        body = 'Por favor inicia sesión de nuevo.';
      } else if (err.status === 503 || err.status === 504) {
        title = 'Servicio no disponible';
        body =
          'El sistema de gestión está temporalmente fuera de línea. Intenta más tarde o acude a recepción.';
      }
    } else {
      toast('Error de conexión.', 'error');
    }

    showModal({
      icon: '⚠️',
      title,
      body,
      actions: [{ label: 'Entendido', variant: 'primary', action: () => {} }],
      dismissible: true,
    });

    // Refrescar la lista de todos modos por si el estado real cambió
    if (refreshList) refreshList();
  }
}

function renderError(container, err) {
  let msg = 'No pudimos cargar tus citas.';
  if (err instanceof ApiError) {
    if (err.status === 401) {
      msg = 'Tu sesión expiró. Por favor vuelve a iniciar sesión.';
    } else if (err.status === 503 || err.status === 504) {
      msg = 'El sistema de gestión está temporalmente fuera de línea. Intenta más tarde.';
    }
  }
  container.innerHTML = `
    <div class="alert alert-error">${escapeHtml(msg)}</div>
  `;
  toast(msg, 'error');
}

function badgeFor(estado) {
  if (estado === 'Confirmada') return { cls: 'badge-success' };
  if (estado === 'Cancelada') return { cls: 'badge-danger' };
  if (estado === 'Atendida') return { cls: '' };
  return { cls: 'badge-warning' };
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  const [y, m, d] = yyyymmdd.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
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
    .replace(/"/g, '&quot;');
}
