import assert from "node:assert/strict";
import test from "node:test";

import {
	assertGroupIntegrationIntegrity,
	GroupIntegrationIntegrityError,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";
import {
	computeGroupIntegrationV1,
	evaluateIntegrationEffects,
} from "../../packages/core/dist/index.js";

const hash = (value) => ({ algorithm: "sha256", value: sha256Jcs(value) });
const oid = (value) => ({ algorithm: "sha1", value: value.repeat(40) });
const clone = structuredClone;

function input() {
	const policyDigest = hash({ policy: "shared" });
	const graph = evaluateIntegrationEffects({
		targetDelta: {
			events: [
				{
					type: "node-changed",
					topologyPath: [],
					before: { id: "session", meta: { owner: "runtime" } },
					after: { id: "session", meta: { owner: "left" } },
				},
			],
		},
		headDelta: {
			events: [
				{
					type: "node-changed",
					topologyPath: [],
					before: { id: "session", meta: { owner: "runtime" } },
					after: { id: "session", meta: { owner: "right" } },
				},
			],
		},
		candidateDelta: {
			events: [
				{
					type: "node-changed",
					topologyPath: [],
					before: { id: "session", meta: { owner: "runtime" } },
					after: { id: "session", meta: { owner: "left" } },
				},
			],
		},
	});
	return {
		schema: "graphrefly.stack.group-integration-input.v1",
		topologyDigest: hash({ topology: "group" }),
		headBlueprintDigest: hash({ blueprint: "head" }),
		repositoryPolicyDigest: policyDigest,
		qualifiedCommitDigests: [
			{ planId: "plan-a", workUnitId: "API", digest: hash({ commit: "a" }) },
			{ planId: "plan-b", workUnitId: "API", digest: hash({ commit: "b" }) },
		],
		plans: [
			{
				planId: "plan-a",
				planDigest: hash({ plan: "a" }),
				policyDigest,
				gateResultDigest: hash({ gate: "a" }),
				verdict: "pass",
			},
			{
				planId: "plan-b",
				planDigest: hash({ plan: "b" }),
				policyDigest,
				gateResultDigest: hash({ gate: "b" }),
				verdict: "pass",
			},
		],
		joins: [
			{
				oid: oid("3"),
				layer: 3,
				joinDigest: hash({ join: "3" }),
				targetDeltaDigest: hash({ delta: "left" }),
				headDeltaDigest: hash({ delta: "right" }),
				candidateDeltaDigest: hash({ delta: "combined" }),
				overlaps: graph.overlaps,
				conflicts: graph.conflicts,
			},
		],
		semanticConflicts: [],
	};
}

test("group integration derives real invalid join witnesses across Plan-qualified branches", () => {
	const source = input();
	const result = computeGroupIntegrationV1(source);
	assert.equal(result.verdict, "blocked");
	assert.deepEqual(result.reasonCodes, ["METADATA_INCOMPATIBLE_CHANGE"]);
	assert.deepEqual(result.joins[0], {
		oid: oid("3"),
		joinDigest: hash({ join: "3" }),
		valid: false,
		reasonCodes: ["METADATA_INCOMPATIBLE_CHANGE"],
		overlaps: [{ kind: "metadata-field", ownerKind: "node", ownerId: "session", field: "owner" }],
		conflicts: [
			{
				reasonCode: "METADATA_INCOMPATIBLE_CHANGE",
				witness: {
					kind: "metadata-field",
					ownerKind: "node",
					ownerId: "session",
					field: "owner",
				},
			},
		],
	});
	assertGroupIntegrationIntegrity(source, result);

	const forged = clone(result);
	forged.joins[0].valid = true;
	assert.throws(
		() => assertGroupIntegrationIntegrity(source, forged),
		(error) =>
			error instanceof GroupIntegrationIntegrityError &&
			error.message === "group integration result is not independently derived",
	);
});

test("group integration preserves per-Plan gate and repository policy failures", () => {
	const source = input();
	source.joins[0].overlaps = [];
	source.joins[0].conflicts = [];
	source.plans[0].verdict = "error";
	source.plans[1].policyDigest = hash({ policy: "stale" });
	const result = computeGroupIntegrationV1(source);
	assert.equal(result.verdict, "error");
	assert.deepEqual(result.reasonCodes, ["POLICY_INVALIDATED", "HEAD_GATE_NOT_PASSING"]);
	assert.equal(result.conflicts.length, 2);
	assertGroupIntegrationIntegrity(source, result);
});

test("group integration rejects noncanonical identity and semantic ownership", () => {
	const reordered = input();
	reordered.plans.reverse();
	const result = computeGroupIntegrationV1(reordered);
	assert.throws(
		() => assertGroupIntegrationIntegrity(reordered, result),
		/not ordered by Plan ID/u,
	);

	const crossPlan = input();
	crossPlan.semanticConflicts = [
		{
			planId: "plan-a",
			workUnitId: "MISSING",
			join: null,
			conflict: {
				reasonCode: "DEPENDENCY_INVALIDATED",
				witness: { kind: "dependency", workUnitId: "MISSING", dependencyId: "API" },
			},
		},
	];
	assert.throws(
		() => assertGroupIntegrationIntegrity(crossPlan, computeGroupIntegrationV1(crossPlan)),
		/semantic conflict is not Plan-qualified/u,
	);

	const foreignDependency = input();
	foreignDependency.qualifiedCommitDigests.push({
		planId: "plan-b",
		workUnitId: "DB",
		digest: hash({ commit: "db" }),
	});
	foreignDependency.semanticConflicts = [
		{
			planId: "plan-a",
			workUnitId: "API",
			join: null,
			conflict: {
				reasonCode: "DEPENDENCY_INVALIDATED",
				witness: { kind: "dependency", workUnitId: "API", dependencyId: "DB" },
			},
		},
	];
	assert.throws(
		() =>
			assertGroupIntegrationIntegrity(
				foreignDependency,
				computeGroupIntegrationV1(foreignDependency),
			),
		/semantic conflict is not Plan-qualified/u,
	);
});
