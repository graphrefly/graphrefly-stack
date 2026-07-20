import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	assertMergeGroupIntegrityV1,
	MergeGroupIntegrityError,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";
import {
	computeDagGateV2,
	computeGroupIntegrationV1,
	computeMergeGroupResultV1,
} from "../../packages/core/dist/index.js";

const root = new URL("../../", import.meta.url);
const clone = structuredClone;
const hash = (value) => ({ algorithm: "sha256", value: sha256Jcs(value) });
const fixedHash = (character) => ({ algorithm: "sha256", value: character.repeat(64) });

async function topology() {
	const suite = JSON.parse(
		await readFile(new URL("fixtures/contracts/dag/v2/golden-suite.json", root), "utf8"),
	);
	return clone(suite.cases.find((entry) => entry.caseId === "linear-subset").topology);
}

function gateBundle(topologyValue, plan, policy) {
	const implementation = topologyValue.objects[0];
	const binding = {
		schema: "graphrefly.stack.work-unit-binding.v2",
		planId: plan.planId,
		workUnitId: "U1",
		commit: implementation.oid,
		parentCommit: implementation.parents[0],
		trailer: { name: "GraphReFly-Work-Unit", value: "U1", occurrences: 1 },
		stablePatchId: "1".repeat(40),
		diffDigest: fixedHash("2"),
		changedPaths: ["src/u1.ts"],
		blueprintHash: implementation.blueprintHash,
		rebindFrom: null,
	};
	const check = { workUnitId: "U1", checkId: "contract", digest: fixedHash("3") };
	const record = {
		schema: "graphrefly.stack.semantic-record.v2",
		recordId: "record-u1",
		planId: plan.planId,
		workUnitId: "U1",
		bindingDigest: hash(binding),
		directDependencyRecordIds: [],
		policyDigest: hash(policy),
		blueprintHash: implementation.blueprintHash,
		sourceScopeDigest: fixedHash("4"),
		claimsDigest: fixedHash("5"),
		checksDigest: hash([check]),
		claimWitnesses: [{ claimId: "claim-u1", predicateDigest: fixedHash("6"), status: "satisfied" }],
		requiredChecks: ["contract"],
		rebindFrom: null,
	};
	const dependencyGraph = {
		schema: "graphrefly.stack.semantic-dependency-graph.v2",
		planId: plan.planId,
		topologyDigest: hash(topologyValue),
		workUnits: [{ workUnitId: "U1", dependencies: [] }],
	};
	const unitEvaluation = {
		schema: "graphrefly.stack.unit-evaluation.v2",
		workUnitId: "U1",
		bindingDigest: hash(binding),
		recordDigest: hash(record),
		sourceScope: { valid: true, witnessDigest: record.sourceScopeDigest },
		blueprintHash: record.blueprintHash,
		policyDigest: hash(policy),
		claims: [{ claimId: "claim-u1", valid: true, witnessDigest: fixedHash("6") }],
		checks: [{ checkId: "contract", status: "passed", digest: fixedHash("3") }],
	};
	const computed = computeDagGateV2({
		topology: topologyValue,
		dependencyGraph,
		bindings: [binding],
		records: [record],
		unitEvaluations: [unitEvaluation],
		joinEvaluations: [],
		policyDigest: hash(policy),
		planDigest: hash(plan),
	});
	return {
		schema: "graphrefly.stack.dag-gate-bundle.v2",
		topology: topologyValue,
		dependencyGraph,
		bindings: [binding],
		records: [record],
		unitEvaluations: [unitEvaluation],
		joinEvaluations: [],
		gateInput: computed.gateInput,
		gateResult: computed.gateResult,
	};
}

