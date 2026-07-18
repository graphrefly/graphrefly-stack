import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import { createHostedWebHandler, HOSTED_WEB_COOKIES } from "../../packages/hosted/dist/index.js";

const publicOrigin = "https://hosted.graphrefly.dev";
const tenantId = "018f0000-0000-7000-8000-000000000001";
const repositoryId = "018f0000-0000-7000-8000-000000000002";
const digest = "a".repeat(64);
const now = new Date("2026-07-18T20:00:00.000Z");

class FakeAuth {
	constructor() {
		this.beginCalls = [];
		this.completeCalls = [];
	}

	async beginLogin(input) {
		this.beginCalls.push(structuredClone(input));
		return {
			authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
			expiresAt: "2026-07-18T20:10:00.000Z",
		};
	}

	async completeLogin(input) {
		this.completeCalls.push(structuredClone(input));
		return {
			sessionToken: "opaque-session-secret",
			expiresAt: "2026-07-18T21:00:00.000Z",
			returnTo: `/tenants/${tenantId}/repositories/${repositoryId}`,
		};
	}
}

class FakeReview {
	constructor() {
		this.readCalls = [];
		this.decisionCalls = [];
		this.auditCalls = [];
	}

	async readEvidence(input) {
		this.readCalls.push(structuredClone(input));
		return (
			this.projection ?? {
				state: "available",
				upload: { digest: input.digest },
				gateResult: { verdict: "pass" },
			}
		);
	}

	async appendDecision(input) {
		this.decisionCalls.push(structuredClone(input));
		return {
			schema: "graphrefly.stack.hosted-decision.v1",
			id: "018f0000-0000-7000-8000-000000000010",
			decision: input.decision,
			summary: input.summary,
		};
	}

	async exportAudit(input) {
		this.auditCalls.push(structuredClone(input));
		return '{"schema":"graphrefly.stack.hosted-audit-event.v1"}\n';
	}
}

async function fixture(run) {
	const auth = new FakeAuth();
	const review = new FakeReview();
	const server = createServer(
		createHostedWebHandler({
			publicOrigin,
			auth,
			review,
			now: () => now,
			randomBytes: () => Buffer.alloc(32, 7),
		}),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		await run({ server, auth, review });
	} finally {
		server.close();
		await once(server, "close");
	}
}

function send(server, input) {
	const address = server.address();
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port: address.port,
				method: input.method ?? "GET",
				path: input.path,
				headers: input.headers,
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => {
					const body = Buffer.concat(chunks).toString("utf8");
					resolve({ status: response.statusCode, headers: response.headers, body });
				});
			},
		);
		request.on("error", reject);
		if (input.body !== undefined) request.end(input.body);
		else request.end();
	});
}

test("login start binds provider-neutral identities and redirects only to the generated GitHub URL", async () => {
	await fixture(async ({ server, auth }) => {
		const response = await send(server, {
			path: `/auth/github/start?tenantId=${tenantId}&repositoryId=${repositoryId}&returnTo=%2Frepositories%2Fstack`,
		});
		assert.equal(response.status, 302);
		assert.equal(
			response.headers.location,
			"https://github.com/login/oauth/authorize?state=opaque",
		);
		assert.deepEqual(auth.beginCalls, [
			{
				tenantId,
				repositoryId,
				returnTo: "/repositories/stack",
				browserBinding: Buffer.alloc(32, 7).toString("base64url"),
			},
		]);
		assert.match(
			response.headers["set-cookie"][0],
			/^__Host-grfs_login=.*HttpOnly; SameSite=Lax$/u,
		);
		assert.equal(response.headers["cache-control"], "no-store");
		assert.equal(response.headers["x-frame-options"], "DENY");
		assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/u);
	});
});

