import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const packageVersion = JSON.parse(
	await readFile(resolve(workspace, "package.json"), "utf8"),
).version;
const gitEnvironment = {
	...process.env,
	GIT_AUTHOR_NAME: "GraphReFly Stack package test",
	GIT_AUTHOR_EMAIL: "stack-package@example.invalid",
	GIT_COMMITTER_NAME: "GraphReFly Stack package test",
	GIT_COMMITTER_EMAIL: "stack-package@example.invalid",
};

function run(cwd, command, args, options = {}) {
	const result = invoke(cwd, command, args, options);
	assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

function invoke(cwd, command, args, options = {}) {
	return spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: gitEnvironment,
		maxBuffer: 32 * 1024 * 1024,
		...options,
	});
}

async function put(root, path, value) {
	const target = resolve(root, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, value, "utf8");
}

function commit(repository, subject) {
	run(repository, "git", ["add", "-A"]);
	run(repository, "git", ["commit", "-m", subject]);
	return run(repository, "git", ["rev-parse", "HEAD"]);
}

function commitWorkUnit(repository, subject, workUnitId) {
	run(repository, "git", ["add", "-A"]);
	run(repository, "git", ["commit", "-m", subject, "-m", `GraphReFly-Work-Unit: ${workUnitId}`]);
	return run(repository, "git", ["rev-parse", "HEAD"]);
}

function commitQualifiedWorkUnit(repository, subject, planId, workUnitId) {
	run(repository, "git", ["add", "-A"]);
	run(repository, "git", [
		"commit",
		"-m",
		subject,
		"-m",
		`GraphReFly-Plan: ${planId}\nGraphReFly-Work-Unit: ${workUnitId}`,
	]);
	return run(repository, "git", ["rev-parse", "HEAD"]);
}

async function proveInstalledMergeGroup(temporary, tarball) {
	const repository = resolve(temporary, "merge-group-consumer-repository");
	const inputs = resolve(temporary, "merge-group-inputs");
	await Promise.all([mkdir(repository), mkdir(inputs)]);
	await Promise.all([
		put(repository, ".gitignore", "node_modules\n"),
		put(
			repository,
			"package.json",
			`${JSON.stringify(
				{
					name: "installed-merge-group-proof",
					private: true,
					type: "module",
					dependencies: { "@graphrefly/ts": "0.3.x" },
					devDependencies: { "@graphrefly/stack": `file:${tarball}` },
				},
				null,
				2,
			)}\n`,
		),
		put(
			repository,
			"graph.mjs",
			`import { graph } from "@graphrefly/ts/graph";
import { applyLeft } from "./left.mjs";
import { applyRight } from "./right.mjs";
export function createGraph() {
  const value = graph({ name: "installed-merge-group-proof" });
  value.state(1, { name: "base" });
  applyLeft(value);
  applyRight(value);
  return value;
}
`,
		),
		put(repository, "left.mjs", "export function applyLeft() {}\n"),
		put(repository, "right.mjs", "export function applyRight() {}\n"),
	]);
	run(repository, "pnpm", ["install", "--ignore-scripts"]);
	run(repository, "git", ["init", "-b", "main"]);
	const initialized = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"init",
			"--graph-module",
			"graph.mjs",
			"--graph-export",
			"createGraph",
			"--json",
		]),
	);
	assert.equal(initialized.ok, true);
	commit(repository, "initialize installed merge-group repository");
	const policy = {
		schema: "graphrefly.stack.semantic-policy.v1",
		policyId: "installed-merge-policy",
		revision: "rev-1",
		allowedSourceRoots: ["left.mjs", "right.mjs"],
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
	const policyPath = resolve(inputs, "policy.json");
	await Promise.all([
		put(inputs, "policy.json", `${JSON.stringify(policy, null, 2)}\n`),
		put(repository, ".graphrefly-stack/policy.json", `${JSON.stringify(policy, null, 2)}\n`),
	]);
	const base = commit(repository, "install repository policy before Plans");
	const proposal = (planId, path) => ({
		schema: "graphrefly.stack.semantic-plan-proposal.v1",
		planId,
		proposalSource: "human",
		workUnits: [
			{
				id: "API",
				title: `${planId} API`,
				intent: `Implement ${planId}`,
				dependencies: [],
				allowedSourceScopes: [path],
				capabilities: ["graph-change"],
				claims: [
					{
						id: `${planId}-safe`,
						predicate: {
							operator: "absent",
							selector: { kind: "node", nodeId: `forbidden-${planId}` },
						},
						rationale: "The forbidden node remains absent.",
					},
				],
				requiredChecks: ["contract"],
			},
		],
	});
	for (const [planId, path, branch, source] of [
		[
			"plan-a",
			"left.mjs",
			"plan-a",
			'export function applyLeft(value) { value.state(2, { name: "left" }); }\n',
		],
		[
			"plan-b",
			"right.mjs",
			"plan-b",
			'export function applyRight(value) { value.state(3, { name: "right" }); }\n',
		],
	]) {
		run(repository, "git", ["switch", "-q", "-c", branch, base]);
		const proposalPath = resolve(inputs, `${planId}.json`);
		await put(inputs, `${planId}.json`, `${JSON.stringify(proposal(planId, path), null, 2)}\n`);
		const accepted = JSON.parse(
			run(repository, "pnpm", [
				"exec",
				"grfs",
				"plan",
				"--repo",
				".",
				"--task",
				`Accept ${planId}`,
				"--policy",
				policyPath,
				"--proposal",
				proposalPath,
				"--accept",
				"--accept-by",
				"package-test",
				"--json",
			]),
		);
		assert.equal(accepted.ok, true);
		commit(repository, `accept ${planId}`);
		await put(repository, path, source);
		commitQualifiedWorkUnit(repository, `implement ${planId}`, planId, "API");
	}
	run(repository, "git", ["switch", "-q", "plan-a"]);
	run(repository, "git", ["merge", "--no-ff", "-m", "synthetic installed merge group", "plan-b"]);
	const head = run(repository, "git", ["rev-parse", "HEAD"]);
	const eventPath = resolve(inputs, "event.json");
	const headRef = "refs/heads/gh-readonly-queue/main/installed";
	await put(
		inputs,
		"event.json",
		`${JSON.stringify({
			action: "checks_requested",
			repository: {
				id: 7654321,
				name: "installed-merge-group-proof",
				owner: { id: 1234567, login: "graphrefly" },
			},
			merge_group: {
				base_sha: base,
				head_sha: head,
				base_ref: "refs/heads/main",
				head_ref: headRef,
			},
		})}\n`,
	);
	const environment = {
		...gitEnvironment,
		GITHUB_EVENT_NAME: "merge_group",
		GITHUB_SHA: head,
		GITHUB_REF: headRef,
		GITHUB_WORKFLOW_REF:
			"graphrefly/installed-merge-group-proof/.github/workflows/graphrefly-stack.yml@refs/heads/main",
		GITHUB_WORKFLOW_SHA: base,
		GITHUB_RUN_ID: "3456789",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_ACTOR_ID: "4567890",
	};
	const before = {
		head,
		status: run(repository, "git", ["status", "--porcelain=v1", "--untracked-files=all"]),
		refs: run(repository, "git", ["for-each-ref", "--format=%(refname) %(objectname)"]),
	};
	const firstPath = resolve(inputs, "installed-aggregate.json");
	const first = invoke(
		repository,
		"pnpm",
		["exec", "grfs", "ci", "run", "--event", eventPath, "--output", firstPath, "--json"],
		{ env: environment },
	);
	assert.equal(first.status, 0, first.stderr || first.stdout);
	const secondPath = resolve(inputs, "installed-aggregate-repeated.json");
	const second = invoke(
		repository,
		"pnpm",
		["exec", "grfs", "ci", "run", "--event", eventPath, "--output", secondPath, "--json"],
		{ env: environment },
	);
	assert.equal(second.status, 0, second.stderr || second.stdout);
	assert.equal(await readFile(firstPath, "utf8"), await readFile(secondPath, "utf8"));
	const bundle = JSON.parse(await readFile(firstPath, "utf8"));
	assert.equal(bundle.schema, "graphrefly.stack.merge-group-bundle.v1");
	assert.deepEqual(
		bundle.result.plans.map((entry) => [entry.planId, entry.gateResult.verdict]),
		[
			["plan-a", "pass"],
			["plan-b", "pass"],
		],
	);
	assert.deepEqual(
		bundle.qualifiedCommits.map((entry) => [entry.planId, entry.workUnitId]),
		[
			["plan-a", "API"],
			["plan-b", "API"],
		],
	);
	assert.deepEqual(
		{
			head: run(repository, "git", ["rev-parse", "HEAD"]),
			status: run(repository, "git", ["status", "--porcelain=v1", "--untracked-files=all"]),
			refs: run(repository, "git", ["for-each-ref", "--format=%(refname) %(objectname)"]),
		},
		before,
	);
}

