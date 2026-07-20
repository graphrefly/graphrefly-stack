import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	CONTRACT_VERSION,
	createStrictAjv,
	SEMANTIC_ARTIFACTS_SCHEMA,
	SEMANTIC_GOLDEN_SUITE_SCHEMA,
	SEMANTIC_REASON_ORDER,
	SEMANTIC_STORAGE,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);

async function readJson(path) {
	return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

const artifactsSchema = await readJson("contracts/semantic/v1/artifacts.schema.json");
const goldenSuiteSchema = await readJson("contracts/semantic/v1/golden-suite.schema.json");
const suite = await readJson("fixtures/contracts/semantic/v1/golden-suite.json");
const digests = await readJson("fixtures/contracts/semantic/v1/golden-digests.json");
const repositoryConfigSchema = await readJson(
	"contracts/repository/v1/repository-config.schema.json",
);

const ajv = createStrictAjv();
ajv.addSchema(artifactsSchema);
const validateSuite = ajv.compile(goldenSuiteSchema);
const definition = (name) => ajv.getSchema(`${SEMANTIC_ARTIFACTS_SCHEMA}#/definitions/${name}`);

test("semantic v1 schemas compile and every golden artifact is strict", () => {
	assert.equal(artifactsSchema.$id, SEMANTIC_ARTIFACTS_SCHEMA);
	assert.equal(goldenSuiteSchema.$id, SEMANTIC_GOLDEN_SUITE_SCHEMA);
	assert.equal(validateSuite(suite), true, JSON.stringify(validateSuite.errors, null, 2));

	assert.equal(definition("RepositoryPolicy")(suite.policy), true);
	assert.equal(
		definition("SemanticPlanProposal")({
			schema: "graphrefly.stack.semantic-plan-proposal.v1",
			planId: suite.plan.planId,
			proposalSource: "human",
			workUnits: suite.plan.workUnits,
		}),
		true,
	);
	assert.equal(definition("AcceptedChangePlan")(suite.plan), true);
	assert.equal(definition("ModelContextManifest")(suite.modelContext), true);
	for (const binding of suite.bindings) {
		assert.equal(definition("CommitWorkUnitBinding")(binding), true);
	}
	for (const record of suite.records) {
		assert.equal(definition("SemanticChangeRecord")(record), true);
	}
	for (const check of suite.checks) assert.equal(definition("CheckResult")(check), true);
	for (const fixtureCase of suite.cases) {
		if (fixtureCase.expectedGate !== null) {
			assert.equal(definition("GateResult")(fixtureCase.expectedGate), true);
		}
		if (fixtureCase.selectiveReplan !== null) {
			assert.equal(definition("SelectiveReplan")(fixtureCase.selectiveReplan), true);
		}
		if (fixtureCase.rebindRecord !== null) {
			assert.equal(definition("SemanticChangeRecord")(fixtureCase.rebindRecord), true);
		}
	}

	const gateInput = {
		schema: "graphrefly.stack.semantic-gate-input.v1",
		policy: suite.policy,
		plan: suite.plan,
		bindings: suite.bindings,
		records: suite.records,
		currentBlueprintHash: suite.records.at(-1).blueprintHash,
		checks: suite.checks,
	};
	assert.equal(definition("GateInput")(gateInput), true);
});

test("semantic contract bytes and every failure case are stable", () => {
	assert.equal(sha256Jcs(suite), digests.suite);
	for (const fixtureCase of suite.cases) {
		assert.equal(sha256Jcs(fixtureCase), digests.cases[fixtureCase.caseId]);
	}
	assert.deepEqual(
		suite.cases.map((fixtureCase) => fixtureCase.caseId),
		[
			"normal-valid",
			"architecture-stale-selective",
			"unrelated-immutable-rebind",
			"missing-trailer",
			"duplicate-trailer",
			"ambiguous-predicate",
			"unsupported-predicate",
			"widened-scope",
			"undeclared-check",
			"policy-freshness",
			"artifact-tamper",
			"unauthorized-live-context",
		],
	);
	assert.equal(Object.keys(digests.cases).length, suite.cases.length);
});

test("gate and recovery cases preserve deterministic order and selective boundaries", () => {
	for (const fixtureCase of suite.cases) {
		assert.notEqual(fixtureCase.expectedGate === null, fixtureCase.expectedError === null);
		if (fixtureCase.expectedGate === null) continue;
		const invalid = fixtureCase.expectedGate.units.filter((unit) => unit.verdict === "invalid");
		assert.equal(fixtureCase.expectedGate.verdict === "pass", invalid.length === 0);
		assert.deepEqual(
			fixtureCase.expectedGate.units.map((unit) => unit.workUnitId),
			["CONTRACTS", "RUNTIME", "HTTP"],
		);
		for (const unit of fixtureCase.expectedGate.units) {
			const indexes = unit.reasonCodes.map((code) => SEMANTIC_REASON_ORDER.indexOf(code));
			assert.equal(
				indexes.every((index) => index >= 0),
				true,
			);
			assert.deepEqual(
				indexes,
				[...indexes].sort((left, right) => left - right),
			);
		}
	}

	const stale = suite.cases.find(
		(fixtureCase) => fixtureCase.caseId === "architecture-stale-selective",
	);
	assert.deepEqual(stale.selectiveReplan.preservedUnits, ["CONTRACTS"]);
	assert.deepEqual(stale.selectiveReplan.invalidUnits, ["RUNTIME", "HTTP"]);
	assert.deepEqual(stale.expectedGate.units[2].invalidDependencies, ["RUNTIME"]);

	const unrelated = suite.cases.find(
		(fixtureCase) => fixtureCase.caseId === "unrelated-immutable-rebind",
	);
	assert.equal(unrelated.rebindRecord.rebindFrom, "record-contracts-v1");
	assert.equal(unrelated.rebindRecord.recordId, "record-contracts-v2");
});

test("schemas reject model authority, arbitrary execution, ambiguous trailers and implicit upload", () => {
	assert.equal(definition("RepositoryPolicy")({ ...suite.policy, modelMayApprove: true }), false);
	assert.equal(definition("PolicyCheck")({ ...suite.policy.checks[0], shell: true }), false);
	assert.equal(definition("PolicyCheck")({ ...suite.policy.checks[0], network: true }), false);
	assert.equal(
		definition("BlueprintPredicate")({ operator: "model-confidence", value: 0.99 }),
		false,
	);
	assert.equal(
		definition("CommitWorkUnitBinding")({
			...suite.bindings[0],
			trailer: { ...suite.bindings[0].trailer, occurrences: 2 },
		}),
		false,
	);
	assert.equal(
		definition("AcceptedChangePlan")({
			...suite.plan,
			acceptedBy: { ...suite.plan.acceptedBy, identityVerified: true },
		}),
		false,
	);
	assert.equal(
		definition("ModelContextManifest")({
			...suite.modelContext,
			authorization: { mode: "implicit", identityVerified: false },
		}),
		false,
	);
	const { policyFields: _policyFields, ...implicitPolicyContext } = suite.modelContext;
	assert.equal(definition("ModelContextManifest")(implicitPolicyContext), false);
	assert.equal(
		definition("ModelContextManifest")({
			...suite.modelContext,
			sourcePaths: ["/private/source.ts"],
		}),
		false,
	);
	for (const sourcePath of [".", "./source.ts", "src//source.ts", "src/./source.ts", "src/"]) {
		assert.equal(
			definition("ModelContextManifest")({
				...suite.modelContext,
				sourcePaths: [sourcePath],
			}),
			false,
		);
	}
	assert.equal(
		definition("BlueprintSelector")({
			kind: "subgraph",
			mountPath: ["api", "api"],
		}),
		true,
	);
	assert.equal(definition("BlueprintSelector")({ kind: "node", nodeId: "audit::sink" }), true);
});

test("semantic adoption is additive and storage ownership remains explicit", () => {
	assert.equal(CONTRACT_VERSION, "v1");
	assert.deepEqual(SEMANTIC_STORAGE, {
		policy: ".graphrefly-stack/policy.json",
		plans: ".graphrefly-stack/plans",
		localState: ".git/grfs",
		planTrailer: "GraphReFly-Plan",
		workUnitTrailer: "GraphReFly-Work-Unit",
	});

	const repositoryAjv = createStrictAjv();
	const validateRepositoryConfig = repositoryAjv.compile(repositoryConfigSchema);
	const existingConfig = {
		schema: "graphrefly.stack.repository.v1",
		blueprint: { entrypoint: "graphrefly-stack.blueprint.mjs" },
	};
	assert.equal(validateRepositoryConfig(existingConfig), true);
	assert.equal(
		validateRepositoryConfig({ ...existingConfig, semanticPolicy: SEMANTIC_STORAGE.policy }),
		false,
	);
	assert.notEqual(SEMANTIC_STORAGE.policy, ".graphrefly-stack.json");
	assert.equal(suite.plan.acceptedBy.identityVerified, false);
	assert.equal(Object.hasOwn(suite.cases[0].expectedGate, "reviewDecision"), false);
	assert.equal(Object.hasOwn(suite.cases[0].expectedGate, "model"), false);
});
