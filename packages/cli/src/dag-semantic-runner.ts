import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	assertDagSemanticIntegrity,
	assertDagStructuralErrorBundleIntegrity,
	assertDagStructuralErrorIntegrity,
	canonicalize,
	createStrictAjv,
	DAG_GATE_BUNDLE_SCHEMA,
	DAG_SEMANTIC_ARTIFACTS_SCHEMA,
	DAG_STRUCTURAL_ERROR_BUNDLE_SCHEMA,
	DAG_STRUCTURAL_ERROR_INPUT_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import {
	computeDagGateV2,
	computeDagStructuralErrorV2,
	diagnoseDagDependenciesV2,
} from "@graphrefly-stack/core";

import { createDagGraphEvidenceForSemanticGate, type DagGraphEvidence } from "./dag-evidence.js";
import { repositoryStateDirectory } from "./repository-review-state.js";
import { runtimeAssetPath } from "./runtime-paths.js";
import { evaluateSemanticPredicate, runRepositoryPolicyChecks } from "./semantic-repository.js";
import { gitText, SystemGitAdapter } from "./system-git.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export class DagSemanticRunnerError extends Error {
	constructor(
		readonly code:
			| "ACCEPTED_ARTIFACT_INVALID"
			| "PLAN_BASE_MISMATCH"
			| "POLICY_MISMATCH"
			| "WORK_UNIT_SET_MISMATCH"
			| "DEPENDENCY_MISSING"
			| "DEPENDENCY_CYCLE"
			| "BINDING_INVALID"
			| "CONTRACT_INVALID"
			| "RECOVERY_EVIDENCE_INVALID"
			| "LOCAL_STATE_INVALID",
		message: string,
	) {
		super(message);
		this.name = "DagSemanticRunnerError";
	}
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagSemanticRunnerError("ACCEPTED_ARTIFACT_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) {
		throw new DagSemanticRunnerError("ACCEPTED_ARTIFACT_INVALID", `${label} must be an array`);
	}
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown): string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function gitJson(repository: string, revision: string, path: string): JsonObject {
	try {
		return object(JSON.parse(gitText(repository, ["show", `${revision}:${path}`])), path);
	} catch {
		throw new DagSemanticRunnerError(
			"ACCEPTED_ARTIFACT_INVALID",
			`Invalid accepted artifact ${revision}:${path}`,
		);
	}
}

function gitHasPath(repository: string, revision: string, path: string): boolean {
	return (
		spawnSync("git", ["-C", repository, "cat-file", "-e", `${revision}:${path}`], {
			encoding: "utf8",
			shell: false,
		}).status === 0
	);
}

function gitIsAncestor(repository: string, ancestor: string, descendant: string): boolean {
	return (
		spawnSync("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, descendant], {
			encoding: "utf8",
			shell: false,
		}).status === 0
	);
}

function canonicalWorkUnitOrder(units: readonly JsonObject[]): string[] {
	const byId = new Map<string, JsonObject>();
	for (const unit of units) {
		const id = unit.id;
		if (typeof id !== "string" || byId.has(id)) {
			throw new DagSemanticRunnerError("WORK_UNIT_SET_MISMATCH", "WorkUnit IDs are not unique");
		}
		byId.set(id, unit);
	}
	for (const [id, unit] of byId) {
		for (const dependency of strings(unit.dependencies)) {
			if (!byId.has(dependency)) {
				throw new DagSemanticRunnerError(
					"DEPENDENCY_MISSING",
					`${id} depends on missing WorkUnit ${dependency}`,
				);
			}
		}
	}
	const result: string[] = [];
	const remaining = new Set(byId.keys());
	while (remaining.size > 0) {
		const next = [...remaining]
			.filter((id) =>
				strings(byId.get(id)?.dependencies).every((dependency) => result.includes(dependency)),
			)
			.sort()[0];
		if (next === undefined) {
			throw new DagSemanticRunnerError("DEPENDENCY_CYCLE", "Semantic dependency graph is cyclic");
		}
		result.push(next);
		remaining.delete(next);
	}
	return result;
}