async function sources() {
	const topologyValue = await topology();
	const plan = { schema: "test.plan.v1", planId: "plan-dag", workUnits: ["U1"] };
	const policy = { schema: "test.policy.v1", policyId: "repository", revision: 1 };
	const bundle = gateBundle(topologyValue, plan, policy);
	const qualified = {
		schema: "graphrefly.stack.plan-qualified-commit.v1",
		planId: plan.planId,
		workUnitId: "U1",
		commit: topologyValue.head,
		ownership: {
			kind: "native",
			planTrailer: { name: "GraphReFly-Plan", value: plan.planId, occurrences: 1 },
			workUnitTrailer: { name: "GraphReFly-Work-Unit", value: "U1", occurrences: 1 },
		},
	};
	const event = {
		name: "merge_group",
		action: "checks_requested",
		baseRef: "refs/heads/main",
		headRef: "refs/heads/gh-readonly-queue/main/pr-1",
		base: topologyValue.base,
		head: topologyValue.head,
	};
	const repository = { identity: topologyValue.repository, id: "100", ownerId: "200" };
	const invocation = {
		schema: "graphrefly.stack.merge-group-invocation.v1",
		adapter: { provider: "github-actions", version: "v1" },
		repository,
		event,
		workflow: {
			ref: "clfhhc/test-graphrefly/.github/workflows/graphrefly.yml@refs/heads/main",
			sha: topologyValue.base,
		},
		run: { id: "300", attempt: 1, actorId: "400", jobName: "GraphReFly Stack / Semantic Gate" },
		checkout: { ref: event.headRef, sha: topologyValue.head },
		concurrency: {
			identityDigest: hash({
				repositoryId: repository.id,
				event: "merge_group",
				headRef: event.headRef,
				head: event.head,
			}),
			cancelInProgress: false,
		},
		topologyDigest: hash(topologyValue),
		plans: [{ planId: plan.planId, planDigest: hash(plan), policyDigest: hash(policy) }],
		identity: { assurance: "platform-asserted" },
	};
	const groupIntegrationInput = {
		schema: "graphrefly.stack.group-integration-input.v1",
		topologyDigest: hash(topologyValue),
		headBlueprintDigest: topologyValue.objects[0].blueprintHash,
		repositoryPolicyDigest: hash(policy),
		qualifiedCommitDigests: [{ planId: plan.planId, workUnitId: "U1", digest: hash(qualified) }],
		plans: [
			{
				planId: plan.planId,
				planDigest: hash(plan),
				policyDigest: hash(policy),
				gateResultDigest: hash(bundle.gateResult),
				verdict: "pass",
			},
		],
		joins: [],
		semanticConflicts: [],
	};
	return {
		invocation,
		topology: topologyValue,
		qualifiedCommits: [qualified],
		conversions: [],
		plans: [{ planId: plan.planId, plan, policy, gateBundle: bundle }],
		groupIntegrationInput,
		groupIntegrationResult: computeGroupIntegrationV1(groupIntegrationInput),
	};
}

test("merge-group result preserves the exact per-Plan GateResult and verifies independently", async () => {
	const source = await sources();
	const result = computeMergeGroupResultV1(source);
	assert.equal(result.outcome, "pass");
	assert.deepEqual(result.plans[0].gateResult, source.plans[0].gateBundle.gateResult);
	assert.deepEqual(result.failedPlanIds, []);
	assertMergeGroupIntegrityV1(source, result);
});

test("merge-group integrity rejects event, projection, and nested result drift", async () => {
	const source = await sources();
	const result = computeMergeGroupResultV1(source);
	for (const mutate of [
		(value) => {
			value.invocation.event.action = "opened";
		},
		(value) => {
			value.plans[0].gateBundle.topology.objects[0].kind = "transport";
		},
		(_value, aggregate) => {
			aggregate.plans[0].gateResult.reasonCodes = ["JOIN_INVALID"];
		},
	]) {
		const changed = clone(source);
		const aggregate = clone(result);
		mutate(changed, aggregate);
		assert.throws(() => assertMergeGroupIntegrityV1(changed, aggregate), MergeGroupIntegrityError);
	}
});
