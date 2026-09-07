import {
	assertConsequenceProjection,
	assertConsequenceProof,
	type ConsequenceReviewAxes,
	type ConsequenceReviewProof,
} from "@graphrefly-stack/contracts/consequence-review";
import {
	type AuthorityRef,
	assertEvidenceManifest,
	type ChangeSubject,
	type EvidenceManifest,
} from "@graphrefly-stack/contracts/evidence-manifest";
import { canonicalize, sha256Jcs } from "@graphrefly-stack/contracts/jcs";
import { Ajv } from "ajv";
import {
	explanationSchema,
	ownerResultSchema,
	proofSchema,
	proposalSchema,
} from "./grounded-handoff-schemas.ts";

export type GroundingRef = {
	manifestId: string;
	authorityRef: string;
	authorityDigest: string;
	owner: string;
	kind: AuthorityRef["kind"];
};
export type GroundedClaim = {
	id: string;
	classification: "supported" | "inferred" | "unknown";
	kind: "direct" | "verified-unchanged" | "structural-reachability" | "evidence-gap";
	subject: string;
	statement: string;
	refs: GroundingRef[];
	inferenceRule: string | null;
	gap: string | null;
};
export type GroundedExplanation = {
	schema: "graphrefly.stack.grounded-explanation.v1";
	id: string;
	projectionId: string;
	manifestId: string;
	subject: ChangeSubject;
	claims: GroundedClaim[];
};
export type HandoffProposal = {
	schema: "graphrefly.stack.grounded-handoff-proposal.v1";
	id: string;
	explanationId: string;
	owner: string;
	target: { subject: ChangeSubject; projectionId: string };
	scope: string[];
	requestedAction: string;
	evidenceRefs: GroundingRef[];
	nonAuthority: {
		executesCapability: false;
		mutatesRepository: false;
		mutatesReadiness: false;
		mutatesHumanReview: false;
		mutatesOwnerAdmission: false;
		mutatesRuntime: false;
		mutatesWorkflow: false;
	};
};
export type OwnerHandoffResult = {
	schema: "refresh-session.owner-handoff-result.v1";
	id: string;
	owner: string;
	proposalId: string;
	target: { subject: ChangeSubject; projectionId: string };
	status: "admitted" | "rejected";
	evidenceRefs: GroundingRef[];
	statement: string;
};
export type OwnerResultReason =
	| "NO_OWNER_RESULT"
	| "DUPLICATE_OWNER_RESULT"
	| "MALFORMED_OWNER_RESULT"
	| "STALE_OWNER_RESULT"
	| "WRONG_OWNER"
	| "WRONG_TARGET"
	| "WRONG_PROPOSAL"
	| "WRONG_SUBJECT"
	| "WRONG_EVIDENCE"
	| "ADMITTED"
	| "OWNER_REJECTED";
export type GroundedReviewProjection = {
	schema: "graphrefly.stack.grounded-review-projection.v1";
	id: string;
	consequenceProjectionId: string;
	explanationId: string;
	proposalId: string;
	axes: ConsequenceReviewAxes;
	ownerEvidence: {
		status: "absent" | "admitted" | "rejected";
		resultId: string | null;
		reason: OwnerResultReason;
	};
};
export type GroundedHandoffProof = {
	artifact_ref: "graphrefly-stack:grounded-handoff-proof";
	schema: "graphrefly-stack/grounded-handoff-proof/v1";
	revision: "stack-handoff-v1";
	id: string;
	consequenceReview: ConsequenceReviewProof;
	explanations: [GroundedExplanation, GroundedExplanation];
	proposal: HandoffProposal;
	ownerEvidence: {
		result: OwnerHandoffResult;
		coordinate: {
			repository: string;
			ref: string;
			commit: string;
			path: string;
			blob: string;
			bytesDigest: string;
		};
	};
	reviewProjections: [GroundedReviewProjection, GroundedReviewProjection];
	ownerResultControls: {
		case:
			| "cross-revision"
			| "duplicate"
			| "malformed"
			| "missing"
			| "rehashed-tamper"
			| "stale"
			| "wrong-evidence"
			| "wrong-owner"
			| "wrong-proposal"
			| "wrong-target";
		inputs: { current: boolean; value: Record<string, unknown> }[];
		projection: GroundedReviewProjection;
	}[];
	compression: { reviewed: number; available: number; unit: string };
	attempt: {
		schema: "graphrefly.stack.grounded-handoff-attempt.v1";
		id: string;
		baselineRevision: string;
		consequenceProofId: string;
		ownerEvidenceCommit: string;
	};
	adapter: { tool: string; version: string; sourceDigest: string };
	llmRequired: false;
	limitations: string[];
};

