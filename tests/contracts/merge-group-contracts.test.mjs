import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	assertGroupIntegrationIntegrity,
	assertLinearV1ConversionIntegrity,
	assertPlanQualifiedCommitIntegrity,
	convertLinearV1ToV2,
	createStrictAjv,
	GROUP_INTEGRATION_GOLDEN_SCHEMA,
	LINEAR_V1_CONVERSION_BUNDLE_SCHEMA,
	LINEAR_V1_CONVERSION_SCHEMA,
	LinearV1ConversionError,
	MERGE_GROUP_ARTIFACTS_SCHEMA,
	MERGE_GROUP_BUNDLE_SCHEMA,
	MERGE_GROUP_GOLDEN_SUITE_SCHEMA,
	MERGE_GROUP_INVOCATION_SCHEMA,
	MERGE_GROUP_RESULT_SCHEMA,
	MULTI_PLAN_LIMITS,
	PLAN_QUALIFIED_COMMIT_SCHEMA,
	SEMANTIC_STORAGE,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const clone = structuredClone;
const digest = (value) => ({ algorithm: "sha256", value: sha256Jcs(value) });

const [
	repositoryConfig,
	repositoryReview,
	semantic,
	ci,
	topology,
	dagSemantic,
	integration,
	mergeGroup,
	mergeGroupGoldenSchema,
	mergeGroupGolden,
	mergeGroupDigests,
	groupIntegrationGoldenSchema,
	groupIntegrationGolden,
	groupIntegrationDigests,
	suite,
] = await Promise.all([
	readJson("contracts/repository/v1/repository-config.schema.json"),
	readJson("contracts/repository/v1/review.schema.json"),
	readJson("contracts/semantic/v1/artifacts.schema.json"),
	readJson("contracts/ci/v1/artifacts.schema.json"),
	readJson("contracts/dag/v2/artifacts.schema.json"),
	readJson("contracts/dag/v2/semantic.schema.json"),
	readJson("contracts/integration/v1/artifacts.schema.json"),
	readJson("contracts/dag/v2/merge-group.schema.json"),
	readJson("contracts/dag/v2/merge-group-golden-suite.schema.json"),
	readJson("fixtures/contracts/dag/v2/merge-group-golden-suite.json"),
	readJson("fixtures/contracts/dag/v2/merge-group-golden-digests.json"),
	readJson("contracts/dag/v2/group-integration-golden.schema.json"),
	readJson("fixtures/contracts/dag/v2/group-integration-golden.json"),
	readJson("fixtures/contracts/dag/v2/group-integration-golden-digests.json"),
	readJson("fixtures/contracts/semantic/v1/golden-suite.json"),
]);

const ajv = createStrictAjv();
for (const schema of [
	repositoryConfig,
	repositoryReview,
	semantic,
	ci,
	topology,
	dagSemantic,
	integration,
	mergeGroup,
]) {
	ajv.addSchema(schema);
}
const definition = (name) => ajv.getSchema(`${MERGE_GROUP_ARTIFACTS_SCHEMA}#/definitions/${name}`);
const validateMergeGroupGolden = ajv.compile(mergeGroupGoldenSchema);
const validateGroupIntegrationGolden = ajv.compile(groupIntegrationGoldenSchema);

