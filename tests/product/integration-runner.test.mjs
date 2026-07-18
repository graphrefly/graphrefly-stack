import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runIntegration } from "../../packages/cli/dist/integration-runner.js";
import { createSemanticPlan } from "../../packages/cli/dist/semantic-repository.js";

const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const cli = fileURLToPath(new URL("../../packages/cli/dist/cli.js", import.meta.url));

function git(repository, args) {
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
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

async function commitFile(repository, path, content, subject, workUnitId) {
	await writeFile(resolve(repository, path), content);
	git(repository, ["add", path]);
	const args = ["commit", "-m", subject];
	if (workUnitId !== undefined) args.push("-m", `GraphReFly-Work-Unit: ${workUnitId}`);
	git(repository, args);
	return git(repository, ["rev-parse", "HEAD"]);
}

function sourceFingerprint(repository) {
	return {
		head: git(repository, ["rev-parse", "HEAD"]),
		status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
		refs: git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
		objects: git(repository, ["count-objects", "-v"]),
	};
}

async function createFixture(root) {
	const repository = resolve(root, "repository");
	await mkdir(repository);
	git(repository, ["init", "-b", "main"]);
	await Promise.all([
		writeFile(
			resolve(repository, ".graphrefly-stack.json"),
			`${JSON.stringify({
				schema: "graphrefly.stack.repository.v1",
				blueprint: { entrypoint: "graphrefly-stack.blueprint.mjs" },
			})}\n`,
		),
		writeFile(
			resolve(repository, "package.json"),
			`${JSON.stringify({
				name: "integration-runner-fixture",
				private: true,
				type: "module",
				dependencies: { "@graphrefly/ts": "0.3.x" },
			})}\n`,
		),
		writeFile(
			resolve(repository, "pnpm-lock.yaml"),
			"lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      '@graphrefly/ts':\n        specifier: 0.3.x\n        version: 0.3.0\n",
		),
		writeFile(
			resolve(repository, "graphrefly-stack.blueprint.mjs"),
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
			resolve(repository, "graph.mjs"),
			`import { graph } from "@graphrefly/ts/graph";
import { applyTarget } from "./target.mjs";
import { applyHead } from "./head.mjs";
export function createGraph() {
  const value = graph({ name: "integration" });
  value.state(1, { name: "base" });
  applyTarget(value);
  applyHead(value);
  return value;
}
`,
		),
		writeFile(resolve(repository, "target.mjs"), "export function applyTarget() {}\n"),
		writeFile(resolve(repository, "head.mjs"), "export function applyHead() {}\n"),
		writeFile(resolve(repository, ".gitignore"), "node_modules\n"),
	]);
	await symlink(workspaceNodeModules, resolve(repository, "node_modules"), "dir");
	git(repository, ["add", "-A"]);
	git(repository, ["commit", "-m", "base graph"]);
	const policyPath = resolve(root, "policy.json");
	const proposalPath = resolve(root, "proposal.json");
	const policy = {
		schema: "graphrefly.stack.semantic-policy.v1",
		policyId: "repository-policy",
		revision: "rev-1",
		allowedSourceRoots: ["head.mjs", "graphrefly-stack.blueprint.mjs"],
		allowedCapabilities: ["graph-change"],
		checks: [
			{
				id: "contract",
				argv: ["node", "-e", "process.exit(0)"],
				timeoutMs: 10000,
				network: false,
				shell: false,
			},
		],
	};
	const proposal = {
		schema: "graphrefly.stack.semantic-plan-proposal.v1",
		planId: "integration-plan",
		proposalSource: "human",
		workUnits: [
			{
				id: "HEAD_GRAPH",
				title: "Add the contributor graph effect",
				intent: "Add one independent graph node on the contributor branch.",
				dependencies: [],
				allowedSourceScopes: ["head.mjs", "graphrefly-stack.blueprint.mjs"],
				capabilities: ["graph-change"],
				claims: [
					{
						id: "base-present",
						predicate: { operator: "present", selector: { kind: "node", nodeId: "base" } },
						rationale: "The contributor change preserves the base node.",
					},
				],
				requiredChecks: ["contract"],
			},
		],
	};
	await Promise.all([
		writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`),
		writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`),
	]);
	await createSemanticPlan({
		repository,
		taskSummary: "Add a contributor graph effect",
		policyPath,
		proposalPath,
		mode: "replay",
		authorizeContext: false,
		accept: true,
		acceptedBy: "integration-test",
	});
	git(repository, ["add", ".graphrefly-stack"]);
	git(repository, ["commit", "-m", "accept integration plan"]);
	const mergeBase = git(repository, ["rev-parse", "HEAD"]);
	git(repository, ["switch", "-c", "target"]);
	const target = await commitFile(
		repository,
		"target.mjs",
		'export function applyTarget(value) { value.state(2, { name: "target" }); }\n',
		"add target graph effect",
	);
	git(repository, ["switch", "-c", "head", mergeBase]);
	const head = await commitFile(
		repository,
		"head.mjs",
		'export function applyHead(value) { value.state(3, { name: "head" }); }\n',
		"add contributor graph effect",
		"HEAD_GRAPH",
	);
	return { repository, mergeBase, target, head, policy };
}

