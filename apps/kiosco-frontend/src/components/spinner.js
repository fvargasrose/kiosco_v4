/**
 * Spinner reutilizable.
 */

export function spinner({ text = 'Cargando…' } = {}) {
  return `
    <div class="loading-block">
      <div class="spinner"></div>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