function validSource() {
	const policy = clone(suite.policy);
	const plan = clone(suite.plan);
	plan.policy.digest = digest(policy);
	const bindings = clone(suite.bindings);
	const records = clone(suite.records);
	for (let index = 0; index < records.length; index += 1) {
		const unit = plan.workUnits[index];
		const record = records[index];
		record.bindingDigest = digest(bindings[index]);
		record.policyDigest = digest(policy);
		record.sourceScopeDigest = digest(unit.allowedSourceScopes);
		record.claimWitnesses = unit.claims.map((claim) => ({
			claimId: claim.id,
			predicateDigest: digest(claim.predicate),
			status: "satisfied",
		}));
		record.requiredChecks = [...unit.requiredChecks];
	}
	const objects = bindings.map((binding, index) => ({
		oid: binding.commit,
		parents: [binding.parentCommit],
		layer: index + 1,
		kind: "implementation",
		workUnitId: binding.workUnitId,
		blueprintHash: records[index].blueprintHash,
	}));
	const gitTopology = {
		schema: "graphrefly.stack.git-topology-slice.v2",
		repository: { provider: "github", owner: "clfhhc", name: "test-graphrefly" },
		provider: { kind: "graphrefly", runtimeVersion: "0.3.0", blueprintVersion: "v2" },
		base: bindings[0].parentCommit,
		head: bindings.at(-1).commit,
		baseBlueprintHash: digest({ base: bindings[0].parentCommit }),
		limits: { maxObjects: 64, maxWidth: 8, maxParents: 2 },
		objects,
		joins: [],
	};
	const gateInput = {
		schema: "graphrefly.stack.semantic-gate-input.v1",
		policy,
		plan,
		bindings,
		records,
		currentBlueprintHash: records.at(-1).blueprintHash,
		checks: clone(suite.checks),
	};
	const expected = suite.cases.find((entry) => entry.caseId === "normal-valid").expectedGate;
	const gateResult = { ...clone(expected), inputDigest: digest(gateInput) };
	return { topology: gitTopology, gateInput, gateResult };
}

test("multi-Plan foundation schemas expose strict additive identities", () => {
	assert.equal(mergeGroup.$id, MERGE_GROUP_ARTIFACTS_SCHEMA);
	assert.equal(mergeGroupGoldenSchema.$id, MERGE_GROUP_GOLDEN_SUITE_SCHEMA);
	assert.equal(
		validateMergeGroupGolden(mergeGroupGolden),
		true,
		JSON.stringify(validateMergeGroupGolden.errors, null, 2),
	);
	assert.equal(sha256Jcs(mergeGroupGolden), mergeGroupDigests.suite);
	assert.equal(
		sha256Jcs(mergeGroupGolden.cases[0]),
		mergeGroupDigests.cases["plan-qualified-conversion"],
	);
	assert.equal(sha256Jcs(mergeGroupGolden.cases[0].native), mergeGroupDigests.artifacts.native);
	assert.equal(
		sha256Jcs(mergeGroupGolden.cases[0].converted),
		mergeGroupDigests.artifacts.converted,
	);
	assert.equal(
		sha256Jcs(mergeGroupGolden.cases[0].conversion),
		mergeGroupDigests.artifacts.conversion,
	);
	assert.equal(PLAN_QUALIFIED_COMMIT_SCHEMA, "graphrefly.stack.plan-qualified-commit.v1");
	assert.equal(LINEAR_V1_CONVERSION_SCHEMA, "graphrefly.stack.linear-v1-conversion.v1");
	assert.equal(
		LINEAR_V1_CONVERSION_BUNDLE_SCHEMA,
		"graphrefly.stack.linear-v1-conversion-bundle.v1",
	);
	assert.equal(MERGE_GROUP_INVOCATION_SCHEMA, "graphrefly.stack.merge-group-invocation.v1");
	assert.equal(MERGE_GROUP_RESULT_SCHEMA, "graphrefly.stack.merge-group-result.v1");
	assert.equal(MERGE_GROUP_BUNDLE_SCHEMA, "graphrefly.stack.merge-group-bundle.v1");
	assert.ok(definition("MergeGroupInvocation"));
	assert.ok(definition("MergeGroupResult"));
	assert.ok(definition("MergeGroupBundle"));
	assert.deepEqual(MULTI_PLAN_LIMITS, { maxPlans: 8 });
	assert.equal(SEMANTIC_STORAGE.planTrailer, "GraphReFly-Plan");
	assert.equal(groupIntegrationGoldenSchema.$id, GROUP_INTEGRATION_GOLDEN_SCHEMA);
	assert.equal(
		validateGroupIntegrationGolden(groupIntegrationGolden),
		true,
		JSON.stringify(validateGroupIntegrationGolden.errors, null, 2),
	);
	assert.equal(sha256Jcs(groupIntegrationGolden.input), groupIntegrationDigests.input);
	assert.equal(sha256Jcs(groupIntegrationGolden.result), groupIntegrationDigests.result);
	assertGroupIntegrationIntegrity(groupIntegrationGolden.input, groupIntegrationGolden.result);
	assert.equal(
		definition("GroupIntegrationInput")({
			schema: "graphrefly.stack.group-integration-input.v1",
			topologyDigest: digest({ topology: true }),
			headBlueprintDigest: digest({ blueprint: true }),
			repositoryPolicyDigest: digest({ policy: true }),
			qualifiedCommitDigests: [
				{ planId: "plan-a", workUnitId: "API", digest: digest({ commit: "a" }) },
			],
			plans: [
				{
					planId: "plan-a",
					planDigest: digest({ plan: "a" }),
					policyDigest: digest({ policy: true }),
					gateResultDigest: digest({ gate: "a" }),
					verdict: "pass",
				},
			],
			joins: [],
			semanticConflicts: [],
		}),
		true,
	);

	const native = {
		schema: PLAN_QUALIFIED_COMMIT_SCHEMA,
		planId: "plan-a",
		workUnitId: "API",
		commit: { algorithm: "sha1", value: "1".repeat(40) },
		ownership: {
			kind: "native",
			planTrailer: { name: "GraphReFly-Plan", value: "plan-a", occurrences: 1 },
			workUnitTrailer: { name: "GraphReFly-Work-Unit", value: "API", occurrences: 1 },
		},
	};
	assert.equal(definition("PlanQualifiedCommit")(native), true);
	assertPlanQualifiedCommitIntegrity(native);
	const mismatched = {
		...native,
		ownership: {
			...native.ownership,
			planTrailer: { ...native.ownership.planTrailer, value: "plan-b" },
		},
	};
	assert.equal(definition("PlanQualifiedCommit")(mismatched), true);
	assert.throws(() => assertPlanQualifiedCommitIntegrity(mismatched), /do not match identity/u);
	assert.equal(
		definition("PlanQualifiedCommit")({ ...native, inferredFromUniqueWorkUnit: true }),
		false,
	);
});

