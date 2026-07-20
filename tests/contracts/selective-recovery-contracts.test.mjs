import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	createStrictAjv,
	DAG_SELECTIVE_RECOVERY_ARTIFACTS_SCHEMA,
	DAG_SELECTIVE_RECOVERY_BUNDLE_SCHEMA,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const [semantic, topology, dagSemantic, mergeGroup, recovery] = await Promise.all([
	readJson("contracts/semantic/v1/artifacts.schema.json"),
	readJson("contracts/dag/v2/artifacts.schema.json"),
	readJson("contracts/dag/v2/semantic.schema.json"),
	readJson("contracts/dag/v2/merge-group.schema.json"),
	readJson("contracts/dag/v2/selective-recovery.schema.json"),
]);

const ajv = createStrictAjv();
for (const schema of [semantic, topology, dagSemantic, mergeGroup, recovery]) ajv.addSchema(schema);
const definition = ajv.getSchema(
	`${DAG_SELECTIVE_RECOVERY_ARTIFACTS_SCHEMA}#/definitions/DagSelectiveRecoveryBundle`,
);

test("selective recovery is a strict additive sidecar without DAG v2 schema changes", () => {
	assert.equal(recovery.$id, DAG_SELECTIVE_RECOVERY_ARTIFACTS_SCHEMA);
	assert.equal(
		DAG_SELECTIVE_RECOVERY_BUNDLE_SCHEMA,
		"graphrefly.stack.dag-selective-recovery-bundle.v1",
	);
	assert.ok(definition);
	assert.equal(recovery.definitions.DagSelectiveRecoveryBundle.additionalProperties, false);
	assert.deepEqual(recovery.definitions.DagSelectiveRecoveryBundle.required, [
		"schema",
		"sourceBundle",
		"sourceBundleDigest",
		"sourcePlan",
		"selectiveReplan",
		"replacementPlan",
		"policy",
		"sharedTopology",
		"qualifiedCommits",
		"effectiveTopology",
		"replacementBundle",
		"lineage",
	]);
	assert.equal(recovery.definitions.RecoveryLineage.additionalProperties, false);
	assert.equal(
		recovery.definitions.DagSelectiveRecoveryBundle.properties.replacementBundle.$ref,
		"urn:graphrefly-stack:schema:dag-semantic-artifacts:v2#/definitions/DagGateBundle",
	);
});

test("selective recovery schema rejects missing evidence and authority widening", () => {
	assert.equal(definition({ schema: DAG_SELECTIVE_RECOVERY_BUNDLE_SCHEMA }), false);
	const fake = Object.fromEntries(
		recovery.definitions.DagSelectiveRecoveryBundle.required.map((key) => [key, {}]),
	);
	fake.schema = DAG_SELECTIVE_RECOVERY_BUNDLE_SCHEMA;
	fake.mergeAuthority = true;
	assert.equal(definition(fake), false);
});
