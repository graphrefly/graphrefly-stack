import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { HostedBrowserAuthError, type HostedBrowserAuthService } from "./browser-auth.js";
import { HostedReviewError, type HostedReviewService } from "./review.js";
import { HOSTED_REVIEW_CSS, renderHostedReviewPage } from "./web-ui.js";

const SESSION_COOKIE = "__Host-grfs_session";
const CSRF_COOKIE = "__Host-grfs_csrf";
const LOGIN_COOKIE = "__Host-grfs_login";
const MAX_JSON_BYTES = 16 * 1024;

type JsonObject = Record<string, unknown>;

function securityHeaders(contentType: string): Record<string, string> {
	return {
		"Cache-Control": "no-store",
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		"Content-Type": contentType,
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Referrer-Policy": "no-referrer",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	};
}

function json(response: ServerResponse, status: number, body: unknown): void {
	const bytes = Buffer.from(JSON.stringify(body), "utf8");
	response.writeHead(status, {
		...securityHeaders("application/json; charset=utf-8"),
		"Content-Length": String(bytes.byteLength),
	});
	response.end(bytes);
}

function html(response: ServerResponse, body: string): void {
	const bytes = Buffer.from(body, "utf8");
	response.writeHead(200, {
		...securityHeaders("text/html; charset=utf-8"),
		"Content-Security-Policy":
			"default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		"Content-Length": String(bytes.byteLength),
	});
	response.end(bytes);
}

function redirect(
	response: ServerResponse,
	status: 302 | 303,
	location: string,
	cookies?: string[],
): void {
	response.writeHead(status, {
		...securityHeaders("text/plain; charset=utf-8"),
		Location: location,
		...(cookies === undefined ? {} : { "Set-Cookie": cookies }),
	});
	response.end();
}

function cookieValues(request: IncomingMessage, name: string): string[] {
	const header = request.headers.cookie;
	if (header === undefined || header.length > 8192) return [];
	return header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`))
		.map((part) => part.slice(name.length + 1));
}

function requiredCookie(request: IncomingMessage, name: string): string {
	const values = cookieValues(request, name);
	const value = values[0];
	if (values.length !== 1 || value === undefined || value.length === 0 || value.length > 1024) {
		throw new HostedBrowserAuthError(
			401,
			"HOSTED_SESSION_INVALID",
			"session is invalid or expired",
		);
	}
	return value;
}

function sameToken(left: string, right: string): boolean {
	const first = Buffer.from(left, "utf8");
	const second = Buffer.from(right, "utf8");
	return first.byteLength === second.byteLength && timingSafeEqual(first, second);
}

function requireCsrf(request: IncomingMessage, publicOrigin: string): void {
	if (
		request.headers.origin !== publicOrigin ||
		(request.headers["sec-fetch-site"] !== undefined &&
			request.headers["sec-fetch-site"] !== "same-origin")
	) {
		throw new HostedReviewError(403, "HOSTED_CSRF_INVALID", "same-origin request is required");
	}
	const cookie = cookieValues(request, CSRF_COOKIE);
	const header = request.headers["x-graphrefly-csrf"];
	if (
		cookie.length !== 1 ||
		typeof header !== "string" ||
		header.length < 32 ||
		header.length > 256 ||
		!sameToken(cookie[0] as string, header)
	) {
		throw new HostedReviewError(403, "HOSTED_CSRF_INVALID", "CSRF token is invalid");
	}
}

function requireFormCsrf(request: IncomingMessage, publicOrigin: string, formToken: string): void {
	if (
		request.headers.origin !== publicOrigin ||
		(request.headers["sec-fetch-site"] !== undefined &&
			request.headers["sec-fetch-site"] !== "same-origin")
	) {
		throw new HostedReviewError(403, "HOSTED_CSRF_INVALID", "same-origin request is required");
	}
	const cookie = cookieValues(request, CSRF_COOKIE);
	if (
		cookie.length !== 1 ||
		formToken.length < 32 ||
		formToken.length > 256 ||
		!sameToken(cookie[0] as string, formToken)
	) {
		throw new HostedReviewError(403, "HOSTED_CSRF_INVALID", "CSRF token is invalid");
	}
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
	if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
		throw new HostedReviewError(415, "HOSTED_CONTENT_TYPE_INVALID", "application/json is required");
	}
	const declared = request.headers["content-length"];
	if (declared !== undefined) {
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_BYTES) {
			throw new HostedReviewError(413, "HOSTED_REQUEST_TOO_LARGE", "request body is too large");
		}
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > MAX_JSON_BYTES) {
			throw new HostedReviewError(413, "HOSTED_REQUEST_TOO_LARGE", "request body is too large");
		}
		chunks.push(bytes);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		throw new HostedReviewError(400, "HOSTED_REQUEST_INVALID", "request body is invalid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HostedReviewError(400, "HOSTED_REQUEST_INVALID", "request body must be an object");
	}
	return value as JsonObject;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
	if (
		!request.headers["content-type"]?.toLowerCase().startsWith("application/x-www-form-urlencoded")
	) {
		throw new HostedReviewError(415, "HOSTED_CONTENT_TYPE_INVALID", "form encoding is required");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > MAX_JSON_BYTES) {
			throw new HostedReviewError(413, "HOSTED_REQUEST_TOO_LARGE", "request body is too large");
		}
		chunks.push(bytes);
	}
	return new URLSearchParams(Buffer.concat(chunks, size).toString("utf8"));
}

function uuidPath(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function evidenceRoute(
	pathname: string,
): { tenantId: string; repositoryId: string; digest: string } | null {
	const match = pathname.match(
		/^\/api\/v1\/tenants\/([^/]+)\/repositories\/([^/]+)\/envelopes\/([0-9a-f]{64})$/u,
	);
	if (match === null || !uuidPath(match[1] as string) || !uuidPath(match[2] as string)) return null;
	return {
		tenantId: match[1] as string,
		repositoryId: match[2] as string,
		digest: match[3] as string,
	};
}

function decisionRoute(
	pathname: string,
): { tenantId: string; repositoryId: string; digest: string } | null {
	const suffix = "/decisions";
	return pathname.endsWith(suffix) ? evidenceRoute(pathname.slice(0, -suffix.length)) : null;
}

function auditRoute(pathname: string): { tenantId: string; repositoryId: string } | null {
	const match = pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/repositories\/([^/]+)\/audit$/u);
	if (match === null || !uuidPath(match[1] as string) || !uuidPath(match[2] as string)) return null;
	return { tenantId: match[1] as string, repositoryId: match[2] as string };
}

function pageRoute(
	pathname: string,
): { tenantId: string; repositoryId: string; digest: string } | null {
	return evidenceRoute(`/api/v1${pathname}`);
}

function formDecisionRoute(
	pathname: string,
): { tenantId: string; repositoryId: string; digest: string } | null {
	const prefix = "/review/v1";
	return pathname.startsWith(prefix)
		? decisionRoute(`/api/v1${pathname.slice(prefix.length)}`)
		: null;
}

export function createHostedWebHandler(options: {
	publicOrigin: string;
	auth: HostedBrowserAuthService;
	review: HostedReviewService;
	randomBytes?: (size: number) => Uint8Array;
	now?: () => Date;
}) {
	const origin = new URL(options.publicOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.origin !== options.publicOrigin ||
		origin.pathname !== "/"
	) {
		throw new Error("hosted public origin must be one exact HTTPS origin");
	}
	const secureRandom = options.randomBytes ?? randomBytes;
	const now = options.now ?? (() => new Date());
	return (request: IncomingMessage, response: ServerResponse): void => {
		void (async () => {
			try {
				const url = new URL(request.url ?? "/", options.publicOrigin);
				if (url.origin !== options.publicOrigin) {
					throw new HostedReviewError(
						400,
						"HOSTED_REQUEST_INVALID",
						"absolute request target is invalid",
					);
				}

				if (request.method === "GET" && url.pathname === "/auth/github/start") {
					const tenantId = url.searchParams.get("tenantId") ?? "";
					const repositoryId = url.searchParams.get("repositoryId") ?? undefined;
					if (!uuidPath(tenantId) || (repositoryId !== undefined && !uuidPath(repositoryId))) {
						throw new HostedReviewError(400, "HOSTED_REQUEST_INVALID", "login identity is invalid");
					}
					const browserBinding = Buffer.from(secureRandom(32)).toString("base64url");
					const login = await options.auth.beginLogin({
						tenantId,
						returnTo: url.searchParams.get("returnTo") ?? "/",
						browserBinding,
						...(repositoryId === undefined ? {} : { repositoryId }),
					});
					redirect(response, 302, login.authorizationUrl, [
						`${LOGIN_COOKIE}=${browserBinding}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
					]);
					return;
				}

				if (request.method === "GET" && url.pathname === "/auth/github/callback") {
					const login = await options.auth.completeLogin({
						state: url.searchParams.get("state") ?? "",
						code: url.searchParams.get("code") ?? "",
						browserBinding: requiredCookie(request, LOGIN_COOKIE),
					});
					const maxAge = Math.max(
						0,
						Math.floor((Date.parse(login.expiresAt) - now().getTime()) / 1000),
					);
					const csrf = Buffer.from(secureRandom(32)).toString("base64url");
					redirect(response, 303, login.returnTo, [
						`${SESSION_COOKIE}=${login.sessionToken}; Path=/; Max-Age=${maxAge}; Expires=${new Date(login.expiresAt).toUTCString()}; Secure; HttpOnly; SameSite=Lax`,
						`${CSRF_COOKIE}=${csrf}; Path=/; Max-Age=${maxAge}; Expires=${new Date(login.expiresAt).toUTCString()}; Secure; SameSite=Strict`,
						`${LOGIN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
					]);
					return;
				}

				if (request.method === "GET" && url.pathname === "/assets/hosted-review.css") {
					const bytes = Buffer.from(HOSTED_REVIEW_CSS, "utf8");
					response.writeHead(200, {
						...securityHeaders("text/css; charset=utf-8"),
						"Content-Length": String(bytes.byteLength),
					});
					response.end(bytes);
					return;
				}

				const page = pageRoute(url.pathname);
				if (request.method === "GET" && page !== null) {
					const sessionToken = requiredCookie(request, SESSION_COOKIE);
					const csrfToken = requiredCookie(request, CSRF_COOKIE);
					const projection = await options.review.readEvidence({ ...page, sessionToken });
					const apiBase = `/api/v1/tenants/${page.tenantId}/repositories/${page.repositoryId}`;
					html(
						response,
						renderHostedReviewPage({
							projection,
							...page,
							csrfToken,
							decisionAction: `/review/v1/tenants/${page.tenantId}/repositories/${page.repositoryId}/envelopes/${page.digest}/decisions`,
							auditUrl: `${apiBase}/audit`,
						}),
					);
					return;
				}

				const formDecision = formDecisionRoute(url.pathname);
				if (request.method === "POST" && formDecision !== null) {
					const form = await readForm(request);
					requireFormCsrf(request, options.publicOrigin, form.get("csrf") ?? "");
					const allowed = ["csrf", "decision", "summary", "supersedes"];
					if ([...form.keys()].some((key) => !allowed.includes(key))) {
						throw new HostedReviewError(400, "HOSTED_REQUEST_INVALID", "decision form is invalid");
					}
					const decision = form.get("decision") ?? "";
					const summary = form.get("summary") ?? "";
					const supersedes = form.get("supersedes") ?? undefined;
					await options.review.appendDecision({
						...formDecision,
						sessionToken: requiredCookie(request, SESSION_COOKIE),
						decision: decision as "approve" | "request-changes" | "defer",
						summary,
						...(supersedes === undefined || supersedes === "" ? {} : { supersedes }),
					});
					redirect(
						response,
						303,
						`/tenants/${formDecision.tenantId}/repositories/${formDecision.repositoryId}/envelopes/${formDecision.digest}#decisions`,
					);
					return;
				}

				const evidence = evidenceRoute(url.pathname);
				if (request.method === "GET" && evidence !== null) {
					json(
						response,
						200,
						await options.review.readEvidence({
							...evidence,
							sessionToken: requiredCookie(request, SESSION_COOKIE),
						}),
					);
					return;
				}

				const decision = decisionRoute(url.pathname);
				if (request.method === "POST" && decision !== null) {
					requireCsrf(request, options.publicOrigin);
					const body = await readJson(request);
					const keys = Object.keys(body);
					if (
						!keys.every((key) => ["decision", "summary", "supersedes"].includes(key)) ||
						typeof body.decision !== "string" ||
						typeof body.summary !== "string" ||
						(body.supersedes !== undefined && typeof body.supersedes !== "string")
					) {
						throw new HostedReviewError(
							400,
							"HOSTED_REQUEST_INVALID",
							"decision request is invalid",
						);
					}
					json(
						response,
						201,
						await options.review.appendDecision({
							...decision,
							sessionToken: requiredCookie(request, SESSION_COOKIE),
							decision: body.decision as "approve" | "request-changes" | "defer",
							summary: typeof body.summary === "string" ? body.summary : "",
							...(typeof body.supersedes === "string" ? { supersedes: body.supersedes } : {}),
						}),
					);
					return;
				}

				const audit = auditRoute(url.pathname);
				if (request.method === "GET" && audit !== null) {
					const beforeValue = url.searchParams.get("before");
					const limitValue = url.searchParams.get("limit");
					const exported = await options.review.exportAudit({
						...audit,
						sessionToken: requiredCookie(request, SESSION_COOKIE),
						...(beforeValue === null ? {} : { before: new Date(beforeValue) }),
						...(limitValue === null ? {} : { limit: Number(limitValue) }),
					});
					const bytes = Buffer.from(exported, "utf8");
					response.writeHead(200, {
						...securityHeaders("application/x-ndjson; charset=utf-8"),
						"Content-Length": String(bytes.byteLength),
						"Content-Disposition": 'attachment; filename="graphrefly-hosted-audit.jsonl"',
					});
					response.end(bytes);
					return;
				}

				json(response, 404, { error: { code: "NOT_FOUND", message: "not found" } });
			} catch (error) {
				if (error instanceof HostedBrowserAuthError || error instanceof HostedReviewError) {
					json(response, error.status, { error: { code: error.code, message: error.message } });
					return;
				}
				json(response, 500, {
					error: { code: "HOSTED_INTERNAL_ERROR", message: "hosted web request failed closed" },
				});
			}
		})();
	};
}

export const HOSTED_WEB_COOKIES = {
	session: SESSION_COOKIE,
	csrf: CSRF_COOKIE,
	login: LOGIN_COOKIE,
} as const;
