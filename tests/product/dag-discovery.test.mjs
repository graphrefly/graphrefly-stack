import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DagDiscoveryError,
	discoverGitDag,
	discoverPlanQualifiedGitDag,
} from "../../packages/cli/dist/dag-discovery.js";

function git(repository, args, allowed = [0]) {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		shell: false,
	});
	if (!allowed.includes(result.status ?? 1)) {
		throw new Error(result.stderr || `git ${args[0]} failed`);
	}
	return (result.stdout ?? "").trim();
}

async function commitFile(repository, path, content, subject, workUnitIds = [], planIds = []) {
	await writeFile(join(repository, path), content);
	git(repository, ["add", path]);
	const args = ["commit", "-m", subject];
	const trailers = [
		...planIds.map((id) => `GraphReFly-Plan: ${id}`),
		...workUnitIds.map((id) => `GraphReFly-Work-Unit: ${id}`),
	];
	if (trailers.length > 0) args.push("-m", trailers.join("\n"));
	git(repository, args);
	return git(repository, ["rev-parse", "HEAD"]);
}

async function repository() {
	const root = await mkdtemp(join(tmpdir(), "graphrefly-dag-discovery-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "GraphReFly Test"]);
	git(root, ["config", "user.email", "test@example.invalid"]);
	const base = await commitFile(root, "base.txt", "base\n", "base");
	return { root, base };
}

test("discovers a real bounded branch and clean transport-only join without mutation", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	git(fixture.root, ["checkout", "-q", "-b", "left"]);
	await commitFile(fixture.root, "left.txt", "left\n", "left", ["LEFT"]);
	await commitFile(fixture.root, "acceptance.txt", "accepted\n", "plan acceptance");
	git(fixture.root, ["checkout", "-q", "-b", "right", fixture.base]);
	await commitFile(fixture.root, "right.txt", "right\n", "right", ["RIGHT"]);
	git(fixture.root, ["checkout", "-q", "left"]);
	git(fixture.root, ["merge", "--no-ff", "-m", "join branches", "right"]);
	const beforeHead = git(fixture.root, ["rev-parse", "HEAD"]);
	const beforeStatus = git(fixture.root, ["status", "--porcelain=v1", "--untracked-files=all"]);

	const result = await discoverGitDag({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
	});
	assert.equal(result.head.value, beforeHead);
	assert.deepEqual(
		result.objects
			.filter((entry) => entry.kind === "implementation")
			.map((entry) => entry.workUnitId)
			.sort(),
		["LEFT", "RIGHT"],
	);
	assert.deepEqual(
		result.objects
			.filter((entry) => entry.kind !== "implementation")
			.map((entry) => [entry.kind, entry.workUnitId, entry.layer]),
		[
			["transport", null, 2],
			["join", null, 3],
		],
	);
	assert.equal(result.joins.length, 1);
	assert.equal(result.joins[0].merge.candidateTree.value, result.joins[0].merge.observedTree.value);
	assert.equal(git(fixture.root, ["rev-parse", "HEAD"]), beforeHead);
	assert.equal(
		git(fixture.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
		beforeStatus,
	);
});

test("discovers native Plan-qualified identities without global WorkUnit collisions", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await commitFile(fixture.root, "one.txt", "one\n", "first API", ["API"], ["plan-one"]);
	await commitFile(fixture.root, "two.txt", "two\n", "second API", ["API"], ["plan-two"]);
	const qualified = await discoverPlanQualifiedGitDag({
		repository: fixture.root,
		base: fixture.base,
		head: "HEAD",
	});
	assert.deepEqual(
		qualified.qualifiedCommits.map((entry) => [entry.planId, entry.workUnitId]),
		[
			["plan-one", "API"],
			["plan-two", "API"],
		],
	);
	await assert.rejects(
		discoverGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "WORK_UNIT_BINDING_AMBIGUOUS",
	);

	await commitFile(fixture.root, "bad.txt", "bad\n", "unowned Plan trailer", [], ["plan-one"]);
	await assert.rejects(
		discoverPlanQualifiedGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "PLAN_OWNERSHIP_INVALID",
	);

	git(fixture.root, ["reset", "--hard", "HEAD^"]);
	await commitFile(fixture.root, "missing.txt", "missing\n", "missing Plan trailer", ["OTHER"]);
	await assert.rejects(
		discoverPlanQualifiedGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "PLAN_OWNERSHIP_INVALID",
	);

	git(fixture.root, ["reset", "--hard", "HEAD^"]);
	await commitFile(
		fixture.root,
		"duplicate.txt",
		"duplicate\n",
		"duplicate pair",
		["API"],
		["plan-one"],
	);
	await assert.rejects(
		discoverPlanQualifiedGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) =>
			error instanceof DagDiscoveryError && error.code === "PLAN_WORK_UNIT_BINDING_AMBIGUOUS",
	);
});

