import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createSemanticPlan,
	replanSemanticPlan,
} from "../../packages/cli/dist/semantic-repository.js";
import { sha256Jcs } from "../../packages/contracts/dist/index.js";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const cli = resolve(workspace, "packages/cli/dist/cli.js");
const workspaceNodeModules = resolve(workspace, "node_modules");

const packageJson = `${JSON.stringify(
	{
		name: "graphrefly-stack-conformance-repository",
		private: true,
		type: "module",
		dependencies: { "@graphrefly/ts": "0.3.x" },
	},
	null,
	2,
)}\n`;

const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@graphrefly/ts':
        specifier: 0.3.x
        version: 0.3.0

packages:

  '@graphrefly/ts@0.3.0':
    resolution: {integrity: sha512-JlGQyBvrKU9EK/1x0wTalNAEP8J6rc/v00RznEhg5BeXivyYnrR1P4a7ByvJSQPllaX/QW7nPpQffkCAM2MQPw==}
    peerDependencies:
      react: ^18.0.0 || ^19.0.0
    peerDependenciesMeta:
      react:
        optional: true

snapshots:

  '@graphrefly/ts@0.3.0': {}
`;

const config = `${JSON.stringify(
	{
		schema: "graphrefly.stack.repository.v1",
		blueprint: { entrypoint: "graphrefly-stack.blueprint.mjs" },
	},
	null,
	2,
)}\n`;

const blueprintEntrypoint = `import { createHash } from "node:crypto";
import { withBlueprintHash } from "@graphrefly/ts/graph";
import { createApplicationGraph } from "./graph.mjs";

const blueprint = withBlueprintHash(
  createApplicationGraph().blueprint({ diagnostics: true, provenance: { source: "product-1-conformance" } }),
  { algorithm: "sha256", hash: (bytes) => createHash("sha256").update(bytes).digest("hex") },
);
process.stdout.write(JSON.stringify(blueprint));
`;

function run(repository, command, args = []) {
	const result = spawnSync(command, args, {
		cwd: repository,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "GraphReFly Stack",
			GIT_AUTHOR_EMAIL: "stack@example.invalid",
			GIT_COMMITTER_NAME: "GraphReFly Stack",
			GIT_COMMITTER_EMAIL: "stack@example.invalid",
		},
		maxBuffer: 8 * 1024 * 1024,
	});
	assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}`);
	return result.stdout.trim();
}

async function write(repository, path, value) {
	const target = resolve(repository, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, value);
}

function commit(repository, subject) {
	run(repository, "git", ["add", "-A"]);
	run(repository, "git", ["commit", "-m", subject]);
	return run(repository, "git", ["rev-parse", "HEAD"]);
}

async function createRepository(root, name, graphSource) {
	const repository = resolve(root, name);
	await mkdir(repository, { recursive: true });
	run(repository, "git", ["init", "-b", "main"]);
	await Promise.all([
		write(repository, ".gitignore", "node_modules\n"),
		write(repository, ".graphrefly-stack.json", config),
		write(repository, "package.json", packageJson),
		write(repository, "pnpm-lock.yaml", lockfile),
		write(repository, "graphrefly-stack.blueprint.mjs", blueprintEntrypoint),
		write(repository, "graph.mjs", graphSource),
		write(repository, "README.md", `# ${name}\n`),
	]);
	await symlink(workspaceNodeModules, resolve(repository, "node_modules"), "dir");
	return repository;
}

function review(repository, base, head) {
	const result = spawnSync(
		process.execPath,
		[cli, "review", "--repo", repository, "--base", base, "--head", head, "--json"],
		{ cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout.trim().split("\n").length, 1);
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, true);
	assert.equal(envelope.command, "review");
	return envelope.data;
}

function failedReview(repository, base, head) {
	const result = spawnSync(
		process.execPath,
		[cli, "review", "--repo", repository, "--base", base, "--head", head, "--json"],
		{ cwd: workspace, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
	);
	assert.equal(result.status, 1, result.stderr || result.stdout);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, false);
	return envelope.error.code;
}

function semanticPlan(repository, args) {
	return semanticCommand(repository, "plan", args);
}

