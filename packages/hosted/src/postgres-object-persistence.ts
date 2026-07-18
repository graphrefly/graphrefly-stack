import { createHash, randomUUID } from "node:crypto";

import {
	HOSTED_BACKUP_PURGE_DAYS,
	HOSTED_DAILY_UPLOAD_LIMIT,
	HOSTED_ENVELOPE_RETENTION_DAYS,
	HOSTED_INDEX_RETENTION_DAYS,
	HOSTED_PRIMARY_PURGE_HOURS,
	HOSTED_TENANT_STORAGE_LIMIT_BYTES,
} from "@graphrefly-stack/contracts";

import type {
	HostedEnvelopeRecord,
	HostedIngestReceipt,
	HostedPersistence,
	HostedPersistenceResult,
	HostedRepositoryContext,
} from "./persistence.js";

type SqlPrimitive = string | number | boolean | Date | null;

export interface HostedSqlResult<Row> {
	rows: Row[];
}

export interface HostedSqlTransaction {
	query<Row extends Record<string, unknown> = Record<string, unknown>>(
		text: string,
		parameters?: readonly SqlPrimitive[],
	): Promise<HostedSqlResult<Row>>;
}

export interface HostedPostgresDatabase {
	transaction<Result>(
		tenantId: string,
		operation: (transaction: HostedSqlTransaction) => Promise<Result>,
	): Promise<Result>;
	retentionTransaction<Result>(
		tenantId: string,
		operation: (transaction: HostedSqlTransaction) => Promise<Result>,
	): Promise<Result>;
}

export interface HostedObjectStore {
	readonly region: string;
	readonly encryption: "provider-managed-kms";
	readonly tenantScopedKeys: true;
	readonly backupPurgeDays: 30;
	putIfAbsent(input: {
		key: string;
		bytes: Uint8Array;
		contentType: "application/json";
		digest: string;
	}): Promise<"created" | "exists">;
	get(key: string): Promise<Uint8Array | null>;
	delete(key: string): Promise<void>;
}

interface EnvelopeRow extends Record<string, unknown> {
	id: string;
	tenant_id: string;
	repository_id: string;
	digest: string;
	profile: string;
	byte_length: string | number;
	object_key: string;
	received_at: string | Date;
	gate_verdict: string;
	source_run_id: string;
	source_head: string;
	content_expires_at: string | Date;
	read_denied_at: string | Date | null;
	primary_purge_due_at: string | Date | null;
	backup_purge_due_at: string | Date | null;
	content_purged_at: string | Date | null;
}

export interface HostedStoredEnvelope {
	record: HostedEnvelopeRecord;
	canonicalBytes: Uint8Array;
}

export interface HostedDeletionResult {
	status: "scheduled" | "already-denied" | "not-found";
	primaryPurgeDueAt?: string;
	backupPurgeDueAt?: string;
}

export class HostedPersistenceConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostedPersistenceConfigurationError";
	}
}

function addTime(value: Date, amount: number, unit: "hours" | "days"): Date {
	const milliseconds = amount * (unit === "hours" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
	return new Date(value.getTime() + milliseconds);
}

function safeSegment(value: string, label: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
		throw new HostedPersistenceConfigurationError(`${label} is not a safe storage identity`);
	}
	return value;
}

function objectKey(repository: HostedRepositoryContext, digest: string): string {
	return [
		"tenants",
		safeSegment(repository.tenantId, "tenant ID"),
		"repositories",
		safeSegment(repository.repositoryId, "repository ID"),
		"envelopes",
		safeSegment(digest, "envelope digest"),
	].join("/");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function number(value: string | number): number {
	const normalized = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error("PostgreSQL returned an invalid non-negative integer");
	}
	return normalized;
}

function timestamp(value: string | Date): string {
	return (value instanceof Date ? value : new Date(value)).toISOString();
}

