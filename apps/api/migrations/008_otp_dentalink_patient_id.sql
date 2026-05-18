-- =============================================================================
-- Migration 008: Agregar dentalink_patient_id a otp_codes y patient_name
-- =============================================================================
-- Razón: al verificar un OTP, necesitamos saber qué paciente Dentalink
-- corresponde sin tener que volver a buscarlo (la cédula está hasheada).
-- Guardamos el ID de Dentalink + nombre en el momento de generar el OTP.
-- =============================================================================

ALTER TABLE otp_codes
  ADD COLUMN dentalink_patient_id  TEXT,
  ADD COLUMN dentalink_patient_name TEXT;

-- Index para queries posteriores por paciente
CREATE INDEX idx_otp_dentalink_patient
  ON otp_codes(dentalink_patient_id)
  WHERE dentalink_patient_id IS NOT NULL;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('008', 'otp_dentalink_patient_id')
ON CONFLICT (version) DO NOTHING;
