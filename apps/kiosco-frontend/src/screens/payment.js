/**
 * Pantalla payment — generar payment link + mostrar QR + polling de estado.
 *
 * Flujo:
 *   1. Al entrar, ejecuta POST /me/payments con los datos pasados como params.
 *   2. Genera un QR del payment.url y lo muestra en la pantalla.
 *   3. Hace polling cada 3s a GET /me/payments/:reference.
 *      - Mientras 'pending': mantiene la pantalla con el QR.
 *      - Si 'approved': muestra confirmación y vuelve a 'home' (o treatments).
 *      - Si 'declined'/'voided'/'expired'/'error': muestra error y opción de
 *        reintentar.
 *   4. Si el paciente toca "Cancelar", vuelve a la pantalla anterior.
 *
 * Por seguridad PCI: NO capturamos datos de tarjeta. El paciente paga
 * desde su celular escaneando el QR, así Wompi maneja todo el PCI compliance.
 */

import QRCode from 'qrcode-svg';
import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { showModal } from '../components/modal.js';
import { toast } from '../components/toast.js';

// Intervalo de polling en ms. Lo subimos a 5s después de 1 minuto para no
// abusar del backend si el paciente está demorando.
const POLL_INTERVAL_FAST_MS = 3000;
const POLL_INTERVAL_SLOW_MS = 5000;
const POLL_SLOW_AFTER_MS = 60_000;

