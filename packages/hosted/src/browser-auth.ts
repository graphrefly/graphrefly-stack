import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type HostedRole = "owner" | "admin" | "reviewer" | "viewer";
export type HostedAction =
	| "read"
	| "append-decision"
	| "audit-export"
	| "repository-admin"
	| "tenant-admin";

export interface SealedCredential {
	version: 1;
	iv: string;
	ciphertext: string;
	tag: string;
}

export interface GitHubUserCredential {
	accessToken: string;
	accessExpiresAt: string;
	refreshToken: string;
	refreshExpiresAt: string;
}

export interface HostedLoginAttempt {
	id: string;
	tenantId: string;
	stateHash: string;
	pkceVerifier: SealedCredential;
	redirectUri: string;
	returnTo: string;
	repositoryId?: string;
	expiresAt: string;
}

export interface HostedBrowserSession {
	id: string;
	tenantId: string;
	actorId: string;
	actorProviderId: string;
	tokenHash: string;
	credential: SealedCredential;
	expiresAt: string;
	revokedAt: string | null;
}

export interface HostedAccessContext {
	role: HostedRole | null;
	repositorySelected: boolean;
	providerRepositoryId: string;
}

export interface HostedBrowserIdentityStore {
	createLoginAttempt(attempt: HostedLoginAttempt): Promise<void>;
	consumeLoginAttempt(stateHash: string, now: Date): Promise<HostedLoginAttempt | null>;
	upsertActor(input: {
		tenantId: string;
		provider: "github";
		providerUserId: string;
		providerLogin: string;
		now: Date;
	}): Promise<{ actorId: string }>;
	createSession(session: HostedBrowserSession): Promise<void>;
	loadSession(tokenHash: string, now: Date): Promise<HostedBrowserSession | null>;
	updateSessionCredential(input: {
		sessionId: string;
		credential: SealedCredential;
		now: Date;
	}): Promise<void>;
	revokeSession(sessionId: string, now: Date): Promise<void>;
	loadAccessContext(input: {
		tenantId: string;
		actorId: string;
		repositoryId: string;
		now: Date;
	}): Promise<HostedAccessContext | null>;
}

export interface GitHubBrowserProvider {
	exchangeAuthorizationCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
		repositoryId?: string;
	}): Promise<GitHubUserCredential>;
	refreshUserCredential(credential: GitHubUserCredential): Promise<GitHubUserCredential>;
	getAuthenticatedUser(accessToken: string): Promise<{ id: string; login: string }>;
	revalidateRepositoryAccess(input: {
		accessToken: string;
		actorProviderId: string;
		providerRepositoryId: string;
	}): Promise<"granted" | "denied" | "unavailable">;
}

type HostedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function objectRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`provider omitted ${key}`);
	return value;
}

function requiredSeconds(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`provider omitted ${key}`);
	}
	return value;
}

export class GitHubAppBrowserProvider implements GitHubBrowserProvider {
	readonly #clientId: string;
	readonly #clientSecret: string;
	readonly #fetch: HostedFetch;
	readonly #now: () => Date;
	readonly #tokenUrl: string;
	readonly #apiUrl: string;

	constructor(options: {
		clientId: string;
		clientSecret: string;
		fetch?: HostedFetch;
		now?: () => Date;
		tokenUrl?: string;
		apiUrl?: string;
	}) {
		if (options.clientId.length === 0 || options.clientSecret.length === 0) {
			throw new Error("GitHub App client credentials are required");
		}
		this.#clientId = options.clientId;
		this.#clientSecret = options.clientSecret;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? (() => new Date());
		this.#tokenUrl = options.tokenUrl ?? "https://github.com/login/oauth/access_token";
		this.#apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/u, "");
	}

