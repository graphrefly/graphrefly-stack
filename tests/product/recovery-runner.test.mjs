import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDagSemanticGate } from "../../packages/cli/dist/dag-semantic-runner.js";
import {
	abortRecovery,
	applyRecovery,
	createRecoveryPlan,
	exportRecovery,
	RecoveryRunnerError,
	recoveryStatus,
	resumeRecovery,
	verifyRecoveryExport,
} from "../../packages/cli/dist/recovery-runner.js";
import { createRepositoryBlueprintSnapshot } from "../../packages/cli/dist/repository-review.js";
import {
	assertRecoveryImpactIntegrity,
	assertRecoveryPlanIntegrity,
	assertRecoveryResultIntegrity,
	RecoveryIntegrityError,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/cli/dist/cli.js", import.meta.url));
const identity = { provider: "github", owner: "clfhhc", name: "test-graphrefly" };

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
	assert.ok(allowed.includes(result.status ?? 1), result.stderr || result.stdout);
	return result.stdout.trim();
}

async function commitFile(repository, path, content, subject, workUnitId, planId) {
	await writeFile(resolve(repository, path), content);
	git(repository, ["add", path]);
	const args = ["commit", "-m", subject];
	if (workUnitId !== undefined) {
		args.push("-m", `GraphReFly-Plan: ${planId}\nGraphReFly-Work-Unit: ${workUnitId}`);
	}
	git(repository, args);
	return git(repository, ["rev-parse", "HEAD"]);
}

function fingerprint(repository) {
	return {
		head: git(repository, ["rev-parse", "HEAD"]),
		branch: git(repository, ["branch", "--show-current"]),
		status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
	};
}

function unit(id, path, dependencies, nodeId, operator = "present") {
	return {
		id,
		title: `${id} semantic state`,
		intent: `${operator} ${nodeId}`,
		dependencies,
		allowedSourceScopes: [path],
		capabilities: ["graph-change"],
		claims: [
			{
				id: `${id.toLowerCase()}-${operator}`,
				predicate: { operator, selector: { kind: "node", nodeId } },
				rationale: `${nodeId} must be ${operator}`,
			},
		],
		requiredChecks: ["contract"],
	};
}

