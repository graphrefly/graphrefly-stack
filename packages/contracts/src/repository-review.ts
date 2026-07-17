export const REPOSITORY_CONFIG_SCHEMA = "graphrefly.stack.repository.v1" as const;
export const REPOSITORY_REVIEW_SCHEMA = "graphrefly.stack.review.v1" as const;
export const SUPPORTED_GRAPHREFLY_VERSION = "0.3.0" as const;

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
		readonly graphreflyVersion: typeof SUPPORTED_GRAPHREFLY_VERSION;
		readonly entrypoint: string;
		readonly baseOid: string;
		readonly headOid: string;
	};
	readonly base: RepositoryRevisionEvidence;
	readonly commits: readonly RepositoryReviewCommit[];
	readonly semanticStatus: "not-configured";
}