	async exchangeAuthorizationCode(input: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
		repositoryId?: string;
	}): Promise<GitHubUserCredential> {
		return this.#token({
			client_id: this.#clientId,
			client_secret: this.#clientSecret,
			code: input.code,
			code_verifier: input.codeVerifier,
			redirect_uri: input.redirectUri,
			...(input.repositoryId === undefined ? {} : { repository_id: input.repositoryId }),
		});
	}

	async refreshUserCredential(credential: GitHubUserCredential): Promise<GitHubUserCredential> {
		return this.#token({
			client_id: this.#clientId,
			client_secret: this.#clientSecret,
			grant_type: "refresh_token",
			refresh_token: credential.refreshToken,
		});
	}

	async getAuthenticatedUser(accessToken: string): Promise<{ id: string; login: string }> {
		const response = await this.#api("/user", accessToken);
		if (!response.ok) throw new Error("GitHub user identity is unavailable");
		const value = objectRecord(await response.json());
		if (value === null || (typeof value.id !== "number" && typeof value.id !== "string")) {
			throw new Error("GitHub user identity is invalid");
		}
		const id = String(value.id);
		const login = requiredString(value, "login");
		if (!/^\d+$/u.test(id)) throw new Error("GitHub user identity is invalid");
		return { id, login };
	}

	async revalidateRepositoryAccess(input: {
		accessToken: string;
		actorProviderId: string;
		providerRepositoryId: string;
	}): Promise<"granted" | "denied" | "unavailable"> {
		try {
			const user = await this.#api("/user", input.accessToken);
			if ([401, 403, 404].includes(user.status)) return "denied";
			if (!user.ok) return "unavailable";
			const userValue = objectRecord(await user.json());
			if (userValue === null || String(userValue.id) !== input.actorProviderId) return "denied";

			const repository = await this.#api(
				`/repositories/${encodeURIComponent(input.providerRepositoryId)}`,
				input.accessToken,
			);
			if ([401, 403, 404].includes(repository.status)) return "denied";
			return repository.ok ? "granted" : "unavailable";
		} catch {
			return "unavailable";
		}
	}

	async #token(parameters: Record<string, string>): Promise<GitHubUserCredential> {
		const response = await this.#fetch(this.#tokenUrl, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(parameters),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error("GitHub credential exchange failed");
		const value = objectRecord(await response.json());
		if (value === null || typeof value.error === "string") {
			throw new Error("GitHub credential exchange failed");
		}
		const accessSeconds = requiredSeconds(value, "expires_in");
		const refreshSeconds = requiredSeconds(value, "refresh_token_expires_in");
		const now = this.#now().getTime();
		return {
			accessToken: requiredString(value, "access_token"),
			accessExpiresAt: new Date(now + accessSeconds * 1000).toISOString(),
			refreshToken: requiredString(value, "refresh_token"),
			refreshExpiresAt: new Date(now + refreshSeconds * 1000).toISOString(),
		};
	}

	#api(path: string, accessToken: string): Promise<Response> {
		return this.#fetch(`${this.#apiUrl}${path}`, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": "graphrefly-stack-hosted",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(10_000),
		});
	}
}

export class HostedBrowserAuthError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HostedBrowserAuthError";
	}
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function credentialContext(kind: "login" | "session", id: string): string {
	return `graphrefly-hosted/${kind}/${id}/v1`;
}

export class AesGcmCredentialVault {
	readonly #key: Buffer;

	constructor(key: Uint8Array) {
		if (key.byteLength !== 32) throw new Error("credential vault key must be exactly 32 bytes");
		this.#key = Buffer.from(key);
	}

	seal(value: unknown, context: string): SealedCredential {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		cipher.setAAD(Buffer.from(context, "utf8"));
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify(value), "utf8"),
			cipher.final(),
		]);
		return {
			version: 1,
			iv: base64url(iv),
			ciphertext: base64url(ciphertext),
			tag: base64url(cipher.getAuthTag()),
		};
	}

	open<T>(sealed: SealedCredential, context: string): T {
		if (sealed.version !== 1) throw new Error("unsupported credential envelope version");
		const decipher = createDecipheriv(
			"aes-256-gcm",
			this.#key,
			Buffer.from(sealed.iv, "base64url"),
		);
		decipher.setAAD(Buffer.from(context, "utf8"));
		decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
			decipher.final(),
		]);
		return JSON.parse(plaintext.toString("utf8")) as T;
	}
}

const minimumRole: Record<HostedAction, HostedRole> = {
	read: "viewer",
	"append-decision": "reviewer",
	"audit-export": "admin",
	"repository-admin": "admin",
	"tenant-admin": "owner",
};

const roleRank: Record<HostedRole, number> = { viewer: 1, reviewer: 2, admin: 3, owner: 4 };

function requireSafeReturnPath(value: string): void {
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("\\") ||
		/[\r\n]/u.test(value)
	) {
		throw new HostedBrowserAuthError(
			400,
			"HOSTED_RETURN_PATH_INVALID",
			"return path must be local",
		);
	}
}

