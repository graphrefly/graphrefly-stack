import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/index.js";
import {
	HostedReviewError,
	HostedReviewService,
	PostgresHostedReviewStore,
} from "../../packages/hosted/dist/index.js";

const suite = JSON.parse(
	await readFile(
		new URL("../../fixtures/contracts/hosted/v1/golden-suite.json", import.meta.url),
		"utf8",
	),
);
const envelope = suite.envelope;
const digest = sha256Jcs(envelope);
const tenantId = suite.decision.tenantId;
const repositoryId = suite.decision.repositoryId;
const actorId = suite.decision.actorId;
const now = new Date("2026-07-18T20:00:00.000Z");

class FakeAuth {
	constructor() {
		this.calls = [];
		this.denied = false;
	}

	async authorize(input) {
		this.calls.push(structuredClone(input));
		if (this.denied) throw new Error("denied");
		return {
			actorId,
			role: input.action === "audit-export" ? "admin" : "reviewer",
			repositoryUrl: "https://github.com/clfhhc/test-graphrefly",
		};
	}
}

class MemoryReviewStore {
	constructor() {
		this.state = "available";
		this.decisions = [];
		this.audit = [];
	}

	async loadEvidence() {
		if (this.state !== "available") return { state: this.state, digest };
		return {
			state: "available",
			digest,
			receivedAt: "2026-07-18T19:00:00.000Z",
			profile: envelope.profile,
			canonicalBytes: Buffer.from(canonicalize(envelope)),
		};
	}

	async appendDecision(decision, audit) {
		if (decision.supersedes !== null) {
			const predecessor = this.decisions.find(
				(item) =>
					item.id === decision.supersedes &&
					item.envelopeDigest.value === decision.envelopeDigest.value,
			);
			if (predecessor === undefined) {
				throw new HostedReviewError(409, "HOSTED_SUPERSEDES_INVALID", "predecessor unavailable");
			}
		}
		this.decisions.push(structuredClone(decision));
		this.audit.push(structuredClone(audit));
	}

	async listDecisions() {
		return structuredClone(this.decisions);
	}

	async appendAudit(record) {
		this.audit.push(structuredClone(record));
	}

	async exportAudit(input) {
		return this.audit
			.filter((record) => Date.parse(record.occurredAt) < input.before.getTime())
			.slice(0, input.limit);
	}
}

