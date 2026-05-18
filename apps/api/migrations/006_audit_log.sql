-- =============================================================================
-- Migration 006: Audit log (inmutable append-only)
-- =============================================================================
-- Esta tabla es CRÍTICA para auditoría legal y forense.
-- NUNCA se permite UPDATE ni DELETE.
-- =============================================================================

CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,

  -- Actor (quién hizo la acción)
  actor_type      TEXT NOT NULL
    CHECK (actor_type IN (
      'admin',          -- usuario admin de la clínica
      'kiosk',          -- el kiosco mismo
      'patient',        -- un paciente en sesión
      'system',         -- procesos automáticos
      'webhook',        -- webhook entrante (Wompi)
      'license_server', -- license server central
      'support'         -- acceso técnico de ALL CREATIVE
    )),
  actor_id        UUID,
  actor_email     TEXT,
  actor_ip        INET,
  actor_user_agent TEXT,

  -- Acción
  action          TEXT NOT NULL,                          -- 'admin.login.success', 'tx.approved', etc

  -- Recurso afectado
  resource_type   TEXT,                                    -- 'transaction', 'admin', 'config', etc
  resource_id     TEXT,

  -- Datos adicionales (estructurados)
  metadata        JSONB,

  -- Resultado
  result          TEXT NOT NULL DEFAULT 'success'
    CHECK (result IN ('success', 'failure', 'denied', 'error')),
  error_message   TEXT,

  -- Timestamp (inmutable)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indices para búsqueda
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_type, actor_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_failures ON audit_log(result, created_at DESC)
  WHERE result IN ('failure', 'denied', 'error');

-- ----------------------------------------------------------------------------
-- Triggers de inmutabilidad
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION fn_prevent_modification();

CREATE TRIGGER trg_audit_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION fn_prevent_modification();

-- ----------------------------------------------------------------------------
-- Helper function: insertar audit entry con redacción automática de PII
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_audit(
  p_actor_type    TEXT,
  p_actor_id      UUID,
  p_action        TEXT,
  p_resource_type TEXT DEFAULT NULL,
  p_resource_id   TEXT DEFAULT NULL,
  p_metadata      JSONB DEFAULT NULL,
  p_result        TEXT DEFAULT 'success',
  p_error_message TEXT DEFAULT NULL,
  p_ip            INET DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
  new_id BIGINT;
BEGIN
  INSERT INTO audit_log (
    actor_type, actor_id, action,
    resource_type, resource_id,
    metadata, result, error_message,
    actor_ip
  ) VALUES (
    p_actor_type, p_actor_id, p_action,
    p_resource_type, p_resource_id,
    p_metadata, p_result, p_error_message,
    p_ip
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('006', 'audit_log')
ON CONFLICT (version) DO NOTHING;
