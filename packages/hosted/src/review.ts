import { randomUUID } from "node:crypto";

import {
	canonicalize,
	HOSTED_AUDIT_EVENT_SCHEMA,
	HOSTED_DECISION_SCHEMA,
	HOSTED_INDEX_RETENTION_DAYS,
} from "@graphrefly-stack/contracts";

import type { HostedBrowserAuthService } from "./browser-auth.js";
import type {
	HostedPostgresDatabase,
	HostedSqlTransaction,
	PostgresObjectHostedPersistence,
} from "./postgres-object-persistence.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };
type DecisionValue = "approve" | "request-changes" | "defer";
type AuditAction =
	| "authenticate"
	| "membership-change"
	| "repository-link"
	| "upload"
	| "evidence-read"
	| "decision-append"
	| "authorization-deny"
	| "delete";
type AuditTarget = "tenant" | "membership" | "repository" | "envelope" | "decision";

export interface HostedDecisionRecord {
	schema: typeof HOSTED_DECISION_SCHEMA;
	id: string;
	tenantId: string;
	repositoryId: string;
	actorId: string;
	identityVerified: true;
	envelopeDigest: Hash;
	gateInputDigest: Hash;
	witnessIds: string[];
	decision: DecisionValue;
	summary: string;
	supersedes: string | null;
	receivedAt: string;
}

export interface HostedAuditRecord {
	schema: typeof HOSTED_AUDIT_EVENT_SCHEMA;
	id: string;
	tenantId: string;
	actorId: string | null;
	action: AuditAction;
	targetType: AuditTarget;
	targetId: string;
	outcome: "accepted" | "rejected";
	occurredAt: string;
}

export type HostedEvidenceState = "available" | "expired" | "deleted" | "not-yet-synced";

export interface HostedEvidenceSnapshot {
	state: HostedEvidenceState;
	digest: string;
	receivedAt?: string;
	profile?: string;
	canonicalBytes?: Uint8Array;
}

export interface HostedReviewStore {
	loadEvidence(input: {
		tenantId: string;
		repositoryId: string;
		digest: string;
		now: Date;
	}): Promise<HostedEvidenceSnapshot>;
	appendDecision(decision: HostedDecisionRecord, audit: HostedAuditRecord): Promise<void>;
	listDecisions(input: {
		tenantId: string;
		repositoryId: string;
		digest: string;
	}): Promise<HostedDecisionRecord[]>;
	appendAudit(record: HostedAuditRecord): Promise<void>;
	exportAudit(input: {
		tenantId: string;
		before: Date;
		limit: number;
	}): Promise<HostedAuditRecord[]>;
}

export class HostedReviewError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HostedReviewError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HostedReviewError(500, "HOSTED_EVIDENCE_INVALID", `${label} is invalid`);
	}
	return value as JsonObject;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new HostedReviewError(500, "HOSTED_EVIDENCE_INVALID", `${label} is invalid`);
	}
	return value;
}

function gateResult(envelope: JsonObject): JsonObject {
	const payload = object(envelope.payload, "hosted payload");
	if (envelope.profile === "semantic-review-v1") {
		return object(
			object(object(payload.bundle, "CI bundle").result, "CI result").gateResult,
			"GateResult",
		);
	}
	return object(payload.gateResult, "GateResult");
}

function evidenceIdentity(envelope: JsonObject): { gateInputDigest: Hash; witnessIds: string[] } {
	const source = object(envelope.source, "hosted source");
	const digest = object(source.gateInputDigest, "GateInput digest");
	const result = gateResult(envelope);
	const units = Array.isArray(result.units) ? result.units : [];
	const witnessIds = [
		...new Set(
			units.map((unit) => string(object(unit, "GateResult unit").workUnitId, "work unit ID")),
		),
	].sort();
	if (witnessIds.length === 0) {
		throw new HostedReviewError(
			500,
			"HOSTED_EVIDENCE_INVALID",
			"GateResult has no witness identities",
		);
	}
	return {
		gateInputDigest: {
			algorithm: "sha256",
			value: string(digest.value, "GateInput digest value"),
		},
		witnessIds,
	};
}

