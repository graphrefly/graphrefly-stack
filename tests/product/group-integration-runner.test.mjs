import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	assembleGroupIntegration,
	GroupIntegrationRunnerError,
} from "../../packages/cli/dist/group-integration-runner.js";
import { assertGroupIntegrationIntegrity, sha256Jcs } from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const hash = (value) => ({ algorithm: "sha256", value: sha256Jcs(value) });
const clone = structuredClone;

const topologySuite = await readJson("fixtures/contracts/dag/v2/golden-suite.json");
const topology = topologySuite.cases.find((entry) => entry.caseId === "binary-clean-join").topology;
const join = topology.joins[0];
const before = { id: "session", kind: "state", meta: { owner: "platform" } };
const changed = (after) => ({ type: "node-changed", topologyPath: [], before, after });
const delta = (events) => ({ schemaVersion: "v2", events });
const evidence = (from, to, value) => ({ from, to, delta: value, digest: hash(value) });

function fixture() {
	const policy = { policyId: "shared", revision: "1" };
	const plan = (planId, workUnitId, predicate) => ({
		planId,
		policy: { policyId: policy.policyId, revision: policy.revision, digest: hash(policy) },
		workUnits: [
			{
				id: workUnitId,
				dependencies: [],
				claims: [{ id: `${workUnitId.toLowerCase()}-claim`, predicate }],
			},
		],
	});
	const plans = [
		{
			plan: plan("plan-a", "API", {
				operator: "absent",
				selector: { kind: "node", nodeId: "forbidden" },
			}),
			policy,
			gateResult: { verdict: "pass" },
		},
		{
			plan: plan("plan-b", "API", {
				operator: "present",
				selector: { kind: "node", nodeId: "required" },
			}),
			policy,
			gateResult: { verdict: "pass" },
		},
	];
	const qualifiedCommits = plans.map(({ plan }, index) => ({
		schema: "graphrefly.stack.plan-qualified-commit.v1",
		planId: plan.planId,
		workUnitId: "API",
		commit: topology.objects.filter((entry) => entry.kind === "implementation")[index].oid,
		ownership: {
			kind: "native",
			planTrailer: { name: "GraphReFly-Plan", value: plan.planId, occurrences: 1 },
			workUnitTrailer: { name: "GraphReFly-Work-Unit", value: "API", occurrences: 1 },
		},
	}));
	const targetDelta = delta([changed({ ...before, meta: { owner: "left" } })]);
	const headDelta = delta([changed({ ...before, meta: { owner: "right" } })]);
	const candidateDelta = delta([changed({ ...before, meta: { owner: "left" } })]);
	return {
		topology,
		repositoryPolicy: policy,
		qualifiedCommits,
		plans,
		headBlueprint: {
			revision: topology.head,
			blueprint: { topology: { nodes: [], edges: [], subgraphs: [] } },
			blueprintHash: topology.objects.find((entry) => entry.oid.value === topology.head.value)
				.blueprintHash,
		},
		joinEvidence: [
			{
				oid: join.oid,
				target: evidence(join.mergeBase, join.parents[0], targetDelta),
				head: evidence(join.mergeBase, join.parents[1], headDelta),
				candidate: evidence(join.mergeBase, join.oid, candidateDelta),
			},
		],
	};
}

test("group runner derives exact graph and Plan-qualified semantic conflicts", async () => {
	const source = fixture();
	const output = await assembleGroupIntegration(source);
	assert.equal(output.result.verdict, "blocked");
	assert.deepEqual(output.result.reasonCodes, [
		"METADATA_INCOMPATIBLE_CHANGE",
		"CLAIM_INVALIDATED",
	]);
	assert.equal(output.result.joins[0].valid, false);
	assert.deepEqual(
		output.result.conflicts.map((entry) => [
			entry.planId,
			entry.workUnitId,
			entry.conflict.reasonCode,
		]),
		[
			["plan-b", "API", "CLAIM_INVALIDATED"],
			[null, null, "METADATA_INCOMPATIBLE_CHANGE"],
		],
	);
	assertGroupIntegrationIntegrity(output.input, output.result);
});

test("group runner rejects delta tamper and cross-Plan dependencies", async () => {
	const tampered = fixture();
	tampered.joinEvidence[0].candidate.digest.value = "f".repeat(64);
	await assert.rejects(
		assembleGroupIntegration(tampered),
		(error) => error instanceof GroupIntegrationRunnerError && error.code === "GROUP_JOIN_INVALID",
	);

	const crossPlan = fixture();
	crossPlan.plans[0].plan.workUnits[0].dependencies = ["DB"];
	crossPlan.plans[1].plan.workUnits[0].id = "DB";
	crossPlan.qualifiedCommits[1].workUnitId = "DB";
	crossPlan.qualifiedCommits[1].ownership.workUnitTrailer.value = "DB";
	await assert.rejects(
		assembleGroupIntegration(crossPlan),
		(error) =>
			error instanceof GroupIntegrationRunnerError &&
			error.code === "CROSS_PLAN_DEPENDENCY_UNSUPPORTED",
	);
});

test("group runner output changes when exact final Blueprint claim evidence changes", async () => {
	const source = fixture();
	const blocked = await assembleGroupIntegration(source);
	const recovered = clone(source);
	recovered.headBlueprint.blueprint.topology.nodes.push({ id: "required" });
	const passClaims = await assembleGroupIntegration(recovered);
	assert.notEqual(
		blocked.input.semanticConflicts.length,
		passClaims.input.semanticConflicts.length,
	);
	assert.notEqual(sha256Jcs(blocked.input), sha256Jcs(passClaims.input));
	assert.equal(passClaims.result.reasonCodes.includes("CLAIM_INVALIDATED"), false);
});
