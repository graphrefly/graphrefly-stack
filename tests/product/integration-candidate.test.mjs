import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	assembleIntegrationCandidate,
	assembleIntegrationFailureCandidate,
	evaluateIsolatedGraphCandidate,
	IntegrationCandidateError,
	withIsolatedGitCandidate,
} from "../../packages/cli/dist/integration-candidate.js";
import { assertIntegrationIntegrity, sha256Jcs } from "../../packages/contracts/dist/index.js";
import { evaluateIntegrationEffects } from "../../packages/core/dist/index.js";

const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));

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

async function commitFile(repository, path, content, subject) {
	await writeFile(resolve(repository, path), content);
	git(repository, ["add", path]);
	git(repository, ["commit", "-m", subject]);
	return git(repository, ["rev-parse", "HEAD"]);
}

async function createDivergedRepository(root) {
	const repository = resolve(root, "repository");
	await mkdir(repository);
	git(repository, ["init", "-b", "main"]);
	const base = await commitFile(repository, "base.txt", "base\n", "base");
	git(repository, ["switch", "-c", "target"]);
	const target = await commitFile(repository, "target.txt", "target\n", "target");
	git(repository, ["switch", "-c", "head", base]);
	const head = await commitFile(repository, "head.txt", "head\n", "head");
	return { repository, base, target, head };
}

async function createGraphRepository(root) {
	const repository = resolve(root, "graph-repository");
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
				name: "integration-graph",
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
	const base = git(repository, ["rev-parse", "HEAD"]);
	git(repository, ["switch", "-c", "target"]);
	const target = await commitFile(
		repository,
		"target.mjs",
		'export function applyTarget(value) { value.state(2, { name: "target" }); }\n',
		"target graph",
	);
	git(repository, ["switch", "-c", "head", base]);
	const head = await commitFile(
		repository,
		"head.mjs",
		'export function applyHead(value) { value.state(3, { name: "head" }); }\n',
		"head graph",
	);
	return { repository, base, target, head };
}

function sourceFingerprint(repository) {
	return {
		head: git(repository, ["rev-parse", "HEAD"]),
		status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
		refs: git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
		objects: git(repository, ["count-objects", "-v"]),
	};
}