function projectionSummary(envelope: JsonObject, result: JsonObject): JsonObject {
	const payload = object(envelope.payload, "hosted payload");
	if (
		typeof payload.summary === "object" &&
		payload.summary !== null &&
		!Array.isArray(payload.summary)
	) {
		return payload.summary as JsonObject;
	}
	const units = Array.isArray(result.units)
		? result.units.map((unit) => object(unit, "GateResult unit"))
		: [];
	return {
		verdict: result.verdict,
		affectedWorkUnitIds: units
			.filter((unit) => unit.verdict !== "valid")
			.map((unit) => string(unit.workUnitId, "work unit ID")),
		reasonCodes: [
			...new Set(
				units.flatMap((unit) =>
					Array.isArray(unit.reasonCodes)
						? unit.reasonCodes.map((reason) => string(reason, "reason"))
						: [],
				),
			),
		],
	};
}

function parseEnvelope(bytes: Uint8Array): JsonObject {
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		throw new HostedReviewError(500, "HOSTED_EVIDENCE_INVALID", "stored evidence is not JSON");
	}
	return object(value, "hosted envelope");
}

function boundedSummary(value: string): string {
	const normalized = value.trim();
	const forbiddenControl = [...normalized].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
	});
	if (normalized.length === 0 || normalized.length > 1000 || forbiddenControl) {
		throw new HostedReviewError(400, "HOSTED_DECISION_INVALID", "decision summary is invalid");
	}
	return normalized;
}

function requireInternalId(value: string, label: string): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
		throw new HostedReviewError(400, "HOSTED_REQUEST_INVALID", `${label} is invalid`);
	}
}

function requireDigest(value: string): void {
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		throw new HostedReviewError(400, "HOSTED_REQUEST_INVALID", "envelope digest is invalid");
	}
}

export class HostedReviewService {
	readonly #auth: HostedBrowserAuthService;
	readonly #store: HostedReviewStore;
	readonly #now: () => Date;
	readonly #id: () => string;

	constructor(options: {
		auth: HostedBrowserAuthService;
		store: HostedReviewStore;
		now?: () => Date;
		idFactory?: () => string;
	}) {
		this.#auth = options.auth;
		this.#store = options.store;
		this.#now = options.now ?? (() => new Date());
		this.#id = options.idFactory ?? randomUUID;
	}

