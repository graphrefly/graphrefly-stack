import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createHostedEnvelope } from "../../packages/cli/dist/hosted-runner.js";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/index.js";
import {
	GitHubAppUploadAuthorizer,
	GitHubOidcVerifier,
	HostedControlPlane,
	InMemoryHostedPersistence,
	StaticJwksProvider,
} from "../../packages/hosted/dist/index.js";

const sourceFixture = JSON.parse(
	await readFile(
		new URL("../../fixtures/contracts/hosted/v1/ci-bundle.json", import.meta.url),
		"utf8",
	),
);
const now = new Date("2026-07-18T20:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const { privateKey: oidcPrivate, publicKey: oidcPublic } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const oidcJwk = oidcPublic.export({ format: "jwk" });
const { privateKey: appPrivate } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appPem = appPrivate.export({ type: "pkcs8", format: "pem" });

function bundleFor(verdict) {
	const bundle = structuredClone(sourceFixture);
	if (verdict !== "pass") {
		const reason = verdict === "error" ? "REQUIRED_CHECK_FAILED" : "SEMANTIC_PARENT_STALE";
		bundle.result.gateResult.verdict = verdict;
		bundle.result.gateResult.units[0].verdict = "invalid";
		bundle.result.gateResult.units[0].reasonCodes = [reason];
		bundle.result.outcome = verdict;
		bundle.result.summary = {
			verdict,
			affectedWorkUnitIds: [bundle.result.gateResult.units[0].workUnitId],
			reasonCodes: [reason],
		};
		bundle.portableBundle.artifacts["gate-result.json"] = structuredClone(bundle.result.gateResult);
		bundle.portableBundle.manifest.artifacts.find(
			(entry) => entry.path === "gate-result.json",
		).hash.value = sha256Jcs(bundle.result.gateResult);
		bundle.result.portableBundleDigest.value = sha256Jcs(bundle.portableBundle);
		bundle.result.artifactName = `graphrefly-stack-ci-${bundle.result.portableBundleDigest.value}`;
	}
	return bundle;
}

function zipBundle(bundle) {
	const name = Buffer.from("graphrefly-stack-ci.json");
	const data = Buffer.from(canonicalize(bundle));
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(name.length, 26);
	const centralOffset = local.length + name.length + data.length;
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(name.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, name, data, central, name, end]);
}

function claims(bundle) {
	return {
		iss: "https://token.actions.githubusercontent.com",
		aud: "graphrefly-stack-hosted",
		sub: "repo:clfhhc/test-graphrefly:ref:refs/heads/main",
		repository_id: bundle.invocation.repository.id,
		repository_owner_id: bundle.invocation.repository.ownerId,
		workflow_ref:
			"clfhhc/test-graphrefly/.github/workflows/graphrefly-stack-hosted.yml@refs/heads/main",
		workflow_sha: "4".repeat(40),
		run_id: "987654322",
		run_attempt: "1",
		actor_id: "24680",
		event_name: "workflow_run",
		iat: nowSeconds - 30,
		nbf: nowSeconds - 30,
		exp: nowSeconds + 300,
	};
}

function jwt(payload) {
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT", kid: "github-e14-key" }),
	).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const signingInput = `${header}.${body}`;
	return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), oidcPrivate).toString("base64url")}`;
}

function githubAuthorizer(bundle, visibility, directoryCalls) {
	const repositoryId = bundle.invocation.repository.id;
	const ownerId = bundle.invocation.repository.ownerId;
	const archive = zipBundle(bundle);
	return new GitHubAppUploadAuthorizer({
		appId: "42",
		privateKey: appPem,
		now: () => now,
		directory: {
			async resolveSelectedRepository(input) {
				directoryCalls.push(structuredClone(input));
				return {
					tenantId: "018f0000-0000-7000-8000-000000000001",
					repositoryId: "018f0000-0000-7000-8000-000000000002",
					provider: "github",
					providerRepositoryId: repositoryId,
					providerOwnerId: ownerId,
					semanticReviewEnabled: true,
				};
			},
		},
		fetch: async (url) => {
			const path = String(url);
			if (path.endsWith("/installation")) {
				return Response.json({
					id: 9001,
					app_id: 42,
					account: { id: Number(ownerId) },
					suspended_at: null,
				});
			}
			if (path.endsWith("/access_tokens")) {
				return Response.json({
					token: "installation-secret",
					expires_at: "2026-07-18T21:00:00.000Z",
					repositories: [{ id: Number(repositoryId) }],
				});
			}
			if (path.endsWith(`/repositories/${repositoryId}`)) {
				return Response.json({
					id: Number(repositoryId),
					owner: { id: Number(ownerId) },
					private: visibility === "private",
				});
			}
			if (path.includes("/artifacts?")) {
				return Response.json({
					artifacts: [
						{
							id: 777,
							name: bundle.result.artifactName,
							expired: false,
							workflow_run: {
								id: Number(bundle.invocation.run.id),
								head_repository_id: Number(repositoryId),
								head_sha: bundle.invocation.event.head.value,
							},
						},
					],
				});
			}
			if (path.endsWith("/actions/artifacts/777/zip")) return new Response(archive);
			if (path.includes(`/actions/runs/${bundle.invocation.run.id}`)) {
				return Response.json({
					id: Number(bundle.invocation.run.id),
					run_attempt: bundle.invocation.run.attempt,
					head_sha: bundle.invocation.event.head.value,
					event: "pull_request",
					status: "completed",
					conclusion: verdictConclusion(bundle.result.outcome),
					path: ".github/workflows/graphrefly-stack.yml@refs/heads/main",
					repository: { id: Number(repositoryId), owner: { id: Number(ownerId) } },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
}

function verdictConclusion(verdict) {
	return verdict === "pass" ? "success" : "failure";
}

test("E14 hermetic happy path binds public and private pass, blocked and error artifacts end to end", async () => {
	for (const scenario of [
		{ verdict: "pass", visibility: "public" },
		{ verdict: "blocked", visibility: "private" },
		{ verdict: "error", visibility: "private" },
	]) {
		const bundle = bundleFor(scenario.verdict);
		const syncClaims = claims(bundle);
		const envelope = await createHostedEnvelope({
			ciBundle: bundle,
			profile: "gate-summary-v1",
			syncIdentity: syncClaims,
		});
		const directoryCalls = [];
		const persistence = new InMemoryHostedPersistence();
		const controlPlane = new HostedControlPlane({
			oidc: new GitHubOidcVerifier({
				jwks: new StaticJwksProvider([["github-e14-key", { ...oidcJwk, use: "sig" }]]),
				now: () => now,
			}),
			authorizer: githubAuthorizer(bundle, scenario.visibility, directoryCalls),
			persistence,
			now: () => now,
		});
		const bytes = canonicalize(envelope);
		const digest = sha256Jcs(envelope);
		const created = await controlPlane.ingest({
			bearerToken: jwt(syncClaims),
			body: bytes,
			claimedDigest: digest,
		});
		assert.equal(created.status, 201);
		assert.equal(persistence.records()[0].gateVerdict, scenario.verdict);
		assert.equal(directoryCalls[0].visibility, scenario.visibility);
		const retry = await controlPlane.ingest({
			bearerToken: jwt(syncClaims),
			body: bytes,
			claimedDigest: digest,
		});
		assert.equal(retry.status, 409);
		assert.deepEqual(retry.receipt, created.receipt);
		assert.equal(persistence.records().length, 1);
	}
});
