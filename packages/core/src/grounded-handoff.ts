import {
	assertConsequenceProjection,
	type ConsequenceProjection,
	type ConsequenceReviewAxes,
} from "@graphrefly-stack/contracts/consequence-review";
import {
	type AuthorityRef,
	assertEvidenceManifest,
	type EvidenceManifest,
} from "@graphrefly-stack/contracts/evidence-manifest";
import {
	assertGroundedExplanation,
	assertGroundedReviewProjection,
	assertHandoffProposal,
	assertOwnerHandoffResult,
	type GroundedClaim,
	type GroundedExplanation,
	type GroundedReviewProjection,
	type GroundingRef,
	groundedClaimDigest,
	groundedExplanationDigest,
	groundedReviewDigest,
	type HandoffProposal,
	handoffProposalDigest,
	type OwnerHandoffResult,
} from "@graphrefly-stack/contracts/grounded-handoff";
import { canonicalize } from "@graphrefly-stack/contracts/jcs";

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
function groundingRef(manifest: EvidenceManifest, authority: AuthorityRef): GroundingRef {
	return {
		manifestId: manifest.id,
		authorityRef: authority.ref,
		authorityDigest: authority.digest,
		owner: authority.owner,
		kind: authority.kind,
	};
}
function currentAuthorities(manifest: EvidenceManifest): AuthorityRef[] {
	return manifest.authorities.filter(
		(authority) =>
			authority.freshness.status === "current" &&
			authority.freshness.authorityDigest === authority.digest &&
			same(authority.freshness.subject, manifest.subject),
	);
}
function sealClaim(value: Omit<GroundedClaim, "id">): GroundedClaim {
	return { ...structuredClone(value), id: groundedClaimDigest(value) };
}

export function deriveGroundedExplanation(options: {
	projection: ConsequenceProjection;
	manifest: EvidenceManifest;
}): GroundedExplanation {
	assertConsequenceProjection(options.projection);
	assertEvidenceManifest(options.manifest);
	if (
		options.projection.manifestId !== options.manifest.id ||
		!same(options.projection.subject, options.manifest.subject) ||
		!same(options.projection.blueprint, options.manifest.blueprint)
	)
		throw new Error("GROUNDED_MANIFEST_COORDINATE");
	const authorities = currentAuthorities(options.manifest);
	const claims: GroundedClaim[] = [];
	for (const direct of options.projection.direct) {
		const refs = uniqueSorted(
			authorities
				.filter(
					(authority) =>
						authority.kind === "artifact" && authority.bindingRefs.includes(direct.bindingRef),
				)
				.map((authority) => groundingRef(options.manifest, authority)),
		);
		if (refs.length === 0) throw new Error("GROUNDED_DIRECT_REF");
		claims.push(
			sealClaim({
				classification: "supported",
				kind: "direct",
				subject: direct.nodeId,
				statement: `${direct.nodeId} is directly bound by the exact current source evidence`,
				refs,
				inferenceRule: null,
				gap: null,
			}),
		);
	}
	for (const unchanged of options.projection.verifiedUnchanged) {
		const refs = uniqueSorted(
			authorities
				.filter(
					(authority) =>
						authority.ref === unchanged.verifierRef &&
						authority.digest === unchanged.verifierDigest,
				)
				.map((authority) => groundingRef(options.manifest, authority)),
		);
		if (refs.length !== 1) throw new Error("GROUNDED_UNCHANGED_REF");
		claims.push(
			sealClaim({
				classification: "supported",
				kind: "verified-unchanged",
				subject: unchanged.scope,
				statement: `${unchanged.scope} is verified unchanged within the declared coverage`,
				refs,
				inferenceRule: null,
				gap: null,
			}),
		);
	}
	for (const reachable of options.projection.reachable) {
		const binding = options.projection.direct.find((entry) => entry.nodeId === reachable.from);
		const refs = uniqueSorted(
			authorities
				.filter(
					(authority) =>
						authority.kind === "artifact" &&
						binding !== undefined &&
						authority.bindingRefs.includes(binding.bindingRef),
				)
				.map((authority) => groundingRef(options.manifest, authority)),
		);
		if (refs.length === 0) throw new Error("GROUNDED_REACHABLE_REF");
		claims.push(
			sealClaim({
				classification: "inferred",
				kind: "structural-reachability",
				subject: `${reachable.from}->${reachable.to}`,
				statement: `${reachable.to} is structurally reachable from ${reachable.from} through ${reachable.path.join(" -> ")}`,
				refs,
				inferenceRule: "graphrefly.stack.structural-reachability.v1",
				gap: null,
			}),
		);
	}
	for (const unknown of options.projection.unknowns) {
		const refs = uniqueSorted(
			authorities.map((authority) => groundingRef(options.manifest, authority)),
		);
		if (refs.length === 0) throw new Error("GROUNDED_UNKNOWN_REF");
		claims.push(
			sealClaim({
				classification: "unknown",
				kind: "evidence-gap",
				subject: unknown.subject,
				statement: `${unknown.subject} is not established by the current evidence`,
				refs,
				inferenceRule: null,
				gap: unknown.code,
			}),
		);
	}
	const nonCausalRefs = uniqueSorted(
		authorities
			.filter((authority) => authority.kind === "artifact")
			.map((authority) => groundingRef(options.manifest, authority)),
	);
	if (nonCausalRefs.length === 0) throw new Error("GROUNDED_RUNTIME_GAP_REF");
	claims.push(
		sealClaim({
			classification: "unknown",
			kind: "evidence-gap",
			subject: "runtime-occurrence-and-causality",
			statement: "Observed runtime occurrence and causality are not established",
			refs: nonCausalRefs,
			inferenceRule: null,
			gap: "RUNTIME_OCCURRENCE_ABSENT",
		}),
	);
	const body = {
		schema: "graphrefly.stack.grounded-explanation.v1" as const,
		projectionId: options.projection.id,
		manifestId: options.manifest.id,
		subject: structuredClone(options.projection.subject),
		claims: uniqueSorted(claims),
	};
	const result = { ...body, id: groundedExplanationDigest(body) };
	assertGroundedExplanation(result);
	return result;
}

