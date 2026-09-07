import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { buildManifest, verifyManifest } from "../../packages/core/dist/evidence-manifest.js";
import { hashBytes, root } from "../source-bound/git.mjs";
import { resolveOwnerFacts } from "./owners.mjs";

const identity = {
	artifact_ref: "graphrefly-stack:evidence-manifest-proof",
	schema: "graphrefly-stack/evidence-manifest-proof/v1",
	revision: "stack-evidence-v1",
};
function proof(facts) {
	const body = {
		...identity,
		manifest: buildManifest(facts),
		adapter: {
			tool: "evidence-manifest-report",
			version: "1",
			sourceDigest: sha256Jcs(
				[
					"scripts/evidence-manifest-report.mjs",
					"scripts/evidence-manifest/report.mjs",
					"scripts/evidence-manifest/owners.mjs",
					"scripts/evidence-manifest/test-runtime.mjs",
					"packages/contracts/src/evidence-manifest.ts",
					"packages/core/src/evidence-manifest.ts",
					"contracts/evidence-manifest/v1/manifest.schema.json",
					"packages/contracts/dist/evidence-manifest.js",
					"packages/core/dist/evidence-manifest.js",
				].map((path) => ({ path, digest: hashBytes(readFileSync(resolve(root, path))) })),
			),
		},
		llmRequired: false,
	};
	return { ...body, id: sha256Jcs(body) };
}
export function buildReport(options = { writeEvidence: true }) {
	return proof(resolveOwnerFacts(options));
}
export function verifyReport(value) {
	if (Object.entries(identity).some(([key, expected]) => value?.[key] !== expected))
		throw new Error("MANIFEST_REPORT_IDENTITY");
	const facts = resolveOwnerFacts();
	verifyManifest(value.manifest, facts);
	if (canonicalize(value) !== canonicalize(proof(facts)))
		throw new Error("MANIFEST_REPORT_MISMATCH");
	return { verified: true, id: value.id };
}
