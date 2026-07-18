BEGIN;

CREATE FUNCTION hosted_load_browser_session(
  requested_token_hash text,
  current_time timestamptz
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  actor_id uuid,
  actor_provider_id text,
  token_hash text,
  provider_credential_ciphertext jsonb,
  created_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.tenant_id, s.actor_id, a.provider_user_id::text,
         s.token_hash, s.provider_credential_ciphertext, s.created_at,
         s.expires_at, s.revoked_at
  FROM public.hosted_browser_sessions s
  JOIN public.hosted_actors a ON a.tenant_id = s.tenant_id AND a.id = s.actor_id
  WHERE s.token_hash = requested_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > current_time;
$$;

REVOKE ALL ON FUNCTION hosted_load_browser_session(text, timestamptz) FROM PUBLIC;

COMMIT;
