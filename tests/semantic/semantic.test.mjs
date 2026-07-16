import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { exportEvidenceBundle } from "../../packages/cli/dist/exporter.js";
import { createFlagshipFixture, readRuntimeSuite } from "../../packages/cli/dist/fixture.js";
import { createStrictAjv, sha256Jcs } from "../../packages/contracts/dist/index.js";
import { computeGate } from "../../packages/core/dist/index.js";

const root = new URL("../../", import.meta.url);
const runRoot = resolve(tmpdir(), `graphrefly-stack-semantic-${process.pid}`);
const firstPath = resolve(runRoot, "first");
const secondPath = resolve(runRoot, "second");

const [first, second] = await Promise.all([
	createFlagshipFixture(firstPath, true),
	createFlagshipFixture(secondPath, true),
]);

test.after(async () => {
	await rm(runRoot, { recursive: true, force: true });
});

test("the fixed source template produces byte-stable real Git lineages", () => {
	assert.deepEqual(first.refs, second.refs);
	assert.match(first.refs.B0, /^[0-9a-f]{40}$/);
	assert.match(first.refs.A1, /^[0-9a-f]{40}$/);
	assert.notEqual(first.refs.S1, first.refs.R1);
	for (const snapshot of first.snapshots) {
		assert.equal(
			snapshot.blueprint.provenance.isolation,
			"detached-worktree-node-permission-read-only",
		);
	}
	assert.equal(first.snapshots[2].policyRevision, "session-writes.v1");
	assert.equal(
		first.snapshots[2].blueprint.topology.nodes.some(
			(node) => node.id === "session.mutation-broker.password-reset",
		),
		false,
	);
	assert.deepEqual(
		first.ordinaryChecks.map((check) => check.exitCode),
		[0, 0, 0],
	);
	for (const record of first.cases[0].input.records) {
		assert.match(record.stablePatchId, /^[0-9a-f]{40}$/);
	}
	assert.equal(
		first.cases[1].input.gitFacts[1].changedPaths.includes("docs/unauthorized-session-note.md"),
		false,
	);
	assert.equal(
		first.cases[4].input.gitFacts[1].changedPaths.includes("docs/unauthorized-session-note.md"),
		true,
	);
});

test("all six golden semantics are produced by the same deterministic gate", async () => {
	const artifactsSchema = JSON.parse(
		await readFile(new URL("contracts/v1/schemas/artifacts.schema.json", root), "utf8"),
	);
	const ajv = createStrictAjv();
	ajv.addSchema(artifactsSchema);
	const validateGate = ajv.getSchema(
		"urn:graphrefly-stack:schema:artifacts:v1#/definitions/GateResult",
	);

	for (const fixtureCase of first.cases) {
		const result = computeGate(fixtureCase.input);
		assert.equal(validateGate(result), true, JSON.stringify(validateGate.errors, null, 2));
		assert.deepEqual(
			{
				verdict: result.verdict,
				units: result.units.map(({ workUnitId, verdict, reasonCodes }) => ({
					workUnitId,
					verdict,
					reasonCodes,
				})),
			},
			fixtureCase.expected,
			fixtureCase.caseId,
		);
		assert.equal(result.inputDigest.value, sha256Jcs(fixtureCase.input));
	}
});

test("selective replan preserves U1 and replaces only U2 and U3", () => {
	assert.deepEqual(first.selectiveReplan.inputUnits, ["U2", "U3"]);
	assert.deepEqual(first.selectiveReplan.preservedUnits, ["U1"]);
	assert.deepEqual(
		first.selectiveReplan.replacements.map((replacement) => replacement.workUnitId),
		["U2", "U3"],
	);
	assert.deepEqual(
		first.selectiveReplan.finalLineage.map((entry) => entry.value),
		[first.refs.A1, first.refs.R1, first.refs.RP2, first.refs.RP3],
	);
});

test("a record cannot shrink checks, widen scope, or swap provider provenance", () => {
	const input = structuredClone(first.cases[0].input);
	const record = input.records[1];
	record.requiredChecks = [];
	record.allowedSourceScopes = [...record.allowedSourceScopes, "docs/attacker-controlled.md"];
	record.sourceScopeDigest.value = sha256Jcs(record.allowedSourceScopes);
	record.providerVersion = "attacker-provider";
	const result = computeGate(input);
	assert.equal(result.verdict, "error");
	assert.deepEqual(result.units[1].reasonCodes, [
		"SCHEMA_INVALID",
		"PROVIDER_CAPABILITY_UNSUPPORTED",
		"SOURCE_SCOPE_VIOLATION",
	]);
	assert.deepEqual(result.units[2].reasonCodes, ["DEPENDENCY_INVALID"]);
});

test("policy-only freshness and missing checks block in canonical reason order", () => {
	const policyInput = structuredClone(first.cases[0].input);
	policyInput.snapshot.policyRevision = "session-writes.v2";
	policyInput.delta.claimImpacts = [
		{ workUnitId: "U2", claimId: "session-write-path", impact: "affected" },
	];
	policyInput.checks = policyInput.checks.filter((check) => check.checkId !== "refresh-runtime");
	const result = computeGate(policyInput);
	assert.deepEqual(result.units[1].reasonCodes, [
		"POLICY_REVISION_STALE",
		"REQUIRED_CHECK_MISSING",
	]);
	assert.deepEqual(result.units[2].reasonCodes, ["DEPENDENCY_INVALID"]);
});

