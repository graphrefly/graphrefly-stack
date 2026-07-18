import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	HostedPersistenceConfigurationError,
	PostgresObjectHostedPersistence,
} from "../../packages/hosted/dist/index.js";

const tenantId = "018f0000-0000-7000-8000-000000000001";
const repositoryId = "018f0000-0000-7000-8000-000000000002";
const digest = createHash("sha256").update("content").digest("hex");
const receivedAt = new Date("2026-07-18T18:00:00.000Z");
const objectKey = `tenants/${tenantId}/repositories/${repositoryId}/envelopes/${digest}`;
const row = {
	id: "018f0000-0000-7000-8000-000000000003",
	tenant_id: tenantId,
	repository_id: repositoryId,
	digest,
	profile: "gate-summary-v1",
	byte_length: 7,
	object_key: objectKey,
	received_at: receivedAt,
	content_expires_at: new Date("2026-10-16T18:00:00.000Z"),
	gate_verdict: "pass",
	source_run_id: "29654453076",
	source_head: "1".repeat(40),
	read_denied_at: null,
	primary_purge_due_at: null,
	backup_purge_due_at: null,
	content_purged_at: null,
};

class QueueDatabase {
	constructor(responses) {
		this.responses = [...responses];
		this.calls = [];
		this.tenants = [];
	}

	async transaction(tenant, operation) {
		this.tenants.push(tenant);
		return operation({
			query: async (sql, parameters = []) => {
				this.calls.push({ sql, parameters });
				const response = this.responses.shift();
				if (response instanceof Error) throw response;
				if (response === undefined) throw new Error(`unexpected SQL: ${sql}`);
				return { rows: response };
			},
		});
	}

	async retentionTransaction(tenant, operation) {
		this.retention = true;
		return this.transaction(tenant, operation);
	}
}

class MemoryObjectStore {
	constructor(region = "us-west-2") {
		this.region = region;
		this.encryption = "provider-managed-kms";
		this.tenantScopedKeys = true;
		this.backupPurgeDays = 30;
		this.objects = new Map();
		this.puts = [];
		this.deletes = [];
	}

	async putIfAbsent(input) {
		this.puts.push(input);
		if (this.objects.has(input.key)) return "exists";
		this.objects.set(input.key, Uint8Array.from(input.bytes));
		return "created";
	}

	async get(key) {
		const value = this.objects.get(key);
		return value === undefined ? null : Uint8Array.from(value);
	}

	async delete(key) {
		this.deletes.push(key);
		this.objects.delete(key);
	}
}

function repository() {
	return {
		tenantId,
		repositoryId,
		provider: "github",
		providerRepositoryId: "123456",
		providerOwnerId: "654321",
		semanticReviewEnabled: false,
	};
}

function ingestInput() {
	return {
		repository: repository(),
		digest,
		canonicalBytes: Buffer.from("content"),
		profile: "gate-summary-v1",
		gateVerdict: "pass",
		sourceRunId: row.source_run_id,
		sourceHead: row.source_head,
		receivedAt,
		actorProviderId: "24680",
	};
}

test("the PostgreSQL migration enforces tenant isolation, immutable evidence and retention bounds", async () => {
	const migration = await readFile(
		new URL("../../packages/hosted/migrations/001_hosted_v1.sql", import.meta.url),
		"utf8",
	);
	for (const table of [
		"hosted_tenants",
		"hosted_repositories",
		"hosted_envelopes",
		"hosted_audit_events",
		"hosted_deletion_tombstones",
	]) {
		assert.match(migration, new RegExp(`CREATE TABLE ${table}`, "u"));
	}
	assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/gu) ?? []).length, 5);
	assert.equal((migration.match(/current_setting\('graphrefly\.tenant_id'/gu) ?? []).length, 10);
	assert.match(migration, /content_expires_at = received_at \+ interval '90 days'/u);
	assert.match(migration, /expires_at = recorded_at \+ interval '365 days'/u);
	assert.match(migration, /primary_purge_due_at <= read_denied_at \+ interval '24 hours'/u);
	assert.match(migration, /backup_purge_due_at <= read_denied_at \+ interval '30 days'/u);
	assert.match(migration, /hosted envelope evidence is immutable/u);
	assert.match(migration, /hosted envelope index may only be deleted by retention/u);
	assert.match(migration, /hosted append-only record is immutable/u);
	assert.match(migration, /graphrefly\.retention_purge/u);
});

