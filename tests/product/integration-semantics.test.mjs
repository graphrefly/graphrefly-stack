import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assembleIntegrationFailureCandidate } from "../../packages/cli/dist/integration-candidate.js";
import {
	assembleIntegrationFailureResult,
	assembleIntegrationResult,
	evaluateIntegrationSemantics,
} from "../../packages/cli/dist/integration-semantics.js";
import { sha256Jcs } from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const suite = JSON.parse(
	await readFile(new URL("fixtures/contracts/integration/v1/golden-suite.json", root), "utf8"),
);
const candidate = suite.cases[0].candidate;
const hash = (value) => ({ algorithm: "sha256", value: value.repeat(64) });
const blueprint = (nodeIds) => ({
	version: "graphrefly.blueprint.v2",
	topology: {
		nodes: nodeIds.map((id) => ({ id, kind: "state", deps: [], meta: {} })),
		edges: [],
		subgraphs: [],
	},
});
const claim = (id, nodeId) => ({
	id,
	predicate: { operator: "present", selector: { kind: "node", nodeId } },
});

test("candidate claim invalidation propagates through accepted dependencies", () => {
	const result = evaluateIntegrationSemantics({
		plan: {
			workUnits: [
				{ id: "U1", dependencies: [], claims: [claim("claim-removed", "removed")] },
				{ id: "U2", dependencies: ["U1"], claims: [claim("claim-session", "session")] },
			],
		},
		candidateBlueprint: blueprint(["session"]),
		acceptedPolicyDigest: hash("a"),
		candidatePolicyDigest: hash("a"),
		headGateInput: {},
		headGateResult: { verdict: "pass" },
	});
	assert.deepEqual(result.reasonCodes, ["CLAIM_INVALIDATED", "DEPENDENCY_INVALIDATED"]);
	assert.deepEqual(result.conflicts, [
		{
			reasonCode: "CLAIM_INVALIDATED",
			witness: { kind: "claim", workUnitId: "U1", claimId: "claim-removed" },
		},
		{
			reasonCode: "DEPENDENCY_INVALIDATED",
			witness: { kind: "dependency", workUnitId: "U2", dependencyId: "U1" },
		},
	]);
});

test("policy and unchanged head GateResult failures remain separate exact witnesses", () => {
	const result = evaluateIntegrationSemantics({
		plan: { workUnits: [] },
		candidateBlueprint: blueprint([]),
		acceptedPolicyDigest: hash("a"),
		candidatePolicyDigest: hash("b"),
		headGateInput: {},
		headGateResult: { verdict: "blocked" },
	});
	assert.deepEqual(result.reasonCodes, ["POLICY_INVALIDATED", "HEAD_GATE_NOT_PASSING"]);
	assert.equal(result.conflicts[0].witness.kind, "diagnostics");
	assert.equal(result.conflicts[1].witness.kind, "policy");
});

