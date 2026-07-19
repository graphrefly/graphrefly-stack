import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	assertDagReviewIntegrity,
	assertDagSemanticIntegrity,
	createStrictAjv,
	DAG_ARTIFACTS_SCHEMA,
	DAG_GATE_INPUT_SCHEMA,
	DAG_GATE_RESULT_SCHEMA,
	DAG_REASON_ORDER,
	DAG_REVIEW_SCHEMA,
	DAG_SEMANTIC_ARTIFACTS_SCHEMA,
	DAG_SEMANTIC_GOLDEN_SUITE_SCHEMA,
	DagSemanticIntegrityError,
	JOIN_EVALUATION_V2_SCHEMA,
	SEMANTIC_DEPENDENCY_GRAPH_SCHEMA,
	SEMANTIC_RECORD_V2_SCHEMA,
	sha256Jcs,
	UNIT_EVALUATION_V2_SCHEMA,
	WORK_UNIT_BINDING_V2_SCHEMA,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const clone = structuredClone;

const [v1Semantic, topologySchema, semanticSchema, goldenSchema, topologySuite, suite, digests] =
	await Promise.all([
		readJson("contracts/semantic/v1/artifacts.schema.json"),
		readJson("contracts/dag/v2/artifacts.schema.json"),
		readJson("contracts/dag/v2/semantic.schema.json"),
		readJson("contracts/dag/v2/semantic-golden-suite.schema.json"),
		readJson("fixtures/contracts/dag/v2/golden-suite.json"),
		readJson("fixtures/contracts/dag/v2/semantic-golden-suite.json"),
		readJson("fixtures/contracts/dag/v2/semantic-golden-digests.json"),
	]);

const ajv = createStrictAjv();
ajv.addSchema(v1Semantic);
ajv.addSchema(topologySchema);
ajv.addSchema(semanticSchema);
const validateSuite = ajv.compile(goldenSchema);
const definition = (name) => ajv.getSchema(`${DAG_SEMANTIC_ARTIFACTS_SCHEMA}#/definitions/${name}`);
const topologyFor = (caseId) =>
	topologySuite.cases.find((entry) => entry.caseId === caseId).topology;

test("DAG semantic v2 schemas and golden bytes are strict and stable", () => {
	assert.equal(semanticSchema.$id, DAG_SEMANTIC_ARTIFACTS_SCHEMA);
	assert.equal(goldenSchema.$id, DAG_SEMANTIC_GOLDEN_SUITE_SCHEMA);
	assert.equal(validateSuite(suite), true, JSON.stringify(validateSuite.errors, null, 2));
	assert.equal(sha256Jcs(suite), digests.suite);
	const golden = suite.cases[0];
	assert.equal(sha256Jcs(golden), digests.cases[golden.caseId]);
	assert.equal(sha256Jcs(golden.dependencyGraph), digests.artifacts.dependencyGraph);
	assert.equal(sha256Jcs(golden.bindings[0]), digests.artifacts.binding);
	assert.equal(sha256Jcs(golden.records[0]), digests.artifacts.record);
	assert.equal(sha256Jcs(golden.unitEvaluations[0]), digests.artifacts.unitEvaluation);
	assert.equal(sha256Jcs(golden.gateInput), digests.artifacts.gateInput);
	assert.equal(sha256Jcs(golden.gateResult), digests.artifacts.gateResult);
	assert.equal(sha256Jcs(golden.review), digests.artifacts.review);
	assertDagSemanticIntegrity({
		topology: topologyFor(golden.topologyCaseId),
		dependencyGraph: golden.dependencyGraph,
		bindings: golden.bindings,
		records: golden.records,
		unitEvaluations: golden.unitEvaluations,
		joinEvaluations: golden.joinEvaluations,
		gateInput: golden.gateInput,
		gateResult: golden.gateResult,
	});
	assertDagReviewIntegrity({
		topology: topologyFor(golden.topologyCaseId),
		dependencyGraph: golden.dependencyGraph,
		gateResult: golden.gateResult,
		review: golden.review,
	});
});

