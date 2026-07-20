import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDagSemanticGate } from "../../packages/cli/dist/dag-semantic-runner.js";
import { createRepositoryBlueprintSnapshot } from "../../packages/cli/dist/repository-review.js";
import { createDagSelectiveRecovery } from "../../packages/cli/dist/selective-recovery-runner.js";
import {
	assertDagSelectiveRecoveryIntegrity,
	SelectiveRecoveryIntegrityError,
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
	assert.ok(allowed.includes(result.status ?? 1), result.stderr);
	return result.stdout.trim();
}

async function commitFile(repository, path, content, subject, workUnitId, planId) {
	await writeFile(resolve(repository, path), content);
	git(repository, ["add", path]);
	const args = ["commit", "-m", subject];
	if (workUnitId !== undefined && planId !== undefined) {
		args.push("-m", `GraphReFly-Plan: ${planId}\nGraphReFly-Work-Unit: ${workUnitId}`);
	}
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

function unit(id, path, dependencies, nodeId, intent) {
	return {
		id,
		title: `${id} implementation`,
		intent,
		dependencies,
		allowedSourceScopes: [path],
		capabilities: ["graph-change"],
		claims: [
			{
				id: `${id.toLowerCase()}-present`,
				predicate: { operator: "present", selector: { kind: "node", nodeId } },
				rationale: `${nodeId} must be present`,
			},
		],
		requiredChecks: ["contract"],
	};
}

async function recoveryRepository() {
	const root = await mkdtemp(resolve(tmpdir(), "graphrefly-dag-recovery-"));
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
				name: "dag-recovery-fixture",
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
  const value = graph({ name: "dag-recovery" });
  value.state("base", { name: "base" });
  applyRight(value);
  applyLeft(value);
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
	const base = git(root, ["rev-parse", "HEAD"]);
	const baseSnapshot = await createRepositoryBlueprintSnapshot({
		repository: root,
		revision: base,
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
	await mkdir(resolve(root, ".graphrefly-stack/plans"), { recursive: true });
	await writeFile(
		resolve(root, ".graphrefly-stack/policy.json"),
		`${JSON.stringify(policy, null, 2)}\n`,
	);
	git(root, ["add", ".graphrefly-stack/policy.json"]);
	git(root, ["commit", "-m", "install policy"]);
	const sourcePlan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: "plan-source",
		taskDigest: { algorithm: "sha256", value: sha256Jcs({ task: "selective recovery" }) },
		taskSummary: "Implement a dependent graph stack",
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
			{
				...unit("RIGHT", "right.mjs", [], "never-right", "Preserve the right foundation"),
				claims: [
					{
						id: "right-absence",
						predicate: {
							operator: "absent",
							selector: { kind: "node", nodeId: "never-right" },
						},
						rationale: "The forbidden right node remains absent",
					},
				],
			},
			unit("LEFT", "left.mjs", ["RIGHT"], "never-left", "Deliberately block the left unit"),
		],
	};
	await writeFile(
		resolve(root, ".graphrefly-stack/plans/plan-source.json"),
		`${JSON.stringify(sourcePlan, null, 2)}\n`,
	);
	git(root, ["add", ".graphrefly-stack/plans/plan-source.json"]);
	git(root, ["commit", "-m", "accept source plan"]);
	const accepted = git(root, ["rev-parse", "HEAD"]);
	const rightCommit = await commitFile(
		root,
		"right.mjs",
		'export function applyRight(value) { value.state("right-node", { name: "right" }); }\n',
		"implement right",
		"RIGHT",
		"plan-source",
	);
	const leftCommit = await commitFile(
		root,
		"left.mjs",
		'export function applyLeft(value) { value.state("source-left", { name: "source left" }); }\n',
		"implement invalid left",
		"LEFT",
		"plan-source",
	);
	git(root, ["branch", "source-blocked"]);
	return { root, base, accepted, rightCommit, leftCommit, sourcePlan, policy };
}

test("keeps implementation change fresh and selective Plan recovery explicit", async (t) => {
	const fixture = await recoveryRepository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const source = await createDagSemanticGate({
		repository: fixture.root,
		base: fixture.base,
		head: "source-blocked",
		planId: "plan-source",
		repositoryIdentity: identity,
	});
	assert.equal(source.gateResult.verdict, "blocked");
	assert.deepEqual(
		source.gateResult.units.map((entry) => [entry.workUnitId, entry.verdict]),
		[
			["RIGHT", "valid"],
			["LEFT", "invalid"],
		],
	);
	const sourceBytes = await readFile(source.artifact.path, "utf8");
	const sourceBindings = new Map(source.bindings.map((entry) => [entry.workUnitId, entry]));
	const sourceRecords = new Map(source.records.map((entry) => [entry.workUnitId, entry]));

	git(fixture.root, ["switch", "-q", "-c", "implementation-change", fixture.rightCommit]);
	await commitFile(
		fixture.root,
		"left.mjs",
		'export function applyLeft(value) { value.state("never-left", { name: "never-left" }); }\n',
		"change left implementation",
		"LEFT",
		"plan-source",
	);
	const changedBefore = fingerprint(fixture.root);
	const changed = await createDagSemanticGate({
		repository: fixture.root,
		base: fixture.base,
		head: "implementation-change",
		planId: "plan-source",
		repositoryIdentity: identity,
	});
	assert.equal(changed.gateResult.verdict, "pass");
	const changedBindings = new Map(changed.bindings.map((entry) => [entry.workUnitId, entry]));
	const changedRecords = new Map(changed.records.map((entry) => [entry.workUnitId, entry]));
	assert.deepEqual(changedBindings.get("RIGHT"), sourceBindings.get("RIGHT"));
	assert.deepEqual(changedRecords.get("RIGHT"), sourceRecords.get("RIGHT"));
	assert.notEqual(
		changedBindings.get("LEFT").commit.value,
		sourceBindings.get("LEFT").commit.value,
	);
	assert.equal(changedBindings.get("LEFT").rebindFrom, null);
	assert.equal(changedRecords.get("LEFT").rebindFrom, null);
	assert.notEqual(sha256Jcs(changedRecords.get("LEFT")), sha256Jcs(sourceRecords.get("LEFT")));
	assert.deepEqual(fingerprint(fixture.root), changedBefore);

	git(fixture.root, ["switch", "-q", "source-blocked"]);
	const sourceHead = git(fixture.root, ["rev-parse", "HEAD"]);
	const sourceHeadSnapshot = await createRepositoryBlueprintSnapshot({
		repository: fixture.root,
		revision: sourceHead,
	});
	const replacementPlan = {
		...structuredClone(fixture.sourcePlan),
		planId: "plan-replacement",
		baseCommit: { algorithm: "sha1", value: sourceHead },
		baseBlueprintHash: sourceHeadSnapshot.blueprintHash,
		workUnits: [
			structuredClone(fixture.sourcePlan.workUnits[0]),
			unit(
				"LEFT",
				"left.mjs",
				["RIGHT"],
				"replacement-left",
				"Replace only the invalid left intent",
			),
		],
	};
	const selectiveReplan = {
		schema: "graphrefly.stack.semantic-selective-replan.v1",
		sourcePlanId: "plan-source",
		replacementPlanId: "plan-replacement",
		preservedUnits: ["RIGHT"],
		invalidUnits: ["LEFT"],
		contextManifestDigest: {
			algorithm: "sha256",
			value: sha256Jcs({ sourcePlanId: "plan-source", replacementPlanId: "plan-replacement" }),
		},
		proposalSource: "human",
	};
	await Promise.all([
		writeFile(
			resolve(fixture.root, ".graphrefly-stack/plans/plan-replacement.json"),
			`${JSON.stringify(replacementPlan, null, 2)}\n`,
		),
		writeFile(
			resolve(fixture.root, ".graphrefly-stack/plans/plan-replacement.replan.json"),
			`${JSON.stringify(selectiveReplan, null, 2)}\n`,
		),
	]);
	git(fixture.root, ["add", ".graphrefly-stack/plans"]);
	git(fixture.root, ["commit", "-m", "accept selective replacement plan"]);
	const replacementCommit = await commitFile(
		fixture.root,
		"left.mjs",
		'export function applyLeft(value) { value.state("replacement-left", { name: "replacement-left" }); }\n',
		"implement replacement left",
		"LEFT",
		"plan-replacement",
	);
	const recoveryBefore = fingerprint(fixture.root);
	const recovery = await createDagSelectiveRecovery({
		repository: fixture.root,
		head: "HEAD",
		sourcePlanId: "plan-source",
		replacementPlanId: "plan-replacement",
		sourceBundleDigest: source.artifact.digest.value,
		repositoryIdentity: identity,
	});
	assertDagSelectiveRecoveryIntegrity(recovery);
	assert.equal(recovery.replacementBundle.gateResult.verdict, "pass");
	assert.deepEqual(
		recovery.lineage.map((entry) => [entry.workUnitId, entry.disposition]),
		[
			["RIGHT", "preserved"],
			["LEFT", "replaced"],
		],
	);
	const effective = new Map(
		recovery.effectiveTopology.objects.map((entry) => [entry.oid.value, entry]),
	);
	assert.equal(effective.get(fixture.rightCommit).kind, "implementation");
	assert.equal(effective.get(fixture.leftCommit).kind, "transport");
	assert.equal(effective.get(replacementCommit).kind, "implementation");
	const replacementBindings = new Map(
		recovery.replacementBundle.bindings.map((entry) => [entry.workUnitId, entry]),
	);
	assert.equal(replacementBindings.get("RIGHT").commit.value, fixture.rightCommit);
	assert.equal(replacementBindings.get("LEFT").commit.value, replacementCommit);
	assert.ok(recovery.replacementBundle.bindings.every((entry) => entry.rebindFrom === null));
	assert.ok(recovery.replacementBundle.records.every((entry) => entry.rebindFrom === null));
	const commonDirectory = git(fixture.root, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	await assert.rejects(
		readdir(resolve(commonDirectory, "grfs/dag-gates/plan-replacement")),
		(error) => error.code === "ENOENT",
		"the nested replacement gate is persisted only inside the verified sidecar",
	);
	assert.equal(await readFile(source.artifact.path, "utf8"), sourceBytes);
	assert.deepEqual(fingerprint(fixture.root), recoveryBefore);

	const persistedBytes = await readFile(recovery.artifact.path, "utf8");
	assert.equal(sha256Jcs(JSON.parse(persistedBytes)), recovery.artifact.digest.value);
	const repeated = await createDagSelectiveRecovery({
		repository: fixture.root,
		head: "HEAD",
		sourcePlanId: "plan-source",
		replacementPlanId: "plan-replacement",
		sourceBundleDigest: source.artifact.digest.value,
		repositoryIdentity: identity,
	});
	assert.equal(repeated.artifact.digest.value, recovery.artifact.digest.value);
	assert.equal(await readFile(recovery.artifact.path, "utf8"), persistedBytes);
	const cliRun = spawnSync(
		process.execPath,
		[
			cli,
			"gate",
			"--repo",
			fixture.root,
			"--base",
			fixture.base,
			"--head",
			"HEAD",
			"--plan-id",
			"plan-replacement",
			"--source-plan-id",
			"plan-source",
			"--source-bundle-digest",
			source.artifact.digest.value,
			"--provider",
			"github",
			"--owner",
			"clfhhc",
			"--name",
			"test-graphrefly",
			"--json",
		],
		{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	assert.equal(cliRun.status, 0, cliRun.stderr || cliRun.stdout);
	assert.equal(
		JSON.parse(cliRun.stdout).data.artifact.digest.value,
		recovery.artifact.digest.value,
	);

	const forgedLineage = structuredClone(recovery);
	delete forgedLineage.artifact;
	forgedLineage.lineage.reverse();
	assert.throws(
		() => assertDagSelectiveRecoveryIntegrity(forgedLineage),
		SelectiveRecoveryIntegrityError,
	);
	const forgedProjection = structuredClone(recovery);
	delete forgedProjection.artifact;
	forgedProjection.effectiveTopology.objects.find(
		(entry) => entry.oid.value === fixture.leftCommit,
	).kind = "implementation";
	assert.throws(
		() => assertDagSelectiveRecoveryIntegrity(forgedProjection),
		SelectiveRecoveryIntegrityError,
	);
	const forgedSourceBase = structuredClone(recovery);
	delete forgedSourceBase.artifact;
	forgedSourceBase.sourcePlan.baseCommit = forgedSourceBase.sharedTopology.head;
	assert.throws(
		() => assertDagSelectiveRecoveryIntegrity(forgedSourceBase),
		SelectiveRecoveryIntegrityError,
	);
	const forgedOwner = structuredClone(recovery);
	delete forgedOwner.artifact;
	forgedOwner.qualifiedCommits.find((entry) => entry.commit.value === fixture.rightCommit).planId =
		"plan-unrelated";
	assert.throws(
		() => assertDagSelectiveRecoveryIntegrity(forgedOwner),
		SelectiveRecoveryIntegrityError,
	);
	const forgedPartition = structuredClone(recovery);
	delete forgedPartition.artifact;
	forgedPartition.selectiveReplan.preservedUnits = ["LEFT"];
	forgedPartition.selectiveReplan.invalidUnits = ["RIGHT"];
	assert.throws(
		() => assertDagSelectiveRecoveryIntegrity(forgedPartition),
		SelectiveRecoveryIntegrityError,
	);
});
