import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDagGraphEvidence, DagEvidenceError } from "../../packages/cli/dist/dag-evidence.js";
import { createDagReviewEvidence } from "../../packages/cli/dist/dag-review-runner.js";
import {
	createDagSemanticGate,
	DagSemanticRunnerError,
} from "../../packages/cli/dist/dag-semantic-runner.js";
import {
	assembleGroupIntegration,
	createGroupJoinEvidence,
} from "../../packages/cli/dist/group-integration-runner.js";
import { createRepositoryBlueprintSnapshot } from "../../packages/cli/dist/repository-review.js";
import { defaultReviewDist, startReviewServer } from "../../packages/cli/dist/review-server.js";
import {
	runRepositoryPolicyChecksWithCacheReport,
	SemanticRepositoryError,
} from "../../packages/cli/dist/semantic-repository.js";
import {
	assertDagReviewEvidenceIntegrity,
	assertDagStructuralErrorBundleIntegrity,
	assertDagTopologyIntegrity,
	DagStructuralErrorIntegrityError,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/cli/dist/cli.js", import.meta.url));

function git(repository, args, allowed = [0]) {
	const result = spawnSync("git", args, {
		cwd: repository,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "GraphReFly Stack",
			GIT_AUTHOR_EMAIL: "stack@example.invalid",
			GIT_COMMITTER_NAME: "GraphReFly Stack",
			GIT_COMMITTER_EMAIL: "stack@example.invalid",
		},
	});
	assert.ok(allowed.includes(result.status ?? 1), result.stderr);
	return result.stdout.trim();
}

async function commitFile(repository, path, content, subject, workUnitId, planId) {
	await writeFile(resolve(repository, path), content);
	git(repository, ["add", path]);
	const args = ["commit", "-m", subject];
	const trailers = [
		...(planId === undefined ? [] : [`GraphReFly-Plan: ${planId}`]),
		...(workUnitId === undefined ? [] : [`GraphReFly-Work-Unit: ${workUnitId}`]),
	];
	if (trailers.length > 0) args.push("-m", trailers.join("\n"));
	git(repository, args);
	return git(repository, ["rev-parse", "HEAD"]);
}

function fingerprint(repository) {
	return {
		head: git(repository, ["rev-parse", "HEAD"]),
		status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
		refs: git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
	};
}

async function repository() {
	const root = await mkdtemp(resolve(tmpdir(), "graphrefly-dag-evidence-"));
	git(root, ["init", "-q", "-b", "main"]);
	await Promise.all([
		writeFile(
			resolve(root, ".graphrefly-stack.json"),
			`${JSON.stringify({
				schema: "graphrefly.stack.repository.v1",
				blueprint: { entrypoint: "graphrefly-stack.blueprint.mjs" },
			})}\n`,
		),
		writeFile(
			resolve(root, "package.json"),
			`${JSON.stringify({
				name: "dag-evidence-fixture",
				private: true,
				type: "module",
				dependencies: { "@graphrefly/ts": "0.3.x" },
			})}\n`,
		),
		writeFile(
			resolve(root, "pnpm-lock.yaml"),
			"lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      '@graphrefly/ts':\n        specifier: 0.3.x\n        version: 0.3.0\n",
		),
		writeFile(
			resolve(root, "graphrefly-stack.blueprint.mjs"),
			`import { createHash } from "node:crypto";
import { withBlueprintHash } from "@graphrefly/ts/graph";
import { createGraph } from "./graph.mjs";
const value = withBlueprintHash(createGraph().blueprint({ diagnostics: true }), {
  algorithm: "sha256",
  hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
});
process.stdout.write(JSON.stringify(value));
`,
		),
		writeFile(
			resolve(root, "graph.mjs"),
			`import { graph } from "@graphrefly/ts/graph";
import { applyLeft } from "./left.mjs";
import { applyRight } from "./right.mjs";
export function createGraph() {
  const value = graph({ name: "dag-evidence" });
  value.state(1, { name: "base" });
  applyLeft(value);
  applyRight(value);
  return value;
}
`,
		),
		writeFile(resolve(root, "left.mjs"), "export function applyLeft() {}\n"),
		writeFile(resolve(root, "right.mjs"), "export function applyRight() {}\n"),
		writeFile(resolve(root, ".gitignore"), "node_modules\n"),
	]);
	await symlink(workspaceNodeModules, resolve(root, "node_modules"), "dir");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "base graph"]);
	return { root, base: git(root, ["rev-parse", "HEAD"]) };
}

