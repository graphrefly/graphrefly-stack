import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrictAjv, sha256Jcs } from "@graphrefly-stack/contracts";
import { type GateInput, graphreflyTopologyHash, type HashValue } from "@graphrefly-stack/core";

import {
	type DerivedFixtureBlueprint,
	deriveFixtureBlueprint,
	type FixtureCheckResult,
	runFixtureChecks,
} from "./graphrefly-provider.js";
import { SystemGitAdapter } from "./system-git.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(moduleDirectory, "../../..");
const templatePath = resolve(workspaceRoot, "fixtures/flagship/v1/repository-template.json");
const goldenPath = resolve(workspaceRoot, "fixtures/contracts/v1/golden-suite.json");
const artifactsSchemaPath = resolve(workspaceRoot, "contracts/v1/schemas/artifacts.schema.json");

interface RepositoryTemplate {
	scenario: string;
	stages: Record<string, Record<string, string>>;
}

interface GoldenSuite {
	changePlan: {
		workUnits: GateInput["workUnits"];
	};
	checks: FixtureCheckResult[];
	deltas: Record<string, unknown>[];
	provider: Record<string, unknown>;
	semanticChanges: Record<string, unknown>[];
	snapshots: Record<string, unknown>[];
	task: Record<string, unknown>;
}

interface RuntimeCase {
	caseId: string;
	input: GateInput;
	expected: {
		verdict: "pass" | "blocked";
		units: { workUnitId: string; verdict: "valid" | "invalid"; reasonCodes: string[] }[];
	};
}

export interface RuntimeSuite {
	schema: "urn:graphrefly-stack:runtime-suite:v1";
	scenario: string;
	repository: string;
	refs: Record<string, string>;
	task: Record<string, unknown>;
	changePlan: Record<string, unknown>;
	provider: Record<string, unknown>;
	checks: FixtureCheckResult[];
	ordinaryChecks: FixtureCheckResult[];
	snapshots: Record<string, unknown>[];
	deltas: Record<string, unknown>[];
	reviewBlueprints: {
		workUnitId: "BASE" | "U1" | "U2" | "U3";
		oid: string;
		parentOid: string | null;
		snapshot: Record<string, unknown>;
		delta: Record<string, unknown> | null;
		diagram: DerivedFixtureBlueprint["diagram"];
	}[];
	cases: RuntimeCase[];
	selectiveReplan: Record<string, unknown>;
}

const gitEnvironment = {
	...process.env,
	GIT_AUTHOR_NAME: "GraphReFly Fixture",
	GIT_AUTHOR_EMAIL: "fixture@graphrefly.local",
	GIT_COMMITTER_NAME: "GraphReFly Fixture",
	GIT_COMMITTER_EMAIL: "fixture@graphrefly.local",
	GIT_AUTHOR_DATE: "2026-07-16T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-07-16T00:00:00Z",
};

function runGit(repository: string, args: readonly string[]): string {
	const result = spawnSync(
		"git",
		["-C", repository, "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args],
		{
			encoding: "utf8",
			env: gitEnvironment,
			shell: false,
		},
	);
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
	}
	return result.stdout.trim();
}

async function applyStage(
	repository: string,
	template: RepositoryTemplate,
	stage: string,
): Promise<void> {
	const files = template.stages[stage];
	if (files === undefined) throw new Error(`Unknown fixture stage: ${stage}`);
	for (const [relative, contents] of Object.entries(files)) {
		const target = resolve(repository, relative);
		if (!target.startsWith(`${repository}${sep}`))
			throw new Error(`Unsafe fixture path: ${relative}`);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, contents, "utf8");
	}
}

async function commitStage(
	repository: string,
	template: RepositoryTemplate,
	stage: string,
	message: string,
): Promise<string> {
	await applyStage(repository, template, stage);
	runGit(repository, ["add", "--all"]);
	runGit(repository, ["commit", "--no-gpg-sign", "-m", message]);
	return runGit(repository, ["rev-parse", "HEAD"]);
}

