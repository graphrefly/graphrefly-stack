import assert from "node:assert/strict";
import test from "node:test";
import { sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { assertSourceRecord, seal } from "../../packages/contracts/dist/source-bound.js";

const coordinate = {
	repository: "synthetic-unit-test",
	commit: "a".repeat(40),
	overlayDigest: null,
};
const candidate = {
	path: "src/a.ts",
	symbol: { name: "A", kind: "const" },
	fingerprint: { algorithm: "typescript-5.9.3-printer-v1", digest: "b".repeat(64) },
	sourceDigest: "c".repeat(64),
	start: 0,
	end: 10,
	authoritative: true,
};
export const anchor = seal({
	schema: "graphrefly.stack.source-anchor.v1",
	coordinate,
	language: "typescript",
	candidate,
	provenance: { tool: "unit-test", version: "1" },
});
test("strict source records reject extra fields, truncated Git IDs, traversal and tampered identity", () => {
	assertSourceRecord(anchor);
	for (const value of [
		{ ...anchor, extra: true },
		{ ...anchor, id: "f".repeat(64) },
		{ ...anchor, coordinate: { ...coordinate, commit: "a".repeat(12) } },
		{ ...anchor, candidate: { ...candidate, path: "../a.ts" } },
		{ ...anchor, candidate: { ...candidate, authoritative: false } },
		{ ...anchor, candidate: { ...candidate, end: 0 } },
	])
		assert.throws(() => assertSourceRecord(value));
	const sha256Commit = seal({ ...anchor, coordinate: { ...coordinate, commit: "a".repeat(64) } });
	assertSourceRecord(sha256Commit);
});
test("record construction snapshots input and uses JCS SHA256 without trusting claimed IDs", () => {
	const input = structuredClone(anchor);
	const sealed = seal(input);
	input.candidate.path = "src/changed.ts";
	assert.equal(sealed.candidate.path, "src/a.ts");
	const { id, ...body } = sealed;
	assert.equal(id, sha256Jcs(body));
});
test("exact and ambiguous dispositions enforce candidate authority and cardinality", () => {
	const base = {
		schema: "graphrefly.stack.source-resolution.v1",
		anchorId: anchor.id,
		target: coordinate,
		resolver: { tool: "unit", version: "1" },
		candidates: [],
		diagnostics: [],
		evidenceDigest: "d".repeat(64),
		disposition: "exact",
		freshness: "current",
	};
	assert.throws(() => seal(base));
	assert.throws(() => seal({ ...base, candidates: [candidate, candidate] }));
	assert.throws(() => seal({ ...base, candidates: [{ ...candidate, authoritative: false }] }));
	assert.throws(() => seal({ ...base, disposition: "ambiguous", candidates: [candidate] }));
	assertSourceRecord(seal({ ...base, candidates: [candidate] }));
});
