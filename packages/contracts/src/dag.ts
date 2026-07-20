export const DAG_ARTIFACTS_SCHEMA = "urn:graphrefly-stack:schema:dag-artifacts:v2" as const;
export const DAG_GOLDEN_SUITE_SCHEMA = "urn:graphrefly-stack:schema:dag-golden-suite:v2" as const;
export const DAG_SEMANTIC_ARTIFACTS_SCHEMA =
	"urn:graphrefly-stack:schema:dag-semantic-artifacts:v2" as const;
export const DAG_SEMANTIC_GOLDEN_SUITE_SCHEMA =
	"urn:graphrefly-stack:schema:dag-semantic-golden-suite:v2" as const;
export const DAG_SELECTIVE_RECOVERY_ARTIFACTS_SCHEMA =
	"urn:graphrefly-stack:schema:dag-selective-recovery:v1" as const;

export const GIT_TOPOLOGY_SLICE_SCHEMA = "graphrefly.stack.git-topology-slice.v2" as const;
export const JOIN_BINDING_SCHEMA = "graphrefly.stack.join-binding.v2" as const;
export const SEMANTIC_DEPENDENCY_GRAPH_SCHEMA =
	"graphrefly.stack.semantic-dependency-graph.v2" as const;
export const WORK_UNIT_BINDING_V2_SCHEMA = "graphrefly.stack.work-unit-binding.v2" as const;
export const SEMANTIC_RECORD_V2_SCHEMA = "graphrefly.stack.semantic-record.v2" as const;
export const UNIT_EVALUATION_V2_SCHEMA = "graphrefly.stack.unit-evaluation.v2" as const;
export const JOIN_EVALUATION_V2_SCHEMA = "graphrefly.stack.join-evaluation.v2" as const;
export const DAG_GATE_INPUT_SCHEMA = "graphrefly.stack.dag-gate-input.v2" as const;
export const DAG_STRUCTURAL_ERROR_INPUT_SCHEMA =
	"graphrefly.stack.dag-structural-error-input.v2" as const;
export const DAG_GATE_RESULT_SCHEMA = "graphrefly.stack.dag-gate-result.v2" as const;
export const DAG_GATE_BUNDLE_SCHEMA = "graphrefly.stack.dag-gate-bundle.v2" as const;
export const DAG_STRUCTURAL_ERROR_BUNDLE_SCHEMA =
	"graphrefly.stack.dag-structural-error-bundle.v2" as const;
export const DAG_SELECTIVE_RECOVERY_BUNDLE_SCHEMA =
	"graphrefly.stack.dag-selective-recovery-bundle.v1" as const;
export const DAG_REVIEW_SCHEMA = "graphrefly.stack.dag-review.v2" as const;
export const DAG_REVIEW_EVIDENCE_SCHEMA = "graphrefly.stack.dag-review-evidence.v2" as const;
export const DAG_REVIEW_DECISION_SCHEMA = "graphrefly.stack.dag-review-decision.v2" as const;
export const DAG_REVIEW_DECISION_REQUEST_SCHEMA =
	"graphrefly.stack.dag-review-decision-request.v2" as const;

export const DAG_REASON_ORDER = [
	"SCHEMA_INVALID",
	"BINDING_MISSING",
	"BINDING_AMBIGUOUS",
	"COMMIT_BINDING_MISMATCH",
	"SOURCE_SCOPE_VIOLATION",
	"DEPENDENCY_MISSING",
	"DEPENDENCY_CYCLE",
	"DEPENDENCY_NOT_ANCESTOR",
	"DEPENDENCY_INVALID",
	"BLUEPRINT_WITNESS_STALE",
	"CLAIM_INVALID",
	"POLICY_REVISION_STALE",
	"REQUIRED_CHECK_MISSING",
	"REQUIRED_CHECK_FAILED",
	"JOIN_INVALID",
	"ARTIFACT_HASH_MISMATCH",
] as const;

export type DagReasonCode = (typeof DAG_REASON_ORDER)[number];

export const DAG_LIMITS = {
	maxObjects: 64,
	maxWidth: 8,
	maxParents: 2,
} as const;