test("isolated candidate uses a real three-way tree without changing source state", async (context) => {
	const root = await mkdtemp(resolve(tmpdir(), "grfs-integration-test-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await createDivergedRepository(root);
	const before = sourceFingerprint(fixture.repository);
	let isolatedRepository;
	const result = await withIsolatedGitCandidate(
		{ repository: fixture.repository, target: fixture.target, head: fixture.head },
		async (candidate) => {
			isolatedRepository = candidate.isolatedRepository;
			assert.notEqual(candidate.isolatedRepository, candidate.sourceRepository);
			assert.equal(candidate.mergeBase.value, fixture.base);
			assert.equal(candidate.target.value, fixture.target);
			assert.equal(candidate.head.value, fixture.head);
			assert.equal(candidate.mergeAlgorithm, "git-ort-three-way");
			assert.equal(candidate.mergeRevision, "v1");
			assert.deepEqual(
				git(candidate.isolatedRepository, [
					"ls-tree",
					"-r",
					"--name-only",
					candidate.tree.value,
				]).split("\n"),
				["base.txt", "head.txt", "target.txt"],
			);
			return candidate.tree.value;
		},
	);
	assert.equal(result.length, fixture.target.length);
	assert.deepEqual(sourceFingerprint(fixture.repository), before);
	await assert.rejects(access(isolatedRepository));
});

test("isolated candidate reports text conflict and rejects merge-containing head range", async (context) => {
	const root = await mkdtemp(resolve(tmpdir(), "grfs-integration-failures-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await createDivergedRepository(root);

	git(fixture.repository, ["switch", "target"]);
	const targetConflict = await commitFile(
		fixture.repository,
		"base.txt",
		"target\n",
		"target conflict",
	);
	git(fixture.repository, ["switch", "head"]);
	const headConflict = await commitFile(fixture.repository, "base.txt", "head\n", "head conflict");
	let textConflict;
	await assert.rejects(
		withIsolatedGitCandidate(
			{ repository: fixture.repository, target: targetConflict, head: headConflict },
			async () => undefined,
		),
		(error) => {
			textConflict = error;
			return error instanceof IntegrationCandidateError && error.code === "TEXT_CONFLICT";
		},
	);
	assert.deepEqual(textConflict.context.conflictPaths, ["base.txt"]);
	assert.deepEqual(textConflict.context.topology, {
		mergeBase: "unique",
		headRange: "linear",
	});
	assert.equal(textConflict.context.merge.status, "conflict");
	const hash = (value) => ({ algorithm: "sha256", value: value.repeat(64) });
	const failureCandidate = await assembleIntegrationFailureCandidate({
		context: textConflict.context,
		repository: { provider: "github", owner: "graphrefly", name: "integration" },
		runtimeVersion: "0.3.0",
		planDigest: hash("a"),
		policyDigest: hash("b"),
		headGate: { inputDigest: hash("c"), resultDigest: hash("d"), verdict: "pass" },
		reasonCode: "TEXT_CONFLICT",
	});
	assert.equal(failureCandidate.status, "conflict");
	assert.equal(failureCandidate.merge.tree, null);
	assert.equal(failureCandidate.evidence.candidateBlueprint, null);

	git(fixture.repository, ["switch", "-c", "side", fixture.head]);
	await commitFile(fixture.repository, "side.txt", "side\n", "side");
	git(fixture.repository, ["switch", "head"]);
	git(fixture.repository, ["merge", "--no-ff", "side", "-m", "merge side"]);
	const mergeHead = git(fixture.repository, ["rev-parse", "HEAD"]);
	await assert.rejects(
		withIsolatedGitCandidate(
			{ repository: fixture.repository, target: fixture.target, head: mergeHead },
			async () => undefined,
		),
		(error) =>
			error instanceof IntegrationCandidateError &&
			error.code === "HEAD_RANGE_NON_LINEAR" &&
			error.context.topology.headRange === "non-linear",
	);
});

test("symbolic target movement invalidates candidate before return", async (context) => {
	const root = await mkdtemp(resolve(tmpdir(), "grfs-integration-stale-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await createDivergedRepository(root);
	await assert.rejects(
		withIsolatedGitCandidate(
			{ repository: fixture.repository, target: "target", head: fixture.head },
			async () => {
				git(fixture.repository, ["branch", "-f", "target", fixture.base]);
			},
		),
		(error) =>
			error instanceof IntegrationCandidateError &&
			error.code === "TARGET_MOVED" &&
			error.context.observedRevisions.target.value === fixture.base &&
			error.context.revisions.target.value === fixture.target,
	);
});

test("isolated candidate derives verified four-revision Blueprints and both upstream deltas", async (context) => {
	const root = await mkdtemp(resolve(tmpdir(), "grfs-integration-graph-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const fixture = await createGraphRepository(root);
	const before = sourceFingerprint(fixture.repository);
	const { evidence, artifact } = await withIsolatedGitCandidate(
		{ repository: fixture.repository, target: fixture.target, head: fixture.head },
		async (gitCandidate) => {
			const evidence = await evaluateIsolatedGraphCandidate(gitCandidate);
			const hash = (value) => ({ algorithm: "sha256", value: value.repeat(64) });
			return {
				evidence,
				artifact: await assembleIntegrationCandidate({
					git: gitCandidate,
					graph: evidence,
					repository: { provider: "github", owner: "graphrefly", name: "integration" },
					planDigest: hash("a"),
					policyDigest: hash("b"),
					headGate: {
						inputDigest: hash("c"),
						resultDigest: hash("d"),
						verdict: "pass",
					},
				}),
			};
		},
	);
	assert.equal(evidence.graphreflyVersion, "0.3.0");
	assert.notEqual(evidence.base.blueprintHash.value, evidence.target.blueprintHash.value);
	assert.notEqual(evidence.base.blueprintHash.value, evidence.head.blueprintHash.value);
	assert.match(JSON.stringify(evidence.candidate.blueprint), /target/u);
	assert.match(JSON.stringify(evidence.candidate.blueprint), /head/u);
	assert.match(JSON.stringify(evidence.targetDelta.delta), /target/u);
	assert.match(JSON.stringify(evidence.headDelta.delta), /head/u);
	assert.match(evidence.targetDelta.digest.value, /^[0-9a-f]{64}$/u);
	assert.match(evidence.headDelta.digest.value, /^[0-9a-f]{64}$/u);
	assert.match(JSON.stringify(evidence.candidateDelta.delta), /target/u);
	assert.match(JSON.stringify(evidence.candidateDelta.delta), /head/u);
	assert.equal(artifact.evidence.candidateBlueprint.revision.value, artifact.merge.tree.value);
	assert.equal(artifact.evidence.targetDelta.deltaDigest.value, evidence.targetDelta.digest.value);
	const effects = evaluateIntegrationEffects({
		targetDelta: evidence.targetDelta.delta,
		headDelta: evidence.headDelta.delta,
		candidateDelta: evidence.candidateDelta.delta,
	});
	assert.deepEqual(effects, { reasonCodes: [], overlaps: [], conflicts: [] });
	const result = {
		schema: "graphrefly.stack.integration-result.v1",
		candidateDigest: { algorithm: "sha256", value: sha256Jcs(artifact) },
		observedRevisions: { target: artifact.revisions.target, head: artifact.revisions.head },
		outcome: "compatible",
		reasonCodes: effects.reasonCodes,
		overlaps: effects.overlaps,
		conflicts: effects.conflicts,
	};
	assertIntegrationIntegrity(artifact, result);
	assert.deepEqual(sourceFingerprint(fixture.repository), before);
});
