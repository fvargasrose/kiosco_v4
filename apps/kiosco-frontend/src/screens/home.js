/**
 * Pantalla home — menú principal post-login.
 * Muestra saludo personalizado y las 3 opciones disponibles.
 */

import { state, clearPatient } from '../state.js';
import { api } from '../api.js';

export function renderHome(container, _params, navigate) {
  const patient = state.patient;
  if (!patient) {
    navigate('standby');
    return null;
  }

  const firstName = patient.name?.split(' ')[0] ?? 'Paciente';

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Hola, ${escapeHtml(firstName)} 👋</h1>
        <button type="button" class="btn btn-secondary" id="logout-btn">
          Cerrar sesión
        </button>
      </header>
      <div class="screen-body">
        <div class="welcome">
          <p>¿Qué deseas hacer hoy?</p>
        </div>

        <div class="menu-grid">
          <button type="button" class="menu-card" data-target="appointments">
            <div class="menu-card-icon">📅</div>
            <h3>Mis citas</h3>
            <p>Consulta, cancela o reagenda</p>
          </button>

          <button type="button" class="menu-card" data-target="treatments">
            <div class="menu-card-icon">🦷</div>
            <h3>Mis tratamientos</h3>
            <p>Historial y estado de pagos</p>
          </button>

          <button type="button" class="menu-card" data-target="profile">
            <div class="menu-card-icon">👤</div>
            <h3>Mi perfil</h3>
            <p>Datos personales registrados</p>
          </button>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('.menu-card').forEach((card) => {
    card.addEventListener('click', () => {
      const target = card.dataset.target;
      if (target) navigate(target);
    });
  });

  container.querySelector('#logout-btn').addEventListener('click', async () => {
    await api.logout();
    clearPatient();
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
