/**
 * Toast / snackbar para mensajes efímeros (errores de red, info).
 */

let toastTimer = null;

/**
 * Muestra un toast por unos segundos.
 * @param {string} message
 * @param {'error'|'success'|'info'} [type='info']
 * @param {number} [ms=4000]
 */
export function toast(message, type = 'info', ms = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  // Cerrar el toast anterior si existe (evitar acumulación)
  while (container.firstChild) container.removeChild(container.firstChild);
  if (toastTimer) clearTimeout(toastTimer);

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);

  requestAnimationFrame(() => el.classList.add('toast-visible'));

  toastTimer = setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 200);
  }, ms);
}
