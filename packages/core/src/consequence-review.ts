import {
	assertConsequenceIntegration,
	assertConsequenceProjection,
	type ConsequenceGuidance,
	type ConsequenceProjection,
	type ConsequenceUnknownCode,
	sealConsequenceGuidance,
	sealConsequenceProjection,
} from "@graphrefly-stack/contracts/consequence-review";
import {
	assertEvidenceManifest,
	type ChangeSubject,
	type EvidenceManifest,
} from "@graphrefly-stack/contracts/evidence-manifest";
import { canonicalize, sha256Jcs } from "@graphrefly-stack/contracts/jcs";
import {
	assertSourceRecord,
	type GraphSourceBinding,
	type ResolutionResult,
	type SourceAnchor,
} from "@graphrefly-stack/contracts/source-bound";

import { evaluateIntegrationEffects } from "./integration-effects.js";

export type ConsequenceTopology = {
	nodes: { id: string; deps: string[]; [key: string]: unknown }[];
	[key: string]: unknown;
};
export type ConsequenceVerifierObservation = {
	authorityRef: string;
	authorityDigest: string;
	resultDigest: string;
	result: "passed" | "failed";
	freshness: "current" | "stale" | "unknown";
	subject: ChangeSubject;
	topologyHash: string;
	coverage: string[];
	attestation: {
		schema: string;
		subject: ChangeSubject;
		topologyHash: string;
		sourceDigest: string;
		result: { status: "passed" | "failed"; [key: string]: unknown };
		coverage: { required: string[]; unchangedControls: string[] };
	};
};
export type ConsequenceSourceInput = {
	anchor: SourceAnchor;
	resolution: ResolutionResult;
};
export type DeriveConsequenceOptions = {
	changeId: string;
	subject: ChangeSubject;
	blueprint: ConsequenceProjection["blueprint"];
	manifest: EvidenceManifest;
	sourceScope: string[];
	sources: ConsequenceSourceInput[];
	bindings: GraphSourceBinding[];
	topology: ConsequenceTopology;
	verificationRequired: string[];
	unchangedControls: string[];
	verifierObservations: ConsequenceVerifierObservation[];
};

function compare(left: unknown, right: unknown): number {
	const a = canonicalize(left);
	const b = canonicalize(right);
	return a < b ? -1 : a > b ? 1 : 0;
}
function uniqueSorted<T>(values: T[]): T[] {
	return [...new Map(values.map((value) => [canonicalize(value), value])).values()].sort(compare);
}
function same(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}
function unknownCode(resolution: ResolutionResult): ConsequenceUnknownCode | null {
	if (resolution.freshness === "stale") return "STALE_SOURCE";
	if (resolution.freshness === "unknown") return "UNRESOLVED_SOURCE";
	const codes: Partial<Record<ResolutionResult["disposition"], ConsequenceUnknownCode>> = {
		ambiguous: "AMBIGUOUS_SOURCE",
		changed: "CHANGED_SOURCE",
		deleted: "DELETED_SOURCE",
		missing: "MISSING_SOURCE",
		moved: "MOVED_SOURCE",
		unsupported: "UNSUPPORTED_SOURCE",
		unresolved: "UNRESOLVED_SOURCE",
	};
	return codes[resolution.disposition] ?? null;
}
function pathsFrom(
	origin: string,
	topology: ConsequenceTopology,
): { from: string; to: string; path: string[] }[] {
	const outgoing = new Map<string, string[]>();
	for (const node of topology.nodes) {
		for (const dependency of node.deps) {
			const values = outgoing.get(dependency) ?? [];
			values.push(node.id);
			outgoing.set(dependency, uniqueSorted(values));
		}
	}
	const result: { from: string; to: string; path: string[] }[] = [];
	const queue: string[][] = [[origin]];
	const shortest = new Map<string, string>([[origin, canonicalize([origin])]]);
	while (queue.length > 0) {
		const path = queue.shift() as string[];
		const tail = path[path.length - 1] as string;
		for (const next of outgoing.get(tail) ?? []) {
			if (path.includes(next)) continue;
			const candidate = [...path, next];
			const bytes = canonicalize(candidate);
			const previous = shortest.get(next);
			if (previous !== undefined && previous <= bytes) continue;
			shortest.set(next, bytes);
			result.splice(0, result.length, ...result.filter((entry) => entry.to !== next));
			result.push({ from: origin, to: next, path: candidate });
			queue.push(candidate);
		}
	}
	return result;
}
function observationAuthority(
	manifest: EvidenceManifest,
	observation: ConsequenceVerifierObservation,
) {
	return manifest.authorities.find(
		(authority) => authority.ref === observation.authorityRef && authority.kind === "verifier",
	);
}
function observationMatches(
	options: DeriveConsequenceOptions,
	observation: ConsequenceVerifierObservation,
): boolean {
	const authority = observationAuthority(options.manifest, observation);
	const attestedCoverage = uniqueSorted([
		...observation.attestation.coverage.required,
		...observation.attestation.coverage.unchangedControls,
	]);
	return (
		authority !== undefined &&
		authority.digest === observation.authorityDigest &&
		authority.freshness.authorityDigest === observation.authorityDigest &&
		authority.freshness.status === observation.freshness &&
		same(authority.freshness.subject, observation.subject) &&
		same(observation.subject, options.subject) &&
		observation.topologyHash === options.blueprint.topologyHash &&
		observation.resultDigest === authority.digest &&
		sha256Jcs(observation.attestation) === authority.digest &&
		same(observation.attestation.subject, observation.subject) &&
		observation.attestation.topologyHash === observation.topologyHash &&
		observation.attestation.result.status === observation.result &&
		same(attestedCoverage, uniqueSorted(observation.coverage))
	);
}

