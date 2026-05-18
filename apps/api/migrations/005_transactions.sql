-- =============================================================================
-- Migration 005: Transactions (pagos)
-- =============================================================================

CREATE TABLE transactions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kiosk_id                    UUID REFERENCES kiosks(id) ON DELETE SET NULL,
  patient_session_id          UUID REFERENCES patient_sessions(id) ON DELETE SET NULL,

  -- Datos del paciente (denormalizados para auditoría)
  dentalink_patient_id        TEXT NOT NULL,
  dentalink_treatment_id      TEXT,                              -- NULL = pago general
  patient_phone_masked        TEXT,
  patient_email_masked        TEXT,

  -- Wompi - referencias y datos
  wompi_reference             TEXT UNIQUE NOT NULL,              -- nuestra ref única
  wompi_transaction_id        TEXT,                              -- de Wompi
  wompi_payment_link_id       TEXT,
  wompi_payment_method_type   TEXT,                              -- 'NEQUI'|'PSE'|'CARD'
  wompi_payment_method_extra  JSONB,                             -- bank, last_four, etc

  -- Importes
  amount_cop                  NUMERIC(12,0) NOT NULL CHECK (amount_cop > 0),
  currency                    TEXT NOT NULL DEFAULT 'COP'
    CHECK (currency = 'COP'),

  -- Estado y máquina de estados
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'voided', 'error', 'expired')),
  status_message              TEXT,
  status_changed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Reconciliación con Dentalink (si la clínica lo habilita)
  registered_in_dentalink     BOOLEAN NOT NULL DEFAULT false,
  dentalink_payment_id        TEXT,
  reconciliation_attempts     INTEGER NOT NULL DEFAULT 0,
  last_reconciliation_at      TIMESTAMPTZ,
  last_reconciliation_error   TEXT,

  -- Auditoría completa (para investigación de incidentes)
  raw_creation_response       JSONB,                             -- response de Wompi al crear
  raw_webhook_payload         JSONB,                             -- payload completo del webhook
  webhook_received_at         TIMESTAMPTZ,
  webhook_verified            BOOLEAN,

  -- Timestamps
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at                 TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ                        -- expiración del link Wompi
);

-- Indices para queries frecuentes
CREATE INDEX idx_tx_status_created
  ON transactions(status, created_at DESC);

CREATE INDEX idx_tx_reference
  ON transactions(wompi_reference);

CREATE INDEX idx_tx_patient
  ON transactions(dentalink_patient_id, created_at DESC);

-- Para el reconciler: pagos aprobados pendientes de registrar
CREATE INDEX idx_tx_reconcile
  ON transactions(approved_at)
  WHERE status = 'approved' AND registered_in_dentalink = false;

-- Updated_at automático
CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ----------------------------------------------------------------------------
-- Trigger: validar transiciones de estado (state machine)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validate_tx_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Si no cambia el status, ok
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Definir transiciones válidas
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'declined', 'voided', 'error', 'expired') THEN
    NEW.status_changed_at := now();
    IF NEW.status = 'approved' AND NEW.approved_at IS NULL THEN
      NEW.approved_at := now();
    END IF;
    RETURN NEW;
  END IF;

  -- Estados terminales no pueden cambiar
  IF OLD.status IN ('approved', 'declined', 'voided', 'expired') THEN
    RAISE EXCEPTION 'No se permite cambiar transacción de estado terminal % a %',
      OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Error puede ir a cualquier estado terminal (recovery)
  IF OLD.status = 'error' AND NEW.status IN ('approved', 'declined', 'voided', 'expired') THEN
    NEW.status_changed_at := now();
    IF NEW.status = 'approved' AND NEW.approved_at IS NULL THEN
      NEW.approved_at := now();
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Transición de estado inválida: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tx_status_transition
  BEFORE UPDATE OF status ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION fn_validate_tx_status_transition();

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('005', 'transactions')
ON CONFLICT (version) DO NOTHING;
