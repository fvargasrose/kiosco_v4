/**
 * Shell Apple — sidebar persistente + área de contenido.
 * Llamado por cada pantalla post-login del tema apple.
 *
 * sidebarCollapsed es module-level para sobrevivir entre navegaciones.
 */

import { api } from '../../api.js';
import { clearPatient } from '../../state.js';
import { toast } from '../../components/toast.js';

let sidebarCollapsed = false;

/**
 * Renderiza el shell (sidebar + main) dentro de `container`.
 * @param {HTMLElement} container
 * @param {string} activeNav  - 'home' | 'appointments' | 'treatments' | 'booking'
 * @param {Function} navigate
 * @param {Function} renderContent - recibe el elemento <main> y pinta el contenido
 */
export function renderAppleShell(container, activeNav, navigate, renderContent) {
  const navItems = [
    { icon: 'ti-home-2',       label: 'Inicio',            target: 'home'         },
    { icon: 'ti-calendar',     label: 'Mis Citas',         target: 'appointments' },
    { icon: 'ti-tooth',        label: 'Mis Tratamientos',  target: 'treatments'   },
    { icon: 'ti-calendar-plus',label: 'Agendar Cita',      target: 'booking'      },
  ];

  const navHtml = navItems.map((n) => `
    <button type="button"
            class="ak-nav-item${n.target === activeNav ? ' active' : ''}"
            data-target="${n.target}">
      <i class="ti ${n.icon}"></i>
      <span class="ak-nav-label">${n.label}</span>
    </button>
  `).join('');

  const bottomNavHtml = navItems.map((n) => `
    <button type="button"
            class="ak-bottom-nav-item${n.target === activeNav ? ' active' : ''}"
            data-target="${n.target}">
      <i class="ti ${n.icon}"></i>
      <span>${n.label}</span>
    </button>
  `).join('');

  container.innerHTML = `
    <div class="ak-shell${sidebarCollapsed ? ' collapsed' : ''}">
      <aside class="ak-sidebar">
        <div class="ak-sidebar-header">
          <div class="ak-logo-circle"><i class="ti ti-tooth"></i></div>
          <span class="ak-logo-text">DentalKiosco</span>
        </div>

        <nav class="ak-nav">
          ${navHtml}
        </nav>

        <div class="ak-sidebar-footer">
          <button type="button" class="ak-nav-item" id="logout-btn">
            <i class="ti ti-logout"></i>
            <span class="ak-nav-label">Cerrar sesión</span>
          </button>
        </div>

        <button type="button" class="ak-toggle" id="sidebar-toggle" title="Colapsar">
          <i class="ti ti-chevron-left"></i>
        </button>
      </aside>

      <main class="ak-main" id="ak-main-content"></main>

      <div class="ak-bottom-nav">
        <div class="ak-bottom-nav-items">
          ${bottomNavHtml}
        </div>
      </div>
    </div>
  `;

  // Wiring toggle
  const shell = container.querySelector('.ak-shell');
  const toggle = container.querySelector('#sidebar-toggle');
  toggle.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    shell.classList.toggle('collapsed', sidebarCollapsed);
    toggle.querySelector('i').className = sidebarCollapsed
      ? 'ti ti-chevron-right'
      : 'ti ti-chevron-left';
  });

  // Wiring nav items
  container.querySelectorAll('.ak-nav-item[data-target]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.target));
  });

  // Wiring bottom nav
  container.querySelectorAll('.ak-bottom-nav-item[data-target]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.target));
  });

  // Logout
  container.querySelector('#logout-btn').addEventListener('click', async () => {
    try { await api.logout(); } catch { /* ignorar */ }
    clearPatient();
    toast('Sesión cerrada.', 'info');
    navigate('standby');
  });

  // Pintar contenido en el main
  const main = container.querySelector('#ak-main-content');
  renderContent(main);
}
