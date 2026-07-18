import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
	HOSTED_OIDC_AUDIENCE,
	HOSTED_OIDC_CLAIMS_SCHEMA,
	HOSTED_OIDC_ISSUER,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

export interface JwksProvider {
	get(kid: string): Promise<JsonWebKey | null>;
}

export interface VerifiedGitHubOidcToken {
	claims: {
		schema: typeof HOSTED_OIDC_CLAIMS_SCHEMA;
		issuer: typeof HOSTED_OIDC_ISSUER;
		audience: typeof HOSTED_OIDC_AUDIENCE;
		subject: string;
		repositoryId: string;
		repositoryOwnerId: string;
		workflowRef: string;
		workflowSha: { algorithm: "sha1" | "sha256"; value: string };
		runId: string;
		runAttempt: number;
		actorId: string;
		eventName: "workflow_run";
	};
	expiresAt: Date;
}

export class HostedOidcError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HostedOidcError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HostedOidcError("HOSTED_OIDC_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
		throw new HostedOidcError("HOSTED_OIDC_INVALID", `${label} must be a bounded string`);
	}
	return value;
}

function decimalId(value: unknown, label: string): string {
	const normalized = text(value, label);
	if (!/^[1-9][0-9]*$/u.test(normalized) || normalized.length > 32) {
		throw new HostedOidcError("HOSTED_OIDC_INVALID", `${label} must be a provider ID`);
	}
	return normalized;
}

function positiveInteger(value: unknown, label: string): number {
	const number = typeof value === "string" ? Number(value) : value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
		throw new HostedOidcError("HOSTED_OIDC_INVALID", `${label} must be a positive integer`);
	}
	return number;
}

function numericDate(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new HostedOidcError("HOSTED_OIDC_INVALID", `${label} must be a NumericDate`);
	}
	return value;
}

function gitOid(value: unknown, label: string) {
	const normalized = text(value, label);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)) {
		throw new HostedOidcError("HOSTED_OIDC_INVALID", `${label} must be a Git OID`);
	}
	return {
		algorithm: normalized.length === 40 ? ("sha1" as const) : ("sha256" as const),
		value: normalized,
	};
}

function decodePart(value: string, label: string): JsonObject {
	try {
		return object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")), label);
	} catch (error) {
		if (error instanceof HostedOidcError) throw error;
		throw new HostedOidcError("HOSTED_OIDC_INVALID", `${label} is not valid JSON`);
	}
}

export class GitHubOidcVerifier {
	readonly #jwks: JwksProvider;
	readonly #now: () => Date;
	readonly #clockSkewSeconds: number;

	constructor(options: {
		jwks: JwksProvider;
		now?: () => Date;
		clockSkewSeconds?: number;
	}) {
		this.#jwks = options.jwks;
		this.#now = options.now ?? (() => new Date());
		this.#clockSkewSeconds = options.clockSkewSeconds ?? 60;
	}

	async verify(token: string): Promise<VerifiedGitHubOidcToken> {
		const parts = token.split(".");
		if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
			throw new HostedOidcError("HOSTED_OIDC_INVALID", "bearer token is not a JWT");
		}
		const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
		const header = decodePart(encodedHeader, "JWT header");
		const payload = decodePart(encodedPayload, "JWT payload");
		if (header.alg !== "RS256" || (header.typ !== undefined && header.typ !== "JWT")) {
			throw new HostedOidcError("HOSTED_OIDC_ALGORITHM_INVALID", "JWT must use RS256");
		}
		const kid = text(header.kid, "kid");
		const jwk = await this.#jwks.get(kid);
		if (jwk === null || jwk.kty !== "RSA" || (jwk.use !== undefined && jwk.use !== "sig")) {
			throw new HostedOidcError(
				"HOSTED_OIDC_KEY_UNAVAILABLE",
				"trusted signing key is unavailable",
			);
		}
		let verified = false;
		try {
			verified = verifySignature(
				"RSA-SHA256",
				Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
				createPublicKey({ key: jwk, format: "jwk" }),
				Buffer.from(encodedSignature, "base64url"),
			);
		} catch {
			throw new HostedOidcError("HOSTED_OIDC_SIGNATURE_INVALID", "JWT signature is invalid");
		}
		if (!verified) {
			throw new HostedOidcError("HOSTED_OIDC_SIGNATURE_INVALID", "JWT signature is invalid");
		}