function assertRefreshableCredential(value: GitHubUserCredential, now: Date): void {
	if (
		value.accessToken.length === 0 ||
		value.refreshToken.length === 0 ||
		!Number.isFinite(Date.parse(value.accessExpiresAt)) ||
		!Number.isFinite(Date.parse(value.refreshExpiresAt)) ||
		Date.parse(value.accessExpiresAt) <= now.getTime() ||
		Date.parse(value.accessExpiresAt) > now.getTime() + 8 * 60 * 60_000 ||
		Date.parse(value.refreshExpiresAt) <= now.getTime()
	) {
		throw new HostedBrowserAuthError(
			502,
			"HOSTED_PROVIDER_CREDENTIAL_INVALID",
			"provider did not issue a refreshable short-lived credential",
		);
	}
}

export class HostedBrowserAuthService {
	readonly #clientId: string;
	readonly #authorizeUrl: string;
	readonly #redirectUri: string;
	readonly #store: HostedBrowserIdentityStore;
	readonly #provider: GitHubBrowserProvider;
	readonly #vault: AesGcmCredentialVault;
	readonly #now: () => Date;
	readonly #id: () => string;
	readonly #random: (bytes: number) => Uint8Array;

	constructor(options: {
		clientId: string;
		redirectUri: string;
		store: HostedBrowserIdentityStore;
		provider: GitHubBrowserProvider;
		vault: AesGcmCredentialVault;
		authorizeUrl?: string;
		now?: () => Date;
		idFactory?: () => string;
		randomBytes?: (bytes: number) => Uint8Array;
	}) {
		if (options.clientId.length === 0 || !options.redirectUri.startsWith("https://")) {
			throw new Error("browser auth requires a client ID and HTTPS redirect URI");
		}
		this.#clientId = options.clientId;
		this.#redirectUri = options.redirectUri;
		this.#store = options.store;
		this.#provider = options.provider;
		this.#vault = options.vault;
		this.#authorizeUrl = options.authorizeUrl ?? "https://github.com/login/oauth/authorize";
		this.#now = options.now ?? (() => new Date());
		this.#id = options.idFactory ?? (() => crypto.randomUUID());
		this.#random = options.randomBytes ?? randomBytes;
	}