const ajv = new Ajv({ strict: true, allErrors: true });
const validateExplanation = ajv.compile(explanationSchema);
const validateProposal = ajv.compile(proposalSchema);
const validateOwnerResult = ajv.compile(ownerResultSchema);
const validateProof = ajv.compile(proofSchema);

function withoutId(value: Record<string, unknown>): Record<string, unknown> {
	const { id: _id, ...body } = value;
	return body;
}
function digest(value: Record<string, unknown>): string {
	return sha256Jcs(withoutId(value));
}
function orderedUnique(values: unknown[]): boolean {
	return values.every(
		(value, index) => index === 0 || canonicalize(values[index - 1]) < canonicalize(value),
	);
}
function same(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}
function assertRefs(refs: GroundingRef[]): void {
	if (!orderedUnique(refs)) throw new Error("GROUNDED_REF_ORDER");
}
export function groundedClaimDigest(value: Omit<GroundedClaim, "id"> | GroundedClaim): string {
	return digest(value as unknown as Record<string, unknown>);
}
export function groundedExplanationDigest(
	value: Omit<GroundedExplanation, "id"> | GroundedExplanation,
): string {
	return digest(value as unknown as Record<string, unknown>);
}
export function handoffProposalDigest(
	value: Omit<HandoffProposal, "id"> | HandoffProposal,
): string {
	return digest(value as unknown as Record<string, unknown>);
}
export function ownerResultDigest(
	value: Omit<OwnerHandoffResult, "id"> | OwnerHandoffResult,
): string {
	return digest(value as unknown as Record<string, unknown>);
}
export function groundedReviewDigest(
	value: Omit<GroundedReviewProjection, "id"> | GroundedReviewProjection,
): string {
	return digest(value as unknown as Record<string, unknown>);
}
export function assertGroundedExplanation(value: unknown): asserts value is GroundedExplanation {
	if (!validateExplanation(value))
		throw new Error(`GROUNDED_EXPLANATION_SCHEMA: ${JSON.stringify(validateExplanation.errors)}`);
	const explanation = value as GroundedExplanation;
	if (explanation.id !== groundedExplanationDigest(explanation))
		throw new Error("GROUNDED_EXPLANATION_DIGEST");
	if (!orderedUnique(explanation.claims)) throw new Error("GROUNDED_CLAIM_ORDER");
	for (const claim of explanation.claims) {
		if (claim.id !== groundedClaimDigest(claim)) throw new Error("GROUNDED_CLAIM_DIGEST");
		assertRefs(claim.refs);
		if (
			(claim.classification === "supported" &&
				(claim.inferenceRule !== null || claim.gap !== null)) ||
			(claim.classification === "inferred" &&
				(claim.inferenceRule === null || claim.gap !== null)) ||
			(claim.classification === "unknown" && (claim.inferenceRule !== null || claim.gap === null))
		)
			throw new Error("GROUNDED_CLAIM_CLASSIFICATION");
	}
}
export function assertHandoffProposal(value: unknown): asserts value is HandoffProposal {
	if (!validateProposal(value))
		throw new Error(`HANDOFF_PROPOSAL_SCHEMA: ${JSON.stringify(validateProposal.errors)}`);
	const proposal = value as HandoffProposal;
	if (proposal.id !== handoffProposalDigest(proposal)) throw new Error("HANDOFF_PROPOSAL_DIGEST");
	if (!orderedUnique(proposal.scope)) throw new Error("HANDOFF_PROPOSAL_SCOPE_ORDER");
	assertRefs(proposal.evidenceRefs);
}
export function assertOwnerHandoffResult(value: unknown): asserts value is OwnerHandoffResult {
	if (!validateOwnerResult(value))
		throw new Error(`OWNER_RESULT_SCHEMA: ${JSON.stringify(validateOwnerResult.errors)}`);
	const result = value as OwnerHandoffResult;
	if (result.id !== ownerResultDigest(result)) throw new Error("OWNER_RESULT_DIGEST");
	assertRefs(result.evidenceRefs);
}
export function assertGroundedReviewProjection(
	value: unknown,
): asserts value is GroundedReviewProjection {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !==
			"axes,consequenceProjectionId,explanationId,id,ownerEvidence,proposalId,schema"
	)
		throw new Error("GROUNDED_REVIEW_SCHEMA");
	const projection = value as GroundedReviewProjection;
	const digestPattern = /^[a-f0-9]{64}$/u;
	const axes = projection.axes;
	const ownerEvidence = projection.ownerEvidence;
	const ownerAdmission = axes?.ownerAdmission;
	if (
		projection.schema !== "graphrefly.stack.grounded-review-projection.v1" ||
		projection.id !== groundedReviewDigest(projection) ||
		!digestPattern.test(projection.consequenceProjectionId) ||
		!digestPattern.test(projection.explanationId) ||
		!digestPattern.test(projection.proposalId) ||
		typeof axes !== "object" ||
		axes === null ||
		Object.keys(axes).sort().join(",") !== "evidence,human,ownerAdmission" ||
		typeof axes.evidence !== "object" ||
		axes.evidence === null ||
		Object.keys(axes.evidence).sort().join(",") !== "reasons,status" ||
		!["verified", "blocked", "stale", "unknown"].includes(axes.evidence.status) ||
		!Array.isArray(axes.evidence.reasons) ||
		!orderedUnique(axes.evidence.reasons) ||
		typeof axes.human !== "object" ||
		axes.human === null ||
		Object.keys(axes.human).sort().join(",") !== "status,targetDigest" ||
		!["needs-review", "approved", "changes-requested", "outdated"].includes(axes.human.status) ||
		!digestPattern.test(axes.human.targetDigest) ||
		typeof ownerEvidence !== "object" ||
		ownerEvidence === null ||
		Object.keys(ownerEvidence).sort().join(",") !== "reason,resultId,status" ||
		!["absent", "admitted", "rejected"].includes(ownerEvidence.status) ||
		!(
			[
				"NO_OWNER_RESULT",
				"DUPLICATE_OWNER_RESULT",
				"MALFORMED_OWNER_RESULT",
				"STALE_OWNER_RESULT",
				"WRONG_OWNER",
				"WRONG_TARGET",
				"WRONG_PROPOSAL",
				"WRONG_SUBJECT",
				"WRONG_EVIDENCE",
				"ADMITTED",
				"OWNER_REJECTED",
			] as string[]
		).includes(ownerEvidence.reason) ||
		(ownerEvidence.resultId !== null && !digestPattern.test(ownerEvidence.resultId)) ||
		(ownerAdmission !== null &&
			(typeof ownerAdmission !== "object" ||
				Object.keys(ownerAdmission).sort().join(",") !== "owner,ref,status,targetDigest" ||
				typeof ownerAdmission.owner !== "string" ||
				typeof ownerAdmission.status !== "string" ||
				!digestPattern.test(ownerAdmission.ref) ||
				!digestPattern.test(ownerAdmission.targetDigest)))
	)
		throw new Error("GROUNDED_REVIEW_SCHEMA");
	if (
		(projection.ownerEvidence.status === "absent" &&
			(projection.ownerEvidence.resultId !== null ||
				projection.axes.ownerAdmission !== null ||
				["ADMITTED", "OWNER_REJECTED"].includes(projection.ownerEvidence.reason))) ||
		(projection.ownerEvidence.status === "admitted" &&
			(projection.ownerEvidence.reason !== "ADMITTED" ||
				projection.ownerEvidence.resultId === null ||
				projection.axes.ownerAdmission?.status !== "admitted" ||
				projection.axes.ownerAdmission.ref !== projection.ownerEvidence.resultId)) ||
		(projection.ownerEvidence.status === "rejected" &&
			(projection.ownerEvidence.reason !== "OWNER_REJECTED" ||
				projection.ownerEvidence.resultId === null ||
				projection.axes.ownerAdmission?.status !== "rejected" ||
				projection.axes.ownerAdmission.ref !== projection.ownerEvidence.resultId))
	)
		throw new Error("GROUNDED_REVIEW_OWNER_AXIS");
}

