import { api, ApiError } from '../api.js';

const VALID_DURATIONS = [15, 30, 45, 60, 75, 90, 105, 120];

export async function renderClinicConfig(container) {
  container.innerHTML = `<div class="loading"><div class="spinner"></div> Cargando...</div>`;

  let clinic;
  let procedures = [];
  try {
    const [clinicRes, proceduresRes] = await Promise.all([
      api.getClinic(),
      api.getProcedures().catch(() => ({ data: [] })),
    ]);
    clinic = clinicRes;
    procedures = proceduresRes.data ?? [];
  } catch {
    container.innerHTML = `<div class="alert alert-error" style="margin:2rem">Error al cargar la configuración.</div>`;
    return;
  }

  render(container, clinic, procedures);
}

// clinic shape from API:
// { display_name, standby: { mode, title, subtitle, has_media, media_hash, media_updated_at }, ... }
function render(container, clinic, procedures) {
  const sb = clinic.standby || {};
  const mode = sb.mode || 'mensaje';
  const hasMedia = !!sb.has_media;
  const logo = clinic.logo || { has: false };

  container.innerHTML = `
    <h1 class="page-title">Configuración de la clínica</h1>

    <!-- Logo de la clínica -->
    <div class="card">
      <div class="card-title">Logo de la clínica</div>
      <p style="margin: 0 0 1rem; color: var(--muted); font-size: 0.875rem">
        Aparece en el header de cada pantalla del kiosco y, si la pantalla de espera está en modo "mensaje", también en grande sobre el título.
      </p>

      ${logo.has ? `
        <div id="current-logo" style="margin-bottom:1rem">
          <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
            <span class="badge badge-success">Logo cargado</span>
            <span style="font-size:.8125rem;color:var(--muted)">
              ${logo.updated_at ? 'Actualizado ' + formatDate(logo.updated_at) : ''}
            </span>
          </div>
          <div id="logo-preview-wrap">
            <img src="/api/public/clinic-logo?v=${esc((logo.hash || '').slice(0,12))}"
                 class="media-preview" alt="Vista previa logo"
                 style="max-height:160px;max-width:320px;object-fit:contain;background:#fff;padding:8px;border-radius:8px">
          </div>
          <div id="logo-meta" style="font-size:.8125rem;color:var(--muted);margin-top:.5rem"></div>
          <button type="button" class="btn btn-danger" id="delete-logo-btn"
                  style="margin-top:.75rem;font-size:.875rem;padding:.375rem 1rem">
            Eliminar logo
          </button>
        </div>
      ` : ''}

      <div class="file-drop" id="logo-drop">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 24 24"
             stroke="currentColor" style="color:var(--muted)">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 8l-3-3m3 3l3-3"/>
        </svg>
        <p>Arrastra un PNG, JPG o WEBP (máx. 2 MB) o haz clic</p>
        <input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp">
      </div>
      <div id="logo-upload-progress" style="display:none;margin-top:.75rem">
        <div class="loading" style="padding:1rem"><div class="spinner"></div> Subiendo...</div>
      </div>
      <div id="logo-alert" style="margin-top:.5rem"></div>
    </div>

    <!-- Pantalla de standby -->
    <div class="card">
      <div class="card-title">Pantalla de espera (Standby)</div>

      <div class="form-group">
        <label>Modo de pantalla</label>
        <div class="radio-group" id="mode-group">
          <label class="radio-card ${mode === 'mensaje' ? 'selected' : ''}">
            <input type="radio" name="standby_mode" value="mensaje" ${mode === 'mensaje' ? 'checked' : ''}> Mensaje de texto
          </label>
          <label class="radio-card ${mode === 'gif' ? 'selected' : ''}">
            <input type="radio" name="standby_mode" value="gif" ${mode === 'gif' ? 'checked' : ''}> GIF animado
          </label>
          <label class="radio-card ${mode === 'video' ? 'selected' : ''}">
            <input type="radio" name="standby_mode" value="video" ${mode === 'video' ? 'checked' : ''}> Video
          </label>
        </div>
      </div>

      <div class="form-group">
        <label for="standby_title">Título de pantalla de espera</label>
        <input type="text" id="standby_title" class="form-control"
               value="${esc(sb.title || '')}"
               placeholder="${esc(clinic.display_name || 'Clínica Dental')}">
        <div class="form-help">Si está vacío, se usa el nombre de la clínica.</div>
      </div>

      <div class="form-group">
        <label for="standby_subtitle">Subtítulo</label>
        <input type="text" id="standby_subtitle" class="form-control"
               value="${esc(sb.subtitle || '')}"
               placeholder="Bienvenido a nuestro autoservicio">
      </div>

      <!-- Zona de media (GIF / video) -->
      <div id="media-section" style="${mode === 'mensaje' ? 'display:none' : ''}">
        <div class="form-group" id="video-sound-group" style="${mode === 'video' ? '' : 'display:none'}">
          <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
            <input type="checkbox" id="standby_video_sound" ${sb.video_sound ? 'checked' : ''}>
            Reproducir video con sonido
          </label>
          <div class="form-help">
            Por defecto el video se reproduce en silencio. Activa esta opción solo si el contenido lo requiere.
            El navegador del kiosco debe permitir autoplay con audio (ver guía de producción).
          </div>
        </div>

        <div class="form-group">
          <label id="media-label">${mode === 'gif' ? 'Archivo GIF animado' : 'Archivo de video (MP4 o WebM)'}</label>

          ${hasMedia ? `
            <div id="current-media" style="margin-bottom:1rem">
              <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
                <span class="badge badge-success">Archivo cargado</span>
                <span style="font-size:.8125rem;color:var(--muted)">
                  ${sb.media_updated_at ? 'Actualizado ' + formatDate(sb.media_updated_at) : ''}
                </span>
              </div>
              <div id="media-preview-wrap"></div>
              <button type="button" class="btn btn-danger" id="delete-media-btn"
                      style="margin-top:.75rem;font-size:.875rem;padding:.375rem 1rem">
                Eliminar archivo
              </button>
            </div>
          ` : ''}

          <div class="file-drop" id="file-drop">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 24 24"
                 stroke="currentColor" style="color:var(--muted)">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                    d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 12V4m0 8l-3-3m3 3l3-3"/>
            </svg>
            <p id="drop-hint">${mode === 'gif' ? 'Arrastra un GIF aquí o haz clic (máx. 50 MB)' : 'Arrastra un MP4 o WebM aquí o haz clic (máx. 50 MB)'}</p>
            <input type="file" id="media-file" accept="${mode === 'gif' ? 'image/gif' : 'video/mp4,video/webm'}">
          </div>
          <div id="upload-progress" style="display:none;margin-top:.75rem">
            <div class="loading" style="padding:1rem"><div class="spinner"></div> Subiendo...</div>
          </div>
          <div id="upload-alert" style="margin-top:.5rem"></div>
        </div>
      </div>

      <div id="save-alert"></div>
      <button type="button" class="btn btn-primary" id="save-btn">Guardar configuración</button>
    </div>

    <!-- Información de la clínica -->
    <div class="card">
      <div class="card-title">Datos de la clínica</div>
      <div class="form-group">
        <label for="display_name">Nombre visible</label>
        <input type="text" id="display_name" class="form-control" value="${esc(clinic.display_name || '')}">
      </div>
      <div class="form-group">
        <label for="notification_email">Email para notificaciones de pago</label>
        <input type="email" id="notification_email" class="form-control"
               value="${esc(clinic.notification_email || '')}"
               placeholder="admin@clinica.com">
        <div class="form-help">
          Si se configura, el administrador recibirá un correo por cada pago aprobado en Wompi.
          Déjalo vacío para desactivar.
        </div>
      </div>
      <div id="clinic-save-alert"></div>
      <button type="button" class="btn btn-primary" id="clinic-save-btn">Guardar cambios</button>
    </div>

    <!-- Procedimientos / Tratamientos -->
    <div class="card">
      <div class="card-title">Procedimientos / Tratamientos</div>
      <p style="margin: 0 0 1rem; color: var(--muted); font-size: 0.875rem">
        Catálogo que verá el paciente al agendar una cita. La duración elegida se envía a Dentalink.
      </p>
      <div id="procedures-table">${renderProceduresTable(procedures)}</div>
      <div id="procedure-alert" style="margin-top: .75rem"></div>
      <button type="button" class="btn btn-primary" id="add-procedure-btn" style="margin-top: 1rem">
        + Agregar procedimiento
      </button>
    </div>

    <!-- Modal de procedure (oculto por defecto) -->
    <div id="procedure-modal" class="modal-overlay" style="display:none"></div>
  `;

  if (hasMedia) buildMediaPreview(container, mode);

  // ── Radio cards ─────────────────────────────────────────────────────────────
  const modeGroup = container.querySelector('#mode-group');
  const mediaSection = container.querySelector('#media-section');

  const updateModeUI = (newMode) => {
    modeGroup.querySelectorAll('.radio-card').forEach((card) => {
      card.classList.toggle('selected', card.querySelector('input').value === newMode);
    });
    mediaSection.style.display = newMode === 'mensaje' ? 'none' : '';
    const soundGroup = container.querySelector('#video-sound-group');
    if (soundGroup) soundGroup.style.display = newMode === 'video' ? '' : 'none';
    const label = container.querySelector('#media-label');
    if (label) label.textContent = newMode === 'gif' ? 'Archivo GIF animado' : 'Archivo de video (MP4 o WebM)';
    const hint = container.querySelector('#drop-hint');
    if (hint) hint.textContent = newMode === 'gif'
      ? 'Arrastra un GIF aquí o haz clic (máx. 50 MB)'
      : 'Arrastra un MP4 o WebM aquí o haz clic (máx. 50 MB)';
    const fileInput = container.querySelector('#media-file');
    if (fileInput) fileInput.accept = newMode === 'gif' ? 'image/gif' : 'video/mp4,video/webm';
  };

  modeGroup.querySelectorAll('input[type=radio]').forEach((radio) => {
    radio.addEventListener('change', () => updateModeUI(radio.value));
  });

  // ── File drop ────────────────────────────────────────────────────────────────
  const fileDrop = container.querySelector('#file-drop');
  const fileInput = container.querySelector('#media-file');

  fileDrop.addEventListener('click', () => fileInput.click());
  fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('over'); });
  fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('over'));
  fileDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDrop.classList.remove('over');
    if (e.dataTransfer.files[0]) handleFileUpload(container, e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFileUpload(container, fileInput.files[0]);
  });

  // ── Delete media ─────────────────────────────────────────────────────────────
  const deleteBtn = container.querySelector('#delete-media-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar el archivo de media? El modo cambiará a "Mensaje de texto".')) return;
      deleteBtn.disabled = true;
      try {
        await api.deleteStandbyMedia();
        render(container, await api.getClinic());
      } catch {
        container.querySelector('#upload-alert').innerHTML =
          '<div class="alert alert-error">Error al eliminar el archivo.</div>';
        deleteBtn.disabled = false;
      }
    });
  }

  // ── Save standby config ───────────────────────────────────────────────────────
  const saveBtn = container.querySelector('#save-btn');
  saveBtn.addEventListener('click', async () => {
    const newMode = container.querySelector('input[name=standby_mode]:checked')?.value || 'mensaje';
    const title = container.querySelector('#standby_title').value.trim();
    const subtitle = container.querySelector('#standby_subtitle').value.trim();
    const videoSound = !!container.querySelector('#standby_video_sound')?.checked;
    const alertEl = container.querySelector('#save-alert');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando...';
    alertEl.innerHTML = '';
    try {
      await api.patchClinic({
        standby_mode: newMode,
        standby_title: title || null,
        standby_subtitle: subtitle || null,
        standby_video_sound: videoSound,
      });
      alertEl.innerHTML = '<div class="alert alert-success">Configuración guardada.</div>';
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error de conexión.';
      alertEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar configuración';
    }
  });

  // ── Save display_name + notification_email ──────────────────────────────────
  const clinicSaveBtn = container.querySelector('#clinic-save-btn');
  clinicSaveBtn.addEventListener('click', async () => {
    const displayName = container.querySelector('#display_name').value.trim();
    const notificationEmailRaw = container.querySelector('#notification_email').value.trim();
    const alertEl = container.querySelector('#clinic-save-alert');
    alertEl.innerHTML = '';

    // Validación cliente: si se ingresó algo, debe ser email válido
    if (notificationEmailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notificationEmailRaw)) {
      alertEl.innerHTML = '<div class="alert alert-error">El email de notificaciones no es válido.</div>';
      return;
    }

    clinicSaveBtn.disabled = true;
    clinicSaveBtn.textContent = 'Guardando...';
    try {
      await api.patchClinic({
        display_name: displayName,
        notification_email: notificationEmailRaw || null,
      });
      alertEl.innerHTML = '<div class="alert alert-success">Cambios guardados.</div>';
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error de conexión.';
      alertEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
    } finally {
      clinicSaveBtn.disabled = false;
      clinicSaveBtn.textContent = 'Guardar cambios';
    }
  });

  // ── Logo de la clínica ───────────────────────────────────────────────────────
  bindLogoHandlers(container);

  // ── Procedures (CRUD) ────────────────────────────────────────────────────────
  bindProceduresHandlers(container);
}

