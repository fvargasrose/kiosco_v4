/**
 * Pantalla login-cedula — captura cédula y celular.
 * Envía /auth/request-otp con consent + policy_version + policy_hash.
 */

import { api, ApiError } from '../api.js';
import { setPatient } from '../state.js';
import { toast } from '../components/toast.js';

export function renderLoginCedula(container, params, navigate) {
  const { policyVersion, policyHash } = params;
  // Leído del bootstrap; true por defecto si no está definido (seguro).
  const otpRequired = params.otpRequired !== false;

  if (!policyVersion || !policyHash) {
    // No deberíamos llegar aquí sin haber pasado por habeas-data
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
            Por favor ingresa tu cédula y celular registrados en la clínica.${otpRequired ? '' : ' No se requiere código de verificación.'}
          </p>

          <div id="form-error" class="form-error" style="display: none;"></div>

          <div class="form-group">
            <label for="cedula">Cédula de ciudadanía</label>
            <input type="tel" id="cedula" inputmode="numeric" pattern="[0-9]*"
                   autocomplete="off" placeholder="Solo números"
                   maxlength="15">
            <div class="form-help">Sin puntos ni espacios.</div>
          </div>

          <div class="form-group">
            <label for="phone">Celular</label>
            <div class="phone-input">
              <span class="phone-prefix">+57</span>
              <input type="tel" id="phone" inputmode="numeric" pattern="[0-9]*"
                     autocomplete="off" placeholder="3001234567"
                     maxlength="10">
            </div>
            <div class="form-help">10 dígitos, sin el +57.${otpRequired ? ' Te enviaremos un código.' : ''}</div>
          </div>

          <button type="button" class="btn btn-primary btn-lg btn-full" id="submit-btn">
            ${otpRequired ? 'Enviar código' : 'Ingresar'}
          </button>

          <div class="register-link-row">
            <span>¿Eres paciente nuevo?</span>
            <button type="button" class="link-btn-inline" id="register-btn">
              Regístrate aquí →
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const cedulaInput = container.querySelector('#cedula');
  const phoneInput = container.querySelector('#phone');
  const submitBtn = container.querySelector('#submit-btn');
  const errorEl = container.querySelector('#form-error');

  cedulaInput.focus();

  // Solo permitir dígitos
  const onlyDigits = (input) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '');
    });
  };
  onlyDigits(cedulaInput);
  onlyDigits(phoneInput);

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

    const cedula = cedulaInput.value.trim();
    const phoneDigits = phoneInput.value.trim();

    if (!/^\d{6,12}$/.test(cedula)) {
      showError('Cédula inválida. Verifica que solo tenga números.');
      cedulaInput.focus();
      return;
    }
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
          cedula,
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
          cedula,
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
          showError('Cédula o celular no coinciden con nuestros registros. Verifica los datos.');
        } else if (err.status === 400) {
          showError('Datos inválidos. Verifica cédula y celular.');
        } else if (err.status === 403) {
          showError('Este kiosco no está autorizado. Contacta a recepción.');
        } else {
          showError('No pudimos verificar tus datos. Intenta de nuevo.');
        }
      } else {
        toast('Error de conexión. Verifica la red del kiosco.', 'error');
      }
    }
  };

  submitBtn.addEventListener('click', handleSubmit);

  // Enter en cualquier input → submit
  [cedulaInput, phoneInput].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSubmit();
    });
  });

  container.querySelector('#back-btn').addEventListener('click', () => navigate('standby'));

  container.querySelector('#register-btn').addEventListener('click', () => {
    navigate('register', { policyVersion, policyHash });
  });

  return null;
}
