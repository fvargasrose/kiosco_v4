/**
 * =============================================================================
 * Kiosco — Entry point
 * =============================================================================
 *
 * Responsabilidades:
 *   1. Bootstrap: hace fetch a /kiosk/bootstrap para obtener la config.
 *   2. Si no hay kiosk_token, muestra pantalla de "kiosco no pareado" (provisional).
 *   3. Registra todas las pantallas en el router.
 *   4. Arranca el detector de inactividad cuando hay sesión de paciente.
 *   5. Va a la pantalla standby.
 */

import { api, ApiError } from './api.js';
import { setConfig, subscribe, state, clearPatient } from './state.js';
import { navigate, registerScreen, getCurrentScreen } from './router.js';
import { startIdleTimer, stopIdleTimer } from './idle.js';
import { toast } from './components/toast.js';

import { renderStandby } from './screens/standby.js';
import { renderFaq } from './screens/faq.js';
import { renderHabeasData } from './screens/habeas-data.js';
import { renderLoginCedula } from './screens/login-cedula.js';
import { renderLoginOtp } from './screens/login-otp.js';
import { renderHome } from './screens/home.js';
import { renderAppointments } from './screens/appointments.js';
import { renderTreatments } from './screens/treatments.js';
import { renderProfile } from './screens/profile.js';

// ===== Registro de pantallas =====
registerScreen('standby', renderStandby);
registerScreen('faq', renderFaq);
registerScreen('habeas-data', renderHabeasData);
registerScreen('login-cedula', renderLoginCedula);
registerScreen('login-otp', renderLoginOtp);
registerScreen('home', renderHome);
registerScreen('appointments', renderAppointments);
registerScreen('treatments', renderTreatments);
registerScreen('profile', renderProfile);

// ===== Idle timer: arranca cuando hay paciente, se detiene cuando se va =====
subscribe((s) => {
  if (s.patient && getCurrentScreen() !== 'standby') {
    if (!idleRunning) {
      idleRunning = true;
      startIdleTimer({
        onTimeout: async () => {
          idleRunning = false;
          await api.logout();
          clearPatient();
          toast('Sesión cerrada por inactividad.', 'info');
          navigate('standby');
        },
      });
    }
  } else if (!s.patient && idleRunning) {
    idleRunning = false;
    stopIdleTimer();
  }
});
let idleRunning = false;

// ===== Bootstrap =====

async function bootstrap() {
  const root = document.getElementById('app');

  // En desarrollo, si no hay kiosk_token persistido, intentamos usar el del
  // query string (útil para que el script de pairing del Hito 9 lo inyecte).
  const params = new URLSearchParams(window.location.search);
  const queryToken = params.get('kiosk_token');
  if (queryToken && !sessionStorage.getItem('kiosk_token')) {
    api.setKioskToken(queryToken);
    // Limpiar query string para no dejar el token visible en la URL
    window.history.replaceState({}, '', window.location.pathname);
  }

  if (!api.kioskToken) {
    showUnpairedScreen(root);
    return;
  }

  try {
    const config = await api.bootstrap();
    setConfig(config);
    navigate('standby');
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      // Token inválido o kiosco inactivo
      api.setKioskToken(null);
      showUnpairedScreen(root, 'El token del kiosco fue rechazado por el servidor.');
    } else if (err instanceof ApiError && err.status === 503) {
      showConfigurationErrorScreen(root, err.body?.message);
    } else {
      console.error('[bootstrap] error', err);
      showNetworkErrorScreen(root);
    }
  }
}

function showUnpairedScreen(root, extraMsg = '') {
  root.innerHTML = `
    <div class="screen unpaired">
      <div class="screen-body" style="display:flex; flex-direction:column; justify-content:center; align-items:center; min-height:100vh; text-align:center;">
        <div class="empty-state-icon">🔒</div>
        <h2 style="margin-bottom: 1rem;">Kiosco no pareado</h2>
        <p>Este kiosco aún no ha sido asociado a una clínica.</p>
        <p style="color: var(--color-text-muted); margin-top: 0.5rem;">
          Contacta al administrador para iniciar el proceso de configuración.
        </p>
        ${extraMsg ? `<div class="alert alert-error" style="margin-top: 2rem;">${escapeHtml(extraMsg)}</div>` : ''}
      </div>
    </div>
  `;
}

function showConfigurationErrorScreen(root, message) {
  root.innerHTML = `
    <div class="screen">
      <div class="screen-body" style="display:flex; flex-direction:column; justify-content:center; align-items:center; min-height:100vh; text-align:center;">
        <div class="empty-state-icon">⚠️</div>
        <h2 style="margin-bottom: 1rem;">Configuración pendiente</h2>
        <p>${escapeHtml(message || 'La clínica aún no ha terminado su configuración.')}</p>
        <button type="button" class="btn btn-primary btn-lg" style="margin-top: 2rem;" onclick="location.reload()">
          Reintentar
        </button>
      </div>
    </div>
  `;
}

function showNetworkErrorScreen(root) {
  root.innerHTML = `
    <div class="screen">
      <div class="screen-body" style="display:flex; flex-direction:column; justify-content:center; align-items:center; min-height:100vh; text-align:center;">
        <div class="empty-state-icon">📡</div>
        <h2 style="margin-bottom: 1rem;">Sin conexión</h2>
        <p>No pudimos contactar al servidor del kiosco.</p>
        <p style="color: var(--color-text-muted); margin-top: 0.5rem;">
          Verifica la conexión de red. El kiosco reintentará automáticamente.
        </p>
        <button type="button" class="btn btn-primary btn-lg" style="margin-top: 2rem;" onclick="location.reload()">
          Reintentar
        </button>
      </div>
    </div>
  `;
  // Reintento automático cada 15s
  setTimeout(() => location.reload(), 15_000);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Go =====
bootstrap();
