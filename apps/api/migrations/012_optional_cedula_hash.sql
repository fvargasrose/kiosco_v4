-- =============================================================================
-- 012: Hacer NULLABLE patient_cedula_hash en otp_codes y habeas_data_consents
-- =============================================================================
-- El login del paciente ahora puede hacerse SOLO por teléfono (sin cédula).
-- En esos flujos no tenemos cédula para hashear y debemos permitir NULL.
-- Los registros antiguos conservan su hash; los nuevos pueden ser NULL.
-- =============================================================================

ALTER TABLE otp_codes
  ALTER COLUMN patient_cedula_hash DROP NOT NULL;

ALTER TABLE habeas_data_consents
  ALTER COLUMN patient_cedula_hash DROP NOT NULL;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('012', 'optional_cedula_hash')
ON CONFLICT (version) DO NOTHING;