function hash(value: string): HashValue {
	return { algorithm: "sha256", value };
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function withSnapshotBinding(
	template: Record<string, unknown>,
	commit: string,
	semanticParent: string,
	derived: DerivedFixtureBlueprint,
): Record<string, unknown> {
	const snapshot = clone(template);
	const blueprint = clone(derived.blueprint) as unknown as Record<string, unknown>;
	const topologyHash = graphreflyTopologyHash(derived.blueprint.topology);
	if ((blueprint.hash as Record<string, unknown>).value !== topologyHash) {
		throw new Error("GraphReFly runtime Blueprint hash does not match its topology");
	}
	snapshot.blueprint = blueprint;
	(snapshot.commit as Record<string, unknown>).value = commit;
	(snapshot.semanticParent as Record<string, unknown>).value = semanticParent;
	(snapshot.topologyHash as Record<string, unknown>).value = topologyHash;
	snapshot.policyRevision = derived.policyRevision;
	return snapshot;
}

function snapshotTopology(snapshot: Record<string, unknown>) {
	return (snapshot.blueprint as Record<string, unknown>).topology as {
		nodes: Record<string, unknown>[];
		edges: { from: string; to: string }[];
	};
}

function deriveBlueprintDelta(
	fromSnapshot: Record<string, unknown>,
	toSnapshot: Record<string, unknown>,
	claimImpacts: { workUnitId: string; claimId: string; impact: "none" | "affected" }[],
): Record<string, unknown> {
	const from = snapshotTopology(fromSnapshot);
	const to = snapshotTopology(toSnapshot);
	const fromNodes = new Map(from.nodes.map((node) => [node.id as string, node]));
	const toNodes = new Map(to.nodes.map((node) => [node.id as string, node]));
	const changedNodeIds = new Set(
		[...fromNodes.keys()].filter(
			(id) => toNodes.has(id) && sha256Jcs(fromNodes.get(id)) !== sha256Jcs(toNodes.get(id)),
		),
	);
	const edgeKey = (edge: { from: string; to: string }) => `${edge.from}\u0000${edge.to}`;
	const fromEdges = new Set(from.edges.map(edgeKey));
	const toEdges = new Set(to.edges.map(edgeKey));
	return {
		schema: "urn:graphrefly-stack:schema:blueprint-delta:v1",
		from: hash(topologyHash(fromSnapshot)),
		to: hash(topologyHash(toSnapshot)),
		structural: {
			addedNodes: [...toNodes.entries()]
				.filter(([id]) => !fromNodes.has(id) || changedNodeIds.has(id))
				.map(([, node]) => node),
			removedNodeIds: [...fromNodes.keys()].filter(
				(id) => !toNodes.has(id) || changedNodeIds.has(id),
			),
			addedEdges: to.edges.filter((edge) => !fromEdges.has(edgeKey(edge))),
			removedEdges: from.edges.filter((edge) => !toEdges.has(edgeKey(edge))),
		},
		claimImpacts,
	};
}

function topologyHash(snapshot: Record<string, unknown>): string {
	return (snapshot.topologyHash as Record<string, unknown>).value as string;
}

async function recordsAndFacts(
	repository: string,
	refs: readonly string[],
	templates: readonly Record<string, unknown>[],
	witnesses: readonly string[],
	policies: readonly string[],
	prefix: string,
) {
	const adapter = new SystemGitAdapter();
	const facts = await Promise.all(
		refs.map((revision, index) => adapter.fact(repository, revision, `U${index + 1}`)),
	);
	const records: Record<string, unknown>[] = [];
	for (const [index, template] of templates.entries()) {
		const fact = facts[index];
		if (fact === undefined) throw new Error("Missing Git fact");
		const record = clone(template);
		record.recordId = `${prefix}.u${index + 1}.${fact.commit.value.slice(0, 12)}`;
		record.commit = fact.commit;
		record.stablePatchId = fact.stablePatchId;
		record.diffDigest = fact.diffDigest;
		record.semanticParentRecordId = index === 0 ? null : records[index - 1]?.recordId;
		record.semanticParentCommit = fact.parent;
		record.sourceScopeDigest = hash(sha256Jcs(record.allowedSourceScopes));
		record.blueprintHash = hash(witnesses[index] ?? witnesses.at(-1) ?? "");
		record.policyRevision = policies[index] ?? policies.at(-1) ?? "session-writes.v1";
		record.rebindFrom = prefix === "current" ? null : (template.recordId as string);
		records.push(record);
	}
	return { records, facts };
}

function gateInput(
	suite: GoldenSuite,
	records: Record<string, unknown>[],
	gitFacts: Awaited<ReturnType<SystemGitAdapter["fact"]>>[],
	snapshot: Record<string, unknown>,
	delta: Record<string, unknown>,
): GateInput {
	return {
		contractVersion: "v1",
		schemaValid: true,
		workUnits: suite.changePlan.workUnits,
		records: records as unknown as GateInput["records"],
		gitFacts,
		checks: suite.checks,
		snapshot: snapshot as unknown as GateInput["snapshot"],
		delta: delta as unknown as GateInput["delta"],
		artifactIntegrity: true,
	};
}

const expectedCases: RuntimeCase["expected"][] = [
	{
		verdict: "pass",
		units: ["U1", "U2", "U3"].map((workUnitId) => ({
			workUnitId,
			verdict: "valid",
			reasonCodes: [],
		})),
	},
	{
		verdict: "blocked",
		units: [
			{ workUnitId: "U1", verdict: "valid", reasonCodes: [] },
			{
				workUnitId: "U2",
				verdict: "invalid",
				reasonCodes: ["BLUEPRINT_WITNESS_STALE", "POLICY_SESSION_WRITE_REQUIRES_BROKER"],
			},
			{ workUnitId: "U3", verdict: "invalid", reasonCodes: ["DEPENDENCY_INVALID"] },
		],
	},
	{
		verdict: "pass",
		units: ["U1", "U2", "U3"].map((workUnitId) => ({
			workUnitId,
			verdict: "valid",
			reasonCodes: [],
		})),
	},
	{
		verdict: "blocked",
		units: [
			{ workUnitId: "U1", verdict: "valid", reasonCodes: [] },
			{ workUnitId: "U2", verdict: "invalid", reasonCodes: ["SEMANTIC_PARENT_STALE"] },
			{ workUnitId: "U3", verdict: "invalid", reasonCodes: ["DEPENDENCY_INVALID"] },
		],
	},
	{
		verdict: "blocked",
		units: [
			{ workUnitId: "U1", verdict: "invalid", reasonCodes: ["COMMIT_BINDING_MISMATCH"] },
			{
				workUnitId: "U2",
				verdict: "invalid",
				reasonCodes: ["SOURCE_SCOPE_VIOLATION", "DEPENDENCY_INVALID"],
			},
			{ workUnitId: "U3", verdict: "invalid", reasonCodes: ["DEPENDENCY_INVALID"] },
		],
	},
	{
		verdict: "pass",
		units: ["U1", "U2", "U3"].map((workUnitId) => ({
			workUnitId,
			verdict: "valid",
			reasonCodes: [],
		})),
	},
];

export async function createFlagshipFixture(output: string, force = false): Promise<RuntimeSuite> {
	const repository = resolve(output);
	const marker = resolve(repository, ".graphrefly-stack-fixture");
	const template = JSON.parse(await readFile(templatePath, "utf8")) as RepositoryTemplate;
	const suite = JSON.parse(await readFile(goldenPath, "utf8")) as GoldenSuite;
	try {
		await stat(repository);
		if (!force) throw new Error(`Fixture output already exists: ${repository}`);
		const ownership = await readFile(marker, "utf8").catch(() => "");
		if (ownership.trim() !== template.scenario) {
			throw new Error(`Refusing to replace an output not owned by GraphReFly Stack: ${repository}`);
		}
		await rm(repository, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(repository, { recursive: true });
	await writeFile(marker, `${template.scenario}\n`, "utf8");
	runGit(repository, ["init", "--initial-branch=main"]);

	const refs: Record<string, string> = {};
	refs.B0 = await commitStage(repository, template, "B0", "B0 fixture base");
	runGit(repository, ["tag", "B0"]);
	runGit(repository, ["switch", "-c", "stack-original"]);
	refs.S1 = await commitStage(repository, template, "U1", "U1 define refresh rotation contracts");
	runGit(repository, ["tag", "S1"]);
	refs.S2 = await commitStage(repository, template, "U2", "U2 implement refresh rotation flow");
	runGit(repository, ["tag", "S2"]);
	refs.S3 = await commitStage(repository, template, "U3", "U3 expose refresh HTTP adapter");
	runGit(repository, ["tag", "S3"]);

	runGit(repository, ["switch", "-c", "concurrent", "B0"]);
	refs.A1 = await commitStage(repository, template, "A1", "A1 require session mutation broker");
	runGit(repository, ["tag", "A1"]);
	runGit(repository, ["switch", "stack-original"]);
	runGit(repository, ["rebase", "--onto", "A1", "B0"]);
	const rebased = runGit(repository, ["rev-list", "--reverse", "A1..HEAD"]).split("\n");
	if (rebased.length !== 3 || rebased.some((value) => value === undefined || value === "")) {
		throw new Error(`Expected three commits after clean rebase, received ${rebased.length}`);
	}
	refs.R1 = rebased[0] as string;
	refs.R2 = rebased[1] as string;
	refs.R3 = rebased[2] as string;
	for (const name of ["R1", "R2", "R3"] as const)
		runGit(repository, ["tag", name, refs[name] ?? ""]);

	runGit(repository, ["switch", "-c", "unrelated", "S3"]);
	refs.T1 = await commitStage(
		repository,
		template,
		"TELEMETRY",
		"T1 add unrelated session telemetry",
	);
	runGit(repository, ["tag", "T1"]);

	runGit(repository, ["switch", "-c", "recovery", "R1"]);
	refs.RP2 = await commitStage(
		repository,
		template,
		"U2_PRIME",
		"R2-prime route persistence through broker",
	);
	runGit(repository, ["tag", "RP2"]);
	refs.RP3 = await commitStage(repository, template, "U3_PRIME", "R3-prime rebind HTTP adapter");
	runGit(repository, ["tag", "RP3"]);

	runGit(repository, ["switch", "-c", "wrong-scope", "S1"]);
	await applyStage(repository, template, "U2");
	await applyStage(repository, template, "WRONG_SCOPE");
	runGit(repository, ["add", "--all"]);
	runGit(repository, ["commit", "--no-gpg-sign", "-m", "BAD2 include an out-of-scope path"]);
	refs.BAD2 = runGit(repository, ["rev-parse", "HEAD"]);
	runGit(repository, ["tag", "BAD2"]);
	refs.BAD3 = await commitStage(repository, template, "U3", "BAD3 expose refresh HTTP adapter");
	runGit(repository, ["tag", "BAD3"]);
	runGit(repository, ["switch", "recovery"]);
	runGit(repository, ["diff", "--check"]);

	const derived = new Map<string, DerivedFixtureBlueprint>();
	for (const revision of ["S3", "R3", "T1", "RP3", "A1", "R1", "R2"]) {
		derived.set(revision, await deriveFixtureBlueprint(repository, revision));
	}
	const requiredDerived = (revision: string) => {
		const value = derived.get(revision);
		if (value === undefined) throw new Error(`Missing GraphReFly Blueprint for ${revision}`);
		return value;
	};
	const snapshotFor = (revision: string, parent: string, templateIndex = 0) =>
		withSnapshotBinding(
			suite.snapshots[templateIndex] ?? suite.snapshots[0] ?? {},
			refs[revision] ?? "",
			refs[parent] ?? "",
			requiredDerived(revision),
		);
	const snapshots = [
		snapshotFor("S3", "S2", 0),
		snapshotFor("R3", "R2", 1),
		snapshotFor("T1", "S3", 2),
		snapshotFor("RP3", "RP2", 3),
	];
	const reviewSnapshots = {
		A1: snapshotFor("A1", "B0"),
		R1: snapshotFor("R1", "A1"),
		R2: snapshotFor("R2", "R1"),
		R3: snapshots[1] as Record<string, unknown>,
	};
	const checkIds = ["contracts", "refresh-runtime", "refresh-api"];
	const ordinaryChecks = await runFixtureChecks(repository, "R3", checkIds);
	const finalChecks = await runFixtureChecks(repository, "RP3", checkIds);
	suite.checks = finalChecks;
	const hashes = snapshots.map(topologyHash);
	const impacts = (index: number) =>
		(suite.deltas[index]?.claimImpacts as {
			workUnitId: string;
			claimId: string;
			impact: "none" | "affected";
		}[]) ?? [];
	const deltas = [
		deriveBlueprintDelta(snapshots[0] ?? {}, snapshots[0] ?? {}, impacts(0)),
		deriveBlueprintDelta(snapshots[0] ?? {}, snapshots[1] ?? {}, impacts(1)),
		deriveBlueprintDelta(snapshots[0] ?? {}, snapshots[2] ?? {}, impacts(2)),
		deriveBlueprintDelta(snapshots[1] ?? {}, snapshots[3] ?? {}, impacts(3)),
	];
	const reviewBlueprints: RuntimeSuite["reviewBlueprints"] = [
		{
			workUnitId: "BASE",
			oid: refs.A1 ?? "",
			parentOid: refs.B0 ?? null,
			snapshot: reviewSnapshots.A1,
			delta: null,
			diagram: requiredDerived("A1").diagram,
		},
		...(
			[
				["U1", "R1", "A1", "contracts", "none"],
				["U2", "R2", "R1", "session-write-path", "affected"],
				["U3", "R3", "R2", "refresh-runtime", "none"],
			] as const
		).map(([workUnitId, revision, parent, claimId, impact]) => ({
			workUnitId,
			oid: refs[revision] ?? "",
			parentOid: refs[parent] ?? null,
			snapshot: reviewSnapshots[revision as "R1" | "R2" | "R3"],
			delta: deriveBlueprintDelta(
				reviewSnapshots[parent as "A1" | "R1" | "R2"],
				reviewSnapshots[revision as "R1" | "R2" | "R3"],
				[{ workUnitId, claimId, impact }],
			),
			diagram: requiredDerived(revision).diagram,
		})),
	];

	const current = await recordsAndFacts(
		repository,
		["S1", "S2", "S3"],
		suite.semanticChanges,
		[hashes[0] ?? ""],
		["session-writes.v1"],
		"current",
	);
	const stale = await recordsAndFacts(
		repository,
		["R1", "R2", "R3"],
		suite.semanticChanges,
		[hashes[0] ?? ""],
		["session-writes.v1"],
		"stale",
	);
	const unrelated = await recordsAndFacts(
		repository,
		["S1", "S2", "S3"],
		suite.semanticChanges,
		[hashes[0] ?? ""],
		["session-writes.v1"],
		"unrelated",
	);
	const staleParent = await recordsAndFacts(
		repository,
		["S1", "S2", "S3"],
		suite.semanticChanges,
		[hashes[0] ?? ""],
		["session-writes.v1"],
		"parent",
	);
	(staleParent.records[1] as Record<string, unknown>).semanticParentCommit = {
		algorithm: "sha1",
		value: refs.B0,
	};
	const forged = await recordsAndFacts(
		repository,
		["S1", "BAD2", "BAD3"],
		suite.semanticChanges,
		[hashes[0] ?? ""],
		["session-writes.v1"],
		"forged",
	);
	(forged.records[0] as Record<string, unknown>).commit = { algorithm: "sha1", value: refs.B0 };
	const fresh = await recordsAndFacts(
		repository,
		["R1", "RP2", "RP3"],
		suite.semanticChanges,
		[hashes[0] ?? "", hashes[3] ?? "", hashes[3] ?? ""],
		["session-writes.v1", "session-writes.v2", "session-writes.v2"],
		"fresh",
	);

	const names = [
		"current-valid",
		"clean-rebase-semantic-stale",
		"unrelated-change-still-valid",
		"stale-parent",
		"forged-or-wrong-scope",
		"fresh-selective-replan",
	];
	const inputs = [
		gateInput(suite, current.records, current.facts, snapshots[0] ?? {}, deltas[0] ?? {}),
		gateInput(suite, stale.records, stale.facts, snapshots[1] ?? {}, deltas[1] ?? {}),
		gateInput(suite, unrelated.records, unrelated.facts, snapshots[2] ?? {}, deltas[2] ?? {}),
		gateInput(suite, staleParent.records, staleParent.facts, snapshots[0] ?? {}, deltas[0] ?? {}),
		gateInput(suite, forged.records, forged.facts, snapshots[0] ?? {}, deltas[0] ?? {}),
		gateInput(suite, fresh.records, fresh.facts, snapshots[3] ?? {}, deltas[3] ?? {}),
	];
	const cases = names.map((caseId, index) => ({
		caseId,
		input: inputs[index] as GateInput,
		expected: expectedCases[index] as RuntimeCase["expected"],
	}));
	const runtimePlan = clone(suite.changePlan as unknown as Record<string, unknown>);
	runtimePlan.taskDigest = hash(sha256Jcs(suite.task));
	runtimePlan.baseCommit = { algorithm: "sha1", value: refs.B0 };
	runtimePlan.baseBlueprintHash = hash(hashes[0] ?? "");
	const runtime: RuntimeSuite = {
		schema: "urn:graphrefly-stack:runtime-suite:v1",
		scenario: template.scenario,
		repository,
		refs,
		task: suite.task,
		changePlan: runtimePlan,
		provider: suite.provider,
		checks: finalChecks,
		ordinaryChecks,
		snapshots,
		deltas,
		reviewBlueprints,
		cases,
		selectiveReplan: {
			schema: "urn:graphrefly-stack:schema:selective-replan:v1",
			planId: "plan.refresh-token-rotation.v1.replan.1",
			inputUnits: ["U2", "U3"],
			preservedUnits: ["U1"],
			replacements: [
				{
					workUnitId: "U2",
					fromCommit: { algorithm: "sha1", value: refs.R2 },
					toCommit: { algorithm: "sha1", value: refs.RP2 },
				},
				{
					workUnitId: "U3",
					fromCommit: { algorithm: "sha1", value: refs.R3 },
					toCommit: { algorithm: "sha1", value: refs.RP3 },
				},
			],
			finalLineage: [refs.A1, refs.R1, refs.RP2, refs.RP3].map((value) => ({
				algorithm: "sha1",
				value,
			})),
		},
	};

	const privateDirectory = resolve(repository, ".graphrefly-stack");
	await mkdir(resolve(privateDirectory, "snapshots"), { recursive: true });
	for (const snapshot of snapshots) {
		const oid = (snapshot.commit as Record<string, unknown>).value as string;
		await writeFile(
			resolve(privateDirectory, "snapshots", `${oid}.json`),
			`${JSON.stringify(snapshot, null, 2)}\n`,
		);
	}
	await writeFile(
		resolve(privateDirectory, "runtime-suite.json"),
		`${JSON.stringify(runtime, null, 2)}\n`,
	);
	await writeFile(
		resolve(privateDirectory, "fixture.json"),
		`${JSON.stringify({ schema: runtime.schema, scenario: runtime.scenario, repository, runtimeSuite: resolve(privateDirectory, "runtime-suite.json"), refs }, null, 2)}\n`,
	);
	return runtime;
}

export async function readRuntimeSuite(path: string): Promise<RuntimeSuite> {
	const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("Runtime suite must be an object");
	const runtime = parsed as RuntimeSuite;
	if (
		runtime.schema !== "urn:graphrefly-stack:runtime-suite:v1" ||
		!Array.isArray(runtime.cases) ||
		!Array.isArray(runtime.checks) ||
		!Array.isArray(runtime.ordinaryChecks) ||
		!Array.isArray(runtime.snapshots) ||
		!Array.isArray(runtime.deltas) ||
		!Array.isArray(runtime.reviewBlueprints)
	) {
		throw new Error("Runtime suite has an invalid envelope");
	}
	const artifactsSchema = JSON.parse(await readFile(artifactsSchemaPath, "utf8")) as object;
	const ajv = createStrictAjv();
	ajv.addSchema(artifactsSchema);
	const validate = (name: string, value: unknown) => {
		const validator = ajv.getSchema(
			`urn:graphrefly-stack:schema:artifacts:v1#/definitions/${name}`,
		);
		if (validator === undefined || !validator(value)) {
			throw new Error(`${name} contract invalid: ${JSON.stringify(validator?.errors ?? [])}`);
		}
	};
	validate("Task", runtime.task);
	validate("ChangePlan", runtime.changePlan);
	validate("BlueprintProviderCapabilities", runtime.provider);
	for (const check of runtime.checks) validate("CheckResult", check);
	for (const check of runtime.ordinaryChecks) validate("CheckResult", check);
	for (const snapshot of runtime.snapshots) validate("BlueprintSnapshot", snapshot);
	for (const delta of runtime.deltas) validate("BlueprintDelta", delta);
	for (const review of runtime.reviewBlueprints) {
		validate("BlueprintSnapshot", review.snapshot);
		if (review.delta !== null) validate("BlueprintDelta", review.delta);
		if (
			review.diagram.format !== "mermaid" ||
			review.diagram.renderer !== "@graphrefly/ts/render.describeToMermaid" ||
			!review.diagram.source.startsWith("flowchart ")
		) {
			throw new Error(
				`Review Blueprint ${review.workUnitId} has invalid GraphReFly diagram evidence`,
			);
		}
	}
	const planUnits = (runtime.changePlan.workUnits as unknown[]) ?? [];
	const snapshotDigests = new Set(runtime.snapshots.map((snapshot) => sha256Jcs(snapshot)));
	const deltaDigests = new Set(runtime.deltas.map((delta) => sha256Jcs(delta)));
	const checkById = new Map(
		runtime.checks.map((check) => [check.checkId as string, check.exitCode as number]),
	);
	const adapter = new SystemGitAdapter();
	for (const fixtureCase of runtime.cases) {
		if (typeof fixtureCase.caseId !== "string" || typeof fixtureCase.input !== "object") {
			throw new Error("Runtime case envelope invalid");
		}
		for (const record of fixtureCase.input.records) validate("SemanticChangeRecord", record);
		if (
			fixtureCase.input.contractVersion !== "v1" ||
			fixtureCase.input.schemaValid !== true ||
			fixtureCase.input.artifactIntegrity !== true ||
			sha256Jcs(fixtureCase.input.workUnits) !== sha256Jcs(planUnits) ||
			!snapshotDigests.has(sha256Jcs(fixtureCase.input.snapshot)) ||
			!deltaDigests.has(sha256Jcs(fixtureCase.input.delta))
		) {
			throw new Error(
				`Runtime case ${fixtureCase.caseId} is not bound to canonical suite artifacts`,
			);
		}
		for (const check of fixtureCase.input.checks) {
			if (checkById.get(check.checkId) !== check.exitCode) {
				throw new Error(`Runtime case ${fixtureCase.caseId} has an unbound check result`);
			}
		}
		for (const fact of fixtureCase.input.gitFacts) {
			if (!fact.exists) continue;
			const actual = await adapter.fact(runtime.repository, fact.commit.value, fact.workUnitId);
			if (
				actual.commit.value !== fact.commit.value ||
				actual.parent?.value !== fact.parent?.value ||
				actual.stablePatchId !== fact.stablePatchId ||
				actual.diffDigest.value !== fact.diffDigest.value ||
				sha256Jcs(actual.changedPaths) !== sha256Jcs(fact.changedPaths)
			) {
				throw new Error(`Runtime case ${fixtureCase.caseId} has stale or forged Git facts`);
			}
		}
	}
	validate("SelectiveReplan", runtime.selectiveReplan);
	return runtime;
}
