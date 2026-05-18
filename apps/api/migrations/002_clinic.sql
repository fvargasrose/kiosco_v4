-- =============================================================================
-- Migration 002: Tabla clinic (singleton)
-- =============================================================================
-- En el modelo self-hosted, cada instalación tiene UNA sola clínica.
-- El CHECK (id = 1) garantiza esto a nivel de BD.
-- =============================================================================

CREATE TABLE clinic (
  id                            INTEGER PRIMARY KEY CHECK (id = 1),

  -- Identificación legal
  legal_name                    TEXT NOT NULL,
  display_name                  TEXT NOT NULL,
  nit                           TEXT NOT NULL,
  address                       TEXT,
  city                          TEXT,
  phone                         TEXT,
  email                         CITEXT,
  logo_path                     TEXT,

  -- Habeas Data
  habeas_data_responsible       TEXT,
  habeas_data_email             CITEXT,
  habeas_data_policy_text       TEXT,
  habeas_data_policy_version    TEXT NOT NULL DEFAULT 'v1.0',
  habeas_data_policy_hash       TEXT,

  -- License (administrado por el license server)
  license_key                   TEXT NOT NULL,
  license_validated_at          TIMESTAMPTZ,
  license_expires_at            TIMESTAMPTZ,

  -- Credenciales de servicios externos (cifradas con pgp_sym_encrypt)
  dentalink_token_encrypted     BYTEA,
  wompi_public_key              TEXT,
  wompi_private_key_encrypted   BYTEA,
  wompi_events_secret_encrypted BYTEA,
  wompi_integrity_secret_encrypted BYTEA,
  twilio_account_sid            TEXT,
  twilio_auth_token_encrypted   BYTEA,
  twilio_from_number            TEXT,
  resend_api_key_encrypted      BYTEA,
  resend_from_email             CITEXT,
  resend_reply_to_email         CITEXT,

  -- Configuración operativa
  sucursal_id                   INTEGER NOT NULL DEFAULT 1,
  sillon_id                     INTEGER NOT NULL DEFAULT 1,
  duracion_cita_minutos         INTEGER NOT NULL DEFAULT 30,
  auto_register_payment_in_dentalink BOOLEAN NOT NULL DEFAULT false,

  -- Contenido dinámico del kiosco
  procedures                    JSONB NOT NULL DEFAULT '[]'::JSONB,
  faq                           JSONB NOT NULL DEFAULT '[]'::JSONB,

  -- WhatsApp asistente
  whatsapp_number               TEXT,
  whatsapp_welcome_message      TEXT,

  -- Timestamps
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Trigger: enforce singleton (no permitir más de 1 fila)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_enforce_clinic_singleton()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM clinic) >= 1 THEN
    RAISE EXCEPTION 'Solo puede existir una clínica (modelo self-hosted)'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clinic_singleton
  BEFORE INSERT ON clinic
  FOR EACH ROW
  EXECUTE FUNCTION fn_enforce_clinic_singleton();

-- ----------------------------------------------------------------------------
-- Trigger: updated_at automático
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_clinic_updated_at
  BEFORE UPDATE ON clinic
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ----------------------------------------------------------------------------
-- Indices
-- ----------------------------------------------------------------------------
CREATE INDEX idx_clinic_nit ON clinic(nit);

-- ----------------------------------------------------------------------------
-- Registrar migración
-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('002', 'clinic_singleton')
ON CONFLICT (version) DO NOTHING;
