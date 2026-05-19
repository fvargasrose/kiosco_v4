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
        </div>
      </div>
    `;

    const alertEl = container.querySelector('#login-alert');
    const btn = container.querySelector('#login-btn');

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

  showLoginForm();
}
