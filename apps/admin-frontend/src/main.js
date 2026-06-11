import { api } from './api.js';
import { renderLogin } from './screens/login.js';
import { renderDashboard } from './screens/dashboard.js';
import { renderClinicConfig } from './screens/clinic-config.js';
import { renderDentists } from './screens/dentists.js';
import { renderKiosks } from './screens/kiosks.js';
import { renderTransactions } from './screens/transactions.js';
import { renderChangePassword } from './screens/change-password.js';

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

function showDashboard(section = 'dashboard') {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <button class="hamburger" id="nav-toggle" aria-label="Abrir menú" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
        <div class="topbar-brand">🦷 DentalKiosco</div>
      </header>
      <div class="sidebar-backdrop" id="nav-backdrop"></div>
      <nav class="sidebar" id="sidebar">
        <div class="sidebar-brand">🦷 DentalKiosco</div>
        <button class="nav-link ${section === 'dashboard' ? 'active' : ''}" data-section="dashboard">
          Dashboard
        </button>
        <button class="nav-link ${section === 'clinic' ? 'active' : ''}" data-section="clinic">
          Configuración clínica
        </button>
        <button class="nav-link ${section === 'dentists' ? 'active' : ''}" data-section="dentists">
          Odontólogos
        </button>
        <button class="nav-link ${section === 'kiosks' ? 'active' : ''}" data-section="kiosks">
          Kioscos
        </button>
        <button class="nav-link ${section === 'transactions' ? 'active' : ''}" data-section="transactions">
          Transacciones
        </button>
        <button class="nav-link ${section === 'change-password' ? 'active' : ''}" data-section="change-password">
          Cambiar contraseña
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
  const shell = app.querySelector('.shell');
  const toggle = app.querySelector('#nav-toggle');
  const backdrop = app.querySelector('#nav-backdrop');

  // Sidebar off-canvas en móvil: abre/cierra con la hamburguesa y el backdrop.
  const setNav = (open) => {
    shell.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setNav(!shell.classList.contains('nav-open')));
  backdrop.addEventListener('click', () => setNav(false));

  const navigate = (s) => {
    app.querySelectorAll('.nav-link[data-section]').forEach((el) => {
      el.classList.toggle('active', el.dataset.section === s);
    });
    setNav(false); // cerrar el menú móvil al cambiar de sección
    loadSection(s, mainContent, navigate);
  };

  app.querySelectorAll('.nav-link[data-section]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.section));
  });

  app.querySelector('#logout-btn').addEventListener('click', async () => {
    await api.logout();
    showLogin();
  });

  loadSection(section, mainContent, navigate);
}

function loadSection(section, container, navigate) {
  if (section === 'dashboard') {
    renderDashboard(container, navigate);
  } else if (section === 'clinic') {
    renderClinicConfig(container);
  } else if (section === 'dentists') {
    renderDentists(container);
  } else if (section === 'kiosks') {
    renderKiosks(container);
  } else if (section === 'transactions') {
    renderTransactions(container);
  } else if (section === 'change-password') {
    renderChangePassword(container);
  }
}

bootstrap();
