import { Ajv } from "ajv";
import schema from "../dist/schemas/evidence-manifest/v1/manifest.schema.json" with {
	type: "json",
};
import { sha256Jcs } from "./jcs.js";

export type ChangeSubject = { repository: string; base: string; head: string };
export type AuthorityLocation = {
	repository: string;
	commit: string | null;
	occurrence: string | null;
	path: string;
	selector: string | null;
};
export type AuthorityRef = {
	ref: string;
	kind: "decision" | "policy" | "test" | "verifier" | "artifact";
	owner: string;
	schema: string;
	location: AuthorityLocation;
	digest: string;
	bindingRefs: string[];
	provenance: { tool: string; version: string; scope: string; sources: AuthorityLocation[] };
	freshness: {
		status: "current" | "stale" | "unknown";
		subject: ChangeSubject;
		authorityDigest: string;
	};
};
export type EvidenceManifest = {
	schema: "graphrefly.stack.evidence-manifest.v1";
	id: string;
	subject: ChangeSubject;
	blueprint: { version: "graphrefly.blueprint.v2"; topologyHash: string };
	bindingRefs: string[];
	authorities: AuthorityRef[];
	coverage: {
		runtimeOccurrence: "absent";
		scope: "retained-refresh-session-required-linkage-only";
	};
};
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
export function manifestDigest(value: Omit<EvidenceManifest, "id"> | EvidenceManifest): string {
	const { id: _id, ...body } = value as EvidenceManifest;
	return sha256Jcs(body);
}
export function assertEvidenceManifest(value: unknown): asserts value is EvidenceManifest {
	if (!validate(value)) throw new Error("MANIFEST_SCHEMA");
	const manifest = value as EvidenceManifest;
	if (manifest.id !== manifestDigest(manifest)) throw new Error("MANIFEST_DIGEST");
	const refs = manifest.authorities.map((entry) => entry.ref);
	if (new Set(refs).size !== refs.length) throw new Error("MANIFEST_DUPLICATE_REF");
	if (
		manifest.authorities.some((entry) =>
			entry.bindingRefs.some((ref) => !manifest.bindingRefs.includes(ref)),
		)
	)
		throw new Error("MANIFEST_UNRESOLVED_BINDING");
}
export function sealManifest(value: Omit<EvidenceManifest, "id">): EvidenceManifest {
	const result = { ...structuredClone(value), id: manifestDigest(value) };
	assertEvidenceManifest(result);
	return result;
}
