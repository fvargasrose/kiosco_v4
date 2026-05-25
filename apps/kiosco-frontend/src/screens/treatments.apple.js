import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { toast } from '../components/toast.js';
import { renderAppleShell } from './shared/shell.apple.js';

export function renderTreatmentsApple(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  renderAppleShell(container, 'treatments', navigate, (main) => {
    main.innerHTML = `
      <div class="ak-page-header">
        <div>
          <div class="ak-page-title">Mis tratamientos</div>
          <div class="ak-page-subtitle">Historial y saldos pendientes</div>
        </div>
      </div>
      <div id="content">${spinner({ text: 'Cargando tratamientos...' })}</div>
    `;

    const content = main.querySelector('#content');

    api.getTreatments('all')
      .then((res) => renderContent(content, res, navigate))
      .catch((err) => renderError(content, err));
  });

  return null;
}

// ─── Content ─────────────────────────────────────────────────────────────────

function renderContent(container, res, navigate) {
  const items = res.data ?? [];
  const tot = res.totales ?? { total: 0, abonado: 0, saldo_pendiente: 0 };

  container.innerHTML = `
    <div class="ak-stat-grid">
      <div class="ak-stat-card">
        <div class="ak-stat-label">Saldo pendiente</div>
        <div class="ak-stat-value" style="color:var(--color-warning);">
          ${formatCop(tot.saldo_pendiente)}
        </div>
        <div class="ak-stat-sub">Total adeudado</div>
      </div>
      <div class="ak-stat-card">
        <div class="ak-stat-label">Total pagado</div>
        <div class="ak-stat-value" style="color:var(--color-success);">
          ${formatCop(tot.abonado)}
        </div>
        <div class="ak-stat-sub">Abonos acumulados</div>
      </div>
      <div class="ak-stat-card">
        <div class="ak-stat-label">Tratamientos</div>
        <div class="ak-stat-value" style="color:var(--accent);">
          ${items.length}
        </div>
        <div class="ak-stat-sub">En historial</div>
      </div>
    </div>

    <div class="ak-section-title" style="margin-top:24px;margin-bottom:12px;">
      Detalle de tratamientos
    </div>

    ${items.length
      ? items.map(renderTreatmentRow).join('')
      : `<div class="ak-empty">
           <i class="ti ti-tooth" style="font-size:48px;color:var(--text3);margin-bottom:12px;"></i>
           <p>No tienes tratamientos registrados todavía.</p>
         </div>`
    }
  `;

  container.querySelectorAll('.treatment-pay-btn').forEach((btn) => {
    const tx = (res.data ?? []).find((t) => t.id === btn.dataset.id);
    if (!tx || tx.saldo_pendiente <= 0) return;
    btn.addEventListener('click', () =>
      navigate('payment', {
        treatmentId: tx.id,
        amountCop: tx.saldo_pendiente,
        description: `Abono ${tx.nombre}`,
        returnTo: 'treatments',
      }),
    );
  });
}

function renderTreatmentRow(t) {
  const hasPending = t.saldo_pendiente > 0;
  const badge = hasPending ? 'badge-orange' : 'badge-green';
  const inicio = t.fecha_inicio ? formatDate(t.fecha_inicio) : '—';
  const fin    = t.fecha_fin    ? formatDate(t.fecha_fin)    : '';
  const periodo = fin ? `${inicio} → ${fin}` : `Desde ${inicio}`;

  return `
    <div class="ak-payment-row">
      <div class="ak-payment-left">
        <div class="ak-payment-name">${escapeHtml(t.nombre)}</div>
        <div class="ak-payment-date">${escapeHtml(periodo)}</div>
        <span class="ak-badge ${badge}">${escapeHtml(t.estado ?? '')}</span>
      </div>
      <div class="ak-payment-right">
        <div class="ak-payment-amount">
          ${hasPending
            ? `<span style="color:var(--color-warning);">${formatCop(t.saldo_pendiente)}</span>
               <small style="display:block;color:var(--text2);font-size:11px;">saldo</small>`
            : `<span style="color:var(--color-success);">Al día</span>`}
        </div>
        ${hasPending
          ? `<button type="button" class="ak-btn-primary treatment-pay-btn"
                     data-id="${escapeHtml(t.id)}" style="margin-top:8px;padding:8px 16px;font-size:13px;">
               <i class="ti ti-credit-card"></i> Pagar
             </button>`
          : ''}
      </div>
    </div>
  `;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderError(container, err) {
  let msg = 'No pudimos cargar tus tratamientos.';
  if (err instanceof ApiError) {
    if (err.status === 401) msg = 'Tu sesión expiró. Por favor vuelve a iniciar sesión.';
    else if (err.status === 503 || err.status === 504)
      msg = 'El sistema de gestión está temporalmente fuera de línea.';
  }
  container.innerHTML = `<div class="alert alert-error">${escapeHtml(msg)}</div>`;
  toast(msg, 'error');
}

function formatCop(amount) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', maximumFractionDigits: 0,
  }).format(amount ?? 0);
}

function formatDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-CO', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