	async readEvidence(input: {
		sessionToken: string;
		tenantId: string;
		repositoryId: string;
		digest: string;
	}): Promise<JsonObject> {
		requireInternalId(input.tenantId, "tenant ID");
		requireInternalId(input.repositoryId, "repository ID");
		requireDigest(input.digest);
		const actorId = await this.#authorize(input, "read", "envelope", input.digest);
		const now = this.#now();
		const evidence = await this.#store.loadEvidence({ ...input, now });
		if (evidence.state !== "available" || evidence.canonicalBytes === undefined) {
			await this.#audit(
				input.tenantId,
				actorId,
				"evidence-read",
				"envelope",
				input.digest,
				"rejected",
			);
			return { state: evidence.state, upload: { digest: input.digest } };
		}
		const envelope = parseEnvelope(evidence.canonicalBytes);
		const result = gateResult(envelope);
		const decisions = await this.#store.listDecisions(input);
		await this.#audit(
			input.tenantId,
			actorId,
			"evidence-read",
			"envelope",
			input.digest,
			"accepted",
		);
		return {
			state: "available",
			upload: {
				digest: input.digest,
				receivedAt: evidence.receivedAt,
				profile: evidence.profile,
			},
			gateResult: result,
			summary: projectionSummary(envelope, result),
			source: object(envelope.source, "hosted source"),
			redaction: object(envelope.redaction, "hosted redaction"),
			decisions,
			sourceReview: { provider: "github", repositoryId: input.repositoryId },
		};
	}

	async appendDecision(input: {
		sessionToken: string;
		tenantId: string;
		repositoryId: string;
		digest: string;
		decision: DecisionValue;
		summary: string;
		supersedes?: string;
	}): Promise<HostedDecisionRecord> {
		requireInternalId(input.tenantId, "tenant ID");
		requireInternalId(input.repositoryId, "repository ID");
		requireDigest(input.digest);
		if (input.supersedes !== undefined)
			requireInternalId(input.supersedes, "predecessor decision ID");
		const actorId = await this.#authorize(input, "append-decision", "envelope", input.digest);
		try {
			if (!(["approve", "request-changes", "defer"] as const).includes(input.decision)) {
				throw new HostedReviewError(400, "HOSTED_DECISION_INVALID", "decision value is invalid");
			}
			const summary = boundedSummary(input.summary);
			const now = this.#now();
			const evidence = await this.#store.loadEvidence({ ...input, now });
			if (evidence.state !== "available" || evidence.canonicalBytes === undefined) {
				throw new HostedReviewError(
					409,
					"HOSTED_EVIDENCE_UNAVAILABLE",
					`evidence is ${evidence.state}`,
				);
			}
			const identity = evidenceIdentity(parseEnvelope(evidence.canonicalBytes));
			const decision: HostedDecisionRecord = {
				schema: HOSTED_DECISION_SCHEMA,
				id: this.#id(),
				tenantId: input.tenantId,
				repositoryId: input.repositoryId,
				actorId,
				identityVerified: true,
				envelopeDigest: { algorithm: "sha256", value: input.digest },
				gateInputDigest: identity.gateInputDigest,
				witnessIds: identity.witnessIds,
				decision: input.decision,
				summary,
				supersedes: input.supersedes ?? null,
				receivedAt: now.toISOString(),
			};
			const audit = this.#auditRecord(
				input.tenantId,
				actorId,
				"decision-append",
				"decision",
				decision.id,
				"accepted",
			);
			await this.#store.appendDecision(decision, audit);
			return decision;
		} catch (error) {
			await this.#audit(
				input.tenantId,
				actorId,
				"decision-append",
				"envelope",
				input.digest,
				"rejected",
			);
			throw error;
		}
	}

	async exportAudit(input: {
		sessionToken: string;
		tenantId: string;
		repositoryId: string;
		before?: Date;
		limit?: number;
	}): Promise<string> {
		requireInternalId(input.tenantId, "tenant ID");
		requireInternalId(input.repositoryId, "repository ID");
		await this.#authorize(input, "audit-export", "tenant", input.tenantId);
		const limit = input.limit ?? 1000;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
			throw new HostedReviewError(
				400,
				"HOSTED_AUDIT_EXPORT_INVALID",
				"audit export limit is invalid",
			);
		}
		const before = input.before ?? this.#now();
		if (!Number.isFinite(before.getTime())) {
			throw new HostedReviewError(400, "HOSTED_AUDIT_EXPORT_INVALID", "audit cursor is invalid");
		}
		const records = await this.#store.exportAudit({
			tenantId: input.tenantId,
			before,
			limit,
		});
		return (
			records.map((record) => canonicalize(record)).join("\n") + (records.length === 0 ? "" : "\n")
		);
	}

	async #authorize(
		input: { sessionToken: string; tenantId: string; repositoryId: string },
		action: "read" | "append-decision" | "audit-export",
		targetType: AuditTarget,
		targetId: string,
	): Promise<string> {
		try {
			return (
				await this.#auth.authorize({
					sessionToken: input.sessionToken,
					tenantId: input.tenantId,
					repositoryId: input.repositoryId,
					action,
				})
			).actorId;
		} catch (error) {
			await this.#audit(
				input.tenantId,
				null,
				"authorization-deny",
				targetType,
				targetId,
				"rejected",
			);
			throw error;
		}
	}

	#audit(
		tenantId: string,
		actorId: string | null,
		action: AuditAction,
		targetType: AuditTarget,
		targetId: string,
		outcome: "accepted" | "rejected",
	): Promise<void> {
		return this.#store.appendAudit(
			this.#auditRecord(tenantId, actorId, action, targetType, targetId, outcome),
		);
	}

	#auditRecord(
		tenantId: string,
		actorId: string | null,
		action: AuditAction,
		targetType: AuditTarget,
		targetId: string,
		outcome: "accepted" | "rejected",
	): HostedAuditRecord {
		return {
			schema: HOSTED_AUDIT_EVENT_SCHEMA,
			id: this.#id(),
			tenantId,
			actorId,
			action,
			targetType,
			targetId,
			outcome,
			occurredAt: this.#now().toISOString(),
		};
	}
}

