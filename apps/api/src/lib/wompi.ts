/**
 * =============================================================================
 * Wompi client
 * =============================================================================
 *
 * API: https://docs.wompi.co/
 *
 * En el Hito 7 usamos SOLO Payment Links (no tokenización ni 3DS desde el
 * kiosco). El paciente recibe un link/QR y paga en su celular.
 *
 * Flujo:
 *   1. POST /payment_links → crea link con amount, reference, expiration
 *   2. Frontend genera QR del checkout URL y muestra al paciente
 *   3. Paciente paga en su celular (Wompi maneja todo el PCI compliance)
 *   4. Wompi envía webhook a /webhooks/wompi cuando hay cambio de estado
 *   5. Verificamos firma HMAC SHA256 con WOMPI_EVENTS_SECRET
 *   6. Actualizamos transactions y disparamos reconciliación con Dentalink
 *
 * Estados Wompi: PENDING → APPROVED | DECLINED | VOIDED | ERROR
 */

import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

const REQUEST_TIMEOUT_MS = 10_000;
const PAYMENT_LINK_TTL_MINUTES = 30; // El link expira en 30 minutos

// ----- Tipos -----

export type WompiStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';

export interface WompiPaymentLinkInput {
  amountCop: number;
  reference: string;
  description: string;
  customerEmail?: string;
  expiresInMinutes?: number;
}

export interface WompiPaymentLink {
  id: string;
  url: string; // URL que el paciente debe abrir (la pondremos en QR)
  reference: string;
  amountInCents: number;
  status: WompiStatus;
  expiresAt: Date;
}

export interface WompiTransactionDetails {
  id: string;
  status: WompiStatus;
  reference: string;
  amountInCents: number;
  paymentMethodType: string; // 'NEQUI' | 'PSE' | 'CARD' | etc.
  paymentMethodExtra: Record<string, unknown>;
  customerEmail?: string;
  createdAt: string;
  finalizedAt?: string;
}

export interface WompiWebhookEvent {
  event: string;
  data: {
    transaction: {
      id: string;
      status: WompiStatus;
      reference: string;
      amount_in_cents: number;
      payment_method_type: string;
      payment_method?: Record<string, unknown>;
      customer_email?: string;
      // Wompi lo incluye en transacciones originadas por un payment link. Lo
      // usamos para casar el webhook con nuestra fila (su `reference` es propia).
      payment_link_id?: string;
      created_at: string;
      finalized_at?: string;
    };
  };
  sent_at: string;
  timestamp: number;
  signature: { checksum: string; properties: string[] };
  environment: string;
}

// ----- Errores -----

export type WompiErrorCode =
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'INVALID_SIGNATURE'
  | 'STALE_EVENT';

export class WompiError extends Error {
  constructor(
    message: string,
    public readonly code: WompiErrorCode,
    public readonly status?: number,
    public readonly upstreamBody?: unknown,
  ) {
    super(message);
    this.name = 'WompiError';
  }
}

// ----- Helpers -----

function isMockMode(): boolean {
  return config.DEV_MOCK_WOMPI || !config.WOMPI_PRIVATE_KEY;
}

function requirePrivateKey(): string {
  if (!config.WOMPI_PRIVATE_KEY) {
    throw new WompiError('WOMPI_PRIVATE_KEY no configurado', 'UPSTREAM_ERROR');
  }
  return config.WOMPI_PRIVATE_KEY;
}

