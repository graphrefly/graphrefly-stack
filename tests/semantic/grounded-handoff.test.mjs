import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ownerResultDigest } from "../../packages/contracts/src/grounded-handoff.ts";
import {
	createHandoffProposal,
	deriveGroundedExplanation,
	reprojectGroundedReview,
} from "../../packages/core/src/grounded-handoff.ts";

const consequence = JSON.parse(
	readFileSync("evidence/runs/consequence-review/evidence-bundle.json", "utf8"),
);
const saved = JSON.parse(
	readFileSync("evidence/runs/grounded-handoff/evidence-bundle.json", "utf8"),
);

function resultWith(mutate) {
	const result = structuredClone(saved.ownerEvidence.result);
	mutate(result);
	result.id = ownerResultDigest(result);
	return result;
}
function project(ownerResults) {
	return reprojectGroundedReview({
		projection: consequence.projections[0],
		explanation: saved.explanations[0],
		proposal: saved.proposal,
		human: consequence.axes[0].human,
		ownerResults,
	});
}

test("current manifest evidence yields supported, inferred and explicit unknown claims", () => {
	for (const [index, projection] of consequence.projections.entries()) {
		const explanation = deriveGroundedExplanation({
			projection,
			manifest: consequence.sourceEvidence[index].manifest,
		});
		assert.deepEqual(explanation, saved.explanations[index]);
		assert(explanation.claims.some((claim) => claim.classification === "supported"));
		assert(explanation.claims.some((claim) => claim.classification === "inferred"));
		assert(
			explanation.claims.some(
				(claim) => claim.classification === "unknown" && claim.gap === "RUNTIME_OCCURRENCE_ABSENT",
			),
		);
		assert(explanation.claims.every((claim) => claim.refs.length > 0));
		assert(
			explanation.claims
				.filter((claim) => claim.classification === "inferred")
				.every((claim) => claim.inferenceRule === "graphrefly.stack.structural-reachability.v1"),
		);
	}
});

test("proposal is bounded data and cannot select an unknown claim", () => {
	assert.deepEqual(Object.values(saved.proposal.nonAuthority), Array(7).fill(false));
	const unknown = saved.explanations[0].claims.find((claim) => claim.classification === "unknown");
	assert.throws(
		() =>
			createHandoffProposal({
				explanation: saved.explanations[0],
				owner: saved.proposal.owner,
				claimIds: [unknown.id],
				requestedAction: "Do not execute",
			}),
		/HANDOFF_PROPOSAL_SELECTION/,
	);
});

test("only one fresh exactly correlated owner result reprojects the owner axis", () => {
	assert.throws(
		() =>
			reprojectGroundedReview({
				projection: consequence.projections[0],
				explanation: saved.explanations[0],
				proposal: saved.proposal,
				human: { status: "approved", targetDigest: "f".repeat(64) },
				ownerResults: [],
			}),
		/GROUNDED_REVIEW_HUMAN_COORDINATE/,
	);
	const humanOnly = reprojectGroundedReview({
		projection: consequence.projections[0],
		explanation: saved.explanations[0],
		proposal: saved.proposal,
		human: { ...consequence.axes[0].human, status: "approved" },
		ownerResults: [],
	});
	assert.equal(humanOnly.axes.human.status, "approved");
	assert.equal(humanOnly.axes.ownerAdmission, null);
	assert.deepEqual(humanOnly.axes.evidence, consequence.projections[0].readiness);
	for (const [ownerResults, reason] of [
		[[], "NO_OWNER_RESULT"],
		[[{ value: saved.ownerEvidence.result, current: false }], "STALE_OWNER_RESULT"],
		[
			[
				{ value: saved.ownerEvidence.result, current: true },
				{ value: saved.ownerEvidence.result, current: true },
			],
			"DUPLICATE_OWNER_RESULT",
		],
		[[{ value: { schema: "malformed" }, current: true }], "MALFORMED_OWNER_RESULT"],
		[
			[{ value: resultWith((value) => (value.owner = "wrong-owner")), current: true }],
			"WRONG_OWNER",
		],
		[
			[{ value: resultWith((value) => (value.proposalId = "f".repeat(64))), current: true }],
			"WRONG_PROPOSAL",
		],
		[
			[
				{
					value: resultWith((value) => (value.target.projectionId = "f".repeat(64))),
					current: true,
				},
			],
			"WRONG_TARGET",
		],
		[
			[
				{
					value: resultWith((value) => (value.target.subject.head = value.target.subject.base)),
					current: true,
				},
			],
			"WRONG_SUBJECT",
		],
		[
			[
				{
					value: resultWith((value) => (value.evidenceRefs[0].authorityDigest = "f".repeat(64))),
					current: true,
				},
			],
			"WRONG_EVIDENCE",
		],
	]) {
		const projected = project(ownerResults);
		assert.equal(projected.ownerEvidence.reason, reason);
		assert.equal(projected.axes.ownerAdmission, null);
		assert.deepEqual(projected.axes.evidence, consequence.projections[0].readiness);
		assert.deepEqual(projected.axes.human, consequence.axes[0].human);
	}
	const admitted = project([{ value: saved.ownerEvidence.result, current: true }]);
	assert.equal(admitted.ownerEvidence.reason, "ADMITTED");
	assert.equal(admitted.axes.ownerAdmission.status, "admitted");
	assert.deepEqual(admitted.axes.evidence, consequence.projections[0].readiness);
	assert.deepEqual(admitted.axes.human, consequence.axes[0].human);
});
