import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	assertIntegrationIntegrity,
	createStrictAjv,
	INTEGRATION_ARTIFACTS_SCHEMA,
	INTEGRATION_CANDIDATE_SCHEMA,
	INTEGRATION_CONFLICT_REASONS,
	INTEGRATION_GOLDEN_SUITE_SCHEMA,
	IntegrationIntegrityError,
	INTEGRATION_REASON_ORDER,
	INTEGRATION_RESULT_SCHEMA,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const [artifactsSchema, goldenSchema, suite, digests] = await Promise.all([
	readJson("contracts/integration/v1/artifacts.schema.json"),
	readJson("contracts/integration/v1/golden-suite.schema.json"),
	readJson("fixtures/contracts/integration/v1/golden-suite.json"),
	readJson("fixtures/contracts/integration/v1/golden-digests.json"),
]);

const ajv = createStrictAjv();
ajv.addSchema(artifactsSchema);
const validateSuite = ajv.compile(goldenSchema);
const definition = (name) => ajv.getSchema(`${INTEGRATION_ARTIFACTS_SCHEMA}#/definitions/${name}`);

test("integration v1 compiles and locks byte-stable compatible, overlap, and conflict cases", () => {
	assert.equal(artifactsSchema.$id, INTEGRATION_ARTIFACTS_SCHEMA);
	assert.equal(goldenSchema.$id, INTEGRATION_GOLDEN_SUITE_SCHEMA);
	assert.equal(validateSuite(suite), true, JSON.stringify(validateSuite.errors, null, 2));
	assert.equal(sha256Jcs(suite), digests.suite);
	for (const entry of suite.cases) {
		assert.equal(definition("IntegrationCandidate")(entry.candidate), true);
		assert.equal(definition("IntegrationResult")(entry.result), true);
		assert.equal(sha256Jcs(entry.candidate), digests.cases[entry.caseId].candidate);
		assert.equal(sha256Jcs(entry.result), digests.cases[entry.caseId].result);
		assertIntegrationIntegrity(entry.candidate, entry.result);
	}
	assert.equal(suite.cases[1].result.outcome, "compatible");
	assert.deepEqual(suite.cases[1].result.overlaps, [
		{ kind: "node", nodeId: "session", field: "metadata.owner" },
	]);
});

test("integration v1 exports separate candidate and result identities with fixed reason order", () => {
	assert.equal(INTEGRATION_CANDIDATE_SCHEMA, "graphrefly.stack.integration-candidate.v1");
	assert.equal(INTEGRATION_RESULT_SCHEMA, "graphrefly.stack.integration-result.v1");
	assert.deepEqual(INTEGRATION_REASON_ORDER, [
		"ANCESTRY_AMBIGUOUS",
		"HEAD_RANGE_NON_LINEAR",
		"TARGET_MOVED",
		"HEAD_MOVED",
		"TEXT_CONFLICT",
		"CANDIDATE_EVALUATION_FAILED",
		"CANDIDATE_BLUEPRINT_INVALID",
		"NODE_DELETE_CHANGE",
		"NODE_INCOMPATIBLE_CHANGE",
		"EDGE_INCOMPATIBLE_CHANGE",
		"SUBGRAPH_INCOMPATIBLE_CHANGE",
		"METADATA_INCOMPATIBLE_CHANGE",
		"CLAIM_INVALIDATED",
		"DEPENDENCY_INVALIDATED",
		"POLICY_INVALIDATED",
		"HEAD_GATE_NOT_PASSING",
		"ARTIFACT_TAMPERED",
	]);
	assert.ok(INTEGRATION_CONFLICT_REASONS.includes("NODE_INCOMPATIBLE_CHANGE"));
});

test("integration v1 rejects authority widening and unsupported preventive coordination", () => {
	const candidate = suite.cases[0].candidate;
	const result = suite.cases[0].result;
	assert.equal(definition("IntegrationCandidate")({ ...candidate, reservation: "session" }), false);
	assert.equal(definition("IntegrationCandidate")({ ...candidate, mergeAuthority: true }), false);
	assert.equal(definition("IntegrationResult")({ ...result, autoMerge: true }), false);
	assert.equal(
		definition("IntegrationCandidate")({
			...candidate,
			revisions: {
				...candidate.revisions,
				head: { algorithm: "sha256", value: "3".repeat(40) },
			},
		}),
		false,
	);
	assert.equal(
		definition("IntegrationResult")({
			...result,
			overlaps: [{ kind: "actor-lease", actorId: "agent-1" }],
		}),
		false,
	);
});

test("integration integrity fails closed for tamper, drift, ordering, and overlap-only blocking", () => {
	const compatible = suite.cases[1];
	const conflict = suite.cases[2];
	assert.throws(
		() =>
			assertIntegrationIntegrity(
				{
					...compatible.candidate,
					evidence: {
						...compatible.candidate.evidence,
						headDelta: {
							...compatible.candidate.evidence.headDelta,
							to: compatible.candidate.revisions.target,
						},
					},
				},
				compatible.result,
			),
		IntegrationIntegrityError,
	);
	assert.throws(
		() =>
			assertIntegrationIntegrity(compatible.candidate, {
				...compatible.result,
				candidateDigest: { ...compatible.result.candidateDigest, value: "0".repeat(64) },
			}),
		IntegrationIntegrityError,
	);
	assert.throws(
		() =>
			assertIntegrationIntegrity(compatible.candidate, {
				...compatible.result,
				outcome: "conflict",
			}),
		IntegrationIntegrityError,
	);
	assert.throws(
		() =>
			assertIntegrationIntegrity(conflict.candidate, {
				...conflict.result,
				reasonCodes: ["POLICY_INVALIDATED", "NODE_INCOMPATIBLE_CHANGE"],
			}),
		IntegrationIntegrityError,
	);
	assert.throws(
		() =>
			assertIntegrationIntegrity(compatible.candidate, {
				...compatible.result,
				observedRevisions: {
					...compatible.result.observedRevisions,
					target: { algorithm: "sha1", value: "f".repeat(40) },
				},
			}),
		IntegrationIntegrityError,
	);
});
