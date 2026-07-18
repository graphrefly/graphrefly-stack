import { Ajv } from "ajv";

export * from "./ci.js";
export * from "./hosted.js";
export * from "./hosted-integrity.js";
export * from "./integration.js";
export * from "./integration-integrity.js";
export * from "./jcs.js";
export * from "./repository-review.js";
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
