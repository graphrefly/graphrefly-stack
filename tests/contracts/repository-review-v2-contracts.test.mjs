import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
	assertRepositoryReviewBundleV2Integrity,
	createStrictAjv,
	REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA,
	REPOSITORY_REVIEW_DECISION_REQUEST_V2_SCHEMA,
	REPOSITORY_REVIEW_DECISION_V2_SCHEMA,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = resolve(import.meta.dirname, "../..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));

const baseOid = "1".repeat(40);
const headOid = "2".repeat(40);
const reviewTargetDigest = { algorithm: "sha256", value: "3".repeat(64) };
const decision = {
	schema: "graphrefly.stack.repository-review-decision.v2",
	id: "018f47a2-4a4b-4c6e-8ea1-9c5e39df1234",
	target: { baseOid, headOid, reviewTargetDigest },
	contextCommitOid: headOid,
	decision: "request-changes",
	reviewerLabel: "Repository reviewer",
	summary: "Keep the correction inside the accepted reach.",
	recordedAt: "2026-07-21T12:34:56.789Z",
	identityVerified: false,
};

test("repository review v2 contracts are strict, additive, and byte-stable", async () => {
	const schemas = await Promise.all([
		readJson("contracts/repository/v1/repository-config.schema.json"),
		readJson("contracts/repository/v1/review.schema.json"),
		readJson("contracts/repository/v2/review-decision-request.schema.json"),
		readJson("contracts/repository/v2/review-decision.schema.json"),
		readJson("contracts/repository/v2/review-bundle.schema.json"),
		readJson("contracts/semantic/v1/artifacts.schema.json"),
	]);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	const validateRequest = ajv.getSchema(
		"urn:graphrefly-stack:schema:repository-review-decision-request:v2",
	);
	const validateDecision = ajv.getSchema(
		"urn:graphrefly-stack:schema:repository-review-decision:v2",
	);
	const validateBundle = ajv.getSchema("urn:graphrefly-stack:schema:repository-review-bundle:v2");
	assert.ok(validateRequest);
	assert.ok(validateDecision);
	assert.ok(validateBundle);
	assert.equal(
		REPOSITORY_REVIEW_DECISION_REQUEST_V2_SCHEMA,
		"graphrefly.stack.repository-review-decision-request.v2",
	);
	assert.equal(REPOSITORY_REVIEW_DECISION_V2_SCHEMA, decision.schema);
	assert.equal(REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA, "graphrefly.stack.repository-review-bundle.v2");
	assert.equal(
		validateRequest({
			schema: REPOSITORY_REVIEW_DECISION_REQUEST_V2_SCHEMA,
			decision: "request-changes",
			reviewerLabel: "Repository reviewer",
			summary: "Keep the correction inside the accepted reach.",
			contextCommitOid: headOid,
		}),
		true,
	);
	assert.equal(validateDecision(decision), true, JSON.stringify(validateDecision.errors));
	const decisionDigest = sha256Jcs(decision);
	const bundle = {
		schema: REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA,
		repository: { label: "example", baseOid, headOid },
		reviewTargetDigest,
		artifacts: [
			{
				path: `reviews/${decision.id}.json`,
				hash: { algorithm: "sha256", value: decisionDigest },
				record: decision,
			},
		],
	};
	assert.equal(validateBundle(bundle), true, JSON.stringify(validateBundle.errors));
	assert.doesNotThrow(() => assertRepositoryReviewBundleV2Integrity(bundle));
	assert.equal(decisionDigest, "c79a2a0040d946b0b07eee1162f5084ea0738004890a74efd65b3baacf0f0f21");
	assert.equal(
		sha256Jcs(bundle),
		"09a515f26aa6cb517389355965ebfb26a56a47360bcb270858ba3afc475beb2c",
	);

	const widened = { ...decision, mergeAuthority: true };
	assert.equal(validateDecision(widened), false);
	const forgedHash = structuredClone(bundle);
	forgedHash.artifacts[0].hash.value = "0".repeat(64);
	assert.throws(() => assertRepositoryReviewBundleV2Integrity(forgedHash), /hash does not match/u);
	const staleTarget = structuredClone(bundle);
	staleTarget.artifacts[0].record.target.headOid = "4".repeat(40);
	staleTarget.artifacts[0].hash.value = sha256Jcs(staleTarget.artifacts[0].record);
	assert.throws(() => assertRepositoryReviewBundleV2Integrity(staleTarget), /Git target/u);
	const duplicate = structuredClone(bundle);
	duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
	assert.equal(validateBundle(duplicate), false);
	assert.throws(() => assertRepositoryReviewBundleV2Integrity(duplicate), /duplicated/u);
});
