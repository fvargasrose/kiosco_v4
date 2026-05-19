import { api, ApiError } from '../api.js';

const STATUS_LABELS = {
  pending:  { label: 'Pendiente',  css: 'badge-warn'    },
  approved: { label: 'Aprobado',   css: 'badge-success' },
  declined: { label: 'Rechazado',  css: 'badge-error'   },
  voided:   { label: 'Anulado',    css: 'badge-error'   },
  error:    { label: 'Error',      css: 'badge-error'   },
  expired:  { label: 'Expirado',   css: 'badge-muted'   },
};

export async function renderDashboard(container, onNavigate) {
  container.innerHTML = `<div class="loading"><div class="spinner"></div> Cargando dashboard...</div>`;

  let data;
  try {
    data = await api.getDashboard();
  } catch (err) {
    const msg = err instanceof ApiError ? `Error ${err.status}` : 'Error al cargar el dashboard.';
    container.innerHTML = `<div class="alert alert-error" style="margin:2rem">${esc(msg)}</div>`;
    return;
  }

  const now = new Date().toLocaleString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;margin-bottom:1.75rem">
      <h1 class="page-title" style="margin:0">Dashboard</h1>
      <span style="font-size:.8125rem;color:var(--muted)">Actualizado: ${esc(now)}</span>
    </div>

    <!-- Tarjetas de métricas -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem">
      ${metricCard({
        title:   'Kioscos activos',
        value:   String(data.kiosks.active),
        sub:     `de ${data.kiosks.total} en total`,
        color:   data.kiosks.active > 0 ? 'var(--success)' : 'var(--muted)',
        icon:    '🖥',
      })}
      ${metricCard({
        title:   'Transacciones hoy',
        value:   String(data.today.transactions),
        sub:     `${data.today.approved} aprobadas`,
        color:   'var(--primary)',
        icon:    '💳',
        link:    'transactions',
      })}
      ${metricCard({
        title:   'Monto aprobado hoy',
        value:   fmtCOP(data.today.amount_cop),
        sub:     data.today.approved > 0 ? `${data.today.approved} pago${data.today.approved !== 1 ? 's' : ''}` : 'Sin pagos aprobados',
        color:   data.today.amount_cop > 0 ? 'var(--success)' : 'var(--muted)',
        icon:    '💰',
      })}
      ${metricCard({
        title:   'Pagos pendientes',
        value:   String(data.pending_transactions),
        sub:     data.pending_transactions > 0 ? 'En espera de confirmación' : 'Sin pagos pendientes',
        color:   data.pending_transactions > 0 ? 'var(--warn)' : 'var(--muted)',
        icon:    '⏳',
        link:    data.pending_transactions > 0 ? 'transactions' : null,
      })}
    </div>

    <!-- Tabla de últimas transacciones -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:.5rem;padding:1.25rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h2 style="margin:0;font-size:1rem;font-weight:600">Últimas transacciones</h2>
        <button class="btn btn-secondary btn-nav" data-section="transactions"
                style="font-size:.8125rem;padding:.25rem .75rem">
          Ver todas →
        </button>
      </div>
      ${data.recent_transactions.length === 0
        ? `<div class="alert alert-warn">Aún no hay transacciones registradas.</div>`
        : recentTableHtml(data.recent_transactions)
      }
    </div>
  `;

  // Delegación de clicks en tarjetas y botones de navegación
  container.querySelectorAll('[data-nav-section]').forEach((el) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => onNavigate(el.dataset.navSection));
  });
  container.querySelectorAll('.btn-nav[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => onNavigate(btn.dataset.section));
  });
}

function metricCard({ title, value, sub, color, icon, link }) {
  const attrs = link ? `data-nav-section="${esc(link)}"` : '';
  const hover = link ? 'style="cursor:pointer"' : '';
  return `
    <div class="metric-card" ${attrs} ${hover}>
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="font-size:.875rem;color:var(--muted);font-weight:500">${esc(title)}</div>
        <span style="font-size:1.25rem">${icon}</span>
      </div>
      <div style="font-size:1.75rem;font-weight:700;color:${color};margin:.5rem 0 .25rem;line-height:1.1">
        ${esc(value)}
      </div>
      <div style="font-size:.8125rem;color:var(--muted)">${esc(sub)}</div>
    </div>
  `;
}

function recentTableHtml(rows) {
  return `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:.875rem">
        <thead>
          <tr style="border-bottom:1px solid var(--border);text-align:left">
            <th style="padding:.5rem 1rem .5rem 0;font-weight:600;color:var(--muted);font-size:.8125rem">Referencia</th>
            <th style="padding:.5rem 1rem;font-weight:600;color:var(--muted);font-size:.8125rem">Paciente</th>
            <th style="padding:.5rem 1rem;font-weight:600;color:var(--muted);font-size:.8125rem">Monto</th>
            <th style="padding:.5rem 1rem;font-weight:600;color:var(--muted);font-size:.8125rem">Estado</th>
            <th style="padding:.5rem 1rem;font-weight:600;color:var(--muted);font-size:.8125rem">Kiosco</th>
            <th style="padding:.5rem 1rem;font-weight:600;color:var(--muted);font-size:.8125rem">Fecha</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(recentRowHtml).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function recentRowHtml(t) {
  const st = STATUS_LABELS[t.status] ?? { label: t.status, css: 'badge-muted' };
  const patient = t.patient_email_masked || t.patient_phone_masked || '—';
  return `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:.6rem 1rem .6rem 0;font-family:monospace;font-size:.8rem">${esc(t.wompi_reference)}</td>
      <td style="padding:.6rem 1rem;font-size:.8125rem">${esc(patient)}</td>
      <td style="padding:.6rem 1rem;font-weight:600;white-space:nowrap">${fmtCOP(t.amount_cop)}</td>
      <td style="padding:.6rem 1rem"><span class="badge ${esc(st.css)}">${esc(st.label)}</span></td>
      <td style="padding:.6rem 1rem;font-size:.8125rem">${esc(t.kiosk_name ?? '—')}</td>
      <td style="padding:.6rem 1rem;font-size:.8125rem;white-space:nowrap">${fmtDate(t.created_at)}</td>
    </tr>
  `;
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
