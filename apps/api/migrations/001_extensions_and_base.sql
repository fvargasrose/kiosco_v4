-- =============================================================================
-- Migration 001: Extensiones y funciones base
-- =============================================================================
-- Esta migración prepara el terreno: extensiones de Postgres, funciones
-- helper, y la tabla de tracking de migraciones.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Extensiones requeridas
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";        -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;            -- pgp_sym_encrypt/decrypt
CREATE EXTENSION IF NOT EXISTS citext;              -- case-insensitive text (emails)

-- ----------------------------------------------------------------------------
-- Tabla de migraciones (tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by    TEXT NOT NULL DEFAULT current_user,
  checksum      TEXT,
  duration_ms   INTEGER
);

-- ----------------------------------------------------------------------------
-- Función: actualizar updated_at automáticamente
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Función: prevenir UPDATE/DELETE en tablas inmutables (audit_log)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_prevent_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Tabla % es inmutable: operación % no permitida',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- Función: cifrar token con clave del entorno
-- La clave viene de la variable de sesión 'app.encryption_key'
-- que el API setea con: SET LOCAL app.encryption_key = '<clave>'
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_encrypt(plain TEXT)
RETURNS BYTEA AS $$
DECLARE
  enc_key TEXT;
BEGIN
  IF plain IS NULL OR plain = '' THEN
    RETURN NULL;
  END IF;

  enc_key := current_setting('app.encryption_key', true);
  IF enc_key IS NULL OR enc_key = '' THEN
    RAISE EXCEPTION 'app.encryption_key no está configurada en la sesión';
  END IF;

  RETURN pgp_sym_encrypt(plain, enc_key);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION fn_decrypt(encrypted BYTEA)
RETURNS TEXT AS $$
DECLARE
  enc_key TEXT;
BEGIN
  IF encrypted IS NULL THEN
    RETURN NULL;
  END IF;

  enc_key := current_setting('app.encryption_key', true);
  IF enc_key IS NULL OR enc_key = '' THEN
    RAISE EXCEPTION 'app.encryption_key no está configurada en la sesión';
  END IF;

  RETURN pgp_sym_decrypt(encrypted, enc_key);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ----------------------------------------------------------------------------
-- Registrar esta migración
-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('001', 'extensions_and_base_functions')
ON CONFLICT (version) DO NOTHING;