function bindLogoHandlers(container) {
  const drop = container.querySelector('#logo-drop');
  const fileInput = container.querySelector('#logo-file');
  const alertEl = container.querySelector('#logo-alert');
  const deleteBtn = container.querySelector('#delete-logo-btn');

  if (drop && fileInput) {
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      if (e.dataTransfer.files[0]) handleLogoUpload(container, e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) handleLogoUpload(container, fileInput.files[0]);
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('¿Eliminar el logo de la clínica?')) return;
      deleteBtn.disabled = true;
      try {
        await api.deleteClinicLogo();
        render(container, await api.getClinic(), await reloadProceduresSilent());
      } catch (err) {
        const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error de conexión.';
        if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
        deleteBtn.disabled = false;
      }
    });
  }

  // Mostrar dimensiones del logo actual leyendo del <img> ya en DOM
  const metaEl = container.querySelector('#logo-meta');
  const imgEl = container.querySelector('#logo-preview-wrap img');
  if (metaEl && imgEl) {
    if (imgEl.complete && imgEl.naturalWidth) {
      metaEl.textContent = `Dimensiones: ${imgEl.naturalWidth}×${imgEl.naturalHeight}px`;
    } else {
      imgEl.addEventListener('load', () => {
        metaEl.textContent = `Dimensiones: ${imgEl.naturalWidth}×${imgEl.naturalHeight}px`;
      });
    }
  }
}

