/**
 * Pantalla de identificación por teléfono (web pública).
 * El paciente escribe su celular; el backend lo busca en Dentalink y envía OTP.
 *
 * Web (Opción A): el OTP es OBLIGATORIO (login-direct fue eliminado del backend).
 * Antes de solicitar el OTP se resuelve el widget de Cloudflare Turnstile cuando
 * la clínica lo tiene configurado (anti-abuso de SMS).
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { toast } from '../components/toast.js';
import { renderTurnstile } from '../lib/turnstile.js';

export function renderLoginCedula(container, params, navigate) {
  const { policyVersion, policyHash } = params;
  const featureRegistro = state.config?.feature_registro === true;
  const turnstileSitekey = state.config?.turnstile_sitekey || null;

  if (!policyVersion || !policyHash) {
    navigate('habeas-data');
    return null;
  }

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Identifícate</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Cancelar
        </button>
      </header>
      <div class="screen-body">
        <div class="login-form">
          <p class="subtitle">
            Ingresa el celular registrado en la clínica.
          </p>

          <div id="form-error" class="form-error" style="display: none;"></div>

          <div class="form-group">
            <label for="phone">Celular</label>
            <div class="phone-input">
              <span class="phone-prefix">+57</span>
              <input type="tel" id="phone" inputmode="numeric" pattern="[0-9]*"
                     autocomplete="tel-national" placeholder="3001234567"
                     maxlength="10" data-kb="numeric">
            </div>
            <div class="form-help">10 dígitos, sin el +57. Te enviaremos un código por SMS y correo.</div>
          </div>

          ${turnstileSitekey ? '<div id="turnstile-box" class="turnstile-box"></div>' : ''}

          <button type="button" class="btn btn-primary btn-lg btn-full" id="submit-btn">
            Enviar código
          </button>

          ${featureRegistro ? `
          <div class="register-link-row">
            <span>¿Eres paciente nuevo?</span>
            <button type="button" class="link-btn-inline" id="register-btn">
              Regístrate aquí →
            </button>
          </div>
          ` : '<!-- DESHABILITADO — FEATURE_REGISTRO=false -->'}
        </div>
      </div>
    </div>
  `;

  const phoneInput = container.querySelector('#phone');
  const submitBtn = container.querySelector('#submit-btn');
  const errorEl = container.querySelector('#form-error');

  phoneInput.focus();

  phoneInput.addEventListener('input', () => {
    phoneInput.value = phoneInput.value.replace(/\D/g, '');
  });

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  };
  const clearError = () => {
    errorEl.style.display = 'none';
  };

  // Turnstile (solo si la clínica lo tiene configurado).
  let turnstile = null;
  if (turnstileSitekey) {
    const box = container.querySelector('#turnstile-box');
    renderTurnstile(box, turnstileSitekey)
      .then((handle) => { turnstile = handle; })
      .catch(() => {
        // Si el script de Turnstile no carga, no bloqueamos la UI: el backend
        // rechazará la solicitud sin token cuando el enforcement esté activo.
        console.warn('[turnstile] no se pudo inicializar el widget');
      });
  }

  let submitting = false;

  const handleSubmit = async () => {
    if (submitting) return;
    clearError();

    const phoneDigits = phoneInput.value.trim();

    if (!/^3\d{9}$/.test(phoneDigits)) {
      showError('El celular debe iniciar con 3 y tener 10 dígitos.');
      phoneInput.focus();
      return;
    }

    let turnstileToken = null;
    if (turnstileSitekey) {
      turnstileToken = turnstile?.getToken() ?? null;
      if (!turnstileToken) {
        showError('Completa la verificación de seguridad e intenta de nuevo.');
        return;
      }
    }

    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';

    try {
      const result = await api.requestOtp({
        phone: `+57${phoneDigits}`,
        policyVersion,
        policyHash,
        turnstileToken,
      });
      const maskedPhone = `+57 ${phoneDigits.slice(0, 3)} *** ${phoneDigits.slice(-2)}`;
      // Persistir el OTP en curso para sobrevivir el cambio de app en móvil
      // (ej: abrir el correo para leer el código y volver). Sin esto, al
      // re-montarse la pantalla sin params se perdía el flujo (§10).
      try {
        sessionStorage.setItem('dk_otp_pending', JSON.stringify({
          requestId: result.request_id,
          maskedPhone,
          expiresAt: Date.now() + (result.expires_in_seconds ?? 300) * 1000,
        }));
      } catch { /* sessionStorage no disponible: el flujo sigue funcionando en memoria */ }
      navigate('login-otp', {
        requestId: result.request_id,
        expiresInSeconds: result.expires_in_seconds,
        maskedPhone,
      });
    } catch (err) {
      submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Enviar código';
      turnstile?.reset();

      if (err instanceof ApiError) {
        if (err.status === 429) {
          const secs = Number(err.body?.retry_after_seconds) || 0;
          let wait = 'un momento';
          if (secs > 0) {
            const mins = Math.ceil(secs / 60);
            wait = mins <= 1 ? 'un minuto' : `${mins} minutos`;
          }
          showError(`Ya pediste un código hace poco. Espera ${wait} y vuelve a intentar.`);
        } else if (err.status === 401) {
          showError('Si el número está registrado, recibirás un código en breve.');
        } else if (err.status === 403) {
          showError('No pudimos verificar que eres una persona. Intenta de nuevo.');
        } else if (err.status === 400) {
          showError('Celular inválido. Verifica el número.');
        } else {
          showError('No pudimos procesar la solicitud. Intenta de nuevo.');
        }
      } else {
        toast('Error de conexión. Verifica tu internet.', 'error');
      }
    }
  };

  submitBtn.addEventListener('click', handleSubmit);

  phoneInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSubmit();
  });

  container.querySelector('#back-btn').addEventListener('click', () => navigate('standby'));

  // DESHABILITADO — FEATURE_REGISTRO. El listener solo se monta si el botón existe.
  if (featureRegistro) {
    container.querySelector('#register-btn').addEventListener('click', () => {
      navigate('register', { policyVersion, policyHash });
    });
  }

  return null;
}