export function deriveConsequenceProjection(
	options: DeriveConsequenceOptions,
): ConsequenceProjection {
	assertEvidenceManifest(options.manifest);
	if (
		!same(options.subject, options.manifest.subject) ||
		!same(options.blueprint, options.manifest.blueprint)
	) {
		throw new Error("CONSEQUENCE_MANIFEST_COORDINATE");
	}
	if (sha256Jcs(options.topology) !== options.blueprint.topologyHash)
		throw new Error("CONSEQUENCE_TOPOLOGY_HASH");
	const sourceScope = uniqueSorted(options.sourceScope);
	const suppliedBindingRefs = uniqueSorted(options.bindings.map((binding) => binding.id));
	const manifestBindingRefs = uniqueSorted(options.manifest.bindingRefs);
	const topologyNodes = new Set(options.topology.nodes.map((node) => node.id));
	const bindingByAnchor = new Map<string, GraphSourceBinding[]>();
	for (const binding of options.bindings) {
		assertSourceRecord(binding);
		const values = bindingByAnchor.get(binding.anchorId) ?? [];
		values.push(binding);
		bindingByAnchor.set(binding.anchorId, values);
	}
	const direct: ConsequenceProjection["direct"] = [];
	const unknowns: ConsequenceProjection["unknowns"] = [];
	const resolutionRefs: string[] = [];
	const observedScope = new Map<string, number>();
	if (
		options.sourceScope.length !== sourceScope.length ||
		!same(
			sourceScope,
			uniqueSorted(options.sources.map((source) => source.anchor.candidate.symbol.name)),
		)
	)
		unknowns.push({ code: "INCOMPLETE_COVERAGE", subject: "source-scope" });
	if (!same(suppliedBindingRefs, manifestBindingRefs))
		unknowns.push({ code: "INCOMPLETE_COVERAGE", subject: "manifest-binding-set" });
	for (const source of options.sources) {
		assertSourceRecord(source.anchor);
		assertSourceRecord(source.resolution);
		resolutionRefs.push(source.resolution.id);
		const label = source.anchor.candidate.symbol.name;
		observedScope.set(label, (observedScope.get(label) ?? 0) + 1);
		if (!sourceScope.includes(label))
			unknowns.push({ code: "INCOMPLETE_COVERAGE", subject: label });
		const code = unknownCode(source.resolution);
		if (code !== null) {
			unknowns.push({ code, subject: label });
			continue;
		}
		if (
			source.resolution.anchorId !== source.anchor.id ||
			!same(source.anchor.coordinate, {
				repository: options.subject.repository,
				commit: options.subject.head,
				overlayDigest: null,
			}) ||
			!same(source.resolution.target, {
				repository: options.subject.repository,
				commit: options.subject.head,
				overlayDigest: null,
			}) ||
			!same(source.resolution.candidates[0], source.anchor.candidate)
		) {
			unknowns.push({ code: "BINDING_MISMATCH", subject: label });
			continue;
		}
		const matches = bindingByAnchor.get(source.anchor.id) ?? [];
		const binding = matches[0];
		if (matches.length === 0) {
			unknowns.push({ code: "MISSING_BINDING", subject: label });
			continue;
		}
		if (
			matches.length !== 1 ||
			binding === undefined ||
			binding.coordinate.repository !== options.subject.repository ||
			binding.coordinate.commit !== options.subject.head ||
			binding.coordinate.overlayDigest !== null ||
			binding.topologyHash !== options.blueprint.topologyHash ||
			binding.blueprintVersion !== options.blueprint.version ||
			!options.manifest.bindingRefs.includes(binding.id) ||
			!topologyNodes.has(binding.nodeId)
		) {
			unknowns.push({ code: "BINDING_MISMATCH", subject: label });
			continue;
		}
		direct.push({ nodeId: binding.nodeId, bindingRef: binding.id });
	}
	for (const label of sourceScope)
		if (observedScope.get(label) !== 1)
			unknowns.push({ code: "INCOMPLETE_COVERAGE", subject: label });
	const required = uniqueSorted(options.verificationRequired);
	for (const authority of options.manifest.authorities) {
		if (authority.freshness.status === "stale")
			unknowns.push({ code: "STALE_EVIDENCE", subject: authority.ref });
		else if (authority.freshness.status === "unknown")
			unknowns.push({ code: "MISSING_EVIDENCE", subject: authority.ref });
	}
	const observations = options.verifierObservations.map((observation) =>
		structuredClone(observation),
	);
	const currentFailures = observations.filter(
		(observation) =>
			observationMatches(options, observation) &&
			observation.freshness === "current" &&
			observation.result === "failed" &&
			observation.coverage.some((scope) => required.includes(scope)),
	);
	const stale = observations.filter(
		(observation) =>
			observationMatches(options, observation) &&
			observation.freshness === "stale" &&
			observation.coverage.some((scope) => required.includes(scope)),
	);
	const verifiedUnchanged: ConsequenceProjection["verifiedUnchanged"] = [];
	for (const scope of uniqueSorted(options.unchangedControls)) {
		const matches = observations.filter(
			(observation) =>
				observationMatches(options, observation) &&
				observation.freshness === "current" &&
				observation.result === "passed" &&
				observation.attestation.coverage.unchangedControls.includes(scope),
		);
		if (matches.length === 0) unknowns.push({ code: "MISSING_EVIDENCE", subject: scope });
		else {
			const observation = matches.sort(compare)[0] as ConsequenceVerifierObservation;
			verifiedUnchanged.push({
				scope,
				verifierRef: observation.authorityRef,
				verifierDigest: observation.resultDigest,
			});
		}
	}
	const covered = new Set(
		observations
			.filter(
				(observation) =>
					observationMatches(options, observation) && observation.freshness === "current",
			)
			.flatMap((observation) => observation.coverage),
	);
	for (const scope of required)
		if (!covered.has(scope)) unknowns.push({ code: "MISSING_EVIDENCE", subject: scope });
	if (stale.length > 0)
		for (const observation of stale)
			unknowns.push({ code: "STALE_EVIDENCE", subject: observation.authorityRef });
	const finalUnknowns = uniqueSorted(unknowns);
	let status: ConsequenceProjection["readiness"]["status"] = "verified";
	let reasons: string[] = [];
	if (currentFailures.length > 0) {
		status = "blocked";
		reasons = currentFailures.map(
			(observation) => `required-verifier-failed:${observation.authorityRef}`,
		);
	} else if (stale.length > 0) {
		status = "stale";
		reasons = stale.map((observation) => `required-verifier-stale:${observation.authorityRef}`);
	} else if (finalUnknowns.length > 0) {
		status = "unknown";
		reasons = finalUnknowns.map((entry) => `${entry.code}:${entry.subject}`);
	}
	const sortedDirect = uniqueSorted(direct);
	const directNodes = new Set(sortedDirect.map((entry) => entry.nodeId));
	const reachable = uniqueSorted(
		sortedDirect
			.flatMap((entry) => pathsFrom(entry.nodeId, options.topology))
			.filter((entry) => !directNodes.has(entry.to)),
	);
	return sealConsequenceProjection({
		schema: "graphrefly.stack.consequence-projection.v1",
		subject: structuredClone(options.subject),
		blueprint: structuredClone(options.blueprint),
		manifestId: options.manifest.id,
		changeId: options.changeId,
		sourceScope,
		direct: sortedDirect,
		reachable,
		verificationRequired: required,
		verifiedUnchanged: uniqueSorted(verifiedUnchanged),
		unknowns: finalUnknowns,
		coverage: {
			bindings: finalUnknowns.some(
				(entry) => !["MISSING_EVIDENCE", "STALE_EVIDENCE"].includes(entry.code),
			)
				? "incomplete"
				: "complete",
			evidence: finalUnknowns.some((entry) =>
				["MISSING_EVIDENCE", "STALE_EVIDENCE"].includes(entry.code),
			)
				? "incomplete"
				: "complete",
			declared: uniqueSorted([...sourceScope, ...required, ...options.unchangedControls]),
		},
		provenance: {
			sourceResolutionRefs: uniqueSorted(resolutionRefs),
			bindingRefs: uniqueSorted(sortedDirect.map((entry) => entry.bindingRef)),
			authorityRefs: uniqueSorted(options.manifest.authorities.map((entry) => entry.ref)),
			manifestId: options.manifest.id,
		},
		readiness: { status, reasons: uniqueSorted(reasons) },
	});
}