test("login callback issues host-only secure session and CSRF cookies without exposing credentials", async () => {
	await fixture(async ({ server, auth }) => {
		const binding = Buffer.alloc(32, 7).toString("base64url");
		const response = await send(server, {
			path: `/auth/github/callback?state=${"s".repeat(43)}&code=one-time-code`,
			headers: { Cookie: `${HOSTED_WEB_COOKIES.login}=${binding}` },
		});
		assert.equal(response.status, 303);
		assert.deepEqual(auth.completeCalls, [
			{ state: "s".repeat(43), code: "one-time-code", browserBinding: binding },
		]);
		assert.equal(response.headers.location, `/tenants/${tenantId}/repositories/${repositoryId}`);
		assert.equal(response.headers["set-cookie"].length, 3);
		const session = response.headers["set-cookie"].find((cookie) =>
			cookie.startsWith(`${HOSTED_WEB_COOKIES.session}=`),
		);
		const csrf = response.headers["set-cookie"].find((cookie) =>
			cookie.startsWith(`${HOSTED_WEB_COOKIES.csrf}=`),
		);
		assert.match(session, /opaque-session-secret; Path=\/; Max-Age=3600;/u);
		assert.match(session, /Secure; HttpOnly; SameSite=Lax$/u);
		assert.doesNotMatch(session, /Domain=/u);
		assert.match(csrf, /Secure; SameSite=Strict$/u);
		assert.doesNotMatch(csrf, /HttpOnly|Domain=/u);
		assert.match(response.headers["set-cookie"].at(-1), /^__Host-grfs_login=;.*Max-Age=0/u);
		assert.equal(response.body.includes("opaque-session-secret"), false);
	});
});

test("callback without the initiating browser binding fails before provider exchange", async () => {
	await fixture(async ({ server, auth }) => {
		const response = await send(server, {
			path: `/auth/github/callback?state=${"s".repeat(43)}&code=one-time-code`,
		});
		assert.equal(response.status, 401);
		assert.equal(JSON.parse(response.body).error.code, "HOSTED_SESSION_INVALID");
		assert.equal(auth.completeCalls.length, 0);
	});
});

test("evidence and audit reads require exactly one session cookie and remain no-store", async () => {
	await fixture(async ({ server, review }) => {
		const path = `/api/v1/tenants/${tenantId}/repositories/${repositoryId}/envelopes/${digest}`;
		const accepted = await send(server, {
			path,
			headers: { Cookie: `${HOSTED_WEB_COOKIES.session}=opaque-session-secret` },
		});
		assert.equal(accepted.status, 200);
		assert.equal(JSON.parse(accepted.body).gateResult.verdict, "pass");
		assert.equal(accepted.headers["cache-control"], "no-store");
		assert.equal(review.readCalls[0].sessionToken, "opaque-session-secret");

		const duplicate = await send(server, {
			path,
			headers: {
				Cookie: `${HOSTED_WEB_COOKIES.session}=first; ${HOSTED_WEB_COOKIES.session}=second`,
			},
		});
		assert.equal(duplicate.status, 401);
		assert.equal(JSON.parse(duplicate.body).error.code, "HOSTED_SESSION_INVALID");

		const audit = await send(server, {
			path: `/api/v1/tenants/${tenantId}/repositories/${repositoryId}/audit?limit=25`,
			headers: { Cookie: `${HOSTED_WEB_COOKIES.session}=opaque-session-secret` },
		});
		assert.equal(audit.status, 200);
		assert.match(audit.headers["content-type"], /application\/x-ndjson/u);
		assert.equal(review.auditCalls[0].limit, 25);
	});
});

