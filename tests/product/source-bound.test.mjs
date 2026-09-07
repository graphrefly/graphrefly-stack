import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { seal } from "../../packages/contracts/dist/source-bound.js";
import { bindSource, resolveSource, verifyBinding } from "../../packages/core/dist/source-bound.js";
import {
	coordinate,
	git,
	readSources,
	retainedRoot,
	root,
	setupRetained,
} from "../../scripts/source-bound/git.mjs";
import { createAnchor, inspectSources, resolveAt } from "../../scripts/source-bound/resolver.mjs";

const head = setupRetained();
const target = coordinate(retainedRoot, head);
const path = "src/refresh-session.ts";
const source = readSources(retainedRoot, target)[path];
const anchor = createAnchor(retainedRoot, target, path, "AdmitRefresh");
const temporary = mkdtempSync(resolve(tmpdir(), "source-bound-tests-"));
process.on("exit", () => rmSync(temporary, { recursive: true, force: true }));
function cli(args) {
	return spawnSync(process.execPath, ["scripts/source-bound-report.mjs", ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 30000,
	});
}
function resolveCli(overlay, witness, extra = {}) {
	const current = coordinate(retainedRoot, head, overlay);
	const request = resolve(temporary, "request.json");
	writeFileSync(
		request,
		JSON.stringify({
			anchor,
			target: current,
			overlay,
			...(witness === undefined ? {} : { witness }),
			...extra,
		}),
	);
	const result = cli(["--resolve", request]);
	assert.equal(result.status, 0, result.stdout);
	return JSON.parse(result.stdout);
}
test("CLI source resolution covers all dispositions and independent freshness without changing anchors", () => {
	const before = canonicalize(anchor);
	const cases = [
		[null, "exact"],
		[{ [path]: `// moved range\n${source}` }, "moved"],
		[{ [path]: null, "src/moved.ts": source }, "moved"],
		[{ [path]: source.replace("valid && allowed", "valid || allowed") }, "changed"],
		[{ "src/copy.ts": source }, "ambiguous"],
		[
			{ [path]: source.slice(0, anchor.candidate.start) + source.slice(anchor.candidate.end) },
			"deleted",
		],
		[{ [path]: null }, "missing"],
		[{ [path]: null, "src/a.py": "print('unsupported')" }, "unsupported"],
		[{ [path]: "export const = ;" }, "unresolved"],
		[{ [path]: "export class Unsupported {}" }, "unsupported"],
	];
	for (const [overlay, expected] of cases) {
		const result = resolveCli(overlay);
		assert.equal(result.disposition, expected);
		assert.equal(result.freshness, "current");
		if (expected === "ambiguous") assert.equal(result.candidates.length, 2);
	}
	assert.equal(resolveCli(null, null).freshness, "unknown");
	assert.equal(resolveCli(null, { ...target, commit: "b".repeat(40) }).freshness, "stale");
	assert.equal(resolveCli({ [path]: `// moved\n${source}` }, target).freshness, "stale");
	assert.equal(canonicalize(anchor), before);
});
test("AST fingerprint preserves literal content and handles trivia conservatively", () => {
	const inspect = (text) => inspectSources({ "src/a.ts": text }).candidates[0].fingerprint.digest;
	assert.equal(inspect('export const A = "a b";'), inspect('/*comment*/ export const A="a b";'));
	assert.notEqual(inspect('export const A = "a b";'), inspect('export const A = "ab";'));
	assert.notEqual(
		inspect("export function A() { return\n 1; }"),
		inspect("export function A() { return 1; }"),
	);
});
test("real Git paths with control characters cannot hide behind a valid source prefix", () => {
	const repository = mkdtempSync(resolve(temporary, "path-coverage-"));
	git(repository, ["init", "-b", "main"]);
	mkdirSync(resolve(repository, "src"));
	writeFileSync(resolve(repository, path), source);
	git(repository, ["add", "--", path]);
	git(repository, ["commit", "--no-gpg-sign", "-m", "Retain valid source prefix"]);
	const base = git(repository, ["rev-parse", "HEAD"]).trim();
	const original = createAnchor(repository, coordinate(repository, base), path, "AdmitRefresh");
	assert.equal(
		resolveAt(repository, original, coordinate(repository, base)).result.disposition,
		"exact",
	);
	for (const control of ["\t", "\n"]) {
		const invalidPath = `${path}${control}copy.ts`;
		writeFileSync(
			resolve(repository, invalidPath),
			source.replace("valid && allowed", "valid || allowed"),
		);
		git(repository, ["add", "--", invalidPath]);
		git(repository, ["commit", "--no-gpg-sign", "-m", "Retain control-character source path"]);
		const revision = git(repository, ["rev-parse", "HEAD"]).trim();
		const entries = git(repository, ["ls-tree", "-r", "-z", revision]).split("\0").filter(Boolean);
		assert.equal(entries.length, 2);
		assert.ok(entries.some((entry) => entry.endsWith(`\t${invalidPath}`)));
		const current = coordinate(repository, revision);
		assert.throws(() => readSources(repository, current), /SOURCE_PATH/);
		assert.throws(() => resolveAt(repository, original, current), /SOURCE_PATH/);
		git(repository, ["rm", "--", invalidPath]);
	}
});
test("CLI rejects overlay tamper, rehashed original tamper, cross repository and malformed coordinates", () => {
	const request = resolve(temporary, "bad.json");
	const overlay = { [path]: `// overlay\n${source}` };
	for (const input of [
		{ anchor, target: coordinate(retainedRoot, head, overlay), overlay: { [path]: source } },
		{
			anchor: seal({ ...anchor, candidate: { ...anchor.candidate, sourceDigest: "0".repeat(64) } }),
			target,
		},
		{ anchor, target: { ...target, repository: "wrong-owner" } },
		{ anchor, target: { ...target, commit: head.slice(0, 12) } },
		{ anchor, target, overlay: { "../escape.ts": "" } },
	]) {
		writeFileSync(request, JSON.stringify(input));
		const result = cli(["--resolve", request]);
		assert.equal(result.status, 1);
		assert.equal(JSON.parse(result.stdout).ok, false);
	}
});
test("real committed target source resolves movement while retaining original binding coordinates", () => {
	const blob = git(
		retainedRoot,
		["hash-object", "-w", "--stdin"],
		`// committed movement\n${source}`,
	).trim();
	const sourceTree = git(
		retainedRoot,
		["mktree"],
		`100644 blob ${blob}\trefresh-session.ts\n`,
	).trim();
	const rootEntries = git(retainedRoot, ["ls-tree", head])
		.split("\n")
		.filter(Boolean)
		.map((entry) => (entry.endsWith("\tsrc") ? `040000 tree ${sourceTree}\tsrc` : entry));
	const tree = git(retainedRoot, ["mktree"], `${rootEntries.join("\n")}\n`).trim();
	const revision = git(retainedRoot, [
		"commit-tree",
		tree,
		"-p",
		head,
		"-m",
		"Source-bound independent target witness",
	]).trim();
	git(retainedRoot, ["update-ref", "refs/heads/source-bound-moved-proof", revision]);
	assert.notEqual(revision, head);
	const result = resolveAt(retainedRoot, anchor, coordinate(retainedRoot, revision)).result;
	assert.equal(result.disposition, "moved");
	assert.equal(result.target.commit, revision);
	assert.equal(anchor.coordinate.commit, head);
	const overlay = { [path]: `// uncommitted source\n${source}` };
	const dirty = coordinate(retainedRoot, head, overlay);
	const dirtyAnchor = createAnchor(retainedRoot, dirty, path, "AdmitRefresh", overlay);
	assert.equal(
		resolveAt(retainedRoot, dirtyAnchor, dirty, overlay, dirty, overlay).result.disposition,
		"exact",
	);
	assert.throws(
		() => resolveAt(retainedRoot, dirtyAnchor, dirty, overlay, dirty, {}),
		/COORDINATE/,
	);
});
test("pure binding rejects altered facts, cross revision, missing node and wrong topology; inputs remain immutable", () => {
	const { facts, result } = resolveAt(retainedRoot, anchor, target);
	const runtime = {
		coordinate: target,
		blueprintVersion: "graphrefly.blueprint.v2",
		topologyHash: "e".repeat(64),
		nodeIds: ["actual-node-unit-test"],
		exports: [{ symbol: "AdmitRefresh", nodeId: "actual-node-unit-test" }],
		provenance: { tool: "unit", version: "1" },
	};
	const before = canonicalize({ anchor, facts, result, runtime });
	const binding = bindSource(anchor, result, facts, runtime);
	verifyBinding(binding, anchor, result, facts, runtime);
	for (const altered of [
		{ ...runtime, coordinate: { ...target, commit: "f".repeat(40) } },
		{ ...runtime, nodeIds: [] },
		{ ...runtime, topologyHash: "d".repeat(64) },
	])
		assert.throws(() => verifyBinding(binding, anchor, result, facts, altered));
	assert.throws(() =>
		verifyBinding(seal({ ...binding, nodeId: "forged" }), anchor, result, facts, runtime),
	);
	assert.throws(() =>
		bindSource(anchor, seal({ ...result, evidenceDigest: "f".repeat(64) }), facts, runtime),
	);
	const stale = { ...facts, witness: null };
	assert.throws(() => bindSource(anchor, resolveSource(anchor, stale), stale, runtime));
	assert.equal(canonicalize({ anchor, facts, result, runtime }), before);
});
test("retained report repeats byte-identically without LLM and verifies source, runtime, verifier and topology", () => {
	const first = cli([]);
	const second = cli([]);
	assert.equal(first.status, 0, first.stdout);
	assert.equal(second.status, 0, second.stdout);
	assert.equal(first.stdout, second.stdout);
	const report = JSON.parse(first.stdout);
	const phase = readFileSync(resolve(root, "docs/plan/phases.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.find((record) => record.id === "STACK-SOURCE-BOUND");
	assert.deepEqual(
		{ artifact_ref: report.artifact_ref, schema: report.schema, revision: report.revision },
		phase.produces[0],
	);
	assert.equal(report.bindings.length, 12);
	assert.equal(report.runtime.version, "0.8.0");
	assert.equal(report.verifier.status, "passed");
	assert.equal(report.llmRequired, false);
	assert.equal(
		report.blueprint.topology.nodes.filter((n) => n.id === "IndependentPasswordResetFlow").length,
		1,
	);
	const file = resolve(temporary, "proof.json");
	writeFileSync(file, first.stdout);
	assert.equal(cli(["--verify", file]).status, 0);
	for (const mutate of [
		(r) => (r.artifact_ref = "other-owner:source-binding-proof"),
		(r) => (r.schema = "graphrefly.stack.source-binding-proof.v1"),
		(r) => (r.revision = "stack-source-v2"),
		(r) => delete r.artifact_ref,
		(r) => delete r.revision,
		(r) => (r.bindings[0].nodeId = "wrong"),
		(r) => (r.repository.head = "a".repeat(40)),
		(r) => (r.blueprint.hash.value = "0".repeat(64)),
		(r) => (r.verifier.coordinate.commit = "b".repeat(40)),
		(r) => (r.runtime.version = "0.3.0"),
		(r) => (r.resolutions[0].freshness = "unknown"),
		(r) => delete r.verifier,
	]) {
		const tampered = structuredClone(report);
		mutate(tampered);
		const { id: _id, ...body } = tampered;
		tampered.id = sha256Jcs(body);
		writeFileSync(file, JSON.stringify(tampered));
		assert.equal(cli(["--verify", file]).status, 1);
	}
});
test("consumer verifier is independently runnable", () => {
	const output = execFileSync(
		process.execPath,
		["--test", "examples/refresh-session-source-bound/tests/business.test.mjs"],
		{ cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
	);
	assert.match(output, /pass 1/);
	assert.doesNotMatch(
		readFileSync(
			resolve(root, "examples/refresh-session-source-bound/tests/business-verifier.mjs"),
			"utf8",
		),
		/from.*(?:packages|source-bound\/report|source-bound\/resolver)/,
	);
});