function semanticCommand(repository, command, args) {
	const result = spawnSync(
		process.execPath,
		[cli, command, "--repo", repository, ...args, "--json"],
		{
			cwd: workspace,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	const envelope = JSON.parse(result.stdout);
	return { status: result.status, envelope, stderr: result.stderr };
}

function workUnitCommit(repository, subject, workUnitId) {
	run(repository, "git", ["add", "-A"]);
	run(repository, "git", ["commit", "-m", subject, "-m", `GraphReFly-Work-Unit: ${workUnitId}`]);
	return run(repository, "git", ["rev-parse", "HEAD"]);
}

const flatGraph = `import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "failure-case" });
  application.state(1, { name: "source" });
  return application;
}
`;

test("a flat GraphReFly repo yields a real linear stack, upstream graph delta, and structured Git diff", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-flat-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const repository = await createRepository(
		temporary,
		"flat-small",
		`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "flat-small" });
  application.state(1, { name: "source" });
  return application;
}
`,
	);
	const base = commit(repository, "create source graph");
	await write(
		repository,
		"graph.mjs",
		`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "flat-small" });
  const source = application.state(1, { name: "source" });
  application.derived([source], (value) => value + 1, { name: "projection" });
  return application;
}
`,
	);
	commit(repository, "add projected value");
	await write(
		repository,
		"docs/projection notes.md",
		"The projection is intentionally documented.\n",
	);
	const head = commit(repository, "document projected value");

	const result = review(repository, base, head);
	assert.equal(result.schema, "graphrefly.stack.review.v1");
	assert.equal(result.repository.graphreflyVersion, "0.3.0");
	assert.equal(result.repository.headLabel, "main");
	assert.deepEqual(
		result.commits.map((entry) => entry.subject),
		["add projected value", "document projected value"],
	);
	assert.deepEqual(
		result.commits[0].delta.events.map((event) => event.type),
		["node-added", "edge-added"],
	);
	assert.deepEqual(result.commits[1].delta.events, []);
	assert.deepEqual(result.commits[0].diff.paths, ["graph.mjs"]);
	assert.deepEqual(result.commits[1].diff.paths, ["docs/projection notes.md"]);
	assert.equal(
		result.commits[0].diff.files[0].hunks[0].lines.some((line) => line.kind === "add"),
		true,
	);
	assert.match(result.commits[0].diagram.source, /^flowchart LR/m);
	assert.equal(Object.hasOwn(result.base.blueprint, "provenance"), false);
	assert.equal(result.semanticStatus, "not-configured");
	assert.equal(Object.hasOwn(result, "gateResult"), false);
});

test("a mounted GraphReFly repo preserves subgraph identity and reports metadata changes", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-mounted-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const repository = await createRepository(
		temporary,
		"mounted-small",
		`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "mounted-small" });
  application.state("ready", { name: "status" });
  return application;
}
`,
	);
	const base = commit(repository, "create root graph");
	await write(
		repository,
		"graph.mjs",
		`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "mounted-small" });
  application.state("ready", { name: "status" });
  const audit = graph({ name: "audit graph" });
  audit.state("idle", { name: "sink", meta: { role: "observer" } });
  application.mount(audit, { at: "audit" });
  return application;
}
`,
	);
	commit(repository, "mount audit graph");
	await write(
		repository,
		"graph.mjs",
		`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "mounted-small" });
  application.state("ready", { name: "status" });
  const audit = graph({ name: "audit graph" });
  audit.state("idle", { name: "sink", meta: { role: "validated-observer" } });
  application.mount(audit, { at: "audit" });
  return application;
}
`,
	);
	const head = commit(repository, "mark audit metadata validated");

	const result = review(repository, base, head);
	assert.deepEqual(
		result.commits[0].delta.events.map((event) => event.type),
		["subgraph-added", "node-added"],
	);
	assert.deepEqual(
		result.commits[1].delta.events.map((event) => event.type),
		["node-changed"],
	);
	assert.deepEqual(result.commits[1].delta.events[0].topologyPath, ["audit"]);
	assert.match(result.commits[1].diagram.source, /audit::sink/);
	assert.deepEqual(result.commits[1].diff.paths, ["graph.mjs"]);
});

test("generic review fails closed on incomplete input and missing repository config", async (context) => {
	const incomplete = spawnSync(process.execPath, [cli, "review", "--repo", workspace, "--json"], {
		cwd: workspace,
		encoding: "utf8",
	});
	assert.equal(incomplete.status, 1);
	assert.equal(JSON.parse(incomplete.stdout).error.code, "REVIEW_RANGE_INCOMPLETE");

	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-invalid-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const repository = resolve(temporary, "missing-config");
	await mkdir(repository);
	run(repository, "git", ["init", "-b", "main"]);
	await write(repository, "README.md", "base\n");
	const base = commit(repository, "base");
	await write(repository, "README.md", "head\n");
	const head = commit(repository, "head");
	const failed = spawnSync(
		process.execPath,
		[cli, "review", "--repo", repository, "--base", base, "--head", head, "--json"],
		{ cwd: workspace, encoding: "utf8" },
	);
	assert.equal(failed.status, 1);
	assert.equal(failed.stderr, "");
	assert.equal(JSON.parse(failed.stdout).error.code, "CONFIG_MISSING");
});