async function repository({ join = false } = {}) {
	const root = await mkdtemp(resolve(tmpdir(), "graphrefly-product-recovery-"));
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
				name: "recovery-fixture",
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
import { applyFoundation } from "./foundation.mjs";
import { applyApi } from "./api.mjs";
export function createGraph() {
  const value = graph({ name: "product-recovery" });
  value.state("base", { name: "base" });
  applyFoundation(value);
  applyApi(value);
  return value;
}
`,
		),
		writeFile(resolve(root, "foundation.mjs"), "export function applyFoundation() {}\n"),
		writeFile(resolve(root, "api.mjs"), "export function applyApi() {}\n"),
		writeFile(resolve(root, ".gitignore"), "node_modules\n"),
	]);
	await symlink(workspaceNodeModules, resolve(root, "node_modules"), "dir");
	git(root, ["add", "-A"]);
	git(root, ["commit", "-m", "base graph"]);
	const base = git(root, ["rev-parse", "HEAD"]);
	const baseSnapshot = await createRepositoryBlueprintSnapshot({
		repository: root,
		revision: base,
	});
	const policy = {
		schema: "graphrefly.stack.semantic-policy.v1",
		policyId: "recovery-policy",
		revision: "rev-1",
		allowedSourceRoots: ["foundation.mjs", "api.mjs"],
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
	await mkdir(resolve(root, ".graphrefly-stack/plans"), { recursive: true });
	await writeFile(
		resolve(root, ".graphrefly-stack/policy.json"),
		`${JSON.stringify(policy, null, 2)}\n`,
	);
	git(root, ["add", ".graphrefly-stack/policy.json"]);
	git(root, ["commit", "-m", "install policy"]);
	const plan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: "plan-product",
		taskDigest: { algorithm: "sha256", value: sha256Jcs({ task: "product recovery" }) },
		taskSummary: "Add a foundation and dependent API",
		baseCommit: { algorithm: "sha1", value: base },
		baseBlueprintHash: baseSnapshot.blueprintHash,
		policy: {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: { algorithm: "sha256", value: sha256Jcs(policy) },
		},
		proposalSource: "human",
		acceptedBy: { label: "test", identityVerified: false },
		workUnits: [
			unit("FOUNDATION", "foundation.mjs", [], "foundation"),
			unit("API", "api.mjs", join ? [] : ["FOUNDATION"], "api"),
		],
	};
	await writeFile(
		resolve(root, ".graphrefly-stack/plans/plan-product.json"),
		`${JSON.stringify(plan, null, 2)}\n`,
	);
	git(root, ["add", ".graphrefly-stack/plans/plan-product.json"]);
	git(root, ["commit", "-m", "accept product Plan"]);
	const acceptanceCommit = git(root, ["rev-parse", "HEAD"]);
	const foundationCommit = await commitFile(
		root,
		"foundation.mjs",
		'export function applyFoundation(value) { value.state("foundation", { name: "foundation" }); }\n',
		"implement foundation",
		"FOUNDATION",
		plan.planId,
	);
	if (join) {
		git(root, ["switch", "-q", "-c", "api-side", acceptanceCommit]);
		await commitFile(
			root,
			"api.mjs",
			'export function applyApi(value) { value.state("api", { name: "api" }); }\n',
			"implement API",
			"API",
			plan.planId,
		);
		git(root, ["switch", "-q", "main"]);
		git(root, ["merge", "--no-ff", "-m", "join source Plan", "api-side"]);
	} else {
		await commitFile(
			root,
			"api.mjs",
			'export function applyApi(value) { value.state("api", { name: "api" }); }\n',
			"implement API",
			"API",
			plan.planId,
		);
	}
	const source = await createDagSemanticGate({
		repository: root,
		base,
		head: "HEAD",
		planId: plan.planId,
		repositoryIdentity: identity,
	});
	assert.equal(source.gateResult.verdict, "pass");
	return { root, base, plan, source, foundationCommit, join };
}

function compensationPatch() {
	const patch = `diff --git a/api.mjs b/api.mjs
--- a/api.mjs
+++ b/api.mjs
@@ -1 +1 @@
-export function applyApi(value) { value.state("api", { name: "api" }); }
+export function applyApi(value) { value.state("api-recovered", { name: "api-recovered" }); }
`;
	return {
		patch,
		patchDigest: {
			algorithm: "sha256",
			value: createHash("sha256").update(patch).digest("hex"),
		},
	};
}

async function proposal(fixture, recoveryPlanId, { externalStatus = "not-applicable" } = {}) {
	const operation = compensationPatch();
	const value = {
		schema: "graphrefly.stack.recovery-plan-proposal.v1",
		recoveryPlanId,
		postRecoveryPlanId: `${recoveryPlanId}-post`,
		proposalSource: "human",
		selection: "work-units",
		targetWorkUnitIds: ["FOUNDATION"],
		steps: [
			{
				workUnitId: "FOUNDATION",
				disposition: "inverse",
				dependsOnSteps: [],
				postRecoveryWorkUnit: unit("FOUNDATION", "foundation.mjs", [], "foundation", "absent"),
				operation: {
					kind: "inverse",
					sourceCommit: { algorithm: "sha1", value: fixture.foundationCommit },
				},
				externalEffects: [
					{
						effectId: "foundation-runtime",
						status: externalStatus,
						evidenceDigest: null,
					},
				],
			},
			{
				workUnitId: "API",
				disposition: "compensate",
				dependsOnSteps: ["FOUNDATION"],
				postRecoveryWorkUnit: unit("API", "api.mjs", ["FOUNDATION"], "api-recovered"),
				operation: { kind: "compensate", ...operation },
				externalEffects: [],
			},
		],
	};
	const path = resolve(fixture.root, `${recoveryPlanId}.proposal.json`);
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
	return path;
}

async function joinProposal(fixture, recoveryPlanId) {
	const value = {
		schema: "graphrefly.stack.recovery-plan-proposal.v1",
		recoveryPlanId,
		postRecoveryPlanId: `${recoveryPlanId}-post`,
		proposalSource: "human",
		selection: "work-units",
		targetWorkUnitIds: ["FOUNDATION"],
		steps: [
			{
				workUnitId: "FOUNDATION",
				disposition: "inverse",
				dependsOnSteps: [],
				postRecoveryWorkUnit: unit("FOUNDATION", "foundation.mjs", [], "foundation", "absent"),
				operation: {
					kind: "inverse",
					sourceCommit: { algorithm: "sha1", value: fixture.foundationCommit },
				},
				externalEffects: [],
			},
		],
	};
	const path = resolve(fixture.root, `${recoveryPlanId}.proposal.json`);
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
	return path;
}

async function compensationOnlyProposal(fixture, recoveryPlanId) {
	const value = {
		schema: "graphrefly.stack.recovery-plan-proposal.v1",
		recoveryPlanId,
		postRecoveryPlanId: `${recoveryPlanId}-post`,
		proposalSource: "human",
		selection: "work-units",
		targetWorkUnitIds: ["API"],
		steps: [
			{
				workUnitId: "API",
				disposition: "compensate",
				dependsOnSteps: [],
				postRecoveryWorkUnit: unit("API", "api.mjs", [], "api-recovered"),
				operation: { kind: "compensate", ...compensationPatch() },
				externalEffects: [],
			},
		],
	};
	const path = resolve(fixture.root, `${recoveryPlanId}.proposal.json`);
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
	return path;
}

async function planned(fixture, recoveryPlanId, proposalOptions = {}) {
	const before = fingerprint(fixture.root);
	const proposalPath = proposalOptions.compensationOnly
		? await compensationOnlyProposal(fixture, recoveryPlanId)
		: fixture.join
			? await joinProposal(fixture, recoveryPlanId)
			: await proposal(fixture, recoveryPlanId, proposalOptions);
	const output = await createRecoveryPlan({
		repository: fixture.root,
		base: fixture.base,
		head: "HEAD",
		sourcePlanId: fixture.plan.planId,
		sourceBundleDigest: fixture.source.artifact.digest.value,
		proposalPath,
		acceptedBy: "Maintainer",
		repositoryIdentity: identity,
	});
	const repeated = await createRecoveryPlan({
		repository: fixture.root,
		base: fixture.base,
		head: "HEAD",
		sourcePlanId: fixture.plan.planId,
		sourceBundleDigest: fixture.source.artifact.digest.value,
		proposalPath,
		acceptedBy: "Maintainer",
		repositoryIdentity: identity,
	});
	assert.equal(repeated.impactArtifact.digest.value, output.impactArtifact.digest.value);
	assert.equal(repeated.planArtifact.digest.value, output.planArtifact.digest.value);
	await rm(proposalPath);
	assert.deepEqual(fingerprint(fixture.root), before);
	return output;
}

test("materializes an authorized mixed recovery branch, resumes, gates, and exports evidence", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const sourceBytes = await readFile(fixture.source.artifact.path, "utf8");
	const output = await planned(fixture, "recover-foundation");
	assertRecoveryImpactIntegrity(output.impact);
	assertRecoveryPlanIntegrity(output.impact, output.plan);
	assert.deepEqual(
		output.impact.affected.map((entry) => [entry.workUnitId, entry.role, entry.witnessPath]),
		[
			["FOUNDATION", "target", ["FOUNDATION"]],
			["API", "dependent", ["FOUNDATION", "API"]],
		],
	);
	assert.deepEqual(output.plan.executionOrder, ["FOUNDATION", "API"]);
	const caller = fingerprint(fixture.root);
	const partial = await applyRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizedBy: "Maintainer",
		maxSteps: 1,
	});
	assert.equal(partial.status, "partial");
	assert.deepEqual(fingerprint(fixture.root), caller);
	assert.equal(
		git(fixture.root, ["rev-parse", "refs/heads/grfs/recovery/recover-foundation"]),
		partial.head,
	);
	const status = await recoveryStatus({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
	});
	assert.equal(status.terminal, "partial");
	const cliStatus = spawnSync(
		process.execPath,
		[
			cli,
			"rollback",
			"status",
			"--repo",
			fixture.root,
			"--recovery-plan-id",
			output.plan.recoveryPlanId,
			"--plan-digest",
			output.planArtifact.digest.value,
			"--json",
		],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	assert.equal(cliStatus.status, 0, cliStatus.stderr || cliStatus.stdout);
	assert.equal(JSON.parse(cliStatus.stdout).data.terminal, "partial");
	const resumed = await resumeRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizationDigest: partial.authorizationArtifact.digest.value,
	});
	assert.equal(resumed.status, "complete");
	assert.equal(
		git(fixture.root, ["show", `${resumed.head}:api.mjs`]),
		'export function applyApi(value) { value.state("api-recovered", { name: "api-recovered" }); }',
	);
	const recoveredSnapshot = await createRepositoryBlueprintSnapshot({
		repository: fixture.root,
		revision: resumed.head,
	});
	assert.ok(
		JSON.stringify(recoveredSnapshot.blueprint).includes("api-recovered"),
		JSON.stringify(recoveredSnapshot.blueprint, null, 2),
	);
	assert.equal(
		resumed.result.outcome,
		"recovered",
		JSON.stringify(resumed.result.postRecoveryBundle.gateResult, null, 2),
	);
	assert.equal(resumed.result.postRecoveryBundle.gateResult.verdict, "pass");
	assertRecoveryResultIntegrity(resumed.result);
	assert.deepEqual(fingerprint(fixture.root), caller);
	assert.equal(await readFile(fixture.source.artifact.path, "utf8"), sourceBytes);
	const exportPath = resolve(fixture.root, "recovery.bundle.json");
	const exported = await exportRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		resultDigest: resumed.artifact.digest.value,
		output: exportPath,
	});
	assert.equal((await verifyRecoveryExport(exportPath)).digest.value, exported.digest.value);
	const cliVerify = spawnSync(
		process.execPath,
		[cli, "rollback", "verify", "--bundle", exportPath, "--json"],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	assert.equal(cliVerify.status, 0, cliVerify.stderr || cliVerify.stdout);
	assert.equal(JSON.parse(cliVerify.stdout).data.digest.value, exported.digest.value);
	const forged = structuredClone(resumed.result);
	forged.impact.affected.reverse();
	assert.throws(() => assertRecoveryResultIntegrity(forged), RecoveryIntegrityError);
	const wrongQualifiedPlan = structuredClone(resumed.result);
	wrongQualifiedPlan.impact.targets[0].planId = "another-plan";
	assert.throws(() => assertRecoveryResultIntegrity(wrongQualifiedPlan), RecoveryIntegrityError);
	const translated = structuredClone(resumed.result);
	translated.outcome = "blocked";
	assert.throws(() => assertRecoveryResultIntegrity(translated), RecoveryIntegrityError);
	const widened = structuredClone(resumed.result);
	widened.authorization.recoveryRef = "refs/heads/main";
	assert.throws(() => assertRecoveryResultIntegrity(widened), RecoveryIntegrityError);
	const forgedReceipt = structuredClone(resumed.result);
	const appliedAttempt = forgedReceipt.attempts.find((entry) => entry.status === "step-applied");
	appliedAttempt.observedAfter = structuredClone(forgedReceipt.plan.expectedHead);
	assert.throws(() => assertRecoveryResultIntegrity(forgedReceipt), RecoveryIntegrityError);
	const reordered = structuredClone(resumed.result);
	const partialAttempt = reordered.attempts.find((entry) => entry.status === "partial");
	partialAttempt.status = "branch-created";
	for (let index = 0; index < reordered.attempts.length; index += 1) {
		const previous = reordered.attempts[index - 1];
		reordered.attempts[index].sequence = index;
		reordered.attempts[index].previousAttemptDigest =
			previous === undefined ? null : { algorithm: "sha256", value: sha256Jcs(previous) };
	}
	assert.throws(() => assertRecoveryResultIntegrity(reordered), RecoveryIntegrityError);
	const changedProposal = structuredClone(resumed.result);
	changedProposal.plan.proposal.proposalSource = "codex";
	assert.throws(() => assertRecoveryResultIntegrity(changedProposal), RecoveryIntegrityError);
});

test("abort is append-only and preserves the partial recovery branch", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const output = await planned(fixture, "recover-abort");
	const caller = fingerprint(fixture.root);
	const partial = await applyRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizedBy: "Maintainer",
		maxSteps: 1,
	});
	const aborted = await abortRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizationDigest: partial.authorizationArtifact.digest.value,
	});
	assert.equal(aborted.branchPreserved, true);
	assert.equal(aborted.attempts.at(-1).status, "aborted");
	assert.equal(git(fixture.root, ["rev-parse", aborted.recoveryRef]), aborted.head);
	assert.deepEqual(fingerprint(fixture.root), caller);
	await assert.rejects(
		resumeRecovery({
			repository: fixture.root,
			recoveryPlanId: output.plan.recoveryPlanId,
			planDigest: output.planArtifact.digest.value,
			authorizationDigest: partial.authorizationArtifact.digest.value,
		}),
		(error) => error instanceof RecoveryRunnerError && error.code === "RECOVERY_TERMINAL",
	);
});

test("recovers one branch of a clean binary join while preserving the unaffected branch", async (t) => {
	const fixture = await repository({ join: true });
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	assert.equal(fixture.source.topology.joins.length, 1);
	const output = await planned(fixture, "recover-joined-foundation");
	assert.deepEqual(
		output.impact.affected.map((entry) => entry.workUnitId),
		["FOUNDATION"],
	);
	assert.deepEqual(
		output.impact.unaffected.map((entry) => entry.workUnitId),
		["API"],
	);
	const caller = fingerprint(fixture.root);
	const applied = await applyRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizedBy: "Maintainer",
	});
	assert.equal(applied.status, "complete");
	assert.equal(applied.result.outcome, "recovered");
	assert.equal(applied.result.sharedTopology.joins.length, 1);
	assert.equal(applied.result.postRecoveryBundle.gateResult.verdict, "pass");
	assertRecoveryResultIntegrity(applied.result);
	assert.deepEqual(fingerprint(fixture.root), caller);
});

test("materializes a pure compensation without changing the unaffected join branch", async (t) => {
	const fixture = await repository({ join: true });
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const output = await planned(fixture, "compensate-joined-api", { compensationOnly: true });
	assert.deepEqual(output.plan.executionOrder, ["API"]);
	assert.deepEqual(
		output.impact.unaffected.map((entry) => entry.workUnitId),
		["FOUNDATION"],
	);
	const caller = fingerprint(fixture.root);
	const applied = await applyRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizedBy: "Maintainer",
	});
	assert.equal(applied.status, "complete");
	assert.equal(applied.result.outcome, "recovered");
	assert.equal(applied.result.postRecoveryBundle.gateResult.verdict, "pass");
	assertRecoveryResultIntegrity(applied.result);
	assert.deepEqual(fingerprint(fixture.root), caller);
});

test("keeps semantic recovery blocked when an external compensation remains unresolved", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const output = await planned(fixture, "recover-external", {
		externalStatus: "unresolved",
	});
	const applied = await applyRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizedBy: "Maintainer",
	});
	assert.equal(applied.status, "complete");
	assert.equal(applied.result.postRecoveryBundle.gateResult.verdict, "pass");
	assert.equal(applied.result.externalEffectsResolved, false);
	assert.equal(applied.result.outcome, "blocked");
	assertRecoveryResultIntegrity(applied.result);
});

test("records an inverse conflict as a resumable failed step without moving the caller", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await commitFile(
		fixture.root,
		"foundation.mjs",
		'export function applyFoundation(value) { value.state("foundation-v2", { name: "foundation-v2" }); }\n',
		"later transport changes foundation",
	);
	fixture.source = await createDagSemanticGate({
		repository: fixture.root,
		base: fixture.base,
		head: "HEAD",
		planId: fixture.plan.planId,
		repositoryIdentity: identity,
	});
	assert.equal(fixture.source.gateResult.verdict, "pass");
	const output = await planned(fixture, "recover-conflict");
	const caller = fingerprint(fixture.root);
	const partial = await applyRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizedBy: "Maintainer",
	});
	assert.equal(partial.status, "partial");
	assert.equal(partial.attempts.at(-1).status, "step-failed");
	assert.match(partial.failure, /patch|apply|does not apply/iu);
	assert.deepEqual(fingerprint(fixture.root), caller);
	assert.equal(git(fixture.root, ["rev-parse", partial.recoveryRef]), partial.head);
});

test("fails closed on caller drift and forged authorization without creating a recovery ref", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const output = await planned(fixture, "recover-drift");
	await commitFile(fixture.root, "note.md", "moved\n", "move caller head");
	await assert.rejects(
		applyRecovery({
			repository: fixture.root,
			recoveryPlanId: output.plan.recoveryPlanId,
			planDigest: output.planArtifact.digest.value,
			authorizedBy: "Maintainer",
		}),
		(error) => error instanceof RecoveryRunnerError && error.code === "RECOVERY_REF_CONFLICT",
	);
	git(fixture.root, ["rev-parse", "--verify", "refs/heads/grfs/recovery/recover-drift"], [128]);
	await assert.rejects(
		resumeRecovery({
			repository: fixture.root,
			recoveryPlanId: output.plan.recoveryPlanId,
			planDigest: output.planArtifact.digest.value,
			authorizationDigest: "0".repeat(64),
		}),
		(error) => error instanceof RecoveryRunnerError && error.code === "RECOVERY_STATE_INVALID",
	);
});

test("rejects mismatched repository identity, unsupported effect evidence, and unsafe local state", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const mismatchPath = await proposal(fixture, "recover-wrong-repository");
	await assert.rejects(
		createRecoveryPlan({
			repository: fixture.root,
			base: fixture.base,
			head: "HEAD",
			sourcePlanId: fixture.plan.planId,
			sourceBundleDigest: fixture.source.artifact.digest.value,
			proposalPath: mismatchPath,
			acceptedBy: "Maintainer",
			repositoryIdentity: { ...identity, name: "another-repository" },
		}),
		(error) => error instanceof RecoveryRunnerError && error.code === "RECOVERY_PLAN_INVALID",
	);
	await rm(mismatchPath);

	const evidencePath = await proposal(fixture, "recover-invalid-effect", {
		externalStatus: "resolved",
	});
	await assert.rejects(
		createRecoveryPlan({
			repository: fixture.root,
			base: fixture.base,
			head: "HEAD",
			sourcePlanId: fixture.plan.planId,
			sourceBundleDigest: fixture.source.artifact.digest.value,
			proposalPath: evidencePath,
			acceptedBy: "Maintainer",
			repositoryIdentity: identity,
		}),
		(error) => error instanceof RecoveryRunnerError && error.code === "RECOVERY_PLAN_INVALID",
	);
	await rm(evidencePath);

	const output = await planned(fixture, "recover-unsafe-state");
	const partial = await applyRecovery({
		repository: fixture.root,
		recoveryPlanId: output.plan.recoveryPlanId,
		planDigest: output.planArtifact.digest.value,
		authorizedBy: "Maintainer",
		maxSteps: 1,
	});
	const attemptsDirectory = resolve(
		fixture.root,
		".git",
		"grfs",
		"recoveries",
		output.plan.recoveryPlanId,
		"attempts",
	);
	await symlink(partial.authorizationArtifact.path, resolve(attemptsDirectory, "unexpected.json"));
	await assert.rejects(
		recoveryStatus({
			repository: fixture.root,
			recoveryPlanId: output.plan.recoveryPlanId,
			planDigest: output.planArtifact.digest.value,
		}),
		(error) => error instanceof RecoveryRunnerError && error.code === "RECOVERY_STATE_INVALID",
	);
});
