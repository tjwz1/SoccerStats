-- Run this in the Supabase SQL Editor to enable the shared rate-limit store.
-- After running, the per-IP rate limit counter is shared across all Vercel instances.

CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 1,
  reset_time TIMESTAMPTZ NOT NULL
);

-- Atomic increment: resets count when the window has expired, otherwise increments.
-- Called by the SupabaseRateLimitStore on every incoming API request.
CREATE OR REPLACE FUNCTION rate_limit_increment(p_key TEXT, p_window_ms BIGINT)
RETURNS TABLE(hits INTEGER, reset_time TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rate_limits (key, count, reset_time)
  VALUES (p_key, 1, NOW() + (p_window_ms || ' milliseconds')::INTERVAL)
  ON CONFLICT (key) DO UPDATE SET
    count      = CASE WHEN rate_limits.reset_time <= NOW() THEN 1 ELSE rate_limits.count + 1 END,
    reset_time = CASE WHEN rate_limits.reset_time <= NOW()
                      THEN NOW() + (p_window_ms || ' milliseconds')::INTERVAL
                      ELSE rate_limits.reset_time END;

  RETURN QUERY SELECT r.count, r.reset_time FROM rate_limits r WHERE r.key = p_key;
END;
$$;