test("strict IntegrationResult combines graph and semantic evidence without editing candidate Gate identity", async () => {
	const boundCandidate = structuredClone(candidate);
	const headGateInput = { schema: "test-gate-input" };
	const headGateResult = { schema: "test-gate-result", verdict: "pass" };
	boundCandidate.headGate = {
		inputDigest: { algorithm: "sha256", value: sha256Jcs(headGateInput) },
		resultDigest: { algorithm: "sha256", value: sha256Jcs(headGateResult) },
		verdict: "pass",
	};
	const semantic = evaluateIntegrationSemantics({
		plan: { workUnits: [{ id: "U1", dependencies: [], claims: [claim("present", "session")] }] },
		candidateBlueprint: blueprint(["session"]),
		acceptedPolicyDigest: boundCandidate.accepted.policyDigest,
		candidatePolicyDigest: boundCandidate.accepted.policyDigest,
		headGateInput,
		headGateResult,
	});
	const originalGate = structuredClone(boundCandidate.headGate);
	const compatible = await assembleIntegrationResult({
		candidate: boundCandidate,
		graph: { reasonCodes: [], overlaps: [], conflicts: [] },
		semantic,
	});
	assert.equal(compatible.outcome, "compatible");
	assert.deepEqual(boundCandidate.headGate, originalGate);

	const blocked = await assembleIntegrationResult({
		candidate: boundCandidate,
		graph: {
			reasonCodes: ["NODE_INCOMPATIBLE_CHANGE"],
			overlaps: [{ kind: "node", nodeId: "session", field: "name" }],
			conflicts: [
				{
					reasonCode: "NODE_INCOMPATIBLE_CHANGE",
					witness: { kind: "node", nodeId: "session", field: "name" },
				},
			],
		},
		semantic,
	});
	assert.equal(blocked.outcome, "conflict");
	assert.deepEqual(blocked.reasonCodes, ["NODE_INCOMPATIBLE_CHANGE"]);
	assert.deepEqual(boundCandidate.headGate, originalGate);

	await assert.rejects(
		assembleIntegrationResult({
			candidate: {
				...boundCandidate,
				headGate: { ...boundCandidate.headGate, verdict: "blocked" },
			},
			graph: { reasonCodes: [], overlaps: [], conflicts: [] },
			semantic,
		}),
		/head GateInput or GateResult identity/u,
	);
});

test("typed failure results bind text paths, ancestry diagnostics, and changed observed revisions", async () => {
	const makeCandidate = async (context, reasonCode) =>
		assembleIntegrationFailureCandidate({
			context,
			repository: candidate.repository,
			runtimeVersion: candidate.provider.runtimeVersion,
			planDigest: candidate.accepted.planDigest,
			policyDigest: candidate.accepted.policyDigest,
			headGate: candidate.headGate,
			reasonCode,
		});
	const baseContext = {
		sourceRepository: "/tmp/repository",
		revisions: candidate.revisions,
		topology: { mergeBase: "unique", headRange: "linear" },
		merge: { ...candidate.merge, tree: null },
		conflictPaths: [],
	};
	const textCandidate = await makeCandidate(
		{
			...baseContext,
			merge: { ...baseContext.merge, status: "conflict" },
			conflictPaths: ["graph.mjs"],
		},
		"TEXT_CONFLICT",
	);
	const textResult = await assembleIntegrationFailureResult({
		candidate: textCandidate,
		reasonCode: "TEXT_CONFLICT",
		witnesses: [{ kind: "path", path: "graph.mjs" }],
	});
	assert.equal(textResult.outcome, "conflict");
	assert.equal(textResult.conflicts[0].witness.path, "graph.mjs");

	const ancestryCandidate = await makeCandidate(
		{
			...baseContext,
			revisions: { ...candidate.revisions, mergeBase: null },
			topology: { mergeBase: "ambiguous", headRange: "unavailable" },
			merge: { ...baseContext.merge, status: "unavailable" },
		},
		"ANCESTRY_AMBIGUOUS",
	);
	const ancestryResult = await assembleIntegrationFailureResult({
		candidate: ancestryCandidate,
		reasonCode: "ANCESTRY_AMBIGUOUS",
	});
	assert.equal(ancestryResult.outcome, "error");
	assert.equal(ancestryResult.conflicts[0].witness.code, "ANCESTRY_AMBIGUOUS");

	const movedTarget = {
		...candidate.revisions.target,
		value: candidate.revisions.target.value.replace(/^./u, "f"),
	};
	const driftCandidate = await makeCandidate(baseContext, "TARGET_MOVED");
	const driftResult = await assembleIntegrationFailureResult({
		candidate: driftCandidate,
		reasonCode: "TARGET_MOVED",
		observedRevisions: { target: movedTarget, head: candidate.revisions.head },
	});
	assert.equal(driftResult.outcome, "error");
	assert.notDeepEqual(driftResult.observedRevisions.target, driftCandidate.revisions.target);
	await assert.rejects(
		assembleIntegrationFailureResult({
			candidate: driftCandidate,
			reasonCode: "TARGET_MOVED",
		}),
		/cross-binding or ordering/u,
	);
});
