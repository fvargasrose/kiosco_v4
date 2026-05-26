-- =============================================================================
-- 014: Metadatos del logo de la clínica
-- =============================================================================
-- La columna clinic.logo_path ya existe desde 002. Aquí añadimos los metadatos
-- necesarios para servirlo como estático cacheable (hash → ETag, mime → Content-Type,
-- updated_at → cache-buster en la URL).
-- =============================================================================

ALTER TABLE clinic
  ADD COLUMN IF NOT EXISTS logo_hash       TEXT,
  ADD COLUMN IF NOT EXISTS logo_mime       TEXT,
  ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('014', 'clinic_logo')
ON CONFLICT (version) DO NOTHING;
