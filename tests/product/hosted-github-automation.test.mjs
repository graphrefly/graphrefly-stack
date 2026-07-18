import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalize } from "../../packages/contracts/dist/index.js";
import { GitHubAppUploadAuthorizer } from "../../packages/hosted/dist/index.js";

const now = new Date("2026-07-18T20:00:00.000Z");
const repositoryId = "123456";
const ownerId = "654321";
const runId = "987654321";
const head = "2".repeat(40);
const portableDigest = "6".repeat(64);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const ciBundle = JSON.parse(
	await readFile(
		new URL("../../fixtures/contracts/hosted/v1/ci-bundle.json", import.meta.url),
		"utf8",
	),
);

function storedZip(name, content) {
	const fileName = Buffer.from(name, "utf8");
	const data = Buffer.from(content);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(fileName.length, 26);
	const centralOffset = local.length + fileName.length + data.length;
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(fileName.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + fileName.length, 12);
	end.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, fileName, data, central, fileName, end]);
}

function input() {
	return {
		identity: {
			claims: {
				schema: "graphrefly.stack.github-oidc-claims.v1",
				issuer: "https://token.actions.githubusercontent.com",
				audience: "graphrefly-stack-hosted",
				subject: "repo:clfhhc/test-graphrefly:ref:refs/heads/main",
				repositoryId,
				repositoryOwnerId: ownerId,
				workflowRef:
					"clfhhc/test-graphrefly/.github/workflows/graphrefly-stack-hosted.yml@refs/heads/main",
				workflowSha: { algorithm: "sha1", value: "4".repeat(40) },
				runId: "987654322",
				runAttempt: 1,
				actorId: "24680",
				eventName: "workflow_run",
			},
			rawClaims: {},
		},
		repository: { provider: "github", repositoryId, ownerId },
		source: {
			runId,
			runAttempt: 2,
			head: { algorithm: "sha1", value: head },
			sourceBundleDigest: { algorithm: "sha256", value: "7".repeat(64) },
			ciInvocationDigest: { algorithm: "sha256", value: "3".repeat(64) },
			gateInputDigest: { algorithm: "sha256", value: "5".repeat(64) },
			portableBundleDigest: { algorithm: "sha256", value: portableDigest },
		},
	};
}

function payloads(options = {}) {
	return {
		installation: {
			id: 9001,
			app_id: 42,
			account: { id: Number(ownerId) },
			suspended_at: null,
			...options.installation,
		},
		token: {
			token: "installation-secret",
			expires_at: "2026-07-18T21:00:00.000Z",
			repositories: [{ id: Number(repositoryId) }],
			...options.token,
		},
		repository: {
			id: Number(repositoryId),
			owner: { id: Number(ownerId) },
			private: options.private ?? false,
		},
		run: {
			id: Number(runId),
			run_attempt: 2,
			head_sha: head,
			event: "pull_request",
			status: "completed",
			conclusion: "success",
			path: ".github/workflows/graphrefly-stack.yml@refs/heads/main",
			repository: { id: Number(repositoryId), owner: { id: Number(ownerId) } },
			...options.run,
		},
		artifacts: {
			artifacts: [
				{
					id: 777,
					name: `graphrefly-stack-ci-${portableDigest}`,
					expired: false,
					workflow_run: {
						id: Number(runId),
						head_repository_id: Number(repositoryId),
						head_sha: head,
					},
				},
			],
			...options.artifacts,
		},
	};
}

