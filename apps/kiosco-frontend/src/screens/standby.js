/**
 * Pantalla standby — atractor inicial.
 * Cualquier toque inicia el flujo de identificación.
 */

import { state } from '../state.js';

export function renderStandby(container, _params, navigate) {
  const clinicName = state.config?.clinic?.display_name ?? 'Clínica Dental';
  const logo = state.config?.clinic?.logo_path
    ? `<img src="${escapeHtml(state.config.clinic.logo_path)}" alt="${escapeHtml(clinicName)}" class="standby-logo-img">`
    : '<div class="standby-logo">🦷</div>';

  container.innerHTML = `
    <div class="screen standby">
      <div class="standby-content">
        ${logo}
        <h1>${escapeHtml(clinicName)}</h1>
        <p>Bienvenido a nuestro autoservicio</p>
        <button type="button" class="standby-cta" id="standby-start">
          Toca para comenzar
        </button>
        <div class="standby-footer">
          <button type="button" class="link-btn" id="open-faq">
            Preguntas frecuentes
          </button>
        </div>
      </div>
    </div>
  `;

  // El kiosco entra al flujo de login en cualquier toque
  const goToLogin = () => navigate('habeas-data');

  container.querySelector('.standby').addEventListener('click', (e) => {
    // Evitar conflicto con el botón de FAQ
    if (e.target.closest('#open-faq')) return;
    goToLogin();
  });

  container.querySelector('#open-faq').addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('faq');
  });

  // Sin cleanup
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