export type ComposeReviewAxesOptions = {
	projection: ConsequenceProjection;
	human: {
		status: "needs-review" | "approved" | "changes-requested";
		targetDigest: string;
		currentTargetDigest: string;
	};
	ownerAdmission: null | { owner: string; ref: string; status: string; targetDigest: string };
};
export function composeReviewAxes(options: ComposeReviewAxesOptions) {
	assertConsequenceProjection(options.projection);
	if (
		options.ownerAdmission !== null &&
		(options.ownerAdmission.targetDigest !== options.projection.id ||
			![
				options.ownerAdmission.owner,
				options.ownerAdmission.ref,
				options.ownerAdmission.status,
			].every((value) => typeof value === "string" && value.length > 0) ||
			!/^[a-f0-9]{64}$/.test(options.ownerAdmission.targetDigest))
	)
		throw new Error("CONSEQUENCE_OWNER_ADMISSION_COORDINATE");
	return {
		evidence: structuredClone(options.projection.readiness),
		human: {
			status:
				options.human.targetDigest === options.human.currentTargetDigest
					? options.human.status
					: "outdated",
			targetDigest: options.human.targetDigest,
		},
		ownerAdmission:
			options.ownerAdmission === null ? null : structuredClone(options.ownerAdmission),
	};
}

