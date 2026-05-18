/**
 * Pantalla profile — mi perfil (datos personales registrados).
 *
 * Lectura solamente. La edición de datos personales se delega a recepción
 * (mejor para auditoría y para evitar errores tipográficos en el kiosco).
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { toast } from '../components/toast.js';

export function renderProfile(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Mi perfil</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Volver
        </button>
      </header>
      <div class="screen-body">
        <div id="content">${spinner({ text: 'Cargando tu perfil...' })}</div>
      </div>
    </div>
  `;

  const content = container.querySelector('#content');

  const load = async () => {
    try {
      const profile = await api.getProfile();
      renderContent(content, profile);
    } catch (err) {
      renderError(content, err);
    }
  };

  container.querySelector('#back-btn').addEventListener('click', () => navigate('home'));

  load();
  return null;
}

function renderContent(container, profile) {
  const rows = [
    { label: 'Nombre completo', value: profile.nombre },
    { label: 'Cédula', value: profile.rut ?? '—' },
    { label: 'Celular', value: profile.celular ?? '—' },
    { label: 'Correo electrónico', value: profile.email ?? '—' },
    {
      label: 'Fecha de nacimiento',
      value: profile.fecha_nacimiento ? formatDate(profile.fecha_nacimiento) : '—',
    },
  ];

  container.innerHTML = `
    <div class="profile-card">
      ${rows
        .map(
          (r) => `
        <div class="profile-row">
          <div class="profile-label">${escapeHtml(r.label)}</div>
          <div class="profile-value">${escapeHtml(r.value)}</div>
        </div>
      `,
        )
        .join('')}
    </div>

    <div class="alert alert-info" style="margin-top: 1.5rem;">
      ℹ️ Si alguno de estos datos está desactualizado, por favor dirígete a
      recepción para corregirlo.
    </div>
  `;
}

function renderError(container, err) {
  let msg = 'No pudimos cargar tu perfil.';
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

function formatDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  const [y, m, d] = yyyymmdd.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'long',
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
