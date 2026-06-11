import { api, ApiError } from '../api.js';

export function renderChangePassword(container) {
  container.innerHTML = `
    <h1 class="page-title">Cambiar contraseña</h1>
    <div class="card" style="max-width:520px">
      <div id="cp-alert"></div>
      <div class="form-group">
        <label for="cp-current">Contraseña actual</label>
        <input type="password" id="cp-current" class="form-control" autocomplete="current-password">
      </div>
      <div class="form-group">
        <label for="cp-new">Nueva contraseña</label>
        <input type="password" id="cp-new" class="form-control" autocomplete="new-password">
      </div>
      <div class="form-group">
        <label for="cp-new2">Repetir nueva contraseña</label>
        <input type="password" id="cp-new2" class="form-control" autocomplete="new-password">
      </div>
      <p style="font-size:.8125rem;color:var(--muted);margin-bottom:1rem;">
        Mínimo 10 caracteres, con mayúscula, minúscula, número y carácter especial.
      </p>
      <button type="button" class="btn btn-primary" id="cp-btn">Guardar</button>
    </div>
  `;

  const alertEl = container.querySelector('#cp-alert');
  const btn = container.querySelector('#cp-btn');

  const submit = async () => {
    const cur = container.querySelector('#cp-current').value;
    const nw  = container.querySelector('#cp-new').value;
    const nw2 = container.querySelector('#cp-new2').value;
    if (!cur || !nw) { alertEl.innerHTML = '<div class="alert alert-error">Completa todos los campos.</div>'; return; }
    if (nw !== nw2)  { alertEl.innerHTML = '<div class="alert alert-error">Las contraseñas no coinciden.</div>'; return; }

    btn.disabled = true;
    btn.textContent = 'Guardando...';
    alertEl.innerHTML = '';
    try {
      await api.changePassword(cur, nw);
      alertEl.innerHTML = '<div class="alert alert-success">Contraseña actualizada correctamente.</div>';
      container.querySelector('#cp-current').value = '';
      container.querySelector('#cp-new').value = '';
      container.querySelector('#cp-new2').value = '';
    } catch (err) {
      let msg = 'Error de conexión.';
      if (err instanceof ApiError) {
        if (err.body && err.body.error === 'WEAK_PASSWORD') {
          msg = 'Contraseña débil: ' + ((err.body.errors || []).join(', ') || 'no cumple los requisitos');
        } else if (err.body && err.body.error === 'SAME_PASSWORD') {
          msg = 'La nueva contraseña debe ser distinta a la actual.';
        } else if (err.status === 401) {
          msg = 'La contraseña actual es incorrecta.';
        }
      }
      alertEl.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Guardar';
    }
  };

  btn.addEventListener('click', submit);
  container.querySelector('#cp-new2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}
