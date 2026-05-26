-- =============================================================================
-- Migration 013: Catálogo local de procedimientos / tratamientos
-- =============================================================================
-- El admin gestiona un catálogo de procedimientos con duración variable.
-- El kiosco lo expone como paso "treatment" en el flujo de booking, y la
-- duración elegida se pasa a /api/v1/agendas y /api/v1/citas.
--
-- IMPORTANTE: Dentalink solo acepta duraciones específicas. Validado
-- empíricamente: {15, 30, 45, 60, 75, 90, 105, 120} minutos. Otras duraciones
-- son redondeadas silenciosamente por /agendas y rechazadas con HTTP 400 por
-- POST /citas. El CHECK enforce esto a nivel de BD.
--
-- Nota: el campo `clinic.procedures JSONB` (migración 002) queda como legacy.
-- El bootstrap del kiosco leerá desde esta tabla en su lugar.
-- =============================================================================

CREATE TABLE IF NOT EXISTS clinic_procedures (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        INTEGER NOT NULL REFERENCES clinic(id) ON DELETE CASCADE,
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  duration_minutes INTEGER NOT NULL
                     CHECK (duration_minutes IN (15, 30, 45, 60, 75, 90, 105, 120)),
  description      TEXT,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clinic_procedures_active
  ON clinic_procedures(clinic_id, active);

CREATE TRIGGER trg_clinic_procedures_updated_at
  BEFORE UPDATE ON clinic_procedures
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('013', 'clinic_procedures')
ON CONFLICT (version) DO NOTHING;
