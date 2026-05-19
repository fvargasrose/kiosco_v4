import { api, ApiError } from '../api.js';

export async function renderKiosks(container) {
  container.innerHTML = `<div class="loading"><div class="spinner"></div> Cargando kioscos...</div>`;

  let kiosks;
  try {
    const res = await api.getKiosks();
    kiosks = res.data ?? [];
  } catch {
    container.innerHTML = `<div class="alert alert-error" style="margin:2rem">Error al cargar los kioscos.</div>`;
    return;
  }

  render(container, kiosks);
}

function render(container, kiosks) {
  container.innerHTML = `
    <h1 class="page-title">Kioscos</h1>
    <p style="color:var(--muted);margin-bottom:1.5rem;font-size:.9375rem">
      Gestiona los dispositivos kiosco de la clínica. Al crear un kiosco se genera
      un token JWT que debes copiar antes de cerrar — no se puede recuperar después.
    </p>

    <div style="margin-bottom:1.5rem">
      <button class="btn btn-primary" id="btn-new-kiosk">+ Nuevo kiosco</button>
    </div>

    <div id="new-kiosk-form" style="display:none;background:var(--surface);border:1px solid var(--border);border-radius:.5rem;padding:1.25rem;margin-bottom:1.5rem;max-width:480px">
      <h3 style="margin:0 0 1rem;font-size:1rem">Crear kiosco</h3>
      <div style="margin-bottom:.75rem">
        <label style="display:block;font-size:.875rem;margin-bottom:.25rem;font-weight:500">Nombre <span style="color:var(--danger)">*</span></label>
        <input id="kiosk-name" type="text" class="form-input" placeholder="Ej: Recepción Principal" maxlength="100" style="width:100%;box-sizing:border-box">
      </div>
      <div style="margin-bottom:.75rem">
        <label style="display:block;font-size:.875rem;margin-bottom:.25rem;font-weight:500">Ubicación</label>
        <input id="kiosk-location" type="text" class="form-input" placeholder="Ej: Piso 1, Sala de espera" maxlength="200" style="width:100%;box-sizing:border-box">
      </div>
      <div style="margin-bottom:1rem">
        <label style="display:block;font-size:.875rem;margin-bottom:.25rem;font-weight:500">Tipo de dispositivo</label>
        <select id="kiosk-device-type" class="form-input" style="width:100%;box-sizing:border-box">
          <option value="unknown">Desconocido</option>
          <option value="pc">PC</option>
          <option value="tablet_android">Tablet Android</option>
        </select>
      </div>
      <div style="display:flex;gap:.75rem">
        <button class="btn btn-primary" id="btn-create-kiosk">Crear</button>
        <button class="btn btn-secondary" id="btn-cancel-new">Cancelar</button>
      </div>
      <div id="create-alert" style="margin-top:.75rem"></div>
    </div>

    <div id="token-reveal" style="display:none;background:#fefce8;border:1px solid #fde047;border-radius:.5rem;padding:1.25rem;margin-bottom:1.5rem;max-width:640px">
      <div style="font-weight:600;margin-bottom:.5rem;color:#713f12">
        ⚠ Copia el token ahora — no se mostrará de nuevo
      </div>
      <div style="font-size:.8125rem;color:#713f12;margin-bottom:.75rem">
        Pega este token en la URL del kiosco: <code>http://&lt;host&gt;:5173/?kiosk_token=TOKEN</code>
      </div>
      <div style="display:flex;gap:.5rem;align-items:center">
        <input id="token-value" type="text" readonly class="form-input"
               style="flex:1;font-family:monospace;font-size:.75rem;box-sizing:border-box;background:#fff">
        <button class="btn btn-secondary" id="btn-copy-token" style="white-space:nowrap">Copiar</button>
      </div>
      <div style="margin-top:.5rem">
        <button class="btn btn-secondary" id="btn-close-reveal" style="font-size:.8125rem;padding:.25rem .75rem">
          Cerrado, ya copié el token
        </button>
      </div>
    </div>

    <div id="kiosk-list">
      ${kiosks.length === 0
        ? `<div class="alert alert-warn">No hay kioscos registrados. Crea el primero con el botón de arriba.</div>`
        : kioskTableHtml(kiosks)
      }
    </div>
  `;

  wireEvents(container, kiosks);
}

