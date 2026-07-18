BEGIN;

CREATE TABLE hosted_tenants (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'github'),
  provider_account_id numeric(32, 0) NOT NULL,
  region text NOT NULL CHECK (region ~ '^us-[a-z0-9-]+$'),
  created_at timestamptz NOT NULL,
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE hosted_repositories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hosted_tenants(id),
  provider text NOT NULL CHECK (provider = 'github'),
  provider_repository_id numeric(32, 0) NOT NULL,
  provider_owner_id numeric(32, 0) NOT NULL,
  installation_id numeric(32, 0) NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  semantic_review_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, provider_repository_id)
);

CREATE TABLE hosted_envelopes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  profile text NOT NULL CHECK (profile IN ('gate-summary-v1', 'semantic-review-v1')),
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 2097152),
  object_key text NOT NULL,
  received_at timestamptz NOT NULL,
  content_expires_at timestamptz NOT NULL,
  gate_verdict text NOT NULL CHECK (gate_verdict IN ('pass', 'blocked', 'error')),
  source_run_id numeric(32, 0) NOT NULL,
  source_head text NOT NULL CHECK (source_head ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  read_denied_at timestamptz,
  primary_purge_due_at timestamptz,
  backup_purge_due_at timestamptz,
  content_purged_at timestamptz,
  FOREIGN KEY (tenant_id, repository_id) REFERENCES hosted_repositories(tenant_id, id),
  UNIQUE (tenant_id, repository_id, digest),
  CHECK (content_expires_at = received_at + interval '90 days'),
  CHECK ((read_denied_at IS NULL) = (primary_purge_due_at IS NULL)),
  CHECK ((read_denied_at IS NULL) = (backup_purge_due_at IS NULL)),
  CHECK (primary_purge_due_at IS NULL OR primary_purge_due_at <= read_denied_at + interval '24 hours'),
  CHECK (backup_purge_due_at IS NULL OR backup_purge_due_at <= read_denied_at + interval '30 days')
);

CREATE INDEX hosted_envelopes_repository_received
  ON hosted_envelopes (tenant_id, repository_id, received_at);
CREATE INDEX hosted_envelopes_primary_purge
  ON hosted_envelopes (tenant_id, primary_purge_due_at)
  WHERE content_purged_at IS NULL AND read_denied_at IS NOT NULL;

CREATE TABLE hosted_audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hosted_tenants(id),
  repository_id uuid,
  actor_provider_id numeric(32, 0),
  action text NOT NULL,
  target_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'duplicate', 'scheduled', 'purged')),
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at = recorded_at + interval '365 days'),
  FOREIGN KEY (tenant_id, repository_id) REFERENCES hosted_repositories(tenant_id, id)
);

CREATE TABLE hosted_deletion_tombstones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hosted_tenants(id),
  repository_id uuid NOT NULL,
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL,
  primary_purge_due_at timestamptz NOT NULL,
  backup_purge_due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at = requested_at + interval '365 days'),
  FOREIGN KEY (tenant_id, repository_id) REFERENCES hosted_repositories(tenant_id, id),
  CHECK (primary_purge_due_at <= requested_at + interval '24 hours'),
  CHECK (backup_purge_due_at <= requested_at + interval '30 days')
);

ALTER TABLE hosted_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_deletion_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_repositories FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE hosted_deletion_tombstones FORCE ROW LEVEL SECURITY;

CREATE POLICY hosted_tenants_tenant ON hosted_tenants
  USING (id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('graphrefly.tenant_id', true)::uuid);
CREATE POLICY hosted_repositories_tenant ON hosted_repositories
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);
CREATE POLICY hosted_envelopes_tenant ON hosted_envelopes
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);
CREATE POLICY hosted_audit_events_tenant ON hosted_audit_events
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);
CREATE POLICY hosted_deletion_tombstones_tenant ON hosted_deletion_tombstones
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);

CREATE FUNCTION hosted_reject_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('graphrefly.retention_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'hosted envelope index may only be deleted by retention';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.repository_id <> OLD.repository_id
     OR NEW.digest <> OLD.digest
     OR NEW.profile <> OLD.profile
     OR NEW.byte_length <> OLD.byte_length
     OR NEW.object_key <> OLD.object_key
     OR NEW.received_at <> OLD.received_at
     OR NEW.content_expires_at <> OLD.content_expires_at
     OR NEW.gate_verdict <> OLD.gate_verdict
     OR NEW.source_run_id <> OLD.source_run_id
     OR NEW.source_head <> OLD.source_head THEN
    RAISE EXCEPTION 'hosted envelope evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hosted_envelopes_immutable
  BEFORE UPDATE OR DELETE ON hosted_envelopes
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_immutable_update();

CREATE FUNCTION hosted_reject_all_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('graphrefly.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'hosted append-only record is immutable';
END;
$$;

CREATE TRIGGER hosted_audit_events_append_only
  BEFORE UPDATE OR DELETE ON hosted_audit_events
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_all_mutation();
CREATE TRIGGER hosted_deletion_tombstones_append_only
  BEFORE UPDATE OR DELETE ON hosted_deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_all_mutation();

COMMIT;