test("grfs init generates a reviewable config and Blueprint adapter", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-init-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const repository = resolve(temporary, "initialized-repository");
	await mkdir(repository);
	run(repository, "git", ["init", "-b", "main"]);
	await Promise.all([
		write(repository, "package.json", packageJson),
		write(repository, "pnpm-lock.yaml", lockfile),
		write(repository, "src/application-graph.mjs", flatGraph),
		symlink(workspaceNodeModules, resolve(repository, "node_modules"), "dir"),
	]);
	const base = commit(repository, "create existing GraphReFly repository");
	await write(
		repository,
		"src/application-graph.mjs",
		flatGraph.replace(
			'application.state(1, { name: "source" });',
			'const source = application.state(1, { name: "source" });\n  application.derived([source], (value) => value + 1, { name: "projection" });',
		),
	);
	const head = commit(repository, "derive projected value before Stack onboarding");
	const initialized = spawnSync(
		process.execPath,
		[cli, "init", "--repo", repository, "--graph-module", "src/application-graph.mjs", "--json"],
		{ cwd: workspace, encoding: "utf8" },
	);
	assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
	assert.equal(JSON.parse(initialized.stdout).data.entrypoint, "graphrefly-stack.blueprint.mjs");
	const config = JSON.parse(await readFile(resolve(repository, ".graphrefly-stack.json"), "utf8"));
	assert.equal(config.blueprint.entrypoint, "graphrefly-stack.blueprint.mjs");
	assert.match(
		await readFile(resolve(repository, "graphrefly-stack.blueprint.mjs"), "utf8"),
		/src\/application-graph\.mjs/u,
	);
	const duplicateInit = spawnSync(
		process.execPath,
		[cli, "init", "--repo", repository, "--graph-module", "src/application-graph.mjs", "--json"],
		{ cwd: workspace, encoding: "utf8" },
	);
	assert.equal(duplicateInit.status, 1);
	assert.equal(JSON.parse(duplicateInit.stdout).error.code, "INIT_ALREADY_EXISTS");
	const escapingInit = spawnSync(
		process.execPath,
		[cli, "init", "--repo", repository, "--graph-module", "../outside.mjs", "--json"],
		{ cwd: workspace, encoding: "utf8" },
	);
	assert.equal(escapingInit.status, 1);
	assert.equal(JSON.parse(escapingInit.stdout).error.code, "INIT_PATH_INVALID");
	assert.deepEqual(
		review(repository, base, head).commits[0].delta.events.map((event) => event.type),
		["node-added", "edge-added"],
	);
	assert.equal(run(repository, "git", ["rev-parse", "HEAD"]), head);
	const status = run(repository, "git", ["status", "--short"]);
	assert.match(status, /\.graphrefly-stack\.json/u);
	assert.match(status, /graphrefly-stack\.blueprint\.mjs/u);
	await rm(resolve(repository, "graphrefly-stack.blueprint.mjs"));
	assert.equal(failedReview(repository, base, head), "ENTRYPOINT_MISSING");
});

test("generic review permits ordinary dependency changes and rejects incompatible runtime ranges", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-contract-failures-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));

	const escapeRepo = await createRepository(temporary, "entrypoint-escape", flatGraph);
	const escapeBase = commit(escapeRepo, "base");
	await write(escapeRepo, "README.md", "head\n");
	const escapeHead = commit(escapeRepo, "head");
	await write(
		escapeRepo,
		".graphrefly-stack.json",
		'{"schema":"graphrefly.stack.repository.v1","blueprint":{"entrypoint":"../escape.mjs"}}\n',
	);
	assert.equal(failedReview(escapeRepo, escapeBase, escapeHead), "CONFIG_INVALID");

	const transitionRepo = await createRepository(temporary, "dependency-transition", flatGraph);
	const transitionBase = commit(transitionRepo, "base");
	const changedPackage = JSON.parse(packageJson);
	changedPackage.scripts = { check: "node --check graph.mjs" };
	await write(transitionRepo, "package.json", `${JSON.stringify(changedPackage, null, 2)}\n`);
	await rm(resolve(transitionRepo, "pnpm-lock.yaml"));
	await write(
		transitionRepo,
		"package-lock.json",
		'{"name":"dependency-transition","lockfileVersion":3}\n',
	);
	const transitionHead = commit(transitionRepo, "change ordinary dependency metadata");
	assert.deepEqual(review(transitionRepo, transitionBase, transitionHead).commits[0].diff.paths, [
		"package-lock.json",
		"package.json",
		"pnpm-lock.yaml",
	]);

	const unsupportedRepo = await createRepository(temporary, "unsupported-runtime", flatGraph);
	await write(unsupportedRepo, "package.json", packageJson.replace('"0.3.x"', '"0.2.x"'));
	await write(unsupportedRepo, "pnpm-lock.yaml", lockfile.replaceAll("0.3.0", "0.2.1"));
	const unsupportedBase = commit(unsupportedRepo, "base on unsupported runtime");
	await write(unsupportedRepo, "README.md", "head\n");
	const unsupportedHead = commit(unsupportedRepo, "head on unsupported runtime");
	assert.equal(
		failedReview(unsupportedRepo, unsupportedBase, unsupportedHead),
		"DEPENDENCY_UNSUPPORTED",
	);
});

