/**
 * Pantalla Habeas Data.
 *
 * Por Ley 1581 de 2012 (Colombia), DEBE mostrarse el aviso ANTES de capturar
 * cualquier dato personal (incluida la cédula). El paciente marca el checkbox
 * y pasa a login-cedula con el hash + versión de la política que aceptó.
 */

import { state } from '../state.js';

export function renderHabeasData(container, _params, navigate) {
  const hd = state.config?.habeas_data;

  if (!hd?.text) {
    container.innerHTML = `
      <div class="screen">
        <div class="screen-body">
          <div class="alert alert-error">
            La política de tratamiento de datos no está configurada.
            Contacta a recepción.
          </div>
          <button type="button" class="btn btn-secondary" id="back-btn">
            ← Volver
          </button>
        </div>
      </div>
    `;
    container.querySelector('#back-btn').addEventListener('click', () => navigate('standby'));
    return null;
  }

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Tratamiento de datos personales</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Cancelar
        </button>
      </header>
      <div class="screen-body">
        <div class="habeas-modal">
          <h2>📄 Aviso de Privacidad</h2>
          <div class="policy-text">${escapeHtml(hd.text)}</div>
          <div class="policy-meta">
            Versión: <strong>${escapeHtml(hd.version)}</strong>
          </div>

          <label class="consent-row" for="consent-check">
            <input type="checkbox" id="consent-check">
            <span>
              <strong>Acepto el tratamiento de mis datos personales</strong> conforme
              a la política descrita arriba y a la Ley 1581 de 2012.
            </span>
          </label>

          <button type="button" class="btn btn-primary btn-lg btn-full" id="continue-btn" disabled>
            Aceptar y continuar
          </button>
        </div>
      </div>
    </div>
  `;

  const checkbox = container.querySelector('#consent-check');
  const continueBtn = container.querySelector('#continue-btn');

  checkbox.addEventListener('change', () => {
    continueBtn.disabled = !checkbox.checked;
  });

  continueBtn.addEventListener('click', () => {
    if (!checkbox.checked) return;
    navigate('login-cedula', {
      policyVersion: hd.version,
      policyHash: hd.hash,
    });
  });

  container.querySelector('#back-btn').addEventListener('click', () => navigate('standby'));

  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
