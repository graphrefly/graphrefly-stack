export const REPOSITORY_CONFIG_SCHEMA = "graphrefly.stack.repository.v1" as const;
export const REPOSITORY_REVIEW_SCHEMA = "graphrefly.stack.review.v1" as const;
export const REPOSITORY_REVIEW_DECISION_REQUEST_SCHEMA =
	"graphrefly.stack.repository-review-decision-request.v1" as const;
export const REPOSITORY_REVIEW_DECISION_SCHEMA =
	"graphrefly.stack.repository-review-decision.v1" as const;
export const REPOSITORY_REVIEW_BUNDLE_SCHEMA =
	"graphrefly.stack.repository-review-bundle.v1" as const;
export const REPOSITORY_REVIEW_DECISION_REQUEST_V2_SCHEMA =
	"graphrefly.stack.repository-review-decision-request.v2" as const;
export const REPOSITORY_REVIEW_DECISION_V2_SCHEMA =
	"graphrefly.stack.repository-review-decision.v2" as const;
export const REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA =
	"graphrefly.stack.repository-review-bundle.v2" as const;
export const REVIEW_DECISION_HISTORY_SCHEMA =
	"graphrefly.stack.review-decision-history.v1" as const;
export const SUPPORTED_GRAPHREFLY_RANGE = ">=0.3.0 <0.4.0" as const;

export interface RepositoryConfig {
	readonly schema: typeof REPOSITORY_CONFIG_SCHEMA;
	readonly blueprint: {
		readonly entrypoint: string;
	};
}

export interface StructuredDiffLine {
	readonly kind: "context" | "delete" | "add";
	readonly content: string;
	readonly oldNo?: number;
	readonly newNo?: number;
}

export interface StructuredDiffHunk {
	readonly header: string;
	readonly lines: readonly StructuredDiffLine[];
}

export interface StructuredFileDiff {
	readonly oldPath: string;
	readonly newPath: string;
	readonly additions: number;
	readonly deletions: number;
	readonly binary: boolean;
	readonly hunks: readonly StructuredDiffHunk[];
}

export interface StructuredGitDiff {
	readonly paths: readonly string[];
	readonly files: readonly StructuredFileDiff[];
}

export interface RepositoryDiagram {
	readonly format: "mermaid";
	readonly renderer: "@graphrefly/ts/render.blueprintToMermaid";
	readonly source: string;
}

export interface RepositoryRevisionEvidence {
	readonly oid: string;
	readonly subject: string;
	readonly blueprint: Record<string, unknown>;
	readonly diagram: RepositoryDiagram;
}

export interface RepositoryReviewCommit extends RepositoryRevisionEvidence {
	readonly parentOid: string;
	readonly delta: Record<string, unknown>;
	readonly diff: StructuredGitDiff;
}

export interface RepositoryReview {
	readonly schema: typeof REPOSITORY_REVIEW_SCHEMA;
	readonly source: "generic-repository";
	readonly repository: {
		readonly label: string;
		readonly headLabel: string;
		readonly graphreflyVersion: string;
		readonly entrypoint: string;
		readonly baseOid: string;
		readonly headOid: string;
	};
	readonly base: RepositoryRevisionEvidence;
	readonly commits: readonly RepositoryReviewCommit[];
	readonly semanticStatus: "not-configured" | "evaluated";
	readonly semantic?: {
		readonly plan: Record<string, unknown>;
		readonly bindings: readonly Record<string, unknown>[];
		readonly records: readonly Record<string, unknown>[];
		readonly checks: readonly Record<string, unknown>[];
		readonly gateResult: Record<string, unknown>;
		readonly invalidWorkUnitIds: readonly string[];
	};
}

export interface RepositoryReviewDecisionRequestV1 {
	readonly schema: typeof REPOSITORY_REVIEW_DECISION_REQUEST_SCHEMA;
	readonly commitOid: string;
	readonly decision: "approve" | "request-changes";
	readonly reviewerLabel: string;
	readonly summary: string;
}

export interface RepositoryReviewTarget {
	readonly baseOid: string;
	readonly headOid: string;
	readonly parentOid: string;
	readonly commitOid: string;
	readonly blueprintHash: string;
}

export interface RepositoryReviewDecisionV1 {
	readonly schema: typeof REPOSITORY_REVIEW_DECISION_SCHEMA;
	readonly id: string;
	readonly target: RepositoryReviewTarget;
	readonly decision: "approve" | "request-changes";
	readonly reviewerLabel: string;
	readonly summary: string;
	readonly recordedAt: string;
	readonly identityVerified: false;
}

export interface RepositoryReviewBundleV1 {
	readonly schema: typeof REPOSITORY_REVIEW_BUNDLE_SCHEMA;
	readonly repository: {
		readonly label: string;
		readonly baseOid: string;
		readonly headOid: string;
	};
	readonly artifacts: readonly {
		readonly path: string;
		readonly hash: { readonly algorithm: "sha256"; readonly value: string };
		readonly record: RepositoryReviewDecisionV1;
	}[];
}

// Preserve the published v1 type names for consumers that still verify or
// project historical repository review artifacts.
export type RepositoryReviewDecisionRequest = RepositoryReviewDecisionRequestV1;
export type RepositoryReviewBundle = RepositoryReviewBundleV1;

export interface RepositoryReviewDecisionRequestV2 {
	readonly schema: typeof REPOSITORY_REVIEW_DECISION_REQUEST_V2_SCHEMA;
	readonly decision: "approve" | "request-changes";
	readonly reviewerLabel: string;
	readonly summary: string;
	readonly contextCommitOid?: string;
}

export interface RepositoryReviewTargetV2 {
	readonly baseOid: string;
	readonly headOid: string;
	readonly reviewTargetDigest: {
		readonly algorithm: "sha256";
		readonly value: string;
	};
}

export interface RepositoryReviewDecisionV2 {
	readonly schema: typeof REPOSITORY_REVIEW_DECISION_V2_SCHEMA;
	readonly id: string;
	readonly target: RepositoryReviewTargetV2;
	readonly contextCommitOid?: string;
	readonly decision: "approve" | "request-changes";
	readonly reviewerLabel: string;
	readonly summary: string;
	readonly recordedAt: string;
	readonly identityVerified: false;
}

export type RepositoryReviewDecision = RepositoryReviewDecisionV1 | RepositoryReviewDecisionV2;

export interface RepositoryReviewDecisionHistory<T = RepositoryReviewDecision> {
	readonly schema: typeof REVIEW_DECISION_HISTORY_SCHEMA;
	readonly current: readonly T[];
	readonly outdated: readonly T[];
}

export interface RepositoryReviewBundleV2 {
	readonly schema: typeof REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA;
	readonly repository: {
		readonly label: string;
		readonly baseOid: string;
		readonly headOid: string;
	};
	readonly reviewTargetDigest: {
		readonly algorithm: "sha256";
		readonly value: string;
	};
	readonly artifacts: readonly {
		readonly path: string;
		readonly hash: { readonly algorithm: "sha256"; readonly value: string };
		readonly record: RepositoryReviewDecisionV2;
	}[];
}
