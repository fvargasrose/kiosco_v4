/**
 * Pantalla treatments — estado de cuenta del paciente.
 *
 * Header azul + 3 tarjetas de totales (Total / Abonado / Saldo) + una tarjeta
 * por tratamiento con barra de progreso y botón Pagar. Tratamientos pagados
 * van al final como tarjetas grises compactas.
 *
 * Contrato con payment.js (NO tocar): navigate('payment', {treatmentId,
 * amountCop, description, returnTo}).
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { toast } from '../components/toast.js';

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function renderTreatments(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Estado de cuenta</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Volver
        </button>
      </header>
      <div class="screen-body">
        <div id="content">${spinner({ text: 'Cargando estado de cuenta...' })}</div>
      </div>
    </div>
  `;

  const content = container.querySelector('#content');

  const load = async () => {
    try {
      const res = await api.getTreatments('all');
      renderContent(content, res, navigate);
    } catch (err) {
      renderError(content, err);
    }
  };

  container.querySelector('#back-btn').addEventListener('click', () => navigate('home'));

  load();
  return null;
}

function renderContent(container, res, navigate) {
  const items = res.data ?? [];
  const tot = res.totales ?? { total: 0, abonado: 0, saldo_pendiente: 0 };

  const patientName = state.patient?.name ?? state.patient?.nombre ?? 'Paciente';
  const today = todayLongEs();

  // Pendientes primero, finalizados al final
  const pending = items.filter((t) => Number(t.saldo_pendiente) > 0);
  const paid = items.filter((t) => Number(t.saldo_pendiente) <= 0);

  container.innerHTML = `
    <div class="account-screen">
      ${headerHtml(patientName, today)}
      <div class="account-section-title">Resumen de Pagos</div>
      ${summaryCardsHtml(tot)}
      ${treatmentsBlockHtml(pending, paid)}
      ${footerHtml()}
    </div>
  `;

  // Wiring de botones "Pagar"
  container.querySelectorAll('.treatment-pay').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tx = items.find((t) => String(t.id) === btn.dataset.id);
      if (!tx || Number(tx.saldo_pendiente) <= 0) return;
      navigate('payment', {
        treatmentId: tx.id,
        amountCop: tx.saldo_pendiente,
        description: `Abono ${tx.nombre}`,
        returnTo: 'treatments',
      });
    });
  });
}

// =============================================================================
// Renderers parciales
// =============================================================================

function headerHtml(name, dateLabel) {
  const initial = (name.trim()[0] ?? '👤').toUpperCase();
  return `
    <div class="account-header">
      <div class="account-patient">
        <div class="account-avatar" aria-hidden="true">${escapeHtml(initial)}</div>
        <div class="account-patient-info">
          <h2>${escapeHtml(name)}</h2>
          <p>Bienvenido(a) a tu estado de cuenta</p>
        </div>
      </div>
      <div class="account-date">
        <div class="account-date-icon" aria-hidden="true">📅</div>
        <div class="account-date-label">Estado de cuenta</div>
        <div class="account-date-value">${escapeHtml(dateLabel)}</div>
      </div>
    </div>
  `;
}

function summaryCardsHtml(tot) {
  return `
    <div class="account-summary-cards">
      ${summaryCardHtml('blue', 'TOTAL TRATAMIENTOS', tot.total, 'Valor acumulado de tus tratamientos')}
      ${summaryCardHtml('green', 'ABONADO', tot.abonado, 'Lo que has pagado hasta hoy')}
      ${summaryCardHtml('orange', 'SALDO PENDIENTE', tot.saldo_pendiente, 'Lo que aún debes a la clínica')}
    </div>
  `;
}

function summaryCardHtml(variant, title, amount, subtitle) {
  return `
    <div class="account-card account-card--${variant}">
      <div class="account-card-header">${escapeHtml(title)}</div>
      <div class="account-card-body">
        <div class="account-card-amount">${formatCop(amount)}</div>
        <div class="account-card-subtitle">${escapeHtml(subtitle)}</div>
      </div>
    </div>
  `;
}

function treatmentsBlockHtml(pending, paid) {
  if (pending.length === 0 && paid.length === 0) {
    return `
      <div class="account-section-title">Mis tratamientos</div>
      <div class="empty-state">
        <div class="empty-state-icon">🦷</div>
        <p>No tienes tratamientos registrados todavía.</p>
      </div>
    `;
  }

  let html = '';
  if (pending.length > 0) {
    html += `<div class="account-section-title">Tratamientos con saldo</div>`;
    html += pending.map(activeTreatmentCardHtml).join('');
  }
  if (paid.length > 0) {
    html += `<div class="account-section-title account-section-title--muted">Finalizados</div>`;
    html += paid.map(paidTreatmentCardHtml).join('');
  }
  return html;
}

function activeTreatmentCardHtml(t) {
  const total = Number(t.total) || 0;
  const abonado = Number(t.abonado) || 0;
  const saldo = Number(t.saldo_pendiente) || 0;
  const pct = total > 0 ? Math.min(100, Math.round((abonado / total) * 100)) : 0;
  const periodo = formatPeriodo(t);

  return `
    <div class="treatment-card">
      <div class="treatment-card-head">
        <div>
          <div class="treatment-card-name">${escapeHtml(t.nombre)}</div>
          ${periodo ? `<div class="treatment-card-period">📅 ${escapeHtml(periodo)}</div>` : ''}
        </div>
        <span class="treatment-card-badge treatment-card-badge--active">${escapeHtml(t.estado || 'En curso')}</span>
      </div>

      <div class="treatment-card-summary">
        <div class="summary-box">
          <h4>Valor total</h4>
          <div class="summary-box-value summary-box-value--blue">${formatCop(total)}</div>
        </div>
        <div class="summary-box">
          <h4>Abonado</h4>
          <div class="summary-box-value summary-box-value--green">${formatCop(abonado)}</div>
        </div>
        <div class="summary-box">
          <h4>Saldo pendiente</h4>
          <div class="summary-box-value summary-box-value--orange">${formatCop(saldo)}</div>
        </div>
      </div>

      <div class="treatment-progress-area">
        <div class="treatment-progress-label">Avance financiero del tratamiento</div>
        <div class="treatment-progress-bar">
          <div class="treatment-progress-fill" style="width: ${pct}%"></div>
        </div>
        <div class="treatment-progress-percent">${pct}%</div>
      </div>

      <button type="button" class="btn btn-primary btn-lg btn-full treatment-pay"
              data-id="${escapeHtml(String(t.id))}">
        💳 Pagar ahora ${formatCop(saldo)}
      </button>
    </div>
  `;
}

function paidTreatmentCardHtml(t) {
  const total = Number(t.total) || 0;
  const periodo = formatPeriodo(t);
  return `
    <div class="treatment-card treatment-card--paid">
      <div class="treatment-card-paid-icon" aria-hidden="true">✓</div>
      <div class="treatment-card-paid-body">
        <div class="treatment-card-name">${escapeHtml(t.nombre)}</div>
        ${periodo ? `<div class="treatment-card-period">${escapeHtml(periodo)}</div>` : ''}
      </div>
      <div class="treatment-card-paid-amount">${formatCop(total)}</div>
      <div class="treatment-card-paid-label">Pagado</div>
    </div>
  `;
}

function footerHtml() {
  return `
    <div class="account-footer">
      <div class="account-recommendation">
        <div class="account-recommendation-title">💡 Recomendación</div>
        <p>Realiza tus abonos antes de la fecha límite acordada con la clínica para evitar generar nuevas cuotas vencidas. Si tienes dudas sobre tu plan de pagos, acércate a recepción.</p>
      </div>
    </div>
  `;
}

function renderError(container, err) {
  let msg = 'No pudimos cargar tu estado de cuenta.';
  if (err instanceof ApiError) {
    if (err.status === 401) {
      msg = 'Tu sesión expiró. Por favor vuelve a iniciar sesión.';
    } else if (err.status === 503 || err.status === 504) {
      msg = 'El sistema de gestión está temporalmente fuera de línea.';
    }
  }
  container.innerHTML = `<div class="alert alert-error">${escapeHtml(msg)}</div>`;
  toast(msg, 'error');
}

// =============================================================================
// Utils
// =============================================================================

function formatPeriodo(t) {
  const inicio = t.fecha_inicio ? formatDate(t.fecha_inicio) : '';
  const fin = t.fecha_fin ? formatDate(t.fecha_fin) : '';
  if (inicio && fin) return `${inicio} → ${fin}`;
  if (inicio) return `Desde ${inicio}`;
  return '';
}

function formatCop(amount) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(amount ?? 0);
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  const [y, m, d] = yyyymmdd.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function todayLongEs() {
  const d = new Date();
  return `${d.getDate()} de ${MONTHS_ES[d.getMonth()]} de ${d.getFullYear()}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
