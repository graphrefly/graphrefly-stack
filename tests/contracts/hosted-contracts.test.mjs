import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	createStrictAjv,
	HOSTED_ARTIFACTS_SCHEMA,
	HOSTED_AUDIT_EVENT_SCHEMA,
	HOSTED_BACKUP_PURGE_DAYS,
	HOSTED_DAILY_UPLOAD_LIMIT,
	HOSTED_DECISION_SCHEMA,
	HOSTED_ENVELOPE_RETENTION_DAYS,
	HOSTED_ENVELOPE_SCHEMA,
	HOSTED_GATE_SUMMARY_SCHEMA,
	HOSTED_GOLDEN_SUITE_SCHEMA,
	HOSTED_INDEX_RETENTION_DAYS,
	HOSTED_MAX_ENVELOPE_BYTES,
	HOSTED_OIDC_AUDIENCE,
	HOSTED_OIDC_CLAIMS_SCHEMA,
	HOSTED_OIDC_ISSUER,
	HOSTED_PRIMARY_PURGE_HOURS,
	HOSTED_REDACTION_EXCLUDES,
	HOSTED_REDACTION_PROFILES,
	HOSTED_SYNC_WORKFLOW_PATH,
	HOSTED_TENANT_STORAGE_LIMIT_BYTES,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const [
	hostedSchema,
	goldenSchema,
	semanticSchema,
	ciSchema,
	repositoryConfigSchema,
	reviewSchema,
	reviewDecisionSchema,
	reviewBundleSchema,
	suite,
	digests,
] = await Promise.all([
	readJson("contracts/hosted/v1/artifacts.schema.json"),
	readJson("contracts/hosted/v1/golden-suite.schema.json"),
	readJson("contracts/semantic/v1/artifacts.schema.json"),
	readJson("contracts/ci/v1/artifacts.schema.json"),
	readJson("contracts/repository/v1/repository-config.schema.json"),
	readJson("contracts/repository/v1/review.schema.json"),
	readJson("contracts/repository/v1/review-decision.schema.json"),
	readJson("contracts/repository/v1/review-bundle.schema.json"),
	readJson("fixtures/contracts/hosted/v1/golden-suite.json"),
	readJson("fixtures/contracts/hosted/v1/golden-digests.json"),
]);

const ajv = createStrictAjv();
ajv.addSchema(semanticSchema);
ajv.addSchema(ciSchema);
ajv.addSchema(repositoryConfigSchema);
ajv.addSchema(reviewSchema);
ajv.addSchema(reviewDecisionSchema);
ajv.addSchema(reviewBundleSchema);
ajv.addSchema(hostedSchema);
const validateSuite = ajv.compile(goldenSchema);
const definition = (name) => ajv.getSchema(`${HOSTED_ARTIFACTS_SCHEMA}#/definitions/${name}`);

test("hosted v1 contract family compiles and golden bytes are stable", () => {
	assert.equal(hostedSchema.$id, HOSTED_ARTIFACTS_SCHEMA);
	assert.equal(goldenSchema.$id, HOSTED_GOLDEN_SUITE_SCHEMA);
	assert.equal(validateSuite(suite), true, JSON.stringify(validateSuite.errors, null, 2));
	assert.equal(definition("HostedEnvelope")(suite.envelope), true);
	assert.equal(definition("HostedDecision")(suite.decision), true);
	assert.equal(definition("AuditEvent")(suite.auditEvent), true);
	assert.equal(sha256Jcs(suite), digests.suite);
	assert.equal(sha256Jcs(suite.envelope), digests.envelope);
	assert.equal(sha256Jcs(suite.envelope.payload), digests.payload);
	assert.equal(suite.envelope.redaction.includes[0].digest.value, digests.payload);
	assert.equal(suite.decision.envelopeDigest.value, digests.envelope);
	assert.equal(sha256Jcs(suite.decision), digests.decision);
	assert.equal(sha256Jcs(suite.auditEvent), digests.auditEvent);
});