test("the production adapter stores one scoped object and immutable PostgreSQL receipt", async () => {
	const database = new QueueDatabase([[], [], [{ count: "0" }], [{ bytes: "0" }], [row], []]);
	const objects = new MemoryObjectStore();
	const ids = [row.id, "018f0000-0000-7000-8000-000000000004"];
	const persistence = new PostgresObjectHostedPersistence({
		database,
		objects,
		region: "us-west-2",
		idFactory: () => ids.shift(),
	});
	const result = await persistence.ingest(ingestInput());
	assert.equal(result.status, "stored");
	assert.equal(result.receipt.digest, digest);
	assert.deepEqual(database.tenants, [tenantId]);
	assert.equal(objects.puts.length, 1);
	assert.equal(objects.puts[0].key, objectKey);
	assert.equal(objects.puts[0].digest, digest);
	assert.equal(objects.puts[0].contentType, "application/json");
	assert.deepEqual(Buffer.from(objects.objects.get(objectKey)), Buffer.from("content"));
	assert.match(database.calls[0].sql, /pg_advisory_xact_lock/u);
	assert.match(database.calls[4].sql, /INSERT INTO hosted_envelopes/u);
	assert.match(database.calls[5].sql, /INSERT INTO hosted_audit_events/u);
	assert.equal(database.calls[5].parameters[3], "24680");
	assert.equal(persistence.region(), "us-west-2");
});

test("idempotent duplicates do not rewrite object bytes and transaction failure cleans a new object", async () => {
	const objects = new MemoryObjectStore();
	objects.objects.set(objectKey, Buffer.from("content"));
	const duplicateDatabase = new QueueDatabase([[], [row], []]);
	const duplicate = new PostgresObjectHostedPersistence({
		database: duplicateDatabase,
		objects,
		region: "us-west-2",
		idFactory: () => "018f0000-0000-7000-8000-000000000004",
	});
	const duplicateResult = await duplicate.ingest(ingestInput());
	assert.equal(duplicateResult.status, "duplicate");
	assert.equal(objects.puts.length, 0);

	objects.objects.clear();
	const failedDatabase = new QueueDatabase([
		[],
		[],
		[{ count: 0 }],
		[{ bytes: 0 }],
		new Error("commit path failed"),
	]);
	const failed = new PostgresObjectHostedPersistence({
		database: failedDatabase,
		objects,
		region: "us-west-2",
		idFactory: () => row.id,
	});
	await assert.rejects(failed.ingest(ingestInput()), /commit path failed/u);
	assert.deepEqual(objects.deletes, [objectKey]);
	assert.equal(objects.objects.has(objectKey), false);
});

