export const REPOSITORY_CONFIG_SCHEMA = "graphrefly.stack.repository.v1" as const;
export const REPOSITORY_REVIEW_SCHEMA = "graphrefly.stack.review.v1" as const;
export const REPOSITORY_REVIEW_DECISION_REQUEST_SCHEMA =
	"graphrefly.stack.repository-review-decision-request.v1" as const;
export const REPOSITORY_REVIEW_DECISION_SCHEMA =
	"graphrefly.stack.repository-review-decision.v1" as const;
export const REPOSITORY_REVIEW_BUNDLE_SCHEMA =
	"graphrefly.stack.repository-review-bundle.v1" as const;
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

export interface RepositoryReviewDecisionRequest {
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

export interface RepositoryReviewDecision {
	readonly schema: typeof REPOSITORY_REVIEW_DECISION_SCHEMA;
	readonly id: string;
	readonly target: RepositoryReviewTarget;
	readonly decision: "approve" | "request-changes";
	readonly reviewerLabel: string;
	readonly summary: string;
	readonly recordedAt: string;
	readonly identityVerified: false;
}

export interface RepositoryReviewBundle {
	readonly schema: typeof REPOSITORY_REVIEW_BUNDLE_SCHEMA;
	readonly repository: {
		readonly label: string;
		readonly baseOid: string;
		readonly headOid: string;
	};
	readonly artifacts: readonly {
		readonly path: string;
		readonly hash: { readonly algorithm: "sha256"; readonly value: string };
		readonly record: RepositoryReviewDecision;
	}[];
}