interface EvidenceIndexRow extends Record<string, unknown> {
	received_at: Date | string;
	profile: string;
	content_expires_at: Date | string;
	read_denied_at: Date | string | null;
}

interface DecisionRow extends Record<string, unknown> {
	id: string;
	tenant_id: string;
	repository_id: string;
	actor_id: string;
	envelope_digest: string;
	gate_input_digest: string;
	witness_ids: string[];
	decision: DecisionValue;
	summary: string;
	supersedes: string | null;
	received_at: Date | string;
}

interface AuditRow extends Record<string, unknown> {
	id: string;
	tenant_id: string;
	actor_id: string | null;
	action: string;
	target_type: AuditTarget | null;
	target_id: string;
	outcome: string;
	recorded_at: Date | string;
}

function iso(value: Date | string): string {
	return (value instanceof Date ? value : new Date(value)).toISOString();
}

function decisionFromRow(row: DecisionRow): HostedDecisionRecord {
	return {
		schema: HOSTED_DECISION_SCHEMA,
		id: row.id,
		tenantId: row.tenant_id,
		repositoryId: row.repository_id,
		actorId: row.actor_id,
		identityVerified: true,
		envelopeDigest: { algorithm: "sha256", value: row.envelope_digest },
		gateInputDigest: { algorithm: "sha256", value: row.gate_input_digest },
		witnessIds: row.witness_ids,
		decision: row.decision,
		summary: row.summary,
		supersedes: row.supersedes,
		receivedAt: iso(row.received_at),
	};
}

function normalizedAuditAction(action: string): AuditAction {
	if (action.includes("upload")) return "upload";
	if (action.includes("delete") || action.includes("purge") || action.includes("expire"))
		return "delete";
	if (
		action === "evidence-read" ||
		action === "decision-append" ||
		action === "authorization-deny"
	) {
		return action;
	}
	return "repository-link";
}

function auditFromRow(row: AuditRow): HostedAuditRecord {
	return {
		schema: HOSTED_AUDIT_EVENT_SCHEMA,
		id: row.id,
		tenantId: row.tenant_id,
		actorId: row.actor_id,
		action: normalizedAuditAction(row.action),
		targetType: row.target_type ?? (row.action.includes("upload") ? "envelope" : "repository"),
		targetId: row.target_id,
		outcome: row.outcome === "rejected" ? "rejected" : "accepted",
		occurredAt: iso(row.recorded_at),
	};
}

