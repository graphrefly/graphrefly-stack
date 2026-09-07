import { canonicalize, sha256Jcs } from "@graphrefly-stack/contracts/jcs";
import {
	assertSourceRecord,
	type Candidate,
	type Coordinate,
	type GraphSourceBinding,
	type Provenance,
	type ResolutionResult,
	type SourceAnchor,
	seal,
} from "@graphrefly-stack/contracts/source-bound";

export type ResolutionFacts = {
	target: Coordinate;
	candidates: Candidate[];
	originalFileExists: boolean;
	supported: boolean;
	complete: boolean;
	witness: Coordinate | null;
	diagnostics: string[];
	resolver: Provenance;
};
export function freshness(
	target: Coordinate,
	witness: Coordinate | null,
): "current" | "stale" | "unknown" {
	return witness === null
		? "unknown"
		: canonicalize(target) === canonicalize(witness)
			? "current"
			: "stale";
}
export function resolveSource(anchor: SourceAnchor, facts: ResolutionFacts): ResolutionResult {
	assertSourceRecord(anchor);
	if (facts.target.repository !== anchor.coordinate.repository)
		throw new Error("SOURCE_REPOSITORY_MISMATCH");
	const candidates = structuredClone(facts.candidates).sort(
		(a, b) => a.path.localeCompare(b.path, "en") || a.start - b.start,
	);
	let disposition: ResolutionResult["disposition"] = "unresolved";
	if (candidates.length > 1) disposition = "ambiguous";
	else if (!facts.supported) disposition = "unsupported";
	else if (!facts.complete) disposition = "unresolved";
	else if (candidates.length === 0) disposition = facts.originalFileExists ? "deleted" : "missing";
	else if (candidates[0]?.authoritative) {
		const candidate = candidates[0];
		disposition =
			candidate.fingerprint.digest !== anchor.candidate.fingerprint.digest
				? "changed"
				: candidate.path !== anchor.candidate.path || candidate.start !== anchor.candidate.start
					? "moved"
					: "exact";
	}
	return seal<ResolutionResult>({
		schema: "graphrefly.stack.source-resolution.v1",
		anchorId: anchor.id,
		target: facts.target,
		resolver: facts.resolver,
		candidates,
		diagnostics: facts.diagnostics,
		evidenceDigest: sha256Jcs(facts),
		disposition,
		freshness: freshness(facts.target, facts.witness),
	});
}
export type RuntimeFacts = {
	coordinate: Coordinate;
	blueprintVersion: "graphrefly.blueprint.v2";
	topologyHash: string;
	nodeIds: string[];
	exports: { symbol: string; nodeId: string }[];
	provenance: Provenance;
};
export function bindSource(
	anchor: SourceAnchor,
	resolution: ResolutionResult,
	facts: ResolutionFacts,
	runtime: RuntimeFacts,
): GraphSourceBinding {
	assertSourceRecord(anchor);
	assertSourceRecord(resolution);
	if (canonicalize(resolveSource(anchor, facts)) !== canonicalize(resolution))
		throw new Error("SOURCE_RESOLUTION_MISMATCH");
	if (
		resolution.anchorId !== anchor.id ||
		resolution.disposition !== "exact" ||
		resolution.freshness !== "current" ||
		canonicalize(anchor.coordinate) !== canonicalize(resolution.target) ||
		canonicalize(anchor.coordinate) !== canonicalize(runtime.coordinate)
	)
		throw new Error("SOURCE_BINDING_COORDINATE");
	if (canonicalize(resolution.candidates[0]) !== canonicalize(anchor.candidate))
		throw new Error("SOURCE_BINDING_CANDIDATE");
	const matches = runtime.exports.filter((x) => x.symbol === anchor.candidate.symbol.name);
	const match = matches[0];
	if (
		matches.length !== 1 ||
		!match ||
		runtime.nodeIds.filter((id) => id === match.nodeId).length !== 1
	)
		throw new Error("SOURCE_BINDING_NODE");
	return seal<GraphSourceBinding>({
		schema: "graphrefly.stack.graph-source-binding.v1",
		anchorId: anchor.id,
		coordinate: anchor.coordinate,
		nodeId: match.nodeId,
		blueprintVersion: runtime.blueprintVersion,
		topologyHash: runtime.topologyHash,
		method: "retained-export-runtime-identity-v1",
		provenance: runtime.provenance,
	});
}
export function verifyBinding(
	binding: GraphSourceBinding,
	anchor: SourceAnchor,
	resolution: ResolutionResult,
	facts: ResolutionFacts,
	runtime: RuntimeFacts,
): void {
	assertSourceRecord(binding);
	if (canonicalize(binding) !== canonicalize(bindSource(anchor, resolution, facts, runtime)))
		throw new Error("SOURCE_BINDING_MISMATCH");
}