function kioskTableHtml(kiosks) {
  return `
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:.9375rem">
        <thead>
          <tr style="border-bottom:2px solid var(--border);text-align:left">
            <th style="padding:.6rem 1rem .6rem 0;font-weight:600">Nombre</th>
            <th style="padding:.6rem 1rem;font-weight:600">Ubicación</th>
            <th style="padding:.6rem 1rem;font-weight:600">Dispositivo</th>
            <th style="padding:.6rem 1rem;font-weight:600">Estado</th>
            <th style="padding:.6rem 1rem;font-weight:600">Última conexión</th>
            <th style="padding:.6rem 1rem;font-weight:600">Expira token</th>
            <th style="padding:.6rem 1rem;font-weight:600">Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${kiosks.map(kioskRowHtml).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function kioskRowHtml(k) {
  const statusBadge = k.is_active
    ? `<span class="badge badge-success">Activo</span>`
    : `<span class="badge badge-error">Inactivo</span>`;

  const lastSeen = k.last_seen_at
    ? fmtDate(k.last_seen_at)
    : `<span style="color:var(--muted)">Nunca</span>`;

  const deviceLabel = { pc: 'PC', tablet_android: 'Tablet Android', unknown: 'Desconocido' }[k.device_type] ?? k.device_type;

  return `
    <tr style="border-bottom:1px solid var(--border)" data-kiosk-id="${esc(k.id)}">
      <td style="padding:.75rem 1rem .75rem 0">
        <div style="font-weight:500">${esc(k.name)}</div>
        <div style="font-size:.8125rem;color:var(--muted)">${esc(k.id.slice(0, 8))}…</div>
      </td>
      <td style="padding:.75rem 1rem;color:var(--muted);font-size:.875rem">${esc(k.location ?? '—')}</td>
      <td style="padding:.75rem 1rem;font-size:.875rem">${esc(deviceLabel)}</td>
      <td style="padding:.75rem 1rem">${statusBadge}</td>
      <td style="padding:.75rem 1rem;font-size:.875rem">${lastSeen}</td>
      <td style="padding:.75rem 1rem;font-size:.875rem">${fmtDate(k.token_expires_at)}</td>
      <td style="padding:.75rem 1rem">
        <div style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-secondary btn-toggle-kiosk" data-id="${esc(k.id)}" data-active="${k.is_active}"
                  style="font-size:.8125rem;padding:.25rem .6rem">
            ${k.is_active ? 'Desactivar' : 'Activar'}
          </button>
          <button class="btn btn-danger btn-revoke-kiosk" data-id="${esc(k.id)}" data-name="${esc(k.name)}"
                  style="font-size:.8125rem;padding:.25rem .6rem"
                  ${!k.is_active ? 'disabled' : ''}>
            Revocar
          </button>
        </div>
        <div class="kiosk-row-alert" style="margin-top:.25rem"></div>
      </td>
    </tr>
  `;
}

function wireEvents(container, initialKiosks) {
  const btnNew      = container.querySelector('#btn-new-kiosk');
  const formEl      = container.querySelector('#new-kiosk-form');
  const btnCancel   = container.querySelector('#btn-cancel-new');
  const btnCreate   = container.querySelector('#btn-create-kiosk');
  const createAlert = container.querySelector('#create-alert');
  const tokenReveal = container.querySelector('#token-reveal');
  const tokenInput  = container.querySelector('#token-value');
  const btnCopy     = container.querySelector('#btn-copy-token');
  const btnClose    = container.querySelector('#btn-close-reveal');

  btnNew.addEventListener('click', () => {
    formEl.style.display = 'block';
    btnNew.style.display = 'none';
    container.querySelector('#kiosk-name').focus();
  });

  btnCancel.addEventListener('click', () => {
    formEl.style.display = 'none';
    btnNew.style.display = '';
    createAlert.innerHTML = '';
  });

  btnCreate.addEventListener('click', async () => {
    const name = container.querySelector('#kiosk-name').value.trim();
    if (!name) {
      createAlert.innerHTML = alertHtml('El nombre es obligatorio.', 'error');
      return;
    }

    btnCreate.disabled = true;
    btnCreate.textContent = 'Creando...';
    createAlert.innerHTML = '';

    try {
      const res = await api.createKiosk({
        name,
        location: container.querySelector('#kiosk-location').value.trim() || undefined,
        device_type: container.querySelector('#kiosk-device-type').value,
      });

      // Ocultar form, mostrar token
      formEl.style.display = 'none';
      tokenInput.value = res.kiosk_token;
      tokenReveal.style.display = 'block';

      // Refrescar la tabla
      await refreshList(container);
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error al crear el kiosco.';
      createAlert.innerHTML = alertHtml(msg, 'error');
    } finally {
      btnCreate.disabled = false;
      btnCreate.textContent = 'Crear';
    }
  });

  btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tokenInput.value);
      btnCopy.textContent = '¡Copiado!';
      setTimeout(() => { btnCopy.textContent = 'Copiar'; }, 2000);
    } catch {
      tokenInput.select();
    }
  });

  btnClose.addEventListener('click', () => {
    tokenReveal.style.display = 'none';
    btnNew.style.display = '';
  });

  // Delegación de eventos en la tabla
  container.querySelector('#kiosk-list').addEventListener('click', async (e) => {
    const toggleBtn = e.target.closest('.btn-toggle-kiosk');
    const revokeBtn = e.target.closest('.btn-revoke-kiosk');

    if (toggleBtn) {
      const id       = toggleBtn.dataset.id;
      const isActive = toggleBtn.dataset.active === 'true';
      const alertEl  = toggleBtn.closest('tr').querySelector('.kiosk-row-alert');
      toggleBtn.disabled = true;
      try {
        await api.patchKiosk(id, { is_active: !isActive });
        await refreshList(container);
      } catch (err) {
        const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error.';
        alertEl.innerHTML = alertHtml(msg, 'error');
        toggleBtn.disabled = false;
      }
    }

    if (revokeBtn) {
      const id   = revokeBtn.dataset.id;
      const name = revokeBtn.dataset.name;
      if (!confirm(`¿Revocar permanentemente el kiosco "${name}"?\nEl token quedará inválido.`)) return;
      const alertEl = revokeBtn.closest('tr').querySelector('.kiosk-row-alert');
      revokeBtn.disabled = true;
      try {
        await api.deleteKiosk(id);
        await refreshList(container);
      } catch (err) {
        const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error.';
        alertEl.innerHTML = alertHtml(msg, 'error');
        revokeBtn.disabled = false;
      }
    }
  });
}

async function refreshList(container) {
  const listEl = container.querySelector('#kiosk-list');
  if (!listEl) return;
  try {
    const res   = await api.getKiosks();
    const kiosks = res.data ?? [];
    listEl.innerHTML = kiosks.length === 0
      ? `<div class="alert alert-warn">No hay kioscos registrados.</div>`
      : kioskTableHtml(kiosks);
  } catch {
    listEl.innerHTML = `<div class="alert alert-error">Error al recargar la lista.</div>`;
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function alertHtml(msg, type) {
  return `<div class="alert alert-${type === 'error' ? 'error' : 'success'}" style="padding:.4rem .75rem;font-size:.875rem">${esc(msg)}</div>`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