async function reloadProceduresSilent() {
  try { return (await api.getProcedures()).data ?? []; }
  catch { return []; }
}

async function handleLogoUpload(container, file) {
  const alertEl = container.querySelector('#logo-alert');
  const progress = container.querySelector('#logo-upload-progress');
  const drop = container.querySelector('#logo-drop');

  if (alertEl) alertEl.innerHTML = '';

  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type)) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">Tipo inválido. Se esperaba PNG, JPG o WEBP.</div>`;
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">El archivo supera el límite de 2 MB (${(file.size / 1024 / 1024).toFixed(2)} MB).</div>`;
    return;
  }

  // Leer dimensiones antes de subir (informativo)
  let dims = null;
  try {
    dims = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  } catch { /* sigue */ }

  if (drop) drop.style.display = 'none';
  if (progress) progress.style.display = '';
  try {
    const res = await api.uploadClinicLogo(file);
    const procedures = await reloadProceduresSilent();
    const clinic = await api.getClinic();
    render(container, clinic, procedures);
    const meta = container.querySelector('#logo-meta');
    if (meta && dims) {
      meta.textContent = `Dimensiones: ${dims.w}×${dims.h}px · Peso: ${(res.bytes / 1024).toFixed(1)} KB`;
    }
  } catch (err) {
    if (drop) drop.style.display = '';
    if (progress) progress.style.display = 'none';
    const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error al subir.';
    if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
  }
}