function harness(options = {}) {
	const values = payloads(options);
	const archive = storedZip("graphrefly-stack-ci.json", canonicalize(ciBundle));
	const calls = [];
	const directory = {
		calls: [],
		async resolveSelectedRepository(value) {
			this.calls.push(structuredClone(value));
			return options.directoryDenied
				? null
				: {
						tenantId: "018f0000-0000-7000-8000-000000000001",
						repositoryId: "018f0000-0000-7000-8000-000000000002",
						provider: "github",
						providerRepositoryId: repositoryId,
						providerOwnerId: ownerId,
						semanticReviewEnabled: true,
					};
		},
	};
	const authorizer = new GitHubAppUploadAuthorizer({
		appId: "42",
		privateKey: privatePem,
		directory,
		now: () => now,
		fetch: async (url, init = {}) => {
			calls.push({ url: String(url), init });
			if (options.transportFailure) throw new Error("network unavailable");
			if (String(url).endsWith("/installation")) return Response.json(values.installation);
			if (String(url).includes("/access_tokens")) return Response.json(values.token);
			if (String(url).endsWith("/actions/artifacts/777/zip")) {
				return new Response(archive, {
					status: 200,
					headers: { "Content-Length": String(archive.byteLength) },
				});
			}
			if (String(url).endsWith(`/repositories/${repositoryId}`)) {
				return Response.json(values.repository);
			}
			if (String(url).includes("/artifacts?")) return Response.json(values.artifacts);
			if (String(url).includes(`/actions/runs/${runId}`)) return Response.json(values.run);
			return new Response("not found", { status: 404 });
		},
	});
	return { authorizer, directory, calls };
}

test("GitHub App upload authorization binds installation, least-privilege token, source run and artifact", async () => {
	for (const visibility of ["public", "private"]) {
		const h = harness({ private: visibility === "private" });
		const result = await h.authorizer.authorizeUpload(input());
		assert.equal(result.repository.providerRepositoryId, repositoryId);
		assert.deepEqual(result.sourceBundle, ciBundle);
		assert.equal(h.directory.calls.length, 1);
		assert.deepEqual(h.directory.calls[0], {
			provider: "github",
			installationId: "9001",
			providerAccountId: ownerId,
			providerRepositoryId: repositoryId,
			providerOwnerId: ownerId,
			visibility,
		});
		assert.match(h.calls[0].url, /\/repos\/clfhhc\/test-graphrefly\/installation$/u);
		const appJwt = h.calls[0].init.headers.Authorization.slice("Bearer ".length);
		const [header, body, signature] = appJwt.split(".");
		assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
		assert.deepEqual(JSON.parse(Buffer.from(body, "base64url")), {
			iat: Math.floor(now.getTime() / 1000) - 60,
			exp: Math.floor(now.getTime() / 1000) + 540,
			iss: "42",
		});
		assert.equal(
			verify(
				"RSA-SHA256",
				Buffer.from(`${header}.${body}`),
				publicKey,
				Buffer.from(signature, "base64url"),
			),
			true,
		);
		const tokenRequest = h.calls[1];
		assert.equal(tokenRequest.init.method, "POST");
		assert.deepEqual(JSON.parse(tokenRequest.init.body), {
			repository_ids: [Number(repositoryId)],
			permissions: { actions: "read", metadata: "read" },
		});
		assert.equal(
			h.calls
				.slice(2)
				.every((call) => call.init.headers.Authorization === "Bearer installation-secret"),
			true,
		);
	}
});

test("installation, repository, run, artifact and selected-directory mismatches all fail closed", async () => {
	const cases = [
		{ installation: { suspended_at: "2026-07-18T19:00:00Z" } },
		{ installation: { account: { id: 999999 } } },
		{ token: { repositories: [{ id: 999999 }] } },
		{ run: { run_attempt: 3 } },
		{ run: { head_sha: "9".repeat(40) } },
		{ run: { event: "push" } },
		{ artifacts: { artifacts: [] } },
		{
			artifacts: {
				artifacts: [
					{
						id: 777,
						name: `graphrefly-stack-ci-${portableDigest}`,
						expired: true,
						workflow_run: {
							id: Number(runId),
							head_repository_id: Number(repositoryId),
							head_sha: head,
						},
					},
				],
			},
		},
		{ directoryDenied: true },
		{ transportFailure: true },
	];
	for (const options of cases) {
		const h = harness(options);
		assert.equal(await h.authorizer.authorizeUpload(input()), null);
	}
});

test("workflow repository identity and artifact name cannot be widened or replayed", async () => {
	const malformedWorkflow = input();
	malformedWorkflow.identity.claims.workflowRef =
		"clfhhc/test-graphrefly/.github/workflows/other.yml@refs/heads/main";
	assert.equal(await harness().authorizer.authorizeUpload(malformedWorkflow), null);

	const replayed = input();
	replayed.source.portableBundleDigest.value = "8".repeat(64);
	assert.equal(await harness().authorizer.authorizeUpload(replayed), null);
});