async function runInstalledSemanticLifecycle(
	repository,
	inputRoot,
	planId,
	nodeId,
	checkArgv = ["node", "--test"],
) {
	let unrelatedHead;
	let architectureHead;
	const policyPath = resolve(inputRoot, `${planId}-policy.json`);
	const proposalPath = resolve(inputRoot, `${planId}-proposal.json`);
	await Promise.all([
		put(
			inputRoot,
			`${planId}-policy.json`,
			`${JSON.stringify(
				{
					schema: "graphrefly.stack.semantic-policy.v1",
					policyId: `${planId}-policy`,
					revision: "rev-1",
					allowedSourceRoots: ["src"],
					allowedCapabilities: ["graph-change"],
					checks: [
						{
							id: "test",
							argv: checkArgv,
							timeoutMs: 120000,
							network: false,
							shell: false,
						},
					],
				},
				null,
				2,
			)}\n`,
		),
		put(
			inputRoot,
			`${planId}-proposal.json`,
			`${JSON.stringify(
				{
					schema: "graphrefly.stack.semantic-plan-proposal.v1",
					planId,
					proposalSource: "human",
					workUnits: [
						{
							id: "CONTRACTS",
							title: "Implement semantic contract",
							intent: "Add the installed-package semantic contract.",
							dependencies: [],
							allowedSourceScopes: ["src"],
							capabilities: ["graph-change"],
							claims: [
								{
									id: "stable-node",
									predicate: {
										operator: "present",
										selector: { kind: "node", nodeId },
									},
									rationale: "The implementation retains the stable graph anchor.",
								},
							],
							requiredChecks: ["test"],
						},
						{
							id: "VERIFY",
							title: "Verify semantic behavior",
							intent: "Verify the installed-package semantic contract.",
							dependencies: ["CONTRACTS"],
							allowedSourceScopes: ["src"],
							capabilities: [],
							claims: [
								{
									id: "ghost-absent",
									predicate: {
										operator: "absent",
										selector: { kind: "node", nodeId: "ghost" },
									},
									rationale: "The initial architecture has no ghost node.",
								},
							],
							requiredChecks: ["test"],
						},
					],
				},
				null,
				2,
			)}\n`,
		),
	]);
	const accepted = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"plan",
			"--repo",
			".",
			"--task",
			"Exercise the installed semantic lifecycle",
			"--policy",
			policyPath,
			"--proposal",
			proposalPath,
			"--accept",
			"--accept-by",
			"package-test",
			"--json",
		]),
	);
	assert.equal(accepted.ok, true);
	const acceptanceCommit = commit(repository, "accept installed semantic plan");
	await put(
		repository,
		`src/${planId}-contract.ts`,
		`export const ${planId.replaceAll("-", "_")}_contract = true;\n`,
	);
	const contractsCommit = commitWorkUnit(
		repository,
		"implement installed semantic contract",
		"CONTRACTS",
	);
	await put(
		repository,
		`src/${planId}-verify.ts`,
		`export const ${planId.replaceAll("-", "_")}_verified = true;\n`,
	);
	const head = commitWorkUnit(repository, "verify installed semantic plan", "VERIFY");
	const bound = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"plan",
			"--repo",
			".",
			"--bind",
			"--plan-id",
			planId,
			"--head",
			head,
			"--json",
		]),
	);
	assert.equal(bound.ok, true);
	assert.deepEqual(
		bound.data.bindings.map((binding) => binding.workUnitId),
		["CONTRACTS", "VERIFY"],
	);
	const gated = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"gate",
			"--repo",
			".",
			"--plan-id",
			planId,
			"--head",
			head,
			"--json",
		]),
	);
	assert.equal(gated.data.gateResult.verdict, "pass");
	const semanticReview = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"review",
			"--repo",
			".",
			"--base",
			accepted.data.plan.baseCommit.value,
			"--head",
			head,
			"--plan-id",
			planId,
			"--json",
		]),
	);
	assert.equal(semanticReview.data.semanticStatus, "evaluated");
	assert.equal(semanticReview.data.semantic.gateResult.verdict, "pass");
	const semanticServer = spawn(
		"pnpm",
		[
			"exec",
			"grfs",
			"review",
			"--repo",
			".",
			"--base",
			accepted.data.plan.baseCommit.value,
			"--head",
			head,
			"--plan-id",
			planId,
			"--port",
			"0",
		],
		{ cwd: repository, env: gitEnvironment, stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		const semanticUrl = await waitForServer(semanticServer);
		const [shell, semanticData] = await Promise.all([
			fetch(semanticUrl),
			fetch(`${semanticUrl}/api/review-data`),
		]);
		assert.equal(shell.status, 200);
		const shellHtml = await shell.text();
		assert.match(shellHtml, /<div id="root"><\/div>/u);
		const stylesheet = shellHtml.match(/href="([^"]+\.css)"/u)?.[1];
		assert.notEqual(stylesheet, undefined);
		const responsiveCss = await fetch(new URL(stylesheet, semanticUrl)).then((response) =>
			response.text(),
		);
		assert.match(responsiveCss, /semantic-grid/u);
		assert.match(responsiveCss, /@media/u);
		assert.equal((await semanticData.json()).semantic.gateResult.verdict, "pass");
	} finally {
		semanticServer.kill("SIGTERM");
	}
	const exportPath = resolve(inputRoot, `${planId}-evidence.json`);
	const exported = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"export",
			"--repo",
			".",
			"--plan-id",
			planId,
			"--head",
			head,
			"--output",
			exportPath,
			"--json",
		]),
	);
	assert.equal(exported.ok, true);
	assert.equal(
		JSON.parse(await readFile(exportPath, "utf8")).schema,
		"graphrefly.stack.semantic-portable-bundle.v1",
	);
	const verifiedExport = JSON.parse(
		run(repository, "pnpm", ["exec", "grfs", "export", "--verify", exportPath, "--json"]),
	);
	assert.equal(verifiedExport.data.artifactCount, 7);
	assert.equal(verifiedExport.data.planId, planId);
	const portableValue = JSON.parse(await readFile(exportPath, "utf8"));
	portableValue.artifacts["gate-result.json"].verdict = "error";
	const tamperedExportPath = resolve(inputRoot, `${planId}-evidence-tampered.json`);
	await writeFile(tamperedExportPath, `${JSON.stringify(portableValue, null, 2)}\n`, "utf8");
	const rejectedExport = invoke(repository, "pnpm", [
		"exec",
		"grfs",
		"export",
		"--verify",
		tamperedExportPath,
		"--json",
	]);
	assert.equal(rejectedExport.status, 1);
	assert.equal(JSON.parse(rejectedExport.stdout).error.code, "ARTIFACT_HASH_MISMATCH");
	if (planId === "flat-installed") {
		const originalBranch = run(repository, "git", ["branch", "--show-current"]);
		const semanticBase = accepted.data.plan.baseCommit.value;
		run(repository, "git", ["switch", "-c", "packed-policy-tamper", head]);
		const policyFile = resolve(repository, ".graphrefly-stack/policy.json");
		const tamperedPolicy = JSON.parse(await readFile(policyFile, "utf8"));
		const executionMarker = resolve(inputRoot, "tampered-policy-executed");
		tamperedPolicy.revision = "rev-tampered";
		tamperedPolicy.checks[0].argv = [
			"node",
			"-e",
			`require("node:fs").writeFileSync(${JSON.stringify(executionMarker)}, "unsafe")`,
		];
		await writeFile(policyFile, `${JSON.stringify(tamperedPolicy, null, 2)}\n`, "utf8");
		const policyTamperHead = commit(repository, "tamper accepted policy");
		const rejectedPolicy = invoke(repository, "pnpm", [
			"exec",
			"grfs",
			"gate",
			"--repo",
			".",
			"--plan-id",
			planId,
			"--head",
			policyTamperHead,
			"--json",
		]);
		assert.equal(rejectedPolicy.status, 1);
		assert.equal(JSON.parse(rejectedPolicy.stdout).error.code, "POLICY_MISMATCH");
		await assert.rejects(readFile(executionMarker, "utf8"));
		run(repository, "git", ["switch", originalBranch]);

		run(repository, "git", ["switch", "-c", "packed-unrelated-rebase", semanticBase]);
		await put(repository, "src/upstream-note.ts", "export const upstreamNote = true;\n");
		commit(repository, "add unrelated upstream source");
		run(repository, "git", ["cherry-pick", acceptanceCommit, contractsCommit, head]);
		unrelatedHead = run(repository, "git", ["rev-parse", "HEAD"]);
		const rebound = JSON.parse(
			run(repository, "pnpm", [
				"exec",
				"grfs",
				"gate",
				"--repo",
				".",
				"--plan-id",
				planId,
				"--head",
				unrelatedHead,
				"--json",
			]),
		);
		assert.equal(rebound.data.gateResult.verdict, "pass");
		assert.equal(
			rebound.data.input.records.every((record) => record.rebindFrom !== null),
			true,
		);

		run(repository, "git", ["switch", "-c", "packed-architecture-rebase", semanticBase]);
		const graphPath = "src/application-graph.mjs";
		const architectureSource = await readFile(resolve(repository, graphPath), "utf8");
		await put(
			repository,
			graphPath,
			architectureSource.replace(
				"  return application;",
				'  application.state(0, { name: "ghost" });\n  return application;',
			),
		);
		commit(repository, "add upstream architecture node");
		run(repository, "git", ["cherry-pick", acceptanceCommit, contractsCommit, head]);
		architectureHead = run(repository, "git", ["rev-parse", "HEAD"]);
		const staleRun = invoke(repository, "pnpm", [
			"exec",
			"grfs",
			"gate",
			"--repo",
			".",
			"--plan-id",
			planId,
			"--head",
			architectureHead,
			"--json",
		]);
		assert.equal(staleRun.status, 2, staleRun.stderr || staleRun.stdout);
		const stale = JSON.parse(staleRun.stdout);
		assert.deepEqual(
			stale.data.gateResult.units.map((unit) => unit.verdict),
			["valid", "invalid"],
		);
		assert.deepEqual(stale.data.gateResult.units[1].reasonCodes, [
			"BLUEPRINT_PREDICATE_UNSATISFIED",
		]);

		const unauthorized = invoke(repository, "pnpm", [
			"exec",
			"grfs",
			"replan",
			"--repo",
			".",
			"--plan-id",
			planId,
			"--head",
			architectureHead,
			"--mode",
			"live",
			"--json",
		]);
		assert.equal(unauthorized.status, 1);
		assert.equal(JSON.parse(unauthorized.stdout).error.code, "MODEL_CONTEXT_UNAUTHORIZED");

		const recoveryId = "flat-installed-recovery";
		const recoveryProposalPath = resolve(inputRoot, `${recoveryId}.json`);
		await put(
			inputRoot,
			`${recoveryId}.json`,
			`${JSON.stringify(
				{
					schema: "graphrefly.stack.semantic-plan-proposal.v1",
					planId: recoveryId,
					proposalSource: "human",
					workUnits: [
						{
							id: "VERIFY",
							title: "Verify recovered architecture",
							intent: "Verify the accepted upstream architecture.",
							dependencies: ["CONTRACTS"],
							allowedSourceScopes: ["src"],
							capabilities: [],
							claims: [
								{
									id: "ghost-present",
									predicate: {
										operator: "present",
										selector: { kind: "node", nodeId: "ghost" },
									},
									rationale: "Recovery accepts the upstream node.",
								},
							],
							requiredChecks: ["test"],
						},
					],
				},
				null,
				2,
			)}\n`,
		);
		const recovery = JSON.parse(
			run(repository, "pnpm", [
				"exec",
				"grfs",
				"replan",
				"--repo",
				".",
				"--plan-id",
				planId,
				"--head",
				architectureHead,
				"--proposal",
				recoveryProposalPath,
				"--accept",
				"--accept-by",
				"package-test",
				"--json",
			]),
		);
		assert.deepEqual(recovery.data.selectiveReplan.preservedUnits, ["CONTRACTS"]);
		commit(repository, "accept packed selective recovery");
		await put(repository, "src/flat-installed-recovered.ts", "export const recovered = true;\n");
		const recoveredHead = commitWorkUnit(repository, "verify packed recovery", "VERIFY");
		const recovered = JSON.parse(
			run(repository, "pnpm", [
				"exec",
				"grfs",
				"gate",
				"--repo",
				".",
				"--plan-id",
				recoveryId,
				"--head",
				recoveredHead,
				"--json",
			]),
		);
		assert.equal(recovered.data.gateResult.verdict, "pass");
		assert.equal(
			recovered.data.input.bindings.find((binding) => binding.workUnitId === "CONTRACTS").commit
				.value,
			run(repository, "git", ["rev-parse", `${architectureHead}~1`]),
		);

		const gateDirectory = resolve(repository, ".git/grfs/gates", recoveryId);
		const gateFile = (await readdir(gateDirectory)).find((entry) => entry.endsWith(".json"));
		assert.notEqual(gateFile, undefined);
		const gatePath = resolve(gateDirectory, gateFile);
		const originalGate = await readFile(gatePath, "utf8");
		const tamperedGate = JSON.parse(originalGate);
		tamperedGate.schema = "graphrefly.stack.semantic-gate-bundle.tampered";
		await writeFile(gatePath, `${JSON.stringify(tamperedGate)}\n`, "utf8");
		const tampered = invoke(repository, "pnpm", [
			"exec",
			"grfs",
			"gate",
			"--repo",
			".",
			"--plan-id",
			recoveryId,
			"--head",
			recoveredHead,
			"--json",
		]);
		assert.equal(tampered.status, 1);
		assert.equal(JSON.parse(tampered.stdout).error.code, "ARTIFACT_HASH_MISMATCH");
		await writeFile(gatePath, originalGate, "utf8");
		run(repository, "git", ["switch", originalBranch]);
	}
	assert.equal(run(repository, "git", ["status", "--short"]), "");
	return {
		base: accepted.data.plan.baseCommit.value,
		head,
		planId,
		gateInputDigest: gated.data.gateResult.inputDigest,
		gateResult: gated.data.gateResult,
		unrelatedHead,
		architectureHead,
	};
}

