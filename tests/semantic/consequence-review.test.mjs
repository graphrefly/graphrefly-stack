import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
	diffGraphBlueprints,
	graph,
	withBlueprintHash,
} from "../../examples/refresh-session-source-bound/node_modules/@graphrefly/ts/dist/index.js";
import {
	assembleIntegrationCandidate,
	withIsolatedGitCandidate,
} from "../../packages/cli/dist/integration-candidate.js";
import { assembleIntegrationResult } from "../../packages/cli/dist/integration-semantics.js";
import { sealConsequenceProjection } from "../../packages/contracts/dist/consequence-review.js";
import { sealManifest } from "../../packages/contracts/dist/evidence-manifest.js";
import { sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { seal } from "../../packages/contracts/dist/source-bound.js";
import {
	compareConsequenceProjections,
	composeReviewAxes,
	deriveConsequenceProjection,
} from "../../packages/core/dist/consequence-review.js";
import { evaluateIntegrationEffects } from "../../packages/core/dist/integration-effects.js";

const proof = JSON.parse(
	readFileSync("evidence/runs/consequence-review/evidence-bundle.json", "utf8"),
);

function runGit(repository, args) {
	return execFileSync("/usr/bin/git", args, {
		cwd: repository,
		encoding: "utf8",
		env: {
			PATH: "/usr/bin:/bin",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Consequence Test",
			GIT_AUTHOR_EMAIL: "consequence-test@example.invalid",
			GIT_COMMITTER_NAME: "Consequence Test",
			GIT_COMMITTER_EMAIL: "consequence-test@example.invalid",
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		},
	}).trim();
}

function blueprintAt(repository, revision) {
	const readRole = (path) => JSON.parse(runGit(repository, ["show", `${revision}:${path}`])).role;
	const leftRole = readRole("left.json");
	const rightRole = readRole("right.json");
	const role = leftRole === "base" ? rightRole : leftRole;
	const topology = graph({ name: "ExactConflict" });
	topology.state(0, { name: "SharedNode", meta: { role } });
	return withBlueprintHash(topology.blueprint(), {
		algorithm: "sha256",
		hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
	});
}

async function exactConflictPair() {
	const temporary = mkdtempSync(resolve(tmpdir(), "consequence-conflict-"));
	try {
		runGit(temporary, ["init", "--quiet"]);
		writeFileSync(resolve(temporary, "left.json"), '{"role":"base"}\n');
		writeFileSync(resolve(temporary, "right.json"), '{"role":"base"}\n');
		runGit(temporary, ["add", "left.json", "right.json"]);
		runGit(temporary, ["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
		const base = runGit(temporary, ["rev-parse", "HEAD"]);
		writeFileSync(resolve(temporary, "left.json"), '{"role":"target"}\n');
		runGit(temporary, ["add", "left.json"]);
		runGit(temporary, ["commit", "--quiet", "--no-gpg-sign", "-m", "target"]);
		const target = runGit(temporary, ["rev-parse", "HEAD"]);
		runGit(temporary, ["checkout", "--quiet", "--detach", base]);
		writeFileSync(resolve(temporary, "right.json"), '{"role":"head"}\n');
		runGit(temporary, ["add", "right.json"]);
		runGit(temporary, ["commit", "--quiet", "--no-gpg-sign", "-m", "head"]);
		const head = runGit(temporary, ["rev-parse", "HEAD"]);
		return await withIsolatedGitCandidate(
			{ repository: temporary, target, head },
			async (isolated) => {
				const snapshots = {
					base: blueprintAt(isolated.isolatedRepository, base),
					target: blueprintAt(isolated.isolatedRepository, target),
					head: blueprintAt(isolated.isolatedRepository, head),
					candidate: blueprintAt(isolated.isolatedRepository, isolated.tree.value),
				};
				const digest = (blueprint) => ({
					algorithm: "sha256",
					value: blueprint.hash.value,
				});
				const delta = (from, to) => {
					const value = diffGraphBlueprints(from, to);
					return { delta: value, digest: { algorithm: "sha256", value: sha256Jcs(value) } };
				};
				const graphEvidence = {
					graphreflyVersion: "0.8.0",
					base: { blueprint: snapshots.base, blueprintHash: digest(snapshots.base) },
					target: { blueprint: snapshots.target, blueprintHash: digest(snapshots.target) },
					head: { blueprint: snapshots.head, blueprintHash: digest(snapshots.head) },
					candidate: {
						blueprint: snapshots.candidate,
						blueprintHash: digest(snapshots.candidate),
					},
					targetDelta: delta(snapshots.base, snapshots.target),
					headDelta: delta(snapshots.base, snapshots.head),
					candidateDelta: delta(snapshots.base, snapshots.candidate),
				};
				const gate = {
					inputDigest: { algorithm: "sha256", value: sha256Jcs({ head }) },
					resultDigest: { algorithm: "sha256", value: sha256Jcs({ verdict: "pass" }) },
					verdict: "pass",
				};
				const candidate = await assembleIntegrationCandidate({
					git: isolated,
					graph: graphEvidence,
					repository: { provider: "local", owner: "test", name: "exact-conflict" },
					planDigest: { algorithm: "sha256", value: sha256Jcs({ plan: "exact" }) },
					policyDigest: { algorithm: "sha256", value: sha256Jcs({ policy: "exact" }) },
					headGate: gate,
				});
				const inputs = {
					targetDelta: graphEvidence.targetDelta.delta,
					headDelta: graphEvidence.headDelta.delta,
					candidateDelta: graphEvidence.candidateDelta.delta,
				};
				const effects = evaluateIntegrationEffects(inputs);
				const result = await assembleIntegrationResult({
					candidate,
					graph: effects,
					semantic: { reasonCodes: [], conflicts: [], headGate: gate },
				});
				const resultDigest = sha256Jcs(result);
				const verificationBody = {
					schema: "graphrefly.stack.integration-result-verification.v1",
					verifierRef: "graphrefly-stack:test-exact-integration-verifier",
					candidateDigest: sha256Jcs(candidate),
					resultDigest,
					candidateTree: isolated.tree.value,
					inputs,
					candidateDeltaBinding: {
						from: base,
						to: isolated.tree.value,
						digest: sha256Jcs(inputs.candidateDelta),
					},
					effectDigest: sha256Jcs(effects),
					status: "verified",
				};
				const projection = (source, revision, blueprint) => {
					const body = structuredClone(source);
					delete body.id;
					body.subject = { repository: "git:test-exact-conflict", base, head: revision };
					body.blueprint.topologyHash = blueprint.hash.value;
					body.provenance.authorityRefs = [verificationBody.verifierRef];
					return sealConsequenceProjection(body);
				};
				return {
					left: projection(proof.projections[0], target, snapshots.target),
					right: projection(proof.projections[1], head, snapshots.head),
					integration: {
						candidate,
						result,
						resultDigest,
						verification: { ...verificationBody, id: sha256Jcs(verificationBody) },
					},
				};
			},
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function options(index = 0) {
	const evidence = structuredClone(proof.sourceEvidence[index]);
	const source = evidence.sourceArtifact;
	const projection = proof.projections[index];
	return {
		changeId: evidence.changeId,
		subject: evidence.manifest.subject,
		blueprint: evidence.manifest.blueprint,
		manifest: evidence.manifest,
		sourceScope: source.anchors.map((anchor) => anchor.candidate.symbol.name),
		sources: source.anchors.map((anchor, i) => ({
			anchor,
			resolution: source.resolutions[i],
		})),
		bindings: source.bindings,
		topology: source.topology,
		verificationRequired: projection.verificationRequired,
		unchangedControls: projection.verifiedUnchanged.map((entry) => entry.scope),
		verifierObservations: [evidence.verifierObservation],
	};
}

test("source and evidence failure matrix is explicit with blocked/stale/unknown precedence", () => {
	for (const [disposition, code] of [
		["moved", "MOVED_SOURCE"],
		["changed", "CHANGED_SOURCE"],
		["ambiguous", "AMBIGUOUS_SOURCE"],
		["deleted", "DELETED_SOURCE"],
		["missing", "MISSING_SOURCE"],
		["unsupported", "UNSUPPORTED_SOURCE"],
		["unresolved", "UNRESOLVED_SOURCE"],
	]) {
		const input = options();
		const resolution = input.sources[0].resolution;
		const candidates =
			disposition === "ambiguous"
				? [resolution.candidates[0], { ...resolution.candidates[0], path: "src/duplicate.ts" }]
				: ["deleted", "missing", "unsupported", "unresolved"].includes(disposition)
					? []
					: resolution.candidates;
		input.sources[0].resolution = seal({ ...resolution, id: undefined, disposition, candidates });
		const result = deriveConsequenceProjection(input);
		assert.equal(result.readiness.status, "unknown", disposition);
		assert(
			result.unknowns.some((entry) => entry.code === code),
			disposition,
		);
	}
	const missingBinding = options();
	missingBinding.bindings.shift();
	assert(
		deriveConsequenceProjection(missingBinding).unknowns.some(
			(entry) => entry.code === "MISSING_BINDING",
		),
	);
	const missingVerifier = options();
	missingVerifier.verifierObservations = [];
	assert.equal(deriveConsequenceProjection(missingVerifier).readiness.status, "unknown");
	const stale = options();
	const verifier = stale.manifest.authorities.find(
		(entry) => entry.ref === stale.verifierObservations[0].authorityRef,
	);
	verifier.freshness.status = "stale";
	stale.manifest = sealManifest(stale.manifest);
	stale.verifierObservations[0].freshness = "stale";
	assert.equal(deriveConsequenceProjection(stale).readiness.status, "stale");
	const failed = options();
	failed.verifierObservations[0].attestation.result.status = "failed";
	failed.verifierObservations[0].result = "failed";
	const failedDigest = sha256Jcs(failed.verifierObservations[0].attestation);
	failed.verifierObservations[0].authorityDigest = failedDigest;
	failed.verifierObservations[0].resultDigest = failedDigest;
	const failedAuthority = failed.manifest.authorities.find(
		(entry) => entry.ref === failed.verifierObservations[0].authorityRef,
	);
	failedAuthority.digest = failedDigest;
	failedAuthority.freshness.authorityDigest = failedDigest;
	failed.manifest = sealManifest(failed.manifest);
	assert.equal(deriveConsequenceProjection(failed).readiness.status, "blocked");
	const forgedDigest = options();
	forgedDigest.verifierObservations[0].resultDigest = "f".repeat(64);
	assert.equal(deriveConsequenceProjection(forgedDigest).readiness.status, "unknown");
	const forgedTopology = options();
	forgedTopology.topology.nodes[0].deps = [];
	assert.throws(() => deriveConsequenceProjection(forgedTopology), /CONSEQUENCE_TOPOLOGY_HASH/);
	const incomplete = options();
	incomplete.sourceScope.push("MissingSource");
	assert.equal(deriveConsequenceProjection(incomplete).readiness.status, "unknown");
	const omittedManifestSource = options();
	omittedManifestSource.sourceScope.pop();
	omittedManifestSource.sources.pop();
	omittedManifestSource.bindings.pop();
	const omittedProjection = deriveConsequenceProjection(omittedManifestSource);
	assert.equal(omittedProjection.readiness.status, "unknown");
	assert.equal(omittedProjection.coverage.bindings, "incomplete");
	assert(
		omittedProjection.unknowns.some(
			(entry) => entry.code === "INCOMPLETE_COVERAGE" && entry.subject === "manifest-binding-set",
		),
	);
	const requiredAsUnchanged = options();
	requiredAsUnchanged.unchangedControls = ["AdmitRefresh"];
	const unchangedProjection = deriveConsequenceProjection(requiredAsUnchanged);
	assert.equal(unchangedProjection.readiness.status, "unknown");
	assert.equal(unchangedProjection.verifiedUnchanged.length, 0);
	assert(
		unchangedProjection.unknowns.some(
			(entry) => entry.code === "MISSING_EVIDENCE" && entry.subject === "AdmitRefresh",
		),
	);
	const unrelatedStale = options();
	unrelatedStale.verifierObservations.push({
		...unrelatedStale.verifierObservations[0],
		authorityRef: "unknown:stale",
		freshness: "stale",
	});
	assert.equal(deriveConsequenceProjection(unrelatedStale).readiness.status, "verified");
	const wrongCandidate = options();
	const wrongResolution = wrongCandidate.sources[0].resolution;
	wrongCandidate.sources[0].resolution = seal({
		...wrongResolution,
		id: undefined,
		candidates: [
			{
				...wrongResolution.candidates[0],
				path: "src/substituted.ts",
			},
		],
	});
	assert.equal(deriveConsequenceProjection(wrongCandidate).readiness.status, "unknown");
});

test("human review and owner admission remain orthogonal to evidence readiness", () => {
	const projection = proof.projections[0];
	for (const status of ["needs-review", "approved", "changes-requested"]) {
		const axes = composeReviewAxes({
			projection,
			human: { status, targetDigest: projection.id, currentTargetDigest: projection.id },
			ownerAdmission: null,
		});
		assert.deepEqual(axes.evidence, projection.readiness);
		assert.equal(axes.human.status, status);
		assert.equal(axes.ownerAdmission, null);
	}
	const admission = {
		owner: "external-owner",
		ref: "external:result",
		status: "admitted",
		targetDigest: projection.id,
	};
	assert.deepEqual(
		composeReviewAxes({
			projection,
			human: {
				status: "approved",
				targetDigest: projection.id,
				currentTargetDigest: "f".repeat(64),
			},
			ownerAdmission: admission,
		}),
		{
			evidence: projection.readiness,
			human: { status: "outdated", targetDigest: projection.id },
			ownerAdmission: admission,
		},
	);
	assert.throws(
		() =>
			composeReviewAxes({
				projection,
				human: {
					status: "approved",
					targetDigest: projection.id,
					currentTargetDigest: projection.id,
				},
				ownerAdmission: { ...admission, targetDigest: "f".repeat(64) },
			}),
		/CONSEQUENCE_OWNER_ADMISSION_COORDINATE/,
	);
});

test("optimistic guidance distinguishes overlap, incompatibility, missing candidate and scoped no-overlap", async () => {
	const pair = {
		candidate: proof.integration.candidate,
		result: proof.integration.result,
		resultDigest: proof.integration.resultDigest,
		verification: proof.integration.verification,
	};
	assert.equal(
		compareConsequenceProjections({
			left: proof.projections[0],
			right: proof.projections[1],
			integration: pair,
		}).status,
		"overlap-observed",
	);
	assert.equal(
		compareConsequenceProjections({ left: proof.projections[0], right: proof.projections[1] })
			.status,
		"unknown",
	);
	const exactConflict = await exactConflictPair();
	assert.equal(
		compareConsequenceProjections({
			...exactConflict,
		}).status,
		"incompatible",
	);
	const body = structuredClone(proof.projections[1]);
	delete body.id;
	body.direct = [];
	body.reachable = [];
	body.sourceScope = ["OrthogonalSource"];
	body.provenance.bindingRefs = [];
	body.provenance.sourceResolutionRefs = [];
	body.provenance.authorityRefs = [pair.verification.verifierRef];
	body.coverage.declared = ["OrthogonalScope"];
	const orthogonal = sealConsequenceProjection(body);
	assert.equal(
		compareConsequenceProjections({
			left: proof.projections[0],
			right: orthogonal,
			integration: pair,
		}).status,
		"no-overlap-observed",
	);
	const mismatched = sealConsequenceProjection({
		...body,
		subject: { ...body.subject, head: "f".repeat(40) },
	});
	assert.equal(
		compareConsequenceProjections({
			left: proof.projections[0],
			right: mismatched,
			integration: pair,
		}).status,
		"unknown",
	);
});
