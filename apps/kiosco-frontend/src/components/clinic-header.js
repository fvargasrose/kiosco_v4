/**
 * Header global con el branding de la clínica.
 *
 * Si hay logo subido (logoUrl), se muestra como <img> compacta (max-height 60px).
 * Si no, fallback al nombre de la clínica en texto.
 *
 * Opcionalmente acepta un screenTitle que se renderiza a la derecha del logo,
 * separado por un divisor visual. Útil para pantallas que no traen título propio.
 *
 * Devuelve un string HTML — se inserta donde el caller necesite.
 */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderClinicHeader(logoUrl, clinicName, screenTitle = '') {
  const name = clinicName || 'Clínica';
  const brand = logoUrl
    ? `<img class="clinic-header-logo" src="${esc(logoUrl)}" alt="${esc(name)}">`
    : `<span class="clinic-header-name">${esc(name)}</span>`;

  const titleHtml = screenTitle
    ? `<h1 class="clinic-header-title">${esc(screenTitle)}</h1>`
    : '';

  return `
    <header class="clinic-header">
      <div class="clinic-header-brand">${brand}</div>
      ${titleHtml}
    </header>
  `;
}
