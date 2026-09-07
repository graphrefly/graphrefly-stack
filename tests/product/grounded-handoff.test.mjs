import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { ownerResultDigest } from "../../packages/contracts/src/grounded-handoff.ts";
import { retainedRoot, root } from "../../scripts/source-bound/git.mjs";

function run(args = []) {
	return spawnSync(process.execPath, ["scripts/grounded-handoff-report.mjs", ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 90000,
		env: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "", CODEX_API_KEY: "" },
	});
}
function git(args) {
	return spawnSync("git", ["-C", retainedRoot, ...args], { encoding: "utf8" });
}

test("retained grounded handoff proof is model-free, deterministic and independently verifiable", () => {
	const saved = readFileSync("evidence/runs/grounded-handoff/evidence-bundle.json", "utf8");
	const before = git(["for-each-ref", "--format=%(refname) %(objectname)"]).stdout;
	const first = run();
	const second = run();
	assert.equal(first.status, 0, first.stdout);
	assert.equal(second.status, 0, second.stdout);
	assert.equal(first.stdout, second.stdout);
	assert.equal(canonicalize(JSON.parse(first.stdout)), canonicalize(JSON.parse(saved)));
	assert.equal(run(["--verify"]).status, 0);
	assert.equal(git(["for-each-ref", "--format=%(refname) %(objectname)"]).stdout, before);
	assert.equal(git(["fsck", "--full", "--no-dangling"]).status, 0);
	const proof = JSON.parse(saved);
	assert.equal(proof.llmRequired, false);
	assert.equal(
		proof.consequenceReview.id,
		"12ba96806b603ed1f6f0a31b6b71c65df590b905c9518d21719abee4bb280a60",
	);
	assert.equal(proof.reviewProjections[0].axes.ownerAdmission, null);
	assert.equal(proof.reviewProjections[1].axes.ownerAdmission.status, "admitted");
	assert.deepEqual(
		proof.reviewProjections[0].axes.evidence,
		proof.reviewProjections[1].axes.evidence,
	);
	assert.deepEqual(proof.reviewProjections[0].axes.human, proof.reviewProjections[1].axes.human);
});

test("Git-backed verification rejects changed owner bytes, coordinates and historical substitutions", () => {
	const saved = JSON.parse(
		readFileSync("evidence/runs/grounded-handoff/evidence-bundle.json", "utf8"),
	);
	for (const mutate of [
		(value) => {
			value.ownerEvidence.coordinate.commit = value.consequenceReview.repository.left;
		},
		(value) => {
			value.ownerEvidence.coordinate.blob = "f".repeat(40);
		},
		(value) => {
			value.ownerEvidence.coordinate.bytesDigest = "f".repeat(64);
		},
		(value) => {
			value.consequenceReview.id = value.id;
		},
	]) {
		const candidate = structuredClone(saved);
		mutate(candidate);
		const child = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import {verifyReport} from './scripts/grounded-handoff/report.mjs'; const v=${JSON.stringify(candidate)}; verifyReport(v).then(()=>process.exit(0)).catch(()=>process.exit(1));`,
			],
			{ cwd: root, encoding: "utf8", timeout: 90000 },
		);
		assert.equal(child.status, 1, mutate.toString());
	}
	const rehashed = structuredClone(saved);
	rehashed.ownerEvidence.result.statement = "Rehashed uncommitted substitute";
	rehashed.ownerEvidence.result.id = ownerResultDigest(rehashed.ownerEvidence.result);
	rehashed.reviewProjections[1].ownerEvidence.resultId = rehashed.ownerEvidence.result.id;
	rehashed.reviewProjections[1].axes.ownerAdmission.ref = rehashed.ownerEvidence.result.id;
	for (const projection of rehashed.reviewProjections) {
		const { id: _id, ...body } = projection;
		projection.id = sha256Jcs(body);
	}
	const { id: _id, ...body } = rehashed;
	rehashed.id = sha256Jcs(body);
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import {verifyReport} from './scripts/grounded-handoff/report.mjs'; const v=${JSON.stringify(rehashed)}; verifyReport(v).then(()=>process.exit(0)).catch(()=>process.exit(1));`,
		],
		{ cwd: root, encoding: "utf8", timeout: 90000 },
	);
	assert.equal(child.status, 1, "rehashed owner substitute must not replace committed bytes");
});
