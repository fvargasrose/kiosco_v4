import { api } from './api.js';
import { renderLogin } from './screens/login.js';
import { renderClinicConfig } from './screens/clinic-config.js';
import { renderDentists } from './screens/dentists.js';
import { renderKiosks } from './screens/kiosks.js';

const app = document.getElementById('app');

async function bootstrap() {
  if (!api.token) {
    showLogin();
    return;
  }
  try {
    await api.getMe();
    showDashboard();
  } catch {
    api.clearToken();
    showLogin();
  }
}

function showLogin() {
  renderLogin(app, () => showDashboard());
}

function showDashboard(section = 'clinic') {
  app.innerHTML = `
    <div class="shell">
      <nav class="sidebar">
        <div class="sidebar-brand">🦷 DentalKiosco</div>
        <button class="nav-link ${section === 'clinic' ? 'active' : ''}" data-section="clinic">
          Configuración clínica
        </button>
        <button class="nav-link ${section === 'dentists' ? 'active' : ''}" data-section="dentists">
          Odontólogos
        </button>
        <button class="nav-link ${section === 'kiosks' ? 'active' : ''}" data-section="kiosks">
          Kioscos
        </button>
        <div style="flex:1"></div>
        <button class="nav-link" id="logout-btn" style="color:var(--danger)">
          Cerrar sesión
        </button>
      </nav>
      <main class="main" id="main-content"></main>
    </div>
  `;

  const mainContent = app.querySelector('#main-content');

  const navigate = (s) => {
    app.querySelectorAll('.nav-link[data-section]').forEach((el) => {
      el.classList.toggle('active', el.dataset.section === s);
    });
    loadSection(s, mainContent);
  };

  app.querySelectorAll('.nav-link[data-section]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.section));
  });

  app.querySelector('#logout-btn').addEventListener('click', async () => {
    await api.logout();
    showLogin();
  });

  loadSection(section, mainContent);
}

function loadSection(section, container) {
  if (section === 'clinic') {
    renderClinicConfig(container);
  } else if (section === 'dentists') {
    renderDentists(container);
  } else if (section === 'kiosks') {
    renderKiosks(container);
  }
}

bootstrap();
