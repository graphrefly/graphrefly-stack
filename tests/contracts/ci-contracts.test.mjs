import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	CI_ARTIFACTS_SCHEMA,
	CI_BUNDLE_SCHEMA,
	CI_GOLDEN_SUITE_SCHEMA,
	CI_INVOCATION_SCHEMA,
	CI_JOB_NAME,
	CI_REDACTION_EXCLUDES,
	CI_RESULT_SCHEMA,
	CI_WORKFLOW_PATH,
	createStrictAjv,
	SEMANTIC_ARTIFACTS_SCHEMA,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const [ciSchema, goldenSchema, semanticSchema, suite, digests] = await Promise.all([
	readJson("contracts/ci/v1/artifacts.schema.json"),
	readJson("contracts/ci/v1/golden-suite.schema.json"),
	readJson("contracts/semantic/v1/artifacts.schema.json"),
	readJson("fixtures/contracts/ci/v1/golden-suite.json"),
	readJson("fixtures/contracts/ci/v1/golden-digests.json"),
]);

const ajv = createStrictAjv();
ajv.addSchema(semanticSchema);
ajv.addSchema(ciSchema);
const validateSuite = ajv.compile(goldenSchema);
const definition = (name) => ajv.getSchema(`${CI_ARTIFACTS_SCHEMA}#/definitions/${name}`);

test("CI v1 contract family compiles and golden bytes are stable", () => {
	assert.equal(ciSchema.$id, CI_ARTIFACTS_SCHEMA);
	assert.equal(goldenSchema.$id, CI_GOLDEN_SUITE_SCHEMA);
	assert.equal(semanticSchema.$id, SEMANTIC_ARTIFACTS_SCHEMA);
	assert.equal(validateSuite(suite), true, JSON.stringify(validateSuite.errors, null, 2));
	assert.equal(definition("CIInvocation")(suite.invocation), true);
	assert.equal(definition("CIResult")(suite.result), true);
	assert.equal(sha256Jcs(suite), digests.suite);
	assert.equal(sha256Jcs(suite.invocation), digests.invocation);
	assert.equal(sha256Jcs(suite.result), digests.result);
	assert.equal(suite.result.invocationDigest.value, digests.invocation);
	assert.equal(suite.result.gateInputDigest.value, suite.result.gateResult.inputDigest.value);
	assert.equal(suite.result.outcome, suite.result.gateResult.verdict);
	assert.equal(
		suite.result.artifactName,
		`graphrefly-stack-ci-${suite.result.portableBundleDigest.value}`,
	);
});

test("CI v1 exports the locked public identifiers and redaction boundary", () => {
	assert.equal(CI_INVOCATION_SCHEMA, "graphrefly.stack.ci-invocation.v1");
	assert.equal(CI_RESULT_SCHEMA, "graphrefly.stack.ci-result.v1");
	assert.equal(CI_BUNDLE_SCHEMA, "graphrefly.stack.ci-bundle.v1");
	assert.equal(CI_JOB_NAME, "GraphReFly Stack / Semantic Gate");
	assert.equal(CI_WORKFLOW_PATH, ".github/workflows/graphrefly-stack.yml");
	assert.deepEqual(CI_REDACTION_EXCLUDES, [
		"source-content",
		"raw-blueprint",
		"check-output",
		"credentials",
		"environment",
		"model-response",
	]);
});

test("CI schemas reject unsupported authority, topology, mutation and upload fields", () => {
	for (const eventName of ["push", "pull_request_target", "merge_group"]) {
		assert.equal(
			definition("CIInvocation")({
				...suite.invocation,
				event: { ...suite.invocation.event, name: eventName },
			}),
			false,
		);
	}
	assert.equal(
		definition("CIInvocation")({ ...suite.invocation, repositoryWriteToken: "secret" }),
		false,
	);
	assert.equal(
		definition("CIResult")({ ...suite.result, sourceArchive: "repository.tar.gz" }),
		false,
	);
	assert.equal(
		definition("CIResult")({
			...suite.result,
			redaction: { excludes: CI_REDACTION_EXCLUDES.slice(1) },
		}),
		false,
	);
});
