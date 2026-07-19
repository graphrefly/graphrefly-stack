import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sha256Jcs } from "../../packages/contracts/dist/index.js";
import { computeDagGateV2 } from "../../packages/core/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const clone = structuredClone;
const hash = (value) => ({ algorithm: "sha256", value: sha256Jcs(value) });
const fixedHash = (character) => ({ algorithm: "sha256", value: character.repeat(64) });

const [semanticSuite, topologySuite] = await Promise.all([
	readJson("fixtures/contracts/dag/v2/semantic-golden-suite.json"),
	readJson("fixtures/contracts/dag/v2/golden-suite.json"),
]);
const topologyFor = (caseId) =>
	topologySuite.cases.find((entry) => entry.caseId === caseId).topology;

function canonicalOrder(dependencies) {
	const result = [];
	const remaining = new Set(Object.keys(dependencies));
	while (remaining.size > 0) {
		const next = [...remaining]
			.filter((id) => dependencies[id].every((dependency) => result.includes(dependency)))
			.sort()[0];
		if (next === undefined) throw new Error("test dependency graph is cyclic");
		result.push(next);
		remaining.delete(next);
	}
	return result;
}

function evidenceFor(topology, dependencies) {
	const order = canonicalOrder(dependencies);
	const implementationById = new Map(
		topology.objects
			.filter((entry) => entry.kind === "implementation")
			.map((entry) => [entry.workUnitId, entry]),
	);
	const dependencyGraph = {
		schema: "graphrefly.stack.semantic-dependency-graph.v2",
		planId: "plan-dag",
		topologyDigest: hash(topology),
		workUnits: order.map((workUnitId) => ({ workUnitId, dependencies: dependencies[workUnitId] })),
	};
	const bindings = order.map((workUnitId, index) => {
		const entry = implementationById.get(workUnitId);
		return {
			schema: "graphrefly.stack.work-unit-binding.v2",
			planId: "plan-dag",
			workUnitId,
			commit: entry.oid,
			parentCommit: entry.parents[0],
			trailer: { name: "GraphReFly-Work-Unit", value: workUnitId, occurrences: 1 },
			stablePatchId: String(index + 1)
				.repeat(40)
				.slice(0, 40),
			diffDigest: fixedHash(String(index + 1)),
			changedPaths: [`src/${workUnitId.toLowerCase()}.ts`],
			blueprintHash: entry.blueprintHash,
			rebindFrom: null,
		};
	});
	const bindingById = new Map(bindings.map((entry) => [entry.workUnitId, entry]));
	const policyDigest = fixedHash("9");
	const records = [];
	const recordById = new Map();
	for (const workUnitId of order) {
		const checkId = `check-${workUnitId.toLowerCase()}`;
		const checkDigest = fixedHash(workUnitId === "RIGHT" ? "c" : "b");
		const checkEvidence = [{ workUnitId, checkId, digest: checkDigest }];
		const record = {
			schema: "graphrefly.stack.semantic-record.v2",
			recordId: `record-${workUnitId.toLowerCase()}`,
			planId: "plan-dag",
			workUnitId,
			bindingDigest: hash(bindingById.get(workUnitId)),
			directDependencyRecordIds: dependencies[workUnitId]
				.map((dependency) => recordById.get(dependency).recordId)
				.sort(),
			policyDigest,
			blueprintHash: bindingById.get(workUnitId).blueprintHash,
			sourceScopeDigest: fixedHash("6"),
			claimsDigest: fixedHash("7"),
			checksDigest: hash(checkEvidence),
			claimWitnesses: [
				{
					claimId: `claim-${workUnitId.toLowerCase()}`,
					predicateDigest: fixedHash("8"),
					status: "satisfied",
				},
			],
			requiredChecks: [checkId],
			rebindFrom: null,
		};
		records.push(record);
		recordById.set(workUnitId, record);
	}
	const unitEvaluations = order.map((workUnitId) => {
		const record = recordById.get(workUnitId);
		return {
			schema: "graphrefly.stack.unit-evaluation.v2",
			workUnitId,
			bindingDigest: hash(bindingById.get(workUnitId)),
			recordDigest: hash(record),
			sourceScope: { valid: true, witnessDigest: record.sourceScopeDigest },
			blueprintHash: record.blueprintHash,
			policyDigest,
			claims: [
				{
					claimId: `claim-${workUnitId.toLowerCase()}`,
					valid: true,
					witnessDigest: fixedHash("8"),
				},
			],
			checks: [
				{
					checkId: record.requiredChecks[0],
					status: "passed",
					digest: workUnitId === "RIGHT" ? fixedHash("c") : fixedHash("b"),
				},
			],
		};
	});
	const joinEvaluations = topology.joins.map((join) => ({
		schema: "graphrefly.stack.join-evaluation.v2",
		oid: join.oid,
		joinDigest: hash(join),
		valid: true,
		witnesses: [],
	}));
	return {
		topology,
		dependencyGraph,
		bindings,
		records,
		unitEvaluations,
		joinEvaluations,
		policyDigest,
		planDigest: fixedHash("5"),
	};
}

