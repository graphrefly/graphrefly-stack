import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import {
	assertGroundedHandoffProof,
	ownerResultDigest,
} from "../../packages/contracts/src/grounded-handoff.ts";
import {
	createHandoffProposal,
	deriveGroundedExplanation,
	reprojectGroundedReview,
} from "../../packages/core/src/grounded-handoff.ts";
import { verifyReport as verifyConsequenceReport } from "../consequence-review/report.mjs";
import { hashBytes, root } from "../source-bound/git.mjs";
import { locateOwnerResult } from "./owner-evidence.mjs";

const identity = {
	artifact_ref: "graphrefly-stack:grounded-handoff-proof",
	schema: "graphrefly-stack/grounded-handoff-proof/v1",
	revision: "stack-handoff-v1",
};
const consequencePath = "evidence/runs/consequence-review/evidence-bundle.json";
const baselineRevision = "bd587d8ec5df8b609aef4aa415a488900930709e";

function filesAt(directory, prefix = "") {
	return readdirSync(directory, { withFileTypes: true })
		.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
		.flatMap((entry) =>
			entry.isDirectory()
				? filesAt(resolve(directory, entry.name), `${prefix}${entry.name}/`)
				: [
						{
							path: `${prefix}${entry.name}`,
							digest: hashBytes(readFileSync(resolve(directory, entry.name))),
						},
					],
		);
}
function adapterDigest() {
	const explicit = [
		"scripts/grounded-handoff-report.mjs",
		"scripts/grounded-handoff/owner-evidence.mjs",
		"scripts/grounded-handoff/report.mjs",
		"packages/contracts/package.json",
		"packages/contracts/src/grounded-handoff-schemas.ts",
		"packages/contracts/src/grounded-handoff.ts",
		"packages/core/src/grounded-handoff.ts",
		"packages/core/package.json",
		"packages/contracts/tsconfig.grounded.json",
		"packages/core/tsconfig.grounded.json",
		"contracts/grounded-handoff/v1/explanation.schema.json",
		"contracts/grounded-handoff/v1/proposal.schema.json",
		"contracts/grounded-handoff/v1/owner-result.schema.json",
		"contracts/grounded-handoff/v1/proof.schema.json",
	];
	return sha256Jcs([
		...explicit.map((path) => ({ path, digest: hashBytes(readFileSync(resolve(root, path))) })),
		...filesAt(resolve(root, "packages/contracts/dist"), "packages/contracts/dist/"),
		...filesAt(resolve(root, "packages/core/dist"), "packages/core/dist/"),
	]);
}
function resealedOwnerResult(source, mutate) {
	const value = structuredClone(source);
	mutate(value);
	const { id: _id, ...body } = value;
	return { ...body, id: ownerResultDigest(body) };
}
function compareCanonical(left, right) {
	const a = canonicalize(left);
	const b = canonicalize(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

export async function buildReport() {
	const consequenceReview = JSON.parse(readFileSync(resolve(root, consequencePath), "utf8"));
	await verifyConsequenceReport(consequenceReview);
	const explanations = consequenceReview.projections.map((projection, index) =>
		deriveGroundedExplanation({
			projection,
			manifest: consequenceReview.sourceEvidence[index].manifest,
		}),
	);
	const selected = explanations[0].claims.find(
		(claim) =>
			claim.classification === "inferred" && claim.subject === "ApplyBrokerPolicy->AdmitRefresh",
	);
	if (selected === undefined) throw new Error("HANDOFF_SELECTED_CLAIM");
	const owner = consequenceReview.repository.identity;
	const proposal = createHandoffProposal({
		explanation: explanations[0],
		owner,
		claimIds: [selected.id],
		requestedAction:
			"Independently evaluate and record repository admission for the selected structural consequence",
	});
	const ownerEvidence = locateOwnerResult();
	const human = structuredClone(consequenceReview.axes[0].human);
	const withoutOwner = reprojectGroundedReview({
		projection: consequenceReview.projections[0],
		explanation: explanations[0],
		proposal,
		human,
		ownerResults: [],
	});
	const withOwner = reprojectGroundedReview({
		projection: consequenceReview.projections[0],
		explanation: explanations[0],
		proposal,
		human,
		ownerResults: [{ value: ownerEvidence.result, current: true }],
	});
	const ownerResultControls = [
		{ case: "missing", inputs: [] },
		{
			case: "stale",
			inputs: [{ value: ownerEvidence.result, current: false }],
		},
		{
			case: "duplicate",
			inputs: [
				{ value: ownerEvidence.result, current: true },
				{ value: ownerEvidence.result, current: true },
			],
		},
		{ case: "malformed", inputs: [{ value: { schema: "malformed" }, current: true }] },
		{
			case: "wrong-owner",
			inputs: [
				{
					value: resealedOwnerResult(ownerEvidence.result, (value) => {
						value.owner = "git-roots:wrong-owner";
					}),
					current: true,
				},
			],
		},
		{
			case: "wrong-target",
			inputs: [
				{
					value: resealedOwnerResult(ownerEvidence.result, (value) => {
						value.target.projectionId = "f".repeat(64);
					}),
					current: true,
				},
			],
		},
		{
			case: "wrong-proposal",
			inputs: [
				{
					value: resealedOwnerResult(ownerEvidence.result, (value) => {
						value.proposalId = "f".repeat(64);
					}),
					current: true,
				},
			],
		},
		{
			case: "cross-revision",
			inputs: [
				{
					value: resealedOwnerResult(ownerEvidence.result, (value) => {
						value.target.subject.head = value.target.subject.base;
					}),
					current: true,
				},
			],
		},
		{
			case: "wrong-evidence",
			inputs: [
				{
					value: resealedOwnerResult(ownerEvidence.result, (value) => {
						value.evidenceRefs[0].authorityDigest = "f".repeat(64);
					}),
					current: true,
				},
			],
		},
		{
			case: "rehashed-tamper",
			inputs: [
				{
					value: resealedOwnerResult(ownerEvidence.result, (value) => {
						value.statement = "Rehashed bytes not found at the exact retained-owner coordinate";
					}),
					current: false,
				},
			],
		},
	]
		.map((control) => ({
			...control,
			projection: reprojectGroundedReview({
				projection: consequenceReview.projections[0],
				explanation: explanations[0],
				proposal,
				human,
				ownerResults: control.inputs,
			}),
		}))
		.sort(compareCanonical);
	const adapter = { tool: "grounded-handoff-report", version: "1", sourceDigest: adapterDigest() };
	const attemptBody = {
		schema: "graphrefly.stack.grounded-handoff-attempt.v1",
		baselineRevision,
		consequenceProofId: consequenceReview.id,
		ownerEvidenceCommit: ownerEvidence.coordinate.commit,
	};
	const attempt = { ...attemptBody, id: sha256Jcs(attemptBody) };
	const claims = explanations.flatMap((explanation) => explanation.claims);
	const body = {
		...identity,
		consequenceReview,
		explanations,
		proposal,
		ownerEvidence,
		reviewProjections: [withoutOwner, withOwner],
		ownerResultControls,
		compression: {
			reviewed: claims.length,
			available: consequenceReview.sourceEvidence.flatMap((entry) => [
				...entry.sourceArtifact.anchors,
				...entry.sourceArtifact.resolutions,
				...entry.sourceArtifact.bindings,
				...entry.manifest.authorities,
			]).length,
			unit: "classified review claims / exact bound technical records",
		},
		attempt,
		adapter,
		llmRequired: false,
		limitations: [
			"Structural reachability is an inference and not observed runtime occurrence or causality",
			"The handoff is proposal-only and does not execute a capability or mutate an owning system",
			"Only the exact retained repository result changes the external owner axis; evidence readiness and human review remain unchanged",
			"Compression counts are descriptive and make no universal review-time claim",
		],
	};
	const proof = { ...body, id: sha256Jcs(body) };
	assertGroundedHandoffProof(proof);
	return proof;
}

export async function verifyReport(value) {
	assertGroundedHandoffProof(value);
	const located = locateOwnerResult();
	if (canonicalize(value.ownerEvidence) !== canonicalize(located))
		throw new Error("GROUNDED_OWNER_EVIDENCE_MISMATCH");
	const expected = await buildReport();
	if (canonicalize(value) !== canonicalize(expected)) throw new Error("GROUNDED_REPORT_MISMATCH");
	return {
		verified: true,
		id: value.id,
		attemptId: value.attempt.id,
		ownerResultId: value.ownerEvidence.result.id,
	};
}
