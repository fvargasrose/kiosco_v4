/**
 * =============================================================================
 * Reconciliador de pagos
 * =============================================================================
 *
 * Worker en proceso que:
 *
 *   1. Cada N segundos, busca transactions en estado 'approved' que NO estén
 *      todavía registradas en Dentalink (`registered_in_dentalink = false`).
 *   2. Para cada una, intenta llamar `dentalink.registerPaymentInDentalink()`.
 *   3. Si éxito: marca `registered_in_dentalink = true`, guarda `dentalink_payment_id`.
 *   4. Si falla: incrementa `reconciliation_attempts`, guarda `last_reconciliation_error`.
 *
 * Política de backoff:
 *   - 1er reintento: inmediato (lo dispara el webhook)
 *   - 2do en adelante: exponencial con jitter, hasta MAX_ATTEMPTS
 *   - Después de MAX_ATTEMPTS, abandonamos y queda para reconciliación manual
 *     (un admin podrá ver estas en el dashboard del Hito 9 y reconciliarlas a mano).
 *
 * También hace polling defensivo de transactions 'pending' que no hayan recibido
 * webhook en cierto tiempo, llamando a Wompi.getTransaction. Esto cubre el caso
 * de webhooks perdidos.
 */

import { db } from './db.js';
import { logger } from './logger.js';
import { audit } from './audit.js';
import { dentalink, DentalinkError } from './dentalink.js';
import { decrypt } from './crypto.js';
import { wompi, WompiError } from './wompi.js';

const DEFAULT_INTERVAL_MS = 60_000; // cada minuto
const MAX_RECONCILIATION_ATTEMPTS = 10;
const MIN_AGE_FOR_WOMPI_POLL_SECS = 120; // pollear Wompi si pasaron >2min sin webhook
const MAX_AGE_FOR_PENDING_HOURS = 24; // después de 24h, marcar pending como expired
const BATCH_SIZE = 20;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

// =============================================================================
// API pública
// =============================================================================

/**
 * Arranca el worker. Idempotente: si ya está corriendo, no hace nada.
 */
export function startReconciler(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (intervalHandle) {
    logger.info('Reconciler already running');
    return;
  }
  logger.info({ intervalMs }, 'Reconciler started');
  intervalHandle = setInterval(() => {
    if (running) return; // evitar overlap
    runCycle().catch((err) => {
      logger.error({ err }, 'Reconciler cycle threw');
    });
  }, intervalMs);
}

export function stopReconciler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Reconciler stopped');
  }
}

/**
 * Ejecuta un ciclo manualmente.
 * Útil para tests y para el endpoint admin que dispare el job on-demand.
 */
export async function runCycle(): Promise<{
  reconciled: number;
  polled: number;
  expired: number;
  errors: number;
}> {
  if (running) {
    return { reconciled: 0, polled: 0, expired: 0, errors: 0 };
  }
  running = true;
  const stats = { reconciled: 0, polled: 0, expired: 0, errors: 0 };

  try {
    stats.reconciled = await reconcileApproved();
    stats.polled = await pollStalePending();
    stats.expired = await expireOldPending();
  } catch (err) {
    logger.error({ err }, 'Reconciler cycle error');
    stats.errors++;
  } finally {
    running = false;
  }
  return stats;
}

// =============================================================================
// Operaciones del ciclo
// =============================================================================

/**
 * Busca transactions approved sin reconciliar y las intenta registrar en Dentalink.
 */
