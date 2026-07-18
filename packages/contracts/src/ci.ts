export const CI_ARTIFACTS_SCHEMA = "urn:graphrefly-stack:schema:ci-artifacts:v1" as const;
export const CI_GOLDEN_SUITE_SCHEMA = "urn:graphrefly-stack:schema:ci-golden-suite:v1" as const;

export const CI_INVOCATION_SCHEMA = "graphrefly.stack.ci-invocation.v1" as const;
export const CI_RESULT_SCHEMA = "graphrefly.stack.ci-result.v1" as const;
export const CI_BUNDLE_SCHEMA = "graphrefly.stack.ci-bundle.v1" as const;
export const CI_JOB_NAME = "GraphReFly Stack / Semantic Gate" as const;
export const CI_WORKFLOW_PATH = ".github/workflows/graphrefly-stack.yml" as const;

export const CI_REDACTION_EXCLUDES = [
	"source-content",
	"raw-blueprint",
	"check-output",
	"credentials",
	"environment",
	"model-response",
] as const;