async function proveInstalledCiPass(repository, inputRoot, lifecycle, repositoryId, pullRequest) {
	const originalPackageJson = await readFile(resolve(repository, "package.json"), "utf8");
	const ciPackageJson = JSON.parse(originalPackageJson);
	ciPackageJson.packageManager = JSON.parse(
		await readFile(resolve(workspace, "package.json"), "utf8"),
	).packageManager;
	ciPackageJson.devDependencies["@graphrefly/stack"] = packageVersion;
	await writeFile(
		resolve(repository, "package.json"),
		`${JSON.stringify(ciPackageJson, null, 2)}\n`,
		"utf8",
	);
	const installedCli = await realpath(
		resolve(repository, "node_modules/@graphrefly/stack/dist/grfs.js"),
	);
	const prefix = `${lifecycle.planId}-ci`;
	const workflowRepository = resolve(inputRoot, `${prefix}-workflow-repository`);
	await mkdir(workflowRepository);
	run(workflowRepository, "git", ["init", "-q"]);
	const initialized = JSON.parse(
		run(repository, process.execPath, [
			installedCli,
			"ci",
			"init",
			"--repo",
			workflowRepository,
			"--json",
		]),
	);
	assert.equal(initialized.data.workflow, ".github/workflows/graphrefly-stack.yml");
	const workflow = await readFile(resolve(workflowRepository, initialized.data.workflow), "utf8");
	assert.match(workflow, /^ {4}runs-on: ubuntu-22\.04$/mu);
	assert.doesNotMatch(workflow, /runs-on: ubuntu-24\.04/u);
	const eventPath = resolve(inputRoot, `${prefix}-event.json`);
	await writeFile(
		eventPath,
		`${JSON.stringify({
			number: pullRequest,
			repository: { id: repositoryId, owner: { id: repositoryId + 1 } },
			pull_request: {
				number: pullRequest,
				base: { sha: lifecycle.base },
				head: { sha: lifecycle.head, repo: { id: repositoryId } },
			},
		})}\n`,
		"utf8",
	);
	const local = JSON.parse(
		run(repository, process.execPath, [
			installedCli,
			"gate",
			"--repo",
			".",
			"--plan-id",
			lifecycle.planId,
			"--head",
			lifecycle.head,
			"--json",
		]),
	).data;
	const outputPath = resolve(inputRoot, `${prefix}-artifact.json`);
	const ci = invoke(
		repository,
		process.execPath,
		[installedCli, "ci", "run", "--event", eventPath, "--output", outputPath, "--json"],
		{
			env: {
				...gitEnvironment,
				GITHUB_EVENT_NAME: "pull_request",
				GITHUB_WORKFLOW_REF: `graphrefly/independent/.github/workflows/graphrefly-stack.yml@refs/pull/${pullRequest}/merge`,
				GITHUB_WORKFLOW_SHA: lifecycle.head,
				GITHUB_RUN_ID: String(repositoryId * 1000),
				GITHUB_RUN_ATTEMPT: "1",
				GITHUB_ACTOR_ID: String(repositoryId + 2),
			},
		},
	);
	assert.equal(ci.status, 0, ci.stderr || ci.stdout);
	const artifact = JSON.parse(await readFile(outputPath, "utf8"));
	assert.equal(artifact.invocation.repository.id, String(repositoryId));
	assert.equal(artifact.invocation.plan.id, lifecycle.planId);
	assert.equal(artifact.invocation.cacheInputs.stackVersion, packageVersion);
	assert.deepEqual(artifact.result.gateInputDigest, local.gateResult.inputDigest);
	assert.deepEqual(artifact.result.gateResult, local.gateResult);
	await writeFile(resolve(repository, "package.json"), originalPackageJson, "utf8");
	assert.equal(run(repository, "git", ["status", "--short"]), "");
}