test("fails closed for a merge WorkUnit trailer and duplicate implementation trailers", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	git(fixture.root, ["checkout", "-q", "-b", "left"]);
	await commitFile(fixture.root, "left.txt", "left\n", "left", ["LEFT"]);
	git(fixture.root, ["checkout", "-q", "-b", "right", fixture.base]);
	await commitFile(fixture.root, "right.txt", "right\n", "right", ["RIGHT"]);
	git(fixture.root, ["checkout", "-q", "left"]);
	git(fixture.root, [
		"merge",
		"--no-ff",
		"-m",
		"join",
		"-m",
		"GraphReFly-Work-Unit: MERGE",
		"right",
	]);
	await assert.rejects(
		discoverGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "MERGE_WORK_UNIT_TRAILER",
	);

	git(fixture.root, ["reset", "--hard", "HEAD^1"]);
	await commitFile(fixture.root, "duplicate.txt", "duplicate\n", "duplicate", ["ONE", "TWO"]);
	await assert.rejects(
		discoverGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "WORK_UNIT_TRAILER_DUPLICATE",
	);

	git(fixture.root, ["reset", "--hard", "HEAD^"]);
	await commitFile(fixture.root, "same-1.txt", "one\n", "same one", ["SAME"]);
	await commitFile(fixture.root, "same-2.txt", "two\n", "same two", ["SAME"]);
	await assert.rejects(
		discoverGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "WORK_UNIT_BINDING_AMBIGUOUS",
	);
});

test("uses Git trailer semantics and rejects identifiers outside the v2 contract", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await commitFile(
		fixture.root,
		"body.txt",
		"body\n",
		"GraphReFly-Work-Unit: BODY_ONLY\n\nThis is ordinary body text.",
	);
	const bodyOnly = await discoverGitDag({
		repository: fixture.root,
		base: fixture.base,
		head: "HEAD",
	});
	assert.equal(bodyOnly.objects[0].kind, "transport");

	await commitFile(fixture.root, "invalid.txt", "invalid\n", "invalid", ["9INVALID"]);
	await assert.rejects(
		discoverGitDag({ repository: fixture.root, base: fixture.base, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "WORK_UNIT_TRAILER_INVALID",
	);
});

test("fails closed when a merge commit contains manual conflict resolution", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await commitFile(fixture.root, "conflict.txt", "base\n", "conflict base");
	const conflictBase = git(fixture.root, ["rev-parse", "HEAD"]);
	git(fixture.root, ["checkout", "-q", "-b", "left"]);
	await commitFile(fixture.root, "conflict.txt", "left\n", "left", ["LEFT"]);
	git(fixture.root, ["checkout", "-q", "-b", "right", conflictBase]);
	await commitFile(fixture.root, "conflict.txt", "right\n", "right", ["RIGHT"]);
	git(fixture.root, ["checkout", "-q", "left"]);
	git(fixture.root, ["merge", "--no-ff", "right"], [1]);
	await writeFile(join(fixture.root, "conflict.txt"), "resolved\n");
	git(fixture.root, ["add", "conflict.txt"]);
	git(fixture.root, ["commit", "-m", "manual resolution"]);

	await assert.rejects(
		discoverGitDag({ repository: fixture.root, base: conflictBase, head: "HEAD" }),
		(error) => error instanceof DagDiscoveryError && error.code === "JOIN_NOT_CLEAN",
	);
});
