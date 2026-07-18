import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalize, createStrictAjv, sha256Jcs } from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);

async function readJson(path) {
	return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

const artifactsSchema = await readJson("contracts/v1/schemas/artifacts.schema.json");
const goldenSuiteSchema = await readJson("contracts/v1/schemas/golden-suite.schema.json");
const suite = await readJson("fixtures/contracts/v1/golden-suite.json");
const digests = await readJson("fixtures/contracts/v1/golden-digests.json");
const bundleLayout = await readJson("fixtures/contracts/v1/bundle-layout.json");
const repositoryConfigSchema = await readJson(
	"contracts/repository/v1/repository-config.schema.json",
);
const repositoryReviewSchema = await readJson("contracts/repository/v1/review.schema.json");
const semanticArtifactsSchema = await readJson("contracts/semantic/v1/artifacts.schema.json");

const ajv = createStrictAjv();
ajv.addSchema(artifactsSchema);
const validateSuite = ajv.compile(goldenSuiteSchema);

test("the generic repository config is strict and path-safe", () => {
	const repositoryAjv = createStrictAjv();
	const validate = repositoryAjv.compile(repositoryConfigSchema);
	assert.equal(
		validate({
			schema: "graphrefly.stack.repository.v1",
			blueprint: { entrypoint: "tools/graphrefly-stack.blueprint.mjs" },
		}),
		true,
	);
	assert.equal(
		validate({
			schema: "graphrefly.stack.repository.v1",
			blueprint: { entrypoint: "../private.mjs" },
		}),
		false,
	);
	assert.equal(
		validate({
			schema: "graphrefly.stack.repository.v1",
			blueprint: { entrypoint: "blueprint.mjs" },
			unreviewed: true,
		}),
		false,
	);
});

test("the generic review schema compiles with the repository config authority", () => {
	const repositoryAjv = createStrictAjv();
	repositoryAjv.addSchema(repositoryConfigSchema);
	repositoryAjv.addSchema(semanticArtifactsSchema);
	assert.equal(typeof repositoryAjv.compile(repositoryReviewSchema), "function");
});

const reasonOrder = [
	"SCHEMA_INVALID",
	"PROVIDER_CAPABILITY_UNSUPPORTED",
	"BLUEPRINT_DIAGNOSTICS_ERROR",
	"COMMIT_NOT_FOUND",
	"COMMIT_BINDING_MISMATCH",
	"PATCH_ID_AMBIGUOUS",
	"SOURCE_SCOPE_VIOLATION",
	"SEMANTIC_PARENT_STALE",
	"DEPENDENCY_INVALID",
	"BLUEPRINT_WITNESS_STALE",
	"POLICY_REVISION_STALE",
	"POLICY_SESSION_WRITE_REQUIRES_BROKER",
	"REQUIRED_CHECK_MISSING",
	"REQUIRED_CHECK_FAILED",
	"ARTIFACT_HASH_MISMATCH",
];

const expectedCommittedBundlePaths = ["README.md", "evidence-bundle.json"];
const expectedBundleArtifactPaths = [
	"task.json",
	"stack.json",
	"blueprints/base.json",
	"blueprints/current.json",
	"blueprints/delta.json",
	"blueprints/commits/base.json",
	"blueprints/commits/u1.json",
	"blueprints/commits/u2.json",
	"blueprints/commits/u3.json",
	"blueprints/diagrams/base.json",
	"blueprints/diagrams/u1.json",
	"blueprints/diagrams/u2.json",
	"blueprints/diagrams/u3.json",
	"blueprints/deltas/u1.json",
	"blueprints/deltas/u2.json",
	"blueprints/deltas/u3.json",
	"diffs/u1.json",
	"diffs/u2.json",
	"diffs/u3.json",
	"plan/change-plan.json",
	"semantic-changes/u1.json",
	"semantic-changes/u2.json",
	"semantic-changes/u3.json",
	"semantic-changes/final/u1.json",
	"semantic-changes/final/u2.json",
	"semantic-changes/final/u3.json",
	"gates/before-change.json",
	"gates/after-change.json",
	"replan/affected.json",
	"checks/final.json",
	"checks/after-rebase.json",
	"gates/final.json",
	"review/decision.json",
];

test("the golden suite and every embedded artifact satisfy the strict v1 schemas", () => {
	assert.equal(validateSuite(suite), true, JSON.stringify(validateSuite.errors, null, 2));

	const validators = {
		task: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/Task"),
		stack: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/GitStack"),
		provider: ajv.getSchema(
			"urn:graphrefly-stack:schema:artifacts:v1#/definitions/BlueprintProviderCapabilities",
		),
		manifest: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/BundleManifest"),
		plan: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/ChangePlan"),
		snapshot: ajv.getSchema(
			"urn:graphrefly-stack:schema:artifacts:v1#/definitions/BlueprintSnapshot",
		),
		delta: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/BlueprintDelta"),
		record: ajv.getSchema(
			"urn:graphrefly-stack:schema:artifacts:v1#/definitions/SemanticChangeRecord",
		),
		check: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/CheckResult"),
		gate: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/GateResult"),
		replan: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/SelectiveReplan"),
		review: ajv.getSchema("urn:graphrefly-stack:schema:artifacts:v1#/definitions/ReviewDecision"),
	};

	assert.equal(validators.task(suite.task), true);
	assert.equal(validators.stack(suite.stack), true);
	assert.equal(validators.provider(suite.provider), true);
	assert.equal(validators.manifest(suite.manifest), true);
	assert.equal(validators.plan(suite.changePlan), true);
	for (const snapshot of suite.snapshots) assert.equal(validators.snapshot(snapshot), true);
	for (const delta of suite.deltas) assert.equal(validators.delta(delta), true);
	for (const record of suite.semanticChanges) assert.equal(validators.record(record), true);
	for (const check of suite.checks) assert.equal(validators.check(check), true);
	for (const fixtureCase of suite.cases) {
		assert.equal(validators.gate(fixtureCase.expectedGate), true);
		if (fixtureCase.selectiveReplan !== null) {
			assert.equal(validators.replan(fixtureCase.selectiveReplan), true);
		}
		assert.equal(validators.review(fixtureCase.reviewDecision), true);
	}

	assert.equal(validators.task({ ...suite.task, modelVerdict: "pass" }), false);
	assert.equal(
		validators.gate({ ...suite.cases[0].expectedGate, reviewDecision: "approve" }),
		false,
	);
	assert.equal(
		validators.manifest({
			...suite.manifest,
			artifacts: [
				...suite.manifest.artifacts,
				{
					path: "manifest.json",
					hash: suite.manifest.canonicalInputDigest,
				},
			],
		}),
		false,
	);
	assert.equal(
		validators.manifest({
			...suite.manifest,
			artifacts: [
				{
					path: "../private/raw.json",
					hash: suite.manifest.canonicalInputDigest,
				},
			],
		}),
		false,
	);
});

test("RFC 8785 canonical bytes and checked-in SHA-256 values are repeatable", () => {
	const canonical = canonicalize(suite);
	assert.equal(canonicalize(JSON.parse(canonical)), canonical);
	assert.equal(sha256Jcs(suite), digests.suite);

	for (const fixtureCase of suite.cases) {
		assert.equal(sha256Jcs(fixtureCase), digests.cases[fixtureCase.caseId]);
	}

	assert.throws(() => canonicalize({ invalid: "\ud800" }), /unpaired high surrogate/);
});

test("golden cases fix verdicts, work-unit order, reason order, and index integrity", () => {
	const expectedCaseOrder = [
		"current-valid",
		"clean-rebase-semantic-stale",
		"unrelated-change-still-valid",
		"stale-parent",
		"forged-or-wrong-scope",
		"fresh-selective-replan",
	];
	assert.deepEqual(
		suite.cases.map((fixtureCase) => fixtureCase.caseId),
		expectedCaseOrder,
	);

	for (const fixtureCase of suite.cases) {
		assert.ok(suite.snapshots[fixtureCase.baseSnapshotIndex]);
		assert.ok(suite.snapshots[fixtureCase.currentSnapshotIndex]);
		assert.ok(suite.deltas[fixtureCase.deltaIndex]);
		assert.deepEqual(
			fixtureCase.expectedGate.units.map((unit) => unit.workUnitId),
			["U1", "U2", "U3"],
		);
		for (const unit of fixtureCase.expectedGate.units) {
			const indexes = unit.reasonCodes.map((code) => reasonOrder.indexOf(code));
			assert.deepEqual(
				indexes,
				[...indexes].sort((left, right) => left - right),
			);
		}
		const invalidUnits = fixtureCase.expectedGate.units.filter(
			(unit) => unit.verdict === "invalid",
		);
		assert.equal(fixtureCase.expectedGate.verdict === "pass", invalidUnits.length === 0);
	}

	const stale = suite.cases[1].expectedGate;
	assert.deepEqual(stale.units[1].reasonCodes, [
		"BLUEPRINT_WITNESS_STALE",
		"POLICY_SESSION_WRITE_REQUIRES_BROKER",
	]);
	assert.deepEqual(stale.units[2].invalidDependencies, ["U2"]);
	assert.deepEqual(suite.cases[5].selectiveReplan.preservedUnits, ["U1"]);
});

test("bundle layout and provenance preserve the evidence boundary", () => {
	assert.deepEqual(bundleLayout.committedPaths, expectedCommittedBundlePaths);
	assert.deepEqual(bundleLayout.requiredArtifactPaths, expectedBundleArtifactPaths);
	assert.equal(bundleLayout.requiredArtifactPaths.includes("review/decision.json"), true);
	for (const artifact of suite.manifest.artifacts) {
		assert.notEqual(artifact.path, "manifest.json");
		assert.notEqual(artifact.path, "README.md");
	}
	for (const fixtureCase of suite.cases) {
		assert.equal(fixtureCase.reviewDecision.identityVerified, false);
		assert.equal(Object.hasOwn(fixtureCase.expectedGate, "reviewDecision"), false);
		assert.equal(Object.hasOwn(fixtureCase.expectedGate, "model"), false);
	}
});