test("decision mutation requires exact origin, same-origin fetch metadata and matching double-submit CSRF", async () => {
	await fixture(async ({ server, review }) => {
		const path = `/api/v1/tenants/${tenantId}/repositories/${repositoryId}/envelopes/${digest}/decisions`;
		const body = JSON.stringify({ decision: "approve", summary: "Evidence is consistent." });
		const baseHeaders = {
			"Content-Type": "application/json",
			Cookie: `${HOSTED_WEB_COOKIES.session}=opaque-session-secret; ${HOSTED_WEB_COOKIES.csrf}=csrf-token-${"x".repeat(32)}`,
			"X-GraphReFly-CSRF": `csrf-token-${"x".repeat(32)}`,
		};
		for (const headers of [
			baseHeaders,
			{ ...baseHeaders, Origin: "https://evil.test" },
			{ ...baseHeaders, Origin: publicOrigin, "Sec-Fetch-Site": "cross-site" },
			{ ...baseHeaders, Origin: publicOrigin, "X-GraphReFly-CSRF": `wrong-${"x".repeat(32)}` },
		]) {
			const response = await send(server, { method: "POST", path, headers, body });
			assert.equal(response.status, 403);
			assert.equal(JSON.parse(response.body).error.code, "HOSTED_CSRF_INVALID");
		}
		assert.equal(review.decisionCalls.length, 0);

		const accepted = await send(server, {
			method: "POST",
			path,
			headers: { ...baseHeaders, Origin: publicOrigin, "Sec-Fetch-Site": "same-origin" },
			body,
		});
		assert.equal(accepted.status, 201);
		assert.equal(review.decisionCalls.length, 1);
		assert.deepEqual(
			{
				decision: review.decisionCalls[0].decision,
				summary: review.decisionCalls[0].summary,
				sessionToken: review.decisionCalls[0].sessionToken,
			},
			{
				decision: "approve",
				summary: "Evidence is consistent.",
				sessionToken: "opaque-session-secret",
			},
		);
	});
});

