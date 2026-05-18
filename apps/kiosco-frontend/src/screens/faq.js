/**
 * Pantalla FAQ — accesible sin login.
 * Renderiza la lista de preguntas/respuestas que vienen del bootstrap.
 */

import { state } from '../state.js';

export function renderFaq(container, _params, navigate) {
  const faq = state.config?.faq ?? [];
  const clinicName = state.config?.clinic?.display_name ?? 'Clínica';

  const list = faq.length
    ? faq.map((item, i) => `
        <details class="faq-item">
          <summary class="faq-question">${escapeHtml(item.question)}</summary>
          <div class="faq-answer">${escapeHtml(item.answer)}</div>
        </details>
      `).join('')
    : `
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <p>Aún no hay preguntas frecuentes configuradas.</p>
        </div>
      `;

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Preguntas frecuentes</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Volver
        </button>
      </header>
      <div class="screen-body">
        <p class="subtitle">Información sobre los servicios de ${escapeHtml(clinicName)}.</p>
        <div class="faq-list">${list}</div>
      </div>
    </div>
  `;

  container.querySelector('#back-btn').addEventListener('click', () => {
    navigate('standby');
  });

  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
