/**
 * Pantalla de identificación por teléfono.
 * El paciente sólo escribe su celular; el backend lo busca en Dentalink.
 * (Nombre de archivo conservado para no romper el router.)
 */

import { api, ApiError } from '../api.js';
import { setPatient, state } from '../state.js';
import { toast } from '../components/toast.js';

export function renderLoginCedula(container, params, navigate) {
  const { policyVersion, policyHash } = params;
  const otpRequired = params.otpRequired !== false;
  const featureRegistro = state.config?.feature_registro === true;

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
            Ingresa el celular registrado en la clínica.${otpRequired ? '' : ' No se requiere código de verificación.'}
          </p>

          <div id="form-error" class="form-error" style="display: none;"></div>

          <div class="form-group">
            <label for="phone">Celular</label>
            <div class="phone-input">
              <span class="phone-prefix">+57</span>
              <input type="tel" id="phone" inputmode="numeric" pattern="[0-9]*"
                     autocomplete="off" placeholder="3001234567"
                     maxlength="10">
            </div>
            <div class="form-help">10 dígitos, sin el +57.${otpRequired ? ' Te enviaremos un código por SMS y correo.' : ''}</div>
          </div>

          <button type="button" class="btn btn-primary btn-lg btn-full" id="submit-btn">
            ${otpRequired ? 'Enviar código' : 'Ingresar'}
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

    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = otpRequired ? 'Enviando...' : 'Verificando...';

    try {
      if (otpRequired) {
        const result = await api.requestOtp({
          phone: `+57${phoneDigits}`,
          policyVersion,
          policyHash,
        });
        navigate('login-otp', {
          requestId: result.request_id,
          expiresInSeconds: result.expires_in_seconds,
          maskedPhone: `+57 ${phoneDigits.slice(0, 3)} *** ${phoneDigits.slice(-2)}`,
        });
      } else {
        const result = await api.loginDirect({
          phone: `+57${phoneDigits}`,
          policyVersion,
          policyHash,
        });
        setPatient(result.patient);
        navigate('home');
      }
    } catch (err) {
      submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = otpRequired ? 'Enviar código' : 'Ingresar';

      if (err instanceof ApiError) {
        if (err.status === 429) {
          showError('Demasiados intentos. Espera unos minutos antes de volver a intentar.');
        } else if (err.status === 401) {
          showError('Si el número está registrado, recibirás un código en breve.');
        } else if (err.status === 400) {
          showError('Celular inválido. Verifica el número.');
        } else if (err.status === 403) {
          showError('Este kiosco no está autorizado. Contacta a recepción.');
        } else {
          showError('No pudimos procesar la solicitud. Intenta de nuevo.');
        }
      } else {
        toast('Error de conexión. Verifica la red del kiosco.', 'error');
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
