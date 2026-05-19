import { api, ApiError } from '../api.js';

const STATUS_LABELS = {
  pending:  { label: 'Pendiente',  css: 'badge-warn'    },
  approved: { label: 'Aprobado',   css: 'badge-success' },
  declined: { label: 'Rechazado',  css: 'badge-error'   },
  voided:   { label: 'Anulado',    css: 'badge-error'   },
  error:    { label: 'Error',      css: 'badge-error'   },
  expired:  { label: 'Expirado',   css: 'badge-muted'   },
};

const METHOD_LABELS = {
  NEQUI:    'Nequi',
  PSE:      'PSE',
  CARD:     'Tarjeta',
  BANCOLOMBIA_TRANSFER: 'Bancolombia',
};

// Estado de filtros actual
let _filters = { status: '', date_from: '', date_to: '', page: 1 };

export async function renderTransactions(container) {
  _filters = { status: '', date_from: '', date_to: '', page: 1 };
  container.innerHTML = `<div class="loading"><div class="spinner"></div> Cargando transacciones...</div>`;
  await buildShell(container);
}

async function buildShell(container) {
  container.innerHTML = `
    <h1 class="page-title">Transacciones</h1>

    <div style="display:flex;flex-wrap:wrap;gap:.75rem;align-items:flex-end;margin-bottom:1.5rem">
      <!-- Filtro estado -->
      <div>
        <label style="display:block;font-size:.8125rem;font-weight:500;margin-bottom:.25rem">Estado</label>
        <select id="filter-status" class="form-input" style="min-width:140px">
          <option value="">Todos</option>
          <option value="pending">Pendiente</option>
          <option value="approved">Aprobado</option>
          <option value="declined">Rechazado</option>
          <option value="voided">Anulado</option>
          <option value="expired">Expirado</option>
          <option value="error">Error</option>
        </select>
      </div>
      <!-- Filtro desde -->
      <div>
        <label style="display:block;font-size:.8125rem;font-weight:500;margin-bottom:.25rem">Desde</label>
        <input id="filter-from" type="date" class="form-input">
      </div>
      <!-- Filtro hasta -->
      <div>
        <label style="display:block;font-size:.8125rem;font-weight:500;margin-bottom:.25rem">Hasta</label>
        <input id="filter-to" type="date" class="form-input">
      </div>
      <button class="btn btn-primary" id="btn-filter" style="margin-bottom:2px">Filtrar</button>
      <button class="btn btn-secondary" id="btn-clear-filter" style="margin-bottom:2px">Limpiar</button>
    </div>

    <div id="tx-summary" style="margin-bottom:1rem"></div>
    <div id="tx-table-wrap"></div>
    <div id="tx-pagination" style="margin-top:1rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap"></div>
  `;

  const btnFilter = container.querySelector('#btn-filter');
  const btnClear  = container.querySelector('#btn-clear-filter');

  btnFilter.addEventListener('click', () => {
    _filters.status    = container.querySelector('#filter-status').value;
    _filters.date_from = container.querySelector('#filter-from').value;
    _filters.date_to   = container.querySelector('#filter-to').value;
    _filters.page      = 1;
    loadData(container);
  });

  btnClear.addEventListener('click', () => {
    _filters = { status: '', date_from: '', date_to: '', page: 1 };
    container.querySelector('#filter-status').value = '';
    container.querySelector('#filter-from').value   = '';
    container.querySelector('#filter-to').value     = '';
    loadData(container);
  });

  await loadData(container);
}