function fixture() {
	const auth = new FakeAuth();
	const store = new MemoryReviewStore();
	let id = 0;
	const service = new HostedReviewService({
		auth,
		store,
		now: () => now,
		idFactory: () => `10000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
	});
	return { auth, store, service };
}

function request(overrides = {}) {
	return {
		sessionToken: "browser-session",
		tenantId,
		repositoryId,
		digest,
		...overrides,
	};
}

test("the server derives append-only decision identity from immutable evidence without changing GateResult", async () => {
	const f = fixture();
	const originalGateResult = structuredClone(envelope.payload.gateResult);
	const first = await f.service.appendDecision({
		...request(),
		decision: "approve",
		summary: "  Evidence is consistent.  ",
	});
	assert.equal(first.schema, "graphrefly.stack.hosted-decision.v1");
	assert.equal(first.identityVerified, true);
	assert.equal(first.actorId, actorId);
	assert.deepEqual(first.envelopeDigest, { algorithm: "sha256", value: digest });
	assert.deepEqual(first.gateInputDigest, envelope.source.gateInputDigest);
	assert.deepEqual(first.witnessIds, ["CONTRACTS"]);
	assert.equal(first.summary, "Evidence is consistent.");
	assert.equal(first.supersedes, null);
	assert.deepEqual(envelope.payload.gateResult, originalGateResult);

	const second = await f.service.appendDecision({
		...request(),
		decision: "request-changes",
		summary: "New evidence needs follow-up.",
		supersedes: first.id,
	});
	assert.equal(second.supersedes, first.id);
	assert.equal(f.store.decisions.length, 2, "superseding appends instead of updating");
	assert.equal(f.store.audit.filter((event) => event.action === "decision-append").length, 2);
	assert.equal(
		f.auth.calls.every((call) => call.action === "append-decision"),
		true,
	);

	await assert.rejects(
		f.service.appendDecision({
			...request(),
			decision: "defer",
			summary: "Invalid predecessor.",
			supersedes: "10000000-0000-4000-8000-999999999999",
		}),
		(error) => error.code === "HOSTED_SUPERSEDES_INVALID",
	);
});

test("the read-only projection exposes redacted evidence and decision history but no envelope bytes or mutation surface", async () => {
	const f = fixture();
	await f.service.appendDecision({
		...request(),
		decision: "approve",
		summary: "Evidence is consistent.",
	});
	const projection = await f.service.readEvidence(request());
	assert.equal(projection.state, "available");
	assert.equal(projection.upload.digest, digest);
	assert.deepEqual(projection.gateResult, envelope.payload.gateResult);
	assert.deepEqual(projection.summary, envelope.payload.summary);
	assert.deepEqual(projection.source, envelope.source);
	assert.deepEqual(projection.redaction.excludes, [
		"source-content",
		"raw-blueprint",
		"check-output",
		"credentials",
		"environment",
		"model-response",
	]);
	assert.deepEqual(projection.sourceReview, {
		provider: "github",
		url: "https://github.com/clfhhc/test-graphrefly",
	});
	assert.equal(projection.decisions.length, 1);
	const serialized = JSON.stringify(projection);
	assert.equal(serialized.includes("uploadIdentity"), false);
	assert.equal(serialized.includes("canonicalBytes"), false);
	assert.equal(serialized.includes("source-content"), true, "the exclusion label remains visible");
	assert.equal(f.store.audit.at(-1).action, "evidence-read");
	assert.equal(f.auth.calls.at(-1).action, "read");
});

test("expired, deleted and unsynced evidence have explicit non-success states and cannot accept decisions", async () => {
	for (const state of ["expired", "deleted", "not-yet-synced"]) {
		const f = fixture();
		f.store.state = state;
		const projection = await f.service.readEvidence(request());
		assert.deepEqual(projection, { state, upload: { digest } });
		assert.equal(f.store.audit.at(-1).outcome, "rejected");
		await assert.rejects(
			f.service.appendDecision({
				...request(),
				decision: "defer",
				summary: "Wait for evidence.",
			}),
			(error) =>
				error instanceof HostedReviewError &&
				error.code === "HOSTED_EVIDENCE_UNAVAILABLE" &&
				error.message.includes(state),
		);
	}
});

test("authorization denial is audited and audit export is bounded canonical JSONL", async () => {
	const f = fixture();
	f.auth.denied = true;
	await assert.rejects(f.service.readEvidence(request()), /denied/u);
	assert.equal(f.store.audit.length, 1);
	assert.deepEqual(
		{
			actorId: f.store.audit[0].actorId,
			action: f.store.audit[0].action,
			targetType: f.store.audit[0].targetType,
			outcome: f.store.audit[0].outcome,
		},
		{ actorId: null, action: "authorization-deny", targetType: "envelope", outcome: "rejected" },
	);
	f.auth.denied = false;
	const exported = await f.service.exportAudit({
		sessionToken: "browser-session",
		tenantId,
		repositoryId,
		before: new Date("2026-07-18T20:00:01.000Z"),
		limit: 100,
	});
	const lines = exported.trimEnd().split("\n");
	assert.equal(lines.length, 1);
	assert.equal(lines[0], canonicalize(JSON.parse(lines[0])));
	assert.equal(JSON.parse(lines[0]).schema, "graphrefly.stack.hosted-audit-event.v1");
	assert.equal(f.auth.calls.at(-1).action, "audit-export");
	await assert.rejects(
		f.service.exportAudit({
			sessionToken: "browser-session",
			tenantId,
			repositoryId,
			limit: 10_001,
		}),
		(error) => error.code === "HOSTED_AUDIT_EXPORT_INVALID",
	);
});

test("the review migration enforces same-envelope supersession, tenant RLS and immutable decisions", async () => {
	const migration = await readFile(
		new URL("../../packages/hosted/migrations/003_hosted_review_v1.sql", import.meta.url),
		"utf8",
	);
	assert.match(migration, /CREATE TABLE hosted_decisions/u);
	assert.match(migration, /decision IN \('approve', 'request-changes', 'defer'\)/u);
	assert.match(migration, /jsonb_array_length\(witness_ids\) > 0/u);
	assert.match(migration, /expires_at = received_at \+ interval '365 days'/u);
	assert.match(
		migration,
		/FOREIGN KEY \(tenant_id, repository_id, envelope_digest, supersedes\)[\s\S]*REFERENCES hosted_decisions/u,
	);
	assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
	assert.match(migration, /hosted_decisions_append_only/u);
	assert.doesNotMatch(migration, /UPDATE hosted_decisions/u);
});

test("the PostgreSQL review store commits a decision and its accepted audit event atomically", async () => {
	const responses = [[{ present: 1 }], [], []];
	const calls = [];
	let transactions = 0;
	const database = {
		async transaction(receivedTenantId, operation) {
			transactions += 1;
			assert.equal(receivedTenantId, tenantId);
			return operation({
				async query(sql, parameters = []) {
					calls.push({ sql, parameters });
					return { rows: responses.shift() };
				},
			});
		},
	};
	const store = new PostgresHostedReviewStore({ database, persistence: {} });
	await store.appendDecision(suite.decision, suite.auditEvent);
	assert.equal(transactions, 1);
	assert.equal(responses.length, 0);
	assert.match(calls[0].sql, /FROM hosted_envelopes/u);
	assert.match(calls[1].sql, /INSERT INTO hosted_decisions/u);
	assert.match(calls[2].sql, /INSERT INTO hosted_audit_events/u);
	assert.equal(calls[1].parameters[5], envelope.source.gateInputDigest.value);
	assert.equal(calls[2].parameters[5], suite.decision.id);
});
