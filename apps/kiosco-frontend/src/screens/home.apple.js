import { state } from '../state.js';
import { renderAppleShell } from './shared/shell.apple.js';

export function renderHomeApple(container, _params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  renderAppleShell(container, 'home', navigate, (main) => {
    const firstName = (state.patient.nombre ?? state.patient.name ?? 'Paciente').split(' ')[0];

    main.innerHTML = `
      <div class="ak-hero">
        <div>
          <div style="font-size:14px;font-weight:500;opacity:.85;margin-bottom:4px;">
            Bienvenido de vuelta
          </div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-.5px;">
            ${escapeHtml(firstName)}
          </div>
        </div>
        <div style="text-align:right;">
          <div id="hero-clock"
               style="font-size:32px;font-weight:300;letter-spacing:-1px;font-variant-numeric:tabular-nums;">
            --:--
          </div>
          <div style="font-size:13px;opacity:.75;" id="hero-date"></div>
        </div>
      </div>

      <div class="ak-action-grid">
        <button type="button" class="ak-action-card" data-target="booking">
          <div class="ak-action-icon ak-icon-green">
            <i class="ti ti-calendar-plus"></i>
          </div>
          <div class="ak-action-label">Agendar cita</div>
          <div class="ak-action-desc">Reserva tu próxima visita</div>
        </button>

        <button type="button" class="ak-action-card" data-target="appointments">
          <div class="ak-action-icon ak-icon-blue">
            <i class="ti ti-calendar"></i>
          </div>
          <div class="ak-action-label">Mis citas</div>
          <div class="ak-action-desc">Consulta o cancela tus visitas</div>
        </button>

        <button type="button" class="ak-action-card" data-target="treatments">
          <div class="ak-action-icon ak-icon-orange">
            <i class="ti ti-dental"></i>
          </div>
          <div class="ak-action-label">Mis tratamientos</div>
          <div class="ak-action-desc">Historial y saldos pendientes</div>
        </button>
      </div>
    `;

    // Reloj en vivo
    const clockEl = main.querySelector('#hero-clock');
    const dateEl  = main.querySelector('#hero-date');
    let clockTimer = null;

    const tick = () => {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
      dateEl.textContent  = now.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
    };
    tick();
    clockTimer = setInterval(tick, 1000);

    // Cleanup cuando el router destruye el container
    const observer = new MutationObserver(() => {
      if (!document.body.contains(main)) {
        clearInterval(clockTimer);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Wiring tarjetas
    main.querySelectorAll('.ak-action-card[data-target]').forEach((card) => {
      card.addEventListener('click', () => navigate(card.dataset.target));
    });
  });

  return null;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