test("generic review requires a semantic plan for merge history before executing repository code", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-history-failure-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const repository = await createRepository(temporary, "merge-history", flatGraph);
	const base = commit(repository, "base");
	await write(repository, "README.md", "main change\n");
	commit(repository, "main change");
	run(repository, "git", ["checkout", "-b", "side", base]);
	await write(repository, "SIDE.md", "side change\n");
	commit(repository, "side change");
	run(repository, "git", ["checkout", "main"]);
	run(repository, "git", ["merge", "--no-ff", "side", "-m", "merge side"]);
	const head = run(repository, "git", ["rev-parse", "HEAD"]);
	assert.equal(failedReview(repository, base, head), "DAG_REVIEW_PLAN_REQUIRED");
});

test("generic review rejects timeout, malformed Blueprint, diagnostics failure, and hash mismatch", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-blueprint-failures-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const cases = [
		{
			name: "malformed-blueprint",
			entrypoint: 'process.stdout.write("{}");\n',
			code: "BLUEPRINT_INVALID",
		},
		{
			name: "diagnostics-error",
			entrypoint: `import { createHash } from "node:crypto";
import { withBlueprintHash } from "@graphrefly/ts/graph";
import { createApplicationGraph } from "./graph.mjs";
const value = withBlueprintHash(createApplicationGraph().blueprint(), { algorithm: "sha256", hash: (bytes) => createHash("sha256").update(bytes).digest("hex") });
process.stdout.write(JSON.stringify(value));
`,
			code: "BLUEPRINT_DIAGNOSTICS_ERROR",
		},
		{
			name: "hash-mismatch",
			entrypoint: `import { createHash } from "node:crypto";
import { withBlueprintHash } from "@graphrefly/ts/graph";
import { createApplicationGraph } from "./graph.mjs";
const value = withBlueprintHash(createApplicationGraph().blueprint({ diagnostics: true }), { algorithm: "sha256", hash: (bytes) => createHash("sha256").update(bytes).digest("hex") });
const forged = JSON.parse(JSON.stringify(value));
forged.hash.value = "0000000000000000000000000000000000000000000000000000000000000000";
process.stdout.write(JSON.stringify(forged));
`,
			code: "BLUEPRINT_HASH_MISMATCH",
		},
	];
	for (const fixture of cases) {
		const repository = await createRepository(temporary, fixture.name, flatGraph);
		const base = commit(repository, "base");
		await write(repository, "graphrefly-stack.blueprint.mjs", fixture.entrypoint);
		const head = commit(repository, `trigger ${fixture.name}`);
		assert.equal(failedReview(repository, base, head), fixture.code);
	}

	const timeoutRepo = await createRepository(temporary, "timeout", flatGraph);
	const timeoutBase = commit(timeoutRepo, "base");
	await write(timeoutRepo, "graphrefly-stack.blueprint.mjs", "for (;;) {}\n");
	const timeoutHead = commit(timeoutRepo, "loop forever");
	assert.equal(failedReview(timeoutRepo, timeoutBase, timeoutHead), "ENTRYPOINT_TIMEOUT");
});

