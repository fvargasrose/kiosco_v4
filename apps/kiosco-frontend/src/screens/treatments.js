/**
 * Pantalla treatments — mis tratamientos y saldos.
 *
 * Muestra summary (total, abonado, saldo) + lista detallada.
 * Saldos pendientes muestran banner informativo (en Hito 7 podrá procesarse pago).
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { toast } from '../components/toast.js';

export function renderTreatments(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Mis tratamientos</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Volver
        </button>
      </header>
      <div class="screen-body">
        <div id="content">${spinner({ text: 'Cargando tratamientos...' })}</div>
      </div>
    </div>
  `;

  const content = container.querySelector('#content');

  const load = async () => {
    try {
      const res = await api.getTreatments('all');
      renderContent(content, res);
    } catch (err) {
      renderError(content, err);
    }
  };

  container.querySelector('#back-btn').addEventListener('click', () => navigate('home'));

  load();
  return null;
}

function renderContent(container, res) {
  const items = res.data ?? [];
  const tot = res.totales ?? { total: 0, abonado: 0, saldo_pendiente: 0 };

  const summaryHtml = `
    <div class="summary-card">
      <div class="summary-item">
        <h4>Total tratamientos</h4>
        <div class="amount muted">${formatCop(tot.total)}</div>
      </div>
      <div class="summary-item">
        <h4>Abonado</h4>
        <div class="amount">${formatCop(tot.abonado)}</div>
      </div>
      <div class="summary-item">
        <h4>Saldo pendiente</h4>
        <div class="amount">${formatCop(tot.saldo_pendiente)}</div>
      </div>
    </div>
  `;

  const paymentBanner =
    tot.saldo_pendiente > 0
      ? `
        <div class="alert alert-info">
          💳 Tienes un saldo pendiente de <strong>${formatCop(tot.saldo_pendiente)}</strong>.
          Acércate a recepción para realizar el pago.
          <small>(Pago en línea desde el kiosco disponible próximamente.)</small>
        </div>
      `
      : '';

  const listHtml = items.length
    ? `<div class="item-list">${items.map(renderTreatment).join('')}</div>`
    : `
        <div class="empty-state">
          <div class="empty-state-icon">🦷</div>
          <p>No tienes tratamientos registrados todavía.</p>
        </div>
      `;

  container.innerHTML = summaryHtml + paymentBanner + listHtml;
}

function renderTreatment(t) {
  const inicio = t.fecha_inicio ? formatDate(t.fecha_inicio) : '—';
  const fin = t.fecha_fin ? formatDate(t.fecha_fin) : '';
  const periodo = fin ? `${inicio} → ${fin}` : `Desde ${inicio}`;
  const badge = t.saldo_pendiente > 0 ? 'badge-warning' : 'badge-success';
  const estadoEscaped = escapeHtml(t.estado);

  return `
    <div class="item-card">
      <div class="item-info">
        <div class="item-title">${escapeHtml(t.nombre)}</div>
        <div class="item-meta">
          📅 ${escapeHtml(periodo)}<br>
          Total: <strong>${formatCop(t.total)}</strong> ·
          Abonado: ${formatCop(t.abonado)} ·
          Saldo: <strong>${formatCop(t.saldo_pendiente)}</strong>
        </div>
      </div>
      <div class="item-aside">
        <span class="item-badge ${badge}">${estadoEscaped}</span>
      </div>
    </div>
  `;
}

function renderError(container, err) {
  let msg = 'No pudimos cargar tus tratamientos.';
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

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
