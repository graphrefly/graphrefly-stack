import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { defaultReviewDist, startReviewServer } from "../../packages/cli/dist/review-server.js";
import { createStrictAjv, sha256Jcs } from "../../packages/contracts/dist/index.js";
import { CORE_ARCHITECTURE } from "../../packages/core/dist/index.js";

const root = new URL("../../", import.meta.url);

test("D17 package boundaries remain the composition authority", () => {
	assert.equal(CORE_ARCHITECTURE.version, "D17");
	assert.equal(CORE_ARCHITECTURE.processModel, "single-local-cli-process");
	assert.equal(CORE_ARCHITECTURE.defaultPlanMode, "replay");
	assert.deepEqual(CORE_ARCHITECTURE.canonicalCommands, [
		"init",
		"fixture create",
		"plan",
		"gate",
		"replan",
		"review",
		"export",
	]);
});

test("the CLI isolates one strict JSON envelope and rejects live mode on deterministic commands", async () => {
	const result = spawnSync(
		process.execPath,
		["packages/cli/dist/cli.js", "gate", "--mode", "live", "--json"],
		{
			cwd: new URL("../..", import.meta.url),
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout.trim().split("\n").length, 1);

	const envelope = JSON.parse(result.stdout);
	const schema = JSON.parse(
		await readFile(new URL("contracts/v1/schemas/cli-result.schema.json", root), "utf8"),
	);
	const validate = createStrictAjv().compile(schema);
	assert.equal(validate(envelope), true, JSON.stringify(validate.errors, null, 2));
	assert.deepEqual(envelope, {
		schema: "urn:graphrefly-stack:schema:cli-result:v1",
		command: "gate",
		ok: false,
		mode: "live",
		error: {
			code: "LIVE_MODE_UNSUPPORTED_FOR_COMMAND",
			message: "gate",
		},
	});
});

test("the CLI rejects fixture mutation outside the private root before touching it", () => {
	const result = spawnSync(
		process.execPath,
		["packages/cli/dist/cli.js", "fixture", "create", "--output", "/tmp/not-authorized", "--json"],
		{ cwd: new URL("../..", import.meta.url), encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.equal(JSON.parse(result.stdout).error.code, "OUTPUT_OUTSIDE_PRIVATE_ROOT");
});

test("runtime failures still emit exactly one JSON envelope", () => {
	const result = spawnSync(
		process.execPath,
		["packages/cli/dist/cli.js", "gate", "--fixture", ".private/missing.json", "--json"],
		{ cwd: new URL("../..", import.meta.url), encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.equal(result.stdout.trim().split("\n").length, 1);
	assert.equal(JSON.parse(result.stdout).error.code, "RUNTIME_ERROR");
});

test("the CLI reviews the same verified portable evidence from a file or directory", () => {
	const directory = "evidence/runs/refresh-token-rotation-v1-live";
	const file = `${directory}/evidence-bundle.json`;
	const run = (bundle) =>
		spawnSync(
			process.execPath,
			["packages/cli/dist/cli.js", "review", "--bundle", bundle, "--json"],
			{
				cwd: new URL("../..", import.meta.url),
				encoding: "utf8",
			},
		);
	const fromDirectory = run(directory);
	const fromFile = run(file);
	assert.equal(fromDirectory.status, 0, fromDirectory.stderr);
	assert.equal(fromFile.status, 0, fromFile.stderr);
	assert.deepEqual(JSON.parse(fromDirectory.stdout), JSON.parse(fromFile.stdout));
	const result = JSON.parse(fromFile.stdout);
	assert.equal(result.data.source, "redacted-bundle");
	assert.equal(result.data.commits.length, 3);
	assert.equal(result.data.blueprints.length, 4);
});

test("the review server refuses non-loopback exposure", () => {
	const result = spawnSync(
		process.execPath,
		["packages/cli/dist/cli.js", "review", "--host", "0.0.0.0", "--json"],
		{ cwd: new URL("../..", import.meta.url), encoding: "utf8" },
	);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, "");
	assert.equal(JSON.parse(result.stdout).error.code, "REVIEW_HOST_NOT_LOOPBACK");
});

test("the local review shell is served by one loopback HTTP process", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-review-"));
	const portable = resolve(temporary, "evidence-bundle.json");
	await writeFile(portable, '{"schema":"portable-test"}\n');
	const running = await startReviewServer({
		host: "127.0.0.1",
		port: 0,
		distDir: defaultReviewDist,
		reviewData: { source: "test" },
		evidenceBundlePath: portable,
	});
	context.after(() => new Promise((resolve) => running.server.close(resolve)));
	context.after(() => rm(temporary, { recursive: true, force: true }));

	const response = await fetch(running.url);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
	assert.match(await response.text(), /GraphReFly Stack — Review/);

	const post = await fetch(running.url, { method: "POST" });
	assert.equal(post.status, 405);
	const api = await fetch(`${running.url}/api/review-data`);
	assert.equal(api.status, 200);
	assert.deepEqual(await api.json(), { source: "test" });
	const download = await fetch(`${running.url}/api/evidence-bundle`);
	assert.equal(download.status, 200);
	assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
	assert.deepEqual(await download.json(), { schema: "portable-test" });
});

test("generic review decisions persist below the Git common directory and export by content hash", async (context) => {
	const repository = await mkdtemp(resolve(tmpdir(), "graphrefly-review-state-"));
	context.after(() => rm(repository, { recursive: true, force: true }));
	const initialized = spawnSync("git", ["init", "-b", "main"], {
		cwd: repository,
		encoding: "utf8",
	});
	assert.equal(initialized.status, 0, initialized.stderr);
	const baseOid = "1".repeat(40);
	const commitOid = "2".repeat(40);
	const blueprintHash = "3".repeat(64);
	const review = {
		schema: "graphrefly.stack.review.v1",
		source: "generic-repository",
		repository: {
			label: "state-test",
			headLabel: "main",
			graphreflyVersion: "0.3.0",
			entrypoint: "graphrefly-stack.blueprint.mjs",
			baseOid,
			headOid: commitOid,
		},
		base: {},
		commits: [
			{
				oid: commitOid,
				parentOid: baseOid,
				blueprint: { hash: { value: blueprintHash } },
			},
		],
		semanticStatus: "not-configured",
	};
	const running = await startReviewServer({
		host: "127.0.0.1",
		port: 0,
		distDir: defaultReviewDist,
		reviewData: review,
		repositoryReviewState: { repository, review },
	});
	context.after(() => new Promise((resolve) => running.server.close(resolve)));

	const request = {
		schema: "graphrefly.stack.repository-review-decision-request.v1",
		commitOid,
		decision: "approve",
		reviewerLabel: "Local reviewer",
		summary: "The Blueprint and source diff agree.",
	};
	const crossSite = await fetch(`${running.url}/api/review-decisions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	assert.equal(crossSite.status, 403);

	const saved = await fetch(`${running.url}/api/review-decisions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: running.url,
			"X-GraphReFly-Review": "1",
		},
		body: JSON.stringify(request),
	});
	const savedBody = await saved.text();
	assert.equal(saved.status, 201, savedBody);
	const record = JSON.parse(savedBody);
	assert.equal(record.schema, "graphrefly.stack.repository-review-decision.v1");
	assert.deepEqual(record.target, {
		baseOid,
		headOid: commitOid,
		parentOid: baseOid,
		commitOid,
		blueprintHash,
	});
	assert.equal(record.identityVerified, false);

	const files = await readdir(resolve(repository, ".git/grfs/reviews"));
	assert.deepEqual(files, [`${record.id}.json`]);
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" });
	assert.equal(status.status, 0, status.stderr);
	assert.equal(status.stdout, "");

	const listed = await fetch(`${running.url}/api/review-decisions`);
	assert.deepEqual(await listed.json(), [record]);
	const exported = await fetch(`${running.url}/api/review-decisions/export`);
	assert.equal(exported.status, 200);
	assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
	const bundle = await exported.json();
	assert.equal(bundle.schema, "graphrefly.stack.repository-review-bundle.v1");
	assert.equal(bundle.artifacts[0].path, `reviews/${record.id}.json`);
	assert.equal(bundle.artifacts[0].hash.value, sha256Jcs(record));
});
