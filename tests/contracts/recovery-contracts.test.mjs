import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	createStrictAjv,
	RECOVERY_ARTIFACTS_SCHEMA,
	RECOVERY_ATTEMPT_SCHEMA,
	RECOVERY_AUTHORIZATION_SCHEMA,
	RECOVERY_IMPACT_SCHEMA,
	RECOVERY_PLAN_PROPOSAL_SCHEMA,
	RECOVERY_PLAN_SCHEMA,
	RECOVERY_PORTABLE_BUNDLE_SCHEMA,
	RECOVERY_RESULT_SCHEMA,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const [semantic, topology, dagSemantic, mergeGroup, recovery] = await Promise.all([
	readJson("contracts/semantic/v1/artifacts.schema.json"),
	readJson("contracts/dag/v2/artifacts.schema.json"),
	readJson("contracts/dag/v2/semantic.schema.json"),
	readJson("contracts/dag/v2/merge-group.schema.json"),
	readJson("contracts/recovery/v1/artifacts.schema.json"),
]);
const ajv = createStrictAjv();
for (const schema of [semantic, topology, dagSemantic, mergeGroup, recovery]) ajv.addSchema(schema);
const definition = (name) => ajv.getSchema(`${RECOVERY_ARTIFACTS_SCHEMA}#/definitions/${name}`);

const hash = (value) => ({ algorithm: "sha256", value });
const oid = (value) => ({ algorithm: "sha1", value });
const postRecoveryWorkUnit = {
	id: "U1",
	title: "Restore U1",
	intent: "Remove the U1 graph effect",
	dependencies: [],
	allowedSourceScopes: ["src/u1.ts"],
	capabilities: ["graph-change"],
	claims: [
		{
			id: "u1-absent",
			predicate: { operator: "absent", selector: { kind: "node", nodeId: "u1" } },
			rationale: "The reverted node is absent",
		},
	],
	requiredChecks: ["contract"],
};
const proposal = {
	schema: RECOVERY_PLAN_PROPOSAL_SCHEMA,
	recoveryPlanId: "recover-u1",
	postRecoveryPlanId: "recover-u1-post",
	proposalSource: "human",
	selection: "work-units",
	targetWorkUnitIds: ["U1"],
	steps: [
		{
			workUnitId: "U1",
			disposition: "inverse",
			dependsOnSteps: [],
			postRecoveryWorkUnit,
			operation: { kind: "inverse", sourceCommit: oid("2".repeat(40)) },
			externalEffects: [{ effectId: "runtime", status: "not-applicable", evidenceDigest: null }],
		},
	],
};
const authorization = {
	schema: RECOVERY_AUTHORIZATION_SCHEMA,
	recoveryPlanId: "recover-u1",
	planDigest: hash("1".repeat(64)),
	impactDigest: hash("2".repeat(64)),
	policyDigest: hash("3".repeat(64)),
	expectedHead: oid("4".repeat(40)),
	recoveryRef: "refs/heads/grfs/recovery/recover-u1",
	action: "materialize-recovery-branch",
	authorizedBy: { label: "Maintainer", identityVerified: false },
};
const attempt = {
	schema: RECOVERY_ATTEMPT_SCHEMA,
	recoveryPlanId: "recover-u1",
	planDigest: hash("1".repeat(64)),
	authorizationDigest: hash("5".repeat(64)),
	sequence: 0,
	previousAttemptDigest: null,
	status: "branch-created",
	workUnitId: null,
	expectedBefore: oid("4".repeat(40)),
	observedAfter: oid("4".repeat(40)),
	failure: null,
};

test("recovery v1 is a strict additive authority-separated family", () => {
	assert.equal(recovery.$id, RECOVERY_ARTIFACTS_SCHEMA);
	for (const [name, schema] of [
		["RecoveryImpact", RECOVERY_IMPACT_SCHEMA],
		["RecoveryPlanProposal", RECOVERY_PLAN_PROPOSAL_SCHEMA],
		["RecoveryPlan", RECOVERY_PLAN_SCHEMA],
		["RecoveryAuthorization", RECOVERY_AUTHORIZATION_SCHEMA],
		["RecoveryAttempt", RECOVERY_ATTEMPT_SCHEMA],
		["RecoveryResult", RECOVERY_RESULT_SCHEMA],
		["RecoveryPortableBundle", RECOVERY_PORTABLE_BUNDLE_SCHEMA],
	]) {
		assert.ok(definition(name));
		assert.equal(recovery.definitions[name].additionalProperties, false);
		assert.equal(recovery.definitions[name].properties.schema.const, schema);
	}
	assert.equal(definition("RecoveryPlanProposal")(proposal), true);
	assert.equal(definition("RecoveryAuthorization")(authorization), true);
	assert.equal(definition("RecoveryAttempt")(attempt), true);
});

test("recovery proposal, authorization, and attempt golden bytes are stable", () => {
	assert.equal(
		sha256Jcs(proposal),
		"1d741274599b2887dd8202be98efdb965017e05f1624c02f9266e986e6aa0eca",
	);
	assert.equal(
		sha256Jcs(authorization),
		"7acfb24a7abc454063bb6c69cee156a1b00887b4f111c16b007f87e041969abb",
	);
	assert.equal(
		sha256Jcs(attempt),
		"985f20e2b08d2597c9986dd239c9461afeca22df74ef583896ce8ab6b11a4f00",
	);
});

test("recovery contracts reject merge authority, hosted execution, and mutable attempt state", () => {
	assert.equal(definition("RecoveryPlanProposal")({ ...proposal, autoMerge: true }), false);
	assert.equal(
		definition("RecoveryAuthorization")({ ...authorization, identityVerified: true }),
		false,
	);
	assert.equal(
		definition("RecoveryAuthorization")({
			...authorization,
			recoveryRef: "refs/heads/main",
		}),
		false,
	);
	assert.equal(definition("RecoveryAttempt")({ ...attempt, editable: true }), false);
});