function withinScope(path: string, scopes: readonly string[]): boolean {
	return scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

async function validators() {
	const [v1, topology, semantic] = await Promise.all([
		readFile(runtimeAssetPath("contracts/semantic/v1/artifacts.schema.json"), "utf8"),
		readFile(runtimeAssetPath("contracts/dag/v2/artifacts.schema.json"), "utf8"),
		readFile(runtimeAssetPath("contracts/dag/v2/semantic.schema.json"), "utf8"),
	]);
	const ajv = createStrictAjv();
	ajv.addSchema(JSON.parse(v1));
	ajv.addSchema(JSON.parse(topology));
	ajv.addSchema(JSON.parse(semantic));
	return (name: string) => {
		const validate = ajv.getSchema(`${DAG_SEMANTIC_ARTIFACTS_SCHEMA}#/definitions/${name}`);
		if (validate === undefined) {
			throw new DagSemanticRunnerError("CONTRACT_INVALID", `Missing DAG semantic schema ${name}`);
		}
		return validate;
	};
}

function assertValid(
	validate: ReturnType<Awaited<ReturnType<typeof validators>>>,
	value: unknown,
	label: string,
): void {
	if (!validate(value)) {
		throw new DagSemanticRunnerError(
			"CONTRACT_INVALID",
			`${label}: ${JSON.stringify(validate.errors)}`,
		);
	}
}

export type DagSemanticGateBundle = {
	schema: typeof DAG_GATE_BUNDLE_SCHEMA;
	topology: JsonObject;
	dependencyGraph: JsonObject;
	bindings: JsonObject[];
	records: JsonObject[];
	unitEvaluations: JsonObject[];
	joinEvaluations: JsonObject[];
	gateInput: JsonObject;
	gateResult: JsonObject;
};

type DagRecovery = {
	kind: "rebase" | "cherry-pick";
	priorBundleDigest: string;
};

type DagSelectiveRecoveryContext = {
	sourcePlanId: string;
	sourceHead: string;
	preservedUnits: string[];
	qualifiedCommits: JsonObject[];
};

type DagCacheReport = {
	priorBundleDigest: string | null;
	units: Array<{
		workUnitId: string;
		binding: "fresh" | "reused" | "rebound";
		record: "recomputed" | "reused";
	}>;
};

export type DagSemanticGateRun = DagSemanticGateBundle & {
	artifact: { path: string; digest: Hash };
	cache: DagCacheReport;
};

export type DagStructuralErrorBundle = {
	schema: typeof DAG_STRUCTURAL_ERROR_BUNDLE_SCHEMA;
	topology: JsonObject;
	dependencyGraph: JsonObject;
	plan: JsonObject;
	policy: JsonObject;
	bindings: JsonObject[];
	errorInput: JsonObject;
	gateResult: JsonObject;
};

export type DagStructuralErrorRun = DagStructuralErrorBundle & {
	artifact: { path: string; digest: Hash };
};

async function assertBundle(
	value: unknown,
	code: "CONTRACT_INVALID" | "RECOVERY_EVIDENCE_INVALID",
): Promise<DagSemanticGateBundle> {
	try {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("DAG gate bundle must be an object");
		}
		const bundle = value as JsonObject;
		if (bundle.schema !== DAG_GATE_BUNDLE_SCHEMA) {
			throw new Error("DAG gate bundle shape is unsupported");
		}
		const definition = await validators();
		assertValid(definition("DagGateBundle"), bundle, "DAG gate bundle");
		for (const [name, values] of [
			["SemanticDependencyGraph", [bundle.dependencyGraph]],
			["WorkUnitBinding", bundle.bindings],
			["SemanticChangeRecord", bundle.records],
			["UnitEvaluationEvidence", bundle.unitEvaluations],
			["JoinEvaluationEvidence", bundle.joinEvaluations],
			["DagGateInput", [bundle.gateInput]],
			["DagGateResult", [bundle.gateResult]],
		] as const) {
			const validate = definition(name);
			for (const entry of Array.isArray(values) ? values : []) {
				assertValid(validate, entry, name);
			}
		}
		assertDagSemanticIntegrity({
			topology: bundle.topology,
			dependencyGraph: bundle.dependencyGraph,
			bindings: bundle.bindings,
			records: bundle.records,
			unitEvaluations: bundle.unitEvaluations,
			joinEvaluations: bundle.joinEvaluations,
			gateInput: bundle.gateInput,
			gateResult: bundle.gateResult,
		});
		return bundle as DagSemanticGateBundle;
	} catch (error) {
		if (error instanceof DagSemanticRunnerError && error.code === code) throw error;
		throw new DagSemanticRunnerError(
			code,
			error instanceof Error ? error.message : "Invalid DAG bundle",
		);
	}
}

export async function readDagGateBundle(
	repository: string,
	planId: string,
	digest: string,
): Promise<DagSemanticGateBundle> {
	if (!/^[0-9a-f]{64}$/u.test(digest)) {
		throw new DagSemanticRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Prior DAG bundle digest is invalid",
		);
	}
	const directory = await repositoryStateDirectory(repository, "dag-gates", planId);
	const path = resolve(directory, `${digest}.json`);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new DagSemanticRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Prior DAG bundle is missing or malformed",
		);
	}
	if (sha256Jcs(value) !== digest) {
		throw new DagSemanticRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Prior DAG bundle content address does not match",
		);
	}
	return assertBundle(value, "RECOVERY_EVIDENCE_INVALID");
}

async function readPriorBundle(
	repository: string,
	planId: string,
	recovery: DagRecovery,
): Promise<DagSemanticGateBundle> {
	return readDagGateBundle(repository, planId, recovery.priorBundleDigest);
}

