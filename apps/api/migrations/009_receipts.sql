-- =============================================================================
-- 009: Receipts y reconciliación
-- =============================================================================
-- Hito 8: añadimos campos para tracking de comprobantes enviados.
-- También un índice para encontrar pagos approved sin reconciliar (lo usa el
-- worker de reconciliación cada minuto).
-- =============================================================================

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS receipt_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receipt_channels TEXT;  -- "email,sms" o "email" o "sms"

-- Índice para el reconciliador: encontrar approved sin reconciliar rápidamente.
-- (Reemplaza al índice parcial pre-existente en migración 005, que no incluye
--  reconciliation_attempts.)
DROP INDEX IF EXISTS idx_transactions_pending_reconciliation;
CREATE INDEX IF NOT EXISTS idx_transactions_pending_reconciliation
  ON transactions (created_at)
  WHERE status = 'approved'
    AND registered_in_dentalink = false;

-- Índice para el poller defensivo: encontrar pendings sin webhook
CREATE INDEX IF NOT EXISTS idx_transactions_pending_no_webhook
  ON transactions (created_at)
  WHERE status = 'pending'
    AND webhook_received_at IS NULL;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('009', 'receipts')
ON CONFLICT (version) DO NOTHING;
