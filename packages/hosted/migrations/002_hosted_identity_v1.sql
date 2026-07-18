BEGIN;

CREATE TABLE hosted_actors (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hosted_tenants(id),
  provider text NOT NULL CHECK (provider = 'github'),
  provider_user_id numeric(32, 0) NOT NULL,
  provider_login text NOT NULL CHECK (provider_login <> ''),
  created_at timestamptz NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_user_id)
);

CREATE TABLE hosted_memberships (
  tenant_id uuid NOT NULL REFERENCES hosted_tenants(id),
  actor_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'reviewer', 'viewer')),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, actor_id),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES hosted_actors(tenant_id, id),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE hosted_login_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hosted_tenants(id),
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  pkce_verifier_ciphertext jsonb NOT NULL,
  redirect_uri text NOT NULL CHECK (redirect_uri ~ '^https://'),
  return_to text NOT NULL CHECK (
    return_to = '/' OR (return_to ~ '^/[^/]' AND return_to !~ E'[\\\\\r\n]')
  ),
  repository_id uuid,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (tenant_id, repository_id) REFERENCES hosted_repositories(tenant_id, id),
  CHECK (expires_at = created_at + interval '10 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at <= expires_at)
);

CREATE TABLE hosted_browser_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hosted_tenants(id),
  actor_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  provider_credential_ciphertext jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  credential_rotated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, actor_id) REFERENCES hosted_actors(tenant_id, id),
  CHECK (expires_at <= created_at + interval '8 hours'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX hosted_login_attempts_expiry ON hosted_login_attempts (expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX hosted_browser_sessions_actor ON hosted_browser_sessions (tenant_id, actor_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE hosted_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_actors FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_login_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_browser_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY hosted_actors_tenant ON hosted_actors
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);
CREATE POLICY hosted_memberships_tenant ON hosted_memberships
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);
CREATE POLICY hosted_login_attempts_tenant ON hosted_login_attempts
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);
CREATE POLICY hosted_browser_sessions_tenant ON hosted_browser_sessions
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);

-- The callback path invokes this through a database role that has EXECUTE but no
-- direct table access. The UPDATE is the one-time consume boundary; concurrent
-- callbacks cannot both obtain the verifier ciphertext.
CREATE FUNCTION hosted_consume_login_attempt(
  requested_state_hash text,
  consumed_time timestamptz
) RETURNS SETOF hosted_login_attempts
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.hosted_login_attempts
  SET consumed_at = consumed_time
  WHERE state_hash = requested_state_hash
    AND consumed_at IS NULL
    AND expires_at > consumed_time
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION hosted_consume_login_attempt(text, timestamptz) FROM PUBLIC;

COMMIT;
