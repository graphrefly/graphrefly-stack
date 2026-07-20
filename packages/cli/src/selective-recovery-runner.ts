import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	assertDagSelectiveRecoveryIntegrity,
	createStrictAjv,
	DAG_SELECTIVE_RECOVERY_ARTIFACTS_SCHEMA,
	DAG_SELECTIVE_RECOVERY_BUNDLE_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import { projectSelectiveRecoveryTopologyV1 } from "@graphrefly-stack/core";

import { discoverPlanQualifiedGitDag } from "./dag-discovery.js";
import { createDagGraphEvidenceForSemanticGate } from "./dag-evidence.js";
import {
	createDagSemanticGateForSelectiveRecovery,
	type DagSemanticGateBundle,
	readDagGateBundle,
} from "./dag-semantic-runner.js";
import { repositoryStateDirectory } from "./repository-review-state.js";
import { runtimeAssetPath } from "./runtime-paths.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export class SelectiveRecoveryRunnerError extends Error {
	constructor(
		readonly code:
			| "RECOVERY_SOURCE_INVALID"
			| "RECOVERY_ARTIFACT_INVALID"
			| "RECOVERY_GATE_INVALID"
			| "RECOVERY_CONTRACT_INVALID"
			| "LOCAL_STATE_INVALID",
		message: string,
	) {
		super(message);
		this.name = "SelectiveRecoveryRunnerError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_ARTIFACT_INVALID",
			`${label} must be an object`,
		);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_ARTIFACT_INVALID",
			`${label} must be an array`,
		);
	}
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_ARTIFACT_INVALID",
			`${label} must be a string array`,
		);
	}
	return value;
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function gitJson(repository: string, revision: string, path: string): JsonObject {
	const result = spawnSync("git", ["-C", repository, "show", `${revision}:${path}`], {
		encoding: "utf8",
		shell: false,
	});
	if (result.status !== 0) {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_ARTIFACT_INVALID",
			`Accepted artifact is missing at ${revision}:${path}`,
		);
	}
	try {
		return object(JSON.parse(result.stdout), path);
	} catch {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_ARTIFACT_INVALID",
			`Accepted artifact is malformed at ${revision}:${path}`,
		);
	}
}

function exactGateBundle(run: JsonObject): DagSemanticGateBundle {
	if (run.schema !== "graphrefly.stack.dag-gate-bundle.v2") {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_GATE_INVALID",
			"Selective recovery requires an ordinary replacement DAG gate bundle",
		);
	}
	return {
		schema: "graphrefly.stack.dag-gate-bundle.v2",
		topology: object(run.topology, "replacement topology"),
		dependencyGraph: object(run.dependencyGraph, "replacement dependency graph"),
		bindings: objects(run.bindings, "replacement bindings"),
		records: objects(run.records, "replacement records"),
		unitEvaluations: objects(run.unitEvaluations, "replacement unit evaluations"),
		joinEvaluations: objects(run.joinEvaluations, "replacement join evaluations"),
		gateInput: object(run.gateInput, "replacement GateInput"),
		gateResult: object(run.gateResult, "replacement GateResult"),
	};
}

async function validateBundle(bundle: JsonObject): Promise<void> {
	const paths = [
		"contracts/semantic/v1/artifacts.schema.json",
		"contracts/dag/v2/artifacts.schema.json",
		"contracts/dag/v2/semantic.schema.json",
		"contracts/dag/v2/merge-group.schema.json",
		"contracts/dag/v2/selective-recovery.schema.json",
	];
	const schemas = await Promise.all(
		paths.map(async (path) => JSON.parse(await readFile(runtimeAssetPath(path), "utf8"))),
	);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	const validate = ajv.getSchema(
		`${DAG_SELECTIVE_RECOVERY_ARTIFACTS_SCHEMA}#/definitions/DagSelectiveRecoveryBundle`,
	);
	if (validate === undefined || !validate(bundle)) {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_CONTRACT_INVALID",
			`Selective recovery bundle: ${JSON.stringify(validate?.errors)}`,
		);
	}
	try {
		assertDagSelectiveRecoveryIntegrity(bundle);
	} catch (error) {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_CONTRACT_INVALID",
			error instanceof Error ? error.message : "Selective recovery integrity failed",
		);
	}
}

async function persistBundle(
	repository: string,
	replacementPlanId: string,
	bundle: JsonObject,
): Promise<{ path: string; digest: Hash }> {
	const digest = hash(bundle);
	const directory = await repositoryStateDirectory(
		repository,
		"dag-selective-recoveries",
		replacementPlanId,
	);
	const path = resolve(directory, `${digest.value}.json`);
	try {
		await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let existing: unknown;
		try {
			existing = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new SelectiveRecoveryRunnerError(
				"LOCAL_STATE_INVALID",
				"Existing selective recovery bundle is malformed",
			);
		}
		if (sha256Jcs(existing) !== digest.value || sha256Jcs(existing) !== sha256Jcs(bundle)) {
			throw new SelectiveRecoveryRunnerError(
				"LOCAL_STATE_INVALID",
				"Existing selective recovery bundle violates its content address",
			);
		}
	}
	return { path, digest };
}

