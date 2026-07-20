import { Ajv } from "ajv";

export * from "./ci.js";
export * from "./dag.js";
export * from "./dag-integrity.js";
export * from "./dag-review-integrity.js";
export * from "./dag-semantic-integrity.js";
export * from "./dag-structural-error-integrity.js";
export * from "./group-integration-integrity.js";
export * from "./hosted.js";
export * from "./hosted-integrity.js";
export * from "./integration.js";
export * from "./integration-integrity.js";
export * from "./jcs.js";
export * from "./linear-v1-conversion.js";
export * from "./merge-group.js";
export * from "./merge-group-integrity.js";
export * from "./repository-review.js";
export * from "./selective-recovery-integrity.js";
export * from "./semantic.js";

export const CONTRACT_VERSION = "v1" as const;
export const CLI_RESULT_SCHEMA = "urn:graphrefly-stack:schema:cli-result:v1" as const;

export type CliCommand =
	| "init"
	| "ci-init"
	| "ci-run"
	| "hosted-init"
	| "hosted-sync"
	| "integration"
	| "integration-ci"
	| "fixture-create"
	| "plan"
	| "gate"
	| "replan"
	| "review"
	| "export";
export type ExecutionMode = "deterministic" | "replay" | "live" | "replay-fallback";

export interface CliError {
	code: string;
	message: string;
	details?: unknown;
}

export type CliResult<T> =
	| {
			schema: typeof CLI_RESULT_SCHEMA;
			command: CliCommand;
			ok: true;
			mode: ExecutionMode;
			data: T;
	  }
	| {
			schema: typeof CLI_RESULT_SCHEMA;
			command: CliCommand;
			ok: false;
			mode: ExecutionMode;
			error: CliError;
	  };

export function createStrictAjv() {
	return new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
}
