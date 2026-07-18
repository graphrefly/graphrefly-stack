import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { createHostedEnvelope } from "../../packages/cli/dist/hosted-runner.js";
import {
	canonicalize,
	HOSTED_OIDC_AUDIENCE,
	HOSTED_OIDC_ISSUER,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";
import {
	createHostedIngestHandler,
	GitHubOidcVerifier,
	HostedControlPlane,
	HostedControlPlaneError,
	InMemoryHostedPersistence,
	StaticJwksProvider,
} from "../../packages/hosted/dist/index.js";

const ciBundle = JSON.parse(
	await readFile(
		new URL("../../fixtures/contracts/hosted/v1/ci-bundle.json", import.meta.url),
		"utf8",
	),
);
const now = new Date("2026-07-18T18:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const baseClaims = {
	iss: HOSTED_OIDC_ISSUER,
	aud: HOSTED_OIDC_AUDIENCE,
	sub: "repo:clfhhc/test-graphrefly:ref:refs/heads/main",
	repository_id: ciBundle.invocation.repository.id,
	repository_owner_id: ciBundle.invocation.repository.ownerId,
	workflow_ref:
		"clfhhc/test-graphrefly/.github/workflows/graphrefly-stack-hosted.yml@refs/heads/main",
	workflow_sha: "4".repeat(40),
	run_id: "29654453077",
	run_attempt: "1",
	actor_id: ciBundle.invocation.run.actorId,
	event_name: "workflow_run",
	iat: nowSeconds - 30,
	nbf: nowSeconds - 30,
	exp: nowSeconds + 300,
};

function jwt(payload = baseClaims, key = privateKey) {
	const encodedHeader = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid: "github-test-key" }),
	).toString("base64url");
	const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url")}`;
}

function verifier() {
	return new GitHubOidcVerifier({
		jwks: new StaticJwksProvider([["github-test-key", { ...publicJwk, use: "sig" }]]),
		now: () => now,
	});
}

function authorizer(options = {}) {
	return {
		calls: [],
		async authorizeUpload(input) {
			this.calls.push(input);
			if (options.deny) return null;
			assert.notEqual(
				input.identity.claims.runId,
				input.source.runId,
				"the hosted workflow run and source semantic-gate run are distinct identities",
			);
			assert.equal(input.source.runId, ciBundle.invocation.run.id);
			assert.deepEqual(input.source.head, ciBundle.invocation.event.head);
			return {
				tenantId: "018f0000-0000-7000-8000-000000000001",
				repositoryId: "018f0000-0000-7000-8000-000000000002",
				provider: "github",
				providerRepositoryId: input.repository.repositoryId,
				providerOwnerId: input.repository.ownerId,
				semanticReviewEnabled: options.semanticReviewEnabled ?? false,
			};
		},
	};
}

async function gateSummaryEnvelope(claims = baseClaims) {
	return createHostedEnvelope({
		ciBundle: structuredClone(ciBundle),
		profile: "gate-summary-v1",
		syncIdentity: claims,
	});
}

test("the control plane verifies RS256 OIDC, provider source-run authorization and scoped idempotency", async () => {
	const persistence = new InMemoryHostedPersistence();
	const provider = authorizer();
	const controlPlane = new HostedControlPlane({
		oidc: verifier(),
		authorizer: provider,
		persistence,
		now: () => now,
	});
	const envelope = await gateSummaryEnvelope();
	const body = canonicalize(envelope);
	const digest = sha256Jcs(envelope);
	const created = await controlPlane.ingest({
		bearerToken: jwt(),
		body,
		claimedDigest: digest,
	});
	assert.equal(created.status, 201);
	assert.equal(created.receipt.digest, digest);
	assert.equal(provider.calls.length, 1);
	assert.equal(persistence.records().length, 1);
	const record = persistence.records()[0];
	assert.equal(record.gateVerdict, ciBundle.result.gateResult.verdict);
	assert.equal(record.sourceRunId, ciBundle.invocation.run.id);
	assert.deepEqual(Buffer.from(persistence.object(record.objectKey)), Buffer.from(body));

	const duplicate = await controlPlane.ingest({
		bearerToken: jwt(),
		body,
		claimedDigest: digest,
	});
	assert.equal(duplicate.status, 409);
	assert.deepEqual(duplicate.receipt, created.receipt);
	assert.equal(persistence.records().length, 1);
});

