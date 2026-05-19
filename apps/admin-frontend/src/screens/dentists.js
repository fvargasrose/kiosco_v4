import { api, ApiError } from '../api.js';

export async function renderDentists(container) {
  container.innerHTML = `<div class="loading"><div class="spinner"></div> Cargando odontólogos...</div>`;

  let dentists;
  try {
    const res = await api.getDentists();
    dentists = res.data ?? [];
  } catch {
    container.innerHTML = `<div class="alert alert-error" style="margin:2rem">Error al cargar los odontólogos.</div>`;
    return;
  }

  render(container, dentists);
}

function render(container, dentists) {
  if (dentists.length === 0) {
    container.innerHTML = `
      <h1 class="page-title">Odontólogos</h1>
      <div class="alert alert-warn">No hay odontólogos registrados en Dentalink.</div>
    `;
    return;
  }

  container.innerHTML = `
    <h1 class="page-title">Odontólogos</h1>
    <p style="color:var(--muted);margin-bottom:1.5rem;font-size:.9375rem">
      Haz clic en una tarjeta para subir o reemplazar la foto del odontólogo.
      La foto aparece en el kiosco cuando el paciente agenda una cita.
    </p>
    <div class="dentist-admin-grid" id="dentist-grid">
      ${dentists.map((d) => dentistCardHtml(d)).join('')}
    </div>
  `;

  // Attach upload logic to each card
  dentists.forEach((d) => {
    const card = container.querySelector(`[data-dentist-id="${CSS.escape(d.id)}"]`);
    if (!card) return;

    const fileInput = card.querySelector('.dentist-file-input');
    const uploadBtn = card.querySelector('.dentist-upload-btn');
    const deleteBtn = card.querySelector('.dentist-delete-btn');
    const alertEl  = card.querySelector('.dentist-card-alert');
    const photoEl  = card.querySelector('.dentist-admin-photo');
    const avatarEl = card.querySelector('.dentist-admin-avatar');

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = '';

      const allowed = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowed.includes(file.type)) {
        showAlert(alertEl, 'Tipo inválido. Usa JPEG, PNG o WebP.', 'error');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        showAlert(alertEl, 'La foto no puede superar 5 MB.', 'error');
        return;
      }

      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Subiendo...';
      alertEl.innerHTML = '';

      try {
        await api.uploadDentistPhoto(d.id, file);
        // Actualizar preview localmente con Object URL temporal
        const url = URL.createObjectURL(file);
        if (photoEl) {
          photoEl.src = url;
          photoEl.style.display = 'block';
          if (avatarEl) avatarEl.style.display = 'none';
        } else {
          // Photo didn't exist before — rebuild the card
          renderDentists(container);
          return;
        }
        showAlert(alertEl, 'Foto actualizada.', 'success');
        if (deleteBtn) deleteBtn.style.display = '';
      } catch (err) {
        const msg = err instanceof ApiError ? (err.body?.message || `Error ${err.status}`) : 'Error al subir.';
        showAlert(alertEl, msg, 'error');
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = d.has_photo ? 'Cambiar foto' : 'Subir foto';
      }
    });

    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar la foto de ${d.nombre}${d.apellido ? ' ' + d.apellido : ''}?`)) return;
        deleteBtn.disabled = true;
        try {
          await api.deleteDentistPhoto(d.id);
          renderDentists(container);
        } catch {
          showAlert(alertEl, 'Error al eliminar.', 'error');
          deleteBtn.disabled = false;
        }
      });
    }
  });
}

function dentistCardHtml(d) {
  const fullName = [d.nombre, d.apellido].filter(Boolean).join(' ');
  const initials = nameInitials(fullName);
  const photoSection = d.has_photo
    ? `<img src="${esc(d.photo_url)}?t=${Date.now()}" class="dentist-admin-photo" alt="${esc(fullName)}">`
    : `<div class="dentist-admin-avatar">${esc(initials)}</div>`;

  return `
    <div class="dentist-admin-card" data-dentist-id="${esc(d.id)}">
      <div class="dentist-admin-photo-wrap">
        ${photoSection}
      </div>
      <div class="dentist-admin-info">
        <div class="dentist-admin-name">${esc(fullName)}</div>
        ${d.especialidad ? `<div class="dentist-admin-spec">${esc(d.especialidad)}</div>` : ''}
        ${d.has_photo
          ? `<div style="font-size:.8125rem;color:var(--muted);margin-top:.25rem">
               Foto cargada · <span class="badge badge-success">OK</span>
             </div>`
          : `<div style="font-size:.8125rem;color:var(--muted);margin-top:.25rem">Sin foto</div>`
        }
      </div>
      <div class="dentist-admin-actions">
        <input type="file" class="dentist-file-input" accept="image/jpeg,image/png,image/webp" style="display:none">
        <button type="button" class="btn btn-primary dentist-upload-btn" style="font-size:.875rem;padding:.375rem 1rem">
          ${d.has_photo ? 'Cambiar foto' : 'Subir foto'}
        </button>
        ${d.has_photo
          ? `<button type="button" class="btn btn-danger dentist-delete-btn" style="font-size:.875rem;padding:.375rem 1rem">
               Eliminar
             </button>`
          : ''
        }
      </div>
      <div class="dentist-card-alert" style="margin-top:.5rem"></div>
    </div>
  `;
}

function showAlert(el, msg, type) {
  el.innerHTML = `<div class="alert alert-${type === 'error' ? 'error' : 'success'}" style="padding:.5rem .75rem;font-size:.875rem">${esc(msg)}</div>`;
}

function nameInitials(name) {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
