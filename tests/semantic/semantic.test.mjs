import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { exportEvidenceBundle } from "../../packages/cli/dist/exporter.js";
import { createFlagshipFixture, readRuntimeSuite } from "../../packages/cli/dist/fixture.js";
import { assertDiagramProjectsTopology } from "../../packages/cli/dist/graphrefly-provider.js";
import { readPortableEvidenceBundle } from "../../packages/cli/dist/portable-bundle.js";
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

test("every review commit is projected from the pinned GraphReFly runtime and renderer", async () => {
	assert.deepEqual(
		first.reviewBlueprints.map((entry) => entry.workUnitId),
		["BASE", "U1", "U2", "U3"],
	);
	for (const entry of first.reviewBlueprints) {
		assert.equal(entry.snapshot.commit.value, entry.oid);
		assert.equal(entry.snapshot.blueprint.version, "graphrefly.blueprint.v1");
		assert.equal(entry.snapshot.blueprint.provenance.source, "@graphrefly/ts");
		assert.equal(entry.snapshot.blueprint.provenance.api, "graph.blueprint()");
		assert.equal(
			entry.snapshot.blueprint.provenance.isolation,
			"detached-worktree-node-permission-read-only",
		);
		assert.equal(entry.diagram.renderer, "@graphrefly/ts/render.describeToMermaid");
		assert.match(entry.diagram.source, /^flowchart LR\n/u);
		assert.doesNotThrow(() =>
			assertDiagramProjectsTopology(entry.snapshot.blueprint.topology, entry.diagram.source),
		);
	}
	const runtimeEntry = first.reviewBlueprints.find((entry) => entry.workUnitId === "U2");
	assert.ok(runtimeEntry);
	assert.throws(
		() =>
			assertDiagramProjectsTopology(
				runtimeEntry.snapshot.blueprint.topology,
				runtimeEntry.diagram.source.replace("n1 --> n3", "n1 --> n2"),
			),
		/not a projection/u,
	);
	const u1 = first.reviewBlueprints.find((entry) => entry.workUnitId === "U1");
	const u2 = first.reviewBlueprints.find((entry) => entry.workUnitId === "U2");
	const u3 = first.reviewBlueprints.find((entry) => entry.workUnitId === "U3");
	assert.deepEqual(u1.delta.structural.addedNodes, []);
	assert.deepEqual(
		u2.delta.structural.addedNodes.map((node) => node.id),
		["refresh.request", "refresh.rotate", "refresh.validate", "session.persist.refresh"],
	);
	assert.deepEqual(u3.delta.structural.addedNodes, []);
	const packageJson = JSON.parse(await readFile(resolve(first.repository, "package.json"), "utf8"));
	assert.equal(packageJson.dependencies["@graphrefly/ts"], "0.1.1");
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
	assert.deepEqual((await readdir(output)).sort(), [
		".graphrefly-stack-bundle",
		"README.md",
		"evidence-bundle.json",
	]);
	const portable = JSON.parse(await readFile(resolve(output, "evidence-bundle.json"), "utf8"));
	const manifest = portable.manifest;
	const artifact = (path) => portable.artifacts[path];
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
	validate("PortableBundle", portable);
	validate("BundleManifest", manifest);
	validate("Task", artifact("task.json"));
	const stack = artifact("stack.json");
	validate("GitStack", stack);
	validate("ChangePlan", artifact("plan/change-plan.json"));
	validate("BlueprintSnapshot", artifact("blueprints/current.json"));
	validate("BlueprintDelta", artifact("blueprints/delta.json"));
	for (const commit of ["base", "u1", "u2", "u3"]) {
		const snapshot = artifact(`blueprints/commits/${commit}.json`);
		validate("BlueprintSnapshot", snapshot);
		const diagram = artifact(`blueprints/diagrams/${commit}.json`);
		assert.equal(diagram.renderer, "@graphrefly/ts/render.describeToMermaid");
		assert.match(diagram.source, /^flowchart LR\n/u);
	}
	for (const unit of ["u1", "u2", "u3"]) {
		validate("BlueprintDelta", artifact(`blueprints/deltas/${unit}.json`));
	}
	validate("SelectiveReplan", artifact("replan/affected.json"));
	validate("ReviewDecision", artifact("review/decision.json"));
	const staleRecords = ["u1", "u2", "u3"].map((unit) => artifact(`semantic-changes/${unit}.json`));
	const finalRecords = ["u1", "u2", "u3"].map((unit) =>
		artifact(`semantic-changes/final/${unit}.json`),
	);
	for (const record of [...staleRecords, ...finalRecords]) validate("SemanticChangeRecord", record);
	const exportedChecks = [
		...artifact("checks/after-rebase.json"),
		...artifact("checks/final.json"),
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
	assert.deepEqual(layout.committedPaths, ["README.md", "evidence-bundle.json"]);
	for (const relative of layout.requiredArtifactPaths) {
		assert.equal(Object.hasOwn(portable.artifacts, relative), true, relative);
	}
	for (const artifact of manifest.artifacts) {
		assert.equal(sha256Jcs(portable.artifacts[artifact.path]), artifact.hash.value, artifact.path);
	}
	for (const unit of ["u1", "u2", "u3"]) {
		const rawDiff = artifact(`diffs/${unit}.json`);
		validate("RawDiff", rawDiff);
		assert.match(rawDiff.patch, /diff --git a\//);
		assert.equal(rawDiff.patch.includes(first.repository), false);
	}
	assert.deepEqual(
		Object.keys(portable.artifacts),
		manifest.artifacts.map((artifact) => artifact.path),
	);
	const loadedFromDirectory = await readPortableEvidenceBundle(output);
	const loadedFromFile = await readPortableEvidenceBundle(resolve(output, "evidence-bundle.json"));
	assert.deepEqual(loadedFromDirectory.artifacts, loadedFromFile.artifacts);
	const tampered = structuredClone(portable);
	tampered.artifacts["task.json"].title = "forged";
	const tamperedPath = resolve(output, "tampered.json");
	await writeFile(tamperedPath, JSON.stringify(tampered));
	await assert.rejects(() => readPortableEvidenceBundle(tamperedPath), /artifact hash mismatch/u);
	const missing = structuredClone(portable);
	delete missing.artifacts["task.json"];
	await writeFile(tamperedPath, JSON.stringify(missing));
	await assert.rejects(() => readPortableEvidenceBundle(tamperedPath), /exactly match/u);
	const extra = structuredClone(portable);
	extra.artifacts["unmanifested.json"] = {};
	await writeFile(tamperedPath, JSON.stringify(extra));
	await assert.rejects(() => readPortableEvidenceBundle(tamperedPath), /exactly match/u);
	const duplicate = structuredClone(portable);
	duplicate.manifest.artifacts.push(duplicate.manifest.artifacts[0]);
	await writeFile(tamperedPath, JSON.stringify(duplicate));
	await assert.rejects(() => readPortableEvidenceBundle(tamperedPath), /duplicate artifact paths/u);
	const finalGate = artifact("gates/final.json");
	assert.equal(finalGate.verdict, "pass");
	const afterGate = artifact("gates/after-change.json");
	assert.equal(afterGate.verdict, "blocked");
});
