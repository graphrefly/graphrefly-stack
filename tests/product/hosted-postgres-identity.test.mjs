import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PostgresHostedBrowserIdentityStore } from "../../packages/hosted/dist/index.js";

const tenantId = "018f0000-0000-7000-8000-000000000001";
const repositoryId = "018f0000-0000-7000-8000-000000000002";
const actorId = "018f0000-0000-7000-8000-000000000003";
const sessionId = "018f0000-0000-7000-8000-000000000004";
const attemptId = "018f0000-0000-7000-8000-000000000005";
const now = new Date("2026-07-18T20:00:00.000Z");
const sealed = { version: 1, iv: "iv", ciphertext: "ciphertext", tag: "tag" };

class QueueDatabase {
	constructor(responses) {
		this.responses = [...responses];
		this.calls = [];
		this.tenants = [];
		this.authenticationTransactions = 0;
	}

	async transaction(tenant, operation) {
		this.tenants.push(tenant);
		return operation(this.#transaction());
	}

	async authenticationTransaction(operation) {
		this.authenticationTransactions += 1;
		return operation(this.#transaction());
	}

	#transaction() {
		return {
			query: async (sql, parameters = []) => {
				this.calls.push({ sql, parameters });
				const rows = this.responses.shift();
				if (rows === undefined) throw new Error(`unexpected SQL: ${sql}`);
				return { rows };
			},
		};
	}
}

function attempt() {
	return {
		id: attemptId,
		tenantId,
		stateHash: "1".repeat(64),
		browserBindingHash: "2".repeat(64),
		pkceVerifier: sealed,
		redirectUri: "https://hosted.graphrefly.dev/auth/github/callback",
		returnTo: "/repositories/stack",
		repositoryId,
		expiresAt: "2026-07-18T20:10:00.000Z",
	};
}

function session() {
	return {
		id: sessionId,
		tenantId,
		actorId,
		actorProviderId: "24680",
		tokenHash: "3".repeat(64),
		credential: sealed,
		createdAt: now.toISOString(),
		expiresAt: "2026-07-19T04:00:00.000Z",
		revokedAt: null,
	};
}

test("the PostgreSQL identity adapter persists only hashes and ciphertext behind tenant or auth transactions", async () => {
	const attemptRow = {
		id: attemptId,
		tenant_id: tenantId,
		state_hash: "1".repeat(64),
		browser_binding_hash: "2".repeat(64),
		pkce_verifier_ciphertext: sealed,
		redirect_uri: "https://hosted.graphrefly.dev/auth/github/callback",
		return_to: "/repositories/stack",
		repository_id: repositoryId,
		expires_at: "2026-07-18T20:10:00.000Z",
	};
	const sessionRow = {
		id: sessionId,
		tenant_id: tenantId,
		actor_id: actorId,
		actor_provider_id: "24680",
		token_hash: "3".repeat(64),
		provider_credential_ciphertext: sealed,
		created_at: now,
		expires_at: "2026-07-19T04:00:00.000Z",
		revoked_at: null,
	};
	const database = new QueueDatabase([
		[],
		[attemptRow],
		[{ id: actorId }],
		[],
		[],
		[sessionRow],
		[{ id: sessionId }],
		[],
		[{ role: "reviewer", selected: true, provider_repository_id: "123456" }],
		[],
	]);
	const ids = [actorId, "018f0000-0000-7000-8000-000000000006"];
	const store = new PostgresHostedBrowserIdentityStore({
		database,
		idFactory: () => ids.shift(),
	});
	await store.createLoginAttempt(attempt());
	assert.deepEqual(
		await store.consumeLoginAttempt({
			stateHash: "1".repeat(64),
			browserBindingHash: "2".repeat(64),
			now,
		}),
		attempt(),
	);
	assert.deepEqual(
		await store.upsertActor({
			tenantId,
			provider: "github",
			providerUserId: "24680",
			providerLogin: "octocat",
			now,
		}),
		{ actorId },
	);
	await store.createSession(session());
	assert.deepEqual(await store.loadSession("3".repeat(64), now), session());
	await store.updateSessionCredential({
		tenantId,
		sessionId,
		credential: sealed,
		now,
	});
	await store.revokeSession(tenantId, sessionId, now);
	assert.deepEqual(await store.loadAccessContext({ tenantId, actorId, repositoryId, now }), {
		role: "reviewer",
		repositorySelected: true,
		providerRepositoryId: "123456",
	});
	await store.recordAuthenticationRejection({ tenantId, now });
	assert.equal(database.authenticationTransactions, 2);
	assert.deepEqual(database.tenants, [
		tenantId,
		tenantId,
		tenantId,
		tenantId,
		tenantId,
		tenantId,
		tenantId,
	]);
	assert.match(database.calls[0].sql, /browser_binding_hash/u);
	assert.match(database.calls[1].sql, /hosted_consume_login_attempt/u);
	assert.match(database.calls[3].sql, /INSERT INTO hosted_browser_sessions/u);
	assert.match(database.calls[4].sql, /'authenticate'/u);
	assert.match(database.calls[5].sql, /hosted_load_browser_session/u);
	assert.match(database.calls.at(-1).sql, /'authenticate'[\s\S]*'rejected'/u);
	const persisted = JSON.stringify(database.calls);
	assert.equal(persisted.includes("github-access-secret"), false);
	assert.equal(persisted.includes("github-refresh-secret"), false);
	assert.equal(persisted.includes("browser-session-secret"), false);
});

test("opaque session lookup is revoked-by-default and excludes expired or revoked sessions", async () => {
	const migration = await readFile(
		new URL("../../packages/hosted/migrations/005_hosted_session_lookup_v1.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /SECURITY DEFINER/u);
	assert.match(migration, /s\.token_hash = requested_token_hash/u);
	assert.match(migration, /s\.revoked_at IS NULL/u);
	assert.match(migration, /s\.expires_at > current_time/u);
	assert.match(migration, /REVOKE ALL[\s\S]*FROM PUBLIC/u);
	assert.doesNotMatch(migration, /UPDATE hosted_browser_sessions/u);
});