test("DAG semantic v2 exports the additive identities and fixed reason order", () => {
	assert.equal(SEMANTIC_DEPENDENCY_GRAPH_SCHEMA, "graphrefly.stack.semantic-dependency-graph.v2");
	assert.equal(WORK_UNIT_BINDING_V2_SCHEMA, "graphrefly.stack.work-unit-binding.v2");
	assert.equal(SEMANTIC_RECORD_V2_SCHEMA, "graphrefly.stack.semantic-record.v2");
	assert.equal(UNIT_EVALUATION_V2_SCHEMA, "graphrefly.stack.unit-evaluation.v2");
	assert.equal(JOIN_EVALUATION_V2_SCHEMA, "graphrefly.stack.join-evaluation.v2");
	assert.equal(DAG_GATE_INPUT_SCHEMA, "graphrefly.stack.dag-gate-input.v2");
	assert.equal(DAG_GATE_RESULT_SCHEMA, "graphrefly.stack.dag-gate-result.v2");
	assert.equal(DAG_REVIEW_SCHEMA, "graphrefly.stack.dag-review.v2");
	assert.deepEqual(DAG_REASON_ORDER.slice(-3), [
		"REQUIRED_CHECK_FAILED",
		"JOIN_INVALID",
		"ARTIFACT_HASH_MISMATCH",
	]);
});

test("DAG semantic schemas reject authority and topology widening", () => {
	const golden = suite.cases[0];
	assert.equal(
		definition("SemanticDependencyGraph")({ ...golden.dependencyGraph, merge: true }),
		false,
	);
	assert.equal(
		definition("WorkUnitBinding")({ ...golden.bindings[0], actorCredential: "x" }),
		false,
	);
	assert.equal(definition("DagGateResult")({ ...golden.gateResult, autoMerge: true }), false);
	assert.equal(
		definition("DagReviewProjection")({ ...golden.review, queueManagement: true }),
		false,
	);
	assert.equal(
		definition("WorkUnitBinding")({
			...golden.bindings[0],
			commit: { algorithm: "sha1", value: "x" },
		}),
		false,
	);
});

test("DAG semantic integrity rejects cycles, missing dependencies and non-ancestor dependencies", () => {
	const golden = suite.cases[0];
	const cyclic = clone(golden.dependencyGraph);
	cyclic.workUnits = [
		{ workUnitId: "U1", dependencies: ["U2"] },
		{ workUnitId: "U2", dependencies: ["U1"] },
	];
	assert.throws(
		() =>
			assertDagSemanticIntegrity({
				topology: topologyFor("linear-subset"),
				dependencyGraph: cyclic,
				bindings: golden.bindings,
				records: golden.records,
				unitEvaluations: golden.unitEvaluations,
				joinEvaluations: golden.joinEvaluations,
				gateInput: golden.gateInput,
				gateResult: golden.gateResult,
			}),
		DagSemanticIntegrityError,
	);

	const missing = clone(golden.dependencyGraph);
	missing.workUnits[0].dependencies = ["MISSING"];
	assert.throws(
		() =>
			assertDagSemanticIntegrity({
				topology: topologyFor("linear-subset"),
				dependencyGraph: missing,
				bindings: golden.bindings,
				records: golden.records,
				unitEvaluations: golden.unitEvaluations,
				joinEvaluations: golden.joinEvaluations,
				gateInput: golden.gateInput,
				gateResult: golden.gateResult,
			}),
		DagSemanticIntegrityError,
	);

	const topology = topologyFor("binary-clean-join");
	const graph = {
		schema: SEMANTIC_DEPENDENCY_GRAPH_SCHEMA,
		planId: "plan-dag",
		topologyDigest: { algorithm: "sha256", value: sha256Jcs(topology) },
		workUnits: [
			{ workUnitId: "LEFT", dependencies: [] },
			{ workUnitId: "RIGHT", dependencies: ["LEFT"] },
		],
	};
	const binding = (entry) => ({
		schema: WORK_UNIT_BINDING_V2_SCHEMA,
		planId: "plan-dag",
		workUnitId: entry.workUnitId,
		commit: entry.oid,
		parentCommit: entry.parents[0],
		trailer: { name: "GraphReFly-Work-Unit", value: entry.workUnitId, occurrences: 1 },
		stablePatchId: "a".repeat(40),
		diffDigest: { algorithm: "sha256", value: "d".repeat(64) },
		changedPaths: [`src/${entry.workUnitId.toLowerCase()}.ts`],
		blueprintHash: entry.blueprintHash,
		rebindFrom: null,
	});
	assert.throws(
		() =>
			assertDagSemanticIntegrity({
				topology,
				dependencyGraph: graph,
				bindings: topology.objects.filter((entry) => entry.kind === "implementation").map(binding),
				records: [],
				unitEvaluations: [],
				joinEvaluations: [],
				gateInput: {},
				gateResult: {},
			}),
		DagSemanticIntegrityError,
	);
});