async function structuralErrorRepository(dependencies, options = {}) {
	const fixture = await repository();
	const baseSnapshot = await createRepositoryBlueprintSnapshot({
		repository: fixture.root,
		revision: fixture.base,
	});
	const policy = {
		schema: "graphrefly.stack.semantic-policy.v1",
		policyId: "dag-policy",
		revision: "rev-1",
		allowedSourceRoots: ["left.mjs", "right.mjs"],
		allowedCapabilities: ["graph-change"],
		checks: [
			{
				id: "contract",
				argv: [process.execPath, "-e", "process.exit(0)"],
				timeoutMs: 10000,
				network: false,
				shell: false,
			},
		],
	};
	const unit = (id, path) => ({
		id,
		title: `${id} branch`,
		intent: `Change only ${id}`,
		dependencies: dependencies[id],
		allowedSourceScopes: [path],
		capabilities: ["graph-change"],
		claims: [
			{
				id: `${id.toLowerCase()}-absence`,
				predicate: {
					operator: "absent",
					selector: { kind: "node", nodeId: `never-${id.toLowerCase()}` },
				},
				rationale: "Keep the forbidden node absent",
			},
		],
		requiredChecks: ["contract"],
	});
	const plan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: "plan-dag",
		taskDigest: { algorithm: "sha256", value: sha256Jcs({ task: "structural-error" }) },
		taskSummary: "Exercise structural DAG errors",
		baseCommit: { algorithm: "sha1", value: fixture.base },
		baseBlueprintHash: baseSnapshot.blueprintHash,
		policy: {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: { algorithm: "sha256", value: sha256Jcs(policy) },
		},
		proposalSource: "human",
		acceptedBy: { label: "test", identityVerified: false },
		workUnits: [unit("RIGHT", "right.mjs"), unit("LEFT", "left.mjs")],
	};
	await mkdir(resolve(fixture.root, ".graphrefly-stack/plans"), { recursive: true });
	await Promise.all([
		writeFile(
			resolve(fixture.root, ".graphrefly-stack/policy.json"),
			`${JSON.stringify(policy, null, 2)}\n`,
		),
		writeFile(
			resolve(fixture.root, ".graphrefly-stack/plans/plan-dag.json"),
			`${JSON.stringify(plan, null, 2)}\n`,
		),
	]);
	git(fixture.root, ["add", ".graphrefly-stack"]);
	git(fixture.root, ["commit", "-m", "accept structural plan"]);
	const accepted = git(fixture.root, ["rev-parse", "HEAD"]);
	git(fixture.root, ["switch", "-q", "-c", "left"]);
	await commitFile(
		fixture.root,
		"left.mjs",
		'export function applyLeft(value) { value.state(2, { name: "left" }); }\n',
		"left graph",
		"LEFT",
	);
	if (options.skipRight === true) return fixture;
	git(fixture.root, ["switch", "-q", "-c", "right", accepted]);
	await commitFile(
		fixture.root,
		"right.mjs",
		'export function applyRight(value) { value.state(3, { name: "right" }); }\n',
		"right graph",
		"RIGHT",
	);
	git(fixture.root, ["switch", "-q", "left"]);
	git(fixture.root, ["merge", "--no-ff", "-m", "join structural branches", "right"]);
	return fixture;
}

