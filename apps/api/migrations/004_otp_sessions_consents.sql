-- =============================================================================
-- Migration 004: OTP codes, patient sessions, habeas data consents
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Tabla: otp_codes (códigos OTP de pacientes)
-- ----------------------------------------------------------------------------
CREATE TABLE otp_codes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kiosk_id             UUID REFERENCES kiosks(id) ON DELETE SET NULL,

  -- Identificación del paciente (hash para no almacenar cédula en claro)
  patient_cedula_hash  TEXT NOT NULL,                     -- SHA256(cedula)
  patient_phone        TEXT NOT NULL,                      -- formato +57XXXXXXXXXX
  patient_email        CITEXT,

  -- El código (bcrypt hash, nunca en claro)
  code_hash            TEXT NOT NULL,

  -- Canal de entrega
  channel              TEXT NOT NULL DEFAULT 'both'
    CHECK (channel IN ('sms', 'email', 'both')),

  -- Tracking de intentos
  attempts             INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL DEFAULT 5,
  consumed_at          TIMESTAMPTZ,

  -- TTL
  expires_at           TIMESTAMPTZ NOT NULL,

  -- Contexto del request
  request_ip           INET,
  user_agent           TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indices para lookup rápido y cleanup
CREATE INDEX idx_otp_active_lookup ON otp_codes(patient_phone, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX idx_otp_expires ON otp_codes(expires_at);
CREATE INDEX idx_otp_cedula_hash ON otp_codes(patient_cedula_hash, created_at DESC);

-- ----------------------------------------------------------------------------
-- Tabla: patient_sessions (sesiones JWT de pacientes autenticados)
-- ----------------------------------------------------------------------------
CREATE TABLE patient_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kiosk_id              UUID REFERENCES kiosks(id) ON DELETE SET NULL,

  -- Referencia al paciente en Dentalink
  dentalink_patient_id  TEXT NOT NULL,
  patient_phone_masked  TEXT,                              -- '+57 30* *** **89'

  -- JWT ID único (jti claim)
  jti                   TEXT NOT NULL UNIQUE,

  -- Duración (típicamente 10 min)
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  revoked_reason        TEXT,

  -- Tracking
  request_ip            INET,
  user_agent            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_jti_active ON patient_sessions(jti)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expires ON patient_sessions(expires_at);
CREATE INDEX idx_sessions_patient ON patient_sessions(dentalink_patient_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- Tabla: habeas_data_consents (registro de consentimientos)
-- Esta tabla es crítica para no-repudio legal.
-- ----------------------------------------------------------------------------
CREATE TABLE habeas_data_consents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kiosk_id              UUID REFERENCES kiosks(id) ON DELETE SET NULL,

  -- Identificación del paciente
  patient_cedula_hash   TEXT NOT NULL,
  patient_phone         TEXT NOT NULL,

  -- Versión exacta del texto consentido
  policy_version        TEXT NOT NULL,
  policy_text_hash      TEXT NOT NULL,                    -- SHA256 del texto mostrado

  -- Estado
  consented_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ,
  revoked_reason        TEXT,

  -- Contexto para no-repudio (auditable)
  ip_address            INET NOT NULL,
  user_agent            TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_consents_lookup ON habeas_data_consents(
  patient_cedula_hash, consented_at DESC
);

-- ----------------------------------------------------------------------------
-- Trigger: habeas_data_consents es INSERT-only (no UPDATE, no DELETE)
-- Excepción: permitir UPDATE solo del campo revoked_at/revoked_reason
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_consents_protect()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'habeas_data_consents no permite DELETE (auditoría legal)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Solo permitir cambios en revoked_at y revoked_reason
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.patient_cedula_hash IS DISTINCT FROM OLD.patient_cedula_hash OR
       NEW.patient_phone IS DISTINCT FROM OLD.patient_phone OR
       NEW.policy_version IS DISTINCT FROM OLD.policy_version OR
       NEW.policy_text_hash IS DISTINCT FROM OLD.policy_text_hash OR
       NEW.consented_at IS DISTINCT FROM OLD.consented_at OR
       NEW.ip_address IS DISTINCT FROM OLD.ip_address OR
       NEW.user_agent IS DISTINCT FROM OLD.user_agent OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Solo se permite modificar revoked_at y revoked_reason en habeas_data_consents'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consents_protect
  BEFORE UPDATE OR DELETE ON habeas_data_consents
  FOR EACH ROW
  EXECUTE FUNCTION fn_consents_protect();

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('004', 'otp_sessions_consents')
ON CONFLICT (version) DO NOTHING;
