import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	assertConsequenceGuidance,
	assertConsequenceProjection,
	assertConsequenceProof,
	consequenceDigest,
	guidanceDigest,
	sealConsequenceGuidance,
	sealConsequenceProjection,
} from "../../packages/contracts/dist/consequence-review.js";
import { sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { seal } from "../../packages/contracts/dist/source-bound.js";

const proof = JSON.parse(
	readFileSync("evidence/runs/consequence-review/evidence-bundle.json", "utf8"),
);

function resealProof(value) {
	value.id = sha256Jcs(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id")));
	return value;
}

test("sealed consequence artifacts have deterministic JCS identities and strict ordering", () => {
	assertConsequenceProof(proof);
	for (const projection of proof.projections) {
		assertConsequenceProjection(projection);
		assert.equal(projection.id, consequenceDigest(projection));
	}
	assertConsequenceGuidance(proof.guidance);
	assert.equal(proof.guidance.id, guidanceDigest(proof.guidance));
	assert.equal(
		proof.id,
		sha256Jcs(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "id"))),
	);
});

test("proof cross-bindings reject internally valid coordinate, guidance, axes and attestation substitutions", () => {
	const coordinate = structuredClone(proof);
	coordinate.repository.left = coordinate.repository.base;
	assert.throws(() => assertConsequenceProof(resealProof(coordinate)), /CROSS_BINDING/);

	const guidance = structuredClone(proof);
	const guidanceBody = structuredClone(guidance.guidance);
	delete guidanceBody.id;
	guidanceBody.integration.verifierDigest = "f".repeat(64);
	guidance.guidance = sealConsequenceGuidance(guidanceBody);
	assert.throws(() => assertConsequenceProof(resealProof(guidance)), /CROSS_BINDING/);

	const axes = structuredClone(proof);
	axes.axes[0].evidence.status = "unknown";
	axes.axes[0].evidence.reasons = ["substituted"];
	assert.throws(() => assertConsequenceProof(resealProof(axes)), /CONSEQUENCE_PROOF_AXES/);

	const attestation = structuredClone(proof);
	attestation.sourceEvidence[0].verifierObservation.coverage.push("UnattestedScope");
	attestation.sourceEvidence[0].verifierObservation.coverage.sort();
	assert.throws(() => assertConsequenceProof(resealProof(attestation)), /SOURCE_EVIDENCE/);

	const emptied = structuredClone(proof);
	const projectionBody = structuredClone(emptied.projections[0]);
	delete projectionBody.id;
	projectionBody.sourceScope = [];
	projectionBody.direct = [];
	projectionBody.reachable = [];
	projectionBody.provenance.bindingRefs = [];
	projectionBody.provenance.sourceResolutionRefs = [];
	emptied.projections[0] = sealConsequenceProjection(projectionBody);
	const emptiedGuidanceBody = structuredClone(emptied.guidance);
	delete emptiedGuidanceBody.id;
	emptiedGuidanceBody.leftProjectionId = emptied.projections[0].id;
	emptied.guidance = sealConsequenceGuidance(emptiedGuidanceBody);
	emptied.axes[0].evidence = structuredClone(emptied.projections[0].readiness);
	emptied.axes[0].human.targetDigest = emptied.projections[0].id;
	assert.throws(() => assertConsequenceProof(resealProof(emptied)), /SOURCE_EVIDENCE/);

	const forgedChange = structuredClone(proof);
	forgedChange.sourceEvidence[0].changeId = "f".repeat(64);
	forgedChange.sourceEvidence[0].sourceArtifact.changeId = "f".repeat(64);
	forgedChange.sourceEvidence[0].sourceArtifact.change.id = "f".repeat(64);
	forgedChange.projections[0].changeId = "f".repeat(64);
	forgedChange.projections[0].id = consequenceDigest(forgedChange.projections[0]);
	forgedChange.guidance.leftProjectionId = forgedChange.projections[0].id;
	forgedChange.guidance.id = guidanceDigest(forgedChange.guidance);
	forgedChange.axes[0].evidence = structuredClone(forgedChange.projections[0].readiness);
	forgedChange.axes[0].human.targetDigest = forgedChange.projections[0].id;
	forgedChange.sourceEvidence[0].sourceArtifact.id = sha256Jcs(
		Object.fromEntries(
			Object.entries(forgedChange.sourceEvidence[0].sourceArtifact).filter(([key]) => key !== "id"),
		),
	);
	assert.throws(
		() => assertConsequenceProof(resealProof(forgedChange)),
		/CONSEQUENCE_CHANGE_DIGEST/,
	);

	const orphanResolution = structuredClone(proof);
	const sourceArtifact = orphanResolution.sourceEvidence[0].sourceArtifact;
	sourceArtifact.resolutions.push(
		seal({
			...sourceArtifact.resolutions[0],
			id: undefined,
			anchorId: "f".repeat(64),
		}),
	);
	sourceArtifact.id = sha256Jcs(
		Object.fromEntries(Object.entries(sourceArtifact).filter(([key]) => key !== "id")),
	);
	assert.throws(
		() => assertConsequenceProof(resealProof(orphanResolution)),
		/CONSEQUENCE_PROOF_SOURCE_EVIDENCE/,
	);
});

test("schemas and nested integrity reject extra fields, reordered sets and tamper after rehash", () => {
	const extra = structuredClone(proof.projections[0]);
	extra.runtimeCausality = true;
	extra.id = consequenceDigest(extra);
	assert.throws(() => assertConsequenceProjection(extra), /CONSEQUENCE_SCHEMA/);
	const reordered = structuredClone(proof.projections[0]);
	reordered.direct.reverse();
	reordered.id = consequenceDigest(reordered);
	assert.throws(() => assertConsequenceProjection(reordered), /CONSEQUENCE_ORDER/);
	const tampered = structuredClone(proof);
	tampered.projections[0].manifestId = "f".repeat(64);
	tampered.id = sha256Jcs(
		Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== "id")),
	);
	assert.throws(() => assertConsequenceProof(tampered), /CONSEQUENCE_DIGEST/);
});