// =============================================================================
// Procedimientos / Tratamientos
// =============================================================================

function renderProceduresTable(procedures) {
  if (!procedures || procedures.length === 0) {
    return `<p style="color: var(--muted); margin: 0">No hay procedimientos configurados aún. El kiosco mostrará "Consulta general" por defecto.</p>`;
  }
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Nombre</th>
          <th style="width: 110px">Duración</th>
          <th style="width: 90px">Estado</th>
          <th style="width: 180px; text-align: right">Acciones</th>
        </tr>
      </thead>
      <tbody>
        ${procedures.map(procedureRowHtml).join('')}
      </tbody>
    </table>
  `;
}

function procedureRowHtml(p) {
  const active = p.active !== false;
  return `
    <tr data-id="${esc(p.id)}" data-active="${active}">
      <td>
        <div style="font-weight: 600">${esc(p.name)}</div>
        ${p.description ? `<div style="font-size: 0.8125rem; color: var(--muted)">${esc(p.description)}</div>` : ''}
      </td>
      <td>${p.duration_minutes} min</td>
      <td>
        ${active
          ? '<span class="badge badge-success">Activo</span>'
          : '<span class="badge" style="background:#e5e7eb;color:#374151">Inactivo</span>'}
      </td>
      <td style="text-align: right">
        <button type="button" class="btn btn-sm" data-action="edit"
                data-id="${esc(p.id)}">Editar</button>
        <button type="button" class="btn btn-sm" data-action="toggle"
                data-id="${esc(p.id)}">${active ? 'Desactivar' : 'Activar'}</button>
      </td>
    </tr>
  `;
}

function bindProceduresHandlers(container) {
  const addBtn = container.querySelector('#add-procedure-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => openProcedureModal(container, null));
  }

  const table = container.querySelector('#procedures-table');
  if (table) {
    table.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const id = btn.dataset.id;
      const action = btn.dataset.action;

      if (action === 'edit') {
        const procedures = await reloadProcedures(container);
        const p = procedures.find((x) => x.id === id);
        if (p) openProcedureModal(container, p);
      } else if (action === 'toggle') {
        const row = btn.closest('tr');
        const isActive = row?.dataset.active === 'true';
        try {
          if (isActive) {
            await api.deleteProcedure(id); // soft delete (active=false)
          } else {
            await api.updateProcedure(id, { active: true });
          }
          await reloadProcedures(container);
          showProcedureAlert(container, 'success', isActive ? 'Procedimiento desactivado.' : 'Procedimiento activado.');
        } catch (err) {
          const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error de conexión.';
          showProcedureAlert(container, 'error', msg);
        }
      }
    });
  }
}

async function reloadProcedures(container) {
  try {
    const res = await api.getProcedures();
    const procedures = res.data ?? [];
    const table = container.querySelector('#procedures-table');
    if (table) table.innerHTML = renderProceduresTable(procedures);
    return procedures;
  } catch {
    return [];
  }
}

function openProcedureModal(container, procedure) {
  const isEdit = !!procedure;
  const modal = container.querySelector('#procedure-modal');
  if (!modal) return;

  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">${isEdit ? 'Editar procedimiento' : 'Nuevo procedimiento'}</div>

      <div class="form-group">
        <label for="proc-name">Nombre</label>
        <input type="text" id="proc-name" class="form-control" maxlength="100"
               value="${esc(procedure?.name ?? '')}" placeholder="Ej: Limpieza dental">
      </div>

      <div class="form-group">
        <label for="proc-duration">Duración (minutos)</label>
        <select id="proc-duration" class="form-control">
          ${VALID_DURATIONS.map((d) => `
            <option value="${d}" ${procedure?.duration_minutes === d ? 'selected' : ''}>${d} min</option>
          `).join('')}
        </select>
        <div class="form-help">
          Solo se permiten estas duraciones porque la API de Dentalink las rechaza si son diferentes.
          Si tu procedimiento dura 40 min, elige 45 — la API redondea al múltiplo válido más cercano.
        </div>
      </div>

      <div class="form-group">
        <label for="proc-description">Descripción (opcional)</label>
        <textarea id="proc-description" class="form-control" rows="2" maxlength="500"
                  placeholder="Texto opcional que verá el paciente">${esc(procedure?.description ?? '')}</textarea>
      </div>

      <div class="form-group">
        <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
          <input type="checkbox" id="proc-active" ${procedure?.active !== false ? 'checked' : ''}>
          Activo (visible en el kiosco)
        </label>
      </div>

      <div id="proc-modal-alert"></div>

      <div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:1rem">
        <button type="button" class="btn" id="proc-modal-cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" id="proc-modal-save">
          ${isEdit ? 'Guardar cambios' : 'Crear'}
        </button>
      </div>
    </div>
  `;
  modal.style.display = '';

  const close = () => {
    modal.style.display = 'none';
    modal.innerHTML = '';
  };

  modal.querySelector('#proc-modal-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  const saveBtn = modal.querySelector('#proc-modal-save');
  saveBtn.addEventListener('click', async () => {
    const name = modal.querySelector('#proc-name').value.trim();
    const duration_minutes = Number(modal.querySelector('#proc-duration').value);
    const description = modal.querySelector('#proc-description').value.trim() || null;
    const active = modal.querySelector('#proc-active').checked;
    const alertEl = modal.querySelector('#proc-modal-alert');
    alertEl.innerHTML = '';

    if (!name) {
      alertEl.innerHTML = `<div class="alert alert-error">El nombre es obligatorio.</div>`;
      return;
    }
    if (!VALID_DURATIONS.includes(duration_minutes)) {
      alertEl.innerHTML = `<div class="alert alert-error">Duración inválida.</div>`;
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando...';
    try {
      const body = { name, duration_minutes, description, active };
      if (isEdit) {
        await api.updateProcedure(procedure.id, body);
      } else {
        await api.createProcedure(body);
      }
      close();
      await reloadProcedures(container);
      showProcedureAlert(container, 'success', isEdit ? 'Procedimiento actualizado.' : 'Procedimiento creado.');
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error de conexión.';
      alertEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Guardar cambios' : 'Crear';
    }
  });
}

function showProcedureAlert(container, type, msg) {
  const el = container.querySelector('#procedure-alert');
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">${esc(msg)}</div>`;
  setTimeout(() => { if (el.firstChild) el.innerHTML = ''; }, 4000);
}

async function handleFileUpload(container, file) {
  const alertEl = container.querySelector('#upload-alert');
  const progress = container.querySelector('#upload-progress');
  const fileDrop = container.querySelector('#file-drop');
  const currentMode = container.querySelector('input[name=standby_mode]:checked')?.value;

  alertEl.innerHTML = '';

  const allowed = { gif: ['image/gif'], video: ['video/mp4', 'video/webm'] };
  if (!(allowed[currentMode] || []).includes(file.type)) {
    alertEl.innerHTML = `<div class="alert alert-error">Tipo inválido. Se esperaba ${currentMode === 'gif' ? 'GIF' : 'MP4 o WebM'}.</div>`;
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    alertEl.innerHTML = `<div class="alert alert-error">El archivo supera el límite de 50 MB.</div>`;
    return;
  }

  fileDrop.style.display = 'none';
  progress.style.display = '';
  try {
    await api.uploadStandbyMedia(file);
    render(container, await api.getClinic());
  } catch (err) {
    fileDrop.style.display = '';
    progress.style.display = 'none';
    const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error al subir.';
    alertEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
  }
}

function buildMediaPreview(container, mode) {
  const wrap = container.querySelector('#media-preview-wrap');
  if (!wrap) return;
  const url = `/api/admin/clinic/standby-media?t=${Date.now()}`;
  if (mode === 'gif') {
    wrap.innerHTML = `<img src="${url}" class="media-preview" alt="Vista previa GIF">`;
  } else {
    wrap.innerHTML = `<video src="${url}" class="media-preview" autoplay loop muted playsinline></video>`;
  }
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