async function proveInstalledIntegration(
	repository,
	inputRoot,
	lifecycle,
	repositoryName,
	pullRequest,
) {
	assert.equal(run(repository, "git", ["rev-parse", "HEAD"]), lifecycle.head);
	const statusBefore = run(repository, "git", ["status", "--short"]);
	const local = invoke(
		repository,
		"pnpm",
		[
			"exec",
			"grfs",
			"integration",
			"--repo",
			".",
			"--target",
			lifecycle.base,
			"--head",
			lifecycle.head,
			"--plan-id",
			lifecycle.planId,
			"--provider",
			"github",
			"--owner",
			"graphrefly",
			"--name",
			repositoryName,
			"--json",
		],
		{ env: gitEnvironment },
	);
	assert.equal(local.status, 0, local.stderr || local.stdout);
	const localArtifact = JSON.parse(local.stdout).data;
	const eventPath = resolve(inputRoot, `${lifecycle.planId}-integration-event.json`);
	await writeFile(
		eventPath,
		`${JSON.stringify({
			number: pullRequest,
			repository: { name: repositoryName, owner: { login: "graphrefly" } },
			pull_request: { base: { sha: lifecycle.base }, head: { sha: lifecycle.head } },
		})}\n`,
		"utf8",
	);
	const output = resolve(inputRoot, `${lifecycle.planId}-integration-ci.json`);
	const ci = invoke(
		repository,
		"pnpm",
		[
			"exec",
			"grfs",
			"integration",
			"ci",
			"--repo",
			".",
			"--event",
			eventPath,
			"--plan-id",
			lifecycle.planId,
			"--output",
			output,
			"--json",
		],
		{ env: { ...gitEnvironment, GITHUB_EVENT_NAME: "pull_request" } },
	);
	assert.equal(ci.status, 0, ci.stderr || ci.stdout);
	assert.deepEqual(JSON.parse(await readFile(output, "utf8")), localArtifact);
	assert.equal(localArtifact.result.outcome, "compatible");
	assert.equal(localArtifact.candidate.repository.name, repositoryName);
	assert.equal(run(repository, "git", ["status", "--short"]), statusBefore);
}