function requireEventsSecret(): string {
  if (!config.WOMPI_EVENTS_SECRET) {
    throw new WompiError('WOMPI_EVENTS_SECRET no configurado', 'UPSTREAM_ERROR');
  }
  return config.WOMPI_EVENTS_SECRET;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function wompiRequest<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; useAuthHeader?: boolean } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const url = `${config.WOMPI_API_URL}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (opts.useAuthHeader !== false) {
    headers.Authorization = `Bearer ${requirePrivateKey()}`;
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401) {
      throw new WompiError('Credenciales Wompi inválidas', 'UNAUTHORIZED', 401);
    }
    if (res.status === 404) {
      throw new WompiError('Recurso no encontrado en Wompi', 'NOT_FOUND', 404);
    }
    if (res.status === 400 || res.status === 422) {
      const body = await safeJson(res);
      throw new WompiError('Petición inválida hacia Wompi', 'BAD_REQUEST', res.status, body);
    }
    if (!res.ok) {
      const body = await safeJson(res);
      throw new WompiError(`Wompi respondió ${res.status}`, 'UPSTREAM_ERROR', res.status, body);
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof WompiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new WompiError('Timeout en Wompi', 'TIMEOUT');
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new WompiError('Timeout en Wompi', 'TIMEOUT');
    }
    logger.error({ err, path, method }, 'Wompi request failed');
    throw new WompiError('Error de red con Wompi', 'UPSTREAM_ERROR');
  }
}

// ----- Cliente -----

class WompiClient {
  /**
   * Genera una referencia única para una transacción.
   * Formato: DK-{timestamp}-{random6} — fácil de identificar en Wompi dashboard.
   */
  generateReference(): string {
    const ts = Date.now().toString(36);
    const rand = randomBytes(4).toString('hex').slice(0, 6);
    return `DK-${ts}-${rand}`;
  }

  /**
   * Crea un payment link en Wompi.
   *
   * En mock mode retorna un link falso pero con shape idéntico al real.
   * Útil para tests automatizados sin Wompi real.
   */
  async createPaymentLink(input: WompiPaymentLinkInput): Promise<WompiPaymentLink> {
    const expiresInMinutes = input.expiresInMinutes ?? PAYMENT_LINK_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    const amountInCents = Math.round(input.amountCop * 100);

    if (isMockMode()) {
      const mockId = randomBytes(8).toString('hex');
      logger.info(
        { reference: input.reference, amountCop: input.amountCop, mockId },
        '[MOCK] Wompi payment link creado',
      );
      return {
        id: `mock-link-${mockId}`,
        url: `https://checkout.wompi.co/l/mock-${mockId}`,
        reference: input.reference,
        amountInCents,
        status: 'PENDING',
        expiresAt,
      };
    }

    // API real: POST /payment_links
    // Doc: https://docs.wompi.co/docs/colombia/link-de-pagos/
    const body = {
      name: input.description.slice(0, 50),
      description: input.description,
      single_use: true,
      collect_shipping: false,
      currency: 'COP',
      amount_in_cents: amountInCents,
      expires_at: expiresAt.toISOString(),
      // Wompi usará la reference cuando se complete la transacción
      // (se devuelve en el webhook como transaction.reference)
      // Para que llegue intacta, la pasamos en el field 'sku'
      sku: input.reference,
      customer_data: input.customerEmail
        ? { email: input.customerEmail }
        : undefined,
    };

    const res = await wompiRequest<{
      data: {
        id: string;
        // 'url_full' (campo nuevo) o 'url' según versión; lo manejamos como string
        single_use: boolean;
      };
    }>('/payment_links', { method: 'POST', body });

    return {
      id: res.data.id,
      url: `https://checkout.wompi.co/l/${res.data.id}`,
      reference: input.reference,
      amountInCents,
      status: 'PENDING',
      expiresAt,
    };
  }

  /**
   * Consulta el estado de una transacción en Wompi por id.
   * Lo usa el job de reconciliación si un webhook nunca llegó.
   */
  async getTransaction(transactionId: string): Promise<WompiTransactionDetails> {
    if (isMockMode()) {
      logger.info({ transactionId }, '[MOCK] getTransaction');
      return {
        id: transactionId,
        status: 'PENDING',
        reference: 'mock-ref',
        amountInCents: 0,
        paymentMethodType: 'NEQUI',
        paymentMethodExtra: {},
        createdAt: new Date().toISOString(),
      };
    }

    const res = await wompiRequest<{
      data: {
        id: string;
        status: WompiStatus;
        reference: string;
        amount_in_cents: number;
        payment_method_type: string;
        payment_method?: Record<string, unknown>;
        customer_email?: string;
        created_at: string;
        finalized_at?: string;
      };
    }>(`/transactions/${encodeURIComponent(transactionId)}`);

    return {
      id: res.data.id,
      status: res.data.status,
      reference: res.data.reference,
      amountInCents: res.data.amount_in_cents,
      paymentMethodType: res.data.payment_method_type,
      paymentMethodExtra: res.data.payment_method ?? {},
      customerEmail: res.data.customer_email,
      createdAt: res.data.created_at,
      finalizedAt: res.data.finalized_at,
    };
  }

  /**
   * Verifica la firma HMAC SHA256 de un webhook de Wompi.
   *
   * Wompi firma así: sha256_hex(concat(values_of_properties) + timestamp + secret)
   * Doc: https://docs.wompi.co/docs/colombia/eventos/
   *
   * @param rawBody El body JSON parseado del webhook
   * @returns true si la firma coincide
   * @throws WompiError si está mal formada
   */
  verifyWebhookSignature(rawBody: WompiWebhookEvent): boolean {
    if (!rawBody.signature?.checksum || !Array.isArray(rawBody.signature?.properties)) {
      throw new WompiError('Webhook sin firma válida', 'INVALID_SIGNATURE');
    }
    if (typeof rawBody.timestamp !== 'number') {
      throw new WompiError('Webhook sin timestamp', 'INVALID_SIGNATURE');
    }

    // Anti-replay: rechazar eventos de hace más de 5 minutos
    const fiveMinutesMs = 5 * 60 * 1000;
    const eventMs = rawBody.timestamp * 1000;
    if (Math.abs(Date.now() - eventMs) > fiveMinutesMs) {
      throw new WompiError('Webhook con timestamp expirado (>5min)', 'STALE_EVENT');
    }

    // Concatenar valores en orden, según las properties listadas
    let concatenated = '';
    for (const prop of rawBody.signature.properties) {
      // 'transaction.id' → navegar data.transaction.id
      const value = resolvePath(rawBody.data, prop);
      if (value === undefined || value === null) {
        throw new WompiError(`Webhook con property '${prop}' faltante`, 'INVALID_SIGNATURE');
      }
      concatenated += String(value);
    }
    concatenated += rawBody.timestamp;
    concatenated += requireEventsSecret();

    // Wompi firma con SHA256 plano sobre la concatenación: valores + timestamp + secret
    const computed = createHash('sha256').update(concatenated).digest('hex');

    return timingSafeEqual(computed, rawBody.signature.checksum);
  }
}

function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Comparación de strings en tiempo constante (anti-timing attack).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export const wompi = new WompiClient();