async function insertAudit(
	transaction: HostedSqlTransaction,
	record: HostedAuditRecord,
): Promise<void> {
	await transaction.query(
		`INSERT INTO hosted_audit_events
       (id, tenant_id, actor_id, action, target_type, target_id, outcome, recorded_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			record.id,
			record.tenantId,
			record.actorId,
			record.action,
			record.targetType,
			record.targetId,
			record.outcome,
			new Date(record.occurredAt),
			new Date(Date.parse(record.occurredAt) + HOSTED_INDEX_RETENTION_DAYS * 86_400_000),
		],
	);
}

export class PostgresHostedReviewStore implements HostedReviewStore {
	readonly #database: HostedPostgresDatabase;
	readonly #persistence: PostgresObjectHostedPersistence;

	constructor(options: {
		database: HostedPostgresDatabase;
		persistence: PostgresObjectHostedPersistence;
	}) {
		this.#database = options.database;
		this.#persistence = options.persistence;
	}

	async loadEvidence(input: {
		tenantId: string;
		repositoryId: string;
		digest: string;
		now: Date;
	}): Promise<HostedEvidenceSnapshot> {
		const index = await this.#database.transaction(input.tenantId, async (transaction) =>
			transaction.query<EvidenceIndexRow>(
				`SELECT received_at, profile, content_expires_at, read_denied_at
           FROM hosted_envelopes WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3`,
				[input.tenantId, input.repositoryId, input.digest],
			),
		);
		const row = index.rows[0];
		if (row === undefined) return { state: "not-yet-synced", digest: input.digest };
		if (row.read_denied_at !== null) return { state: "deleted", digest: input.digest };
		if (Date.parse(iso(row.content_expires_at)) <= input.now.getTime()) {
			return { state: "expired", digest: input.digest };
		}
		const stored = await this.#persistence.read(input);
		if (stored === null) return { state: "deleted", digest: input.digest };
		return {
			state: "available",
			digest: input.digest,
			receivedAt: iso(row.received_at),
			profile: row.profile,
			canonicalBytes: stored.canonicalBytes,
		};
	}

	async appendDecision(decision: HostedDecisionRecord, audit: HostedAuditRecord): Promise<void> {
		await this.#database.transaction(decision.tenantId, async (transaction) => {
			const evidence = await transaction.query(
				`SELECT 1 FROM hosted_envelopes
         WHERE tenant_id = $1 AND repository_id = $2 AND digest = $3
           AND read_denied_at IS NULL AND content_purged_at IS NULL AND content_expires_at > $4
         FOR SHARE`,
				[
					decision.tenantId,
					decision.repositoryId,
					decision.envelopeDigest.value,
					new Date(decision.receivedAt),
				],
			);
			if (evidence.rows[0] === undefined) {
				throw new HostedReviewError(409, "HOSTED_EVIDENCE_UNAVAILABLE", "evidence is unavailable");
			}
			if (decision.supersedes !== null) {
				const predecessor = await transaction.query(
					`SELECT 1 FROM hosted_decisions
           WHERE tenant_id = $1 AND repository_id = $2 AND envelope_digest = $3 AND id = $4`,
					[
						decision.tenantId,
						decision.repositoryId,
						decision.envelopeDigest.value,
						decision.supersedes,
					],
				);
				if (predecessor.rows[0] === undefined) {
					throw new HostedReviewError(
						409,
						"HOSTED_SUPERSEDES_INVALID",
						"predecessor decision is unavailable",
					);
				}
			}
			await transaction.query(
				`INSERT INTO hosted_decisions
         (id, tenant_id, repository_id, actor_id, envelope_digest, gate_input_digest,
          witness_ids, decision, summary, supersedes, received_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
				[
					decision.id,
					decision.tenantId,
					decision.repositoryId,
					decision.actorId,
					decision.envelopeDigest.value,
					decision.gateInputDigest.value,
					JSON.stringify(decision.witnessIds),
					decision.decision,
					decision.summary,
					decision.supersedes,
					new Date(decision.receivedAt),
					new Date(Date.parse(decision.receivedAt) + HOSTED_INDEX_RETENTION_DAYS * 86_400_000),
				],
			);
			await insertAudit(transaction, audit);
		});
	}

	async listDecisions(input: {
		tenantId: string;
		repositoryId: string;
		digest: string;
	}): Promise<HostedDecisionRecord[]> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const result = await transaction.query<DecisionRow>(
				`SELECT * FROM hosted_decisions
         WHERE tenant_id = $1 AND repository_id = $2 AND envelope_digest = $3
         ORDER BY received_at, id`,
				[input.tenantId, input.repositoryId, input.digest],
			);
			return result.rows.map(decisionFromRow);
		});
	}

	appendAudit(record: HostedAuditRecord): Promise<void> {
		return this.#database.transaction(record.tenantId, (transaction) =>
			insertAudit(transaction, record),
		);
	}

	exportAudit(input: {
		tenantId: string;
		before: Date;
		limit: number;
	}): Promise<HostedAuditRecord[]> {
		return this.#database.transaction(input.tenantId, async (transaction) => {
			const result = await transaction.query<AuditRow>(
				`SELECT id, tenant_id, actor_id, action, target_type, target_id, outcome, recorded_at
         FROM hosted_audit_events WHERE tenant_id = $1 AND recorded_at < $2
         ORDER BY recorded_at, id LIMIT $3`,
				[input.tenantId, input.before, input.limit],
			);
			return result.rows.map(auditFromRow);
		});
	}
}