test("runtime replay rejects Git facts that no longer match the repository", async () => {
	assert.equal(
		(await readRuntimeSuite(resolve(firstPath, ".graphrefly-stack/runtime-suite.json"))).scenario,
		"refresh-token-rotation-v1",
	);
	const tampered = structuredClone(first);
	tampered.cases[0].input.gitFacts[0].changedPaths.push("forged/path.ts");
	const path = resolve(runRoot, "tampered-runtime-suite.json");
	await writeFile(path, JSON.stringify(tampered));
	await assert.rejects(() => readRuntimeSuite(path), /stale or forged Git facts/);
});

test("redacted bundle export is complete and every manifest hash revalidates", async () => {
	const output = resolve(runRoot, "bundle");
	await exportEvidenceBundle(first, output);
	const layout = JSON.parse(
		await readFile(new URL("fixtures/contracts/v1/bundle-layout.json", root), "utf8"),
	);
	const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
	const artifactsSchema = JSON.parse(
		await readFile(new URL("contracts/v1/schemas/artifacts.schema.json", root), "utf8"),
	);
	const ajv = createStrictAjv();
	ajv.addSchema(artifactsSchema);
	const validate = (name, value) => {
		const validator = ajv.getSchema(
			`urn:graphrefly-stack:schema:artifacts:v1#/definitions/${name}`,
		);
		assert.equal(validator(value), true, `${name}: ${JSON.stringify(validator.errors, null, 2)}`);
	};
	validate("BundleManifest", manifest);
	validate("Task", JSON.parse(await readFile(resolve(output, "task.json"), "utf8")));
	const stack = JSON.parse(await readFile(resolve(output, "stack.json"), "utf8"));
	validate("GitStack", stack);
	validate(
		"ChangePlan",
		JSON.parse(await readFile(resolve(output, "plan/change-plan.json"), "utf8")),
	);
	validate(
		"BlueprintSnapshot",
		JSON.parse(await readFile(resolve(output, "blueprints/current.json"), "utf8")),
	);
	validate(
		"BlueprintDelta",
		JSON.parse(await readFile(resolve(output, "blueprints/delta.json"), "utf8")),
	);
	validate(
		"SelectiveReplan",
		JSON.parse(await readFile(resolve(output, "replan/affected.json"), "utf8")),
	);
	validate(
		"ReviewDecision",
		JSON.parse(await readFile(resolve(output, "review/decision.json"), "utf8")),
	);
	const staleRecords = await Promise.all(
		["u1", "u2", "u3"].map(async (unit) =>
			JSON.parse(await readFile(resolve(output, `semantic-changes/${unit}.json`), "utf8")),
		),
	);
	const finalRecords = await Promise.all(
		["u1", "u2", "u3"].map(async (unit) =>
			JSON.parse(await readFile(resolve(output, `semantic-changes/final/${unit}.json`), "utf8")),
		),
	);
	for (const record of [...staleRecords, ...finalRecords]) validate("SemanticChangeRecord", record);
	const exportedChecks = [
		...JSON.parse(await readFile(resolve(output, "checks/after-rebase.json"), "utf8")),
		...JSON.parse(await readFile(resolve(output, "checks/final.json"), "utf8")),
	];
	for (const check of exportedChecks) {
		validate("CheckResult", check);
		assert.equal(check.exitCode, 0);
		assert.notEqual(check.stdoutDigest.value, "a".repeat(64));
	}
	assert.deepEqual(
		stack.commits.filter((commit) => commit.workUnitId !== null).map((commit) => commit.oid.value),
		staleRecords.map((record) => record.commit.value),
	);
	assert.deepEqual(
		finalRecords.slice(1).map((record) => record.commit.value),
		first.selectiveReplan.replacements.map((replacement) => replacement.toCommit.value),
	);
	for (const relative of layout.requiredPaths) await readFile(resolve(output, relative));
	for (const artifact of manifest.artifacts) {
		const value = JSON.parse(await readFile(resolve(output, artifact.path), "utf8"));
		assert.equal(sha256Jcs(value), artifact.hash.value, artifact.path);
	}
	for (const unit of ["u1", "u2", "u3"]) {
		const rawDiff = JSON.parse(await readFile(resolve(output, `diffs/${unit}.json`), "utf8"));
		validate("RawDiff", rawDiff);
		assert.match(rawDiff.patch, /diff --git a\//);
		assert.equal(rawDiff.patch.includes(first.repository), false);
	}
	const portable = JSON.parse(await readFile(resolve(output, "evidence-bundle.json"), "utf8"));
	validate("PortableBundle", portable);
	assert.deepEqual(portable.manifest, manifest);
	assert.deepEqual(
		Object.keys(portable.artifacts),
		manifest.artifacts.map((artifact) => artifact.path),
	);
	const finalGate = JSON.parse(await readFile(resolve(output, "gates/final.json"), "utf8"));
	assert.equal(finalGate.verdict, "pass");
	const afterGate = JSON.parse(await readFile(resolve(output, "gates/after-change.json"), "utf8"));
	assert.equal(afterGate.verdict, "blocked");
});