async function persistBundle(
	repository: string,
	planId: string,
	bundle: DagSemanticGateBundle,
): Promise<{ path: string; digest: Hash }> {
	const directory = await repositoryStateDirectory(repository, "dag-gates", planId);
	const digest = hash(bundle);
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
			throw new DagSemanticRunnerError("LOCAL_STATE_INVALID", "Existing DAG bundle is malformed");
		}
		if (sha256Jcs(existing) !== digest.value || sha256Jcs(existing) !== sha256Jcs(bundle)) {
			throw new DagSemanticRunnerError(
				"LOCAL_STATE_INVALID",
				"Existing DAG bundle violates its content address",
			);
		}
	}
	return { path, digest };
}

async function persistStructuralErrorBundle(
	repository: string,
	planId: string,
	bundle: DagStructuralErrorBundle,
): Promise<{ path: string; digest: Hash }> {
	const directory = await repositoryStateDirectory(repository, "dag-gate-errors", planId);
	const digest = hash(bundle);
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
			throw new DagSemanticRunnerError(
				"LOCAL_STATE_INVALID",
				"Existing DAG structural error bundle is malformed",
			);
		}
		if (sha256Jcs(existing) !== digest.value || sha256Jcs(existing) !== sha256Jcs(bundle)) {
			throw new DagSemanticRunnerError(
				"LOCAL_STATE_INVALID",
				"Existing DAG structural error bundle violates its content address",
			);
		}
	}
	return { path, digest };
}

async function createDagSemanticGateInternal(options: {
	repository: string;
	base: string;
	head: string;
	planId: string;
	repositoryIdentity: { provider: string; owner: string; name: string };
	recovery?: DagRecovery;
	graphEvidence?: DagGraphEvidence;
	selectiveRecovery?: DagSelectiveRecoveryContext;
}): Promise<
	DagSemanticGateRun | DagStructuralErrorRun | DagSemanticGateBundle | DagStructuralErrorBundle
