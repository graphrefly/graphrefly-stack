import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertDagTopologyIntegrity, sha256Jcs } from "../../packages/contracts/dist/index.js";
import {
	MultiPlanProjectionError,
	projectMultiPlanTopologyV1,
} from "../../packages/core/dist/index.js";

const root = new URL("../../", import.meta.url);
const suite = JSON.parse(
	await readFile(new URL("fixtures/contracts/dag/v2/golden-suite.json", root), "utf8"),
);
const topology = suite.cases.find((entry) => entry.caseId === "binary-clean-join").topology;
const implementations = topology.objects.filter((entry) => entry.kind === "implementation");
const qualified = (entry, planId) => ({
	schema: "graphrefly.stack.plan-qualified-commit.v1",
	planId,
	workUnitId: entry.workUnitId,
	commit: entry.oid,
	ownership: {
		kind: "native",
		planTrailer: { name: "GraphReFly-Plan", value: planId, occurrences: 1 },
		workUnitTrailer: {
			name: "GraphReFly-Work-Unit",
			value: entry.workUnitId,
			occurrences: 1,
		},
	},
});

test("per-Plan topology projection retains exact shared Git and Blueprint context", () => {
	const ownership = [
		qualified(implementations[0], "plan-a"),
		qualified(implementations[1], "plan-b"),
	];
	const planA = projectMultiPlanTopologyV1({
		topology,
		qualifiedCommits: ownership,
		planId: "plan-a",
	});
	const planB = projectMultiPlanTopologyV1({
		topology,
		qualifiedCommits: ownership,
		planId: "plan-b",
	});
	assertDagTopologyIntegrity(planA);
	assertDagTopologyIntegrity(planB);
	assert.deepEqual(
		planA.objects.map((entry) => [entry.oid, entry.parents, entry.layer, entry.blueprintHash]),
		topology.objects.map((entry) => [entry.oid, entry.parents, entry.layer, entry.blueprintHash]),
	);
	assert.deepEqual(planA.joins, topology.joins);
	assert.deepEqual(planB.joins, topology.joins);
	assert.deepEqual(
		planA.objects
			.filter((entry) => entry.kind === "implementation")
			.map((entry) => entry.workUnitId),
		[implementations[0].workUnitId],
	);
	assert.deepEqual(
		planB.objects
			.filter((entry) => entry.kind === "implementation")
			.map((entry) => entry.workUnitId),
		[implementations[1].workUnitId],
	);
	assert.notEqual(sha256Jcs(planA), sha256Jcs(planB));
});

test("per-Plan projection fails closed on missing, duplicate or false ownership", () => {
	const ownership = [
		qualified(implementations[0], "plan-a"),
		qualified(implementations[1], "plan-b"),
	];
	assert.throws(
		() =>
			projectMultiPlanTopologyV1({
				topology,
				qualifiedCommits: ownership.slice(0, 1),
				planId: "plan-a",
			}),
		/implementation object has no explicit Plan owner/u,
	);
	assert.throws(
		() => {
			const duplicate = structuredClone(ownership[0]);
			duplicate.planId = "plan-c";
			duplicate.ownership.planTrailer.value = "plan-c";
			return projectMultiPlanTopologyV1({
				topology,
				qualifiedCommits: [...ownership, duplicate],
				planId: "plan-a",
			});
		},
		(error) =>
			error instanceof MultiPlanProjectionError &&
			error.message === "one Git commit has multiple Plan owners",
	);
	const forged = structuredClone(ownership);
	forged[0].workUnitId = "FORGED";
	forged[0].ownership.workUnitTrailer.value = "FORGED";
	assert.throws(
		() => projectMultiPlanTopologyV1({ topology, qualifiedCommits: forged, planId: "plan-a" }),
		/does not match one implementation/u,
	);
});