test("DAG semantic integrity rejects traversal order, duplicate binding, tamper and reason reordering", () => {
	const golden = suite.cases[0];
	const inputs = () => ({
		topology: topologyFor(golden.topologyCaseId),
		dependencyGraph: clone(golden.dependencyGraph),
		bindings: clone(golden.bindings),
		records: clone(golden.records),
		unitEvaluations: clone(golden.unitEvaluations),
		joinEvaluations: clone(golden.joinEvaluations),
		gateInput: clone(golden.gateInput),
		gateResult: clone(golden.gateResult),
	});
	const duplicate = inputs();
	duplicate.bindings.push(clone(duplicate.bindings[0]));
	assert.throws(() => assertDagSemanticIntegrity(duplicate), DagSemanticIntegrityError);

	const tamper = inputs();
	tamper.records[0].bindingDigest.value = "f".repeat(64);
	assert.throws(() => assertDagSemanticIntegrity(tamper), DagSemanticIntegrityError);

	const reasons = inputs();
	reasons.gateResult.verdict = "blocked";
	reasons.gateResult.minimalAffectedCut = ["U1"];
	reasons.gateResult.units[0] = {
		workUnitId: "U1",
		verdict: "invalid",
		reasonCodes: ["CLAIM_INVALID", "SOURCE_SCOPE_VIOLATION"],
		witnesses: [],
		recordId: "record-u1",
	};
	assert.throws(() => assertDagSemanticIntegrity(reasons), DagSemanticIntegrityError);

	const forged = inputs();
	forged.gateResult.verdict = "blocked";
	forged.gateResult.minimalAffectedCut = ["U1"];
	forged.gateResult.units[0] = {
		workUnitId: "U1",
		verdict: "invalid",
		reasonCodes: ["CLAIM_INVALID"],
		witnesses: [{ kind: "claim", workUnitId: "U1", claimId: "claim-u1" }],
		recordId: "record-u1",
	};
	assert.throws(() => assertDagSemanticIntegrity(forged), DagSemanticIntegrityError);

	const binary = topologyFor("binary-clean-join");
	const unordered = inputs();
	unordered.topology = binary;
	unordered.dependencyGraph.topologyDigest = { algorithm: "sha256", value: sha256Jcs(binary) };
	unordered.dependencyGraph.workUnits = [
		{ workUnitId: "RIGHT", dependencies: [] },
		{ workUnitId: "LEFT", dependencies: [] },
	];
	assert.throws(() => assertDagSemanticIntegrity(unordered), DagSemanticIntegrityError);
});

test("DAG semantic schemas remain separate from unchanged topology v2", () => {
	assert.equal(topologySchema.$id, DAG_ARTIFACTS_SCHEMA);
	assert.equal(Object.hasOwn(topologySchema.definitions, "DagGateResult"), false);
});

test("DAG review integrity rejects editable verdicts, hidden edges and false parent selection", () => {
	const golden = suite.cases[0];
	const values = () => ({
		topology: topologyFor(golden.topologyCaseId),
		dependencyGraph: golden.dependencyGraph,
		gateResult: golden.gateResult,
		review: clone(golden.review),
	});
	const verdict = values();
	verdict.review.summary.verdict = "blocked";
	assert.throws(() => assertDagReviewIntegrity(verdict), DagSemanticIntegrityError);

	const edge = values();
	edge.review.gitEdges = [];
	assert.throws(() => assertDagReviewIntegrity(edge), DagSemanticIntegrityError);

	const selection = values();
	selection.review.selectedEvidence.parent.value = "f".repeat(40);
	assert.throws(() => assertDagReviewIntegrity(selection), DagSemanticIntegrityError);
});
