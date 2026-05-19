/**
 * Pantalla standby — atractor inicial.
 * Soporta 3 modos: mensaje (texto), gif (imagen animada), video.
 * El media se cachea en IndexedDB para evitar descargas repetidas.
 * Cualquier toque inicia el flujo de identificación.
 */

import { state } from '../state.js';
import { api } from '../api.js';
import { getMedia, saveMedia, clearMedia } from '../lib/standby-cache.js';

let _blobUrl = null;

function revokeBlobUrl() {
  if (_blobUrl) {
    URL.revokeObjectURL(_blobUrl);
    _blobUrl = null;
  }
}

export function renderStandby(container, _params, navigate) {
  // Initial render from bootstrap config (fast, no network needed)
  const sb = state.config?.standby || {};
  const clinicName = state.config?.clinic?.display_name ?? 'Clínica Dental';
  const initMode = sb.mode || 'mensaje';
  const title = sb.title || clinicName;
  const subtitle = sb.subtitle || 'Bienvenido a nuestro autoservicio';

  renderFrame(container, { mode: initMode, title, subtitle, mediaEl: null }, navigate);

  // Async: check for updated media config and refresh if needed
  syncStandby(container, navigate, initMode, title, subtitle);

  return () => {
    // Cleanup on navigate away — keep Blob URL alive for re-entry
  };
}

async function syncStandby(container, navigate, initMode, initTitle, initSubtitle) {
  let cfg;
  try {
    cfg = await api.getStandbyConfig();
  } catch {
    // Network error — stay with bootstrap config
    return;
  }

  const mode     = cfg.mode     || 'mensaje';
  const title    = cfg.title    || initTitle;
  const subtitle = cfg.subtitle || initSubtitle;

  // If mode is "mensaje", clear any stale cached media and re-render if mode changed
  if (mode === 'mensaje') {
    await clearMedia();
    revokeBlobUrl();
    if (mode !== initMode || title !== initTitle || subtitle !== initSubtitle) {
      if (!isCurrentScreen(container)) return;
      renderFrame(container, { mode, title, subtitle, mediaEl: null }, navigate);
    }
    return;
  }

  // Mode requires media — resolve Blob from cache or download
  const serverHash = cfg.media_hash;
  let blobUrl = null;

  if (serverHash) {
    const cached = await getMedia();
    if (cached && cached.hash === serverHash) {
      // Cache hit
      revokeBlobUrl();
      _blobUrl = URL.createObjectURL(cached.blob);
      blobUrl = _blobUrl;
    } else {
      // Cache miss or stale — download
      try {
        const blob = await api.downloadStandbyMedia();
        await saveMedia(serverHash, blob);
        revokeBlobUrl();
        _blobUrl = URL.createObjectURL(blob);
        blobUrl = _blobUrl;
      } catch {
        // Download failed — fall back to mensaje mode
        if (!isCurrentScreen(container)) return;
        renderFrame(container, { mode: 'mensaje', title, subtitle, mediaEl: null }, navigate);
        return;
      }
    }
  }

  if (!isCurrentScreen(container)) return;

  const mediaEl = blobUrl ? buildMediaEl(mode, blobUrl) : null;
  renderFrame(container, { mode: mediaEl ? mode : 'mensaje', title, subtitle, mediaEl }, navigate);
}

function buildMediaEl(mode, src) {
  if (mode === 'gif') {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Standby GIF';
    img.className = 'standby-media standby-gif';
    return img;
  }
  // video
  const vid = document.createElement('video');
  vid.src = src;
  vid.autoplay = true;
  vid.loop = true;
  vid.muted = true;
  vid.playsInline = true;
  vid.className = 'standby-media standby-video';
  return vid;
}

function renderFrame(container, { mode, title, subtitle, mediaEl }, navigate) {
  container.innerHTML = `
    <div class="screen standby" id="standby-root">
      <div class="standby-content">
        ${mode === 'mensaje' ? `
          <div class="standby-logo">🦷</div>
          <h1 class="standby-title">${esc(title)}</h1>
          <p class="standby-subtitle">${esc(subtitle)}</p>
        ` : `
          <div id="standby-media-slot"></div>
          <h1 class="standby-title standby-title--media">${esc(title)}</h1>
          <p class="standby-subtitle">${esc(subtitle)}</p>
        `}
        <button type="button" class="standby-cta" id="standby-start">
          Toca para comenzar
        </button>
        <div class="standby-footer">
          <button type="button" class="link-btn" id="open-faq">
            Preguntas frecuentes
          </button>
        </div>
      </div>
    </div>
  `;

  if (mediaEl) {
    const slot = container.querySelector('#standby-media-slot');
    if (slot) slot.appendChild(mediaEl);
  }

  const goToLogin = () => navigate('habeas-data');

  container.querySelector('.standby').addEventListener('click', (e) => {
    if (e.target.closest('#open-faq')) return;
    goToLogin();
  });

  container.querySelector('#open-faq').addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('faq');
  });
}

function isCurrentScreen(container) {
  return !!container.querySelector('#standby-root');
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
