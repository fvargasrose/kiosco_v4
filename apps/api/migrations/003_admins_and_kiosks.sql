-- =============================================================================
-- Migration 003: Admins y kiosks
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Tabla: admins (usuarios administrativos de la clínica)
-- ----------------------------------------------------------------------------
CREATE TABLE admins (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 CITEXT UNIQUE NOT NULL,
  password_hash         TEXT NOT NULL,                    -- argon2id
  full_name             TEXT NOT NULL,
  phone                 TEXT,

  -- Roles dentro de la clínica
  role                  TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('admin', 'viewer')),

  -- MFA (TOTP)
  totp_secret_encrypted BYTEA,
  totp_recovery_codes_encrypted BYTEA,                    -- JSON array de códigos
  mfa_enrolled          BOOLEAN NOT NULL DEFAULT false,
  mfa_required          BOOLEAN NOT NULL DEFAULT true,

  -- Estado
  is_active             BOOLEAN NOT NULL DEFAULT true,
  must_change_password  BOOLEAN NOT NULL DEFAULT false,

  -- Login tracking
  last_login_at         TIMESTAMPTZ,
  last_login_ip         INET,
  last_password_change  TIMESTAMPTZ NOT NULL DEFAULT now(),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Soft delete (no perder histórico)
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX idx_admins_email ON admins(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_admins_active ON admins(is_active) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_admins_updated_at
  BEFORE UPDATE ON admins
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ----------------------------------------------------------------------------
-- Tabla: kiosks (dispositivos kiosco físicos)
-- ----------------------------------------------------------------------------
CREATE TABLE kiosks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,                        -- 'Recepción Principal'
  location          TEXT,                                  -- 'Sucursal Norte, Piso 1'

  -- Tipo de dispositivo
  device_type       TEXT NOT NULL DEFAULT 'unknown'
    CHECK (device_type IN ('pc', 'tablet_android', 'unknown')),

  -- Autenticación del kiosco (JWT)
  token_hash        TEXT NOT NULL UNIQUE,                 -- SHA256 del JWT
  token_expires_at  TIMESTAMPTZ NOT NULL,

  -- Telemetría
  last_seen_at      TIMESTAMPTZ,
  last_ip           INET,
  last_user_agent   TEXT,

  -- Estado
  is_active         BOOLEAN NOT NULL DEFAULT true,
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,
  revoked_by        UUID REFERENCES admins(id),

  -- Timestamps
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES admins(id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_kiosks_active ON kiosks(is_active) WHERE is_active = true;
CREATE INDEX idx_kiosks_last_seen ON kiosks(last_seen_at);

CREATE TRIGGER trg_kiosks_updated_at
  BEFORE UPDATE ON kiosks
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ----------------------------------------------------------------------------
-- Registrar migración
-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('003', 'admins_and_kiosks')
ON CONFLICT (version) DO NOTHING;
