/**
 * Loader del Widget de Wompi (Web Checkout en un modal sobre la propia página).
 *
 * Carga `https://checkout.wompi.co/widget.js` una sola vez y expone una función
 * para abrir el checkout. A diferencia del payment link (que redirige a otra
 * web), el widget abre un iframe de Wompi en un modal: el paciente NO sale del
 * sistema. Al terminar, el callback nos entrega la transacción.
 *
 * Requisito de CSP (producción, Caddyfile.prod): script-src/frame-src/connect-src
 * deben permitir https://checkout.wompi.co (y https://production.wompi.co).
 */

const WIDGET_SRC = 'https://checkout.wompi.co/widget.js';
let loadPromise = null;

/**
 * Carga widget.js una sola vez. Resuelve con la clase global WidgetCheckout.
 * Rechaza si el script no carga (red/CSP) o tarda más de 12s.
 */
export function loadWompiWidget() {
  if (window.WidgetCheckout) return Promise.resolve(window.WidgetCheckout);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${WIDGET_SRC}"]`);
    const script = existing || document.createElement('script');
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      loadPromise = null;
      reject(new Error('Timeout cargando el widget de Wompi'));
    }, 12_000);

    const onLoad = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (window.WidgetCheckout) {
        resolve(window.WidgetCheckout);
      } else {
        loadPromise = null;
        reject(new Error('widget.js cargó pero WidgetCheckout no está disponible'));
      }
    };

    const onError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      loadPromise = null;
      reject(new Error('No se pudo cargar el widget de Wompi (red o CSP)'));
    };

    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);

    if (!existing) {
      script.src = WIDGET_SRC;
      script.async = true;
      document.head.appendChild(script);
    } else if (window.WidgetCheckout) {
      // Ya estaba cargado en una visita previa a la pantalla.
      onLoad();
    }
  });

  return loadPromise;
}

/**
 * Abre el Widget de Wompi y resuelve con la transacción cuando el paciente
 * cierra el modal (pagó, canceló o falló). El resultado puede venir todavía en
 * estado PENDING: el llamador debe confirmar el estado real por polling.
 *
 * @param {object} checkout  { reference, public_key, currency, amount_in_cents, signature, redirect_url? }
 * @returns {Promise<object|null>} la transacción de Wompi, o null si se cerró sin datos
 */
export async function openWompiWidget(checkout) {
  const WidgetCheckout = await loadWompiWidget();

  const opts = {
    currency: checkout.currency || 'COP',
    amountInCents: checkout.amount_in_cents,
    reference: checkout.reference,
    publicKey: checkout.public_key,
    signature: { integrity: checkout.signature },
  };
  if (checkout.redirect_url) opts.redirectUrl = checkout.redirect_url;

  const widget = new WidgetCheckout(opts);

  return new Promise((resolve) => {
    widget.open((result) => {
      resolve(result?.transaction ?? null);
    });
  });
}
