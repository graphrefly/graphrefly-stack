import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { manifestDigest } from "../../packages/contracts/dist/evidence-manifest.js";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { buildManifest, verifyManifest } from "../../packages/core/dist/evidence-manifest.js";
import {
	currentDecision,
	resolveOwnerFacts,
	testResultPath,
} from "../../scripts/evidence-manifest/owners.mjs";
import { root } from "../../scripts/source-bound/git.mjs";

function cli(args = [], script = "scripts/evidence-manifest-report.mjs") {
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 60000,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null);
	return { ...result, value: JSON.parse(result.stdout) };
}
function rehash(proof) {
	proof.manifest.id = manifestDigest(proof.manifest);
	const { id: _id, ...body } = proof;
	proof.id = sha256Jcs(body);
}

test("real retained owner linkage is deterministic, private, independently verified, and rejects rehashed substitutions", () => {
	const first = cli();
	assert.equal(first.status, 0, first.stdout);
	const second = cli();
	assert.equal(second.status, 0, second.stdout);
	assert.equal(first.stdout, second.stdout);
	const proof = first.value;
	const phase = readFileSync(resolve(root, "docs/plan/phases.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map(JSON.parse)
		.find((v) => v.id === "STACK-EVIDENCE-MANIFEST");
	for (const [key, value] of Object.entries(phase.produces[0])) assert.equal(proof[key], value);
	assert.deepEqual(proof.manifest.coverage, {
		runtimeOccurrence: "absent",
		scope: "retained-refresh-session-required-linkage-only",
	});
	assert.equal(proof.llmRequired, false);
	assert.equal("topology" in proof.manifest.blueprint, false);
	assert.equal(
		proof.manifest.authorities.some((v) => "verdict" in v),
		false,
	);
	const directory = mkdtempSync(resolve(tmpdir(), "manifest-test-"));
	const path = resolve(directory, "proof.json");
	try {
		writeFileSync(path, first.stdout);
		assert.equal(cli(["--verify", path]).status, 0);
		const attacks = [
			(v) => {
				v.manifest.subject.head = v.manifest.subject.base;
			},
			(v) => {
				v.manifest.subject.repository = "attacker";
			},
			(v) => {
				v.manifest.blueprint.topologyHash = "f".repeat(64);
			},
			(v) => {
				v.manifest.authorities[0].owner = "attacker";
			},
			(v) => {
				v.manifest.authorities[0].location.commit = "f".repeat(40);
			},
			(v) => {
				v.manifest.authorities[0].digest = "f".repeat(64);
				v.manifest.authorities[0].freshness.authorityDigest = "f".repeat(64);
			},
			(v) => {
				v.manifest.authorities[0].freshness.status = "unknown";
			},
			(v) => {
				v.manifest.authorities[0].freshness.status = "stale";
			},
			(v) => {
				v.manifest.authorities[0].freshness.subject.head = "f".repeat(40);
			},
			(v) => {
				v.manifest.authorities = v.manifest.authorities.filter((r) => r.kind !== "verifier");
			},
			(v) => {
				v.manifest.authorities[0].bindingRefs.pop();
			},
			(v) => {
				v.manifest.authorities[0].location.path = "/tmp/untrusted";
			},
			(v) => {
				v.manifest.authorities[0].extra = true;
			},
			(v) => {
				v.extra = true;
			},
		];
		for (const attack of attacks) {
			const candidate = structuredClone(proof);
			attack(candidate);
			rehash(candidate);
			writeFileSync(path, canonicalize(candidate));
			assert.equal(cli(["--verify", path]).status, 1, attack.toString());
		}
		writeFileSync(path, "{");
		assert.equal(cli(["--verify", path]).status, 1);
		assert.equal(cli(["--unknown"]).status, 1);
		const currentSource = cli(
			["--verify", "evidence/runs/source-bound/evidence-bundle.json"],
			"scripts/source-bound-report.mjs",
		);
		assert.equal(currentSource.status, 0);
		// Byte-preserved copy of the actual historical stale proof; always exercised in a clean checkout.
		const historical = resolve(
			root,
			"tests/fixtures/evidence-manifest/stale-source-bound-report.json.fixture",
		);
		{
			const stale = cli(["--verify", historical], "scripts/source-bound-report.mjs");
			assert.equal(stale.status, 1);
			assert.match(stale.value.error, /SOURCE_REPORT_MISMATCH/);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("pure core uses independent subject and authority witnesses and leaves its inputs immutable", () => {
	const facts = resolveOwnerFacts({ writeEvidence: true });
	const before = canonicalize(facts);
	const manifest = buildManifest(facts);
	verifyManifest(manifest, facts);
	assert.equal(canonicalize(facts), before);
	for (const kind of ["decision", "policy", "test", "verifier", "artifact"]) {
		const missing = structuredClone(facts);
		missing.authorities = missing.authorities.filter((v) => v.reference.kind !== kind);
		assert.throws(() => buildManifest(missing), /MANIFEST_MISSING_AUTHORITY/);
	}
	for (const mutate of [
		(v) => {
			v.authorities[0].subjectWitness = null;
		},
		(v) => {
			v.authorities[0].authorityWitness = null;
		},
		(v) => {
			v.authorities[0].subjectWitness.head = "f".repeat(40);
		},
		(v) => {
			v.authorities[0].authorityWitness = "f".repeat(64);
		},
	]) {
		const bad = structuredClone(facts);
		mutate(bad);
		assert.throws(() => buildManifest(bad), /MANIFEST_FRESHNESS/);
	}
	manifest.authorities[0].owner = "mutated";
	assert.equal(canonicalize(facts), before);
});

test("verification rejects missing or tampered located test material without silently recreating it", () => {
	const report = cli();
	assert.equal(report.status, 0);
	const ownerPath = resolve(root, testResultPath);
	const original = readFileSync(ownerPath);
	const directory = mkdtempSync(resolve(tmpdir(), "manifest-owner-"));
	const path = resolve(directory, "proof.json");
	writeFileSync(path, report.stdout);
	try {
		writeFileSync(ownerPath, "{}\n");
		assert.equal(cli(["--verify", path]).status, 1);
		assert.equal(readFileSync(ownerPath, "utf8"), "{}\n");
		rmSync(ownerPath);
		assert.equal(cli(["--verify", path]).status, 1);
		assert.equal(existsSync(ownerPath), false);
	} finally {
		writeFileSync(ownerPath, original);
		rmSync(directory, { recursive: true, force: true });
	}
});

test("independent tests resolve and execute the exact 0.8.0 consumer runtime", () => {
	const result = JSON.parse(readFileSync(resolve(root, testResultPath), "utf8"));
	assert.equal(result.workingDirectory, "examples/refresh-session-source-bound");
	assert.equal(result.runtime.version, "0.8.0");
	assert.equal(result.runtime.entry, "node_modules/@graphrefly/ts/dist/index.js");
	assert.equal(result.runtime.resolutionBase, "tests/business.test.mjs");
	assert.equal(result.exitCode, 0);
	assert.equal(result.stdout.trim(), ".");
	assert.match(result.runtime.entryDigest, /^[a-f0-9]{64}$/);
});

test("a locked row superseded by current owner decisions is not current authority", () => {
	const original = { id: "D56", status: "locked", supersedes: [] };
	assert.deepEqual(currentDecision([original], "D56"), original);
	for (const ref of ["D56", "graphrefly-stack:D56"]) {
		assert.throws(
			() => currentDecision([original, { id: "D999", status: "locked", supersedes: [ref] }], "D56"),
			/MANIFEST_DECISION_AUTHORITY/,
		);
	}
	assert.throws(() => currentDecision([], "D56"), /MANIFEST_DECISION_AUTHORITY/);
	assert.throws(() => currentDecision([original, original], "D56"), /MANIFEST_DECISION_AUTHORITY/);
});

test("explicit outgoing supersession prevents a locked decision from claiming current authority", () => {
	for (const superseded_by of ["D900", "graphrefly-stack:D900"]) {
		assert.throws(
			() =>
				currentDecision([{ id: "D56", status: "locked", supersedes: [], superseded_by }], "D56"),
			/MANIFEST_DECISION_AUTHORITY/,
		);
	}
});

test("superseding an intermediate decision does not revive its historical predecessor", () => {
	for (const prefix of ["", "graphrefly-stack:"]) {
		const records = [
			{ id: "D56", status: "locked", supersedes: [] },
			{
				id: "D900",
				status: "superseded",
				supersedes: [`${prefix}D56`],
				superseded_by: `${prefix}D901`,
			},
			{ id: "D901", status: "locked", supersedes: [`${prefix}D900`] },
		];
		assert.throws(() => currentDecision(records, "D56"), /MANIFEST_DECISION_AUTHORITY/);
	}
});