async function reconcileApproved(): Promise<number> {
  const rows = await db.query<{
    id: string;
    dentalink_patient_id: string;
    dentalink_treatment_id: string | null;
    amount_cop: string;
    wompi_reference: string;
    wompi_payment_method_type: string | null;
    reconciliation_attempts: number;
  }>(
    `SELECT id, dentalink_patient_id, dentalink_treatment_id, amount_cop,
            wompi_reference, wompi_payment_method_type, reconciliation_attempts
     FROM transactions
     WHERE status = 'approved'
       AND registered_in_dentalink = false
       AND reconciliation_attempts < $1
       AND (last_reconciliation_at IS NULL
            OR last_reconciliation_at < now() - (interval '1 minute' * power(2, reconciliation_attempts)))
     ORDER BY created_at ASC
     LIMIT $2`,
    [MAX_RECONCILIATION_ATTEMPTS, BATCH_SIZE],
  );

  let count = 0;
  for (const tx of rows.rows) {
    const ok = await reconcileOne(tx);
    if (ok) count++;
  }
  return count;
}

async function reconcileOne(tx: {
  id: string;
  dentalink_patient_id: string;
  dentalink_treatment_id: string | null;
  amount_cop: string;
  wompi_reference: string;
  wompi_payment_method_type: string | null;
  reconciliation_attempts: number;
}): Promise<boolean> {
  // Incrementar contador antes del intento
  await db.query(
    `UPDATE transactions
     SET reconciliation_attempts = reconciliation_attempts + 1,
         last_reconciliation_at = now()
     WHERE id = $1`,
    [tx.id],
  );

  try {
    const token = await getDentalinkToken();
    const { paymentId } = await dentalink.registerPaymentInDentalink({
      patientId: tx.dentalink_patient_id,
      treatmentId: tx.dentalink_treatment_id,
      amountCop: Number(tx.amount_cop),
      reference: tx.wompi_reference,
      method: tx.wompi_payment_method_type ?? 'OTHER',
      dentalinkToken: token,
    });

    await db.query(
      `UPDATE transactions
       SET registered_in_dentalink = true,
           dentalink_payment_id = $1,
           last_reconciliation_error = NULL
       WHERE id = $2`,
      [paymentId, tx.id],
    );

    await audit({
      actorType: 'system',
      actorId: null,
      action: 'payment.reconciled',
      resourceType: 'transaction',
      resourceId: tx.wompi_reference,
      metadata: {
        dentalink_payment_id: paymentId,
        attempt: tx.reconciliation_attempts + 1,
      },
      result: 'success',
    });

    logger.info(
      { reference: tx.wompi_reference, paymentId, attempt: tx.reconciliation_attempts + 1 },
      'Payment reconciled',
    );
    return true;
  } catch (err) {
    const isFinalAttempt = tx.reconciliation_attempts + 1 >= MAX_RECONCILIATION_ATTEMPTS;
    const errMsg = err instanceof Error ? err.message : String(err);

    await db.query(
      `UPDATE transactions
       SET last_reconciliation_error = $1
       WHERE id = $2`,
      [errMsg.slice(0, 500), tx.id],
    );

    if (isFinalAttempt) {
      logger.error(
        { reference: tx.wompi_reference, err, attempts: tx.reconciliation_attempts + 1 },
        'Payment reconciliation exhausted attempts — manual reconciliation required',
      );
      await audit({
        actorType: 'system',
        actorId: null,
        action: 'payment.reconciliation_exhausted',
        resourceType: 'transaction',
        resourceId: tx.wompi_reference,
        metadata: {
          error: errMsg.slice(0, 200),
          attempts: tx.reconciliation_attempts + 1,
        },
        result: 'failure',
      });
    } else {
      logger.warn(
        {
          reference: tx.wompi_reference,
          err: err instanceof DentalinkError ? err.code : errMsg.slice(0, 100),
          attempt: tx.reconciliation_attempts + 1,
        },
        'Payment reconciliation failed (will retry)',
      );
    }
    return false;
  }
}

/**
 * Para transactions 'pending' sin webhook reciente, pollea Wompi directamente.
 * Cubre el caso de webhooks perdidos.
 */