test("the hosted review page renders an evidence-first responsive ledger and posts append-only decisions", async () => {
	await fixture(async ({ server, review }) => {
		review.projection = {
			state: "available",
			upload: {
				digest,
				receivedAt: "2026-07-18T20:00:00.000Z",
				profile: "gate-summary-v1",
			},
			gateResult: {
				verdict: "blocked",
				units: [
					{
						workUnitId: "CONTRACTS",
						verdict: "invalid",
						reasonCodes: ["ARCHITECTURE_STALE"],
					},
				],
			},
			summary: {
				affectedWorkUnitIds: ["CONTRACTS"],
				reasonCodes: ["ARCHITECTURE_STALE"],
			},
			source: {
				runId: "987654321",
				runAttempt: 2,
				head: { value: "2".repeat(40) },
				gateInputDigest: { value: "3".repeat(64) },
			},
			redaction: {
				includes: [{ path: "ci/gate-summary.json", digest: { value: "4".repeat(64) } }],
				excludes: ["source-content", "credentials"],
			},
			access: { role: "reviewer" },
			sourceReview: { provider: "github", url: "https://github.com/clfhhc/test-graphrefly" },
			decisions: [],
		};
		const csrf = `csrf-token-${"x".repeat(32)}`;
		const cookies = `${HOSTED_WEB_COOKIES.session}=opaque-session-secret; ${HOSTED_WEB_COOKIES.csrf}=${csrf}`;
		const path = `/tenants/${tenantId}/repositories/${repositoryId}/envelopes/${digest}`;
		const page = await send(server, { path, headers: { Cookie: cookies } });
		assert.equal(page.status, 200);
		assert.match(page.headers["content-type"], /text\/html/u);
		assert.match(page.headers["content-security-policy"], /style-src 'self'; form-action 'self'/u);
		assert.match(page.body, /Upload[\s\S]*available[\s\S]*GateResult[\s\S]*blocked/u);
		assert.match(page.body, /ARCHITECTURE_STALE/u);
		assert.match(page.body, /Open repository source review/u);
		assert.match(page.body, /Append decision/u);
		assert.doesNotMatch(page.body, /Export audit/u);
		assert.doesNotMatch(page.body, /<script/u);

		const css = await send(server, { path: "/assets/hosted-review.css" });
		assert.equal(css.status, 200);
		assert.match(css.body, /evidence-spine/u);
		assert.match(css.body, /@media\(max-width:760px\)/u);
		assert.match(css.body, /prefers-reduced-motion/u);

		const form = new URLSearchParams({
			csrf,
			decision: "request-changes",
			summary: "Refresh the architecture witnesses.",
		}).toString();
		const posted = await send(server, {
			method: "POST",
			path: `/review/v1/tenants/${tenantId}/repositories/${repositoryId}/envelopes/${digest}/decisions`,
			headers: {
				Origin: publicOrigin,
				"Sec-Fetch-Site": "same-origin",
				"Content-Type": "application/x-www-form-urlencoded",
				"Content-Length": String(Buffer.byteLength(form)),
				Cookie: cookies,
			},
			body: form,
		});
		assert.equal(posted.status, 303);
		assert.match(posted.headers.location, /#decisions$/u);
		assert.equal(review.decisionCalls.at(-1).decision, "request-changes");
	});
});

test("rendered evidence escapes provider and decision text instead of creating active content", async () => {
	await fixture(async ({ server, review }) => {
		review.projection = {
			state: "available",
			upload: { digest, profile: "gate-summary-v1" },
			gateResult: { verdict: "pass", units: [] },
			summary: { affectedWorkUnitIds: [], reasonCodes: [] },
			source: { head: { value: '<img src=x onerror="alert(1)">' }, gateInputDigest: {} },
			redaction: { includes: [], excludes: [] },
			access: { role: "viewer" },
			sourceReview: { url: "https://github.com/clfhhc/test-graphrefly" },
			decisions: [{ decision: "approve", summary: "<script>alert(1)</script>" }],
		};
		const response = await send(server, {
			path: `/tenants/${tenantId}/repositories/${repositoryId}/envelopes/${digest}`,
			headers: {
				Cookie: `${HOSTED_WEB_COOKIES.session}=session; ${HOSTED_WEB_COOKIES.csrf}=${"x".repeat(43)}`,
			},
		});
		assert.equal(response.status, 200);
		assert.match(response.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
		assert.doesNotMatch(response.body, /<script|<img/u);
		assert.match(response.body, /Viewer access is read-only/u);
		assert.doesNotMatch(response.body, /Append decision/u);
	});
});

test("malformed paths, oversized writes and non-HTTPS public origins fail closed", async () => {
	assert.throws(
		() =>
			createHostedWebHandler({
				publicOrigin: "http://hosted.graphrefly.dev",
				auth: new FakeAuth(),
				review: new FakeReview(),
			}),
		/exact HTTPS origin/u,
	);
	await fixture(async ({ server }) => {
		const missing = await send(server, { path: "/api/v1/tenants/not-a-uuid" });
		assert.equal(missing.status, 404);
		const oversized = await send(server, {
			method: "POST",
			path: `/api/v1/tenants/${tenantId}/repositories/${repositoryId}/envelopes/${digest}/decisions`,
			headers: {
				Origin: publicOrigin,
				"Content-Type": "application/json",
				"Content-Length": String(16 * 1024 + 1),
				Cookie: `${HOSTED_WEB_COOKIES.session}=session; ${HOSTED_WEB_COOKIES.csrf}=${"x".repeat(43)}`,
				"X-GraphReFly-CSRF": "x".repeat(43),
			},
			body: "{}",
		});
		assert.equal(oversized.status, 413);
		assert.equal(JSON.parse(oversized.body).error.code, "HOSTED_REQUEST_TOO_LARGE");
	});
});

test("the web migration consumes OAuth state only with its initiating browser binding", async () => {
	const migration = await readFile(
		new URL("../../packages/hosted/migrations/004_hosted_web_v1.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /ADD COLUMN browser_binding_hash text/u);
	assert.match(migration, /DELETE FROM hosted_login_attempts/u);
	assert.match(migration, /ALTER COLUMN browser_binding_hash SET NOT NULL/u);
	assert.match(migration, /requested_browser_binding_hash text/u);
	assert.match(migration, /browser_binding_hash = requested_browser_binding_hash/u);
	assert.match(migration, /consumed_at IS NULL/u);
	assert.match(migration, /SECURITY DEFINER/u);
	assert.match(migration, /REVOKE ALL[\s\S]*FROM PUBLIC/u);
});