async function waitForServer(child) {
	return new Promise((resolveReady, rejectReady) => {
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			rejectReady(new Error(`Timed out waiting for review UI: ${stderr}`));
		}, 20_000);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			const match = stderr.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);
			if (match !== null) {
				clearTimeout(timeout);
				resolveReady(match[1]);
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			rejectReady(new Error(`Review UI exited ${code}: ${stderr}`));
		});
	});
}

test("the npm tarball installs and reviews an independent GraphReFly 0.3.x repository", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-package-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const tarballs = resolve(temporary, "tarballs");
	const repository = resolve(temporary, "consumer-repository");
	await Promise.all([mkdir(tarballs), mkdir(repository)]);

	run(workspace, "pnpm", ["pack", "--pack-destination", tarballs, "--silent"]);
	const tarballFiles = (await readdir(tarballs)).filter((path) => path.endsWith(".tgz"));
	assert.deepEqual(tarballFiles, [`graphrefly-stack-${packageVersion}.tgz`]);
	const tarball = resolve(tarballs, tarballFiles[0]);
	const packedPaths = run(workspace, "tar", ["-tf", tarball]).split("\n");
	const packedManifest = JSON.parse(
		run(workspace, "tar", ["-xOf", tarball, "package/package.json"]),
	);
	assert.equal(packedManifest.name, "@graphrefly/stack");
	assert.equal(packedManifest.version, packageVersion);
	assert.deepEqual(packedManifest.bin, { grfs: "dist/grfs.js" });
	assert.equal(packedPaths.includes("package/dist/grfs.js"), true);
	assert.equal(packedPaths.includes("package/dist/review/index.html"), true);
	assert.equal(
		packedPaths.includes(
			"package/dist/assets/contracts/repository/v1/repository-config.schema.json",
		),
		true,
	);
	for (const schema of [
		"review-decision-request.schema.json",
		"review-decision.schema.json",
		"review-bundle.schema.json",
	]) {
		assert.equal(
			packedPaths.includes(`package/dist/assets/contracts/repository/v1/${schema}`),
			true,
		);
	}
	for (const packedPath of [
		"package/dist/assets/contracts/ci/v1/artifacts.schema.json",
		"package/dist/assets/contracts/ci/v1/golden-suite.schema.json",
		"package/dist/assets/fixtures/contracts/ci/v1/golden-suite.json",
		"package/dist/assets/fixtures/contracts/ci/v1/golden-digests.json",
		"package/dist/assets/contracts/hosted/v1/artifacts.schema.json",
		"package/dist/assets/contracts/hosted/v1/golden-suite.schema.json",
		"package/dist/assets/fixtures/contracts/hosted/v1/ci-bundle.json",
		"package/dist/assets/fixtures/contracts/hosted/v1/golden-suite.json",
		"package/dist/assets/fixtures/contracts/hosted/v1/golden-digests.json",
		"package/dist/assets/contracts/semantic/v1/artifacts.schema.json",
		"package/dist/assets/contracts/semantic/v1/golden-suite.schema.json",
		"package/dist/assets/fixtures/contracts/semantic/v1/golden-suite.json",
		"package/dist/assets/fixtures/contracts/semantic/v1/golden-digests.json",
	]) {
		assert.equal(
			packedPaths.includes(packedPath),
			true,
			`${packedPath} is missing from the tarball`,
		);
	}
	assert.equal(
		packedPaths.some((path) => path.startsWith("package/packages/")),
		false,
	);

	await Promise.all([
		put(repository, ".gitignore", "node_modules\n"),
		put(
			repository,
			"package.json",
			`${JSON.stringify(
				{
					name: "independent-graphrefly-consumer",
					private: true,
					type: "module",
					dependencies: { "@graphrefly/ts": "0.3.x" },
				},
				null,
				2,
			)}\n`,
		),
		put(
			repository,
			"src/application-graph.mjs",
			`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "installed-package-proof" });
  application.state(1, { name: "source" });
  return application;
}
`,
		),
	]);
	run(repository, "pnpm", ["install", "--ignore-scripts"]);
	run(repository, "git", ["init", "-b", "main"]);
	const base = commit(repository, "create existing GraphReFly repository");

	await put(
		repository,
		"src/application-graph.mjs",
		`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "installed-package-proof" });
  const source = application.state(1, { name: "source" });
  application.derived([source], (value) => value + 1, { name: "projection" });
  return application;
}
`,
	);
	const head = commit(repository, "derive projection before Stack onboarding");

	const consumerPackage = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
	consumerPackage.devDependencies = { "@graphrefly/stack": `file:${tarball}` };
	await put(repository, "package.json", `${JSON.stringify(consumerPackage, null, 2)}\n`);
	run(repository, "pnpm", ["install", "--ignore-scripts"]);
	const packedCli = await realpath(
		resolve(repository, "node_modules/@graphrefly/stack/dist/grfs.js"),
	);
	const registryLayoutCli = resolve(repository, "registry-layout-grfs.js");
	await symlink(packedCli, registryLayoutCli);
	assert.match(run(repository, process.execPath, [registryLayoutCli, "--help"]), /Usage:/u);
	const hostedRepository = resolve(temporary, "hosted-consumer-repository");
	await mkdir(hostedRepository);
	run(hostedRepository, "git", ["init", "-q"]);
	const hostedInitialized = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"hosted",
			"init",
			"--repo",
			hostedRepository,
			"--endpoint",
			"https://stack.example.test",
			"--json",
		]),
	);
	assert.equal(hostedInitialized.command, "hosted-init");
	assert.equal(hostedInitialized.data.stackVersion, packageVersion);
	const hostedWorkflow = await readFile(
		resolve(hostedRepository, hostedInitialized.data.workflow),
		"utf8",
	);
	assert.match(
		hostedWorkflow,
		new RegExp(`@graphrefly/stack@${packageVersion.replaceAll(".", "\\.")}`, "u"),
	);
	assert.doesNotMatch(
		hostedWorkflow,
		/actions\/checkout|contents:|secrets\.|pull-requests: write/u,
	);

	const initialized = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"init",
			"--graph-module",
			"src/application-graph.mjs",
			"--json",
		]),
	);
	assert.equal(initialized.ok, true);
	assert.equal(initialized.command, "init");
	assert.equal(initialized.data.entrypoint, "graphrefly-stack.blueprint.mjs");
	assert.equal(
		JSON.parse(await readFile(resolve(repository, ".graphrefly-stack.json"), "utf8")).blueprint
			.entrypoint,
		"graphrefly-stack.blueprint.mjs",
	);

	const reviewed = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"review",
			"--repo",
			".",
			"--base",
			base,
			"--head",
			head,
			"--json",
		]),
	);
	assert.equal(reviewed.ok, true);
	assert.match(reviewed.data.repository.graphreflyVersion, /^0\.3\.\d+$/u);
	assert.deepEqual(
		reviewed.data.commits[0].delta.events.map((event) => event.type),
		["node-added", "edge-added"],
	);
	assert.deepEqual(reviewed.data.commits[0].diff.paths, ["src/application-graph.mjs"]);

	const server = spawn(
		"pnpm",
		["exec", "grfs", "review", "--repo", ".", "--base", base, "--head", head, "--port", "0"],
		{ cwd: repository, env: gitEnvironment, stdio: ["ignore", "pipe", "pipe"] },
	);
	context.after(() => server.kill("SIGTERM"));
	const url = await waitForServer(server);
	const [shellResponse, dataResponse] = await Promise.all([
		fetch(url),
		fetch(`${url}/api/review-data`),
	]);
	assert.equal(shellResponse.status, 200);
	assert.match(await shellResponse.text(), /<div id="root"><\/div>/u);
	assert.equal(dataResponse.status, 200);
	assert.equal((await dataResponse.json()).commits[0].oid, head);

	const statusBeforeDecision = run(repository, "git", ["status", "--short"]);
	const decisionResponse = await fetch(`${url}/api/review-decisions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: url,
			"X-GraphReFly-Review": "1",
		},
		body: JSON.stringify({
			schema: "graphrefly.stack.repository-review-decision-request.v1",
			commitOid: head,
			decision: "approve",
			reviewerLabel: "Package test",
			summary: "Installed package review state is durable and portable.",
		}),
	});
	assert.equal(decisionResponse.status, 201);
	const decision = await decisionResponse.json();
	assert.equal(decision.target.commitOid, head);
	assert.equal(decision.target.parentOid, base);
	assert.equal(decision.identityVerified, false);
	assert.match(
		decision.id,
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
	);

	const storedResponse = await fetch(`${url}/api/review-decisions`);
	assert.equal(storedResponse.status, 200);
	assert.deepEqual(await storedResponse.json(), [decision]);
	const exportResponse = await fetch(`${url}/api/review-decisions/export`);
	assert.equal(exportResponse.status, 200);
	const bundle = await exportResponse.json();
	assert.equal(bundle.artifacts[0].record.id, decision.id);
	assert.match(bundle.artifacts[0].hash.value, /^[0-9a-f]{64}$/u);
	assert.equal(
		await readFile(resolve(repository, ".git/grfs/reviews", `${decision.id}.json`), "utf8").then(
			(value) => JSON.parse(value).id,
		),
		decision.id,
	);
	assert.equal(run(repository, "git", ["status", "--short"]), statusBeforeDecision);
	server.kill("SIGTERM");

	commit(repository, "onboard installed GraphReFly Stack package");
	const semanticInputs = resolve(temporary, "semantic-inputs");
	await mkdir(semanticInputs);
	const flatLifecycle = await runInstalledSemanticLifecycle(
		repository,
		semanticInputs,
		"flat-installed",
		"source",
	);
	await proveInstalledIntegration(
		repository,
		semanticInputs,
		flatLifecycle,
		"independent-flat",
		42,
	);
	const originalPackageJson = await readFile(resolve(repository, "package.json"), "utf8");
	const ciPackageJson = JSON.parse(originalPackageJson);
	ciPackageJson.packageManager = JSON.parse(
		await readFile(resolve(workspace, "package.json"), "utf8"),
	).packageManager;
	ciPackageJson.devDependencies["@graphrefly/stack"] = packageVersion;
	await writeFile(
		resolve(repository, "package.json"),
		`${JSON.stringify(ciPackageJson, null, 2)}\n`,
		"utf8",
	);
	const eventPath = resolve(semanticInputs, "github-pull-request.json");
	await writeFile(
		eventPath,
		`${JSON.stringify(
			{
				number: 42,
				repository: { id: 123456, owner: { id: 654321 } },
				pull_request: {
					number: 42,
					base: { sha: flatLifecycle.base },
					head: { sha: flatLifecycle.head, repo: { id: 123456 } },
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	const githubOutput = resolve(semanticInputs, "github-output.txt");
	const githubSummary = resolve(semanticInputs, "github-summary.md");
	await Promise.all([writeFile(githubOutput, "", "utf8"), writeFile(githubSummary, "", "utf8")]);
	const ciEnvironment = {
		...gitEnvironment,
		GITHUB_EVENT_NAME: "pull_request",
		GITHUB_WORKFLOW_REF:
			"graphrefly/independent/.github/workflows/graphrefly-stack.yml@refs/pull/42/merge",
		GITHUB_WORKFLOW_SHA: flatLifecycle.head,
		GITHUB_RUN_ID: "987654321",
		GITHUB_RUN_ATTEMPT: "1",
		GITHUB_ACTOR_ID: "24680",
		GITHUB_OUTPUT: githubOutput,
		GITHUB_STEP_SUMMARY: githubSummary,
	};
	const localParity = JSON.parse(
		run(repository, process.execPath, [
			packedCli,
			"gate",
			"--repo",
			".",
			"--plan-id",
			flatLifecycle.planId,
			"--head",
			flatLifecycle.head,
			"--json",
		]),
	).data;
	const ciArtifactPath = resolve(semanticInputs, "ci-artifact.json");
	const ciRun = invoke(
		repository,
		process.execPath,
		[
			packedCli,
			"ci",
			"run",
			"--event",
			eventPath,
			"--plan-id",
			flatLifecycle.planId,
			"--output",
			ciArtifactPath,
			"--json",
		],
		{ env: ciEnvironment },
	);
	assert.equal(ciRun.status, 0, ciRun.stderr || ciRun.stdout);
	const ciResult = JSON.parse(ciRun.stdout);
	const ciArtifact = JSON.parse(await readFile(ciArtifactPath, "utf8"));
	assert.equal(ciResult.command, "ci-run");
	assert.equal(ciResult.data.outcome, "pass");
	assert.deepEqual(ciResult.data.gateInputDigest, localParity.gateResult.inputDigest);
	assert.deepEqual(ciResult.data.gateResult, localParity.gateResult);
	assert.equal(ciArtifact.schema, "graphrefly.stack.ci-bundle.v1");
	assert.equal(ciArtifact.invocation.event.head.value, flatLifecycle.head);
	assert.equal(ciArtifact.invocation.plan.id, flatLifecycle.planId);
	assert.equal(ciArtifact.invocation.identity.assurance, "platform-asserted");
	assert.equal(ciArtifact.invocation.cacheInputs.stackVersion, packageVersion);
	assert.match(ciArtifact.invocation.cacheInputs.graphreflyVersion, /^0\.3\.\d+$/u);
	assert.equal(ciArtifact.result.outcome, ciArtifact.result.gateResult.verdict);
	assert.equal(
		ciArtifact.result.gateInputDigest.value,
		ciArtifact.result.gateResult.inputDigest.value,
	);
	assert.equal(
		ciArtifact.result.artifactName,
		`graphrefly-stack-ci-${ciArtifact.result.portableBundleDigest.value}`,
	);
	assert.deepEqual(ciArtifact.result.redaction.excludes, [
		"source-content",
		"raw-blueprint",
		"check-output",
		"credentials",
		"environment",
		"model-response",
	]);
	assert.equal(Object.hasOwn(ciArtifact, "source"), false);
	assert.match(
		await readFile(githubOutput, "utf8"),
		/artifact-name=graphrefly-stack-ci-[0-9a-f]{64}/u,
	);
	assert.match(await readFile(githubSummary, "utf8"), /Verdict: pass/u);

	const discoveredArtifactPath = resolve(semanticInputs, "ci-artifact-discovered.json");
	const discoveredRun = invoke(
		repository,
		process.execPath,
		[packedCli, "ci", "run", "--event", eventPath, "--output", discoveredArtifactPath, "--json"],
		{ env: { ...ciEnvironment, GITHUB_RUN_ATTEMPT: "2" } },
	);
	assert.equal(discoveredRun.status, 0, discoveredRun.stderr || discoveredRun.stdout);
	const discovered = JSON.parse(await readFile(discoveredArtifactPath, "utf8"));
	assert.equal(discovered.invocation.plan.id, flatLifecycle.planId);
	assert.equal(discovered.invocation.run.attempt, 2);
	assert.deepEqual(discovered.result.gateInputDigest, ciArtifact.result.gateInputDigest);
	assert.deepEqual(discovered.result.gateResult, ciArtifact.result.gateResult);
	assert.notDeepEqual(discovered.result.invocationDigest, ciArtifact.result.invocationDigest);
	const forkEvent = JSON.parse(await readFile(eventPath, "utf8"));
	forkEvent.pull_request.head.repo.id = 777777;
	await writeFile(eventPath, `${JSON.stringify(forkEvent, null, 2)}\n`, "utf8");
	const forkArtifactPath = resolve(semanticInputs, "ci-artifact-fork.json");
	const forkRun = invoke(
		repository,
		process.execPath,
		[
			packedCli,
			"ci",
			"run",
			"--event",
			eventPath,
			"--plan-id",
			flatLifecycle.planId,
			"--output",
			forkArtifactPath,
			"--json",
		],
		{ env: { ...ciEnvironment, GITHUB_RUN_ATTEMPT: "5" } },
	);
	assert.equal(forkRun.status, 0, forkRun.stderr || forkRun.stdout);
	const forkArtifact = JSON.parse(await readFile(forkArtifactPath, "utf8"));
	assert.equal(forkArtifact.invocation.repository.id, "123456");
	assert.equal(forkArtifact.invocation.repository.headRepositoryId, "777777");
	assert.equal(forkArtifact.result.outcome, "pass");
	forkEvent.pull_request.head.repo.id = 123456;
	await writeFile(eventPath, `${JSON.stringify(forkEvent, null, 2)}\n`, "utf8");

	run(repository, "git", ["switch", "packed-unrelated-rebase"]);
	const unrelatedLocal = JSON.parse(
		run(repository, process.execPath, [
			packedCli,
			"gate",
			"--repo",
			".",
			"--plan-id",
			flatLifecycle.planId,
			"--head",
			flatLifecycle.unrelatedHead,
			"--json",
		]),
	).data;
	const unrelatedEvent = JSON.parse(await readFile(eventPath, "utf8"));
	unrelatedEvent.pull_request.head.sha = flatLifecycle.unrelatedHead;
	await writeFile(eventPath, `${JSON.stringify(unrelatedEvent, null, 2)}\n`, "utf8");
	const unrelatedArtifactPath = resolve(semanticInputs, "ci-artifact-unrelated.json");
	const unrelatedCi = invoke(
		repository,
		process.execPath,
		[
			packedCli,
			"ci",
			"run",
			"--event",
			eventPath,
			"--plan-id",
			flatLifecycle.planId,
			"--output",
			unrelatedArtifactPath,
			"--json",
		],
		{
			env: {
				...ciEnvironment,
				GITHUB_WORKFLOW_SHA: flatLifecycle.unrelatedHead,
				GITHUB_RUN_ATTEMPT: "3",
			},
		},
	);
	assert.equal(unrelatedCi.status, 0, unrelatedCi.stderr || unrelatedCi.stdout);
	const unrelatedArtifact = JSON.parse(await readFile(unrelatedArtifactPath, "utf8"));
	assert.deepEqual(unrelatedArtifact.result.gateResult, unrelatedLocal.gateResult);
	assert.equal(
		unrelatedArtifact.portableBundle.artifacts["records.json"].every(
			(record) => record.rebindFrom !== null,
		),
		true,
	);

	run(repository, "git", ["switch", "--detach", flatLifecycle.architectureHead]);
	const architectureLocalRun = invoke(repository, process.execPath, [
		packedCli,
		"gate",
		"--repo",
		".",
		"--plan-id",
		flatLifecycle.planId,
		"--head",
		flatLifecycle.architectureHead,
		"--json",
	]);
	assert.equal(architectureLocalRun.status, 2, architectureLocalRun.stderr);
	const architectureLocal = JSON.parse(architectureLocalRun.stdout).data;
	const architectureEvent = JSON.parse(await readFile(eventPath, "utf8"));
	architectureEvent.pull_request.head.sha = flatLifecycle.architectureHead;
	await writeFile(eventPath, `${JSON.stringify(architectureEvent, null, 2)}\n`, "utf8");
	const architectureArtifactPath = resolve(semanticInputs, "ci-artifact-architecture.json");
	const architectureCi = invoke(
		repository,
		process.execPath,
		[
			packedCli,
			"ci",
			"run",
			"--event",
			eventPath,
			"--plan-id",
			flatLifecycle.planId,
			"--output",
			architectureArtifactPath,
			"--json",
		],
		{
			env: {
				...ciEnvironment,
				GITHUB_WORKFLOW_SHA: flatLifecycle.architectureHead,
				GITHUB_RUN_ATTEMPT: "4",
			},
		},
	);
	assert.equal(architectureCi.status, 2, architectureCi.stderr || architectureCi.stdout);
	const architectureArtifact = JSON.parse(await readFile(architectureArtifactPath, "utf8"));
	assert.equal(architectureArtifact.result.outcome, "blocked");
	assert.deepEqual(architectureArtifact.result.gateResult, architectureLocal.gateResult);
	assert.deepEqual(architectureArtifact.result.summary.affectedWorkUnitIds, ["VERIFY"]);
	assert.deepEqual(architectureArtifact.result.summary.reasonCodes, [
		"BLUEPRINT_PREDICATE_UNSATISFIED",
	]);
	run(repository, "git", ["switch", "main"]);
	await writeFile(resolve(repository, "package.json"), originalPackageJson, "utf8");
	assert.equal(run(repository, "git", ["status", "--short"]), "");

	const mountedRepository = resolve(temporary, "mounted-consumer-repository");
	await mkdir(mountedRepository);
	await Promise.all([
		put(mountedRepository, ".gitignore", "node_modules\n"),
		put(
			mountedRepository,
			"package.json",
			`${JSON.stringify(
				{
					name: "mounted-graphrefly-consumer",
					private: true,
					type: "module",
					dependencies: { "@graphrefly/ts": "0.3.x" },
					devDependencies: { "@graphrefly/stack": `file:${tarball}` },
				},
				null,
				2,
			)}\n`,
		),
		put(
			mountedRepository,
			"src/application-graph.mjs",
			`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "mounted-installed-proof" });
  application.state(1, { name: "source" });
  const audit = graph({ name: "audit" });
  audit.state("idle", { name: "sink" });
  application.mount(audit, { at: "audit" });
  return application;
}
`,
		),
	]);
	run(mountedRepository, "pnpm", ["install", "--ignore-scripts"]);
	run(mountedRepository, "git", ["init", "-b", "main"]);
	const mountedInit = JSON.parse(
		run(mountedRepository, "pnpm", [
			"exec",
			"grfs",
			"init",
			"--graph-module",
			"src/application-graph.mjs",
			"--json",
		]),
	);
	assert.equal(mountedInit.ok, true);
	commit(mountedRepository, "onboard mounted installed package");
	const mutationTarget = resolve(mountedRepository, "sandbox-escape.txt");
	const mountedLifecycle = await runInstalledSemanticLifecycle(
		mountedRepository,
		semanticInputs,
		"mounted-installed",
		"audit::sink",
		[
			"node",
			"-e",
			`const fs=require("node:fs");try{fs.writeFileSync(${JSON.stringify(mutationTarget)},"unsafe");process.exitCode=91}catch(error){if(!["EACCES","EPERM","EROFS"].includes(error.code))throw error}`,
		],
	);
	await proveInstalledIntegration(
		mountedRepository,
		semanticInputs,
		mountedLifecycle,
		"independent-mounted",
		84,
	);
	await assert.rejects(readFile(mutationTarget, "utf8"));
	await proveInstalledCiPass(mountedRepository, semanticInputs, mountedLifecycle, 234567, 84);
	await proveInstalledMergeGroup(temporary, tarball);
});
