export const MERGE_GROUP_ARTIFACTS_SCHEMA =
	"urn:graphrefly-stack:schema:merge-group-artifacts:v1" as const;
export const MERGE_GROUP_GOLDEN_SUITE_SCHEMA =
	"urn:graphrefly-stack:schema:merge-group-golden-suite:v1" as const;
export const PLAN_QUALIFIED_COMMIT_SCHEMA = "graphrefly.stack.plan-qualified-commit.v1" as const;
export const LINEAR_V1_CONVERSION_SCHEMA = "graphrefly.stack.linear-v1-conversion.v1" as const;
export const LINEAR_V1_CONVERSION_BUNDLE_SCHEMA =
	"graphrefly.stack.linear-v1-conversion-bundle.v1" as const;

export const MULTI_PLAN_LIMITS = {
	maxPlans: 8,
} as const;
