-- =============================================================================
-- 016: Toggle "video con sonido" en pantalla standby
-- =============================================================================
-- Agrega un flag boolean que controla si el video del standby se reproduce
-- con audio. Default false: audio sorpresa en kiosco es mala UX, el admin
-- debe activarlo explícitamente.
-- =============================================================================

ALTER TABLE clinic
  ADD COLUMN IF NOT EXISTS standby_video_sound BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('016', 'standby_video_sound')
ON CONFLICT (version) DO NOTHING;
