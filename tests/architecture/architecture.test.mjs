import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
		"rollback",
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

test("the generic review bounds long desktop commit stacks without trapping narrow screens", async () => {
	const stylesheet = await readFile(new URL("apps/review/src/styles.css", root), "utf8");
	assert.match(
		stylesheet,
		/\.commit-stack\s*\{[^}]*max-height:\s*min\(680px, calc\(100vh - 220px\)\);[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/su,
	);
	assert.match(
		stylesheet,
		/@media \(max-width: 980px\)\s*\{[\s\S]*?\.commit-stack\s*\{[^}]*max-height:\s*none;[^}]*overflow-y:\s*visible;[^}]*overscroll-behavior:\s*auto;[^}]*scrollbar-gutter:\s*auto;/u,
	);
});

test("the primary semantic review is decision-sized while proof remains secondary", async () => {
	const source = await readFile(
		new URL("apps/review/src/GenericRepositoryReview.tsx", root),
		"utf8",
	);
	assert.match(source, /1 · Intent/);
	assert.match(source, /2 · Reach/);
	assert.match(source, /3 · Readiness/);
	assert.match(source, /Technical details/);
	assert.match(source, /Typed predicates/);
	assert.doesNotMatch(source, /Typed claim ·/);
	assert.doesNotMatch(source, /Accepted intent · \{review\.semantic\.plan\.planId\}/);
});

