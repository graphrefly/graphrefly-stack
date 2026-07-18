import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
	IntegrationCandidateError,
	withIsolatedGitCandidate,
} from "../../packages/cli/dist/integration-candidate.js";

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
	await assert.rejects(
		withIsolatedGitCandidate(
			{ repository: fixture.repository, target: targetConflict, head: headConflict },
			async () => undefined,
		),
		(error) => error instanceof IntegrationCandidateError && error.code === "TEXT_CONFLICT",
	);

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
		(error) => error instanceof IntegrationCandidateError && error.code === "HEAD_RANGE_NON_LINEAR",
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
		(error) => error instanceof IntegrationCandidateError && error.code === "TARGET_MOVED",
	);
});
