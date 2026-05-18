/**
 * Modal genérico — para warnings de idle y confirmaciones.
 * Crea / destruye el DOM dinámicamente.
 */

let activeModal = null;

/**
 * Muestra un modal. Cierra automáticamente cualquier modal anterior.
 *
 * @param {Object} opts
 * @param {string} opts.title       Título grande
 * @param {string} opts.body        Texto explicativo (puede incluir HTML escapado)
 * @param {string} [opts.icon]      Emoji o icono al inicio (ej: '⏰')
 * @param {Array<{label, action, variant?}>} opts.actions  Botones
 * @param {boolean} [opts.dismissible=false]  Si permite cerrar tocando fuera
 * @returns {{ close: () => void }}
 */
export function showModal({ title, body, icon = '', actions = [], dismissible = false }) {
  closeActiveModal();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const card = document.createElement('div');
  card.className = 'modal-card';

  const iconHtml = icon ? `<div class="modal-icon">${escapeHtml(icon)}</div>` : '';

  card.innerHTML = `
    ${iconHtml}
    <h2 class="modal-title">${escapeHtml(title)}</h2>
    <p class="modal-body">${escapeHtml(body)}</p>
    <div class="modal-actions"></div>
  `;

  const actionsContainer = card.querySelector('.modal-actions');
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${variantClass(a.variant)} btn-lg`;
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      close();
      try {
        a.action?.();
      } catch (err) {
        console.error('[modal] action error', err);
      }
    });
    actionsContainer.appendChild(btn);
  }

  if (dismissible) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Animación de entrada en próximo tick
  requestAnimationFrame(() => overlay.classList.add('modal-overlay-visible'));

  const close = () => {
    if (overlay.parentNode) {
      overlay.classList.remove('modal-overlay-visible');
      setTimeout(() => overlay.remove(), 200);
    }
    if (activeModal === handle) activeModal = null;
  };

  const handle = { close };
  activeModal = handle;
  return handle;
}

export function closeActiveModal() {
  if (activeModal) {
    activeModal.close();
    activeModal = null;
  }
}

function variantClass(variant) {
  switch (variant) {
    case 'danger':
      return 'btn-danger';
    case 'secondary':
      return 'btn-secondary';
    default:
      return 'btn-primary';
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
