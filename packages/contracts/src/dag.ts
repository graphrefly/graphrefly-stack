export const DAG_ARTIFACTS_SCHEMA = "urn:graphrefly-stack:schema:dag-artifacts:v2" as const;
export const DAG_GOLDEN_SUITE_SCHEMA = "urn:graphrefly-stack:schema:dag-golden-suite:v2" as const;

export const GIT_TOPOLOGY_SLICE_SCHEMA = "graphrefly.stack.git-topology-slice.v2" as const;
export const JOIN_BINDING_SCHEMA = "graphrefly.stack.join-binding.v2" as const;

export const DAG_LIMITS = {
	maxObjects: 64,
	maxWidth: 8,
	maxParents: 2,
} as const;
