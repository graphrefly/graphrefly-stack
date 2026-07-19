import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDagGraphEvidence, DagEvidenceError } from "../../packages/cli/dist/dag-evidence.js";
import { assertDagTopologyIntegrity, sha256Jcs } from "../../packages/contracts/dist/index.js";

const workspaceNodeModules = fileURLToPath(new URL("../../node_modules", import.meta.url));

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

async function commitFile(repository, path, content, subject, workUnitId) {
	await writeFile(resolve(repository, path), content);
	git(repository, ["add", path]);
	const args = ["commit", "-m", subject];
	if (workUnitId !== undefined) args.push("-m", `GraphReFly-Work-Unit: ${workUnitId}`);
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
	const second = await createDagGraphEvidence({
		repository: fixture.root,
		base: fixture.base,
		head: "left",
		repositoryIdentity: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
	});
	assert.equal(sha256Jcs(second.topology), sha256Jcs(first.topology));
	assert.deepEqual(fingerprint(fixture.root), before);
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
