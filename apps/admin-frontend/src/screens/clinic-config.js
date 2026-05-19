import { api, ApiError } from '../api.js';

export async function renderClinicConfig(container) {
  container.innerHTML = `<div class="loading"><div class="spinner"></div> Cargando...</div>`;

  let clinic;
  try {
    clinic = await api.getClinic();
  } catch {
    container.innerHTML = `<div class="alert alert-error" style="margin:2rem">Error al cargar la configuración.</div>`;
    return;
  }

  render(container, clinic);
}

// clinic shape from API:
// { display_name, standby: { mode, title, subtitle, has_media, media_hash, media_updated_at }, ... }
function render(container, clinic) {
  const sb = clinic.standby || {};
  const mode = sb.mode || 'mensaje';
  const hasMedia = !!sb.has_media;

  container.innerHTML = `
    <h1 class="page-title">Configuración de la clínica</h1>

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
      <div id="clinic-save-alert"></div>
      <button type="button" class="btn btn-primary" id="clinic-save-btn">Guardar nombre</button>
    </div>
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
    const alertEl = container.querySelector('#save-alert');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando...';
    alertEl.innerHTML = '';
    try {
      await api.patchClinic({
        standby_mode: newMode,
        standby_title: title || null,
        standby_subtitle: subtitle || null,
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

  // ── Save display_name ─────────────────────────────────────────────────────────
  const clinicSaveBtn = container.querySelector('#clinic-save-btn');
  clinicSaveBtn.addEventListener('click', async () => {
    const displayName = container.querySelector('#display_name').value.trim();
    const alertEl = container.querySelector('#clinic-save-alert');
    clinicSaveBtn.disabled = true;
    clinicSaveBtn.textContent = 'Guardando...';
    alertEl.innerHTML = '';
    try {
      await api.patchClinic({ display_name: displayName });
      alertEl.innerHTML = '<div class="alert alert-success">Nombre guardado.</div>';
    } catch (err) {
      const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error de conexión.';
      alertEl.innerHTML = `<div class="alert alert-error">${esc(msg)}</div>`;
    } finally {
      clinicSaveBtn.disabled = false;
      clinicSaveBtn.textContent = 'Guardar nombre';
    }
  });
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
