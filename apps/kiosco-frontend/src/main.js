/**
 * =============================================================================
 * App del paciente (web pública) — Entry point
 * =============================================================================
 *
 * Responsabilidades:
 *   1. Bootstrap: fetch a /public/bootstrap para obtener la config (sin token).
 *   2. Registrar todas las pantallas en el router.
 *   3. Restaurar la sesión persistida (sessionStorage) y renovarla si sigue viva.
 *   4. Renovación deslizante en visibilitychange/pageshow (§10).
 *   5. Arrancar el detector de inactividad (relajado) cuando hay paciente.
 *   6. Ir a la landing pública (standby).
 *
 * Modelo web (Opción A): NO hay kiosk_token. El control de acceso recae en
 * rate-limit + OTP + Turnstile + anti-enumeración (backend).
 */

import { api, ApiError } from './api.js';
import { setConfig, subscribe, state, clearPatient } from './state.js';
import { navigate, registerScreen, getCurrentScreen, initRouter, screenForPath } from './router.js';
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
import { renderPayment } from './screens/payment.js';
import { renderBooking } from './screens/booking.js';
import { renderRegister } from './screens/register.js';

// Apple theme screens (loaded always — only registered when theme === 'apple')
import { renderHomeApple } from './screens/home.apple.js';
import { renderAppointmentsApple } from './screens/appointments.apple.js';
import { renderTreatmentsApple } from './screens/treatments.apple.js';
import { renderBookingApple } from './screens/booking.apple.js';
import { renderPaymentApple } from './screens/payment.apple.js';

// Pantallas que requieren sesión de paciente: si la sesión cae, se redirige a la
// landing al volver a la app.
const AUTHED_SCREENS = new Set([
  'home', 'appointments', 'treatments', 'booking', 'payment', 'profile',
]);

// Pantallas públicas a las que se puede llegar por deep-link sin sesión.
const PUBLIC_SCREENS = new Set([
  'standby', 'faq', 'habeas-data', 'login-cedula', 'login-otp', 'register',
]);

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
registerScreen('payment', renderPayment);
registerScreen('booking', renderBooking);
// registerScreen('register', ...) se hace condicionalmente en bootstrap() según FEATURE_REGISTRO.

function activateAppleTheme() {
  // Fuentes self-hosted (Inter + Tabler Icons) — sin CDN, compatible con la CSP
  // estricta de producción (font-src 'self'). Vite empaqueta los .woff2.
  import('@fontsource/inter/300.css').catch(() => {});
  import('@fontsource/inter/400.css').catch(() => {});
  import('@fontsource/inter/500.css').catch(() => {});
  import('@fontsource/inter/600.css').catch(() => {});
  import('@fontsource/inter/700.css').catch(() => {});
  import('@tabler/icons-webfont/dist/tabler-icons.min.css').catch(() => {});

  // Inyectar hoja de estilos apple — Vite la procesa y la incluye en el bundle
  import('./styles-apple.css').catch(() => {});

  document.body.classList.add('theme-apple');

  // Sobreescribir las pantallas post-login con versiones apple
  registerScreen('home',         renderHomeApple);
  registerScreen('appointments', renderAppointmentsApple);
  registerScreen('treatments',   renderTreatmentsApple);
  registerScreen('booking',      renderBookingApple);
  registerScreen('payment',      renderPaymentApple);
}

// ===== Idle timer: arranca cuando hay paciente, se detiene cuando se va =====
// Web (§10): inactividad larga (30 min), no el idle agresivo de kiosco (90 s).
let idleRunning = false;
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

// ===== Renovación de sesión al volver a la app (§10) =====
// En móvil, al cambiar de app y volver, el access token puede haber expirado.
// Renovamos silenciosamente; si la sesión ya no es válida, se cierra y se
// vuelve a la landing (preservando una UX no hostil).
let refreshing = false;
async function refreshOnResume() {
  if (refreshing) return;
  if (!api.hasSession) return;
  refreshing = true;
  try {
    const ok = await api.refreshSession();
    if (!ok && AUTHED_SCREENS.has(getCurrentScreen())) {
      clearPatient();
      toast('Tu sesión expiró. Inicia de nuevo.', 'info');
      navigate('standby');
    }
  } finally {
    refreshing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshOnResume();
});
// pageshow cubre el bfcache (volver con el botón atrás del navegador en móvil).
window.addEventListener('pageshow', (e) => {
  if (e.persisted) refreshOnResume();
});

// ===== Bootstrap =====

async function bootstrap() {
  const root = document.getElementById('app');

  let config;
  try {
    config = await api.bootstrap();
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      showConfigurationErrorScreen(root, err.body?.message);
    } else {
      console.error('[bootstrap] error', err);
      showNetworkErrorScreen(root);
    }
    return;
  }

  setConfig(config);
  if (config.feature_registro) {
    registerScreen('register', renderRegister);
  }
  if (config.theme === 'apple') activateAppleTheme();

  // Routing real: instalar back/forward y resolver la pantalla inicial según la
  // URL (deep-link / refresh) y la sesión.
  initRouter();
  const urlScreen = screenForPath(window.location.pathname);

  // Restaurar sesión persistida: si hay token, validarlo con un refresh.
  if (api.hasSession) {
    const ok = await api.refreshSession();
    if (ok && state.patient) {
      // Respeta el deep-link a una pantalla conocida; '/' o desconocida → home.
      const target = urlScreen && urlScreen !== 'standby' ? urlScreen : 'home';
      navigate(target, {}, { replace: true });
      return;
    }
    clearPatient();
  }

  // Sin sesión: solo pantallas públicas por deep-link; el resto → landing.
  const target = urlScreen && PUBLIC_SCREENS.has(urlScreen) ? urlScreen : 'standby';
  navigate(target, {}, { replace: true });
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
        <p>No pudimos contactar al servidor.</p>
        <p style="color: var(--color-text-muted); margin-top: 0.5rem;">
          Verifica tu conexión a internet e intenta de nuevo.
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