function assertExplanationGrounding(
	explanation: GroundedExplanation,
	manifest: EvidenceManifest,
): void {
	assertEvidenceManifest(manifest);
	if (explanation.manifestId !== manifest.id || !same(explanation.subject, manifest.subject))
		throw new Error("GROUNDED_EXPLANATION_MANIFEST");
	for (const claim of explanation.claims) {
		for (const ref of claim.refs) {
			const authority = manifest.authorities.find(
				(candidate) => candidate.ref === ref.authorityRef,
			);
			if (
				ref.manifestId !== manifest.id ||
				authority === undefined ||
				authority.digest !== ref.authorityDigest ||
				authority.owner !== ref.owner ||
				authority.kind !== ref.kind ||
				authority.freshness.status !== "current" ||
				!same(authority.freshness.subject, manifest.subject) ||
				authority.freshness.authorityDigest !== authority.digest
			)
				throw new Error("GROUNDED_EXPLANATION_REF");
		}
	}
}

function expectedRefs(
	manifest: EvidenceManifest,
	predicate: (authority: AuthorityRef) => boolean,
): GroundingRef[] {
	return manifest.authorities
		.filter(
			(authority) =>
				authority.freshness.status === "current" &&
				authority.freshness.authorityDigest === authority.digest &&
				same(authority.freshness.subject, manifest.subject) &&
				predicate(authority),
		)
		.map((authority) => ({
			manifestId: manifest.id,
			authorityRef: authority.ref,
			authorityDigest: authority.digest,
			owner: authority.owner,
			kind: authority.kind,
		}))
		.sort((left, right) => {
			const a = canonicalize(left);
			const b = canonicalize(right);
			return a < b ? -1 : a > b ? 1 : 0;
		});
}
function assertExplanationSemantics(
	explanation: GroundedExplanation,
	projection: ConsequenceReviewProof["projections"][number],
	manifest: EvidenceManifest,
): void {
	const expected: Omit<GroundedClaim, "id">[] = [];
	for (const direct of projection.direct) {
		expected.push({
			classification: "supported",
			kind: "direct",
			subject: direct.nodeId,
			statement: `${direct.nodeId} is directly bound by the exact current source evidence`,
			refs: expectedRefs(
				manifest,
				(authority) =>
					authority.kind === "artifact" && authority.bindingRefs.includes(direct.bindingRef),
			),
			inferenceRule: null,
			gap: null,
		});
	}
	for (const unchanged of projection.verifiedUnchanged) {
		expected.push({
			classification: "supported",
			kind: "verified-unchanged",
			subject: unchanged.scope,
			statement: `${unchanged.scope} is verified unchanged within the declared coverage`,
			refs: expectedRefs(
				manifest,
				(authority) =>
					authority.ref === unchanged.verifierRef && authority.digest === unchanged.verifierDigest,
			),
			inferenceRule: null,
			gap: null,
		});
	}
	for (const reachable of projection.reachable) {
		const binding = projection.direct.find((entry) => entry.nodeId === reachable.from);
		expected.push({
			classification: "inferred",
			kind: "structural-reachability",
			subject: `${reachable.from}->${reachable.to}`,
			statement: `${reachable.to} is structurally reachable from ${reachable.from} through ${reachable.path.join(" -> ")}`,
			refs: expectedRefs(
				manifest,
				(authority) =>
					authority.kind === "artifact" &&
					binding !== undefined &&
					authority.bindingRefs.includes(binding.bindingRef),
			),
			inferenceRule: "graphrefly.stack.structural-reachability.v1",
			gap: null,
		});
	}
	for (const unknown of projection.unknowns) {
		expected.push({
			classification: "unknown",
			kind: "evidence-gap",
			subject: unknown.subject,
			statement: `${unknown.subject} is not established by the current evidence`,
			refs: expectedRefs(manifest, () => true),
			inferenceRule: null,
			gap: unknown.code,
		});
	}
	expected.push({
		classification: "unknown",
		kind: "evidence-gap",
		subject: "runtime-occurrence-and-causality",
		statement: "Observed runtime occurrence and causality are not established",
		refs: expectedRefs(manifest, (authority) => authority.kind === "artifact"),
		inferenceRule: null,
		gap: "RUNTIME_OCCURRENCE_ABSENT",
	});
	const sealed = expected
		.map((claim) => ({ ...claim, id: groundedClaimDigest(claim) }))
		.sort((left, right) => {
			const a = canonicalize(left);
			const b = canonicalize(right);
			return a < b ? -1 : a > b ? 1 : 0;
		});
	if (!same(explanation.claims, sealed)) throw new Error("GROUNDED_EXPLANATION_SEMANTICS");
}

