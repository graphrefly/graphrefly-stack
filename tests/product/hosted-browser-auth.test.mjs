import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	AesGcmCredentialVault,
	GitHubAppBrowserProvider,
	HostedBrowserAuthError,
	HostedBrowserAuthService,
} from "../../packages/hosted/dist/index.js";

const now = new Date("2026-07-18T18:00:00.000Z");
const tenantId = "018f0000-0000-7000-8000-000000000001";
const repositoryId = "018f0000-0000-7000-8000-000000000002";
const actorId = "018f0000-0000-7000-8000-000000000003";
const accessToken = "github-access-secret";
const refreshToken = "github-refresh-secret";
const browserBinding = `browser-${"b".repeat(35)}`;

function credential(overrides = {}) {
	return {
		accessToken,
		accessExpiresAt: "2026-07-18T19:00:00.000Z",
		refreshToken,
		refreshExpiresAt: "2026-08-18T18:00:00.000Z",
		...overrides,
	};
}

class MemoryIdentityStore {
	constructor() {
		this.attempts = [];
		this.sessions = [];
		this.consumed = new Set();
		this.role = "viewer";
		this.selected = true;
		this.membershipActive = true;
		this.authenticationRejections = [];
	}

	async createLoginAttempt(attempt) {
		this.attempts.push(structuredClone(attempt));
	}

	async consumeLoginAttempt(input) {
		const attempt = this.attempts.find(
			(item) =>
				item.stateHash === input.stateHash && item.browserBindingHash === input.browserBindingHash,
		);
		if (
			attempt === undefined ||
			this.consumed.has(input.stateHash) ||
			Date.parse(attempt.expiresAt) <= input.now.getTime()
		) {
			return null;
		}
		this.consumed.add(input.stateHash);
		return structuredClone(attempt);
	}

	async upsertActor(input) {
		this.actor = structuredClone(input);
		return { actorId };
	}

	async createSession(session) {
		this.sessions.push(structuredClone(session));
	}

	async recordAuthenticationRejection(input) {
		this.authenticationRejections.push(structuredClone(input));
	}

	async loadSession(tokenHash, at) {
		const session = this.sessions.find((item) => item.tokenHash === tokenHash);
		if (
			session === undefined ||
			session.revokedAt !== null ||
			Date.parse(session.expiresAt) <= at.getTime()
		) {
			return null;
		}
		return structuredClone(session);
	}

	async updateSessionCredential(input) {
		this.updates ??= [];
		this.updates.push(structuredClone(input));
		const session = this.sessions.find((item) => item.id === input.sessionId);
		session.credential = structuredClone(input.credential);
	}

	async revokeSession(_tenantId, sessionId, at) {
		this.sessions.find((item) => item.id === sessionId).revokedAt = at.toISOString();
	}

	async loadAccessContext() {
		return {
			role: this.membershipActive ? this.role : null,
			repositorySelected: this.selected,
			providerRepositoryId: "123456789",
		};
	}
}

class FakeGitHubProvider {
	constructor() {
		this.access = "granted";
		this.exchangeCalls = [];
		this.revalidationCalls = [];
		this.refreshCalls = [];
	}

	async exchangeAuthorizationCode(input) {
		this.exchangeCalls.push(structuredClone(input));
		return credential();
	}

	async refreshUserCredential(previous) {
		this.refreshCalls.push(structuredClone(previous));
		return credential({
			accessToken: "rotated-access-secret",
			accessExpiresAt: "2026-07-18T20:00:00.000Z",
			refreshToken: "rotated-refresh-secret",
		});
	}

	async getAuthenticatedUser(receivedAccessToken) {
		assert.equal(receivedAccessToken, accessToken);
		return { id: "24680", login: "octocat" };
	}

	async revalidateRepositoryAccess(input) {
		this.revalidationCalls.push(structuredClone(input));
		return this.access === "granted"
			? { status: "granted", repositoryUrl: "https://github.com/clfhhc/test-graphrefly" }
			: { status: this.access };
	}
}

function fixture() {
	const store = new MemoryIdentityStore();
	const provider = new FakeGitHubProvider();
	const randomValues = [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)];
	const ids = ["018f0000-0000-7000-8000-000000000010", "018f0000-0000-7000-8000-000000000011"];
	const vault = new AesGcmCredentialVault(Buffer.alloc(32, 9));
	const service = new HostedBrowserAuthService({
		clientId: "github-app-client-id",
		redirectUri: "https://hosted.graphrefly.dev/auth/github/callback",
		store,
		provider,
		vault,
		now: () => now,
		idFactory: () => ids.shift(),
		randomBytes: () => randomValues.shift(),
	});
	return { service, store, provider, vault };
}