> {
	const graphEvidence =
		options.graphEvidence ?? (await createDagGraphEvidenceForSemanticGate(options));
	const topology = graphEvidence.topology;
	const git = new SystemGitAdapter();
	const resolvedHead = object(topology.head, "topology head").value as string;
	const planPath = `.graphrefly-stack/plans/${options.planId}.json`;
	const replanPath = `.graphrefly-stack/plans/${options.planId}.replan.json`;
	const policyPath = ".graphrefly-stack/policy.json";
	const plan = gitJson(options.repository, resolvedHead, planPath);
	const policy = gitJson(options.repository, resolvedHead, policyPath);
	const selectiveReplan =
		options.selectiveRecovery === undefined
			? undefined
			: gitJson(options.repository, resolvedHead, replanPath);
	const semanticV1 = JSON.parse(
		await readFile(runtimeAssetPath("contracts/semantic/v1/artifacts.schema.json"), "utf8"),
	);
	const v1Ajv = createStrictAjv();
	v1Ajv.addSchema(semanticV1);
	const acceptedArtifacts: Array<readonly [string, JsonObject]> = [
		["AcceptedChangePlan", plan],
		["RepositoryPolicy", policy],
	];
	if (selectiveReplan !== undefined) {
		acceptedArtifacts.push(["SelectiveReplan", selectiveReplan]);
	}
	for (const [name, value] of acceptedArtifacts) {
		const validate = v1Ajv.getSchema(
			`urn:graphrefly-stack:schema:semantic-artifacts:v1#/definitions/${name}`,
		);
		if (validate === undefined || !validate(value)) {
			throw new DagSemanticRunnerError(
				"ACCEPTED_ARTIFACT_INVALID",
				`${name}: ${JSON.stringify(validate?.errors)}`,
			);
		}
	}
	if (plan.planId !== options.planId) {
		throw new DagSemanticRunnerError("ACCEPTED_ARTIFACT_INVALID", "Accepted plan ID changed");
	}
	const topologyBase = object(topology.base, "topology base").value as string;
	const topologyObjects = objects(topology.objects, "topology objects");
	const introductionCandidates = gitHasPath(options.repository, topologyBase, planPath)
		? [topologyBase]
		: topologyObjects
				.filter(
					(entry) =>
						gitHasPath(
							options.repository,
							object(entry.oid, "object OID").value as string,
							planPath,
						) &&
						objects(entry.parents, "object parents").every(
							(parent) => !gitHasPath(options.repository, parent.value as string, planPath),
						),
				)
				.map((entry) => object(entry.oid, "acceptance OID").value as string);
	if (introductionCandidates.length !== 1) {
		throw new DagSemanticRunnerError(
			"ACCEPTED_ARTIFACT_INVALID",
			"Accepted plan must have one exact introduction point",
		);
	}
	const acceptanceCommit = introductionCandidates[0] as string;
	const acceptanceEntry = topologyObjects.find(
		(entry) => object(entry.oid, "object OID").value === acceptanceCommit,
	);
	if (acceptanceEntry !== undefined && acceptanceEntry.kind !== "transport") {
		throw new DagSemanticRunnerError(
			"ACCEPTED_ARTIFACT_INVALID",
			"Accepted plan must enter through a transport-only commit",
		);
	}
	if (acceptanceEntry !== undefined) {
		const acceptanceOid = acceptanceEntry.oid as { algorithm: "sha1" | "sha256"; value: string };
		const changedPaths = await git.changedPaths(options.repository, acceptanceOid);
		const acceptedPaths = [...changedPaths].sort();
		const acceptedPathSet = new Set(acceptedPaths);
		const normalAcceptance =
			acceptedPaths.length >= 1 &&
			acceptedPaths.length <= 2 &&
			acceptedPaths[0] === planPath &&
			acceptedPaths.every((path) => path === planPath || path === policyPath);
		const selectiveAcceptance =
			options.selectiveRecovery !== undefined &&
			acceptedPaths.length >= 2 &&
			acceptedPaths.length <= 3 &&
			acceptedPathSet.has(planPath) &&
			acceptedPathSet.has(replanPath) &&
			acceptedPaths.every(
				(path) => path === planPath || path === replanPath || path === policyPath,
			);
		if (!normalAcceptance && !selectiveAcceptance) {
			throw new DagSemanticRunnerError(
				"ACCEPTED_ARTIFACT_INVALID",
				"Plan acceptance commit mixes non-plan changes",
			);
		}
	}
	for (const revision of [
		topologyBase,
		...topologyObjects.map((entry) => object(entry.oid, "OID").value as string),
	]) {
		const hasPlan = gitHasPath(options.repository, revision, planPath);
		const hasSelectiveReplan = gitHasPath(options.repository, revision, replanPath);
		if (
			hasPlan &&
			(!gitHasPath(options.repository, revision, policyPath) ||
				sha256Jcs(gitJson(options.repository, revision, planPath)) !== sha256Jcs(plan) ||
				sha256Jcs(gitJson(options.repository, revision, policyPath)) !== sha256Jcs(policy) ||
				(selectiveReplan !== undefined &&
					(!hasSelectiveReplan ||
						sha256Jcs(gitJson(options.repository, revision, replanPath)) !==
							sha256Jcs(selectiveReplan))))
		) {
			throw new DagSemanticRunnerError(
				"ACCEPTED_ARTIFACT_INVALID",
				`Accepted plan or policy changed at ${revision}`,
			);
		}
		if (selectiveReplan !== undefined && hasSelectiveReplan !== hasPlan) {
			throw new DagSemanticRunnerError(
				"ACCEPTED_ARTIFACT_INVALID",
				`Selective replan lifecycle changed at ${revision}`,
			);
		}
	}
	for (const entry of topologyObjects.filter((candidate) => candidate.kind === "implementation")) {
		const revision = object(entry.oid, "implementation OID").value as string;
		const owner = options.selectiveRecovery?.qualifiedCommits.find(
			(qualified) => object(qualified.commit, "qualified commit").value === revision,
		);
		const carriedSourceImplementation =
			options.selectiveRecovery !== undefined &&
			owner?.planId === options.selectiveRecovery.sourcePlanId &&
			options.selectiveRecovery.preservedUnits.includes(String(owner.workUnitId));
		if (
			!carriedSourceImplementation &&
			(!gitIsAncestor(options.repository, acceptanceCommit, revision) ||
				!gitHasPath(options.repository, revision, planPath))
		) {
			throw new DagSemanticRunnerError(
				"ACCEPTED_ARTIFACT_INVALID",
				`Implementation ${revision} does not descend from the accepted plan`,
			);
		}
	}
	const expectedBase = options.selectiveRecovery?.sourceHead ?? topologyBase;
	const expectedBaseBlueprint =
		options.selectiveRecovery === undefined
			? object(topology.baseBlueprintHash, "topology base Blueprint")
			: object(
					topologyObjects.find((entry) => object(entry.oid, "topology OID").value === expectedBase)
						?.blueprintHash,
					"selective recovery source head Blueprint",
				);
	if (
		(object(plan.baseCommit, "plan base").value as string) !== expectedBase ||
		!Object.is(
			object(plan.baseBlueprintHash, "plan base Blueprint").value,
			expectedBaseBlueprint.value,
		)
	) {
		throw new DagSemanticRunnerError(
			"PLAN_BASE_MISMATCH",
			"Accepted plan base does not match the DAG evidence base",
		);
	}
	const policyDigest = hash(policy);
	const planPolicy = object(plan.policy, "plan policy");
	if (
		planPolicy.policyId !== policy.policyId ||
		planPolicy.revision !== policy.revision ||
		object(planPolicy.digest, "plan policy digest").value !== policyDigest.value
	) {
		throw new DagSemanticRunnerError("POLICY_MISMATCH", "Accepted policy changed");
	}
	const policyCheckIds = objects(policy.checks, "policy checks").map((check) => check.id as string);
	if (new Set(policyCheckIds).size !== policyCheckIds.length) {
		throw new DagSemanticRunnerError(
			"ACCEPTED_ARTIFACT_INVALID",
			"Policy check IDs are duplicated",
		);
	}

	const units = objects(plan.workUnits, "plan WorkUnits");
	const allowedRoots = strings(policy.allowedSourceRoots);
	const allowedCapabilities = new Set(strings(policy.allowedCapabilities));
	const declaredChecks = new Set(policyCheckIds);
	for (const unit of units) {
		const workUnitId = unit.id as string;
		if (
			strings(unit.allowedSourceScopes).some((scope) => !withinScope(scope, allowedRoots)) ||
			strings(unit.capabilities).some((capability) => !allowedCapabilities.has(capability)) ||
			strings(unit.requiredChecks).some((checkId) => !declaredChecks.has(checkId))
		) {
			throw new DagSemanticRunnerError(
				"ACCEPTED_ARTIFACT_INVALID",
				`${workUnitId} exceeds the accepted repository policy`,
			);
		}
		const claimIds = objects(unit.claims, `${workUnitId} claims`).map(
			(claim) => claim.id as string,
		);
		if (new Set(claimIds).size !== claimIds.length) {
			throw new DagSemanticRunnerError(
				"ACCEPTED_ARTIFACT_INVALID",
				`${workUnitId} repeats a claim ID`,
			);
		}
	}
	if (options.recovery !== undefined && options.selectiveRecovery !== undefined) {
		throw new DagSemanticRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Git rebinding and selective Plan recovery cannot be combined",
		);
	}
	const priorBundle =
		options.recovery === undefined
			? undefined
			: await readPriorBundle(options.repository, options.planId, options.recovery);
	if (
		priorBundle !== undefined &&
		(object(priorBundle.gateInput.planDigest, "prior plan digest").value !== hash(plan).value ||
			priorBundle.dependencyGraph.planId !== options.planId)
	) {
		throw new DagSemanticRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Prior DAG bundle belongs to a different accepted plan",
		);
	}
	const emitStructuralError = async (
		dependencyGraph: JsonObject,
		workUnitIds: string[],
		diagnostics: JsonObject[],
		bindings: JsonObject[] = [],
	): Promise<DagStructuralErrorRun | DagStructuralErrorBundle> => {
		const availableEvidenceDigests = bindings
			.map((entry) => ({
				kind: "binding",
				workUnitId: entry.workUnitId,
				digest: hash(entry),
			}))
			.sort((left, right) => {
				const leftKey = canonicalize(left);
				const rightKey = canonicalize(right);
				return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
			});
		const errorInput: JsonObject = {
			schema: DAG_STRUCTURAL_ERROR_INPUT_SCHEMA,
			topologyDigest: hash(topology),
			dependencyGraphDigest: hash(dependencyGraph),
			policyDigest,
			planDigest: hash(plan),
			workUnitIds,
			availableEvidenceDigests,
			diagnostics,
		};
		const computed = computeDagStructuralErrorV2(errorInput);
		const definition = await validators();
		assertValid(definition("DagStructuralErrorInput"), errorInput, "DAG structural error input");
		assertValid(definition("DagGateResult"), computed.gateResult, "DAG structural GateResult");
		assertDagStructuralErrorIntegrity({ input: errorInput, result: computed.gateResult });
		const bundle: DagStructuralErrorBundle = {
			schema: DAG_STRUCTURAL_ERROR_BUNDLE_SCHEMA,
			topology,
			dependencyGraph,
			plan,
			policy,
			bindings,
			errorInput,
			gateResult: computed.gateResult,
		};
		assertValid(definition("DagStructuralErrorBundle"), bundle, "DAG structural error bundle");
		assertDagStructuralErrorBundleIntegrity(bundle);
		const observedHead = await git.resolveCommit(options.repository, options.head);
		if (observedHead.value !== resolvedHead) {
			throw new DagSemanticRunnerError(
				"BINDING_INVALID",
				"DAG head moved while structural evidence was evaluated",
			);
		}
		if (options.selectiveRecovery !== undefined) return bundle;
		const artifact = await persistStructuralErrorBundle(options.repository, options.planId, bundle);
		return { ...bundle, artifact };
	};
	const dependencyDiagnostics = diagnoseDagDependenciesV2(
		units.map((unit) => ({
			workUnitId: unit.id as string,
			dependencies: strings(unit.dependencies),
		})),
	);
	if (dependencyDiagnostics.diagnostics.length > 0) {
		const unitById = new Map(units.map((unit) => [unit.id as string, unit] as const));
		const dependencyGraph: JsonObject = {
			schema: "graphrefly.stack.semantic-dependency-graph.v2",
			planId: options.planId,
			topologyDigest: hash(topology),
			workUnits: dependencyDiagnostics.workUnitIds.map((workUnitId) => ({
				workUnitId,
				dependencies: [...strings(unitById.get(workUnitId)?.dependencies)].sort(),
			})),
		};
		return emitStructuralError(
			dependencyGraph,
			dependencyDiagnostics.workUnitIds,
			dependencyDiagnostics.diagnostics,
		);
	}
	const order = canonicalWorkUnitOrder(units);
	const priorBindingById = new Map(
		(priorBundle?.bindings ?? []).map(
			(binding) => [binding.workUnitId as string, binding] as const,
		),
	);
	const priorRecordById = new Map(
		(priorBundle?.records ?? []).map((record) => [record.workUnitId as string, record] as const),
	);
	const bindingStates = new Map<string, "fresh" | "reused" | "rebound">();
	let recoveryMatches = 0;
	const unitById = new Map(units.map((unit) => [unit.id as string, unit] as const));
	const dependencyGraph: JsonObject = {
		schema: "graphrefly.stack.semantic-dependency-graph.v2",
		planId: options.planId,
		topologyDigest: hash(topology),
		workUnits: order.map((workUnitId) => ({
			workUnitId,
			dependencies: [...strings(unitById.get(workUnitId)?.dependencies)].sort(),
		})),
	};
	const implementationEntries = objects(topology.objects, "topology objects").filter(
		(entry) => entry.kind === "implementation",
	);
	const extraImplementation = implementationEntries.find(
		(entry) => !unitById.has(entry.workUnitId as string),
	);
	if (extraImplementation !== undefined) {
		throw new DagSemanticRunnerError(
			"WORK_UNIT_SET_MISMATCH",
			`Reachable implementation ${String(extraImplementation.workUnitId)} is outside the accepted plan`,
		);
	}
	const candidatesById = new Map<string, JsonObject[]>();
	for (const entry of implementationEntries) {
		const id = entry.workUnitId as string;
		candidatesById.set(id, [...(candidatesById.get(id) ?? []), entry]);
	}
	const bindingDiagnostics: JsonObject[] = [];
	for (const workUnitId of [...order].sort()) {
		const candidates = candidatesById.get(workUnitId) ?? [];
		if (candidates.length === 0) {
			bindingDiagnostics.push({
				workUnitId,
				reasonCode: "BINDING_MISSING",
				relatedWorkUnitIds: [],
				relatedCommits: [],
				edges: [],
			});
		} else if (candidates.length > 1) {
			bindingDiagnostics.push({
				workUnitId,
				reasonCode: "BINDING_AMBIGUOUS",
				relatedWorkUnitIds: [],
				relatedCommits: candidates
					.map((entry) => entry.oid as JsonObject)
					.sort((left, right) => {
						const leftKey = canonicalize(left);
						const rightKey = canonicalize(right);
						return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
					}),
				edges: [],
			});
		}
	}
	if (bindingDiagnostics.length > 0) {
		return emitStructuralError(dependencyGraph, [...order].sort(), bindingDiagnostics);
	}
	const implementationById = new Map(
		[...candidatesById].map(([id, entries]) => [id, entries[0] as JsonObject] as const),
	);
	const blueprintByRevision = new Map(
		graphEvidence.blueprints.map((entry) => [entry.revision.value, entry] as const),
	);
	const bindings: JsonObject[] = [];
	for (const workUnitId of order) {
		const entry = implementationById.get(workUnitId) as JsonObject;
		const commit = entry.oid as { algorithm: "sha1" | "sha256"; value: string };
		const diff = await git.canonicalDiff(options.repository, commit);
		const changedPaths = [...(await git.changedPaths(options.repository, commit))];
		const binding: JsonObject = {
			schema: "graphrefly.stack.work-unit-binding.v2",
			planId: options.planId,
			workUnitId,
			commit,
			parentCommit: objects(entry.parents, "implementation parents")[0],
			trailer: { name: "GraphReFly-Work-Unit", value: workUnitId, occurrences: 1 },
			stablePatchId: await git.stablePatchId(options.repository, commit),
			diffDigest: {
				algorithm: "sha256",
				value: createHash("sha256").update(diff).digest("hex"),
			},
			changedPaths,
			blueprintHash: entry.blueprintHash,
			rebindFrom: null,
		};
		const priorBinding = priorBindingById.get(workUnitId);
		if (priorBinding !== undefined && priorBinding.stablePatchId === binding.stablePatchId) {
			recoveryMatches += 1;
			const sameCommit =
				object(priorBinding.commit, "prior binding commit").value ===
				object(binding.commit, "binding commit").value;
			if (sameCommit) {
				binding.rebindFrom = priorBinding.rebindFrom;
				bindingStates.set(
					workUnitId,
					sha256Jcs(binding) === sha256Jcs(priorBinding) ? "reused" : "fresh",
				);
			} else {
				binding.rebindFrom = {
					kind: (options.recovery as DagRecovery).kind,
					previousBindingDigest: hash(priorBinding),
					stablePatchId: binding.stablePatchId,
				};
				bindingStates.set(workUnitId, "rebound");
			}
		} else {
			bindingStates.set(workUnitId, "fresh");
		}
		bindings.push(binding);
	}
	if (priorBundle !== undefined && recoveryMatches === 0) {
		throw new DagSemanticRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Prior DAG bundle shares no stable patch identity with the current implementation",
		);
	}
	const bindingById = new Map(bindings.map((binding) => [binding.workUnitId as string, binding]));
	const ancestryDiagnostics: JsonObject[] = [];
	for (const workUnitId of [...order].sort()) {
		const dependent = bindingById.get(workUnitId) as JsonObject;
		const dependentCommit = dependent.commit as JsonObject;
		for (const dependencyId of [...strings(unitById.get(workUnitId)?.dependencies)].sort()) {
			const dependency = bindingById.get(dependencyId) as JsonObject;
			const dependencyCommit = dependency.commit as JsonObject;
			if (
				!gitIsAncestor(
					options.repository,
					object(dependencyCommit, "dependency commit").value as string,
					object(dependentCommit, "dependent commit").value as string,
				)
			) {
				ancestryDiagnostics.push({
					workUnitId,
					reasonCode: "DEPENDENCY_NOT_ANCESTOR",
					relatedWorkUnitIds: [dependencyId],
					relatedCommits: [dependencyCommit, dependentCommit],
					edges: [],
				});
			}
		}
	}
	if (ancestryDiagnostics.length > 0) {
		return emitStructuralError(dependencyGraph, [...order].sort(), ancestryDiagnostics, bindings);
	}
	const requiredCheckIds = [
		...new Set(units.flatMap((unit) => strings(unit.requiredChecks))),
	].sort();
	const checkResults = await runRepositoryPolicyChecks(
		options.repository,
		resolvedHead,
		policy,
		requiredCheckIds,
	);
	const checkById = new Map(checkResults.map((check) => [check.checkId as string, check] as const));
	const records: JsonObject[] = [];
	const evaluations: JsonObject[] = [];
	const recordStates = new Map<string, "recomputed" | "reused">();
	const recordById = new Map<string, JsonObject>();
	for (const workUnitId of order) {
		const unit = unitById.get(workUnitId) as JsonObject;
		const binding = bindingById.get(workUnitId) as JsonObject;
		const blueprint = blueprintByRevision.get(
			object(binding.commit, "binding commit").value as string,
		);
		if (blueprint === undefined) {
			throw new DagSemanticRunnerError("BINDING_INVALID", `${workUnitId} Blueprint is missing`);
		}
		const sourceScopes = strings(unit.allowedSourceScopes);
		const changedPaths = strings(binding.changedPaths);
		const sourceScope = {
			valid: changedPaths.every((path) => withinScope(path, sourceScopes)),
			witnessDigest: hash({ allowedSourceScopes: sourceScopes, changedPaths }),
		};
		const orderedClaims = objects(unit.claims, `${workUnitId} claims`).sort((left, right) =>
			(left.id as string) < (right.id as string)
				? -1
				: (left.id as string) > (right.id as string)
					? 1
					: 0,
		);
		const claims = orderedClaims.map((claim) => {
			const result = evaluateSemanticPredicate(
				blueprint.blueprint,
				object(claim.predicate, "claim predicate"),
			);
			return {
				claimId: claim.id,
				valid: result.ok,
				witnessDigest: result.witnessDigest ?? hash({ claimId: claim.id, reason: result.reason }),
			};
		});
		const checks = [...strings(unit.requiredChecks)].sort().map((checkId) => {
			const result = checkById.get(checkId);
			return {
				checkId,
				status: result === undefined ? "missing" : result.exitCode === 0 ? "passed" : "failed",
				digest: hash(result ?? { checkId, status: "missing" }),
			};
		});
		const checkDigests = checks.map((check) => ({
			workUnitId,
			checkId: check.checkId,
			digest: check.digest,
		}));
		const claimWitnesses = orderedClaims.map((claim, index) => ({
			claimId: claim.id,
			predicateDigest: hash(claim.predicate),
			status: claims[index]?.valid === true ? "satisfied" : "unsatisfied",
		}));
		let recordBody: JsonObject = {
			schema: "graphrefly.stack.semantic-record.v2",
			planId: options.planId,
			workUnitId,
			bindingDigest: hash(binding),
			directDependencyRecordIds: strings(unit.dependencies)
				.map((dependency) => recordById.get(dependency)?.recordId as string)
				.sort(),
			policyDigest,
			blueprintHash: blueprint.blueprintHash,
			sourceScopeDigest: hash(sourceScopes),
			claimsDigest: hash(unit.claims),
			checksDigest: hash(checkDigests),
			claimWitnesses,
			requiredChecks: [...strings(unit.requiredChecks)].sort(),
			rebindFrom: null,
		};
		const priorRecord = priorRecordById.get(workUnitId);
		const stableLineage =
			priorRecord !== undefined &&
			priorBindingById.get(workUnitId)?.stablePatchId === binding.stablePatchId;
		let record: JsonObject;
		if (stableLineage) {
			const priorRecordBody = { ...priorRecord };
			delete priorRecordBody.recordId;
			const reusableBody = {
				...recordBody,
				rebindFrom: priorRecord.rebindFrom,
			};
			if (sha256Jcs(reusableBody) === sha256Jcs(priorRecordBody)) {
				record = structuredClone(priorRecord);
				recordBody = reusableBody;
				recordStates.set(workUnitId, "reused");
			} else {
				recordBody = { ...recordBody, rebindFrom: priorRecord.recordId };
				record = {
					...recordBody,
					recordId: `record-${sha256Jcs(recordBody).slice(0, 24)}`,
				};
				recordStates.set(workUnitId, "recomputed");
			}
		} else {
			record = {
				...recordBody,
				recordId: `record-${sha256Jcs(recordBody).slice(0, 24)}`,
			};
			recordStates.set(workUnitId, "recomputed");
		}
		records.push(record);
		recordById.set(workUnitId, record);
		evaluations.push({
			schema: "graphrefly.stack.unit-evaluation.v2",
			workUnitId,
			bindingDigest: hash(binding),
			recordDigest: hash(record),
			sourceScope,
			blueprintHash: blueprint.blueprintHash,
			policyDigest,
			claims,
			checks,
		});
	}
	const joinEvaluations = objects(topology.joins, "topology joins").map((join) => ({
		schema: "graphrefly.stack.join-evaluation.v2",
		oid: join.oid,
		joinDigest: hash(join),
		valid: true,
		witnesses: [],
	}));
	const definition = await validators();
	for (const [name, values] of [
		["SemanticDependencyGraph", [dependencyGraph]],
		["WorkUnitBinding", bindings],
		["SemanticChangeRecord", records],
		["UnitEvaluationEvidence", evaluations],
		["JoinEvaluationEvidence", joinEvaluations],
	] as const) {
		const validate = definition(name);
		for (const value of values) assertValid(validate, value, name);
	}
	const computed = computeDagGateV2({
		topology,
		dependencyGraph,
		bindings,
		records,
		unitEvaluations: evaluations,
		joinEvaluations,
		policyDigest,
		planDigest: hash(plan),
	});
	assertValid(definition("DagGateInput"), computed.gateInput, "DagGateInput");
	assertValid(definition("DagGateResult"), computed.gateResult, "DagGateResult");
	const observedHead = await git.resolveCommit(options.repository, options.head);
	if (observedHead.value !== resolvedHead) {
		throw new DagSemanticRunnerError(
			"BINDING_INVALID",
			"DAG head moved while semantic evidence was evaluated",
		);
	}
	const bundle: DagSemanticGateBundle = {
		schema: DAG_GATE_BUNDLE_SCHEMA,
		topology,
		dependencyGraph,
		bindings,
		records,
		unitEvaluations: evaluations,
		joinEvaluations,
		...computed,
	};
	await assertBundle(bundle, "CONTRACT_INVALID");
	if (options.selectiveRecovery !== undefined) return bundle;
	const artifact = await persistBundle(options.repository, options.planId, bundle);
	return {
		...bundle,
		artifact,
		cache: {
			priorBundleDigest: options.recovery?.priorBundleDigest ?? null,
			units: order.map((workUnitId) => ({
				workUnitId,
				binding: bindingStates.get(workUnitId) ?? "fresh",
				record: recordStates.get(workUnitId) ?? "recomputed",
			})),
		},
	};
}

export function createDagSemanticGate(options: {
	repository: string;
	base: string;
	head: string;
	planId: string;
	repositoryIdentity: { provider: string; owner: string; name: string };
	recovery?: DagRecovery;
	graphEvidence?: DagGraphEvidence;
}): Promise<DagSemanticGateRun | DagStructuralErrorRun> {
	return createDagSemanticGateInternal(options) as Promise<
		DagSemanticGateRun | DagStructuralErrorRun
	>;
}

export function createDagSemanticGateForSelectiveRecovery(options: {
	repository: string;
	base: string;
	head: string;
	planId: string;
	repositoryIdentity: { provider: string; owner: string; name: string };
	graphEvidence: DagGraphEvidence;
	selectiveRecovery: DagSelectiveRecoveryContext;
}): Promise<DagSemanticGateBundle | DagStructuralErrorBundle> {
	return createDagSemanticGateInternal(options) as Promise<
		DagSemanticGateBundle | DagStructuralErrorBundle
	>;
}
