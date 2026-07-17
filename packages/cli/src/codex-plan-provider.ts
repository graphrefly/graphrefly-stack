import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createStrictAjv, sha256Jcs } from "@graphrefly-stack/contracts";
import { Codex, type ModelReasoningEffort, type Usage } from "@openai/codex-sdk";

import type { RuntimeSuite } from "./fixture.js";
import { runtimeAssetPath, runtimeStateRoot } from "./runtime-paths.js";

const stateRoot = runtimeStateRoot();
const artifactsSchemaPath = runtimeAssetPath("contracts/v1/schemas/artifacts.schema.json");
const planProposalSchemaPath = runtimeAssetPath("contracts/v1/schemas/plan-proposal.schema.json");
const replanProposalSchemaPath = runtimeAssetPath(
	"contracts/v1/schemas/replan-proposal.schema.json",
);
const rawResponseRoot = resolve(stateRoot, ".private/live-responses");
const liveRunRoot = resolve(stateRoot, ".private/live-runs");
const CODEX_SDK_VERSION = "0.143.0";

interface ProposalWorkUnit {
	id: string;
	title: string;
	intent: string;
	dependencies: string[];
	allowedSourceScopes: string[];
	blueprintClaims: { id: string; statement: string }[];
	requiredChecks: string[];
}

interface PlanProposal {
	schema: "urn:graphrefly-stack:schema:plan-proposal:v1";
	workUnits: ProposalWorkUnit[];
}

interface ReplanProposal {
	schema: "urn:graphrefly-stack:schema:replan-proposal:v1";
	inputUnits: string[];
	preservedUnits: string[];
	workUnits: ProposalWorkUnit[];
}

export interface CodexRunRequest {
	prompt: string;
	outputSchema: object;
	workingDirectory: string;
	model: string;
	reasoningEffort: ModelReasoningEffort;
}

export interface CodexRunResponse {
	finalResponse: string;
	threadId: string | null;
	usage: Usage | null;
	runtime?: { source: "sdk-bundled" | "override"; version: string | null };
}

export interface CodexRunner {
	run(request: CodexRunRequest): Promise<CodexRunResponse>;
}