async function login(f) {
	const started = await f.service.beginLogin({
		tenantId,
		returnTo: "/repositories/stack",
		browserBinding,
	});
	const url = new URL(started.authorizationUrl);
	const state = url.searchParams.get("state");
	const completed = await f.service.completeLogin({
		state,
		code: "one-time-code",
		browserBinding,
	});
	return { started, url, state, completed };
}

test("browser login binds one-time state, exact redirect URI and S256 PKCE without persisting secrets", async () => {
	const f = fixture();
	const result = await login(f);
	assert.equal(result.url.origin, "https://github.com");
	assert.equal(result.url.pathname, "/login/oauth/authorize");
	assert.equal(result.url.searchParams.get("client_id"), "github-app-client-id");
	assert.equal(
		result.url.searchParams.get("redirect_uri"),
		"https://hosted.graphrefly.dev/auth/github/callback",
	);
	assert.equal(result.url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(result.url.searchParams.get("code_challenge").length, 43);
	assert.equal(
		f.store.attempts[0].stateHash,
		createHash("sha256").update(result.state).digest("hex"),
	);
	assert.equal(f.store.attempts[0].state, undefined);
	assert.equal(
		f.store.attempts[0].browserBindingHash,
		createHash("sha256").update(browserBinding).digest("hex"),
	);
	assert.equal(JSON.stringify(f.store.attempts).includes(browserBinding), false);
	assert.equal(f.provider.exchangeCalls[0].redirectUri, f.store.attempts[0].redirectUri);
	assert.equal(f.provider.exchangeCalls[0].codeVerifier.length, 43);
	assert.equal(
		result.url.searchParams.get("code_challenge"),
		createHash("sha256").update(f.provider.exchangeCalls[0].codeVerifier).digest("base64url"),
	);
	assert.equal(result.completed.returnTo, "/repositories/stack");
	assert.equal(
		f.store.sessions[0].tokenHash,
		createHash("sha256").update(result.completed.sessionToken).digest("hex"),
	);
	const stored = JSON.stringify({ attempts: f.store.attempts, sessions: f.store.sessions });
	for (const secret of [result.state, result.completed.sessionToken, accessToken, refreshToken]) {
		assert.equal(stored.includes(secret), false);
	}
	await assert.rejects(
		f.service.completeLogin({
			state: result.state,
			code: "replayed-code",
			browserBinding,
		}),
		(error) =>
			error instanceof HostedBrowserAuthError && error.code === "HOSTED_LOGIN_STATE_INVALID",
	);
});

test("unsafe return paths and invalid callback state fail before contacting GitHub", async () => {
	for (const returnTo of ["https://evil.test", "//evil.test", "/\\evil", "/ok\r\nLocation: evil"]) {
		const f = fixture();
		await assert.rejects(
			f.service.beginLogin({ tenantId, returnTo, browserBinding }),
			(error) =>
				error instanceof HostedBrowserAuthError && error.code === "HOSTED_RETURN_PATH_INVALID",
		);
		assert.equal(f.store.attempts.length, 0);
	}
	const f = fixture();
	await assert.rejects(
		f.service.completeLogin({
			state: "x".repeat(43),
			code: "code",
			browserBinding,
		}),
		(error) =>
			error instanceof HostedBrowserAuthError && error.code === "HOSTED_LOGIN_STATE_INVALID",
	);
	assert.equal(f.provider.exchangeCalls.length, 0);
});

test("OAuth state is atomically bound to the browser that initiated login", async () => {
	const f = fixture();
	const started = await f.service.beginLogin({
		tenantId,
		returnTo: "/repositories/stack",
		browserBinding,
	});
	const state = new URL(started.authorizationUrl).searchParams.get("state");
	await assert.rejects(
		f.service.completeLogin({
			state,
			code: "attacker-code",
			browserBinding: `attacker-${"a".repeat(34)}`,
		}),
		(error) => error.code === "HOSTED_LOGIN_STATE_INVALID",
	);
	assert.equal(f.provider.exchangeCalls.length, 0);
	assert.equal(f.store.consumed.size, 0, "a mismatched browser cannot burn the valid attempt");
	await f.service.completeLogin({ state, code: "valid-code", browserBinding });
	assert.equal(f.provider.exchangeCalls.length, 1);
});

test("a tenant-bound provider login failure emits a rejected authentication audit", async () => {
	const f = fixture();
	const started = await f.service.beginLogin({
		tenantId,
		returnTo: "/repositories/stack",
		browserBinding,
	});
	f.provider.exchangeAuthorizationCode = async () => {
		throw new Error("provider denied the code");
	};
	await assert.rejects(
		f.service.completeLogin({
			state: new URL(started.authorizationUrl).searchParams.get("state"),
			code: "rejected-code",
			browserBinding,
		}),
		(error) =>
			error instanceof HostedBrowserAuthError && error.code === "HOSTED_PROVIDER_LOGIN_FAILED",
	);
	assert.deepEqual(f.store.authenticationRejections, [{ tenantId, now }]);
});

test("effective access is membership role intersected with installation selection and live provider access", async () => {
	const f = fixture();
	const { completed } = await login(f);
	const cases = [
		["viewer", "read", true],
		["viewer", "append-decision", false],
		["reviewer", "append-decision", true],
		["reviewer", "audit-export", false],
		["admin", "audit-export", true],
		["admin", "repository-admin", true],
		["admin", "tenant-admin", false],
		["owner", "tenant-admin", true],
	];
	for (const [role, action, allowed] of cases) {
		f.store.role = role;
		const operation = f.service.authorize({
			sessionToken: completed.sessionToken,
			tenantId,
			repositoryId,
			action,
		});
		if (allowed) assert.equal((await operation).role, role);
		else {
			await assert.rejects(
				operation,
				(error) => error instanceof HostedBrowserAuthError && error.code === "HOSTED_ACCESS_DENIED",
			);
		}
	}
	assert.equal(
		f.provider.revalidationCalls.length,
		cases.length,
		"every action revalidates provider access",
	);

	f.store.selected = false;
	await assert.rejects(
		f.service.authorize({
			sessionToken: completed.sessionToken,
			tenantId,
			repositoryId,
			action: "read",
		}),
		(error) => error.code === "HOSTED_ACCESS_DENIED",
	);
	f.store.selected = true;
	f.store.membershipActive = false;
	await assert.rejects(
		f.service.authorize({
			sessionToken: completed.sessionToken,
			tenantId,
			repositoryId,
			action: "read",
		}),
		(error) => error.code === "HOSTED_ACCESS_DENIED",
	);
});

test("provider denial and outage fail closed while expiring credentials rotate before access", async () => {
	const f = fixture();
	const { completed } = await login(f);
	const session = f.store.sessions[0];
	session.credential = f.vault.seal(
		credential({ accessExpiresAt: "2026-07-18T18:04:00.000Z" }),
		`graphrefly-hosted/session/${session.id}/v1`,
	);
	await f.service.authorize({
		sessionToken: completed.sessionToken,
		tenantId,
		repositoryId,
		action: "read",
	});
	assert.equal(f.provider.refreshCalls.length, 1);
	assert.equal(f.store.updates.length, 1);
	const persisted = JSON.stringify(f.store.sessions[0]);
	assert.equal(persisted.includes("rotated-access-secret"), false);
	assert.equal(persisted.includes("rotated-refresh-secret"), false);
	assert.equal(f.provider.revalidationCalls.at(-1).accessToken, "rotated-access-secret");

	for (const [access, code] of [
		["denied", "HOSTED_ACCESS_DENIED"],
		["unavailable", "HOSTED_PROVIDER_UNAVAILABLE"],
	]) {
		f.provider.access = access;
		await assert.rejects(
			f.service.authorize({
				sessionToken: completed.sessionToken,
				tenantId,
				repositoryId,
				action: "read",
			}),
			(error) => error instanceof HostedBrowserAuthError && error.code === code,
		);
	}
});

test("identity migration uses tenant RLS, one-time state consumption and ciphertext-only credential columns", async () => {
	const migration = await readFile(
		new URL("../../packages/hosted/migrations/002_hosted_identity_v1.sql", import.meta.url),
		"utf8",
	);
	for (const table of [
		"hosted_actors",
		"hosted_memberships",
		"hosted_login_attempts",
		"hosted_browser_sessions",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE ${table}`, "u"));
	}
	assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/gu) ?? []).length, 4);
	assert.match(migration, /role IN \('owner', 'admin', 'reviewer', 'viewer'\)/u);
	assert.match(migration, /state_hash text NOT NULL UNIQUE/u);
	assert.match(migration, /UPDATE public\.hosted_login_attempts/u);
	assert.match(migration, /consumed_at IS NULL/u);
	assert.match(migration, /SECURITY DEFINER/u);
	assert.match(migration, /pkce_verifier_ciphertext jsonb NOT NULL/u);
	assert.match(migration, /provider_credential_ciphertext jsonb NOT NULL/u);
	assert.doesNotMatch(migration, /access_token|refresh_token|session_token/iu);
});

test("the live GitHub App adapter sends PKCE and rotating refresh grants, then rebinds user identity", async () => {
	const calls = [];
	const responses = [
		new Response(
			JSON.stringify({
				access_token: "issued-access",
				expires_in: 28_800,
				refresh_token: "issued-refresh",
				refresh_token_expires_in: 15_552_000,
			}),
			{ status: 200 },
		),
		new Response(
			JSON.stringify({
				access_token: "rotated-access",
				expires_in: 28_800,
				refresh_token: "rotated-refresh",
				refresh_token_expires_in: 15_552_000,
			}),
			{ status: 200 },
		),
		new Response(JSON.stringify({ id: 24680, login: "octocat" }), { status: 200 }),
		new Response(JSON.stringify({ id: 24680, login: "octocat" }), { status: 200 }),
		new Response(
			JSON.stringify({
				id: 123456789,
				private: true,
				html_url: "https://github.com/clfhhc/test-graphrefly",
			}),
			{ status: 200 },
		),
	];
	const github = new GitHubAppBrowserProvider({
		clientId: "client-id",
		clientSecret: "client-secret",
		now: () => now,
		fetch: async (url, init) => {
			calls.push({ url: String(url), init });
			return responses.shift();
		},
	});
	const issued = await github.exchangeAuthorizationCode({
		code: "one-time-code",
		codeVerifier: "v".repeat(43),
		redirectUri: "https://hosted.graphrefly.dev/auth/github/callback",
		repositoryId: "123456789",
	});
	assert.equal(issued.accessExpiresAt, "2026-07-19T02:00:00.000Z");
	const exchange = Object.fromEntries(calls[0].init.body);
	assert.deepEqual(exchange, {
		client_id: "client-id",
		client_secret: "client-secret",
		code: "one-time-code",
		code_verifier: "v".repeat(43),
		redirect_uri: "https://hosted.graphrefly.dev/auth/github/callback",
		repository_id: "123456789",
	});
	await github.refreshUserCredential(issued);
	const refresh = Object.fromEntries(calls[1].init.body);
	assert.equal(refresh.grant_type, "refresh_token");
	assert.equal(refresh.refresh_token, "issued-refresh");
	assert.equal(await github.getAuthenticatedUser("issued-access").then((user) => user.id), "24680");
	assert.deepEqual(
		await github.revalidateRepositoryAccess({
			accessToken: "issued-access",
			actorProviderId: "24680",
			providerRepositoryId: "123456789",
		}),
		{
			status: "granted",
			repositoryUrl: "https://github.com/clfhhc/test-graphrefly",
		},
	);
	assert.match(calls[4].url, /\/repositories\/123456789$/u);
	assert.equal(calls[4].init.headers.Authorization, "Bearer issued-access");
});

test("the live GitHub App adapter treats identity drift, denial and transport failure as closed access", async () => {
	for (const [response, expected] of [
		[new Response(JSON.stringify({ id: 99999, login: "other" }), { status: 200 }), "denied"],
		[new Response("not found", { status: 404 }), "denied"],
	]) {
		const github = new GitHubAppBrowserProvider({
			clientId: "client-id",
			clientSecret: "client-secret",
			fetch: async () => response,
		});
		assert.deepEqual(
			await github.revalidateRepositoryAccess({
				accessToken: "token",
				actorProviderId: "24680",
				providerRepositoryId: "123456789",
			}),
			{ status: expected },
		);
	}
	const unavailable = new GitHubAppBrowserProvider({
		clientId: "client-id",
		clientSecret: "client-secret",
		fetch: async () => {
			throw new Error("network unavailable");
		},
	});
	assert.deepEqual(
		await unavailable.revalidateRepositoryAccess({
			accessToken: "token",
			actorProviderId: "24680",
			providerRepositoryId: "123456789",
		}),
		{ status: "unavailable" },
	);
});
