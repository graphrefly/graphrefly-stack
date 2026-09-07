import assert from "node:assert/strict";
import test from "node:test";
import {
	assertEvidenceManifest,
	manifestDigest,
	sealManifest,
} from "../../packages/contracts/dist/evidence-manifest.js";

const digest = "a".repeat(64);
const subject = { repository: "fixture", base: "b".repeat(40), head: "c".repeat(40) };
const location = {
	repository: "owner",
	commit: "d".repeat(40),
	occurrence: null,
	path: "tests/oracle.mjs",
	selector: null,
};
const entry = {
	ref: "fixture:verifier",
	kind: "verifier",
	owner: "fixture-owner",
	schema: "fixture/v1",
	location,
	digest,
	bindingRefs: [digest],
	provenance: {
		tool: "fixture",
		version: "1",
		scope: "Synthetic contract test",
		sources: [location],
	},
	freshness: { status: "current", subject, authorityDigest: digest },
};
const body = {
	schema: "graphrefly.stack.evidence-manifest.v1",
	subject,
	blueprint: { version: "graphrefly.blueprint.v2", topologyHash: digest },
	bindingRefs: [digest],
	authorities: [entry],
	coverage: {
		runtimeOccurrence: "absent",
		scope: "retained-refresh-session-required-linkage-only",
	},
};

test("manifest has deterministic identity and snapshots caller inputs without retaining verdict bodies", () => {
	const input = structuredClone(body);
	const sealed = sealManifest(input);
	input.authorities[0].owner = "changed";
	assert.equal(sealed.authorities[0].owner, "fixture-owner");
	assert.equal(sealed.id, manifestDigest(sealed));
	assert.deepEqual(sealed, sealManifest(body));
});
test("strict manifest schema rejects malformed, extra, duplicate and unresolved linkage even rehashed", () => {
	const mutations = [
		(v) => {
			v.extra = true;
		},
		(v) => {
			v.subject.head = "abc123";
		},
		(v) => {
			v.authorities[0].verdict = "passed";
		},
		(v) => {
			v.authorities[0].location.path = "../outside";
		},
		(v) => {
			v.authorities[0].location.commit = null;
		},
		(v) => {
			v.authorities[0].location.occurrence = digest;
		},
		(v) => {
			v.authorities.push({ ...v.authorities[0], owner: "other" });
		},
		(v) => {
			v.bindingRefs.push(digest);
		},
		(v) => {
			v.authorities[0].bindingRefs = ["f".repeat(64)];
		},
		(v) => {
			v.authorities[0].provenance.sources = [];
		},
		(v) => {
			v.authorities = Array.from({ length: 65 }, (_, i) => ({ ...entry, ref: `x:${i}` }));
		},
		(v) => {
			v.authorities[0].owner = "x".repeat(501);
		},
	];
	for (const mutate of mutations) {
		const value = sealManifest(body);
		mutate(value);
		value.id = manifestDigest(value);
		assert.throws(() => assertEvidenceManifest(value));
	}
	const tampered = sealManifest(body);
	tampered.id = "f".repeat(64);
	assert.throws(() => assertEvidenceManifest(tampered), /MANIFEST_DIGEST/);
});
