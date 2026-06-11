import { api, ApiError } from '../api.js';

export async function renderLogin(container, onSuccess) {
  let mfaChallengeToken = null;

  const showLoginForm = () => {
    container.innerHTML = `
      <div class="page-center">
        <div class="login-box">
          <div class="login-title">🦷 DentalKiosco Admin</div>
          <div id="login-alert"></div>
          <div class="form-group">
            <label for="email">Correo electrónico</label>
            <input type="email" id="email" class="form-control" autocomplete="username" placeholder="admin@clinica.co">
          </div>
          <div class="form-group">
            <label for="password">Contraseña</label>
            <input type="password" id="password" class="form-control" autocomplete="current-password">
          </div>
          <button type="button" class="btn btn-primary" id="login-btn" style="width:100%;justify-content:center">
            Ingresar
          </button>
          <button type="button" class="btn-link" id="forgot-link"
                  style="display:block;width:100%;margin-top:.75rem;background:none;border:none;color:var(--muted);cursor:pointer;font-size:.875rem;text-align:center">
            ¿Olvidaste tu contraseña?
          </button>
        </div>
      </div>
    `;

    const alertEl = container.querySelector('#login-alert');
    const btn = container.querySelector('#login-btn');
    container.querySelector('#forgot-link').addEventListener('click', () => showForgotForm());

    const submit = async () => {
      const email = container.querySelector('#email').value.trim();
      const pass  = container.querySelector('#password').value;
      if (!email || !pass) { alertEl.innerHTML = '<div class="alert alert-error">Completa todos los campos.</div>'; return; }
      btn.disabled = true;
      btn.textContent = 'Ingresando...';
      alertEl.innerHTML = '';
      try {
        const res = await api.login(email, pass);
        if (res.session_token) {
          api.setToken(res.session_token);
          onSuccess();
        } else if (res.mfa_required) {
          mfaChallengeToken = res.mfa_challenge_token;
          showMfaForm();
        } else if (res.mfa_enrollment_required) {
          alertEl.innerHTML = '<div class="alert alert-warn">Este admin requiere configurar MFA. Contacta al superadmin.</div>';
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          alertEl.innerHTML = '<div class="alert alert-error">Credenciales incorrectas.</div>';
        } else if (err instanceof ApiError && err.status === 423) {
          alertEl.innerHTML = '<div class="alert alert-error">Cuenta bloqueada temporalmente.</div>';
        } else {
          alertEl.innerHTML = '<div class="alert alert-error">Error de conexión.</div>';
        }
        btn.disabled = false;
        btn.textContent = 'Ingresar';
      }
    };

    btn.addEventListener('click', submit);
    container.querySelector('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  };

  const showMfaForm = () => {
    container.innerHTML = `
      <div class="page-center">
        <div class="login-box">
          <div class="login-title">🔐 Verificación MFA</div>
          <div id="mfa-alert"></div>
          <p style="font-size:.9375rem;color:var(--muted);margin-bottom:1rem;">
            Ingresa el código de 6 dígitos de tu app autenticadora.
          </p>
          <div class="form-group">
            <label for="code">Código TOTP</label>
            <input type="text" id="code" class="form-control" maxlength="6" inputmode="numeric"
                   pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="000000"
                   style="letter-spacing:.3em;font-size:1.25rem;text-align:center">
          </div>
          <button type="button" class="btn btn-primary" id="mfa-btn" style="width:100%;justify-content:center">
            Verificar
          </button>
          <button type="button" class="btn btn-secondary" id="back-btn" style="width:100%;justify-content:center;margin-top:.5rem">
            ← Volver
          </button>
        </div>
      </div>
    `;

    const alertEl = container.querySelector('#mfa-alert');
    const btn = container.querySelector('#mfa-btn');

    const submit = async () => {
      const code = container.querySelector('#code').value.trim();
      if (!/^\d{6}$/.test(code)) { alertEl.innerHTML = '<div class="alert alert-error">Código debe tener 6 dígitos.</div>'; return; }
      btn.disabled = true;
      btn.textContent = 'Verificando...';
      alertEl.innerHTML = '';
      try {
        const res = await api.verifyMfa(mfaChallengeToken, code);
        api.setToken(res.session_token);
        onSuccess();
      } catch (err) {
        alertEl.innerHTML = `<div class="alert alert-error">${err instanceof ApiError && err.status === 401 ? 'Código incorrecto o expirado.' : 'Error de verificación.'}</div>`;
        btn.disabled = false;
        btn.textContent = 'Verificar';
      }
    };

    btn.addEventListener('click', submit);
    container.querySelector('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    container.querySelector('#back-btn').addEventListener('click', showLoginForm);
  };

  const showForgotForm = () => {
    container.innerHTML = `
      <div class="page-center">
        <div class="login-box">
          <div class="login-title">🔑 Recuperar contraseña</div>
          <div id="forgot-alert"></div>
          <p style="font-size:.9375rem;color:var(--muted);margin-bottom:1rem;">
            Escribe tu correo. Si existe una cuenta, te enviaremos un código de 6 dígitos.
          </p>
          <div class="form-group">
            <label for="fp-email">Correo electrónico</label>
            <input type="email" id="fp-email" class="form-control" autocomplete="username" placeholder="admin@clinica.co">
          </div>
          <button type="button" class="btn btn-primary" id="fp-btn" style="width:100%;justify-content:center">
            Enviar código
          </button>
          <button type="button" class="btn btn-secondary" id="fp-back" style="width:100%;justify-content:center;margin-top:.5rem">
            ← Volver
          </button>
        </div>
      </div>
    `;
    const alertEl = container.querySelector('#forgot-alert');
    const btn = container.querySelector('#fp-btn');
    const submit = async () => {
      const email = container.querySelector('#fp-email').value.trim();
      if (!email) { alertEl.innerHTML = '<div class="alert alert-error">Escribe tu correo.</div>'; return; }
      btn.disabled = true;
      btn.textContent = 'Enviando...';
      alertEl.innerHTML = '';
      try {
        await api.forgotPassword(email);
        showResetForm(email);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          alertEl.innerHTML = '<div class="alert alert-error">Demasiados intentos. Espera un momento.</div>';
        } else {
          alertEl.innerHTML = '<div class="alert alert-error">Error de conexión.</div>';
        }
        btn.disabled = false;
        btn.textContent = 'Enviar código';
      }
    };
    btn.addEventListener('click', submit);
    container.querySelector('#fp-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    container.querySelector('#fp-back').addEventListener('click', showLoginForm);
  };

  const showResetForm = (email) => {
    container.innerHTML = `
      <div class="page-center">
        <div class="login-box">
          <div class="login-title">🔑 Nueva contraseña</div>
          <div id="rp-alert"></div>
          <p style="font-size:.9375rem;color:var(--muted);margin-bottom:1rem;">
            Si el correo existe, te enviamos un código a <strong>${email}</strong>. Ingrésalo y define tu nueva contraseña.
          </p>
          <div class="form-group">
            <label for="rp-code">Código (6 dígitos)</label>
            <input type="text" id="rp-code" class="form-control" maxlength="6" inputmode="numeric"
                   pattern="[0-9]{6}" autocomplete="one-time-code" placeholder="000000"
                   style="letter-spacing:.3em;font-size:1.25rem;text-align:center">
          </div>
          <div class="form-group">
            <label for="rp-pass">Nueva contraseña</label>
            <input type="password" id="rp-pass" class="form-control" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label for="rp-pass2">Repetir contraseña</label>
            <input type="password" id="rp-pass2" class="form-control" autocomplete="new-password">
          </div>
          <p style="font-size:.8125rem;color:var(--muted);margin-bottom:1rem;">
            Mínimo 10 caracteres, con mayúscula, minúscula, número y carácter especial.
          </p>
          <button type="button" class="btn btn-primary" id="rp-btn" style="width:100%;justify-content:center">
            Guardar nueva contraseña
          </button>
          <button type="button" class="btn btn-secondary" id="rp-back" style="width:100%;justify-content:center;margin-top:.5rem">
            ← Volver
          </button>
        </div>
      </div>
    `;
    const alertEl = container.querySelector('#rp-alert');
    const btn = container.querySelector('#rp-btn');
    const submit = async () => {
      const code  = container.querySelector('#rp-code').value.trim();
      const pass  = container.querySelector('#rp-pass').value;
      const pass2 = container.querySelector('#rp-pass2').value;
      if (!/^\d{6}$/.test(code)) { alertEl.innerHTML = '<div class="alert alert-error">El código debe tener 6 dígitos.</div>'; return; }
      if (pass !== pass2) { alertEl.innerHTML = '<div class="alert alert-error">Las contraseñas no coinciden.</div>'; return; }
      btn.disabled = true;
      btn.textContent = 'Guardando...';
      alertEl.innerHTML = '';
      try {
        await api.resetPassword(email, code, pass);
        showLoginForm();
        const a = container.querySelector('#login-alert');
        if (a) a.innerHTML = '<div class="alert alert-success">Contraseña actualizada. Inicia sesión.</div>';
      } catch (err) {
        let msg = 'Error de conexión.';
        if (err instanceof ApiError) {
          if (err.body && err.body.error === 'WEAK_PASSWORD') {
            msg = 'Contraseña débil: ' + ((err.body.errors || []).join(', ') || 'no cumple los requisitos');
          } else if (err.body && err.body.error === 'TOO_MANY_ATTEMPTS') {
            msg = 'Demasiados intentos. Solicita un código nuevo.';
          } else if (err.status === 400) {
            msg = 'Código inválido o expirado.';
          }
        }
        alertEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
        btn.disabled = false;
        btn.textContent = 'Guardar nueva contraseña';
      }
    };
    btn.addEventListener('click', submit);
    container.querySelector('#rp-pass2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    container.querySelector('#rp-back').addEventListener('click', showLoginForm);
  };

  showLoginForm();
}
