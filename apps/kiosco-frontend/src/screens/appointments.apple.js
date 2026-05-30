import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { showModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { renderAppleShell } from './shared/shell.apple.js';

export function renderAppointmentsApple(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  renderAppleShell(container, 'appointments', navigate, (main) => {
    let currentTab = 'upcoming';

    main.innerHTML = `
      <div class="ak-page-header">
        <div>
          <div class="ak-page-title">Mis citas</div>
          <div class="ak-page-subtitle">Consulta y gestiona tus visitas</div>
        </div>
        <button type="button" class="ak-btn-primary" id="new-apt-btn">
          <i class="ti ti-calendar-plus"></i> Nueva cita
        </button>
      </div>

      <div class="tabs" style="margin-bottom:20px;">
        <button type="button" class="tab tab-active" data-tab="upcoming">Próximas</button>
        <button type="button" class="tab" data-tab="past">Pasadas</button>
      </div>

      <div id="list-container">${spinner({ text: 'Cargando citas...' })}</div>
    `;

    main.querySelector('#new-apt-btn').addEventListener('click', () => navigate('booking'));

    const listContainer = main.querySelector('#list-container');
    const tabs = Array.from(main.querySelectorAll('.tab'));

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

    loadList(currentTab);
  });

  return null;
}

// ─── List renderer ───────────────────────────────────────────────────────────

function renderList(container, items, status, onActionDone, navigate) {
  if (items.length === 0) {
    container.innerHTML = `
      <div class="ak-empty">
        <i class="ti ti-calendar-off" style="font-size:48px;color:var(--text3);margin-bottom:12px;"></i>
        <p>${status === 'upcoming' ? 'No tienes citas próximas.' : 'No hay citas anteriores.'}</p>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(renderCitaCard).join('');

  container.querySelectorAll('.ak-cita-card[data-id]').forEach((card) => {
    const apt = items.find((a) => String(a.id) === card.dataset.id);
    if (!apt) return;
    const isPast = ['Cancelada', 'Atendida', 'Anulado', 'No asistió'].includes(apt.estado ?? '');
    if (!isPast) {
      card.addEventListener('click', () =>
        handleAppointmentAction(apt, onActionDone, navigate),
      );
    }
  });
}

function renderCitaCard(apt) {
  const isPast = ['Cancelada', 'Atendida', 'Anulado', 'No asistió'].includes(apt.estado ?? '');
  const { day, month } = parseDateParts(apt.fecha);
  const badge = badgeFor(apt.estado);

  return `
    <div class="ak-cita-card${isPast ? ' past' : ''}" data-id="${escapeHtml(String(apt.id))}">
      <div class="ak-date-box${isPast ? ' gray' : ''}">
        <div class="ak-date-day">${day}</div>
        <div class="ak-date-month">${month}</div>
      </div>
      <div class="ak-cita-info">
        <div class="ak-cita-title">${escapeHtml(apt.tratamiento ?? 'Cita odontológica')}</div>
        <div class="ak-cita-detail">
          <i class="ti ti-user-circle" style="font-size:13px;"></i>
          ${escapeHtml(apt.dentista ?? 'Por asignar')}
          &nbsp;·&nbsp;
          <i class="ti ti-clock" style="font-size:13px;"></i>
          ${escapeHtml(apt.hora_inicio ?? '')}
        </div>
        <div class="ak-cita-meta">
          <i class="ti ti-map-pin" style="font-size:13px;"></i>
          ${escapeHtml(apt.sucursal ?? '')}
        </div>
        <span class="ak-badge ${badge}">${escapeHtml(apt.estado ?? '')}</span>
      </div>
      ${!isPast ? '<i class="ti ti-chevron-right ak-cita-chevron"></i>' : ''}
    </div>
  `;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

function handleAppointmentAction(apt, refreshList, navigate) {
  showModal({
    icon: '📅',
    title: 'Opciones de cita',
    body: `Cita del ${formatDate(apt.fecha)} a las ${apt.hora_inicio} con ${apt.dentista ?? 'tu dentista'}.`,
    actions: [
      {
        label: 'Reagendar',
        variant: 'secondary',
        action: () => showModal({
          icon: '📅',
          title: 'Reagendar cita',
          body: `Para reagendar crearemos una cita nueva. Si quieres cancelar la actual del ${formatDate(apt.fecha)} a las ${apt.hora_inicio}, puedes hacerlo después desde "Mis citas".`,
          actions: [
            { label: 'Cancelar', variant: 'secondary', action: () => {} },
            { label: 'Agendar nueva', variant: 'primary', action: () => navigate('booking') },
          ],
          dismissible: false,
        }),
      },
      {
        label: 'Cancelar cita',
        variant: 'danger',
        action: () => confirmCancel(apt, refreshList),
      },
    ],
    dismissible: true,
  });
}

function confirmCancel(apt, refreshList) {
  showModal({
    icon: '⚠️',
    title: '¿Cancelar esta cita?',
    body: `Vas a cancelar tu cita del ${formatDate(apt.fecha)} a las ${apt.hora_inicio} con ${apt.dentista ?? 'tu dentista'}. Esta acción no se puede deshacer desde el kiosco.`,
    actions: [
      { label: 'No, mantener', variant: 'secondary', action: () => {} },
      { label: 'Sí, cancelar', variant: 'danger', action: () => doCancelAppointment(apt, refreshList) },
    ],
    dismissible: false,
  });
}

async function doCancelAppointment(apt, refreshList) {
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
      body: `Tu cita del ${formatDate(apt.fecha)} ha sido cancelada.`,
      actions: [{ label: 'Entendido', variant: 'primary', action: () => {} }],
      dismissible: true,
    });
    if (refreshList) refreshList();
  } catch (err) {
    loadingModal.close();
    let title = 'No pudimos cancelar la cita';
    let body  = 'Por favor intenta de nuevo o acude a recepción.';

    if (err instanceof ApiError) {
      if (err.status === 409) {
        title = 'Esta cita ya no se puede cancelar';
        body  = err.body?.message ?? 'Es posible que ya esté cancelada o ya haya sido atendida.';
      } else if (err.status === 400) {
        title = 'No se pudo cancelar';
        body  = 'El sistema de gestión rechazó la operación. Por favor acude a recepción.';
      } else if (err.status === 404) {
        title = 'Cita no encontrada';
        body  = 'No pudimos encontrar esta cita. Refresca la lista e intenta de nuevo.';
      } else if (err.status === 401) {
        title = 'Sesión expirada';
        body  = 'Por favor inicia sesión de nuevo.';
      } else if (err.status === 503 || err.status === 504) {
        title = 'Servicio no disponible';
        body  = 'El sistema de gestión está temporalmente fuera de línea. Intenta más tarde.';
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
    if (refreshList) refreshList();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderError(container, err) {
  let msg = 'No pudimos cargar tus citas.';
  if (err instanceof ApiError) {
    if (err.status === 401) msg = 'Tu sesión expiró. Por favor vuelve a iniciar sesión.';
    else if (err.status === 503 || err.status === 504)
      msg = 'El sistema de gestión está temporalmente fuera de línea.';
  }
  container.innerHTML = `<div class="alert alert-error">${escapeHtml(msg)}</div>`;
  toast(msg, 'error');
}

function badgeFor(estado) {
  if (estado === 'Confirmada') return 'badge-green';
  if (estado === 'Reservada') return 'badge-green';
  if (estado === 'Pendiente') return 'badge-orange';
  if (estado === 'Cancelada' || estado === 'Anulado') return 'badge-red';
  if (estado === 'Atendida') return 'badge-gray';
  return 'badge-gray';
}

function parseDateParts(yyyymmdd) {
  if (!yyyymmdd) return { day: '--', month: '---' };
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return {
    day:   date.getDate(),
    month: date.toLocaleDateString('es-CO', { month: 'short' }).replace('.', '').toUpperCase(),
  };
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd) return '';
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
    .replace(/"/g, '&quot;');
}