function rederiveControlProjection(
	control: GroundedHandoffProof["ownerResultControls"][number],
	proof: GroundedHandoffProof,
): GroundedReviewProjection {
	let result: OwnerHandoffResult | null = null;
	let reason: OwnerResultReason = "NO_OWNER_RESULT";
	if (control.inputs.length > 1) reason = "DUPLICATE_OWNER_RESULT";
	else if (control.inputs.length === 1) {
		const located = control.inputs[0];
		if (located === undefined) throw new Error("GROUNDED_PROOF_CONTROL_INPUT");
		try {
			assertOwnerHandoffResult(located.value);
			result = located.value;
		} catch {
			reason = "MALFORMED_OWNER_RESULT";
		}
		if (result !== null) {
			if (!located.current) reason = "STALE_OWNER_RESULT";
			else if (result.owner !== proof.proposal.owner) reason = "WRONG_OWNER";
			else if (result.proposalId !== proof.proposal.id) reason = "WRONG_PROPOSAL";
			else if (result.target.projectionId !== proof.proposal.target.projectionId)
				reason = "WRONG_TARGET";
			else if (!same(result.target.subject, proof.proposal.target.subject))
				reason = "WRONG_SUBJECT";
			else if (!same(result.evidenceRefs, proof.proposal.evidenceRefs)) reason = "WRONG_EVIDENCE";
			else reason = result.status === "admitted" ? "ADMITTED" : "OWNER_REJECTED";
		}
	}
	const accepted = reason === "ADMITTED" || reason === "OWNER_REJECTED";
	const baseProjection = proof.consequenceReview.projections[0];
	const human = proof.consequenceReview.axes[0]?.human;
	if (human === undefined) throw new Error("GROUNDED_PROOF_CONTROL_INPUT");
	const body = {
		schema: "graphrefly.stack.grounded-review-projection.v1" as const,
		consequenceProjectionId: baseProjection.id,
		explanationId: proof.explanations[0].id,
		proposalId: proof.proposal.id,
		axes: {
			evidence: structuredClone(baseProjection.readiness),
			human: structuredClone(human),
			ownerAdmission:
				accepted && result !== null
					? {
							owner: result.owner,
							ref: result.id,
							status: result.status,
							targetDigest: baseProjection.id,
						}
					: null,
		},
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
	return { ...body, id: groundedReviewDigest(body) };
}

export function assertGroundedHandoffProof(value: unknown): asserts value is GroundedHandoffProof {
	if (!validateProof(value))
		throw new Error(`GROUNDED_PROOF_SCHEMA: ${JSON.stringify(validateProof.errors)}`);
	const proof = value as GroundedHandoffProof;
	if (proof.id !== digest(proof as unknown as Record<string, unknown>))
		throw new Error("GROUNDED_PROOF_DIGEST");
	assertConsequenceProof(proof.consequenceReview);
	for (const [index, explanation] of proof.explanations.entries()) {
		assertGroundedExplanation(explanation);
		const source = proof.consequenceReview.sourceEvidence[index];
		const projection = proof.consequenceReview.projections[index];
		if (
			source === undefined ||
			projection === undefined ||
			explanation.projectionId !== projection.id
		)
			throw new Error("GROUNDED_PROOF_EXPLANATION");
		assertExplanationGrounding(explanation, source.manifest);
		assertExplanationSemantics(explanation, projection, source.manifest);
	}
	assertHandoffProposal(proof.proposal);
	assertOwnerHandoffResult(proof.ownerEvidence.result);
	for (const projection of proof.reviewProjections) {
		assertGroundedReviewProjection(projection);
		assertConsequenceProjection(
			proof.consequenceReview.projections.find(
				(candidate) => candidate.id === projection.consequenceProjectionId,
			),
		);
	}
	const expectedControlReasons = new Map([
		["cross-revision", "WRONG_SUBJECT"],
		["duplicate", "DUPLICATE_OWNER_RESULT"],
		["malformed", "MALFORMED_OWNER_RESULT"],
		["missing", "NO_OWNER_RESULT"],
		["rehashed-tamper", "STALE_OWNER_RESULT"],
		["stale", "STALE_OWNER_RESULT"],
		["wrong-evidence", "WRONG_EVIDENCE"],
		["wrong-owner", "WRONG_OWNER"],
		["wrong-proposal", "WRONG_PROPOSAL"],
		["wrong-target", "WRONG_TARGET"],
	]);
	if (
		!orderedUnique(proof.ownerResultControls) ||
		new Set(proof.ownerResultControls.map((control) => control.case)).size !==
			expectedControlReasons.size
	)
		throw new Error("GROUNDED_PROOF_CONTROL_SET");
	for (const control of proof.ownerResultControls) {
		assertGroundedReviewProjection(control.projection);
		if (
			!same(control.projection, rederiveControlProjection(control, proof)) ||
			control.projection.ownerEvidence.reason !== expectedControlReasons.get(control.case) ||
			control.projection.ownerEvidence.status !== "absent" ||
			control.projection.ownerEvidence.resultId !== null ||
			control.projection.axes.ownerAdmission !== null
		)
			throw new Error("GROUNDED_PROOF_CONTROL_RESULT");
	}
	const selected = proof.explanations
		.flatMap((explanation) => explanation.claims)
		.filter((claim) => proof.proposal.scope.includes(claim.id));
	const expectedRefs = [
		...new Map(
			selected.flatMap((claim) => claim.refs).map((ref) => [canonicalize(ref), ref]),
		).values(),
	].sort((left, right) => {
		const a = canonicalize(left);
		const b = canonicalize(right);
		return a < b ? -1 : a > b ? 1 : 0;
	});
	const [withoutOwner, withOwner] = proof.reviewProjections;
	const result = proof.ownerEvidence.result;
	const attemptBody = withoutId(proof.attempt as unknown as Record<string, unknown>);
	if (
		selected.length !== proof.proposal.scope.length ||
		selected.some((claim) => claim.classification === "unknown") ||
		proof.proposal.explanationId !== proof.explanations[0].id ||
		!same(proof.proposal.target.subject, proof.explanations[0].subject) ||
		proof.proposal.target.projectionId !== proof.explanations[0].projectionId ||
		!same(proof.proposal.evidenceRefs, expectedRefs) ||
		result.owner !== proof.proposal.owner ||
		result.proposalId !== proof.proposal.id ||
		!same(result.target, proof.proposal.target) ||
		!same(result.evidenceRefs, proof.proposal.evidenceRefs) ||
		proof.ownerEvidence.coordinate.repository !== result.owner ||
		withoutOwner.consequenceProjectionId !== proof.consequenceReview.projections[0].id ||
		withOwner.consequenceProjectionId !== proof.consequenceReview.projections[0].id ||
		withoutOwner.explanationId !== proof.explanations[0].id ||
		withOwner.explanationId !== proof.explanations[0].id ||
		withoutOwner.proposalId !== proof.proposal.id ||
		withOwner.proposalId !== proof.proposal.id ||
		withoutOwner?.ownerEvidence.reason !== "NO_OWNER_RESULT" ||
		withoutOwner.axes.ownerAdmission !== null ||
		withOwner?.ownerEvidence.reason !==
			(result.status === "admitted" ? "ADMITTED" : "OWNER_REJECTED") ||
		withOwner.ownerEvidence.resultId !== result.id ||
		withoutOwner.ownerEvidence.status !== "absent" ||
		withOwner.ownerEvidence.status !== result.status ||
		!same(withoutOwner.axes.evidence, proof.consequenceReview.projections[0].readiness) ||
		!same(withoutOwner.axes.human, proof.consequenceReview.axes[0]?.human) ||
		!same(withoutOwner.axes.evidence, withOwner.axes.evidence) ||
		!same(withoutOwner.axes.human, withOwner.axes.human) ||
		!same(withOwner.axes.ownerAdmission, {
			owner: result.owner,
			ref: result.id,
			status: result.status,
			targetDigest: proof.consequenceReview.projections[0].id,
		}) ||
		proof.attempt.id !== sha256Jcs(attemptBody) ||
		proof.attempt.baselineRevision !== "bd587d8ec5df8b609aef4aa415a488900930709e" ||
		proof.attempt.consequenceProofId !== proof.consequenceReview.id ||
		proof.consequenceReview.id !==
			"12ba96806b603ed1f6f0a31b6b71c65df590b905c9518d21719abee4bb280a60" ||
		proof.attempt.ownerEvidenceCommit !== proof.ownerEvidence.coordinate.commit ||
		proof.ownerEvidence.coordinate.ref !== "refs/heads/grounded-handoff-owner-result-v1" ||
		proof.ownerEvidence.coordinate.path !== "evidence/grounded-handoff-owner-result.json" ||
		proof.adapter.tool !== "grounded-handoff-report" ||
		proof.adapter.version !== "1"
	)
		throw new Error("GROUNDED_PROOF_CROSS_BINDING");
}