		const now = Math.floor(this.#now().getTime() / 1000);
		const issuedAt = numericDate(payload.iat, "iat");
		const notBefore = payload.nbf === undefined ? issuedAt : numericDate(payload.nbf, "nbf");
		const expiresAt = numericDate(payload.exp, "exp");
		if (
			issuedAt > now + this.#clockSkewSeconds ||
			notBefore > now + this.#clockSkewSeconds ||
			expiresAt <= now - this.#clockSkewSeconds ||
			expiresAt - issuedAt > 15 * 60
		) {
			throw new HostedOidcError("HOSTED_OIDC_TIME_INVALID", "JWT time window is invalid");
		}
		const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
		if (
			payload.iss !== HOSTED_OIDC_ISSUER ||
			audience.length !== 1 ||
			audience[0] !== HOSTED_OIDC_AUDIENCE
		) {
			throw new HostedOidcError("HOSTED_OIDC_AUTHORITY_INVALID", "JWT authority is invalid");
		}
		if (payload.event_name !== "workflow_run") {
			throw new HostedOidcError("HOSTED_OIDC_EVENT_INVALID", "JWT event must be workflow_run");
		}

		return {
			claims: {
				schema: HOSTED_OIDC_CLAIMS_SCHEMA,
				issuer: HOSTED_OIDC_ISSUER,
				audience: HOSTED_OIDC_AUDIENCE,
				subject: text(payload.sub, "sub"),
				repositoryId: decimalId(payload.repository_id, "repository_id"),
				repositoryOwnerId: decimalId(payload.repository_owner_id, "repository_owner_id"),
				workflowRef: text(payload.workflow_ref, "workflow_ref"),
				workflowSha: gitOid(payload.workflow_sha, "workflow_sha"),
				runId: decimalId(payload.run_id, "run_id"),
				runAttempt: positiveInteger(payload.run_attempt, "run_attempt"),
				actorId: decimalId(payload.actor_id, "actor_id"),
				eventName: "workflow_run",
			},
			expiresAt: new Date(expiresAt * 1000),
		};
	}
}

export class StaticJwksProvider implements JwksProvider {
	readonly #keys: ReadonlyMap<string, JsonWebKey>;

	constructor(keys: Iterable<readonly [string, JsonWebKey]>) {
		this.#keys = new Map(keys);
	}

	async get(kid: string): Promise<JsonWebKey | null> {
		return this.#keys.get(kid) ?? null;
	}
}

export class GitHubJwksProvider implements JwksProvider {
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#expiresAt = 0;
	#keys = new Map<string, JsonWebKey>();

	constructor(options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {
		this.#fetch = options.fetchImpl ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	async get(kid: string): Promise<JsonWebKey | null> {
		if (this.#now() >= this.#expiresAt || !this.#keys.has(kid)) await this.#refresh();
		return this.#keys.get(kid) ?? null;
	}

	async #refresh(): Promise<void> {
		const response = await this.#fetch(
			"https://token.actions.githubusercontent.com/.well-known/jwks",
			{ redirect: "error", signal: AbortSignal.timeout(10_000) },
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (!response.ok || bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024) {
			throw new HostedOidcError("HOSTED_OIDC_KEY_UNAVAILABLE", "GitHub JWKS is unavailable");
		}
		let document: JsonObject;
		try {
			document = object(JSON.parse(bytes.toString("utf8")), "JWKS");
		} catch (error) {
			if (error instanceof HostedOidcError) throw error;
			throw new HostedOidcError("HOSTED_OIDC_KEY_UNAVAILABLE", "GitHub JWKS is invalid");
		}
		const keys = Array.isArray(document.keys) ? document.keys : [];
		const next = new Map<string, JsonWebKey>();
		for (const candidate of keys) {
			const record = object(candidate, "JWK");
			const key = record as JsonWebKey;
			if (typeof record.kid === "string" && key.kty === "RSA") next.set(record.kid, key);
		}
		if (next.size === 0) {
			throw new HostedOidcError("HOSTED_OIDC_KEY_UNAVAILABLE", "GitHub JWKS has no RSA keys");
		}
		this.#keys = next;
		this.#expiresAt = this.#now() + 5 * 60 * 1000;
	}
}
