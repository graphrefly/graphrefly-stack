import { randomUUID } from "node:crypto";

import { HOSTED_INDEX_RETENTION_DAYS } from "@graphrefly-stack/contracts";

import type {
	HostedAccessContext,
	HostedBrowserIdentityStore,
	HostedBrowserSession,
	HostedLoginAttempt,
	HostedRole,
	SealedCredential,
} from "./browser-auth.js";
import type {
	HostedPostgresDatabase,
	HostedSqlResult,
	HostedSqlTransaction,
} from "./postgres-object-persistence.js";

export interface HostedAuthenticationDatabase extends HostedPostgresDatabase {
	authenticationTransaction<Result>(
		operation: (transaction: HostedSqlTransaction) => Promise<Result>,
	): Promise<Result>;
}

interface LoginAttemptRow extends Record<string, unknown> {
	id: string;
	tenant_id: string;
	state_hash: string;
	browser_binding_hash: string;
	pkce_verifier_ciphertext: SealedCredential;
	redirect_uri: string;
	return_to: string;
	repository_id: string | null;
	expires_at: string | Date;
}

interface SessionRow extends Record<string, unknown> {
	id: string;
	tenant_id: string;
	actor_id: string;
	actor_provider_id: string;
	token_hash: string;
	provider_credential_ciphertext: SealedCredential;
	created_at: string | Date;
	expires_at: string | Date;
	revoked_at: string | Date | null;
}

interface AccessRow extends Record<string, unknown> {
	role: HostedRole;
	selected: boolean;
	provider_repository_id: string;
}

function iso(value: string | Date): string {
	return (value instanceof Date ? value : new Date(value)).toISOString();
}

function loginAttempt(row: LoginAttemptRow): HostedLoginAttempt {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		stateHash: row.state_hash,
		browserBindingHash: row.browser_binding_hash,
		pkceVerifier: row.pkce_verifier_ciphertext,
		redirectUri: row.redirect_uri,
		returnTo: row.return_to,
		...(row.repository_id === null ? {} : { repositoryId: row.repository_id }),
		expiresAt: iso(row.expires_at),
	};
}

function session(row: SessionRow): HostedBrowserSession {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		actorId: row.actor_id,
		actorProviderId: String(row.actor_provider_id),
		tokenHash: row.token_hash,
		credential: row.provider_credential_ciphertext,
		createdAt: iso(row.created_at),
		expiresAt: iso(row.expires_at),
		revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
	};
}

export class PostgresHostedBrowserIdentityStore implements HostedBrowserIdentityStore {
	readonly #database: HostedAuthenticationDatabase;
	readonly #id: () => string;

	constructor(options: { database: HostedAuthenticationDatabase; idFactory?: () => string }) {
		this.#database = options.database;
		this.#id = options.idFactory ?? randomUUID;
	}

