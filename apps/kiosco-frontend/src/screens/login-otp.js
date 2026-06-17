/**
 * Pantalla login-otp — captura código de 6 dígitos.
 *
 * 6 inputs separados, auto-focus al siguiente, paste-to-fill.
 * Si todos los dígitos están llenos, auto-submit.
 */

import { api, ApiError } from '../api.js';
import { setPatient } from '../state.js';
import { toast } from '../components/toast.js';

export function renderLoginOtp(container, params, navigate) {
  let { requestId, expiresInSeconds = 300, maskedPhone = '' } = params;

  // Restaurar el OTP en curso si la pantalla se re-monta sin params (típico en
  // móvil: cambiar a la app de correo para leer el código y volver recarga la
  // pestaña). El estado se persiste en sessionStorage desde login-cedula (§10).
  if (!requestId) {
    try {
      const saved = JSON.parse(sessionStorage.getItem('dk_otp_pending') || 'null');
      if (saved && saved.requestId) {
        const secondsLeft = Math.floor((saved.expiresAt - Date.now()) / 1000);
        if (secondsLeft > 0) {
          requestId = saved.requestId;
          maskedPhone = saved.maskedPhone || '';
          expiresInSeconds = secondsLeft;
        } else {
          // Código ya vencido: limpiar y volver a empezar.
          sessionStorage.removeItem('dk_otp_pending');
        }
      }
    } catch { /* sessionStorage no disponible: seguimos el flujo normal */ }
  }

  if (!requestId) {
    navigate('habeas-data');
    return null;
  }

  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Código de verificación</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Cancelar
        </button>
      </header>
      <div class="screen-body">
        <div class="login-form">
          <p class="subtitle">
            Enviamos tu código al correo y al celular registrados (<strong>${escapeHtml(maskedPhone)}</strong>).
          </p>
          <p class="otp-meta">
            El código expira en <span id="countdown">${formatTime(expiresInSeconds)}</span>
          </p>

          <div id="form-error" class="form-error" style="display: none;"></div>

          <div class="otp-inputs" id="otp-inputs">
            <input type="tel" inputmode="numeric" maxlength="1" class="otp-digit" data-kb="numeric" data-index="0">
            <input type="tel" inputmode="numeric" maxlength="1" class="otp-digit" data-kb="numeric" data-index="1">
            <input type="tel" inputmode="numeric" maxlength="1" class="otp-digit" data-kb="numeric" data-index="2">
            <input type="tel" inputmode="numeric" maxlength="1" class="otp-digit" data-kb="numeric" data-index="3">
            <input type="tel" inputmode="numeric" maxlength="1" class="otp-digit" data-kb="numeric" data-index="4">
            <input type="tel" inputmode="numeric" maxlength="1" class="otp-digit" data-kb="numeric" data-index="5">
          </div>

          <button type="button" class="btn btn-primary btn-lg btn-full" id="submit-btn" disabled>
            Verificar
          </button>
        </div>
      </div>
    </div>
  `;

  const inputs = Array.from(container.querySelectorAll('.otp-digit'));
  const submitBtn = container.querySelector('#submit-btn');
  const errorEl = container.querySelector('#form-error');
  const countdownEl = container.querySelector('#countdown');

  // Countdown
  let remaining = expiresInSeconds;
  const countdownInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownEl.textContent = 'expirado';
      submitBtn.disabled = true;
      // Código vencido: limpiar el estado persistido para no restaurarlo.
      try { sessionStorage.removeItem('dk_otp_pending'); } catch { /* noop */ }
      showError('El código expiró. Toca "Cancelar" para volver a intentar.');
      return;
    }
    countdownEl.textContent = formatTime(remaining);
  }, 1000);

  const getCode = () => inputs.map((i) => i.value).join('');
  const updateSubmitState = () => {
    submitBtn.disabled = getCode().length !== 6;
  };

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
    const code = getCode();
    if (code.length !== 6) return;
    if (remaining <= 0) return;

    clearError();
    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verificando...';

    try {
      const result = await api.verifyOtp({ requestId, code });
      // result.patient = { id, name, ... }
      setPatient(result.patient);
      // OTP consumido: limpiar el estado persistido.
      try { sessionStorage.removeItem('dk_otp_pending'); } catch { /* noop */ }
      // Detener el countdown
      clearInterval(countdownInterval);
      navigate('home');
    } catch (err) {
      submitting = false;
      submitBtn.textContent = 'Verificar';

      // Limpiar inputs y volver al primero
      inputs.forEach((i) => (i.value = ''));
      inputs[0].focus();
      updateSubmitState();

      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 400) {
          showError('Código incorrecto. Verifica el SMS o correo recibido.');
        } else if (err.status === 429) {
          showError('Demasiados intentos fallidos. Toca "Cancelar" y vuelve a empezar.');
          submitBtn.disabled = true;
        } else if (err.status === 410 || err.status === 404) {
          showError('El código expiró o ya fue usado. Toca "Cancelar" para volver a empezar.');
          submitBtn.disabled = true;
        } else {
          showError('No pudimos verificar el código. Intenta de nuevo.');
        }
      } else {
        toast('Error de conexión.', 'error');
      }
    }
  };

  // Comportamiento de inputs de OTP
  inputs.forEach((input, idx) => {
    input.addEventListener('input', (e) => {
      // Solo dígitos
      const v = input.value.replace(/\D/g, '');
      input.value = v.slice(-1);

      if (input.value && idx < inputs.length - 1) {
        inputs[idx + 1].focus();
      }
      updateSubmitState();

      // Auto-submit cuando se completen los 6
      if (getCode().length === 6) {
        handleSubmit();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && idx > 0) {
        inputs[idx - 1].focus();
      }
      if (e.key === 'Enter') handleSubmit();
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      [...pasted].forEach((ch, i) => {
        if (inputs[i]) inputs[i].value = ch;
      });
      const lastFilled = Math.min(pasted.length, inputs.length) - 1;
      if (lastFilled >= 0) inputs[Math.min(lastFilled + 1, inputs.length - 1)].focus();
      updateSubmitState();
      if (getCode().length === 6) handleSubmit();
    });
  });

  inputs[0].focus();

  submitBtn.addEventListener('click', handleSubmit);

  container.querySelector('#back-btn').addEventListener('click', () => {
    clearInterval(countdownInterval);
    // Cancelar: descartar el OTP en curso.
    try { sessionStorage.removeItem('dk_otp_pending'); } catch { /* noop */ }
    navigate('standby');
  });

  // Cleanup
  return () => clearInterval(countdownInterval);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
