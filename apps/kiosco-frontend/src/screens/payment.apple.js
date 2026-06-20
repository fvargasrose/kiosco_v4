import QRCode from 'qrcode-svg';
import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { spinner } from '../components/spinner.js';
import { showModal } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { renderAppleShell } from './shared/shell.apple.js';
import { openWompiWidget } from '../lib/wompi-widget.js';
import { isKioskMode } from '../lib/mode.js';
import { pauseIdleTimer, resumeIdleTimer } from '../idle.js';

const POLL_INTERVAL_FAST_MS = 3000;
const POLL_INTERVAL_SLOW_MS = 5000;
const POLL_SLOW_AFTER_MS    = 60_000;

export async function renderPaymentApple(container, params, navigate) {
  if (!state.patient) {
    navigate('standby');
    return null;
  }

  const { treatmentId, amountCop, description, returnTo = 'treatments', resumeReference } = params;

  // Modo resumen: el paciente vuelve de Wompi (/pago/retorno/<ref>). No creamos
  // un link nuevo; consultamos el estado de la transacción y mostramos el
  // resultado (aprobado/rechazado), con un polling corto por si el webhook tarda.
  if (resumeReference) {
    return renderResume(container, resumeReference, navigate, returnTo);
  }

  if (!amountCop || !description) {
    navigate(returnTo);
    return null;
  }

  // Modo kiosco (equipo compartido): QR + envío del enlace por correo, para que
  // el paciente pague en SU celular sin teclear datos en el kiosco. Modo web:
  // widget de Wompi en la misma página.
  const kiosk = isKioskMode();

  let pollTimer = null;
  let aborted   = false;
  let mainEl    = null;
  let onVisible = null;

  // En kiosco, el paciente paga en su celular y no toca la pantalla: pausamos el
  // idle agresivo (~90 s) mientras dura el pago (con tope de seguridad en idle.js).
  if (kiosk) pauseIdleTimer();

  const cleanup = () => {
    aborted = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (onVisible) {
      document.removeEventListener('visibilitychange', onVisible);
      onVisible = null;
    }
    if (kiosk) resumeIdleTimer();
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

  // Crear el pago según el modo. Kiosco → payment link (QR + correo). Web →
  // widget (firma de integridad calculada en el backend; pago en modal in situ).
  let payment;
  try {
    payment = kiosk
      ? await api.createKioskPayment({ treatmentId, amountCop, description })
      : await api.createWidgetPayment({ treatmentId, amountCop, description });
  } catch (err) {
    if (aborted) return cleanup;
    renderCreationError(content, err, () => { cleanup(); navigate(returnTo); });
    return cleanup;
  }

  if (aborted) return cleanup;

  // Polling del estado real (autoridad: webhook → BD). Idéntico para widget y
  // link: confirma aprobado/rechazado aunque el callback del widget no llegue.
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

  // Dispara una comprobación inmediata (p.ej. al cerrarse el modal del widget).
  const forcePoll = () => {
    if (aborted) return;
    if (pollTimer) clearTimeout(pollTimer);
    poll();
  };

  // Abre el widget de Wompi en un modal. Al cerrarse, confirmamos por polling.
  const onPay = async (btn) => {
    if (aborted) return;
    const prevHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader"></i> Abriendo pago seguro…';
    try {
      await openWompiWidget(payment);
    } catch (err) {
      console.error('[payment] widget error', err);
      toast('No pudimos abrir el pago seguro. Intenta de nuevo.', 'error');
    } finally {
      if (!aborted) {
        btn.disabled = false;
        btn.innerHTML = prevHtml;
      }
    }
    // Tras cerrar el widget, confirmar el estado real de inmediato.
    forcePoll();
  };

  if (kiosk) {
    renderKioskPayScreen(content, payment, () => { cleanup(); navigate(returnTo); });
  } else {
    renderPayScreen(content, payment, onPay, () => { cleanup(); navigate(returnTo); });
  }

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

function renderPayScreen(container, payment, onPay, onCancel) {
  // El botón abre el Widget de Wompi en un modal SOBRE esta página: el paciente
  // paga con Nequi/tarjeta sin salir del sistema (PSE puede redirigir al banco).
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
        <button type="button"
           class="ak-btn-primary" id="pay-now-btn"
           style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:16px;font-size:17px;border:none;cursor:pointer;">
          <i class="ti ti-credit-card"></i> Pagar ahora
        </button>
        <div style="font-size:13px;color:var(--text2);margin-top:10px;">
          El pago se abrirá aquí mismo, en una ventana segura de Wompi (Nequi,
          tarjeta o PSE). No saldrás del sistema.
        </div>

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
  const payBtn = container.querySelector('#pay-now-btn');
  payBtn.addEventListener('click', () => onPay(payBtn));
  container.querySelector('#cancel-btn').addEventListener('click', onCancel);
}

// Modo kiosco (equipo compartido): QR para pagar desde el celular del paciente +
// aviso de que el enlace temporal se envió a su correo. El paciente NO teclea
// datos en el kiosco; el kiosco refleja el resultado por polling.
function renderKioskPayScreen(container, payment, onCancel) {
  let qrSvg = '';
  try {
    const qr = new QRCode({
      content: payment.url, padding: 4, width: 260, height: 260,
      color: '#1d1d1f', background: '#ffffff', ecl: 'M',
    });
    qrSvg = qr.svg();
  } catch (err) {
    console.error('[payment] QR generation failed', err);
  }

  const amountFmt = formatCop(payment.amount_cop);
  const emailLine = payment.email_sent && payment.email_masked
    ? `También te enviamos el enlace a <strong>${escapeHtml(payment.email_masked)}</strong>.
       Es <strong>temporal</strong> y vence pronto.`
    : `Escanea el código con la cámara de tu celular. El enlace es <strong>temporal</strong> y vence pronto.`;

  container.innerHTML = `
    <div style="max-width:480px;margin:0 auto;">
      <div class="ak-stat-card" style="text-align:center;margin-bottom:20px;">
        <div class="ak-stat-label">Monto a pagar</div>
        <div class="ak-stat-value" style="color:var(--color-warning);font-size:36px;">
          ${amountFmt}
        </div>
        <div class="ak-stat-sub" id="expiry-line">Preparando…</div>
      </div>

      <div class="ak-card" style="text-align:center;padding:24px;">
        <div style="font-size:15px;font-weight:600;color:var(--text1);margin-bottom:12px;">
          Paga desde tu celular
        </div>
        <div style="display:flex;justify-content:center;">${qrSvg || '<div class="ak-alert">No se pudo generar el QR.</div>'}</div>
        <div style="font-size:13px;color:var(--text2);margin-top:12px;">
          ${emailLine}
        </div>
        <div style="font-size:12px;color:var(--text2);margin-top:6px;">
          No escribas datos de pago en este equipo: usa tu teléfono.
        </div>

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
      body: `Tu pago de ${formatCop(result.amount_cop)} fue procesado exitosamente. Recibirás el comprobante por correo electrónico. El saldo de tu tratamiento puede tardar hasta 4 horas en actualizarse, una vez la clínica confirme el pago.`,
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

// Modo resumen tras volver de Wompi: consulta el estado de la transacción por
// su reference y muestra el resultado. Si sigue 'pending' (el webhook puede
// tardar unos segundos), hace polling corto antes de mostrar un aviso.
async function renderResume(container, reference, navigate, returnTo) {
  let pollTimer = null;
  let aborted = false;
  const cleanup = () => {
    aborted = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  };

  renderAppleShell(container, 'treatments', navigate, (main) => {
    main.innerHTML = `
      <div class="ak-page-header" style="margin-bottom:20px;">
        <div>
          <div class="ak-page-title">Confirmando tu pago</div>
          <div class="ak-page-subtitle">Un momento por favor…</div>
        </div>
      </div>
      <div id="payment-content">${spinner({ text: 'Verificando el estado de tu pago...' })}</div>
    `;
  });

  const content = container.querySelector('#payment-content');
  if (!content) return cleanup;

  const startedAt = Date.now();
  const MAX_WAIT_MS = 45_000;

  const poll = async () => {
    if (aborted) return;
    try {
      const result = await api.getPaymentStatus(reference);
      if (aborted) return;

      if (isTerminal(result.status)) {
        handleStatusChange(result, content, navigate, returnTo, cleanup);
        return;
      }

      // Aún 'pending': el webhook puede tardar. Reintentamos un rato.
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        cleanup();
        renderPendingNotice(content, navigate, returnTo);
        return;
      }
      pollTimer = setTimeout(poll, POLL_INTERVAL_FAST_MS);
    } catch (err) {
      if (aborted) return;
      // 404/401: la reference no es de este paciente o la sesión cayó.
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
        cleanup();
        renderPendingNotice(content, navigate, returnTo);
        return;
      }
      pollTimer = setTimeout(poll, POLL_INTERVAL_SLOW_MS);
    }
  };

  poll();
  return cleanup;
}

function renderPendingNotice(container, navigate, returnTo) {
  container.innerHTML = `
    <div class="ak-card" style="text-align:center;padding:32px;">
      <i class="ti ti-clock" style="font-size:48px;color:var(--color-warning);margin-bottom:12px;"></i>
      <div style="font-weight:600;font-size:16px;margin-bottom:8px;">Tu pago se está procesando</div>
      <div style="font-size:14px;color:var(--text2);margin-bottom:20px;">
        Estamos confirmando tu pago con el banco. Recibirás el comprobante por correo
        cuando se confirme. El saldo de tu tratamiento puede tardar en actualizarse.
      </div>
      <button type="button" class="ak-btn-primary" id="resume-home" style="width:100%;padding:14px;">
        Entendido
      </button>
    </div>
  `;
  container.querySelector('#resume-home').addEventListener('click', () => navigate('home'));
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
