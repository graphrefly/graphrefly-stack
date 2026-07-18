import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("generic review rejects merge history before executing repository code", async (context) => {
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
	assert.equal(failedReview(repository, base, head), "NON_LINEAR_HISTORY");
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