function record(row: EnvelopeRow): HostedEnvelopeRecord {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		repositoryId: row.repository_id,
		digest: row.digest,
		profile: row.profile,
		bytes: number(row.byte_length),
		objectKey: row.object_key,
		receivedAt: timestamp(row.received_at),
		gateVerdict: row.gate_verdict,
		sourceRunId: row.source_run_id,
		sourceHead: row.source_head,
	};
}

function receipt(row: EnvelopeRow): HostedIngestReceipt {
	const value = record(row);
	return {
		id: value.id,
		digest: value.digest,
		tenantId: value.tenantId,
		repositoryId: value.repositoryId,
		receivedAt: value.receivedAt,
	};
}

async function audit(
	transaction: HostedSqlTransaction,
	input: {
		id: string;
		tenantId: string;
		repositoryId: string;
		actorProviderId: string | null;
		action: string;
		targetId: string;
		outcome: "accepted" | "rejected" | "duplicate" | "scheduled" | "purged";
		recordedAt: Date;
	},
): Promise<void> {
	await transaction.query(
		`INSERT INTO hosted_audit_events
       (id, tenant_id, repository_id, actor_provider_id, action, target_id, outcome, recorded_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			input.id,
			input.tenantId,
			input.repositoryId,
			input.actorProviderId,
			input.action,
			input.targetId,
			input.outcome,
			input.recordedAt,
			addTime(input.recordedAt, HOSTED_INDEX_RETENTION_DAYS, "days"),
		],
	);
}

export class PostgresObjectHostedPersistence implements HostedPersistence {
	readonly #database: HostedPostgresDatabase;
	readonly #objects: HostedObjectStore;
	readonly #region: string;
	readonly #id: () => string;

	constructor(options: {
		database: HostedPostgresDatabase;
		objects: HostedObjectStore;
		region: string;
		idFactory?: () => string;
	}) {
		if (!/^us-[a-z0-9-]+$/u.test(options.region) || options.objects.region !== options.region) {
			throw new HostedPersistenceConfigurationError(
				"control-plane and object storage must share one disclosed United States region",
			);
		}
		if (
			options.objects.encryption !== "provider-managed-kms" ||
			options.objects.tenantScopedKeys !== true ||
			options.objects.backupPurgeDays !== HOSTED_BACKUP_PURGE_DAYS
		) {
			throw new HostedPersistenceConfigurationError(
				"object storage must use provider-managed KMS and tenant-scoped keys",
			);
		}
		this.#database = options.database;
		this.#objects = options.objects;
		this.#region = options.region;
		this.#id = options.idFactory ?? randomUUID;
	}

	region(): string {
		return this.#region;
	}

	async ingest(input: {
		repository: HostedRepositoryContext;
		digest: string;
		canonicalBytes: Uint8Array;
		profile: string;
		gateVerdict: string;
		sourceRunId: string;
		sourceHead: string;
		receivedAt: Date;
		actorProviderId?: string;
	}): Promise<HostedPersistenceResult> {
		if (sha256(input.canonicalBytes) !== input.digest) {
			throw new Error("canonical envelope bytes do not match their content address");
		}
		const key = objectKey(input.repository, input.digest);
		let createdObject = false;
		try {
			return await this.#database.transaction(input.repository.tenantId, async (transaction) => {
				await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
					`${input.repository.tenantId}/${input.repository.repositoryId}`,
				]);
				const existing = await transaction.query<EnvelopeRow>(
					`SELECT * FROM hosted_envelopes
           WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3`,
					[input.repository.tenantId, input.repository.repositoryId, input.digest],
				);
				if (existing.rows[0] !== undefined) {
					const existingBytes = await this.#objects.get(existing.rows[0].object_key);
					if (existingBytes === null || sha256(existingBytes) !== input.digest) {
						throw new Error("stored hosted object does not match its immutable index");
					}
					await audit(transaction, {
						id: this.#id(),
						tenantId: input.repository.tenantId,
						repositoryId: input.repository.repositoryId,
						actorProviderId: input.actorProviderId ?? null,
						action: "envelope.upload",
						targetId: input.digest,
						outcome: "duplicate",
						recordedAt: input.receivedAt,
					});
					return { status: "duplicate", receipt: receipt(existing.rows[0]) };
				}
				const utcDay = `${input.receivedAt.toISOString().slice(0, 10)}T00:00:00.000Z`;
				const uploads = await transaction.query<{ count: string | number }>(
					`SELECT count(*) AS count FROM hosted_envelopes
           WHERE tenant_id = $1 AND repository_id = $2 AND received_at >= $3`,
					[input.repository.tenantId, input.repository.repositoryId, new Date(utcDay)],
				);
				const storage = await transaction.query<{ bytes: string | number }>(
					`SELECT coalesce(sum(byte_length), 0) AS bytes FROM hosted_envelopes
           WHERE tenant_id = $1 AND content_purged_at IS NULL`,
					[input.repository.tenantId],
				);
				const rateExceeded = number(uploads.rows[0]?.count ?? 0) >= HOSTED_DAILY_UPLOAD_LIMIT;
				const storageExceeded =
					number(storage.rows[0]?.bytes ?? 0) + input.canonicalBytes.byteLength >
					HOSTED_TENANT_STORAGE_LIMIT_BYTES;
				if (rateExceeded || storageExceeded) {
					await audit(transaction, {
						id: this.#id(),
						tenantId: input.repository.tenantId,
						repositoryId: input.repository.repositoryId,
						actorProviderId: input.actorProviderId ?? null,
						action: "envelope.upload",
						targetId: input.digest,
						outcome: "rejected",
						recordedAt: input.receivedAt,
					});
					return { status: rateExceeded ? "rate-limit" : "storage-limit" };
				}

				const objectStatus = await this.#objects.putIfAbsent({
					key,
					bytes: input.canonicalBytes,
					contentType: "application/json",
					digest: input.digest,
				});
				createdObject = objectStatus === "created";
				if (objectStatus === "exists") {
					const existingBytes = await this.#objects.get(key);
					if (existingBytes === null || sha256(existingBytes) !== input.digest) {
						throw new Error("existing hosted object does not match its content address");
					}
				}
				const envelopeId = this.#id();
				const inserted = await transaction.query<EnvelopeRow>(
					`INSERT INTO hosted_envelopes
           (id, tenant_id, repository_id, digest, profile, byte_length, object_key, received_at,
            content_expires_at, gate_verdict, source_run_id, source_head)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
					[
						envelopeId,
						input.repository.tenantId,
						input.repository.repositoryId,
						input.digest,
						input.profile,
						input.canonicalBytes.byteLength,
						key,
						input.receivedAt,
						addTime(input.receivedAt, HOSTED_ENVELOPE_RETENTION_DAYS, "days"),
						input.gateVerdict,
						input.sourceRunId,
						input.sourceHead,
					],
				);
				const row = inserted.rows[0];
				if (row === undefined) throw new Error("PostgreSQL did not return the stored envelope");
				await audit(transaction, {
					id: this.#id(),
					tenantId: input.repository.tenantId,
					repositoryId: input.repository.repositoryId,
					actorProviderId: input.actorProviderId ?? null,
					action: "envelope.upload",
					targetId: input.digest,
					outcome: "accepted",
					recordedAt: input.receivedAt,
				});
				return { status: "stored", receipt: receipt(row) };
			});
		} catch (error) {
			if (createdObject) await this.#objects.delete(key);
			throw error;
		}
	}

	async read(input: {
		tenantId: string;
		repositoryId: string;
		digest: string;
		now: Date;
	}): Promise<HostedStoredEnvelope | null> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const selected = await transaction.query<EnvelopeRow>(
				`SELECT * FROM hosted_envelopes
         WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3
           AND read_denied_at IS NULL AND content_purged_at IS NULL AND content_expires_at > $4`,
				[input.tenantId, input.repositoryId, input.digest, input.now],
			);
			const row = selected.rows[0];
			if (row === undefined) return null;
			const bytes = await this.#objects.get(row.object_key);
			if (bytes === null) throw new Error("hosted object is missing for an accessible index");
			if (sha256(bytes) !== row.digest) {
				throw new Error("hosted object no longer matches its immutable content address");
			}
			return { record: record(row), canonicalBytes: bytes };
		});
	}

	async scheduleDeletion(input: {
		tenantId: string;
		repositoryId: string;
		digest: string;
		actorProviderId: string;
		now: Date;
	}): Promise<HostedDeletionResult> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
				`${input.tenantId}/${input.repositoryId}`,
			]);
			const selected = await transaction.query<EnvelopeRow>(
				`SELECT * FROM hosted_envelopes
         WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3 FOR UPDATE`,
				[input.tenantId, input.repositoryId, input.digest],
			);
			const row = selected.rows[0];
			if (row === undefined) {
				await audit(transaction, {
					id: this.#id(),
					tenantId: input.tenantId,
					repositoryId: input.repositoryId,
					actorProviderId: input.actorProviderId,
					action: "envelope.delete",
					targetId: input.digest,
					outcome: "rejected",
					recordedAt: input.now,
				});
				return { status: "not-found" };
			}
			if (row.read_denied_at !== null) {
				await audit(transaction, {
					id: this.#id(),
					tenantId: input.tenantId,
					repositoryId: input.repositoryId,
					actorProviderId: input.actorProviderId,
					action: "envelope.delete",
					targetId: input.digest,
					outcome: "duplicate",
					recordedAt: input.now,
				});
				return {
					status: "already-denied",
					primaryPurgeDueAt:
						row.primary_purge_due_at === null ? undefined : timestamp(row.primary_purge_due_at),
					backupPurgeDueAt:
						row.backup_purge_due_at === null ? undefined : timestamp(row.backup_purge_due_at),
				};
			}
			const primaryPurgeDueAt = addTime(input.now, HOSTED_PRIMARY_PURGE_HOURS, "hours");
			const backupPurgeDueAt = addTime(input.now, HOSTED_BACKUP_PURGE_DAYS, "days");
			await transaction.query(
				`UPDATE hosted_envelopes
         SET read_denied_at = $4, primary_purge_due_at = $5, backup_purge_due_at = $6
         WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3`,
				[
					input.tenantId,
					input.repositoryId,
					input.digest,
					input.now,
					primaryPurgeDueAt,
					backupPurgeDueAt,
				],
			);
			await transaction.query(
				`INSERT INTO hosted_deletion_tombstones
         (id, tenant_id, repository_id, envelope_digest, requested_at, primary_purge_due_at,
          backup_purge_due_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				[
					this.#id(),
					input.tenantId,
					input.repositoryId,
					input.digest,
					input.now,
					primaryPurgeDueAt,
					backupPurgeDueAt,
					addTime(input.now, HOSTED_INDEX_RETENTION_DAYS, "days"),
				],
			);
			await audit(transaction, {
				id: this.#id(),
				tenantId: input.tenantId,
				repositoryId: input.repositoryId,
				actorProviderId: input.actorProviderId,
				action: "envelope.delete",
				targetId: input.digest,
				outcome: "scheduled",
				recordedAt: input.now,
			});
			return {
				status: "scheduled",
				primaryPurgeDueAt: primaryPurgeDueAt.toISOString(),
				backupPurgeDueAt: backupPurgeDueAt.toISOString(),
			};
		});
	}

	async purgePrimary(input: { tenantId: string; now: Date; limit?: number }): Promise<number> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const due = await transaction.query<EnvelopeRow>(
				`SELECT * FROM hosted_envelopes
         WHERE tenant_id = $1 AND read_denied_at IS NOT NULL AND content_purged_at IS NULL
           AND primary_purge_due_at <= $2
         ORDER BY primary_purge_due_at, id
         LIMIT $3 FOR UPDATE SKIP LOCKED`,
				[input.tenantId, input.now, input.limit ?? 100],
			);
			for (const row of due.rows) {
				await this.#objects.delete(row.object_key);
				await transaction.query(
					`UPDATE hosted_envelopes SET content_purged_at = $4
           WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3`,
					[row.tenant_id, row.repository_id, row.digest, input.now],
				);
				await audit(transaction, {
					id: this.#id(),
					tenantId: row.tenant_id,
					repositoryId: row.repository_id,
					actorProviderId: null,
					action: "envelope.purge-primary",
					targetId: row.digest,
					outcome: "purged",
					recordedAt: input.now,
				});
			}
			return due.rows.length;
		});
	}

	async scheduleExpired(input: { tenantId: string; now: Date; limit?: number }): Promise<number> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const expired = await transaction.query<EnvelopeRow>(
				`SELECT * FROM hosted_envelopes
         WHERE tenant_id = $1 AND content_expires_at <= $2 AND read_denied_at IS NULL
         ORDER BY content_expires_at, id
         LIMIT $3 FOR UPDATE SKIP LOCKED`,
				[input.tenantId, input.now, input.limit ?? 100],
			);
			for (const row of expired.rows) {
				const primaryPurgeDueAt = addTime(input.now, HOSTED_PRIMARY_PURGE_HOURS, "hours");
				const backupPurgeDueAt = addTime(input.now, HOSTED_BACKUP_PURGE_DAYS, "days");
				await transaction.query(
					`UPDATE hosted_envelopes
           SET read_denied_at = $4, primary_purge_due_at = $5, backup_purge_due_at = $6
           WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3`,
					[
						row.tenant_id,
						row.repository_id,
						row.digest,
						input.now,
						primaryPurgeDueAt,
						backupPurgeDueAt,
					],
				);
				await audit(transaction, {
					id: this.#id(),
					tenantId: row.tenant_id,
					repositoryId: row.repository_id,
					actorProviderId: null,
					action: "envelope.expire",
					targetId: row.digest,
					outcome: "scheduled",
					recordedAt: input.now,
				});
			}
			return expired.rows.length;
		});
	}

	async purgeExpiredMetadata(input: { tenantId: string; now: Date }): Promise<{
		auditEvents: number;
		tombstones: number;
		envelopeIndexes: number;
	}> {
		return this.#database.retentionTransaction(input.tenantId, async (transaction) => {
			const auditEvents = await transaction.query<{ count: string | number }>(
				`WITH removed AS (
           DELETE FROM hosted_audit_events WHERE tenant_id = $1 AND expires_at <= $2 RETURNING 1
         ) SELECT count(*) AS count FROM removed`,
				[input.tenantId, input.now],
			);
			const tombstones = await transaction.query<{ count: string | number }>(
				`WITH removed AS (
           DELETE FROM hosted_deletion_tombstones
           WHERE tenant_id = $1 AND expires_at <= $2 RETURNING 1
         ) SELECT count(*) AS count FROM removed`,
				[input.tenantId, input.now],
			);
			const envelopeIndexes = await transaction.query<{ count: string | number }>(
				`WITH removed AS (
           DELETE FROM hosted_envelopes
           WHERE tenant_id = $1 AND content_purged_at IS NOT NULL
             AND received_at + interval '365 days' <= $2
           RETURNING 1
         ) SELECT count(*) AS count FROM removed`,
				[input.tenantId, input.now],
			);
			return {
				auditEvents: number(auditEvents.rows[0]?.count ?? 0),
				tombstones: number(tombstones.rows[0]?.count ?? 0),
				envelopeIndexes: number(envelopeIndexes.rows[0]?.count ?? 0),
			};
		});
	}
}