export function createHandoffProposal(options: {
	explanation: GroundedExplanation;
	owner: string;
	claimIds: string[];
	requestedAction: string;
}): HandoffProposal {
	assertGroundedExplanation(options.explanation);
	const scope = uniqueSorted(options.claimIds);
	const selected = options.explanation.claims.filter((claim) => scope.includes(claim.id));
	if (
		!options.owner ||
		!options.requestedAction ||
		selected.length !== scope.length ||
		selected.some((claim) => claim.classification === "unknown")
	)
		throw new Error("HANDOFF_PROPOSAL_SELECTION");
	const body = {
		schema: "graphrefly.stack.grounded-handoff-proposal.v1" as const,
		explanationId: options.explanation.id,
		owner: options.owner,
		target: {
			subject: structuredClone(options.explanation.subject),
			projectionId: options.explanation.projectionId,
		},
		scope,
		requestedAction: options.requestedAction,
		evidenceRefs: uniqueSorted(selected.flatMap((claim) => claim.refs)),
		nonAuthority: {
			executesCapability: false as const,
			mutatesRepository: false as const,
			mutatesReadiness: false as const,
			mutatesHumanReview: false as const,
			mutatesOwnerAdmission: false as const,
			mutatesRuntime: false as const,
			mutatesWorkflow: false as const,
		},
	};
	const result = { ...body, id: handoffProposalDigest(body) };
	assertHandoffProposal(result);
	return result;
}

export type LocatedOwnerResult = { value: unknown; current: boolean };
export function reprojectGroundedReview(options: {
	projection: ConsequenceProjection;
	explanation: GroundedExplanation;
	proposal: HandoffProposal;
	human: ConsequenceReviewAxes["human"];
	ownerResults: LocatedOwnerResult[];
}): GroundedReviewProjection {
	assertConsequenceProjection(options.projection);
	assertGroundedExplanation(options.explanation);
	assertHandoffProposal(options.proposal);
	if (
		options.explanation.projectionId !== options.projection.id ||
		options.proposal.explanationId !== options.explanation.id ||
		!same(options.proposal.target.subject, options.projection.subject) ||
		options.proposal.target.projectionId !== options.projection.id
	)
		throw new Error("GROUNDED_REVIEW_COORDINATE");
	if (options.human.status !== "outdated" && options.human.targetDigest !== options.projection.id)
		throw new Error("GROUNDED_REVIEW_HUMAN_COORDINATE");
	let result: OwnerHandoffResult | null = null;
	let reason: GroundedReviewProjection["ownerEvidence"]["reason"] = "NO_OWNER_RESULT";
	if (options.ownerResults.length > 1) reason = "DUPLICATE_OWNER_RESULT";
	else if (options.ownerResults.length === 1) {
		const located = options.ownerResults[0] as LocatedOwnerResult;
		try {
			assertOwnerHandoffResult(located.value);
			result = located.value;
		} catch {
			reason = "MALFORMED_OWNER_RESULT";
		}
		if (result !== null) {
			if (!located.current) reason = "STALE_OWNER_RESULT";
			else if (result.owner !== options.proposal.owner) reason = "WRONG_OWNER";
			else if (result.proposalId !== options.proposal.id) reason = "WRONG_PROPOSAL";
			else if (result.target.projectionId !== options.proposal.target.projectionId)
				reason = "WRONG_TARGET";
			else if (!same(result.target.subject, options.proposal.target.subject))
				reason = "WRONG_SUBJECT";
			else if (!same(result.evidenceRefs, options.proposal.evidenceRefs)) reason = "WRONG_EVIDENCE";
			else reason = result.status === "admitted" ? "ADMITTED" : "OWNER_REJECTED";
		}
	}
	const accepted = reason === "ADMITTED" || reason === "OWNER_REJECTED";
	const axes = {
		evidence: structuredClone(options.projection.readiness),
		human: structuredClone(options.human),
		ownerAdmission:
			accepted && result !== null
				? {
						owner: result.owner,
						ref: result.id,
						status: result.status,
						targetDigest: options.projection.id,
					}
				: null,
	};
	const body = {
		schema: "graphrefly.stack.grounded-review-projection.v1" as const,
		consequenceProjectionId: options.projection.id,
		explanationId: options.explanation.id,
		proposalId: options.proposal.id,
		axes,
		ownerEvidence: {
			status: (reason === "ADMITTED"
				? "admitted"
				: reason === "OWNER_REJECTED"
					? "rejected"
					: "absent") as "absent" | "admitted" | "rejected",
			resultId: accepted && result !== null ? result.id : null,
			reason,
		},
	};
	const projected = { ...body, id: groundedReviewDigest(body) };
	assertGroundedReviewProjection(projected);
	return projected;
}