async function loadData(container) {
  const tableWrap  = container.querySelector('#tx-table-wrap');
  const summaryEl  = container.querySelector('#tx-summary');
  const paginEl    = container.querySelector('#tx-pagination');

  tableWrap.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  summaryEl.innerHTML = '';
  paginEl.innerHTML   = '';

  let res;
  try {
    res = await api.getTransactions({
      status:    _filters.status    || undefined,
      date_from: _filters.date_from || undefined,
      date_to:   _filters.date_to   || undefined,
      page:      _filters.page,
      per_page:  20,
    });
  } catch (err) {
    const msg = err instanceof ApiError ? `Error ${err.status}` : 'Error al cargar transacciones.';
    tableWrap.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
    return;
  }

  const { data, total, page, pages } = res;

  // Resumen
  const approved = data.filter((t) => t.status === 'approved');
  const totalApproved = approved.reduce((s, t) => s + t.amount_cop, 0);
  summaryEl.innerHTML = `
    <div style="display:flex;gap:1.5rem;flex-wrap:wrap;font-size:.875rem;color:var(--muted)">
      <span><strong style="color:var(--text)">${total}</strong> transacciones encontradas</span>
      ${approved.length > 0
        ? `<span><strong style="color:var(--success)">${approved.length} aprobadas</strong> · ${fmtCOP(totalApproved)}</span>`
        : ''
      }
    </div>
  `;

  // Tabla
  if (data.length === 0) {
    tableWrap.innerHTML = `<div class="alert alert-warn">No hay transacciones con los filtros aplicados.</div>`;
  } else {
    tableWrap.innerHTML = txTableHtml(data);
  }

  // Paginación
  if (pages > 1) {
    paginEl.innerHTML = paginHtml(page, pages);
    paginEl.querySelectorAll('.btn-page').forEach((btn) => {
      btn.addEventListener('click', () => {
        _filters.page = parseInt(btn.dataset.page, 10);
        loadData(container);
      });
    });
  }
}

function txTableHtml(rows) {
  return `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:.875rem">
        <thead>
          <tr style="border-bottom:2px solid var(--border);text-align:left">
            <th style="padding:.6rem 1rem .6rem 0;font-weight:600">Referencia</th>
            <th style="padding:.6rem 1rem;font-weight:600">Paciente</th>
            <th style="padding:.6rem 1rem;font-weight:600">Monto</th>
            <th style="padding:.6rem 1rem;font-weight:600">Estado</th>
            <th style="padding:.6rem 1rem;font-weight:600">Método</th>
            <th style="padding:.6rem 1rem;font-weight:600">Kiosco</th>
            <th style="padding:.6rem 1rem;font-weight:600">Fecha</th>
            <th style="padding:.6rem 1rem;font-weight:600">Comprobante</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(txRowHtml).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function txRowHtml(t) {
  const st = STATUS_LABELS[t.status] ?? { label: t.status, css: 'badge-muted' };
  const method = METHOD_LABELS[t.wompi_payment_method_type] ?? (t.wompi_payment_method_type ?? '—');
  const patient = t.patient_email_masked || t.patient_phone_masked || t.dentalink_patient_id;
  const receipt = t.receipt_sent_at
    ? `<span style="color:var(--success);font-size:.8125rem">✓ ${fmtDate(t.receipt_sent_at)}</span>`
    : `<span style="color:var(--muted);font-size:.8125rem">—</span>`;

  return `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:.7rem 1rem .7rem 0">
        <div style="font-family:monospace;font-size:.8125rem">${esc(t.wompi_reference)}</div>
      </td>
      <td style="padding:.7rem 1rem">
        <div style="font-size:.8125rem">${esc(patient)}</div>
        ${t.dentalink_treatment_id
          ? `<div style="font-size:.75rem;color:var(--muted)">Trat. ${esc(t.dentalink_treatment_id)}</div>`
          : ''}
      </td>
      <td style="padding:.7rem 1rem;font-weight:600;white-space:nowrap">
        ${fmtCOP(t.amount_cop)}
      </td>
      <td style="padding:.7rem 1rem">
        <span class="badge ${esc(st.css)}">${esc(st.label)}</span>
        ${t.status_message
          ? `<div style="font-size:.75rem;color:var(--muted);margin-top:.2rem">${esc(t.status_message)}</div>`
          : ''}
      </td>
      <td style="padding:.7rem 1rem;font-size:.8125rem">${esc(method)}</td>
      <td style="padding:.7rem 1rem;font-size:.8125rem">${esc(t.kiosk_name ?? '—')}</td>
      <td style="padding:.7rem 1rem;font-size:.8125rem;white-space:nowrap">${fmtDate(t.created_at)}</td>
      <td style="padding:.7rem 1rem">${receipt}</td>
    </tr>
  `;
}

function paginHtml(page, pages) {
  const items = [];
  if (page > 1) {
    items.push(`<button class="btn btn-secondary btn-page" data-page="${page - 1}" style="padding:.25rem .6rem;font-size:.875rem">‹ Anterior</button>`);
  }
  items.push(`<span style="font-size:.875rem;color:var(--muted)">Página ${page} de ${pages}</span>`);
  if (page < pages) {
    items.push(`<button class="btn btn-secondary btn-page" data-page="${page + 1}" style="padding:.25rem .6rem;font-size:.875rem">Siguiente ›</button>`);
  }
  return items.join('');
}

function fmtCOP(amount) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(amount);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