test("DAG gate v2 reproduces the stable golden input and result", () => {
	const golden = semanticSuite.cases[0];
	const computed = computeDagGateV2({
		topology: topologyFor(golden.topologyCaseId),
		dependencyGraph: golden.dependencyGraph,
		bindings: golden.bindings,
		records: golden.records,
		unitEvaluations: golden.unitEvaluations,
		joinEvaluations: golden.joinEvaluations,
		policyDigest: golden.gateInput.policyDigest,
		planDigest: golden.gateInput.planDigest,
	});
	assert.deepEqual(computed.gateInput, golden.gateInput);
	assert.deepEqual(computed.gateResult, golden.gateResult);
});

test("DAG gate v2 isolates an invalid branch and is invariant to evidence order", () => {
	const evidence = evidenceFor(topologyFor("binary-clean-join"), { LEFT: [], RIGHT: [] });
	evidence.unitEvaluations.find((entry) => entry.workUnitId === "LEFT").claims[0].valid = false;
	const expected = computeDagGateV2(evidence);
	const reordered = computeDagGateV2({
		...evidence,
		bindings: [...evidence.bindings].reverse(),
		records: [...evidence.records].reverse(),
		unitEvaluations: [...evidence.unitEvaluations].reverse(),
	});
	assert.deepEqual(reordered, expected);
	assert.equal(expected.gateResult.verdict, "blocked");
	assert.deepEqual(expected.gateResult.minimalAffectedCut, ["LEFT"]);
	assert.deepEqual(expected.gateResult.units[0].reasonCodes, ["CLAIM_INVALID"]);
	assert.equal(expected.gateResult.units[1].verdict, "valid");
});

test("DAG gate v2 propagates only through declared semantic dependencies", () => {
	const topology = clone(topologyFor("linear-subset"));
	const first = topology.objects[0];
	const second = {
		...clone(first),
		oid: { algorithm: "sha1", value: "3333333333333333333333333333333333333333" },
		parents: [clone(first.oid)],
		layer: 2,
		workUnitId: "U2",
		blueprintHash: fixedHash("3"),
	};
	topology.objects.push(second);
	topology.head = clone(second.oid);
	const evidence = evidenceFor(topology, { U1: [], U2: ["U1"] });
	evidence.unitEvaluations[0].sourceScope.valid = false;
	const computed = computeDagGateV2(evidence);
	assert.deepEqual(computed.gateResult.units[0].reasonCodes, ["SOURCE_SCOPE_VIOLATION"]);
	assert.deepEqual(computed.gateResult.units[1].reasonCodes, ["DEPENDENCY_INVALID"]);
	assert.deepEqual(computed.gateResult.minimalAffectedCut, ["U1"]);
});

test("DAG gate v2 derives stale-policy, failed-check, stale-Blueprint and join reasons", () => {
	const evidence = evidenceFor(topologyFor("binary-clean-join"), { LEFT: [], RIGHT: [] });
	const left = evidence.unitEvaluations.find((entry) => entry.workUnitId === "LEFT");
	left.policyDigest = fixedHash("a");
	left.blueprintHash = fixedHash("f");
	left.checks[0].status = "failed";
	const join = evidence.joinEvaluations[0];
	join.valid = false;
	join.witnesses = [
		{ kind: "join-parent", join: join.oid, parent: evidence.topology.joins[0].parents[0] },
	];
	const computed = computeDagGateV2(evidence);
	assert.deepEqual(computed.gateResult.units[0].reasonCodes, [
		"BLUEPRINT_WITNESS_STALE",
		"POLICY_REVISION_STALE",
		"REQUIRED_CHECK_FAILED",
	]);
	assert.deepEqual(computed.gateResult.joins[0].reasonCodes, ["JOIN_INVALID"]);
	assert.equal(computed.gateResult.verdict, "blocked");
});

test("DAG gate v2 fails closed for unknown evaluation states and unexplained invalid joins", () => {
	const unknownCheck = evidenceFor(topologyFor("binary-clean-join"), { LEFT: [], RIGHT: [] });
	unknownCheck.unitEvaluations[0].checks[0].status = "unknown";
	assert.throws(() => computeDagGateV2(unknownCheck), /unsupported status/);

	const unexplainedJoin = evidenceFor(topologyFor("binary-clean-join"), { LEFT: [], RIGHT: [] });
	unexplainedJoin.joinEvaluations[0].valid = false;
	assert.throws(() => computeDagGateV2(unexplainedJoin), /validity and witnesses/);
});
