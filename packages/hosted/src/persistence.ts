import { randomUUID } from "node:crypto";

import {
	HOSTED_DAILY_UPLOAD_LIMIT,
	HOSTED_TENANT_STORAGE_LIMIT_BYTES,
} from "@graphrefly-stack/contracts";

export interface HostedRepositoryContext {
	tenantId: string;
	repositoryId: string;
	provider: "github";
	providerRepositoryId: string;
	providerOwnerId: string;
	semanticReviewEnabled: boolean;
}

export interface HostedEnvelopeRecord {
	id: string;
	tenantId: string;
	repositoryId: string;
	digest: string;
	profile: string;
	bytes: number;
	objectKey: string;
	receivedAt: string;
	gateVerdict: string;
	sourceRunId: string;
	sourceHead: string;
}

export interface HostedIngestReceipt {
	id: string;
	digest: string;
	tenantId: string;
	repositoryId: string;
	receivedAt: string;
}

export type HostedPersistenceResult =
	| { status: "stored"; receipt: HostedIngestReceipt }
	| { status: "duplicate"; receipt: HostedIngestReceipt }
	| { status: "rate-limit" }
	| { status: "storage-limit" };

export interface HostedPersistence {
	ingest(input: {
		repository: HostedRepositoryContext;
		digest: string;
		canonicalBytes: Uint8Array;
		profile: string;
		gateVerdict: string;
		sourceRunId: string;
		sourceHead: string;
		receivedAt: Date;
	}): Promise<HostedPersistenceResult>;
}

export class InMemoryHostedPersistence implements HostedPersistence {
	readonly #records = new Map<string, HostedEnvelopeRecord>();
	readonly #objects = new Map<string, Uint8Array>();
	readonly #dailyUploadLimit: number;
	readonly #tenantStorageLimitBytes: number;

	constructor(options: { dailyUploadLimit?: number; tenantStorageLimitBytes?: number } = {}) {
		this.#dailyUploadLimit = options.dailyUploadLimit ?? HOSTED_DAILY_UPLOAD_LIMIT;
		this.#tenantStorageLimitBytes =
			options.tenantStorageLimitBytes ?? HOSTED_TENANT_STORAGE_LIMIT_BYTES;
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
	}): Promise<HostedPersistenceResult> {
		const scope = `${input.repository.tenantId}/${input.repository.repositoryId}`;
		const key = `${scope}/${input.digest}`;
		const existing = this.#records.get(key);
		if (existing !== undefined) return { status: "duplicate", receipt: receipt(existing) };
		const utcDay = input.receivedAt.toISOString().slice(0, 10);
		const repositoryUploads = [...this.#records.values()].filter(
			(record) =>
				record.tenantId === input.repository.tenantId &&
				record.repositoryId === input.repository.repositoryId &&
				record.receivedAt.startsWith(utcDay),
		).length;
		if (repositoryUploads >= this.#dailyUploadLimit) return { status: "rate-limit" };
		const tenantBytes = [...this.#records.values()]
			.filter((record) => record.tenantId === input.repository.tenantId)
			.reduce((sum, record) => sum + record.bytes, 0);
		if (tenantBytes + input.canonicalBytes.byteLength > this.#tenantStorageLimitBytes) {
			return { status: "storage-limit" };
		}
		const record: HostedEnvelopeRecord = {
			id: randomUUID(),
			tenantId: input.repository.tenantId,
			repositoryId: input.repository.repositoryId,
			digest: input.digest,
			profile: input.profile,
			bytes: input.canonicalBytes.byteLength,
			objectKey: key,
			receivedAt: input.receivedAt.toISOString(),
			gateVerdict: input.gateVerdict,
			sourceRunId: input.sourceRunId,
			sourceHead: input.sourceHead,
		};
		this.#objects.set(key, Uint8Array.from(input.canonicalBytes));
		this.#records.set(key, record);
		return { status: "stored", receipt: receipt(record) };
	}

	records(): readonly HostedEnvelopeRecord[] {
		return [...this.#records.values()];
	}

	object(key: string): Uint8Array | null {
		const value = this.#objects.get(key);
		return value === undefined ? null : Uint8Array.from(value);
	}
}

function receipt(record: HostedEnvelopeRecord): HostedIngestReceipt {
	return {
		id: record.id,
		digest: record.digest,
		tenantId: record.tenantId,
		repositoryId: record.repositoryId,
		receivedAt: record.receivedAt,
	};
}
