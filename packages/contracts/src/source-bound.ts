import { Ajv } from "ajv";
import anchorSchema from "../dist/schemas/source-bound/v1/anchor.schema.json" with { type: "json" };
import bindingSchema from "../dist/schemas/source-bound/v1/binding.schema.json" with {
	type: "json",
};
import resolutionSchema from "../dist/schemas/source-bound/v1/resolution.schema.json" with {
	type: "json",
};
import { sha256Jcs } from "./jcs.js";

export type Coordinate = { repository: string; commit: string; overlayDigest: string | null };
export type Provenance = { tool: string; version: string };
export type Candidate = {
	path: string;
	symbol: { name: string; kind: "const" | "function" };
	fingerprint: { algorithm: "typescript-5.9.3-printer-v1"; digest: string };
	sourceDigest: string;
	start: number;
	end: number;
	authoritative: boolean;
};
export type SourceAnchor = {
	schema: "graphrefly.stack.source-anchor.v1";
	id: string;
	coordinate: Coordinate;
	language: "typescript";
	candidate: Candidate;
	provenance: Provenance;
};
export type ResolutionResult = {
	schema: "graphrefly.stack.source-resolution.v1";
	id: string;
	anchorId: string;
	target: Coordinate;
	resolver: Provenance;
	candidates: Candidate[];
	diagnostics: string[];
	evidenceDigest: string;
	disposition:
		| "exact"
		| "moved"
		| "changed"
		| "ambiguous"
		| "deleted"
		| "missing"
		| "unsupported"
		| "unresolved";
	freshness: "current" | "stale" | "unknown";
};
export type GraphSourceBinding = {
	schema: "graphrefly.stack.graph-source-binding.v1";
	id: string;
	anchorId: string;
	coordinate: Coordinate;
	nodeId: string;
	blueprintVersion: "graphrefly.blueprint.v2";
	topologyHash: string;
	method: "retained-export-runtime-identity-v1";
	provenance: Provenance;
};
export type SourceRecord = SourceAnchor | ResolutionResult | GraphSourceBinding;
const ajv = new Ajv({ strict: true, allErrors: true });
const validators = Object.fromEntries(
	[anchorSchema, resolutionSchema, bindingSchema].map((schema) => {
		return [schema.properties.schema.const, ajv.compile(schema)];
	}),
);
export function recordDigest(record: Omit<SourceRecord, "id"> | SourceRecord): string {
	const { id: _id, ...body } = record as SourceRecord;
	return sha256Jcs(body);
}
export function seal<T extends SourceRecord>(record: Omit<T, "id">): T {
	const sealed = { ...structuredClone(record), id: recordDigest(record) } as T;
	assertSourceRecord(sealed);
	return sealed;
}
export function assertSourceRecord(value: unknown): asserts value is SourceRecord {
	if (!value || typeof value !== "object") throw new Error("SOURCE_RECORD_SCHEMA");
	const record = value as SourceRecord;
	const validate = validators[record.schema];
	if (!validate || !validate(record))
		throw new Error(`SOURCE_RECORD_SCHEMA: ${JSON.stringify(validate?.errors)}`);
	if (record.id !== recordDigest(record)) throw new Error("SOURCE_RECORD_DIGEST");
	if (
		"candidate" in record &&
		(record.candidate.end <= record.candidate.start || !record.candidate.authoritative)
	)
		throw new Error("SOURCE_ANCHOR_NOT_AUTHORITATIVE");
	if ("candidates" in record) {
		if (record.candidates.some((c) => c.end <= c.start)) throw new Error("SOURCE_RANGE");
		if (
			["exact", "moved", "changed"].includes(record.disposition) &&
			(record.candidates.length !== 1 || !record.candidates[0]?.authoritative)
		)
			throw new Error("SOURCE_EXACT_REQUIRES_ONE_AUTHORITY");
		if (record.disposition === "ambiguous" && record.candidates.length < 2)
			throw new Error("SOURCE_AMBIGUOUS_REQUIRES_CANDIDATES");
	}
}
