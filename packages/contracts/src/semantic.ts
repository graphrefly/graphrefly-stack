export const SEMANTIC_ARTIFACTS_SCHEMA =
	"urn:graphrefly-stack:schema:semantic-artifacts:v1" as const;
export const SEMANTIC_GOLDEN_SUITE_SCHEMA =
	"urn:graphrefly-stack:schema:semantic-golden-suite:v1" as const;

export const SEMANTIC_REASON_ORDER = [
	"SCHEMA_INVALID",
	"PLAN_NOT_ACCEPTED",
	"POLICY_MISMATCH",
	"WORK_UNIT_TRAILER_MISSING",
	"WORK_UNIT_TRAILER_DUPLICATE",
	"WORK_UNIT_UNKNOWN",
	"COMMIT_BINDING_MISMATCH",
	"PATCH_ID_AMBIGUOUS",
	"SOURCE_SCOPE_VIOLATION",
	"SEMANTIC_PARENT_STALE",
	"DEPENDENCY_INVALID",
	"PREDICATE_SELECTOR_AMBIGUOUS",
	"PREDICATE_UNSUPPORTED",
	"BLUEPRINT_PREDICATE_UNSATISFIED",
	"BLUEPRINT_WITNESS_STALE",
	"POLICY_REVISION_STALE",
	"REQUIRED_CHECK_UNDECLARED",
	"REQUIRED_CHECK_MISSING",
	"REQUIRED_CHECK_FAILED",
	"MODEL_CONTEXT_UNAUTHORIZED",
	"ARTIFACT_HASH_MISMATCH",
] as const;

export type SemanticReasonCode = (typeof SEMANTIC_REASON_ORDER)[number];

export const SEMANTIC_STORAGE = {
	policy: ".graphrefly-stack/policy.json",
	plans: ".graphrefly-stack/plans",
	localState: ".git/grfs",
	workUnitTrailer: "GraphReFly-Work-Unit",
} as const;