async function pollStalePending(): Promise<number> {
  const rows = await db.query<{
    id: string;
    wompi_reference: string;
    wompi_payment_link_id: string | null;
    wompi_transaction_id: string | null;
  }>(
    `SELECT id, wompi_reference, wompi_payment_link_id, wompi_transaction_id
     FROM transactions
     WHERE status = 'pending'
       AND created_at < now() - interval '${MIN_AGE_FOR_WOMPI_POLL_SECS} seconds'
       AND created_at > now() - interval '${MAX_AGE_FOR_PENDING_HOURS} hours'
       AND webhook_received_at IS NULL
     ORDER BY created_at ASC
     LIMIT $1`,
    [BATCH_SIZE],
  );

  let count = 0;
  for (const tx of rows.rows) {
    try {
      // Si tenemos el wompi_transaction_id desde un payment link, lo usamos.
      // Si solo tenemos el payment_link_id, no podemos consultar directamente
      // — Wompi requiere transaction_id. Skip por ahora; el siguiente webhook
      // o reintento del paciente lo resolverá.
      if (!tx.wompi_transaction_id) continue;

      const details = await wompi.getTransaction(tx.wompi_transaction_id);
      if (details.status === 'PENDING') continue; // sigue pending, nada que hacer

      // Status cambió en Wompi pero el webhook no llegó. Sincronizamos.
      const newStatus = details.status.toLowerCase();
      await db.query(
        `UPDATE transactions
         SET status = $1,
             status_message = $2,
             wompi_payment_method_type = $3,
             wompi_payment_method_extra = $4::jsonb,
             webhook_received_at = COALESCE(webhook_received_at, now()),
             webhook_verified = false
         WHERE id = $5`,
        [
          newStatus,
          details.status,
          details.paymentMethodType,
          JSON.stringify(details.paymentMethodExtra),
          tx.id,
        ],
      );

      await audit({
        actorType: 'system',
        actorId: null,
        action: 'payment.polled_from_wompi',
        resourceType: 'transaction',
        resourceId: tx.wompi_reference,
        metadata: {
          new_status: newStatus,
          source: 'reconciler_poll',
        },
        result: 'success',
      });

      logger.info(
        { reference: tx.wompi_reference, status: newStatus },
        'Stale pending payment synced from Wompi poll',
      );
      count++;
    } catch (err) {
      if (err instanceof WompiError && err.code === 'NOT_FOUND') {
        logger.warn({ reference: tx.wompi_reference }, 'Wompi transaction not found in poll');
        continue;
      }
      logger.warn({ err, reference: tx.wompi_reference }, 'Stale poll failed');
    }
  }
  return count;
}

/**
 * Marca como 'expired' transactions pending de más de 24h.
 * Esto NO es un estado terminal de Wompi: refleja nuestra política de timeout
 * para evitar tener pending en limbo indefinidamente.
 */
async function expireOldPending(): Promise<number> {
  const result = await db.query<{ id: string; wompi_reference: string }>(
    `UPDATE transactions
     SET status = 'expired'
     WHERE status = 'pending'
       AND created_at < now() - interval '${MAX_AGE_FOR_PENDING_HOURS} hours'
     RETURNING id, wompi_reference`,
  );

  for (const row of result.rows) {
    await audit({
      actorType: 'system',
      actorId: null,
      action: 'payment.expired',
      resourceType: 'transaction',
      resourceId: row.wompi_reference,
      metadata: { reason: `pending > ${MAX_AGE_FOR_PENDING_HOURS}h` },
      result: 'success',
    });
  }
  if (result.rows.length > 0) {
    logger.info({ count: result.rows.length }, 'Expired old pending payments');
  }
  return result.rows.length;
}

// =============================================================================
// Helpers
// =============================================================================

let cachedToken: { value: string | null; expiresAt: number } = {
  value: null,
  expiresAt: 0,
};

async function getDentalinkToken(): Promise<string | null> {
  if (cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }
  const result = await db.query<{ dentalink_token_encrypted: Buffer | null }>(
    `SELECT dentalink_token_encrypted FROM clinic WHERE id = 1`,
  );
  const token = await decrypt(result.rows[0]?.dentalink_token_encrypted ?? null);
  cachedToken = { value: token, expiresAt: Date.now() + 30_000 };
  return token;
}
