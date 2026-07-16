import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { defaultReviewDist, startReviewServer } from "../../packages/cli/dist/review-server.js";
import { createStrictAjv } from "../../packages/contracts/dist/index.js";
import { CORE_ARCHITECTURE } from "../../packages/core/dist/index.js";

const root = new URL("../../", import.meta.url);

test("D17 package boundaries remain the composition authority", () => {
	assert.equal(CORE_ARCHITECTURE.version, "D17");
	assert.equal(CORE_ARCHITECTURE.processModel, "single-local-cli-process");
	assert.equal(CORE_ARCHITECTURE.defaultPlanMode, "replay");
	assert.deepEqual(CORE_ARCHITECTURE.canonicalCommands, [
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