export async function renderPayment(container, params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  const { treatmentId, amountCop, description, returnTo = 'treatments' } = params;

  if (!amountCop || !description) {
    navigate(returnTo);
    return null;
  }

  // ===== Cleanup state =====
  let pollTimer = null;
  let aborted = false;

  const cleanup = () => {
    aborted = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  // ===== UI: loading inicial =====
  container.innerHTML = `
    <div class="screen">
      <header class="screen-header">
        <h1>Pago</h1>
        <button type="button" class="btn btn-secondary" id="back-btn">
          ← Cancelar
        </button>
      </header>
      <div class="screen-body">
        <div id="payment-content">${spinner({ text: 'Preparando tu pago...' })}</div>
      </div>
    </div>
  `;

  const content = container.querySelector('#payment-content');
  container.querySelector('#back-btn').addEventListener('click', () => {
    cleanup();
    navigate(returnTo);
  });

  // ===== Crear el payment link =====
  let payment;
  try {
    payment = await api.createPayment({ treatmentId, amountCop, description });
  } catch (err) {
    if (aborted) return cleanup;
    renderCreationError(content, err, () => navigate(returnTo));
    return cleanup;
  }

  if (aborted) return cleanup;

  // ===== UI: QR + estado =====
  renderQrScreen(content, payment, () => navigate(returnTo));

  // ===== Polling =====
  const startedAt = Date.now();
  let lastStatus = 'pending';

  const poll = async () => {
    if (aborted) return;
    try {
      const result = await api.getPaymentStatus(payment.reference);

      if (aborted) return;

      // Si el estado cambió, actualizamos UI
      if (result.status !== lastStatus) {
        lastStatus = result.status;
        handleStatusChange(result, content, navigate, returnTo, cleanup);
        // En estado terminal, cleanup ya se llamó dentro de handleStatusChange
        if (isTerminal(result.status)) return;
      } else {
        // Actualizar tiempo restante visualmente
        updateExpiryCountdown(content, payment.expires_at);
      }

      // Programar siguiente poll
      const elapsed = Date.now() - startedAt;
      const interval = elapsed > POLL_SLOW_AFTER_MS ? POLL_INTERVAL_SLOW_MS : POLL_INTERVAL_FAST_MS;
      pollTimer = setTimeout(poll, interval);
    } catch (err) {
      if (aborted) return;
      // Errores de red en el polling no son fatales: reintentamos
      console.warn('[payment] polling error', err);
      pollTimer = setTimeout(poll, POLL_INTERVAL_SLOW_MS);
    }
  };

  // Primer poll después de 3s (dar tiempo al paciente a ver el QR)
  pollTimer = setTimeout(poll, POLL_INTERVAL_FAST_MS);

  return cleanup;
}

// =============================================================================
// Renderers
// =============================================================================

function renderQrScreen(container, payment, onCancel) {
  // Generar el QR del payment.url
  let qrSvg = '';
  try {
    const qr = new QRCode({
      content: payment.url,
      padding: 4, // zona silenciosa norma QR (con 2 muchas cámaras no leen en pantalla)
      width: 280,
      height: 280,
      color: '#0f172a',
      background: '#ffffff',
      ecl: 'M',
    });
    qrSvg = qr.svg();
  } catch (err) {
    console.error('[payment] QR generation failed', err);
  }

  const amountFmt = formatCop(payment.amount_cop);
  const expiresIn = formatTimeUntil(payment.expires_at);

  container.innerHTML = `
    <div class="payment-screen">
      <div class="payment-instructions">
        <h2>Escanea con tu celular para pagar</h2>
        <p class="subtitle">
          Abre la cámara de tu teléfono y apunta al código QR. Se abrirá la
          página de pago de Wompi donde podrás pagar con Nequi, PSE o tarjeta.
        </p>
      </div>

      <div class="payment-card">
        <div class="payment-qr" id="qr-holder">
          ${qrSvg || '<div class="alert alert-error">No se pudo generar el código QR.</div>'}
        </div>

        <div class="payment-details">
          <div class="payment-amount">${amountFmt}</div>
          <div class="payment-status" id="status-line">
            <span class="status-dot status-pending"></span>
            Esperando pago...
          </div>
          <div class="payment-expiry" id="expiry-line">
            Expira en <strong>${expiresIn}</strong>
          </div>
        </div>
      </div>

      <div class="payment-actions">
        <button type="button" class="btn btn-secondary btn-lg" id="cancel-btn">
          Cancelar y volver
        </button>
      </div>

      <div class="payment-help">
        <p>
          <strong>¿Problemas para escanear?</strong> Pídele al recepcionista que te envíe
          el enlace al celular, o realiza el pago directamente en recepción.
        </p>
      </div>
    </div>
  `;

  container.querySelector('#cancel-btn').addEventListener('click', () => onCancel());
}

function handleStatusChange(result, container, navigate, returnTo, cleanup) {
  if (result.status === 'approved') {
    cleanup();
    showModal({
      icon: '✅',
      title: '¡Pago recibido!',
      body: `Tu pago de ${formatCop(result.amount_cop)} fue procesado exitosamente. Recibirás el comprobante por correo electrónico. El saldo de tu tratamiento puede tardar hasta 4 horas en actualizarse, una vez la clínica confirme el pago.`,
      actions: [
        {
          label: 'Entendido',
          variant: 'primary',
          action: () => navigate('home'),
        },
      ],
      dismissible: false,
    });
    return;
  }

  if (result.status === 'declined' || result.status === 'voided' || result.status === 'error') {
    cleanup();
    const titles = {
      declined: 'Pago rechazado',
      voided: 'Pago anulado',
      error: 'Error en el pago',
    };
    const bodies = {
      declined:
        'Tu banco o el método de pago rechazó la transacción. Verifica los datos e intenta de nuevo, o acude a recepción.',
      voided: 'La transacción fue anulada antes de completarse.',
      error: 'Ocurrió un error procesando tu pago. Intenta de nuevo o acude a recepción.',
    };
    showModal({
      icon: '❌',
      title: titles[result.status],
      body: bodies[result.status],
      actions: [
        {
          label: 'Entendido',
          variant: 'primary',
          action: () => navigate(returnTo),
        },
      ],
      dismissible: false,
    });
    return;
  }

  if (result.status === 'expired') {
    cleanup();
    showModal({
      icon: '⏰',
      title: 'El enlace de pago expiró',
      body:
        'El tiempo para completar el pago se agotó. Vuelve a iniciar el proceso desde tus tratamientos.',
      actions: [
        {
          label: 'Entendido',
          variant: 'primary',
          action: () => navigate(returnTo),
        },
      ],
      dismissible: false,
    });
    return;
  }

  // 'pending' — no-op
}

function renderCreationError(container, err, onBack) {
  let title = 'No pudimos generar el pago';
  let body = 'Intenta de nuevo en unos minutos.';

  if (err instanceof ApiError) {
    if (err.status === 400) {
      title = 'Datos inválidos';
      body = err.body?.message ?? 'Verifica los datos del pago e intenta de nuevo.';
    } else if (err.status === 401) {
      title = 'Sesión expirada';
      body = 'Por favor inicia sesión de nuevo.';
    } else if (err.status === 503 || err.status === 504) {
      title = 'Servicio no disponible';
      body =
        'El sistema de pagos está temporalmente fuera de línea. Intenta más tarde o acude a recepción.';
    } else if (err.status === 404) {
      title = 'Tratamiento no encontrado';
      body = 'No pudimos encontrar el tratamiento asociado.';
    }
  }

  container.innerHTML = `
    <div class="alert alert-error">
      <strong>${escapeHtml(title)}</strong>
      <div style="margin-top: 0.5rem;">${escapeHtml(body)}</div>
    </div>
    <button type="button" class="btn btn-secondary btn-lg" id="err-back" style="margin-top: 1.5rem;">
      ← Volver
    </button>
  `;
  container.querySelector('#err-back').addEventListener('click', onBack);
}

function updateExpiryCountdown(container, expiresAt) {
  const el = container.querySelector('#expiry-line');
  if (!el || !expiresAt) return;
  const remaining = formatTimeUntil(expiresAt);
  el.innerHTML = `Expira en <strong>${remaining}</strong>`;
}

// =============================================================================
// Helpers
// =============================================================================

function isTerminal(status) {
  return ['approved', 'declined', 'voided', 'expired', 'error'].includes(status);
}

function formatCop(amount) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(amount ?? 0);
}

function formatTimeUntil(isoString) {
  if (!isoString) return '';
  const target = new Date(isoString).getTime();
  const remaining = Math.max(0, target - Date.now());
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
