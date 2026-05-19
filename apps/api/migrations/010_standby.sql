-- =============================================================================
-- 010: Configuración de pantalla standby del kiosco
-- =============================================================================
-- Añade los campos necesarios para los tres modos de standby:
--   mensaje  → solo título + subtítulo (comportamiento original)
--   gif      → título + subtítulo + archivo GIF animado
--   video    → título + subtítulo + archivo de video (mp4/webm) con audio
-- =============================================================================

ALTER TABLE clinic
  ADD COLUMN IF NOT EXISTS standby_mode         TEXT NOT NULL DEFAULT 'mensaje'
                           CHECK (standby_mode IN ('mensaje', 'gif', 'video')),
  ADD COLUMN IF NOT EXISTS standby_title        TEXT,
  ADD COLUMN IF NOT EXISTS standby_subtitle     TEXT,
  ADD COLUMN IF NOT EXISTS standby_media_path   TEXT,
  ADD COLUMN IF NOT EXISTS standby_media_hash   TEXT,
  ADD COLUMN IF NOT EXISTS standby_media_updated_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('010', 'standby')
ON CONFLICT (version) DO NOTHING;
