BEGIN;

ALTER TABLE hosted_audit_events
  ADD COLUMN actor_id uuid,
  ADD COLUMN target_type text
    CHECK (target_type IS NULL OR target_type IN ('tenant', 'membership', 'repository', 'envelope', 'decision'));

ALTER TABLE hosted_audit_events
  ADD FOREIGN KEY (tenant_id, actor_id) REFERENCES hosted_actors(tenant_id, id);

CREATE TABLE hosted_decisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^[0-9a-f]{64}$'),
  gate_input_digest text NOT NULL CHECK (gate_input_digest ~ '^[0-9a-f]{64}$'),
  witness_ids jsonb NOT NULL CHECK (
    jsonb_typeof(witness_ids) = 'array' AND jsonb_array_length(witness_ids) > 0
  ),
  decision text NOT NULL CHECK (decision IN ('approve', 'request-changes', 'defer')),
  summary text NOT NULL CHECK (
    char_length(summary) BETWEEN 1 AND 1000 AND summary !~ E'[\u0000-\u0008\u000b\u000c\u000e-\u001f]'
  ),
  supersedes uuid,
  received_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at = received_at + interval '365 days'),
  FOREIGN KEY (tenant_id, repository_id, envelope_digest)
    REFERENCES hosted_envelopes(tenant_id, repository_id, digest),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES hosted_actors(tenant_id, id),
  UNIQUE (tenant_id, repository_id, envelope_digest, id),
  FOREIGN KEY (tenant_id, repository_id, envelope_digest, supersedes)
    REFERENCES hosted_decisions(tenant_id, repository_id, envelope_digest, id)
);

CREATE INDEX hosted_decisions_envelope_history
  ON hosted_decisions (tenant_id, repository_id, envelope_digest, received_at, id);
CREATE INDEX hosted_decisions_expiry ON hosted_decisions (tenant_id, expires_at);
CREATE INDEX hosted_audit_export ON hosted_audit_events (tenant_id, recorded_at, id);

ALTER TABLE hosted_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY hosted_decisions_tenant ON hosted_decisions
  USING (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('graphrefly.tenant_id', true)::uuid);

CREATE TRIGGER hosted_decisions_append_only
  BEFORE UPDATE OR DELETE ON hosted_decisions
  FOR EACH ROW EXECUTE FUNCTION hosted_reject_all_mutation();

COMMIT;