	createLoginAttempt(attempt: HostedLoginAttempt): Promise<void> {
		return this.#database.transaction(attempt.tenantId, async (transaction) => {
			const expiresAt = new Date(attempt.expiresAt);
			await transaction.query(
				`INSERT INTO hosted_login_attempts
         (id, tenant_id, state_hash, browser_binding_hash, pkce_verifier_ciphertext,
          redirect_uri, return_to, repository_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
				[
					attempt.id,
					attempt.tenantId,
					attempt.stateHash,
					attempt.browserBindingHash,
					JSON.stringify(attempt.pkceVerifier),
					attempt.redirectUri,
					attempt.returnTo,
					attempt.repositoryId ?? null,
					new Date(expiresAt.getTime() - 10 * 60_000),
					expiresAt,
				],
			);
		});
	}

	consumeLoginAttempt(input: {
		stateHash: string;
		browserBindingHash: string;
		now: Date;
	}): Promise<HostedLoginAttempt | null> {
		return this.#database.authenticationTransaction(async (transaction) => {
			const result = await transaction.query<LoginAttemptRow>(
				"SELECT * FROM hosted_consume_login_attempt($1, $2, $3)",
				[input.stateHash, input.browserBindingHash, input.now],
			);
			return result.rows[0] === undefined ? null : loginAttempt(result.rows[0]);
		});
	}

	upsertActor(input: {
		tenantId: string;
		provider: "github";
		providerUserId: string;
		providerLogin: string;
		now: Date;
	}): Promise<{ actorId: string }> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const result = await transaction.query<{ id: string }>(
				`INSERT INTO hosted_actors
         (id, tenant_id, provider, provider_user_id, provider_login, created_at, last_authenticated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (tenant_id, provider, provider_user_id) DO UPDATE
           SET provider_login = EXCLUDED.provider_login,
               last_authenticated_at = EXCLUDED.last_authenticated_at
         RETURNING id`,
				[
					this.#id(),
					input.tenantId,
					input.provider,
					input.providerUserId,
					input.providerLogin,
					input.now,
				],
			);
			const actorId = result.rows[0]?.id;
			if (actorId === undefined) throw new Error("PostgreSQL did not return the hosted actor");
			return { actorId };
		});
	}

	createSession(value: HostedBrowserSession): Promise<void> {
		return this.#database.transaction(value.tenantId, async (transaction) => {
			await transaction.query(
				`INSERT INTO hosted_browser_sessions
         (id, tenant_id, actor_id, token_hash, provider_credential_ciphertext,
          created_at, credential_rotated_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6, $7, $8)`,
				[
					value.id,
					value.tenantId,
					value.actorId,
					value.tokenHash,
					JSON.stringify(value.credential),
					new Date(value.createdAt),
					new Date(value.expiresAt),
					value.revokedAt === null ? null : new Date(value.revokedAt),
				],
			);
			await this.#authenticationAudit(transaction, value);
		});
	}

	recordAuthenticationRejection(input: { tenantId: string; now: Date }): Promise<void> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			await transaction.query(
				`INSERT INTO hosted_audit_events
         (id, tenant_id, actor_id, action, target_type, target_id, outcome, recorded_at, expires_at)
         VALUES ($1, $2, NULL, 'authenticate', 'tenant', $2, 'rejected', $3, $4)`,
				[
					this.#id(),
					input.tenantId,
					input.now,
					new Date(input.now.getTime() + HOSTED_INDEX_RETENTION_DAYS * 86_400_000),
				],
			);
		});
	}

	loadSession(tokenHash: string, now: Date): Promise<HostedBrowserSession | null> {
		return this.#database.authenticationTransaction(async (transaction) => {
			const result = await transaction.query<SessionRow>(
				"SELECT * FROM hosted_load_browser_session($1, $2)",
				[tokenHash, now],
			);
			return result.rows[0] === undefined ? null : session(result.rows[0]);
		});
	}

	updateSessionCredential(input: {
		tenantId: string;
		sessionId: string;
		credential: SealedCredential;
		now: Date;
	}): Promise<void> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const result = await transaction.query(
				`UPDATE hosted_browser_sessions
         SET provider_credential_ciphertext = $3::jsonb, credential_rotated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > $4
         RETURNING id`,
				[input.tenantId, input.sessionId, JSON.stringify(input.credential), input.now],
			);
			if (result.rows[0] === undefined) throw new Error("hosted session is no longer active");
		});
	}

	revokeSession(tenantId: string, sessionId: string, now: Date): Promise<void> {
		return this.#database.transaction(tenantId, async (transaction) => {
			await transaction.query(
				`UPDATE hosted_browser_sessions SET revoked_at = coalesce(revoked_at, $3)
         WHERE tenant_id = $1 AND id = $2`,
				[tenantId, sessionId, now],
			);
		});
	}

	loadAccessContext(input: {
		tenantId: string;
		actorId: string;
		repositoryId: string;
		now: Date;
	}): Promise<HostedAccessContext | null> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const result = await transaction.query<AccessRow>(
				`SELECT m.role, r.selected, r.provider_repository_id::text
         FROM hosted_memberships m
         JOIN hosted_repositories r ON r.tenant_id = m.tenant_id
         WHERE m.tenant_id = $1 AND m.actor_id = $2 AND r.id = $3
           AND m.revoked_at IS NULL`,
				[input.tenantId, input.actorId, input.repositoryId],
			);
			const row = result.rows[0];
			return row === undefined
				? null
				: {
						role: row.role,
						repositorySelected: row.selected,
						providerRepositoryId: String(row.provider_repository_id),
					};
		});
	}

	async #authenticationAudit(
		transaction: HostedSqlTransaction,
		value: HostedBrowserSession,
	): Promise<HostedSqlResult<Record<string, unknown>>> {
		const createdAt = new Date(value.createdAt);
		return transaction.query(
			`INSERT INTO hosted_audit_events
       (id, tenant_id, actor_id, action, target_type, target_id, outcome, recorded_at, expires_at)
       VALUES ($1, $2, $3, 'authenticate', 'tenant', $2, 'accepted', $4, $5)`,
			[
				this.#id(),
				value.tenantId,
				value.actorId,
				createdAt,
				new Date(createdAt.getTime() + HOSTED_INDEX_RETENTION_DAYS * 86_400_000),
			],
		);
	}
}
