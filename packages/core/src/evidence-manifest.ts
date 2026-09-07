import {
	type AuthorityRef,
	assertEvidenceManifest,
	type ChangeSubject,
	type EvidenceManifest,
	sealManifest,
} from "@graphrefly-stack/contracts/evidence-manifest";
import { canonicalize } from "@graphrefly-stack/contracts/jcs";
import {
	assertSourceRecord,
	type GraphSourceBinding,
} from "@graphrefly-stack/contracts/source-bound";

// These facts are supplied by the trusted composition root, never extracted from a candidate manifest.
export type ManifestFacts = {
	subject: ChangeSubject;
	blueprint: EvidenceManifest["blueprint"];
	bindings: GraphSourceBinding[];
	authorities: {
		reference: AuthorityRef;
		subjectWitness: ChangeSubject | null;
		authorityWitness: string | null;
	}[];
};
export function buildManifest(facts: ManifestFacts): EvidenceManifest {
	const bindingRefs = facts.bindings
		.map((binding) => {
			assertSourceRecord(binding);
			if (
				binding.coordinate.repository !== facts.subject.repository ||
				binding.coordinate.commit !== facts.subject.head ||
				binding.coordinate.overlayDigest !== null ||
				binding.topologyHash !== facts.blueprint.topologyHash ||
				binding.blueprintVersion !== facts.blueprint.version
			)
				throw new Error("MANIFEST_BINDING_COORDINATE");
			return binding.id;
		})
		.sort();
	for (const kind of ["decision", "policy", "test", "verifier", "artifact"])
		if (!facts.authorities.some(({ reference }) => reference.kind === kind))
			throw new Error(`MANIFEST_MISSING_AUTHORITY: ${kind}`);
	const authorities = facts.authorities
		.map(({ reference, subjectWitness, authorityWitness }) => {
			if (subjectWitness === null || authorityWitness === null)
				throw new Error("MANIFEST_FRESHNESS_UNKNOWN");
			if (
				reference.freshness.status !== "current" ||
				canonicalize(subjectWitness) !== canonicalize(facts.subject) ||
				canonicalize(reference.freshness.subject) !== canonicalize(subjectWitness) ||
				authorityWitness !== reference.digest ||
				reference.freshness.authorityDigest !== authorityWitness
			)
				throw new Error("MANIFEST_FRESHNESS_STALE");
			return structuredClone(reference);
		})
		.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
	return sealManifest({
		schema: "graphrefly.stack.evidence-manifest.v1",
		subject: facts.subject,
		blueprint: facts.blueprint,
		bindingRefs,
		authorities,
		coverage: {
			runtimeOccurrence: "absent",
			scope: "retained-refresh-session-required-linkage-only",
		},
	});
}
export function verifyManifest(value: unknown, facts: ManifestFacts): void {
	assertEvidenceManifest(value);
	if (canonicalize(value) !== canonicalize(buildManifest(facts)))
		throw new Error("MANIFEST_AUTHORITY_MISMATCH");
}
