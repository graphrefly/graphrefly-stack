import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalize } from "../../packages/contracts/dist/jcs.js";
import { retainedRoot, root } from "../../scripts/source-bound/git.mjs";

function run(args = []) {
	return spawnSync(process.execPath, ["scripts/consequence-review-report.mjs", ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 60000,
		env: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "", CODEX_API_KEY: "" },
	});
}
function git(args) {
	return spawnSync("git", ["-C", retainedRoot, ...args], { encoding: "utf8" });
}

test("retained exact SC12 proof is deterministic, model-free and independently verifiable", () => {
	const saved = readFileSync("evidence/runs/consequence-review/evidence-bundle.json", "utf8");
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
	assert.equal(proof.integration.candidate.provider.runtimeVersion, "0.8.0");
	assert.equal(proof.integration.result.outcome, "compatible");
	assert.equal(proof.guidance.status, "overlap-observed");
	assert(proof.guidance.witnesses.some((entry) => entry.value === "AdmitRefresh"));
	assert(proof.projections.every((entry) => entry.readiness.status === "verified"));
	assert(
		proof.projections.every((entry) =>
			entry.verifiedUnchanged.some((control) => control.scope === "IndependentPasswordResetFlow"),
		),
	);
	assert(!before.includes("consequence-review-candidate"));
});

test("historical proofs remain exact and current proof rejects substitutions", () => {
	for (const [script, path] of [
		["scripts/source-bound-report.mjs", "evidence/runs/source-bound/evidence-bundle.json"],
		[
			"scripts/evidence-manifest-report.mjs",
			"evidence/runs/evidence-manifest/evidence-bundle.json",
		],
	]) {
		const result = spawnSync(process.execPath, [script, "--verify", path], {
			cwd: root,
			encoding: "utf8",
			timeout: 60000,
		});
		assert.equal(result.status, 0, result.stdout);
	}
	const proof = JSON.parse(
		readFileSync("evidence/runs/consequence-review/evidence-bundle.json", "utf8"),
	);
	for (const mutate of [
		(value) => {
			value.repository.left = value.repository.base;
		},
		(value) => {
			value.sourceEvidence[0].manifest.subject.head = value.repository.base;
		},
		(value) => {
			value.sourceEvidence[0].manifest.blueprint.topologyHash = "f".repeat(64);
		},
		(value) => {
			value.sourceEvidence[0].verifierObservation.freshness = "stale";
		},
		(value) => {
			value.sourceEvidence[0].manifest.authorities =
				value.sourceEvidence[0].manifest.authorities.filter((entry) => entry.kind !== "verifier");
		},
	]) {
		const candidate = structuredClone(proof);
		mutate(candidate);
		const temporary = `.private/consequence-review-tamper-${process.pid}.json`;
		try {
			const write = spawnSync(
				process.execPath,
				[
					"-e",
					`require("fs").mkdirSync(".private",{recursive:true});require("fs").writeFileSync(${JSON.stringify(temporary)},${JSON.stringify(canonicalize(candidate))})`,
				],
				{ cwd: root },
			);
			assert.equal(write.status, 0);
			assert.equal(run(["--verify", temporary]).status, 1, mutate.toString());
		} finally {
			spawnSync(
				process.execPath,
				["-e", `require("fs").rmSync(${JSON.stringify(temporary)},{force:true})`],
				{ cwd: root },
			);
		}
	}
});