type IntegrationPair = {
	candidate: unknown;
	result: unknown;
	resultDigest: string;
	verification: {
		schema: "graphrefly.stack.integration-result-verification.v1";
		id: string;
		verifierRef: string;
		candidateDigest: string;
		resultDigest: string;
		candidateTree: string;
		inputs: {
			targetDelta: Record<string, unknown>;
			headDelta: Record<string, unknown>;
			candidateDelta: Record<string, unknown>;
		};
		candidateDeltaBinding: { from: string; to: string; digest: string };
		effectDigest: string;
		status: "verified";
	};
};
export function compareConsequenceProjections(options: {
	left: ConsequenceProjection;
	right: ConsequenceProjection;
	integration?: IntegrationPair | null;
}): ConsequenceGuidance {
	assertConsequenceProjection(options.left);
	assertConsequenceProjection(options.right);
	const coverageComplete = [options.left, options.right].every(
		(projection) =>
			projection.coverage.bindings === "complete" && projection.coverage.evidence === "complete",
	);
	const intersection = (left: string[], right: string[]) =>
		left.filter((value) => right.includes(value));
	const leftGraph = uniqueSorted([
		...options.left.direct.map((entry) => entry.nodeId),
		...options.left.reachable.map((entry) => entry.to),
	]);
	const rightGraph = uniqueSorted([
		...options.right.direct.map((entry) => entry.nodeId),
		...options.right.reachable.map((entry) => entry.to),
	]);
	const integrationVerifierRef = options.integration?.verification.verifierRef;
	const frameworkAuthorityRefs = new Set([
		"graphrefly-stack:D57",
		"graphrefly-stack:D58",
		"graphrefly-stack:D59",
	]);
	const leftAuthorities = options.left.provenance.authorityRefs.filter(
		(ref) => ref !== integrationVerifierRef && !frameworkAuthorityRefs.has(ref),
	);
	const rightAuthorities = options.right.provenance.authorityRefs.filter(
		(ref) => ref !== integrationVerifierRef && !frameworkAuthorityRefs.has(ref),
	);
	const witnesses: ConsequenceGuidance["witnesses"] = uniqueSorted([
		...intersection(
			options.left.provenance.sourceResolutionRefs,
			options.right.provenance.sourceResolutionRefs,
		).map((value) => ({ kind: "source" as const, value })),
		...intersection(leftGraph, rightGraph).map((value) => ({ kind: "graph" as const, value })),
		...intersection(leftAuthorities, rightAuthorities).map((value) => ({
			kind: "authority" as const,
			value,
		})),
		...intersection(
			options.left.unknowns.map((entry) => `${entry.code}:${entry.subject}`),
			options.right.unknowns.map((entry) => `${entry.code}:${entry.subject}`),
		).map((value) => ({ kind: "invalidated-evidence" as const, value })),
	]);
	let integration: ConsequenceGuidance["integration"] = null;
	let status: ConsequenceGuidance["status"] = "unknown";
	if (options.integration !== undefined && options.integration !== null) {
		try {
			assertConsequenceIntegration(options.integration.candidate, options.integration.result);
			const { id: verificationId, ...verificationBody } = options.integration.verification;
			const candidate = options.integration.candidate as {
				status: string;
				merge: { tree: { value: string } | null };
				revisions: {
					mergeBase: { value: string } | null;
					target: { value: string };
					head: { value: string };
				};
				evidence: {
					baseBlueprint: { blueprintHash: { value: string } } | null;
					targetBlueprint: { blueprintHash: { value: string } } | null;
					headBlueprint: { blueprintHash: { value: string } } | null;
					candidateBlueprint: { blueprintHash: { value: string } } | null;
					targetDelta: { deltaDigest: { value: string } } | null;
					headDelta: { deltaDigest: { value: string } } | null;
				};
			};
			const inputHashes = Object.fromEntries(
				Object.entries(options.integration.verification.inputs).map(([key, value]) => [
					key,
					value as {
						fromHash?: { value?: string };
						toHash?: { value?: string };
					},
				]),
			) as Record<
				"targetDelta" | "headDelta" | "candidateDelta",
				{ fromHash?: { value?: string }; toHash?: { value?: string } }
			>;
			const effects = evaluateIntegrationEffects(options.integration.verification.inputs);
			const result = options.integration.result as {
				candidateDigest: { value: string };
				outcome: string;
				reasonCodes: unknown[];
				overlaps: unknown[];
				conflicts: unknown[];
			};
			if (
				options.integration.verification.schema !==
					"graphrefly.stack.integration-result-verification.v1" ||
				options.integration.verification.status !== "verified" ||
				verificationId !== sha256Jcs(verificationBody) ||
				options.integration.verification.candidateDigest !==
					sha256Jcs(options.integration.candidate) ||
				options.integration.verification.resultDigest !== options.integration.resultDigest ||
				options.integration.verification.effectDigest !== sha256Jcs(effects) ||
				candidate.evidence.targetDelta?.deltaDigest.value !==
					sha256Jcs(options.integration.verification.inputs.targetDelta) ||
				candidate.evidence.headDelta?.deltaDigest.value !==
					sha256Jcs(options.integration.verification.inputs.headDelta) ||
				inputHashes.targetDelta.fromHash?.value !==
					candidate.evidence.baseBlueprint?.blueprintHash.value ||
				inputHashes.targetDelta.toHash?.value !==
					candidate.evidence.targetBlueprint?.blueprintHash.value ||
				inputHashes.headDelta.fromHash?.value !==
					candidate.evidence.baseBlueprint?.blueprintHash.value ||
				inputHashes.headDelta.toHash?.value !==
					candidate.evidence.headBlueprint?.blueprintHash.value ||
				inputHashes.candidateDelta.fromHash?.value !==
					candidate.evidence.baseBlueprint?.blueprintHash.value ||
				inputHashes.candidateDelta.toHash?.value !==
					candidate.evidence.candidateBlueprint?.blueprintHash.value ||
				options.integration.verification.candidateDeltaBinding.from !==
					candidate.revisions.mergeBase?.value ||
				options.integration.verification.candidateDeltaBinding.to !== candidate.merge.tree?.value ||
				options.integration.verification.candidateDeltaBinding.digest !==
					sha256Jcs(options.integration.verification.inputs.candidateDelta) ||
				!same(result.reasonCodes, effects.reasonCodes) ||
				!same(result.overlaps, effects.overlaps) ||
				!same(result.conflicts, effects.conflicts) ||
				result.outcome !== (effects.conflicts.length === 0 ? "compatible" : "conflict") ||
				!options.left.provenance.authorityRefs.includes(
					options.integration.verification.verifierRef,
				) ||
				!options.right.provenance.authorityRefs.includes(
					options.integration.verification.verifierRef,
				)
			)
				throw new Error("CONSEQUENCE_INTEGRATION_VERIFICATION");
			if (options.integration.verification.candidateTree !== candidate.merge.tree?.value)
				throw new Error("CONSEQUENCE_INTEGRATION_VERIFICATION");
			if (options.integration.resultDigest !== sha256Jcs(result))
				throw new Error("CONSEQUENCE_INTEGRATION_DIGEST");
			const sameParallelBase =
				options.left.subject.repository === options.right.subject.repository &&
				options.left.subject.base === options.right.subject.base &&
				candidate.revisions.mergeBase?.value === options.left.subject.base;
			const forward =
				candidate.revisions.target.value === options.left.subject.head &&
				candidate.revisions.head.value === options.right.subject.head &&
				candidate.evidence.targetBlueprint?.blueprintHash.value ===
					options.left.blueprint.topologyHash &&
				candidate.evidence.headBlueprint?.blueprintHash.value ===
					options.right.blueprint.topologyHash;
			const reverse =
				candidate.revisions.target.value === options.right.subject.head &&
				candidate.revisions.head.value === options.left.subject.head &&
				candidate.evidence.targetBlueprint?.blueprintHash.value ===
					options.right.blueprint.topologyHash &&
				candidate.evidence.headBlueprint?.blueprintHash.value ===
					options.left.blueprint.topologyHash;
			if (!sameParallelBase || (!forward && !reverse))
				throw new Error("CONSEQUENCE_INTEGRATION_COORDINATE");
			if (candidate.status === "ready" && ["compatible", "conflict"].includes(result.outcome)) {
				integration = {
					candidateDigest: result.candidateDigest.value,
					resultDigest: options.integration.resultDigest,
					verifierDigest: options.integration.verification.id,
					outcome: result.outcome as "compatible" | "conflict",
				};
				status = !coverageComplete
					? "unknown"
					: result.outcome === "conflict"
						? "incompatible"
						: witnesses.length > 0
							? "overlap-observed"
							: "no-overlap-observed";
			}
		} catch {
			status = "unknown";
		}
	}
	return sealConsequenceGuidance({
		schema: "graphrefly.stack.consequence-guidance.v1",
		leftProjectionId: options.left.id,
		rightProjectionId: options.right.id,
		status,
		coverage: {
			complete: coverageComplete,
			scope: uniqueSorted([...options.left.coverage.declared, ...options.right.coverage.declared]),
		},
		witnesses,
		integration,
	});
}
