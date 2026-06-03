-- =============================================================================
-- 017: kiosk_id NULLABLE para acceso web público (Hito A — Opción A)
-- =============================================================================
-- A partir del modelo web público (sin kiosk_token), el flujo del paciente ya
-- NO está asociado a un kiosco físico. Las sesiones, OTPs, consentimientos y
-- transacciones originados en la web se registran con kiosk_id = NULL.
--
-- NOTA: en el esquema actual estas columnas YA son nullable
-- (UUID REFERENCES kiosks(id) ON DELETE SET NULL, sin NOT NULL). Esta migración
-- es DEFENSIVA e IDEMPOTENTE: garantiza el invariante "kiosk_id puede ser NULL"
-- en cualquier entorno (incl. instalaciones donde se hubiera añadido NOT NULL),
-- y deja constancia explícita del cambio de modelo. DROP NOT NULL sobre una
-- columna ya nullable es un no-op sin error.
--
-- REVERSIBILIDAD (down): el runner (migrate.ts) solo implementa `up`. El reverso
-- documentado es re-imponer NOT NULL en estas columnas:
--
--   ALTER TABLE otp_codes            ALTER COLUMN kiosk_id SET NOT NULL;
--   ALTER TABLE patient_sessions     ALTER COLUMN kiosk_id SET NOT NULL;
--   ALTER TABLE transactions         ALTER COLUMN kiosk_id SET NOT NULL;
--   ALTER TABLE habeas_data_consents ALTER COLUMN kiosk_id SET NOT NULL;
--   DELETE FROM schema_migrations WHERE version = '017';
--
-- ⚠️ El down SOLO es aplicable si no existen filas con kiosk_id IS NULL
--    (las sesiones web las generarían); de lo contrario fallaría, que es el
--    comportamiento correcto: no se puede volver al modelo kiosco con datos web.
-- =============================================================================

ALTER TABLE otp_codes            ALTER COLUMN kiosk_id DROP NOT NULL;
ALTER TABLE patient_sessions     ALTER COLUMN kiosk_id DROP NOT NULL;
ALTER TABLE transactions         ALTER COLUMN kiosk_id DROP NOT NULL;
ALTER TABLE habeas_data_consents ALTER COLUMN kiosk_id DROP NOT NULL;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('017', 'nullable_kiosk_id_web')
ON CONFLICT (version) DO NOTHING;