test("valid linear v1 evidence converts to new independently derived v2 identities", () => {
	const source = validSource();
	const bundle = convertLinearV1ToV2(source);
	assert.equal(definition("LinearV1ConversionBundle")(bundle), true);
	assertLinearV1ConversionIntegrity(bundle);
	assert.deepEqual(
		bundle.dependencyGraph.workUnits.map((unit) => unit.workUnitId),
		["CONTRACTS", "RUNTIME", "HTTP"],
	);
	assert.equal(
		bundle.qualifiedCommits.every((entry) => entry.ownership.kind === "converted-v1"),
		true,
	);
	assert.equal(
		bundle.records.every((record) => record.recordId.startsWith("record-")),
		true,
	);
	assert.equal(
		bundle.records.every((record) => !source.gateInput.records.includes(record)),
		true,
	);
	assert.equal(bundle.conversion.source.gateInputDigest.value, sha256Jcs(source.gateInput));
	assert.notEqual(bundle.records[0].recordId, source.gateInput.records[0].recordId);

	const forged = clone(bundle);
	forged.records[0].sourceScopeDigest.value = "f".repeat(64);
	assert.throws(
		() => assertLinearV1ConversionIntegrity(forged),
		(error) =>
			error instanceof LinearV1ConversionError &&
			error.message === "linear v1 conversion bundle is not independently derived",
	);
});

test("conversion rejects blocked, merged and mismatched legacy evidence", () => {
	const blocked = validSource();
	blocked.gateResult.verdict = "blocked";
	assert.throws(() => convertLinearV1ToV2(blocked), /only a passing v1 GateResult/u);

	const merged = validSource();
	merged.topology.joins.push({});
	assert.throws(() => convertLinearV1ToV2(merged), /DAG join bindings are duplicated|join/u);

	const mismatched = validSource();
	mismatched.gateInput.records[0].bindingDigest.value = "f".repeat(64);
	mismatched.gateResult.inputDigest = digest(mismatched.gateInput);
	assert.throws(() => convertLinearV1ToV2(mismatched), /does not match topology/u);
});