test("binds verified Blueprint and ordered parent delta evidence for a real clean DAG", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	git(fixture.root, ["switch", "-q", "-c", "left"]);
	await commitFile(
		fixture.root,
		"left.mjs",
		'export function applyLeft(value) { value.state(2, { name: "left" }); }\n',
		"left graph",
		"LEFT",
	);
	await commitFile(fixture.root, "left.md", "left evidence\n", "document left");
	git(fixture.root, ["switch", "-q", "-c", "right", fixture.base]);
	await commitFile(
		fixture.root,
		"right.mjs",
		'export function applyRight(value) { value.state(3, { name: "right" }); }\n',
		"right graph",
		"RIGHT",
	);
	git(fixture.root, ["switch", "-q", "left"]);
	git(fixture.root, ["merge", "--no-ff", "-m", "join graph branches", "right"]);
	const before = fingerprint(fixture.root);

	const first = await createDagGraphEvidence({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	assertDagTopologyIntegrity(first.topology);
	assert.equal(first.topology.provider.runtimeVersion, "0.3.0");
	assert.equal(first.blueprints.length, first.topology.objects.length + 1);
	assert.equal(
		first.parentDeltas.length,
		first.topology.objects.reduce((count, entry) => count + entry.parents.length, 0),
	);
	assert.equal(first.topology.joins.length, 1);
	for (const object of first.topology.objects) {
		assert.equal(
			first.blueprints.find((entry) => entry.revision.value === object.oid.value)?.blueprintHash
				.value,
			object.blueprintHash.value,
		);
	}
	assert.ok(
		first.parentDeltas.every((entry) => entry.deltaDigest.value === sha256Jcs(entry.delta)),
	);
	assert.deepEqual(
		first.topology.joins[0].parentDeltas.map((entry) => entry.from),
		first.topology.joins[0].parents,
	);
	assert.ok(
		first.topology.joins[0].parentDeltas.every((entry) =>
			first.parentDeltas.some(
				(delta) =>
					delta.from.value === entry.from.value &&
					delta.to.value === entry.to.value &&
					delta.deltaDigest.value === entry.deltaDigest.value,
			),
		),
	);
	assert.ok(first.executionCache.blueprints.every((entry) => entry.execution === "executed"));
	assert.ok(first.executionCache.parentDeltas.every((entry) => entry.execution === "executed"));
	const second = await createDagGraphEvidence({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	assert.equal(sha256Jcs(second.topology), sha256Jcs(first.topology));
	assert.ok(second.executionCache.blueprints.every((entry) => entry.execution === "cache-hit"));
	assert.ok(second.executionCache.parentDeltas.every((entry) => entry.execution === "cache-hit"));
	assert.deepEqual(fingerprint(fixture.root), before);

	const commonDirectory = git(fixture.root, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	const blueprintCacheDirectory = resolve(commonDirectory, "grfs/dag-execution/blueprints");
	const [cacheEntry] = (await readdir(blueprintCacheDirectory)).sort();
	await writeFile(resolve(blueprintCacheDirectory, cacheEntry), "{}\n");
	await assert.rejects(
		createDagGraphEvidence({
			repository: fixture.root,
			base: fixture.base,
			head: "left",
			repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
		}),
		(error) => error instanceof DagEvidenceError && error.code === "BLUEPRINT_EVIDENCE_INVALID",
	);
});

test("fails closed when one selected object cannot produce verified Blueprint evidence", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await commitFile(
		fixture.root,
		"graphrefly-stack.blueprint.mjs",
		'process.stdout.write(JSON.stringify({ version: "not-a-blueprint" }));\n',
		"break blueprint",
		"BROKEN",
	);
	await assert.rejects(
		createDagGraphEvidence({
			repository: fixture.root,
			base: fixture.base,
			head: "HEAD",
			repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
		}),
		(error) => error instanceof DagEvidenceError && error.code === "BLUEPRINT_EVIDENCE_INVALID",
	);
});

test("skips exact policy-check executions and rejects tampered local cache", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const externalCheck = resolve(fixture.root, "external-check.mjs");
	await writeFile(externalCheck, "process.exit(0);\n");
	const policy = {
		checks: [
			{
				id: "contract",
				argv: [process.execPath, externalCheck],
				timeoutMs: 10000,
				network: false,
				shell: false,
			},
		],
	};
	const first = await runRepositoryPolicyChecksWithCacheReport(fixture.root, "HEAD", policy, [
		"contract",
	]);
	assert.deepEqual(first.executions, [{ checkId: "contract", execution: "executed" }]);
	const second = await runRepositoryPolicyChecksWithCacheReport(fixture.root, "HEAD", policy, [
		"contract",
	]);
	assert.deepEqual(second.executions, [{ checkId: "contract", execution: "cache-hit" }]);

	await writeFile(externalCheck, "process.exit(1);\n");
	const environmentChanged = await runRepositoryPolicyChecksWithCacheReport(
		fixture.root,
		"HEAD",
		policy,
		["contract"],
	);
	assert.deepEqual(environmentChanged.executions, [{ checkId: "contract", execution: "executed" }]);
	assert.equal(environmentChanged.results[0].exitCode, 1);
	await writeFile(externalCheck, "process.exit(0);\n");
	await commitFile(fixture.root, "evidence.md", "new head\n", "move check head");
	const changed = await runRepositoryPolicyChecksWithCacheReport(fixture.root, "HEAD", policy, [
		"contract",
	]);
	assert.deepEqual(changed.executions, [{ checkId: "contract", execution: "executed" }]);

	const commonDirectory = git(fixture.root, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	const checkCacheDirectory = resolve(commonDirectory, "grfs/dag-execution/policy-checks");
	const entries = (await readdir(checkCacheDirectory)).sort();
	await Promise.all(entries.map((entry) => writeFile(resolve(checkCacheDirectory, entry), "{}\n")));
	await assert.rejects(
		runRepositoryPolicyChecksWithCacheReport(fixture.root, "HEAD", policy, ["contract"]),
		(error) => error instanceof SemanticRepositoryError && error.code === "EXECUTION_CACHE_INVALID",
	);
});

test("emits verified structural GateResult errors for dependency and binding failures", async (t) => {
	const cases = [
		{
			name: "missing dependency",
			dependencies: { LEFT: ["MISSING"], RIGHT: [] },
			expected: [
				["LEFT", "invalid", ["DEPENDENCY_MISSING"]],
				["RIGHT", "not-evaluated", []],
			],
			cut: ["LEFT"],
		},
		{
			name: "cycle",
			dependencies: { LEFT: ["RIGHT"], RIGHT: ["LEFT"] },
			expected: [
				["LEFT", "invalid", ["DEPENDENCY_CYCLE"]],
				["RIGHT", "invalid", ["DEPENDENCY_CYCLE"]],
			],
			cut: ["LEFT", "RIGHT"],
		},
		{
			name: "missing binding",
			dependencies: { LEFT: [], RIGHT: [] },
			options: { skipRight: true },
			expected: [
				["LEFT", "not-evaluated", []],
				["RIGHT", "invalid", ["BINDING_MISSING"]],
			],
			cut: ["RIGHT"],
		},
		{
			name: "dependency not ancestor",
			dependencies: { LEFT: ["RIGHT"], RIGHT: [] },
			expected: [
				["LEFT", "invalid", ["DEPENDENCY_NOT_ANCESTOR"]],
				["RIGHT", "not-evaluated", []],
			],
			cut: ["LEFT"],
		},
		{
			name: "ambiguous binding",
			dependencies: { LEFT: [], RIGHT: [] },
			mutate: async (fixture) => {
				await commitFile(
					fixture.root,
					"left.mjs",
					'export function applyLeft(value) { value.state(4, { name: "second-left" }); }\n',
					"second left binding",
					"LEFT",
				);
			},
			expected: [
				["LEFT", "invalid", ["BINDING_AMBIGUOUS"]],
				["RIGHT", "not-evaluated", []],
			],
			cut: ["LEFT"],
		},
	];
	for (const entry of cases) {
		await t.test(entry.name, async () => {
			const fixture = await structuralErrorRepository(entry.dependencies, entry.options);
			t.after(() => rm(fixture.root, { recursive: true, force: true }));
			await entry.mutate?.(fixture);
			const before = fingerprint(fixture.root);
			const result = await createDagSemanticGate({
				repository: fixture.root,
				base: fixture.base,
				head: "left",
				planId: "plan-dag",
				repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
			});
			assert.equal(result.schema, "graphrefly.stack.dag-structural-error-bundle.v2");
			assert.equal(result.errorInput.schema, "graphrefly.stack.dag-structural-error-input.v2");
			assert.equal(result.gateResult.verdict, "error");
			assert.deepEqual(
				result.gateResult.units.map((unit) => [unit.workUnitId, unit.verdict, unit.reasonCodes]),
				entry.expected,
			);
			assert.deepEqual(result.gateResult.minimalAffectedCut, entry.cut);
			const persisted = JSON.parse(await readFile(result.artifact.path, "utf8"));
			assert.equal(sha256Jcs(persisted), result.artifact.digest.value);
			assertDagStructuralErrorBundleIntegrity(persisted);
			const forged = structuredClone(persisted);
			forged.plan.taskSummary = "forged after evaluation";
			assert.throws(
				() => assertDagStructuralErrorBundleIntegrity(forged),
				DagStructuralErrorIntegrityError,
			);
			const repeated = await createDagSemanticGate({
				repository: fixture.root,
				base: fixture.base,
				head: "left",
				planId: "plan-dag",
				repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
			});
			assert.equal(sha256Jcs(repeated), sha256Jcs(result));
			if (entry.name === "missing binding") {
				const review = await createDagReviewEvidence({
					repository: fixture.root,
					base: fixture.base,
					head: "left",
					planId: "plan-dag",
					repositoryIdentity: {
						provider: "github",
						owner: "clfhhc",
						name: "test-graphrefly",
					},
				});
				assert.equal(review.schema, "graphrefly.stack.dag-review-evidence.v2");
				assert.deepEqual(review.projection.selectedEvidence, {
					kind: "structural-unit",
					workUnitId: "RIGHT",
				});
				assert.equal(
					review.projection.gitLanes.find((lane) => lane.kind === "implementation")?.verdict,
					"not-evaluated",
				);
			}
			assert.deepEqual(fingerprint(fixture.root), before);
		});
	}
});

test("composes a real accepted plan and branched DAG into one selective semantic result", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const baseSnapshot = await createRepositoryBlueprintSnapshot({
		repository: fixture.root,
		revision: fixture.base,
	});
	const policy = {
		schema: "graphrefly.stack.semantic-policy.v1",
		policyId: "dag-policy",
		revision: "rev-1",
		allowedSourceRoots: ["left.mjs", "right.mjs"],
		allowedCapabilities: ["graph-change"],
		checks: [
			{
				id: "contract",
				argv: [process.execPath, "-e", "process.exit(0)"],
				timeoutMs: 10000,
				network: false,
				shell: false,
			},
		],
	};
	await mkdir(resolve(fixture.root, ".graphrefly-stack"), { recursive: true });
	await writeFile(
		resolve(fixture.root, ".graphrefly-stack/policy.json"),
		`${JSON.stringify(policy, null, 2)}\n`,
	);
	git(fixture.root, ["add", ".graphrefly-stack/policy.json"]);
	git(fixture.root, ["commit", "-m", "install repository policy"]);
	const plan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: "plan-dag",
		taskDigest: { algorithm: "sha256", value: sha256Jcs({ task: "branch" }) },
		taskSummary: "Implement two independent graph branches",
		baseCommit: { algorithm: "sha1", value: fixture.base },
		baseBlueprintHash: baseSnapshot.blueprintHash,
		policy: {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: { algorithm: "sha256", value: sha256Jcs(policy) },
		},
		proposalSource: "human",
		acceptedBy: { label: "test", identityVerified: false },
		workUnits: [
			{
				id: "RIGHT",
				title: "Right branch",
				intent: "Change only the right graph branch",
				dependencies: [],
				allowedSourceScopes: ["right.mjs"],
				capabilities: ["graph-change"],
				claims: [
					{
						id: "right-absence",
						predicate: { operator: "absent", selector: { kind: "node", nodeId: "never-right" } },
						rationale: "The forbidden right node remains absent",
					},
				],
				requiredChecks: ["contract"],
			},
			{
				id: "LEFT",
				title: "Left branch",
				intent: "Expose an invalid left semantic claim without affecting right",
				dependencies: [],
				allowedSourceScopes: ["left.mjs"],
				capabilities: ["graph-change"],
				claims: [
					{
						id: "left-required",
						predicate: { operator: "present", selector: { kind: "node", nodeId: "never-left" } },
						rationale: "Deliberately prove a blocked branch",
					},
				],
				requiredChecks: ["contract"],
			},
		],
	};
	await mkdir(resolve(fixture.root, ".graphrefly-stack/plans"), { recursive: true });
	await writeFile(
		resolve(fixture.root, ".graphrefly-stack/plans/plan-dag.json"),
		`${JSON.stringify(plan, null, 2)}\n`,
	);
	git(fixture.root, ["add", ".graphrefly-stack/plans/plan-dag.json"]);
	git(fixture.root, ["commit", "-m", "accept DAG plan"]);
	const accepted = git(fixture.root, ["rev-parse", "HEAD"]);
	git(fixture.root, ["switch", "-q", "-c", "left"]);
	const leftCommit = await commitFile(
		fixture.root,
		"left.mjs",
		'export function applyLeft(value) { value.state(2, { name: "left" }); }\n',
		"left graph",
		"LEFT",
		"plan-dag",
	);
	git(fixture.root, ["switch", "-q", "-c", "right", accepted]);
	const rightCommit = await commitFile(
		fixture.root,
		"right.mjs",
		'export function applyRight(value) { value.state(3, { name: "right" }); }\n',
		"right graph",
		"RIGHT",
		"plan-dag",
	);
	git(fixture.root, ["switch", "-q", "left"]);
	git(fixture.root, ["merge", "--no-ff", "-m", "join graph branches", "right"]);
	git(fixture.root, ["remote", "add", "origin", "git@github.com:clfhhc/test-graphrefly.git"]);
	const before = fingerprint(fixture.root);
	const result = await createDagSemanticGate({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		planId: "plan-dag",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	assert.equal(result.gateResult.verdict, "blocked");
	assert.deepEqual(
		result.gateResult.units.map((unit) => [unit.workUnitId, unit.verdict]),
		[
			["LEFT", "invalid"],
			["RIGHT", "valid"],
		],
	);
	assert.deepEqual(result.gateResult.minimalAffectedCut, ["LEFT"]);
	assert.deepEqual(result.gateResult.units[0].reasonCodes, ["CLAIM_INVALID"]);
	assert.equal(result.gateResult.joins[0].verdict, "valid");
	const graphEvidence = await createDagGraphEvidence({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	const joinEvidence = await createGroupJoinEvidence({
		repository: fixture.root,
		topology: graphEvidence.topology,
		blueprints: graphEvidence.blueprints,
	});
	const qualified = (workUnitId, commit) => ({
		schema: "graphrefly.stack.plan-qualified-commit.v1",
		planId: "plan-dag",
		workUnitId,
		commit: { algorithm: "sha1", value: commit },
		ownership: {
			kind: "native",
			planTrailer: { name: "GraphReFly-Plan", value: "plan-dag", occurrences: 1 },
			workUnitTrailer: { name: "GraphReFly-Work-Unit", value: workUnitId, occurrences: 1 },
		},
	});
	const headBlueprint = graphEvidence.blueprints.find(
		(entry) => entry.revision.value === graphEvidence.topology.head.value,
	);
	assert.ok(headBlueprint);
	const group = await assembleGroupIntegration({
		topology: graphEvidence.topology,
		repositoryPolicy: policy,
		qualifiedCommits: [qualified("LEFT", leftCommit), qualified("RIGHT", rightCommit)],
		plans: [{ plan, policy, gateResult: result.gateResult }],
		headBlueprint,
		joinEvidence,
	});
	assert.equal(group.result.joins[0].valid, true);
	assert.equal(group.result.reasonCodes.includes("CLAIM_INVALIDATED"), true);
	assert.equal(group.result.reasonCodes.includes("HEAD_GATE_NOT_PASSING"), true);
	const checkCache = await runRepositoryPolicyChecksWithCacheReport(fixture.root, "left", policy, [
		"contract",
	]);
	assert.deepEqual(checkCache.executions, [{ checkId: "contract", execution: "cache-hit" }]);
	const repeated = await createDagSemanticGate({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		planId: "plan-dag",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	assert.equal(sha256Jcs(repeated), sha256Jcs(result));
	const reviewRun = await createDagReviewEvidence({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		planId: "plan-dag",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	const { artifact: reviewArtifact, ...review } = reviewRun;
	assertDagReviewEvidenceIntegrity(review);
	assert.equal(review.projection.summary.verdict, "blocked");
	assert.equal(review.projection.selectedEvidence.kind, "work-unit");
	assert.equal(review.projection.selectedEvidence.workUnitId, "LEFT");
	assert.equal(
		review.comparisons.length,
		review.domainBundle.topology.objects.reduce(
			(count, object) => count + object.parents.length,
			0,
		),
	);
	assert.ok(
		review.comparisons.some(
			(comparison) =>
				comparison.to.value === review.domainBundle.topology.joins[0].oid.value &&
				comparison.parentIndex === 1,
		),
	);
	const reviewBytes = await readFile(reviewArtifact.path, "utf8");
	const repeatedReview = await createDagReviewEvidence({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		planId: "plan-dag",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	assert.equal(repeatedReview.artifact.digest.value, reviewArtifact.digest.value);
	assert.equal(await readFile(reviewArtifact.path, "utf8"), reviewBytes);
	const automaticReview = spawnSync(
		process.execPath,
		[
			cli,
			"review",
			"--repo",
			fixture.root,
			"--base",
			fixture.base,
			"--head",
			"left",
			"--plan-id",
			"plan-dag",
			"--json",
		],
		{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	assert.equal(automaticReview.status, 0, automaticReview.stderr || automaticReview.stdout);
	const automaticEnvelope = JSON.parse(automaticReview.stdout);
	assert.equal(automaticEnvelope.data.schema, "graphrefly.stack.dag-review-evidence.v2");
	assert.deepEqual(automaticEnvelope.data.domainBundle.topology.repository, {
		provider: "github",
		owner: "clfhhc",
		name: "test-graphrefly",
	});
	const missingPlan = spawnSync(
		process.execPath,
		[cli, "review", "--repo", fixture.root, "--base", fixture.base, "--head", "left", "--json"],
		{ encoding: "utf8" },
	);
	assert.equal(missingPlan.status, 1);
	assert.equal(JSON.parse(missingPlan.stdout).error.code, "DAG_REVIEW_PLAN_REQUIRED");
	const obsoleteMode = spawnSync(
		process.execPath,
		[
			cli,
			"review",
			"--dag",
			"--repo",
			fixture.root,
			"--base",
			fixture.base,
			"--head",
			"left",
			"--plan-id",
			"plan-dag",
			"--json",
		],
		{ encoding: "utf8" },
	);
	assert.equal(obsoleteMode.status, 1);
	assert.equal(JSON.parse(obsoleteMode.stdout).error.code, "REVIEW_MODE_DEPRECATED");
	const forgedDiff = structuredClone(review);
	forgedDiff.comparisons[0].structuredDiff.paths.push("forged.ts");
	assert.throws(() => assertDagReviewEvidenceIntegrity(forgedDiff));
	const forgedSelection = structuredClone(review);
	forgedSelection.projection.selectedEvidence = {
		...forgedSelection.projection.selectedEvidence,
		workUnitId: "RIGHT",
	};
	assert.throws(() => assertDagReviewEvidenceIntegrity(forgedSelection));

	const running = await startReviewServer({
		host: "127.0.0.1",
		port: 0,
		distDir: defaultReviewDist,
		reviewData: review,
		dagReviewState: { repository: fixture.root, review },
	});
	const decisionResponse = await fetch(`${running.url}/api/review-decisions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: running.url,
			"X-GraphReFly-Review": "1",
		},
		body: JSON.stringify({
			schema: "graphrefly.stack.dag-review-decision-request.v2",
			decision: "request-changes",
			reviewerLabel: "DAG reviewer",
			summary: "LEFT needs correction.",
			selectedEvidence: review.projection.selectedEvidence,
		}),
	});
	const decisionBody = await decisionResponse.text();
	assert.equal(decisionResponse.status, 201, decisionBody);
	const priorDecision = JSON.parse(decisionBody);
	const decisions = await (await fetch(`${running.url}/api/review-decisions`)).json();
	assert.equal(decisions.schema, "graphrefly.stack.review-decision-history.v1");
	assert.equal(decisions.current.length, 1);
	assert.deepEqual(decisions.outdated, []);
	assert.deepEqual(decisions.current[0].target, {
		gateResultDigest: review.projection.gateResultDigest,
		topologyDigest: review.projection.topologyDigest,
		dependencyGraphDigest: review.projection.dependencyGraphDigest,
	});
	assert.equal(
		(await fetch(`${running.url}/api/review-decisions/export`)).status,
		404,
		"DAG decisions are repository-local unless a portable policy is explicitly added",
	);
	await new Promise((resolve) => running.server.close(resolve));
	assert.deepEqual(fingerprint(fixture.root), before);

	const originalArtifactBytes = await readFile(result.artifact.path, "utf8");
	git(fixture.root, ["switch", "-q", "-c", "recovered", accepted]);
	await commitFile(
		fixture.root,
		"graph.mjs",
		`import { graph } from "@graphrefly/ts/graph";
import { applyLeft } from "./left.mjs";
import { applyRight } from "./right.mjs";
export function createGraph() {
  const value = graph({ name: "dag-evidence" });
  value.state(1, { name: "base" });
  value.state(9, { name: "architecture" });
  applyLeft(value);
  applyRight(value);
  return value;
}
`,
		"change architecture baseline",
	);
	git(fixture.root, ["cherry-pick", leftCommit]);
	git(fixture.root, ["merge", "--no-ff", "-m", "join recovered branch", "right"]);
	const recoveredBefore = fingerprint(fixture.root);
	const recovered = await createDagSemanticGate({
		repository: fixture.root,
		base: fixture.base,
		head: "recovered",
		planId: "plan-dag",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
		recovery: {
			kind: "cherry-pick",
			priorBundleDigest: result.artifact.digest.value,
		},
	});
	assert.notEqual(recovered.artifact.digest.value, result.artifact.digest.value);
	assert.equal(await readFile(result.artifact.path, "utf8"), originalArtifactBytes);
	assert.deepEqual(recovered.cache.units, [
		{ workUnitId: "LEFT", binding: "rebound", record: "recomputed" },
		{ workUnitId: "RIGHT", binding: "reused", record: "reused" },
	]);
	const originalBindings = new Map(result.bindings.map((binding) => [binding.workUnitId, binding]));
	const recoveredBindings = new Map(
		recovered.bindings.map((binding) => [binding.workUnitId, binding]),
	);
	assert.deepEqual(recoveredBindings.get("LEFT").rebindFrom, {
		kind: "cherry-pick",
		previousBindingDigest: {
			algorithm: "sha256",
			value: sha256Jcs(originalBindings.get("LEFT")),
		},
		stablePatchId: originalBindings.get("LEFT").stablePatchId,
	});
	assert.deepEqual(recoveredBindings.get("RIGHT"), originalBindings.get("RIGHT"));
	const originalRecords = new Map(result.records.map((record) => [record.workUnitId, record]));
	const recoveredRecords = new Map(recovered.records.map((record) => [record.workUnitId, record]));
	assert.equal(recoveredRecords.get("LEFT").rebindFrom, originalRecords.get("LEFT").recordId);
	assert.deepEqual(recoveredRecords.get("RIGHT"), originalRecords.get("RIGHT"));
	assert.deepEqual(fingerprint(fixture.root), recoveredBefore);
	const recoveredReviewRun = await createDagReviewEvidence({
		repository: fixture.root,
		base: fixture.base,
		head: "recovered",
		planId: "plan-dag",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	const { artifact: _recoveredReviewArtifact, ...recoveredReview } = recoveredReviewRun;
	const recoveredServer = await startReviewServer({
		host: "127.0.0.1",
		port: 0,
		distDir: defaultReviewDist,
		reviewData: recoveredReview,
		dagReviewState: { repository: fixture.root, review: recoveredReview },
	});
	const recoveredHistory = await (
		await fetch(`${recoveredServer.url}/api/review-decisions`)
	).json();
	assert.deepEqual(recoveredHistory.current, []);
	assert.deepEqual(recoveredHistory.outdated, [priorDecision]);
	await new Promise((resolve) => recoveredServer.server.close(resolve));

	git(fixture.root, ["switch", "-q", "-c", "rebase-upstream", accepted]);
	await commitFile(
		fixture.root,
		"graph.mjs",
		`import { graph } from "@graphrefly/ts/graph";
import { applyLeft } from "./left.mjs";
import { applyRight } from "./right.mjs";
export function createGraph() {
  const value = graph({ name: "dag-evidence" });
  value.state(1, { name: "base" });
  value.state(8, { name: "rebased-architecture" });
  applyLeft(value);
  applyRight(value);
  return value;
}
`,
		"prepare rebase architecture",
	);
	const rebaseUpstream = git(fixture.root, ["rev-parse", "HEAD"]);
	git(fixture.root, ["switch", "-q", "-c", "rebase-source", leftCommit]);
	git(fixture.root, ["rebase", "--onto", rebaseUpstream, accepted, "rebase-source"]);
	const rebasedLeftCommit = git(fixture.root, ["rev-parse", "HEAD"]);
	assert.notEqual(rebasedLeftCommit, leftCommit);
	git(fixture.root, ["merge", "--no-ff", "-m", "join rebased branch", "right"]);
	const rebasedBefore = fingerprint(fixture.root);
	const rebased = await createDagSemanticGate({
		repository: fixture.root,
		base: fixture.base,
		head: "rebase-source",
		planId: "plan-dag",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
		recovery: {
			kind: "rebase",
			priorBundleDigest: result.artifact.digest.value,
		},
	});
	assert.deepEqual(rebased.cache.units, [
		{ workUnitId: "LEFT", binding: "rebound", record: "recomputed" },
		{ workUnitId: "RIGHT", binding: "reused", record: "reused" },
	]);
	const rebasedBindings = new Map(rebased.bindings.map((binding) => [binding.workUnitId, binding]));
	assert.equal(rebasedBindings.get("LEFT").commit.value, rebasedLeftCommit);
	assert.deepEqual(rebasedBindings.get("LEFT").rebindFrom, {
		kind: "rebase",
		previousBindingDigest: {
			algorithm: "sha256",
			value: sha256Jcs(originalBindings.get("LEFT")),
		},
		stablePatchId: originalBindings.get("LEFT").stablePatchId,
	});
	assert.deepEqual(rebasedBindings.get("RIGHT"), originalBindings.get("RIGHT"));
	assert.deepEqual(fingerprint(fixture.root), rebasedBefore);

	await writeFile(recovered.artifact.path, "{}\n");
	await assert.rejects(
		createDagSemanticGate({
			repository: fixture.root,
			base: fixture.base,
			head: "recovered",
			planId: "plan-dag",
			repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
			recovery: {
				kind: "rebase",
				priorBundleDigest: recovered.artifact.digest.value,
			},
		}),
		(error) =>
			error instanceof DagSemanticRunnerError && error.code === "RECOVERY_EVIDENCE_INVALID",
	);
});