export async function createDagSelectiveRecovery(options: {
	repository: string;
	base?: string;
	head: string;
	sourcePlanId: string;
	replacementPlanId: string;
	sourceBundleDigest: string;
	repositoryIdentity: { provider: string; owner: string; name: string };
}) {
	const sourceBundle = await readDagGateBundle(
		options.repository,
		options.sourcePlanId,
		options.sourceBundleDigest,
	);
	if (object(sourceBundle.gateResult, "source GateResult").verdict !== "blocked") {
		throw new SelectiveRecoveryRunnerError(
			"RECOVERY_SOURCE_INVALID",
			"Selective recovery requires a blocked source DAG gate",
		);
	}
	const sourceTopology = object(sourceBundle.topology, "source topology");
	const base = String(object(sourceTopology.base, "source base").value);
	const sourceHead = String(object(sourceTopology.head, "source head").value);
	if (options.base !== undefined) {
		const resolved = spawnSync(
			"git",
			["-C", options.repository, "rev-parse", "--verify", `${options.base}^{commit}`],
			{
				encoding: "utf8",
				shell: false,
			},
		);
		if (resolved.status !== 0 || resolved.stdout.trim() !== base) {
			throw new SelectiveRecoveryRunnerError(
				"RECOVERY_SOURCE_INVALID",
				"Requested base does not match the blocked source bundle",
			);
		}
	}
	const graphEvidence = await createDagGraphEvidenceForSemanticGate({
		repository: options.repository,
		base,
		head: options.head,
		repositoryIdentity: options.repositoryIdentity,
	});
	const resolvedHead = String(object(graphEvidence.topology.head, "recovery head").value);
	const qualified = await discoverPlanQualifiedGitDag({
		repository: options.repository,
		base,
		head: resolvedHead,
	});
	const sourcePlan = gitJson(
		options.repository,
		sourceHead,
		`.graphrefly-stack/plans/${options.sourcePlanId}.json`,
	);
	const replacementPlan = gitJson(
		options.repository,
		resolvedHead,
		`.graphrefly-stack/plans/${options.replacementPlanId}.json`,
	);
	const selectiveReplan = gitJson(
		options.repository,
		resolvedHead,
		`.graphrefly-stack/plans/${options.replacementPlanId}.replan.json`,
	);
	const policy = gitJson(options.repository, resolvedHead, ".graphrefly-stack/policy.json");
	const preservedUnits = strings(selectiveReplan.preservedUnits, "preserved units");
	const invalidUnits = strings(selectiveReplan.invalidUnits, "invalid units");
	const effectiveTopology = projectSelectiveRecoveryTopologyV1({
		topology: graphEvidence.topology,
		qualifiedCommits: qualified.qualifiedCommits,
		sourcePlanId: options.sourcePlanId,
		replacementPlanId: options.replacementPlanId,
		preservedUnits,
		invalidUnits,
	});
	const replacementRun = await createDagSemanticGateForSelectiveRecovery({
		repository: options.repository,
		base,
		head: resolvedHead,
		planId: options.replacementPlanId,
		repositoryIdentity: options.repositoryIdentity,
		graphEvidence: { ...graphEvidence, topology: effectiveTopology },
		selectiveRecovery: {
			sourcePlanId: options.sourcePlanId,
			sourceHead,
			preservedUnits,
			qualifiedCommits: qualified.qualifiedCommits,
		},
	});
	const replacementBundle = exactGateBundle(replacementRun as unknown as JsonObject);
	const sourceBindings = new Map(
		sourceBundle.bindings.map((entry) => [String(entry.workUnitId), entry]),
	);
	const sourceRecords = new Map(
		sourceBundle.records.map((entry) => [String(entry.workUnitId), entry]),
	);
	const replacementBindings = new Map(
		replacementBundle.bindings.map((entry) => [String(entry.workUnitId), entry]),
	);
	const replacementRecords = new Map(
		replacementBundle.records.map((entry) => [String(entry.workUnitId), entry]),
	);
	const invalid = new Set(invalidUnits);
	const lineage = objects(sourcePlan.workUnits, "source WorkUnits").map((unit) => {
		const workUnitId = String(unit.id);
		const sourceBinding = sourceBindings.get(workUnitId);
		const sourceRecord = sourceRecords.get(workUnitId);
		const replacementBinding = replacementBindings.get(workUnitId);
		const replacementRecord = replacementRecords.get(workUnitId);
		if (!sourceBinding || !sourceRecord || !replacementBinding || !replacementRecord) {
			throw new SelectiveRecoveryRunnerError(
				"RECOVERY_GATE_INVALID",
				`Recovery lineage is missing ${workUnitId}`,
			);
		}
		return {
			workUnitId,
			disposition: invalid.has(workUnitId) ? "replaced" : "preserved",
			sourcePlanId: options.sourcePlanId,
			replacementPlanId: options.replacementPlanId,
			sourceBindingDigest: hash(sourceBinding),
			sourceRecordDigest: hash(sourceRecord),
			replacementBindingDigest: hash(replacementBinding),
			replacementRecordDigest: hash(replacementRecord),
		};
	});
	const bundle: JsonObject = {
		schema: DAG_SELECTIVE_RECOVERY_BUNDLE_SCHEMA,
		sourceBundle,
		sourceBundleDigest: hash(sourceBundle),
		sourcePlan,
		selectiveReplan,
		replacementPlan,
		policy,
		sharedTopology: graphEvidence.topology,
		qualifiedCommits: qualified.qualifiedCommits,
		effectiveTopology,
		replacementBundle,
		lineage,
	};
	await validateBundle(bundle);
	const artifact = await persistBundle(options.repository, options.replacementPlanId, bundle);
	return { ...bundle, artifact };
}