test("repository-owned integration runner emits compatible bytes and policy invalidation", async (context) => {
	const root = await mkdtemp(resolve(tmpdir(), "grfs-integration-runner-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await createFixture(root);
	const identity = { provider: "github", owner: "graphrefly", name: "integration-runner" };
	const before = sourceFingerprint(fixture.repository);
	const compatible = await runIntegration({
		repository: fixture.repository,
		target: fixture.target,
		head: fixture.head,
		planId: "integration-plan",
		repositoryIdentity: identity,
	});
	assert.equal(compatible.result.outcome, "compatible");
	assert.deepEqual(compatible.result.reasonCodes, []);
	assert.equal(compatible.candidate.headGate.verdict, "pass");
	assert.deepEqual(sourceFingerprint(fixture.repository), before);
	const local = spawnSync(
		process.execPath,
		[
			cli,
			"integration",
			"--repo",
			fixture.repository,
			"--target",
			fixture.target,
			"--head",
			fixture.head,
			"--plan-id",
			"integration-plan",
			"--provider",
			identity.provider,
			"--owner",
			identity.owner,
			"--name",
			identity.name,
			"--json",
		],
		{ encoding: "utf8" },
	);
	assert.equal(local.status, 0, local.stderr || local.stdout);
	assert.deepEqual(JSON.parse(local.stdout).data, compatible);
	const eventPath = resolve(root, "pull-request.json");
	const ciOutput = resolve(root, "integration-ci.json");
	await writeFile(
		eventPath,
		`${JSON.stringify({
			repository: { name: identity.name, owner: { login: identity.owner } },
			pull_request: { base: { sha: fixture.target }, head: { sha: fixture.head } },
		})}\n`,
	);
	const ci = spawnSync(
		process.execPath,
		[
			cli,
			"integration",
			"ci",
			"--repo",
			fixture.repository,
			"--event",
			eventPath,
			"--output",
			ciOutput,
			"--json",
		],
		{ encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request" } },
	);
	assert.equal(ci.status, 0, ci.stderr || ci.stdout);
	assert.deepEqual(JSON.parse(await readFile(ciOutput, "utf8")), compatible);
	const ciEnvelope = JSON.parse(ci.stdout);
	assert.deepEqual(
		{ candidate: ciEnvelope.data.candidate, result: ciEnvelope.data.result },
		compatible,
	);

	git(fixture.repository, ["switch", "target"]);
	const stalePolicy = { ...fixture.policy, revision: "rev-2" };
	const staleTarget = await commitFile(
		fixture.repository,
		".graphrefly-stack/policy.json",
		`${JSON.stringify(stalePolicy, null, 2)}\n`,
		"update target policy",
	);
	const staleBefore = sourceFingerprint(fixture.repository);
	const invalidated = await runIntegration({
		repository: fixture.repository,
		target: staleTarget,
		head: fixture.head,
		planId: "integration-plan",
		repositoryIdentity: identity,
	});
	assert.equal(invalidated.result.outcome, "conflict");
	assert.deepEqual(invalidated.result.reasonCodes, ["POLICY_INVALIDATED"]);
	assert.deepEqual(sourceFingerprint(fixture.repository), staleBefore);

	git(fixture.repository, ["switch", "-c", "conflict-target", fixture.mergeBase]);
	const conflictTarget = await commitFile(
		fixture.repository,
		"head.mjs",
		'export function applyHead(value) { value.state(4, { name: "target-conflict" }); }\n',
		"create textual conflict",
	);
	const conflictBefore = sourceFingerprint(fixture.repository);
	const textConflict = await runIntegration({
		repository: fixture.repository,
		target: conflictTarget,
		head: fixture.head,
		planId: "integration-plan",
		repositoryIdentity: identity,
	});
	assert.equal(textConflict.result.outcome, "conflict");
	assert.deepEqual(textConflict.result.reasonCodes, ["TEXT_CONFLICT"]);
	assert.deepEqual(textConflict.result.conflicts[0].witness, {
		kind: "path",
		path: "head.mjs",
	});
	assert.deepEqual(sourceFingerprint(fixture.repository), conflictBefore);

	git(fixture.repository, ["switch", "-c", "execution-target", fixture.mergeBase]);
	const executionTarget = await commitFile(
		fixture.repository,
		"target.mjs",
		'export function applyTarget(value) { globalThis.__targetApplied = true; value.state(2, { name: "target" }); }\n',
		"add execution trigger",
	);
	git(fixture.repository, ["switch", "-c", "execution-head", fixture.mergeBase]);
	const executionHead = await commitFile(
		fixture.repository,
		"head.mjs",
		'export function applyHead(value) { if (globalThis.__targetApplied) for (;;) {} value.state(3, { name: "head" }); }\n',
		"add combined execution guard",
		"HEAD_GRAPH",
	);
	const executionFailure = await runIntegration({
		repository: fixture.repository,
		target: executionTarget,
		head: executionHead,
		planId: "integration-plan",
		repositoryIdentity: identity,
	});
	assert.equal(executionFailure.result.outcome, "error");
	assert.deepEqual(executionFailure.result.reasonCodes, ["CANDIDATE_EVALUATION_FAILED"]);

	git(fixture.repository, ["switch", "-c", "execution-recovery", fixture.mergeBase]);
	const recoveredHead = await commitFile(
		fixture.repository,
		"head.mjs",
		'export function applyHead(value) { value.state(3, { name: "head" }); }\n',
		"remove combined execution guard",
		"HEAD_GRAPH",
	);
	const recovered = await runIntegration({
		repository: fixture.repository,
		target: executionTarget,
		head: recoveredHead,
		planId: "integration-plan",
		repositoryIdentity: identity,
	});
	assert.equal(recovered.result.outcome, "compatible");
	assert.notDeepEqual(recovered.result.candidateDigest, executionFailure.result.candidateDigest);

	git(fixture.repository, ["switch", "-c", "blueprint-head", fixture.mergeBase]);
	await Promise.all([
		writeFile(
			resolve(fixture.repository, "head.mjs"),
			'export function applyHead(value) { value.state(3, { name: "head" }); }\n',
		),
		writeFile(
			resolve(fixture.repository, "graphrefly-stack.blueprint.mjs"),
			`import { createHash } from "node:crypto";
import { withBlueprintHash } from "@graphrefly/ts/graph";
import { createGraph } from "./graph.mjs";
const value = withBlueprintHash(createGraph().blueprint({ diagnostics: true }), {
  algorithm: "sha256",
  hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
});
if (globalThis.__targetApplied) value.hash.value = "0".repeat(64);
process.stdout.write(JSON.stringify(value));
`,
		),
	]);
	git(fixture.repository, ["add", "head.mjs", "graphrefly-stack.blueprint.mjs"]);
	git(fixture.repository, [
		"commit",
		"-m",
		"add combined Blueprint guard",
		"-m",
		"GraphReFly-Work-Unit: HEAD_GRAPH",
	]);
	const blueprintHead = git(fixture.repository, ["rev-parse", "HEAD"]);
	const blueprintFailure = await runIntegration({
		repository: fixture.repository,
		target: executionTarget,
		head: blueprintHead,
		planId: "integration-plan",
		repositoryIdentity: identity,
	});
	assert.equal(blueprintFailure.result.outcome, "conflict");
	assert.deepEqual(blueprintFailure.result.reasonCodes, ["CANDIDATE_BLUEPRINT_INVALID"]);

	git(fixture.repository, ["branch", "moving-head", recoveredHead]);
	const moveHead = setTimeout(() => {
		git(fixture.repository, ["branch", "-f", "moving-head", fixture.mergeBase]);
	}, 1000);
	const moved = await runIntegration({
		repository: fixture.repository,
		target: executionTarget,
		head: "moving-head",
		planId: "integration-plan",
		repositoryIdentity: identity,
	});
	clearTimeout(moveHead);
	assert.equal(moved.result.outcome, "error");
	assert.deepEqual(moved.result.reasonCodes, ["HEAD_MOVED"]);
	assert.equal(moved.result.observedRevisions.head.value, fixture.mergeBase);
});
