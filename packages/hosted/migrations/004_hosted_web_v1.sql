BEGIN;

ALTER TABLE hosted_login_attempts
  ADD COLUMN browser_binding_hash text;

-- Pre-binding login attempts cannot be completed safely. They are ephemeral and
-- intentionally invalidated instead of receiving a fabricated browser binding.
DELETE FROM hosted_login_attempts;

ALTER TABLE hosted_login_attempts
  ALTER COLUMN browser_binding_hash SET NOT NULL,
  ADD CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$');

DROP FUNCTION hosted_consume_login_attempt(text, timestamptz);

CREATE FUNCTION hosted_consume_login_attempt(
  requested_state_hash text,
  requested_browser_binding_hash text,
  consumed_time timestamptz
) RETURNS SETOF hosted_login_attempts
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.hosted_login_attempts
  SET consumed_at = consumed_time
  WHERE state_hash = requested_state_hash
    AND browser_binding_hash = requested_browser_binding_hash
    AND consumed_at IS NULL
    AND expires_at > consumed_time
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION hosted_consume_login_attempt(text, text, timestamptz) FROM PUBLIC;

COMMIT;
