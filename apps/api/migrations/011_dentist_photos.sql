-- Asocia fotos de odontólogos (gestionadas localmente) con sus IDs en Dentalink.
-- La foto se guarda en disco; aquí solo se guarda la ruta y el hash SHA-256.

CREATE TABLE IF NOT EXISTS dentist_photos (
  dentalink_dentist_id TEXT PRIMARY KEY,
  photo_path           TEXT NOT NULL,
  photo_hash           TEXT NOT NULL,
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name)
VALUES ('011', 'dentist_photos')
ON CONFLICT (version) DO NOTHING;