test("generic and DAG review expose one whole-change correction loop without a fake re-request action", async () => {
	const [generic, dag] = await Promise.all([
		readFile(new URL("apps/review/src/GenericRepositoryReview.tsx", root), "utf8"),
		readFile(new URL("apps/review/src/DagRepositoryReview.tsx", root), "utf8"),
	]);
	assert.match(generic, /repository-review-decision-request\.v2/);
	assert.doesNotMatch(generic, /repository-review-decision-request\.v1/);
	assert.match(generic, /Review the whole current change/);
	assert.match(generic, /Fresh revision · Needs review/);
	assert.match(generic, /Review history/);
	assert.match(generic, /provider's native Re-request/);
	assert.match(dag, /Human review ·/);
	assert.match(dag, /Fresh DAG evidence · Needs review/);
	assert.match(dag, /Review history/);
	assert.match(dag, /provider's native Re-request/);
	assert.doesNotMatch(`${generic}\n${dag}`, /<button[^>]*>\s*Re-request review/);
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
		schema: "graphrefly.stack.repository-review-decision-request.v2",
		decision: "approve",
		reviewerLabel: "Local reviewer",
		summary: "The Blueprint and source diff agree.",
		contextCommitOid: commitOid,
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
	assert.equal(record.schema, "graphrefly.stack.repository-review-decision.v2");
	assert.deepEqual(record.target, {
		baseOid,
		headOid: commitOid,
		reviewTargetDigest: { algorithm: "sha256", value: sha256Jcs(review) },
	});
	assert.equal(record.contextCommitOid, commitOid);
	assert.equal(record.identityVerified, false);

	const files = await readdir(resolve(repository, ".git/grfs/reviews"));
	assert.deepEqual(files, [`${record.id}.json`]);
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" });
	assert.equal(status.status, 0, status.stderr);
	assert.equal(status.stdout, "");

	const listed = await fetch(`${running.url}/api/review-decisions`);
	assert.deepEqual(await listed.json(), {
		schema: "graphrefly.stack.review-decision-history.v1",
		current: [record],
		outdated: [],
	});
	const exported = await fetch(`${running.url}/api/review-decisions/export`);
	assert.equal(exported.status, 200);
	assert.match(exported.headers.get("content-disposition") ?? "", /attachment/);
	const bundle = await exported.json();
	assert.equal(bundle.schema, "graphrefly.stack.repository-review-bundle.v2");
	assert.deepEqual(bundle.reviewTargetDigest, {
		algorithm: "sha256",
		value: sha256Jcs(review),
	});
	assert.equal(bundle.artifacts[0].path, `reviews/${record.id}.json`);
	assert.equal(bundle.artifacts[0].hash.value, sha256Jcs(record));

	const correctedHeadOid = "4".repeat(40);
	const correctedReview = structuredClone(review);
	correctedReview.repository.headOid = correctedHeadOid;
	correctedReview.commits.push({
		oid: correctedHeadOid,
		parentOid: commitOid,
		blueprint: { hash: { value: "5".repeat(64) } },
	});
	const corrected = await startReviewServer({
		host: "127.0.0.1",
		port: 0,
		distDir: defaultReviewDist,
		reviewData: correctedReview,
		repositoryReviewState: { repository, review: correctedReview },
	});
	context.after(() => new Promise((resolve) => corrected.server.close(resolve)));
	const freshHistory = await (await fetch(`${corrected.url}/api/review-decisions`)).json();
	assert.deepEqual(freshHistory, {
		schema: "graphrefly.stack.review-decision-history.v1",
		current: [],
		outdated: [record],
	});
	const correctedResponse = await fetch(`${corrected.url}/api/review-decisions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: corrected.url,
			"X-GraphReFly-Review": "1",
		},
		body: JSON.stringify({
			...request,
			decision: "request-changes",
			contextCommitOid: correctedHeadOid,
			summary: "The corrective commit still reaches one unexpected node.",
		}),
	});
	const correctedBody = await correctedResponse.text();
	assert.equal(correctedResponse.status, 201, correctedBody);
	const correctedRecord = JSON.parse(correctedBody);
	assert.equal(correctedRecord.target.reviewTargetDigest.value, sha256Jcs(correctedReview));
	const correctedHistory = await (await fetch(`${corrected.url}/api/review-decisions`)).json();
	assert.deepEqual(correctedHistory.current, [correctedRecord]);
	assert.deepEqual(correctedHistory.outdated, [record]);
	const correctedBundle = await (
		await fetch(`${corrected.url}/api/review-decisions/export`)
	).json();
	assert.deepEqual(
		correctedBundle.artifacts.map((artifact) => artifact.record.id),
		[correctedRecord.id],
	);
});

test("historical repository review v1 records stay readable without entering portable v2", async (context) => {
	const repository = await mkdtemp(resolve(tmpdir(), "graphrefly-review-v1-"));
	context.after(() => rm(repository, { recursive: true, force: true }));
	assert.equal(
		spawnSync("git", ["init", "-b", "main"], { cwd: repository, encoding: "utf8" }).status,
		0,
	);
	const baseOid = "6".repeat(40);
	const commitOid = "7".repeat(40);
	const blueprintHash = "8".repeat(64);
	const review = {
		schema: "graphrefly.stack.review.v1",
		source: "generic-repository",
		repository: {
			label: "legacy-state-test",
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
	const legacy = {
		schema: "graphrefly.stack.repository-review-decision.v1",
		id: "018f47a2-4a4b-4c6e-8ea1-9c5e39df5678",
		target: { baseOid, headOid: commitOid, parentOid: baseOid, commitOid, blueprintHash },
		decision: "approve",
		reviewerLabel: "Legacy reviewer",
		summary: "Historical commit decision.",
		recordedAt: "2026-07-20T12:34:56.789Z",
		identityVerified: false,
	};
	const reviews = resolve(repository, ".git/grfs/reviews");
	await mkdir(reviews, { recursive: true });
	await writeFile(resolve(reviews, `${legacy.id}.json`), `${JSON.stringify(legacy)}\n`);
	const running = await startReviewServer({
		host: "127.0.0.1",
		port: 0,
		distDir: defaultReviewDist,
		reviewData: review,
		repositoryReviewState: { repository, review },
	});
	context.after(() => new Promise((resolveClose) => running.server.close(resolveClose)));
	assert.deepEqual(await (await fetch(`${running.url}/api/review-decisions`)).json(), {
		schema: "graphrefly.stack.review-decision-history.v1",
		current: [legacy],
		outdated: [],
	});
	const bundle = await (await fetch(`${running.url}/api/review-decisions/export`)).json();
	assert.equal(bundle.schema, "graphrefly.stack.repository-review-bundle.v2");
	assert.deepEqual(bundle.artifacts, []);
});