test("hosted v1 exports the approved identities, profiles and bounds", () => {
	assert.equal(HOSTED_ENVELOPE_SCHEMA, "graphrefly.stack.hosted-envelope.v1");
	assert.equal(HOSTED_GATE_SUMMARY_SCHEMA, "graphrefly.stack.hosted-gate-summary.v1");
	assert.equal(HOSTED_DECISION_SCHEMA, "graphrefly.stack.hosted-decision.v1");
	assert.equal(HOSTED_AUDIT_EVENT_SCHEMA, "graphrefly.stack.hosted-audit-event.v1");
	assert.equal(HOSTED_OIDC_CLAIMS_SCHEMA, "graphrefly.stack.github-oidc-claims.v1");
	assert.equal(HOSTED_OIDC_ISSUER, "https://token.actions.githubusercontent.com");
	assert.equal(HOSTED_OIDC_AUDIENCE, "graphrefly-stack-hosted");
	assert.equal(HOSTED_SYNC_WORKFLOW_PATH, ".github/workflows/graphrefly-stack-hosted.yml");
	assert.deepEqual(HOSTED_REDACTION_PROFILES, [
		"gate-summary-v1",
		"semantic-review-v1",
		"local-review-decisions-v1",
	]);
	assert.deepEqual(HOSTED_REDACTION_EXCLUDES, [
		"source-content",
		"raw-blueprint",
		"check-output",
		"credentials",
		"environment",
		"model-response",
	]);
	assert.equal(HOSTED_MAX_ENVELOPE_BYTES, 2 * 1024 * 1024);
	assert.equal(HOSTED_DAILY_UPLOAD_LIMIT, 100);
	assert.equal(HOSTED_TENANT_STORAGE_LIMIT_BYTES, 1024 * 1024 * 1024);
	assert.equal(HOSTED_ENVELOPE_RETENTION_DAYS, 90);
	assert.equal(HOSTED_INDEX_RETENTION_DAYS, 365);
	assert.equal(HOSTED_PRIMARY_PURGE_HOURS, 24);
	assert.equal(HOSTED_BACKUP_PURGE_DAYS, 30);
});

test("hosted schemas reject identity, profile, redaction and authority widening", () => {
	const validateEnvelope = definition("HostedEnvelope");
	const reject = (value) => assert.equal(validateEnvelope(value), false);

	reject({ ...suite.envelope, sourceArchive: "repository.tar.gz" });
	reject({
		...suite.envelope,
		uploadIdentity: { ...suite.envelope.uploadIdentity, audience: "attacker" },
	});
	reject({
		...suite.envelope,
		repository: { ...suite.envelope.repository, provider: "gitlab" },
	});
	reject({
		...suite.envelope,
		profile: "semantic-review-v1",
		redaction: { ...suite.envelope.redaction, explicitOptIn: false },
	});
	reject({
		...suite.envelope,
		redaction: {
			...suite.envelope.redaction,
			excludes: HOSTED_REDACTION_EXCLUDES.slice(1),
		},
	});
	reject({
		...suite.envelope,
		payload: { ...suite.envelope.payload, outcome: "success" },
	});
	assert.equal(definition("HostedDecision")({ ...suite.decision, identityVerified: false }), false);
	assert.equal(
		definition("HostedDecision")({ ...suite.decision, gateResult: { verdict: "pass" } }),
		false,
	);
});

test("local review upload keeps authenticated uploader separate from unverified local authorship", () => {
	const baseOid = "1".repeat(40);
	const headOid = "2".repeat(40);
	const record = {
		schema: "graphrefly.stack.repository-review-decision.v1",
		id: "20000000-0000-4000-8000-000000000001",
		target: {
			baseOid,
			headOid,
			parentOid: baseOid,
			commitOid: headOid,
			blueprintHash: "3".repeat(64),
		},
		decision: "approve",
		reviewerLabel: "Local reviewer",
		summary: "Local evidence only.",
		recordedAt: "2026-07-18T20:00:00.000Z",
		identityVerified: false,
	};
	const bundle = {
		schema: "graphrefly.stack.repository-review-bundle.v1",
		repository: { label: "example", baseOid, headOid },
		artifacts: [
			{
				path: `reviews/${record.id}.json`,
				hash: { algorithm: "sha256", value: sha256Jcs(record) },
				record,
			},
		],
	};
	const payload = { schema: "graphrefly.stack.hosted-local-review.v1", bundle };
	const envelope = {
		...suite.envelope,
		profile: "local-review-decisions-v1",
		source: {
			kind: "review-bundle",
			sourceBundleDigest: { algorithm: "sha256", value: sha256Jcs(bundle) },
			base: { algorithm: "sha1", value: baseOid },
			head: { algorithm: "sha1", value: headOid },
		},
		uploadIdentity: {
			schema: "graphrefly.stack.github-user-upload.v1",
			provider: "github",
			providerUserId: "24680",
			actorId: "10000000-0000-4000-8000-000000000004",
			identityVerified: true,
		},
		redaction: {
			explicitOptIn: true,
			includes: [
				{
					path: "review/decisions.json",
					digest: { algorithm: "sha256", value: sha256Jcs(payload) },
				},
			],
			excludes: [...HOSTED_REDACTION_EXCLUDES],
		},
		payload,
	};
	assert.equal(definition("HostedEnvelope")(envelope), true);
	assert.equal(envelope.payload.bundle.artifacts[0].record.identityVerified, false);
	assert.equal(envelope.uploadIdentity.identityVerified, true);
});
