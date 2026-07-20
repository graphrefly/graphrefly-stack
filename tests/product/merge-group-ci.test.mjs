import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCi } from "../../packages/cli/dist/ci-runner.js";
import { createRepositoryBlueprintSnapshot } from "../../packages/cli/dist/repository-review.js";
import {
	assertMergeGroupBundleIntegrityV1,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

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

function fingerprint(repository) {
	return {
		head: git(repository, ["rev-parse", "HEAD"]),
		status: git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
		refs: git(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
	};
}

async function commitImplementation(repository, path, source, planId, workUnitId) {
	await writeFile(resolve(repository, path), source);
	git(repository, ["add", path]);
	git(repository, [
		"commit",
		"-m",
		`${workUnitId} implementation`,
		"-m",
		`GraphReFly-Plan: ${planId}\nGraphReFly-Work-Unit: ${workUnitId}`,
	]);
}

async function repository() {
	const root = await mkdtemp(resolve(tmpdir(), "graphrefly-merge-group-ci-"));
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
			`${JSON.stringify({ name: "merge-group-ci", private: true, type: "module", dependencies: { "@graphrefly/ts": "0.3.x" } })}\n`,
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
  const value = graph({ name: "merge-group-ci" });
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
	const base = git(root, ["rev-parse", "HEAD"]);
	const baseBlueprint = await createRepositoryBlueprintSnapshot({
		repository: root,
		revision: base,
	});
	const policy = {
		schema: "graphrefly.stack.semantic-policy.v1",
		policyId: "merge-policy",
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
		intent: `Change ${id}`,
		dependencies: [],
		allowedSourceScopes: [path],
		capabilities: ["graph-change"],
		claims: [
			{
				id: `${id.toLowerCase()}-safe`,
				predicate: {
					operator: "absent",
					selector: { kind: "node", nodeId: `forbidden-${id.toLowerCase()}` },
				},
				rationale: "Forbidden node remains absent",
			},
		],
		requiredChecks: ["contract"],
	});
	const plan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: "plan-group",
		taskDigest: { algorithm: "sha256", value: sha256Jcs({ task: "merge group" }) },
		taskSummary: "Validate a clean merge group",
		baseCommit: { algorithm: "sha1", value: base },
		baseBlueprintHash: baseBlueprint.blueprintHash,
		policy: {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: { algorithm: "sha256", value: sha256Jcs(policy) },
		},
		proposalSource: "human",
		acceptedBy: { label: "test", identityVerified: false },
		workUnits: [unit("LEFT", "left.mjs"), unit("RIGHT", "right.mjs")],
	};
	await mkdir(resolve(root, ".graphrefly-stack/plans"), { recursive: true });
	await Promise.all([
		writeFile(
			resolve(root, ".graphrefly-stack/policy.json"),
			`${JSON.stringify(policy, null, 2)}\n`,
		),
		writeFile(
			resolve(root, ".graphrefly-stack/plans/plan-group.json"),
			`${JSON.stringify(plan, null, 2)}\n`,
		),
	]);
	git(root, ["add", ".graphrefly-stack"]);
	git(root, ["commit", "-m", "accept plan"]);
	const accepted = git(root, ["rev-parse", "HEAD"]);
	git(root, ["switch", "-q", "-c", "left"]);
	await commitImplementation(
		root,
		"left.mjs",
		'export function applyLeft(value) { value.state(2, { name: "left" }); }\n',
		"plan-group",
		"LEFT",
	);
	git(root, ["switch", "-q", "-c", "right", accepted]);
	await commitImplementation(
		root,
		"right.mjs",
		'export function applyRight(value) { value.state(3, { name: "right" }); }\n',
		"plan-group",
		"RIGHT",
	);
	git(root, ["switch", "-q", "left"]);
	git(root, ["merge", "--no-ff", "-m", "synthetic merge group", "right"]);
	return { root, base, head: git(root, ["rev-parse", "HEAD"]) };
}

test("merge_group checks_requested emits one independently verified aggregate", async (t) => {
	const fixture = await repository();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const external = await mkdtemp(resolve(tmpdir(), "graphrefly-merge-group-output-"));
	t.after(() => rm(external, { recursive: true, force: true }));
	const eventPath = resolve(external, "event.json");
	const output = resolve(external, "aggregate.json");
	const headRef = "refs/heads/gh-readonly-queue/main/pr-1";
	await writeFile(
		eventPath,
		`${JSON.stringify({
			action: "checks_requested",
			repository: { id: 100, name: "test-graphrefly", owner: { id: 200, login: "clfhhc" } },
			merge_group: {
				base_sha: fixture.base,
				head_sha: fixture.head,
				base_ref: "refs/heads/main",
				head_ref: headRef,
			},
		})}\n`,
	);
	const before = fingerprint(fixture.root);
	const result = await runCi({
		repository: fixture.root,
		eventPath,
		output,
		environment: {
			...process.env,
			GITHUB_EVENT_NAME: "merge_group",
			GITHUB_SHA: fixture.head,
			GITHUB_REF: headRef,
			GITHUB_WORKFLOW_REF:
				"clfhhc/test-graphrefly/.github/workflows/graphrefly-stack.yml@refs/heads/main",
			GITHUB_WORKFLOW_SHA: fixture.base,
			GITHUB_RUN_ID: "300",
			GITHUB_RUN_ATTEMPT: "1",
			GITHUB_ACTOR_ID: "400",
		},
	});
	assert.equal(result.outcome, "pass");
	const bundle = JSON.parse(await readFile(output, "utf8"));
	assert.equal(bundle.result.plans.length, 1);
	assert.equal(bundle.result.plans[0].gateResult.verdict, "pass");
	assertMergeGroupBundleIntegrityV1(bundle);
	const repeatedOutput = resolve(external, "aggregate-repeated.json");
	const repeated = await runCi({
		repository: fixture.root,
		eventPath,
		output: repeatedOutput,
		environment: {
			...process.env,
			GITHUB_EVENT_NAME: "merge_group",
			GITHUB_SHA: fixture.head,
			GITHUB_REF: headRef,
			GITHUB_WORKFLOW_REF:
				"clfhhc/test-graphrefly/.github/workflows/graphrefly-stack.yml@refs/heads/main",
			GITHUB_WORKFLOW_SHA: fixture.base,
			GITHUB_RUN_ID: "300",
			GITHUB_RUN_ATTEMPT: "1",
			GITHUB_ACTOR_ID: "400",
		},
	});
	assert.equal(repeated.outcome, "pass");
	assert.equal(await readFile(repeatedOutput, "utf8"), await readFile(output, "utf8"));
	assert.deepEqual(fingerprint(fixture.root), before);

	const stale = structuredClone(JSON.parse(await readFile(eventPath, "utf8")));
	stale.merge_group.head_sha = "1".repeat(40);
	await writeFile(eventPath, `${JSON.stringify(stale)}\n`);
	await assert.rejects(
		runCi({
			repository: fixture.root,
			eventPath,
			output: resolve(external, "stale.json"),
			environment: {
				...process.env,
				GITHUB_EVENT_NAME: "merge_group",
				GITHUB_SHA: fixture.head,
				GITHUB_REF: headRef,
			},
		}),
		(error) => error.code === "CI_HEAD_MISMATCH",
	);
});
