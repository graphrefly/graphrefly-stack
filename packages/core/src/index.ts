import { createHash } from "node:crypto";
import { canonicalTopologyBytes, GRAPH_BLUEPRINT_VERSION } from "@graphrefly/ts/graph";
import type { ExecutionMode } from "@graphrefly-stack/contracts";

export * from "./gate.js";
export * from "./integration-effects.js";

export const CORE_ARCHITECTURE = {
	version: "D17",
	canonicalCommands: ["init", "fixture create", "plan", "gate", "replan", "review", "export"],
	defaultPlanMode: "replay",
	graphreflyBlueprintVersion: GRAPH_BLUEPRINT_VERSION,
	processModel: "single-local-cli-process",
} as const;

export interface GitOid {
	algorithm: "sha1" | "sha256";
	value: string;
}

export interface GitAdapter {
	resolveCommit(repository: string, revision: string): Promise<GitOid>;
	changedPaths(repository: string, commit: GitOid): Promise<readonly string[]>;
	canonicalDiff(repository: string, commit: GitOid): Promise<Uint8Array>;
}

export interface BlueprintProviderRequest {
	repository: string;
	commit: GitOid;
}

export interface BlueprintProvider {
	id: "graphrefly";
	version: string;
	snapshot(request: BlueprintProviderRequest): Promise<unknown>;
	delta(base: unknown, current: unknown): Promise<unknown>;
}

export interface PlanRequest {
	mode: Exclude<ExecutionMode, "deterministic">;
	task: unknown;
	repository: string;
}

export interface PlanProvider {
	id: "replay" | "codex";
	propose(request: PlanRequest): Promise<unknown>;
}

export function graphreflyTopologyHash(topology: unknown): string {
	return createHash("sha256")
		.update(canonicalTopologyBytes(topology as Parameters<typeof canonicalTopologyBytes>[0]))
		.digest("hex");
}