test("generic semantic planning accepts before implementation and binds flat and mounted repositories", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-semantic-plan-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const inputRoot = resolve(temporary, "inputs");
	await mkdir(inputRoot);
	const policyPath = resolve(inputRoot, "policy.json");
	const policy = {
		schema: "graphrefly.stack.semantic-policy.v1",
		policyId: "repository-policy",
		revision: "rev-1",
		allowedSourceRoots: ["graph.mjs", "src", "tests"],
		allowedCapabilities: ["graph-change"],
		checks: [
			{
				id: "test",
				argv: ["node", "--test"],
				timeoutMs: 120000,
				network: false,
				shell: false,
			},
		],
	};
	await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
	const variants = [
		{
			name: "semantic-flat",
			graph: flatGraph,
			nodeId: "source",
		},
		{
			name: "semantic-mounted",
			graph: `import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "mounted" });
  application.state(1, { name: "source" });
  const audit = graph({ name: "audit" });
  audit.state("idle", { name: "sink" });
  application.mount(audit, { at: "audit" });
  return application;
}
`,
			nodeId: "audit::sink",
		},
	];
	for (const variant of variants) {
		const repository = await createRepository(temporary, variant.name, variant.graph);
		const base = commit(repository, "create semantic planning base");
		const proposalPath = resolve(inputRoot, `${variant.name}.json`);
		const proposal = {
			schema: "graphrefly.stack.semantic-plan-proposal.v1",
			planId: `${variant.name}-plan`,
			proposalSource: "human",
			workUnits: [
				{
					id: "CONTRACTS",
					title: "Define the contract",
					intent: "Add the repository contract before behavior.",
					dependencies: [],
					allowedSourceScopes: ["src"],
					capabilities: ["graph-change"],
					claims: [
						{
							id: "base-node-present",
							predicate: {
								operator: "present",
								selector: { kind: "node", nodeId: variant.nodeId },
							},
							rationale: "The change is anchored to an existing stable node.",
						},
					],
					requiredChecks: ["test"],
				},
				{
					id: "TESTS",
					title: "Verify the contract",
					intent: "Add focused conformance evidence.",
					dependencies: ["CONTRACTS"],
					allowedSourceScopes: ["tests"],
					capabilities: [],
					claims: [
						{
							id: "base-node-still-present",
							predicate: {
								operator: "absent",
								selector: { kind: "node", nodeId: "ghost" },
							},
							rationale: "Tests preserve the absence of an undeclared architecture node.",
						},
					],
					requiredChecks: ["test"],
				},
			],
		};
		await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);
		if (variant.name === "semantic-flat") {
			const taskSummary = "Add a verified semantic contract";
			const contextPath = resolve(inputRoot, "model-context.json");
			await writeFile(
				contextPath,
				`${JSON.stringify(
					{
						schema: "graphrefly.stack.semantic-model-context.v1",
						purpose: "plan",
						taskDigest: { algorithm: "sha256", value: sha256Jcs({ taskSummary }) },
						policyDigest: { algorithm: "sha256", value: sha256Jcs(policy) },
						policyFields: [
							"policyId",
							"revision",
							"allowedSourceRoots",
							"allowedCapabilities",
							"checkIds",
						],
						blueprintFields: ["version", "topology.nodes", "topology.edges", "hash"],
						sourcePaths: ["graph.mjs"],
						omittedClasses: [
							"credentials",
							"environment",
							"unlisted-source",
							"execution-details",
							"raw-provider-output",
						],
						authorization: { mode: "explicit-cli", identityVerified: false },
					},
					null,
					2,
				)}\n`,
			);
			const liveProposal = { ...proposal, proposalSource: "codex" };
			let modelRequest;
			const live = await createSemanticPlan(
				{
					repository,
					taskSummary,
					policyPath,
					contextPath,
					mode: "live",
					authorizeContext: true,
					accept: false,
				},
				{
					async run(request) {
						assert.equal(JSON.stringify(request.outputSchema).includes("oneOf"), false);
						assert.equal(JSON.stringify(request.outputSchema).includes("anyOf"), true);
						assert.equal(
							Object.hasOwn(request.outputSchema.definitions, "RepositoryPolicy"),
							false,
						);
						modelRequest = JSON.parse(
							await readFile(resolve(request.workingDirectory, "request.json")),
						);
						return {
							finalResponse: JSON.stringify(liveProposal),
							threadId: "semantic-live-test",
							usage: null,
						};
					},
				},
			);
			assert.equal(live.draft.proposal.proposalSource, "codex");
			assert.deepEqual(Object.keys(modelRequest.sources), ["graph.mjs"]);
			assert.equal(Object.hasOwn(modelRequest.sources, "package.json"), false);
			assert.deepEqual(modelRequest.policy.checkIds, ["test"]);
			assert.equal(Object.hasOwn(modelRequest.policy, "checks"), false);
			await assert.rejects(
				createSemanticPlan(
					{
						repository,
						taskSummary,
						policyPath,
						contextPath,
						mode: "live",
						authorizeContext: false,
						accept: false,
					},
					{ run: async () => assert.fail("unauthorized context reached the provider") },
				),
				(error) => error.code === "MODEL_CONTEXT_UNAUTHORIZED",
			);
		}
		const drafted = semanticPlan(repository, [
			"--task",
			"Add a verified semantic contract",
			"--policy",
			policyPath,
			"--proposal",
			proposalPath,
		]);
		assert.equal(drafted.status, 0, drafted.stderr || JSON.stringify(drafted.envelope));
		assert.equal(drafted.envelope.data.draft.admission.baseCommit.value, base);
		assert.equal(drafted.envelope.data.draft.proposal.planId, proposal.planId);
		await assert.rejects(access(resolve(repository, ".graphrefly-stack/policy.json")));
		if (variant.name === "semantic-flat") {
			const widened = structuredClone(proposal);
			widened.workUnits[0].allowedSourceScopes = ["docs"];
			const widenedPath = resolve(inputRoot, "widened-proposal.json");
			await writeFile(widenedPath, `${JSON.stringify(widened, null, 2)}\n`);
			const rejected = semanticPlan(repository, [
				"--task",
				"Add a verified semantic contract",
				"--policy",
				policyPath,
				"--proposal",
				widenedPath,
			]);
			assert.equal(rejected.status, 1);
			assert.equal(rejected.envelope.error.code, "PLAN_SOURCE_SCOPE_WIDENED");
		}

		const accepted = semanticPlan(repository, [
			"--task",
			"Add a verified semantic contract",
			"--policy",
			policyPath,
			"--proposal",
			proposalPath,
			"--accept",
			"--accept-by",
			"local-reviewer",
		]);
		assert.equal(accepted.status, 0, accepted.stderr || JSON.stringify(accepted.envelope));
		assert.equal(accepted.envelope.data.plan.acceptedBy.identityVerified, false);
		const acceptedPlanPath = resolve(repository, `.graphrefly-stack/plans/${proposal.planId}.json`);
		assert.equal(JSON.parse(await readFile(acceptedPlanPath, "utf8")).baseCommit.value, base);
		const acceptanceCommit = commit(repository, "accept semantic plan and policy");

		await write(repository, "src/contract.ts", "export const semanticContract = true;\n");
		const contractsCommit = workUnitCommit(repository, "define semantic contract", "CONTRACTS");
		await write(repository, "tests/contract.test.mjs", "export const contractEvidence = true;\n");
		const head = workUnitCommit(repository, "verify semantic contract", "TESTS");
		const bound = semanticPlan(repository, [
			"--bind",
			"--plan-id",
			proposal.planId,
			"--head",
			head,
		]);
		assert.equal(bound.status, 0, bound.stderr || JSON.stringify(bound.envelope));
		assert.deepEqual(
			bound.envelope.data.bindings.map((binding) => binding.workUnitId),
			["CONTRACTS", "TESTS"],
		);
		assert.equal(bound.envelope.data.acceptanceCommit.length, 40);
		assert.equal(bound.envelope.data.bindings[0].changedPaths[0], "src/contract.ts");
		assert.equal(bound.envelope.data.bindings[1].changedPaths[0], "tests/contract.test.mjs");
		if (variant.name === "semantic-flat") {
			const firstGate = semanticCommand(repository, "gate", [
				"--plan-id",
				proposal.planId,
				"--head",
				head,
			]);
			assert.equal(firstGate.status, 0, firstGate.stderr || JSON.stringify(firstGate.envelope));
			assert.equal(firstGate.envelope.data.gateResult.verdict, "pass");
			assert.deepEqual(
				firstGate.envelope.data.gateResult.units.map((unit) => unit.verdict),
				["valid", "valid"],
			);
			const repeatedGate = semanticCommand(repository, "gate", [
				"--plan-id",
				proposal.planId,
				"--head",
				head,
			]);
			assert.equal(repeatedGate.status, 0);
			assert.deepEqual(
				repeatedGate.envelope.data.input.records.map((record) => record.recordId),
				firstGate.envelope.data.input.records.map((record) => record.recordId),
			);

			const exportPath = resolve(temporary, "semantic-portable.json");
			const exported = semanticCommand(repository, "export", [
				"--plan-id",
				proposal.planId,
				"--head",
				head,
				"--output",
				exportPath,
			]);
			assert.equal(exported.status, 0, exported.stderr || JSON.stringify(exported.envelope));
			const portable = JSON.parse(await readFile(exportPath, "utf8"));
			assert.equal(portable.schema, "graphrefly.stack.semantic-portable-bundle.v1");
			assert.equal(JSON.stringify(portable).includes("semanticContract = true"), false);
			const semanticReview = semanticCommand(repository, "review", [
				"--base",
				base,
				"--head",
				head,
				"--plan-id",
				proposal.planId,
			]);
			assert.equal(
				semanticReview.status,
				0,
				semanticReview.stderr || JSON.stringify(semanticReview.envelope),
			);
			assert.equal(semanticReview.envelope.data.semanticStatus, "evaluated");
			assert.equal(semanticReview.envelope.data.semantic.gateResult.verdict, "pass");
			assert.equal(Object.hasOwn(semanticReview.envelope.data, "reviewDecision"), false);

			run(repository, "git", ["switch", "-c", "unrelated-rebase", base]);
			await write(repository, "README.md", "# semantic-flat\n\nUpstream documentation.\n");
			commit(repository, "upstream documentation");
			run(repository, "git", ["cherry-pick", acceptanceCommit, contractsCommit, head]);
			const unrelatedHead = run(repository, "git", ["rev-parse", "HEAD"]);
			const rebound = semanticCommand(repository, "gate", [
				"--plan-id",
				proposal.planId,
				"--head",
				unrelatedHead,
			]);
			assert.equal(rebound.status, 0, rebound.stderr || JSON.stringify(rebound.envelope));
			assert.equal(rebound.envelope.data.gateResult.verdict, "pass");
			assert.equal(
				rebound.envelope.data.input.records.every((record) => record.rebindFrom !== null),
				true,
			);

			run(repository, "git", ["switch", "-c", "architecture-rebase", base]);
			await write(
				repository,
				"graph.mjs",
				`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "failure-case" });
  application.state(1, { name: "source" });
  application.state(0, { name: "ghost" });
  return application;
}
`,
			);
			commit(repository, "upstream adds architecture node");
			run(repository, "git", ["cherry-pick", acceptanceCommit, contractsCommit, head]);
			const architectureHead = run(repository, "git", ["rev-parse", "HEAD"]);
			const stale = semanticCommand(repository, "gate", [
				"--plan-id",
				proposal.planId,
				"--head",
				architectureHead,
			]);
			assert.equal(stale.status, 2, stale.stderr || JSON.stringify(stale.envelope));
			assert.equal(stale.envelope.data.gateResult.verdict, "blocked");
			assert.deepEqual(stale.envelope.data.gateResult.units[0].reasonCodes, []);
			assert.deepEqual(stale.envelope.data.gateResult.units[1].reasonCodes, [
				"BLUEPRINT_PREDICATE_UNSATISFIED",
			]);

			const replacement = structuredClone(proposal);
			replacement.planId = "semantic-flat-recovery";
			replacement.workUnits = [
				{
					...proposal.workUnits[1],
					claims: [
						{
							id: "ghost-now-present",
							predicate: {
								operator: "present",
								selector: { kind: "node", nodeId: "ghost" },
							},
							rationale: "Recovery acknowledges the accepted upstream architecture.",
						},
					],
				},
			];
			const replacementPath = resolve(inputRoot, "semantic-flat-recovery.json");
			await writeFile(replacementPath, `${JSON.stringify(replacement, null, 2)}\n`);
			const replanContextPath = resolve(inputRoot, "semantic-replan-context.json");
			await writeFile(
				replanContextPath,
				`${JSON.stringify(
					{
						schema: "graphrefly.stack.semantic-model-context.v1",
						purpose: "selective-replan",
						taskDigest: {
							algorithm: "sha256",
							value: sha256Jcs({ taskSummary: "Add a verified semantic contract" }),
						},
						policyDigest: { algorithm: "sha256", value: sha256Jcs(policy) },
						policyFields: ["policyId", "revision", "allowedSourceRoots", "checkIds"],
						blueprintFields: ["version", "topology.nodes", "hash"],
						sourcePaths: ["graph.mjs"],
						omittedClasses: [
							"credentials",
							"environment",
							"unlisted-source",
							"execution-details",
							"raw-provider-output",
						],
						authorization: { mode: "explicit-cli", identityVerified: false },
					},
					null,
					2,
				)}\n`,
			);
			const liveReplacement = { ...replacement, proposalSource: "codex" };
			const liveRecovery = await replanSemanticPlan(
				{
					repository,
					planId: proposal.planId,
					head: architectureHead,
					contextPath: replanContextPath,
					mode: "live",
					authorizeContext: true,
					accept: false,
				},
				{
					async run(request) {
						const modelInput = JSON.parse(
							await readFile(resolve(request.workingDirectory, "request.json"), "utf8"),
						);
						assert.deepEqual(modelInput.selectiveBoundary.invalidUnits, ["TESTS"]);
						assert.deepEqual(modelInput.selectiveBoundary.preservedUnits, ["CONTRACTS"]);
						return {
							finalResponse: JSON.stringify(liveReplacement),
							threadId: "semantic-live-replan-test",
							usage: null,
						};
					},
				},
			);
			assert.equal(liveRecovery.draft.proposal.proposalSource, "codex");
			const replanned = semanticCommand(repository, "replan", [
				"--plan-id",
				proposal.planId,
				"--head",
				architectureHead,
				"--proposal",
				replacementPath,
			]);
			assert.equal(replanned.status, 0, replanned.stderr || JSON.stringify(replanned.envelope));
			assert.deepEqual(replanned.envelope.data.draft.selectiveReplan.preservedUnits, ["CONTRACTS"]);
			assert.deepEqual(replanned.envelope.data.draft.selectiveReplan.invalidUnits, ["TESTS"]);
			const acceptedRecovery = semanticCommand(repository, "replan", [
				"--plan-id",
				proposal.planId,
				"--head",
				architectureHead,
				"--proposal",
				replacementPath,
				"--accept",
				"--accept-by",
				"local-reviewer",
			]);
			assert.equal(
				acceptedRecovery.status,
				0,
				acceptedRecovery.stderr || JSON.stringify(acceptedRecovery.envelope),
			);
			commit(repository, "accept selective recovery");
			await write(repository, "tests/recovery.test.mjs", "export const recovered = true;\n");
			const recoveryHead = workUnitCommit(repository, "verify selective recovery", "TESTS");
			const recoveryBinding = semanticPlan(repository, [
				"--bind",
				"--plan-id",
				replacement.planId,
				"--head",
				recoveryHead,
			]);
			assert.equal(
				recoveryBinding.status,
				0,
				recoveryBinding.stderr || JSON.stringify(recoveryBinding.envelope),
			);
			assert.deepEqual(
				recoveryBinding.envelope.data.bindings.map((binding) => binding.workUnitId),
				["CONTRACTS", "TESTS"],
			);
			assert.equal(
				recoveryBinding.envelope.data.bindings[0].commit.value,
				run(repository, "git", ["rev-parse", `${architectureHead}~1`]),
			);
			const recovered = semanticCommand(repository, "gate", [
				"--plan-id",
				replacement.planId,
				"--head",
				recoveryHead,
			]);
			assert.equal(recovered.status, 0, recovered.stderr || JSON.stringify(recovered.envelope));
			assert.equal(recovered.envelope.data.gateResult.verdict, "pass");
			run(repository, "git", ["switch", "main"]);

			run(repository, "git", ["switch", "-c", "missing-trailer", acceptanceCommit]);
			await write(repository, "src/missing.ts", "export const missingTrailer = true;\n");
			commit(repository, "implementation without binding trailer");
			await write(repository, "tests/missing.test.mjs", "export const followup = true;\n");
			const missingHead = workUnitCommit(repository, "add followup evidence", "TESTS");
			const missing = semanticPlan(repository, [
				"--bind",
				"--plan-id",
				proposal.planId,
				"--head",
				missingHead,
			]);
			assert.equal(missing.status, 1);
			assert.equal(missing.envelope.error.code, "WORK_UNIT_TRAILER_MISSING");

			run(repository, "git", ["switch", "-c", "duplicate-trailer", acceptanceCommit]);
			await write(repository, "src/duplicate.ts", "export const duplicateTrailer = true;\n");
			run(repository, "git", ["add", "-A"]);
			run(repository, "git", [
				"commit",
				"-m",
				"implementation with duplicate binding trailers",
				"-m",
				"GraphReFly-Work-Unit: CONTRACTS\nGraphReFly-Work-Unit: CONTRACTS",
			]);
			await write(repository, "tests/duplicate.test.mjs", "export const followup = true;\n");
			const duplicateHead = workUnitCommit(repository, "add duplicate followup", "TESTS");
			const duplicate = semanticPlan(repository, [
				"--bind",
				"--plan-id",
				proposal.planId,
				"--head",
				duplicateHead,
			]);
			assert.equal(duplicate.status, 1);
			assert.equal(duplicate.envelope.error.code, "WORK_UNIT_TRAILER_DUPLICATE");
			run(repository, "git", ["switch", "main"]);

			run(repository, "git", ["switch", "-c", "scope-violation", acceptanceCommit]);
			await write(repository, "docs/outside.md", "outside the accepted unit scope\n");
			workUnitCommit(repository, "write outside scope", "CONTRACTS");
			await write(repository, "tests/scope.test.mjs", "export const scoped = true;\n");
			const scopeHead = workUnitCommit(repository, "add scoped test", "TESTS");
			const scoped = semanticCommand(repository, "gate", [
				"--plan-id",
				proposal.planId,
				"--head",
				scopeHead,
			]);
			assert.equal(scoped.status, 2, scoped.stderr || JSON.stringify(scoped.envelope));
			assert.deepEqual(scoped.envelope.data.gateResult.units[0].reasonCodes, [
				"SOURCE_SCOPE_VIOLATION",
			]);

			run(repository, "git", ["switch", "-c", "check-failure", acceptanceCommit]);
			await write(repository, "src/failing-contract.ts", "export const contract = true;\n");
			workUnitCommit(repository, "add contract for failed check", "CONTRACTS");
			await write(repository, "tests/failing.test.mjs", 'throw new Error("expected failure");\n');
			const failedCheckHead = workUnitCommit(repository, "add failing evidence", "TESTS");
			const failedCheck = semanticCommand(repository, "gate", [
				"--plan-id",
				proposal.planId,
				"--head",
				failedCheckHead,
			]);
			assert.equal(
				failedCheck.status,
				2,
				failedCheck.stderr || JSON.stringify(failedCheck.envelope),
			);
			assert.equal(
				failedCheck.envelope.data.gateResult.units[0].reasonCodes.includes("REQUIRED_CHECK_FAILED"),
				true,
			);
			run(repository, "git", ["switch", "main"]);
		}
		assert.equal(run(repository, "git", ["status", "--short"]), "");
	}
});
