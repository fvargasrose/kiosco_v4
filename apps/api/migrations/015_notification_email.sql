-- =============================================================================
-- 015: Email del admin para notificaciones de pago
-- =============================================================================
-- Cuando Wompi confirma un pago aprobado, además del recibo al paciente,
-- el sistema envía una copia enriquecida al administrador en este email.
-- Es opcional: si es NULL, no se intenta enviar.
-- =============================================================================

ALTER TABLE clinic
  ADD COLUMN IF NOT EXISTS notification_email CITEXT;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('015', 'notification_email')
ON CONFLICT (version) DO NOTHING;
