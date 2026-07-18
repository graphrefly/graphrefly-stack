export const HOSTED_ARTIFACTS_SCHEMA = "urn:graphrefly-stack:schema:hosted-artifacts:v1" as const;
export const HOSTED_GOLDEN_SUITE_SCHEMA =
	"urn:graphrefly-stack:schema:hosted-golden-suite:v1" as const;

export const HOSTED_ENVELOPE_SCHEMA = "graphrefly.stack.hosted-envelope.v1" as const;
export const HOSTED_GATE_SUMMARY_SCHEMA = "graphrefly.stack.hosted-gate-summary.v1" as const;
export const HOSTED_SEMANTIC_REVIEW_SCHEMA = "graphrefly.stack.hosted-semantic-review.v1" as const;
export const HOSTED_LOCAL_REVIEW_SCHEMA = "graphrefly.stack.hosted-local-review.v1" as const;
export const HOSTED_DECISION_SCHEMA = "graphrefly.stack.hosted-decision.v1" as const;
export const HOSTED_AUDIT_EVENT_SCHEMA = "graphrefly.stack.hosted-audit-event.v1" as const;
export const HOSTED_OIDC_CLAIMS_SCHEMA = "graphrefly.stack.github-oidc-claims.v1" as const;

export const HOSTED_OIDC_AUDIENCE = "graphrefly-stack-hosted" as const;
export const HOSTED_OIDC_ISSUER = "https://token.actions.githubusercontent.com" as const;
export const HOSTED_SYNC_WORKFLOW_PATH = ".github/workflows/graphrefly-stack-hosted.yml" as const;
export const HOSTED_SYNC_WORKFLOW_NAME = "GraphReFly Stack Hosted Sync" as const;

export const HOSTED_REDACTION_PROFILES = [
	"gate-summary-v1",
	"semantic-review-v1",
	"local-review-decisions-v1",
] as const;

export const HOSTED_REDACTION_EXCLUDES = [
	"source-content",
	"raw-blueprint",
	"check-output",
	"credentials",
	"environment",
	"model-response",
] as const;

export const HOSTED_MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const HOSTED_DAILY_UPLOAD_LIMIT = 100;
export const HOSTED_TENANT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const HOSTED_ENVELOPE_RETENTION_DAYS = 90;
export const HOSTED_INDEX_RETENTION_DAYS = 365;
export const HOSTED_PRIMARY_PURGE_HOURS = 24;
export const HOSTED_BACKUP_PURGE_DAYS = 30;

export type HostedRedactionProfile = (typeof HOSTED_REDACTION_PROFILES)[number];
export type HostedRole = "owner" | "admin" | "reviewer" | "viewer";
export type HostedDecisionValue = "approve" | "request-changes" | "defer";
