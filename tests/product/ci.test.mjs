import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const cli = resolve(workspace, "packages/cli/dist/cli.js");
const { requireSingleTipCoveringPlan } = await import(
	new URL("../../packages/cli/dist/ci-runner.js", import.meta.url)
);

function invoke(repository, args, environment = {}) {
	return spawnSync(process.execPath, [cli, ...args], {
		cwd: repository,
		encoding: "utf8",
		env: { ...process.env, ...environment },
	});
}

async function put(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value, "utf8");
}

test("ci plan discovery accepts exactly one tip-covering plan", () => {
	assert.equal(requireSingleTipCoveringPlan(["current-plan"]), "current-plan");
	assert.throws(
		() => requireSingleTipCoveringPlan([]),
		(error) => error.code === "CI_PLAN_NOT_FOUND",
	);
	assert.throws(
		() => requireSingleTipCoveringPlan(["plan-a", "plan-b"]),
		(error) => error.code === "CI_PLAN_AMBIGUOUS",
	);
});

test("ci init writes one deterministic least-privilege pull-request workflow", async (context) => {
	const repository = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-ci-init-"));
	context.after(() => rm(repository, { recursive: true, force: true }));
	assert.equal(spawnSync("git", ["-C", repository, "init", "-q"]).status, 0);

	const initialized = invoke(repository, ["ci", "init", "--repo", ".", "--json"]);
	assert.equal(initialized.status, 0, initialized.stderr);
	const result = JSON.parse(initialized.stdout);
	assert.equal(result.command, "ci-init");
	assert.equal(result.data.workflow, ".github/workflows/graphrefly-stack.yml");
	const workflowPath = resolve(repository, result.data.workflow);
	const workflow = await readFile(workflowPath, "utf8");
	assert.match(workflow, /^name: GraphReFly Stack$/mu);
	assert.match(workflow, /^ {2}pull_request:$/mu);
	assert.doesNotMatch(workflow, /pull_request_target|merge_group|push:/u);
	assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
	assert.match(workflow, /persist-credentials: false/u);
	assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
	assert.match(workflow, /node-version: 24\.18\.0/u);
	assert.match(workflow, /cancel-in-progress: true/u);
	assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/u);
	assert.match(workflow, /sudo apt-get install --yes --no-install-recommends bubblewrap/u);
	assert.match(workflow, /retention-days: 7/u);
	assert.doesNotMatch(workflow, /uses: [^\n]+@v[0-9]+/u);
	assert.equal(
		[...workflow.matchAll(/uses: [^@\n]+@([0-9a-f]{40})/gu)].length,
		4,
		"every external action must be pinned to an immutable commit",
	);
	assert.doesNotMatch(workflow, /id-token|secrets\.|contents: write|pull-requests: write/u);

	const repeated = invoke(repository, ["ci", "init", "--repo", ".", "--json"]);
	assert.equal(repeated.status, 1);
	assert.equal(JSON.parse(repeated.stdout).error.code, "CI_WORKFLOW_EXISTS");
	const forced = invoke(repository, ["ci", "init", "--repo", ".", "--force", "--json"]);
	assert.equal(forced.status, 0, forced.stderr);
	assert.equal(await readFile(workflowPath, "utf8"), workflow);
});

test("ci run rejects unsupported events, repository output and malformed event bytes before gating", async (context) => {
	const root = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-ci-errors-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const repository = resolve(root, "repository");
	await mkdir(repository);
	assert.equal(spawnSync("git", ["-C", repository, "init", "-q"]).status, 0);
	const eventPath = resolve(root, "event.json");
	await put(eventPath, "{}\n");

	const mergeGroup = invoke(
		repository,
		["ci", "run", "--event", eventPath, "--output", resolve(root, "result.json"), "--json"],
		{ GITHUB_EVENT_NAME: "merge_group" },
	);
	assert.equal(mergeGroup.status, 1);
	assert.equal(JSON.parse(mergeGroup.stdout).error.code, "CI_EVENT_UNSUPPORTED");

	const inside = invoke(
		repository,
		["ci", "run", "--event", eventPath, "--output", resolve(repository, "result.json"), "--json"],
		{ GITHUB_EVENT_NAME: "pull_request" },
	);
	assert.equal(inside.status, 1);
	assert.equal(JSON.parse(inside.stdout).error.code, "CI_OUTPUT_INSIDE_REPOSITORY");

	const injectedOutput = invoke(
		repository,
		[
			"ci",
			"run",
			"--event",
			eventPath,
			"--output",
			resolve(root, "result.json\nforged-output=value"),
			"--json",
		],
		{ GITHUB_EVENT_NAME: "pull_request" },
	);
	assert.equal(injectedOutput.status, 1);
	assert.equal(JSON.parse(injectedOutput.stdout).error.code, "CI_OUTPUT_INVALID");

	await put(eventPath, "not-json\n");
	const malformed = invoke(
		repository,
		["ci", "run", "--event", eventPath, "--output", resolve(root, "malformed.json"), "--json"],
		{ GITHUB_EVENT_NAME: "pull_request" },
	);
	assert.equal(malformed.status, 1);
	assert.equal(JSON.parse(malformed.stdout).error.code, "CI_EVENT_INVALID");

	await put(resolve(repository, "README.md"), "CI event harness\n");
	assert.equal(spawnSync("git", ["-C", repository, "add", "README.md"]).status, 0);
	assert.equal(
		spawnSync("git", ["-C", repository, "commit", "-m", "create CI harness"], {
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "CI test",
				GIT_AUTHOR_EMAIL: "ci@example.invalid",
				GIT_COMMITTER_NAME: "CI test",
				GIT_COMMITTER_EMAIL: "ci@example.invalid",
			},
		}).status,
		0,
	);
	const head = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).stdout.trim();
	const validEvent = {
		number: 7,
		repository: { id: 123, owner: { id: 456 } },
		pull_request: {
			number: 7,
			base: { sha: head },
			head: { sha: head, repo: { id: 123 } },
		},
	};
	await put(eventPath, `${JSON.stringify(validEvent)}\n`);
	const githubEnvironment = {
		GITHUB_EVENT_NAME: "pull_request",
		GITHUB_WORKFLOW_REF: "owner/repository/.github/workflows/graphrefly-stack.yml@main",
		GITHUB_WORKFLOW_SHA: head,
		GITHUB_RUN_ID: "100",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_ACTOR_ID: "200",
	};
	const noPlan = invoke(
		repository,
		["ci", "run", "--event", eventPath, "--output", resolve(root, "no-plan.json"), "--json"],
		githubEnvironment,
	);
	assert.equal(noPlan.status, 1);
	assert.equal(JSON.parse(noPlan.stdout).error.code, "CI_PLAN_NOT_FOUND");

	await put(
		eventPath,
		`${JSON.stringify({
			...validEvent,
			pull_request: {
				...validEvent.pull_request,
				head: { ...validEvent.pull_request.head, sha: "1".repeat(40) },
			},
		})}\n`,
	);
	const stale = invoke(
		repository,
		["ci", "run", "--event", eventPath, "--output", resolve(root, "stale.json"), "--json"],
		githubEnvironment,
	);
	assert.equal(stale.status, 1);
	assert.equal(JSON.parse(stale.stdout).error.code, "CI_HEAD_MISMATCH");
});
