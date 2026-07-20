export const RECOVERY_ARTIFACTS_SCHEMA =
	"urn:graphrefly-stack:schema:recovery-artifacts:v1" as const;
export const RECOVERY_IMPACT_SCHEMA = "graphrefly.stack.recovery-impact.v1" as const;
export const RECOVERY_PLAN_PROPOSAL_SCHEMA = "graphrefly.stack.recovery-plan-proposal.v1" as const;
export const RECOVERY_PLAN_SCHEMA = "graphrefly.stack.recovery-plan.v1" as const;
export const RECOVERY_AUTHORIZATION_SCHEMA = "graphrefly.stack.recovery-authorization.v1" as const;
export const RECOVERY_ATTEMPT_SCHEMA = "graphrefly.stack.recovery-attempt.v1" as const;
export const RECOVERY_RESULT_SCHEMA = "graphrefly.stack.recovery-result.v1" as const;
export const RECOVERY_PORTABLE_BUNDLE_SCHEMA =
	"graphrefly.stack.recovery-portable-bundle.v1" as const;

export type RecoveryDisposition = "inverse" | "compensate" | "retain";
export type RecoveryOutcome = "recovered" | "blocked" | "error";
