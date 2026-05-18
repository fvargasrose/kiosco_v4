-- =============================================================================
-- Migration 007: Rate limits (fallback persistente)
-- =============================================================================
-- En producción usaremos Redis para rate limiting (rápido).
-- Esta tabla es fallback en caso de Redis caído, y también para
-- ventanas largas que sobreviven reinicios.
-- =============================================================================

CREATE TABLE rate_limits (
  bucket_key      TEXT PRIMARY KEY,                       -- 'otp:phone:+573001234567'
  count           INTEGER NOT NULL DEFAULT 1,
  window_start    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);

-- ----------------------------------------------------------------------------
-- Helper: incrementar contador (atómico)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_rate_limit_check(
  p_bucket_key  TEXT,
  p_max_count   INTEGER,
  p_window_secs INTEGER
) RETURNS TABLE(allowed BOOLEAN, current_count INTEGER, retry_after_secs INTEGER) AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_expires TIMESTAMPTZ := v_now + (p_window_secs || ' seconds')::INTERVAL;
  v_count INTEGER;
  v_existing_expires TIMESTAMPTZ;
BEGIN
  -- Upsert atómico
  INSERT INTO rate_limits (bucket_key, count, window_start, expires_at)
  VALUES (p_bucket_key, 1, v_now, v_expires)
  ON CONFLICT (bucket_key) DO UPDATE
    SET count = CASE
                  WHEN rate_limits.expires_at < v_now THEN 1
                  ELSE rate_limits.count + 1
                END,
        window_start = CASE
                         WHEN rate_limits.expires_at < v_now THEN v_now
                         ELSE rate_limits.window_start
                       END,
        expires_at = CASE
                       WHEN rate_limits.expires_at < v_now THEN v_expires
                       ELSE rate_limits.expires_at
                     END
  RETURNING count, expires_at INTO v_count, v_existing_expires;

  RETURN QUERY SELECT
    (v_count <= p_max_count) AS allowed,
    v_count AS current_count,
    CASE
      WHEN v_count > p_max_count
      THEN EXTRACT(EPOCH FROM (v_existing_expires - v_now))::INTEGER
      ELSE 0
    END AS retry_after_secs;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
INSERT INTO schema_migrations (version, name)
VALUES ('007', 'rate_limits')
ON CONFLICT (version) DO NOTHING;