test("the control plane rejects invalid signature, expiry, claim binding and unavailable authorization", async () => {
	const { privateKey: attackerKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const envelope = await gateSummaryEnvelope();
	const body = canonicalize(envelope);
	const digest = sha256Jcs(envelope);
	const cases = [
		{
			code: "HOSTED_OIDC_SIGNATURE_INVALID",
			controlPlane: new HostedControlPlane({
				oidc: verifier(),
				authorizer: authorizer(),
				persistence: new InMemoryHostedPersistence(),
			}),
			token: jwt(baseClaims, attackerKey),
			status: 401,
		},
		{
			code: "HOSTED_OIDC_TIME_INVALID",
			controlPlane: new HostedControlPlane({
				oidc: verifier(),
				authorizer: authorizer(),
				persistence: new InMemoryHostedPersistence(),
			}),
			token: jwt({ ...baseClaims, iat: nowSeconds - 900, exp: nowSeconds - 600 }),
			status: 401,
		},
		{
			code: "HOSTED_IDENTITY_BINDING_INVALID",
			controlPlane: new HostedControlPlane({
				oidc: verifier(),
				authorizer: authorizer(),
				persistence: new InMemoryHostedPersistence(),
			}),
			token: jwt({ ...baseClaims, actor_id: "999999" }),
			status: 401,
		},
		{
			code: "HOSTED_REPOSITORY_UNAUTHORIZED",
			controlPlane: new HostedControlPlane({
				oidc: verifier(),
				authorizer: authorizer({ deny: true }),
				persistence: new InMemoryHostedPersistence(),
			}),
			token: jwt(),
			status: 403,
		},
	];
	for (const scenario of cases) {
		await assert.rejects(
			scenario.controlPlane.ingest({ bearerToken: scenario.token, body, claimedDigest: digest }),
			(error) =>
				error instanceof HostedControlPlaneError &&
				error.status === scenario.status &&
				error.code === scenario.code,
		);
	}
});

test("the control plane requires canonical bytes and revalidates nested semantic evidence", async () => {
	const controlPlane = new HostedControlPlane({
		oidc: verifier(),
		authorizer: authorizer({ semanticReviewEnabled: true }),
		persistence: new InMemoryHostedPersistence(),
	});
	const summary = await gateSummaryEnvelope();
	await assert.rejects(
		controlPlane.ingest({
			bearerToken: jwt(),
			body: `${JSON.stringify(summary, null, 2)}\n`,
			claimedDigest: sha256Jcs(summary),
		}),
		(error) =>
			error instanceof HostedControlPlaneError && error.code === "HOSTED_CANONICAL_BYTES_REQUIRED",
	);

	const semantic = await createHostedEnvelope({
		ciBundle: structuredClone(ciBundle),
		profile: "semantic-review-v1",
		syncIdentity: baseClaims,
	});
	semantic.payload.bundle.portableBundle.artifacts["records.json"][0].recordId = "tampered";
	semantic.redaction.includes[0].digest.value = sha256Jcs(semantic.payload);
	semantic.source.sourceBundleDigest.value = sha256Jcs(semantic.payload.bundle);
	await assert.rejects(
		controlPlane.ingest({
			bearerToken: jwt(),
			body: canonicalize(semantic),
			claimedDigest: sha256Jcs(semantic),
		}),
		(error) =>
			error instanceof HostedControlPlaneError &&
			error.code === "HOSTED_ENVELOPE_INTEGRITY_INVALID",
	);

	const summaryTamper = await gateSummaryEnvelope();
	summaryTamper.payload.summary.affectedWorkUnitIds = ["forged-unit"];
	summaryTamper.redaction.includes[0].digest.value = sha256Jcs(summaryTamper.payload);
	await assert.rejects(
		controlPlane.ingest({
			bearerToken: jwt(),
			body: canonicalize(summaryTamper),
			claimedDigest: sha256Jcs(summaryTamper),
		}),
		(error) =>
			error instanceof HostedControlPlaneError &&
			error.code === "HOSTED_ENVELOPE_INTEGRITY_INVALID",
	);
});

test("semantic review requires repository opt-in and rejected content is not stored", async () => {
	const semantic = await createHostedEnvelope({
		ciBundle: structuredClone(ciBundle),
		profile: "semantic-review-v1",
		syncIdentity: baseClaims,
	});
	const persistence = new InMemoryHostedPersistence();
	const controlPlane = new HostedControlPlane({
		oidc: verifier(),
		authorizer: authorizer(),
		persistence,
	});
	await assert.rejects(
		controlPlane.ingest({
			bearerToken: jwt(),
			body: canonicalize(semantic),
			claimedDigest: sha256Jcs(semantic),
		}),
		(error) =>
			error instanceof HostedControlPlaneError && error.code === "HOSTED_PROFILE_UNAUTHORIZED",
	);
	assert.equal(persistence.records().length, 0);
});

test("tenant and repository scoped persistence enforces rate and storage bounds", async () => {
	const repository = {
		tenantId: "tenant-1",
		repositoryId: "repository-1",
		provider: "github",
		providerRepositoryId: "123",
		providerOwnerId: "456",
		semanticReviewEnabled: false,
	};
	const base = {
		repository,
		profile: "gate-summary-v1",
		gateVerdict: "pass",
		sourceRunId: "1",
		sourceHead: "a".repeat(40),
		receivedAt: now,
	};
	const rateLimited = new InMemoryHostedPersistence({ dailyUploadLimit: 1 });
	assert.equal(
		(
			await rateLimited.ingest({
				...base,
				digest: "1".repeat(64),
				canonicalBytes: Buffer.from("a"),
			})
		).status,
		"stored",
	);
	assert.equal(
		(
			await rateLimited.ingest({
				...base,
				digest: "2".repeat(64),
				canonicalBytes: Buffer.from("b"),
			})
		).status,
		"rate-limit",
	);
	assert.equal(rateLimited.records().length, 1);

	const storageLimited = new InMemoryHostedPersistence({ tenantStorageLimitBytes: 1 });
	assert.equal(
		(
			await storageLimited.ingest({
				...base,
				digest: "3".repeat(64),
				canonicalBytes: Buffer.from("ab"),
			})
		).status,
		"storage-limit",
	);
	assert.equal(storageLimited.records().length, 0);
});

test("workflow identity is an exact path and the bounded HTTP endpoint returns one receipt", async (context) => {
	const maliciousClaims = {
		...baseClaims,
		workflow_ref:
			"evil/prefix/clfhhc/test-graphrefly/.github/workflows/graphrefly-stack-hosted.yml@refs/heads/main",
	};
	const maliciousEnvelope = await gateSummaryEnvelope(maliciousClaims);
	const controlPlane = new HostedControlPlane({
		oidc: verifier(),
		authorizer: authorizer(),
		persistence: new InMemoryHostedPersistence(),
		now: () => now,
	});
	await assert.rejects(
		controlPlane.ingest({
			bearerToken: jwt(maliciousClaims),
			body: canonicalize(maliciousEnvelope),
			claimedDigest: sha256Jcs(maliciousEnvelope),
		}),
		(error) =>
			error instanceof HostedControlPlaneError && error.code === "HOSTED_IDENTITY_BINDING_INVALID",
	);

	const server = createServer(createHostedIngestHandler(controlPlane));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	context.after(() => server.close());
	const address = server.address();
	assert.notEqual(address, null);
	assert.equal(typeof address, "object");
	const envelope = await gateSummaryEnvelope();
	const response = await fetch(`http://127.0.0.1:${address.port}/v1/envelopes`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${jwt()}`,
			"Content-Type": "application/json",
			"X-GraphReFly-Envelope-Digest": sha256Jcs(envelope),
		},
		body: canonicalize(envelope),
	});
	assert.equal(response.status, 201);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal((await response.json()).digest, sha256Jcs(envelope));

	const unauthenticated = await fetch(`http://127.0.0.1:${address.port}/v1/envelopes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: canonicalize(envelope),
	});
	assert.equal(unauthenticated.status, 401);
	assert.equal((await unauthenticated.json()).error.code, "HOSTED_BEARER_REQUIRED");
});