	async beginLogin(input: {
		tenantId: string;
		returnTo: string;
		repositoryId?: string;
	}): Promise<{ authorizationUrl: string; expiresAt: string }> {
		requireSafeReturnPath(input.returnTo);
		const now = this.#now();
		const id = this.#id();
		const state = base64url(this.#random(32));
		const verifier = base64url(this.#random(32));
		const challenge = base64url(createHash("sha256").update(verifier, "utf8").digest());
		const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
		await this.#store.createLoginAttempt({
			id,
			tenantId: input.tenantId,
			stateHash: sha256(state),
			pkceVerifier: this.#vault.seal(verifier, credentialContext("login", id)),
			redirectUri: this.#redirectUri,
			returnTo: input.returnTo,
			...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
			expiresAt,
		});
		const url = new URL(this.#authorizeUrl);
		url.searchParams.set("client_id", this.#clientId);
		url.searchParams.set("redirect_uri", this.#redirectUri);
		url.searchParams.set("state", state);
		url.searchParams.set("code_challenge", challenge);
		url.searchParams.set("code_challenge_method", "S256");
		return { authorizationUrl: url.toString(), expiresAt };
	}

	async completeLogin(input: {
		state: string;
		code: string;
	}): Promise<{ sessionToken: string; expiresAt: string; returnTo: string }> {
		if (
			input.state.length < 32 ||
			input.state.length > 512 ||
			input.code.length === 0 ||
			input.code.length > 1024
		) {
			throw new HostedBrowserAuthError(
				400,
				"HOSTED_LOGIN_CALLBACK_INVALID",
				"login callback is invalid",
			);
		}
		const now = this.#now();
		const attempt = await this.#store.consumeLoginAttempt(sha256(input.state), now);
		if (attempt === null) {
			throw new HostedBrowserAuthError(
				401,
				"HOSTED_LOGIN_STATE_INVALID",
				"login state is expired, unknown, or already consumed",
			);
		}
		let credential: GitHubUserCredential;
		try {
			const verifier = this.#vault.open<string>(
				attempt.pkceVerifier,
				credentialContext("login", attempt.id),
			);
			credential = await this.#provider.exchangeAuthorizationCode({
				code: input.code,
				codeVerifier: verifier,
				redirectUri: attempt.redirectUri,
				...(attempt.repositoryId === undefined ? {} : { repositoryId: attempt.repositoryId }),
			});
			assertRefreshableCredential(credential, now);
		} catch (error) {
			if (error instanceof HostedBrowserAuthError) throw error;
			throw new HostedBrowserAuthError(
				502,
				"HOSTED_PROVIDER_LOGIN_FAILED",
				"provider login failed",
			);
		}
		let providerUser: { id: string; login: string };
		try {
			providerUser = await this.#provider.getAuthenticatedUser(credential.accessToken);
		} catch {
			throw new HostedBrowserAuthError(
				502,
				"HOSTED_PROVIDER_IDENTITY_INVALID",
				"provider identity cannot be verified",
			);
		}
		if (!/^\d+$/u.test(providerUser.id) || providerUser.login.length === 0) {
			throw new HostedBrowserAuthError(
				502,
				"HOSTED_PROVIDER_IDENTITY_INVALID",
				"provider identity cannot be verified",
			);
		}
		const actor = await this.#store.upsertActor({
			tenantId: attempt.tenantId,
			provider: "github",
			providerUserId: providerUser.id,
			providerLogin: providerUser.login,
			now,
		});
		const id = this.#id();
		const sessionToken = base64url(this.#random(32));
		const expiresAt = new Date(
			Math.min(now.getTime() + 8 * 60 * 60_000, Date.parse(credential.refreshExpiresAt)),
		).toISOString();
		await this.#store.createSession({
			id,
			tenantId: attempt.tenantId,
			actorId: actor.actorId,
			actorProviderId: providerUser.id,
			tokenHash: sha256(sessionToken),
			credential: this.#vault.seal(credential, credentialContext("session", id)),
			expiresAt,
			revokedAt: null,
		});
		return { sessionToken, expiresAt, returnTo: attempt.returnTo };
	}

	async authorize(input: {
		sessionToken: string;
		tenantId: string;
		repositoryId: string;
		action: HostedAction;
	}): Promise<{ actorId: string; role: HostedRole }> {
		const now = this.#now();
		const session = await this.#store.loadSession(sha256(input.sessionToken), now);
		if (session === null || session.tenantId !== input.tenantId) {
			throw new HostedBrowserAuthError(
				401,
				"HOSTED_SESSION_INVALID",
				"session is invalid or expired",
			);
		}
		let credential: GitHubUserCredential;
		try {
			credential = this.#vault.open<GitHubUserCredential>(
				session.credential,
				credentialContext("session", session.id),
			);
			if (Date.parse(credential.refreshExpiresAt) <= now.getTime()) {
				await this.#store.revokeSession(session.id, now);
				throw new HostedBrowserAuthError(
					401,
					"HOSTED_SESSION_INVALID",
					"session is invalid or expired",
				);
			}
			if (Date.parse(credential.accessExpiresAt) <= now.getTime() + 5 * 60_000) {
				credential = await this.#provider.refreshUserCredential(credential);
				assertRefreshableCredential(credential, now);
				await this.#store.updateSessionCredential({
					sessionId: session.id,
					credential: this.#vault.seal(credential, credentialContext("session", session.id)),
					now,
				});
			}
		} catch (error) {
			if (error instanceof HostedBrowserAuthError) throw error;
			throw new HostedBrowserAuthError(
				503,
				"HOSTED_PROVIDER_UNAVAILABLE",
				"provider credential revalidation is unavailable",
			);
		}

		const context = await this.#store.loadAccessContext({
			tenantId: input.tenantId,
			actorId: session.actorId,
			repositoryId: input.repositoryId,
			now,
		});
		if (context === null || context.role === null || !context.repositorySelected) {
			throw new HostedBrowserAuthError(403, "HOSTED_ACCESS_DENIED", "hosted access is denied");
		}
		const providerAccess = await this.#provider.revalidateRepositoryAccess({
			accessToken: credential.accessToken,
			actorProviderId: session.actorProviderId,
			providerRepositoryId: context.providerRepositoryId,
		});
		if (providerAccess === "unavailable") {
			throw new HostedBrowserAuthError(
				503,
				"HOSTED_PROVIDER_UNAVAILABLE",
				"provider repository access cannot be revalidated",
			);
		}
		if (
			providerAccess !== "granted" ||
			roleRank[context.role] < roleRank[minimumRole[input.action]]
		) {
			throw new HostedBrowserAuthError(403, "HOSTED_ACCESS_DENIED", "hosted access is denied");
		}
		return { actorId: session.actorId, role: context.role };
	}
}