test("deletion denies reads immediately and primary purge removes only already-denied content", async () => {
	const deletionAt = new Date("2026-07-19T00:00:00.000Z");
	const database = new QueueDatabase([[], [row], [], [], []]);
	const objects = new MemoryObjectStore();
	objects.objects.set(objectKey, Buffer.from("content"));
	const ids = ["018f0000-0000-7000-8000-000000000005", "018f0000-0000-7000-8000-000000000006"];
	const persistence = new PostgresObjectHostedPersistence({
		database,
		objects,
		region: "us-west-2",
		idFactory: () => ids.shift(),
	});
	const deletion = await persistence.scheduleDeletion({
		tenantId,
		repositoryId,
		digest,
		actorProviderId: "24680",
		now: deletionAt,
	});
	assert.equal(deletion.status, "scheduled");
	assert.equal(deletion.primaryPurgeDueAt, "2026-07-20T00:00:00.000Z");
	assert.equal(deletion.backupPurgeDueAt, "2026-08-18T00:00:00.000Z");
	assert.match(database.calls[2].sql, /SET read_denied_at/u);
	assert.equal(objects.objects.has(objectKey), true, "access denial precedes physical purge");

	const deniedRow = {
		...row,
		read_denied_at: deletionAt,
		primary_purge_due_at: new Date("2026-07-20T00:00:00.000Z"),
		backup_purge_due_at: new Date("2026-08-18T00:00:00.000Z"),
	};
	const purgeDatabase = new QueueDatabase([[deniedRow], [], []]);
	const purger = new PostgresObjectHostedPersistence({
		database: purgeDatabase,
		objects,
		region: "us-west-2",
		idFactory: () => "018f0000-0000-7000-8000-000000000007",
	});
	assert.equal(
		await purger.purgePrimary({
			tenantId,
			now: new Date("2026-07-20T00:00:00.000Z"),
		}),
		1,
	);
	assert.equal(objects.objects.has(objectKey), false);
	assert.deepEqual(objects.deletes, [objectKey]);
});

test("reads verify object bytes and retention schedules expiry then removes 365-day metadata", async () => {
	const objects = new MemoryObjectStore();
	objects.objects.set(objectKey, Buffer.from("content"));
	const readable = new PostgresObjectHostedPersistence({
		database: new QueueDatabase([[row]]),
		objects,
		region: "us-west-2",
	});
	const stored = await readable.read({ tenantId, repositoryId, digest, now: receivedAt });
	assert.equal(stored.record.digest, digest);
	assert.deepEqual(Buffer.from(stored.canonicalBytes), Buffer.from("content"));

	objects.objects.set(objectKey, Buffer.from("corrupted"));
	const corrupted = new PostgresObjectHostedPersistence({
		database: new QueueDatabase([[row]]),
		objects,
		region: "us-west-2",
	});
	await assert.rejects(
		corrupted.read({ tenantId, repositoryId, digest, now: receivedAt }),
		/immutable content address/u,
	);

	const expiredRow = { ...row, content_expires_at: new Date("2026-10-16T18:00:00.000Z") };
	const expiryDatabase = new QueueDatabase([[expiredRow], [], []]);
	const expiry = new PostgresObjectHostedPersistence({
		database: expiryDatabase,
		objects,
		region: "us-west-2",
		idFactory: () => "018f0000-0000-7000-8000-000000000008",
	});
	assert.equal(
		await expiry.scheduleExpired({
			tenantId,
			now: new Date("2026-10-16T18:00:00.000Z"),
		}),
		1,
	);
	assert.match(expiryDatabase.calls[1].sql, /SET read_denied_at/u);
	assert.equal(expiryDatabase.calls[2].parameters[4], "envelope.expire");

	const metadataDatabase = new QueueDatabase([
		[{ count: "2" }],
		[{ count: "1" }],
		[{ count: "3" }],
	]);
	const metadata = new PostgresObjectHostedPersistence({
		database: metadataDatabase,
		objects,
		region: "us-west-2",
	});
	assert.deepEqual(
		await metadata.purgeExpiredMetadata({
			tenantId,
			now: new Date("2027-10-17T18:00:00.000Z"),
		}),
		{ auditEvents: 2, tombstones: 1, envelopeIndexes: 3 },
	);
	assert.equal(metadataDatabase.retention, true);
});

test("the production adapter rejects non-US, cross-region or weakened storage", () => {
	const database = new QueueDatabase([]);
	assert.throws(
		() =>
			new PostgresObjectHostedPersistence({
				database,
				objects: new MemoryObjectStore("eu-west-1"),
				region: "eu-west-1",
			}),
		HostedPersistenceConfigurationError,
	);
	assert.throws(
		() =>
			new PostgresObjectHostedPersistence({
				database,
				objects: new MemoryObjectStore("us-east-1"),
				region: "us-west-2",
			}),
		HostedPersistenceConfigurationError,
	);
});
