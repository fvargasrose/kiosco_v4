import QRCode from 'qrcode-svg';
import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { showModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { renderAppleShell } from './shared/shell.apple.js';

const POLL_INTERVAL_FAST_MS = 3000;
const POLL_INTERVAL_SLOW_MS = 5000;
const POLL_SLOW_AFTER_MS    = 60_000;

export async function renderPaymentApple(container, params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  const { treatmentId, amountCop, description, returnTo = 'treatments' } = params;

  if (!amountCop || !description) {
    navigate(returnTo);
    return null;
  }

  let pollTimer = null;
  let aborted   = false;
  let mainEl    = null;
  let onVisible = null;

  const cleanup = () => {
    aborted = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (onVisible) {
      document.removeEventListener('visibilitychange', onVisible);
      onVisible = null;
    }
  };

  renderAppleShell(container, 'treatments', navigate, (main) => {
    mainEl = main;
    main.innerHTML = `
      <div class="ak-page-header" style="margin-bottom:20px;">
        <div>
          <div class="ak-page-title">Realizar pago</div>
          <div class="ak-page-subtitle">${escapeHtml(description)}</div>
        </div>
        <button type="button" class="ak-btn-outline" id="back-btn">
          <i class="ti ti-x"></i> Cancelar
        </button>
      </div>
      <div id="payment-content">${spinner({ text: 'Preparando tu pago...' })}</div>
    `;

    main.querySelector('#back-btn').addEventListener('click', () => {
      cleanup();
      navigate(returnTo);
    });
  });

  const content = container.querySelector('#payment-content');
  if (!content) return cleanup;

  // Crear payment link
  let payment;
  try {
    payment = await api.createPayment({ treatmentId, amountCop, description });
  } catch (err) {
    if (aborted) return cleanup;
    renderCreationError(content, err, () => { cleanup(); navigate(returnTo); });
    return cleanup;
  }

  if (aborted) return cleanup;
  renderPayScreen(content, payment, () => { cleanup(); navigate(returnTo); });

  // Polling
  const startedAt = Date.now();
  let lastStatus = 'pending';

  const poll = async () => {
    if (aborted) return;
    try {
      const result = await api.getPaymentStatus(payment.reference);
      if (aborted) return;

      if (result.status !== lastStatus) {
        lastStatus = result.status;
        handleStatusChange(result, content, navigate, returnTo, cleanup);
        if (isTerminal(result.status)) return;
      } else {
        updateExpiryCountdown(content, payment.expires_at);
      }

      const elapsed  = Date.now() - startedAt;
      const interval = elapsed > POLL_SLOW_AFTER_MS ? POLL_INTERVAL_SLOW_MS : POLL_INTERVAL_FAST_MS;
      pollTimer = setTimeout(poll, interval);
    } catch (err) {
      if (aborted) return;
      console.warn('[payment] polling error', err);
      pollTimer = setTimeout(poll, POLL_INTERVAL_SLOW_MS);
    }
  };

  pollTimer = setTimeout(poll, POLL_INTERVAL_FAST_MS);

  // Reanudar el polling al volver a la app (§10): tras pagar en Wompi/Nequi el
  // paciente regresa a esta pestaña; hacemos una comprobación inmediata para
  // reflejar el estado sin esperar al siguiente tick.
  onVisible = () => {
    if (aborted) return;
    if (document.visibilityState !== 'visible') return;
    if (pollTimer) clearTimeout(pollTimer);
    poll();
  };
  document.addEventListener('visibilitychange', onVisible);

  return cleanup;
}

// ─── Renderers ───────────────────────────────────────────────────────────────

function renderPayScreen(container, payment, onCancel) {
  // En móvil el paciente ya está en su teléfono: el camino principal es el botón
  // "Pagar ahora" que abre el enlace de Wompi. El QR queda como ayuda para pagar
  // desde OTRO dispositivo (típicamente escritorio).
  const isDesktop = window.matchMedia('(min-width: 768px)').matches;

  let qrSvg = '';
  if (isDesktop) {
    try {
      const qr = new QRCode({
        content: payment.url, padding: 2, width: 220, height: 220,
        color: '#1d1d1f', background: '#ffffff', ecl: 'M', join: true,
      });
      qrSvg = qr.svg();
    } catch (err) {
      console.error('[payment] QR generation failed', err);
    }
  }

  const amountFmt = formatCop(payment.amount_cop);

  container.innerHTML = `
    <div style="max-width:480px;margin:0 auto;">
      <div class="ak-stat-card" style="text-align:center;margin-bottom:20px;">
        <div class="ak-stat-label">Monto a pagar</div>
        <div class="ak-stat-value" style="color:var(--color-warning);font-size:36px;">
          ${amountFmt}
        </div>
        <div class="ak-stat-sub" id="expiry-line">
          Preparando…
        </div>
      </div>

      <div class="ak-card" style="text-align:center;padding:24px;">
        <a href="${escapeHtml(payment.url)}" target="_blank" rel="noopener"
           class="ak-btn-primary" id="pay-now-btn"
           style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:16px;font-size:17px;text-decoration:none;">
          <i class="ti ti-credit-card"></i> Pagar ahora
        </a>
        <div style="font-size:13px;color:var(--text2);margin-top:10px;">
          Se abrirá Wompi para pagar con Nequi, PSE o tarjeta. Al terminar, vuelve a esta pantalla.
        </div>

        ${isDesktop && qrSvg ? `
        <div class="pay-qr" style="margin-top:20px;border-top:1px solid var(--hairline,#e5e5e5);padding-top:16px;">
          <div style="font-size:13px;font-weight:500;color:var(--text1);margin-bottom:8px;">
            o escanea con tu celular
          </div>
          <div>${qrSvg}</div>
        </div>
        ` : ''}

        <div id="status-line" style="margin-top:16px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <span class="status-dot status-pending"></span>
          <span style="font-size:13px;color:var(--text2);">Esperando confirmación del pago…</span>
        </div>
      </div>

      <div style="margin-top:20px;text-align:center;">
        <button type="button" class="ak-btn-outline" id="cancel-btn" style="width:100%;padding:14px;">
          <i class="ti ti-x"></i> Cancelar y volver
        </button>
      </div>

      <div style="margin-top:16px;font-size:13px;color:var(--text2);text-align:center;">
        ¿Problemas con el pago? También puedes realizarlo en recepción.
      </div>
    </div>
  `;

  updateExpiryCountdown(container, payment.expires_at);
  container.querySelector('#cancel-btn').addEventListener('click', onCancel);
}

function handleStatusChange(result, container, navigate, returnTo, cleanup) {
  if (result.status === 'approved') {
    cleanup();
    showModal({
      icon: '✅',
      title: '¡Pago recibido!',
      body: `Tu pago de ${formatCop(result.amount_cop)} fue procesado exitosamente. Recibirás el comprobante por correo electrónico.`,
      actions: [{ label: 'Entendido', variant: 'primary', action: () => navigate('home') }],
      dismissible: false,
    });
    return;
  }

  const terminalMap = {
    declined: { title: 'Pago rechazado',  body: 'Tu banco rechazó la transacción. Verifica los datos e intenta de nuevo, o acude a recepción.' },
    voided:   { title: 'Pago anulado',    body: 'La transacción fue anulada antes de completarse.' },
    error:    { title: 'Error en el pago',body: 'Ocurrió un error procesando tu pago. Intenta de nuevo o acude a recepción.' },
    expired:  { title: 'Enlace expirado', body: 'El tiempo para completar el pago se agotó. Vuelve a iniciar el proceso desde tus tratamientos.' },
  };

  const info = terminalMap[result.status];
  if (info) {
    cleanup();
    showModal({
      icon: result.status === 'expired' ? '⏰' : '❌',
      title: info.title,
      body: info.body,
      actions: [{ label: 'Entendido', variant: 'primary', action: () => navigate(returnTo) }],
      dismissible: false,
    });
  }
}

function renderCreationError(container, err, onBack) {
  let title = 'No pudimos generar el pago';
  let body  = 'Intenta de nuevo en unos minutos.';

  if (err instanceof ApiError) {
    if (err.status === 400)            { title = 'Datos inválidos'; body = err.body?.message ?? body; }
    else if (err.status === 401)       { title = 'Sesión expirada'; body = 'Por favor inicia sesión de nuevo.'; }
    else if (err.status === 404)       { title = 'Tratamiento no encontrado'; body = 'No pudimos encontrar el tratamiento asociado.'; }
    else if (err.status === 503 || err.status === 504) {
      title = 'Servicio no disponible';
      body  = 'El sistema de pagos está temporalmente fuera de línea. Intenta más tarde.';
    }
  }

  container.innerHTML = `
    <div class="ak-card" style="text-align:center;padding:32px;">
      <i class="ti ti-alert-triangle" style="font-size:48px;color:var(--color-danger);margin-bottom:12px;"></i>
      <div style="font-weight:600;font-size:16px;margin-bottom:8px;">${escapeHtml(title)}</div>
      <div style="font-size:14px;color:var(--text2);margin-bottom:20px;">${escapeHtml(body)}</div>
      <button type="button" class="ak-btn-outline" id="err-back" style="width:100%;padding:14px;">
        <i class="ti ti-arrow-left"></i> Volver
      </button>
    </div>
  `;
  container.querySelector('#err-back').addEventListener('click', onBack);
}

function updateExpiryCountdown(container, expiresAt) {
  const el = container.querySelector('#expiry-line');
  if (!el || !expiresAt) return;
  const remaining = formatTimeUntil(expiresAt);
  el.textContent = `Expira en ${remaining}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTerminal(status) {
  return ['approved', 'declined', 'voided', 'expired', 'error'].includes(status);
}

function formatCop(amount) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', maximumFractionDigits: 0,
  }).format(amount ?? 0);
}

function formatTimeUntil(isoString) {
  if (!isoString) return '';
  const remaining = Math.max(0, new Date(isoString).getTime() - Date.now());
  const totalSec = Math.floor(remaining / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