function scrubbedCodexEnvironment(): Record<string, string> {
	const names = ["PATH", "HOME", "CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY"];
	return Object.fromEntries(
		names.flatMap((name) => {
			const value = process.env[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
}

export class SdkCodexRunner implements CodexRunner {
	async run(request: CodexRunRequest): Promise<CodexRunResponse> {
		const codexPathOverride = process.env.GRAPHREFLY_STACK_CODEX_PATH;
		const environment = scrubbedCodexEnvironment();
		const codex = new Codex({ env: environment, codexPathOverride });
		const thread = codex.startThread({
			model: request.model,
			modelReasoningEffort: request.reasoningEffort,
			sandboxMode: "read-only",
			approvalPolicy: "never",
			workingDirectory: request.workingDirectory,
			networkAccessEnabled: false,
			webSearchMode: "disabled",
		});
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 120_000);
		try {
			const result = await thread.run(request.prompt, {
				outputSchema: request.outputSchema,
				signal: controller.signal,
			});
			const version = codexPathOverride
				? spawnSync(codexPathOverride, ["--version"], {
						encoding: "utf8",
						env: environment,
						shell: false,
					}).stdout.trim() || null
				: null;
			return {
				finalResponse: result.finalResponse,
				threadId: thread.id,
				usage: result.usage,
				runtime: { source: codexPathOverride ? "override" : "sdk-bundled", version },
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}

function stableAnchor(unit: ProposalWorkUnit) {
	return {
		id: unit.id,
		dependencies: unit.dependencies,
		allowedSourceScopes: unit.allowedSourceScopes,
		blueprintClaimIds: unit.blueprintClaims.map((claim) => claim.id),
		requiredChecks: unit.requiredChecks,
	};
}

function validateAnchors(proposed: ProposalWorkUnit[], canonical: ProposalWorkUnit[]): void {
	if (sha256Jcs(proposed.map(stableAnchor)) !== sha256Jcs(canonical.map(stableAnchor))) {
		throw new Error(
			"Codex proposal changed locked work-unit IDs, scope, dependencies, claims, or checks",
		);
	}
}

async function schemas(kind: "plan" | "replan") {
	const artifacts = JSON.parse(await readFile(artifactsSchemaPath, "utf8")) as Record<
		string,
		unknown
	>;
	const proposal = JSON.parse(
		await readFile(kind === "plan" ? planProposalSchemaPath : replanProposalSchemaPath, "utf8"),
	) as Record<string, unknown>;
	const sdkSchema = structuredClone(proposal);
	sdkSchema.definitions = {
		RepoPath: (artifacts.definitions as Record<string, unknown>).RepoPath,
		WorkUnit: (artifacts.definitions as Record<string, unknown>).WorkUnit,
	};
	((sdkSchema.properties as Record<string, unknown>).workUnits as Record<string, unknown>).items = {
		$ref: "#/definitions/WorkUnit",
	};
	const removeUnsupportedKeywords = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) removeUnsupportedKeywords(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const record = value as Record<string, unknown>;
		delete record.uniqueItems;
		delete record.pattern;
		if (record.const !== undefined && record.type === undefined) {
			record.type = typeof record.const;
		}
		for (const child of Object.values(record)) removeUnsupportedKeywords(child);
	};
	removeUnsupportedKeywords(sdkSchema);
	return { artifacts, proposal, sdkSchema };
}

function effectiveReasoningEffort(): ModelReasoningEffort {
	const value = process.env.GRAPHREFLY_STACK_REASONING_EFFORT ?? "high";
	if (!["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
		throw new Error(`Unsupported GRAPHREFLY_STACK_REASONING_EFFORT: ${value}`);
	}
	return value as ModelReasoningEffort;
}

async function persistRawResponse(
	kind: "plan" | "replan",
	response: CodexRunResponse,
): Promise<string> {
	const digest = createHash("sha256").update(response.finalResponse, "utf8").digest("hex");
	await mkdir(rawResponseRoot, { recursive: true });
	await writeFile(
		resolve(rawResponseRoot, `${kind}-${digest}.json`),
		`${JSON.stringify(response, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	return digest;
}

function provenance(
	kind: "plan" | "replan",
	model: string,
	reasoningEffort: ModelReasoningEffort,
	response: CodexRunResponse,
	responseDigest: string,
) {
	return {
		provider: "codex-sdk",
		codexSdkVersion: CODEX_SDK_VERSION,
		model,
		reasoningEffort,
		promptVersion: `stack.${kind}.v1`,
		threadId: response.threadId,
		codexRuntime: response.runtime ?? { source: "sdk-bundled", version: null },
		usage: response.usage,
		responseDigest: { algorithm: "sha256", value: responseDigest },
	};
}

async function persistLiveRun(
	kind: "plan" | "replan",
	output: unknown,
	provenanceValue: ReturnType<typeof provenance>,
) {
	const record = {
		schema: "urn:graphrefly-stack:live-run:v1",
		kind,
		mode: "live",
		output,
		provenance: provenanceValue,
	};
	await mkdir(liveRunRoot, { recursive: true });
	const path = resolve(liveRunRoot, `${kind}-${provenanceValue.responseDigest.value}.json`);
	await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return path;
}

export async function runLivePlan(
	runtime: RuntimeSuite,
	runner: CodexRunner = new SdkCodexRunner(),
) {
	const { artifacts, proposal, sdkSchema } = await schemas("plan");
	const model = process.env.GRAPHREFLY_STACK_MODEL ?? "gpt-5.6-sol";
	const reasoningEffort = effectiveReasoningEffort();
	const prompt = [
		"You are proposing a ChangePlan only. Do not edit files or decide gate validity.",
		"Preserve the supplied locked work-unit IDs, dependencies, source scopes, claim IDs, and checks exactly.",
		"You may improve only titles, intent wording, and claim statements. Return only schema-valid JSON.",
		`Task: ${JSON.stringify(runtime.task)}`,
		`Locked plan: ${JSON.stringify(runtime.changePlan)}`,
	].join("\n");
	const response = await runner.run({
		prompt,
		outputSchema: sdkSchema,
		workingDirectory: runtime.repository,
		model,
		reasoningEffort,
	});
	const parsed = JSON.parse(response.finalResponse) as PlanProposal;
	const ajv = createStrictAjv();
	ajv.addSchema(artifacts);
	const validateProposal = ajv.compile(proposal);
	if (!validateProposal(parsed))
		throw new Error(`Codex plan proposal invalid: ${JSON.stringify(validateProposal.errors)}`);
	const canonicalUnits = runtime.changePlan.workUnits as ProposalWorkUnit[];
	validateAnchors(parsed.workUnits, canonicalUnits);
	const output = { ...runtime.changePlan, source: "codex", workUnits: parsed.workUnits };
	const validatePlan = ajv.getSchema(
		"urn:graphrefly-stack:schema:artifacts:v1#/definitions/ChangePlan",
	);
	if (validatePlan === undefined || !validatePlan(output)) {
		throw new Error(`Bound ChangePlan invalid: ${JSON.stringify(validatePlan?.errors)}`);
	}
	const responseDigest = await persistRawResponse("plan", response);
	const provenanceValue = {
		...provenance("plan", model, reasoningEffort, response, responseDigest),
		outputDigest: { algorithm: "sha256" as const, value: sha256Jcs(output) },
	};
	const runArtifact = await persistLiveRun("plan", output, provenanceValue);
	return { output, provenance: provenanceValue, runArtifact };
}

export async function runLiveReplan(
	runtime: RuntimeSuite,
	runner: CodexRunner = new SdkCodexRunner(),
) {
	const { artifacts, proposal, sdkSchema } = await schemas("replan");
	const model = process.env.GRAPHREFLY_STACK_MODEL ?? "gpt-5.6-sol";
	const reasoningEffort = effectiveReasoningEffort();
	const stale = runtime.cases.find(
		(fixtureCase) => fixtureCase.caseId === "clean-rebase-semantic-stale",
	);
	if (stale === undefined) throw new Error("Stale flagship case is missing");
	const canonicalUnits = (runtime.changePlan.workUnits as ProposalWorkUnit[]).filter((unit) =>
		["U2", "U3"].includes(unit.id),
	);
	const prompt = [
		"Selectively replan only U2 and U3. Preserve U1. Do not edit files or decide gate validity.",
		"Preserve supplied IDs, dependencies, source scopes, claim IDs, and checks exactly.",
		"Update wording to reflect the sessionMutationBroker policy. Return only schema-valid JSON.",
		`Blocked GateResult: ${JSON.stringify(stale.expected)}`,
		`Blueprint delta: ${JSON.stringify(stale.input.delta)}`,
		`Current policy revision: ${stale.input.snapshot.policyRevision}`,
		`Locked U2/U3: ${JSON.stringify(canonicalUnits)}`,
	].join("\n");
	const response = await runner.run({
		prompt,
		outputSchema: sdkSchema,
		workingDirectory: runtime.repository,
		model,
		reasoningEffort,
	});
	const parsed = JSON.parse(response.finalResponse) as ReplanProposal;
	const ajv = createStrictAjv();
	ajv.addSchema(artifacts);
	const validateProposal = ajv.compile(proposal);
	if (!validateProposal(parsed))
		throw new Error(`Codex replan proposal invalid: ${JSON.stringify(validateProposal.errors)}`);
	if (
		sha256Jcs(parsed.inputUnits) !== sha256Jcs(["U2", "U3"]) ||
		sha256Jcs(parsed.preservedUnits) !== sha256Jcs(["U1"])
	) {
		throw new Error("Codex replan changed the locked selective invalidation boundary");
	}
	validateAnchors(parsed.workUnits, canonicalUnits);
	const u2Claim = parsed.workUnits
		.find((unit) => unit.id === "U2")
		?.blueprintClaims.find((claim) => claim.id === "session-write-path")?.statement;
	if (
		u2Claim === undefined ||
		!u2Claim.includes("sessionMutationBroker") ||
		!u2Claim.includes(stale.input.snapshot.policyRevision)
	) {
		throw new Error("Codex replan did not bind U2 to the current broker policy revision");
	}
	const responseDigest = await persistRawResponse("replan", response);
	const output = { ...runtime.selectiveReplan, proposedWorkUnits: parsed.workUnits };
	const provenanceValue = {
		...provenance("replan", model, reasoningEffort, response, responseDigest),
		outputDigest: { algorithm: "sha256" as const, value: sha256Jcs(output) },
	};
	const runArtifact = await persistLiveRun("replan", output, provenanceValue);
	return { output, provenance: provenanceValue, runArtifact };
}

export function replayFallback(kind: "plan" | "replan", runtime: RuntimeSuite, error: unknown) {
	const output = kind === "plan" ? runtime.changePlan : runtime.selectiveReplan;
	return {
		output,
		provenance: {
			provider: "replay",
			promptVersion: `stack.${kind}.v1`,
			replayArtifactDigest: { algorithm: "sha256", value: sha256Jcs(output) },
			fallbackReason: redactProviderError(error),
		},
	};
}

export function redactProviderError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.replaceAll(stateRoot, "<workspace>")
		.replaceAll(homedir(), "<home>")
		.replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/g, "<redacted-credential>")
		.slice(0, 400);
}
