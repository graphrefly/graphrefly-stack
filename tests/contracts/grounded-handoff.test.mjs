import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import {
	assertGroundedExplanation,
	assertGroundedHandoffProof,
	assertGroundedReviewProjection,
	assertHandoffProposal,
	assertOwnerHandoffResult,
	groundedClaimDigest,
	groundedExplanationDigest,
	groundedReviewDigest,
	handoffProposalDigest,
	ownerResultDigest,
} from "../../packages/contracts/src/grounded-handoff.ts";
import {
	explanationSchema,
	ownerResultSchema,
	proofSchema,
	proposalSchema,
} from "../../packages/contracts/src/grounded-handoff-schemas.ts";

const proof = JSON.parse(
	readFileSync("evidence/runs/grounded-handoff/evidence-bundle.json", "utf8"),
);

test("runtime validators use exact copies of the checked-in schemas", () => {
	for (const [path, schema] of [
		["contracts/grounded-handoff/v1/explanation.schema.json", explanationSchema],
		["contracts/grounded-handoff/v1/proposal.schema.json", proposalSchema],
		["contracts/grounded-handoff/v1/owner-result.schema.json", ownerResultSchema],
		["contracts/grounded-handoff/v1/proof.schema.json", proofSchema],
	]) {
		assert.deepEqual(schema, JSON.parse(readFileSync(path, "utf8")));
	}
});

test("grounded artifacts are strict, deterministically ordered and content addressed", () => {
	assertGroundedHandoffProof(proof);
	for (const explanation of proof.explanations) {
		assertGroundedExplanation(explanation);
		assert.equal(explanation.id, groundedExplanationDigest(explanation));
		for (const claim of explanation.claims) assert.equal(claim.id, groundedClaimDigest(claim));
	}
	assertHandoffProposal(proof.proposal);
	assert.equal(proof.proposal.id, handoffProposalDigest(proof.proposal));
	assertOwnerHandoffResult(proof.ownerEvidence.result);
	assert.equal(proof.ownerEvidence.result.id, ownerResultDigest(proof.ownerEvidence.result));
});

test("classification, correlation, grounding and proof identities fail closed", () => {
	const invalidClaim = structuredClone(proof.explanations[0]);
	invalidClaim.claims[0].classification = "supported";
	invalidClaim.claims[0].inferenceRule = "forged-rule";
	invalidClaim.claims[0].id = groundedClaimDigest(invalidClaim.claims[0]);
	invalidClaim.claims.sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
	invalidClaim.id = groundedExplanationDigest(invalidClaim);
	assert.throws(() => assertGroundedExplanation(invalidClaim), /CLASSIFICATION/);

	const wrongRef = structuredClone(proof);
	wrongRef.explanations[0].claims[0].refs[0].authorityDigest = "f".repeat(64);
	wrongRef.explanations[0].claims[0].id = groundedClaimDigest(wrongRef.explanations[0].claims[0]);
	wrongRef.explanations[0].claims.sort((left, right) =>
		canonicalize(left).localeCompare(canonicalize(right)),
	);
	wrongRef.explanations[0].id = groundedExplanationDigest(wrongRef.explanations[0]);
	wrongRef.id = sha256Jcs(
		Object.fromEntries(Object.entries(wrongRef).filter(([key]) => key !== "id")),
	);
	assert.throws(() => assertGroundedHandoffProof(wrongRef), /EXPLANATION_REF/);

	const wrongProposal = structuredClone(proof);
	wrongProposal.ownerEvidence.result.proposalId = "e".repeat(64);
	wrongProposal.ownerEvidence.result.id = ownerResultDigest(wrongProposal.ownerEvidence.result);
	wrongProposal.id = sha256Jcs(
		Object.fromEntries(Object.entries(wrongProposal).filter(([key]) => key !== "id")),
	);
	assert.throws(() => assertGroundedHandoffProof(wrongProposal), /CROSS_BINDING/);

	const relabeled = structuredClone(proof);
	const inferred = relabeled.explanations[1].claims.find(
		(claim) => claim.classification === "inferred",
	);
	inferred.classification = "supported";
	inferred.inferenceRule = null;
	inferred.id = groundedClaimDigest(inferred);
	relabeled.explanations[1].claims.sort((left, right) =>
		canonicalize(left).localeCompare(canonicalize(right)),
	);
	relabeled.explanations[1].id = groundedExplanationDigest(relabeled.explanations[1]);
	relabeled.id = sha256Jcs(
		Object.fromEntries(Object.entries(relabeled).filter(([key]) => key !== "id")),
	);
	assert.throws(() => assertGroundedHandoffProof(relabeled), /EXPLANATION_SEMANTICS/);

	for (const [status, resultId] of [
		["admitted", proof.ownerEvidence.result.id],
		["rejected", proof.ownerEvidence.result.id],
	]) {
		const contradiction = structuredClone(proof.reviewProjections[0]);
		contradiction.ownerEvidence.status = status;
		contradiction.ownerEvidence.resultId = resultId;
		const { id: _id, ...body } = contradiction;
		contradiction.id = groundedReviewDigest(body);
		assert.throws(() => assertGroundedReviewProjection(contradiction), /OWNER_AXIS/);
	}

	const extra = structuredClone(proof.proposal);
	extra.authority = true;
	assert.throws(() => assertHandoffProposal(extra), /SCHEMA/);

	const wrongHumanCoordinate = structuredClone(proof.reviewProjections[0]);
	wrongHumanCoordinate.axes.human.targetDigest = "f".repeat(64);
	wrongHumanCoordinate.id = groundedReviewDigest(wrongHumanCoordinate);
	assert.throws(
		() => assertGroundedReviewProjection(wrongHumanCoordinate),
		/GROUNDED_REVIEW_COORDINATE/,
	);

	const wrongOwnerCoordinate = structuredClone(proof.reviewProjections[1]);
	wrongOwnerCoordinate.axes.ownerAdmission.targetDigest = "f".repeat(64);
	wrongOwnerCoordinate.id = groundedReviewDigest(wrongOwnerCoordinate);
	assert.throws(
		() => assertGroundedReviewProjection(wrongOwnerCoordinate),
		/GROUNDED_REVIEW_COORDINATE/,
	);
});

test("retained proof preserves the complete fail-closed owner-result matrix", () => {
	assert.deepEqual(proof.ownerResultControls.map((control) => control.case).sort(), [
		"cross-revision",
		"duplicate",
		"malformed",
		"missing",
		"rehashed-tamper",
		"stale",
		"wrong-evidence",
		"wrong-owner",
		"wrong-proposal",
		"wrong-target",
	]);
	assert(
		proof.ownerResultControls.every((control) => control.projection.axes.ownerAdmission === null),
	);
	const substituted = structuredClone(proof);
	const stale = substituted.ownerResultControls.find((control) => control.case === "stale");
	stale.inputs[0].current = true;
	substituted.ownerResultControls.sort((left, right) =>
		canonicalize(left).localeCompare(canonicalize(right)),
	);
	substituted.id = sha256Jcs(
		Object.fromEntries(Object.entries(substituted).filter(([key]) => key !== "id")),
	);
	assert.throws(() => assertGroundedHandoffProof(substituted), /CONTROL_RESULT/);
});
