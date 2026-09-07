import { Ajv } from "ajv";
import guidanceSchema from "../dist/schemas/consequence-review/v1/guidance.schema.json" with {
	type: "json",
};
import projectionSchema from "../dist/schemas/consequence-review/v1/projection.schema.json" with {
	type: "json",
};
import proofSchema from "../dist/schemas/consequence-review/v1/proof.schema.json" with {
	type: "json",
};
import integrationSchema from "../dist/schemas/integration/v1/artifacts.schema.json" with {
	type: "json",
};
import {
	assertEvidenceManifest,
	type ChangeSubject,
	type EvidenceManifest,
} from "./evidence-manifest.js";
import { assertIntegrationIntegrity } from "./integration-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";
import {
	assertSourceRecord,
	type GraphSourceBinding,
	type ResolutionResult,
	type SourceAnchor,
} from "./source-bound.js";

export type ConsequenceReadiness = "verified" | "blocked" | "stale" | "unknown";
export type ConsequenceChangeSet = {
	schema: "graphrefly.stack.git-change-set.v1";
	id: string;
	subject: ChangeSubject;
	rawDiffDigest: string;
};
export type ConsequenceUnknownCode =
	| "AMBIGUOUS_SOURCE"
	| "CHANGED_SOURCE"
	| "DELETED_SOURCE"
	| "MISSING_SOURCE"
	| "MOVED_SOURCE"
	| "UNRESOLVED_SOURCE"
	| "UNSUPPORTED_SOURCE"
	| "STALE_SOURCE"
	| "MISSING_BINDING"
	| "BINDING_MISMATCH"
	| "MISSING_EVIDENCE"
	| "STALE_EVIDENCE"
	| "INCOMPLETE_COVERAGE";
export type ConsequenceProjection = {
	schema: "graphrefly.stack.consequence-projection.v1";
	id: string;
	subject: ChangeSubject;
	blueprint: { version: "graphrefly.blueprint.v2"; topologyHash: string };
	manifestId: string;
	changeId: string;
	sourceScope: string[];
	direct: { nodeId: string; bindingRef: string }[];
	reachable: { from: string; to: string; path: string[] }[];
	verificationRequired: string[];
	verifiedUnchanged: { scope: string; verifierRef: string; verifierDigest: string }[];
	unknowns: { code: ConsequenceUnknownCode; subject: string }[];
	coverage: {
		bindings: "complete" | "incomplete";
		evidence: "complete" | "incomplete";
		declared: string[];
	};
	provenance: {
		sourceResolutionRefs: string[];
		bindingRefs: string[];
		authorityRefs: string[];
		manifestId: string;
	};
	readiness: { status: ConsequenceReadiness; reasons: string[] };
};
export type ConsequenceGuidance = {
	schema: "graphrefly.stack.consequence-guidance.v1";
	id: string;
	leftProjectionId: string;
	rightProjectionId: string;
	status: "no-overlap-observed" | "overlap-observed" | "incompatible" | "unknown";
	coverage: { complete: boolean; scope: string[] };
	witnesses: { kind: "source" | "graph" | "authority" | "invalidated-evidence"; value: string }[];
	integration: null | {
		candidateDigest: string;
		resultDigest: string;
		verifierDigest: string;
		outcome: "compatible" | "conflict";
	};
};
export type ConsequenceReviewAxes = {
	evidence: ConsequenceProjection["readiness"];
	human: {
		status: "needs-review" | "approved" | "changes-requested" | "outdated";
		targetDigest: string;
	};
	ownerAdmission: null | { owner: string; ref: string; status: string; targetDigest: string };
};
export type ConsequenceIntegrationEvidence = {
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
export type ConsequenceReviewProof = {
	artifact_ref: "graphrefly-stack:consequence-review-proof";
	schema: "graphrefly-stack/consequence-review-proof/v1";
	revision: "stack-review-v1";
	id: string;
	repository: {
		identity: string;
		base: string;
		left: string;
		right: string;
		candidateTree: string;
	};
	runtime: {
		name: "@graphrefly/ts";
		version: "0.8.0";
		typescriptVersion: "5.9.3";
		lockIntegrity: string;
		installedFilesDigest: string;
		typescriptLockIntegrity: string;
		typescriptInstalledFilesDigest: string;
		foundationProofId: string;
	};
	sourceEvidence: {
		changeId: string;
		manifest: EvidenceManifest;
		sourceArtifact: {
			schema: "graphrefly.stack.consequence-source-evidence.v1";
			id: string;
			changeId: string;
			change: ConsequenceChangeSet;
			subject: ChangeSubject;
			blueprint: ConsequenceProjection["blueprint"];
			topology: Record<string, unknown>;
			anchors: SourceAnchor[];
			resolutions: ResolutionResult[];
			bindings: GraphSourceBinding[];
		};
		testResult: Record<string, unknown>;
		verifierResult: {
			schema: "refresh-session/business-verifier-observation/v1";
			subject: ChangeSubject;
			topologyHash: string;
			sourceDigest: string;
			result: { status: "passed" | "failed"; [key: string]: unknown };
			coverage: { required: string[]; unchangedControls: string[] };
		};
		verifierObservation: {
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
	}[];
	projections: [ConsequenceProjection, ConsequenceProjection];
	guidance: ConsequenceGuidance;
	axes: ConsequenceReviewAxes[];
	integration: ConsequenceIntegrationEvidence;
	compression: { reviewed: number; available: number; unit: string };
	adapter: { tool: string; version: string; sourceDigest: string };
	llmRequired: false;
	limitations: string[];
};

const ajv = new Ajv({ strict: true, allErrors: true });
const validateProjection = ajv.compile(projectionSchema);
const validateGuidance = ajv.compile(guidanceSchema);
const validateProof = ajv.compile(proofSchema);
const integrationAjv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
integrationAjv.addSchema(integrationSchema);
const validateCandidate = integrationAjv.getSchema(
	"urn:graphrefly-stack:schema:integration-artifacts:v1#/definitions/IntegrationCandidate",
);
const validateResult = integrationAjv.getSchema(
	"urn:graphrefly-stack:schema:integration-artifacts:v1#/definitions/IntegrationResult",
);

function digestWithoutId(value: Record<string, unknown>): string {
	const { id: _id, ...body } = value;
	return sha256Jcs(body);
}
export function consequenceChangeDigest(
	value: Omit<ConsequenceChangeSet, "id"> | ConsequenceChangeSet,
): string {
	return digestWithoutId(value as unknown as Record<string, unknown>);
}
export function assertConsequenceChangeSet(value: unknown): asserts value is ConsequenceChangeSet {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "id,rawDiffDigest,schema,subject"
	)
		throw new Error("CONSEQUENCE_CHANGE_SCHEMA");
	const change = value as ConsequenceChangeSet;
	if (
		change.schema !== "graphrefly.stack.git-change-set.v1" ||
		!/^[a-f0-9]{64}$/.test(change.id) ||
		!/^[a-f0-9]{64}$/.test(change.rawDiffDigest) ||
		typeof change.subject !== "object" ||
		change.subject === null ||
		Object.keys(change.subject).sort().join(",") !== "base,head,repository" ||
		typeof change.subject?.repository !== "string" ||
		!change.subject.repository ||
		!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(change.subject.base) ||
		!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(change.subject.head)
	)
		throw new Error("CONSEQUENCE_CHANGE_SCHEMA");
	if (change.id !== consequenceChangeDigest(change)) throw new Error("CONSEQUENCE_CHANGE_DIGEST");
}
export function sealConsequenceChangeSet(
	value: Omit<ConsequenceChangeSet, "id">,
): ConsequenceChangeSet {
	const result = {
		...structuredClone(value),
		id: consequenceChangeDigest(value),
	} as ConsequenceChangeSet;
	assertConsequenceChangeSet(result);
	return result;
}
function orderedUnique(values: unknown[]): boolean {
	return values.every(
		(value, index) => index === 0 || canonicalize(values[index - 1]) < canonicalize(value),
	);
}
function same(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}
function uniqueSorted<T>(values: T[]): T[] {
	return [...new Map(values.map((value) => [canonicalize(value), value])).values()].sort((a, b) => {
		const left = canonicalize(a);
		const right = canonicalize(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
}
function structuralPaths(
	origin: string,
	topology: { nodes: { id: string; deps: string[] }[] },
): ConsequenceProjection["reachable"] {
	const outgoing = new Map<string, string[]>();
	for (const node of topology.nodes) {
		for (const dependency of node.deps) {
			const values = outgoing.get(dependency) ?? [];
			values.push(node.id);
			outgoing.set(dependency, uniqueSorted(values));
		}
	}
	const result: ConsequenceProjection["reachable"] = [];
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
export function consequenceDigest(
	value: Omit<ConsequenceProjection, "id"> | ConsequenceProjection,
): string {
	return digestWithoutId(value as unknown as Record<string, unknown>);
}
export function guidanceDigest(
	value: Omit<ConsequenceGuidance, "id"> | ConsequenceGuidance,
): string {
	return digestWithoutId(value as unknown as Record<string, unknown>);
}
export function assertConsequenceProjection(
	value: unknown,
): asserts value is ConsequenceProjection {
	if (!validateProjection(value))
		throw new Error(`CONSEQUENCE_SCHEMA: ${JSON.stringify(validateProjection.errors)}`);
	const projection = value as ConsequenceProjection;
	if (projection.id !== consequenceDigest(projection)) throw new Error("CONSEQUENCE_DIGEST");
	for (const values of [
		projection.sourceScope,
		projection.direct,
		projection.reachable,
		projection.verificationRequired,
		projection.verifiedUnchanged,
		projection.unknowns,
		projection.coverage.declared,
		projection.provenance.sourceResolutionRefs,
		projection.provenance.bindingRefs,
		projection.provenance.authorityRefs,
		projection.readiness.reasons,
	]) {
		if (!orderedUnique(values)) throw new Error("CONSEQUENCE_ORDER");
	}
}
export function sealConsequenceProjection(
	value: Omit<ConsequenceProjection, "id">,
): ConsequenceProjection {
	const result = {
		...structuredClone(value),
		id: consequenceDigest(value),
	} as ConsequenceProjection;
	assertConsequenceProjection(result);
	return result;
}
export function assertConsequenceGuidance(value: unknown): asserts value is ConsequenceGuidance {
	if (!validateGuidance(value))
		throw new Error(`GUIDANCE_SCHEMA: ${JSON.stringify(validateGuidance.errors)}`);
	const guidance = value as ConsequenceGuidance;
	if (guidance.id !== guidanceDigest(guidance)) throw new Error("GUIDANCE_DIGEST");
	for (const values of [guidance.coverage.scope, guidance.witnesses]) {
		if (!orderedUnique(values)) throw new Error("GUIDANCE_ORDER");
	}
}
export function sealConsequenceGuidance(
	value: Omit<ConsequenceGuidance, "id">,
): ConsequenceGuidance {
	const result = { ...structuredClone(value), id: guidanceDigest(value) } as ConsequenceGuidance;
	assertConsequenceGuidance(result);
	return result;
}
export function assertConsequenceIntegration(candidate: unknown, result: unknown): void {
	if (!validateCandidate?.(candidate) || !validateResult?.(result))
		throw new Error("CONSEQUENCE_INTEGRATION_SCHEMA");
	assertIntegrationIntegrity(candidate, result);
}
export function assertConsequenceProof(value: unknown): void {
	if (!validateProof(value))
		throw new Error(`CONSEQUENCE_PROOF_SCHEMA: ${JSON.stringify(validateProof.errors)}`);
	const proof = value as ConsequenceReviewProof;
	if (proof.id !== digestWithoutId(proof as unknown as Record<string, unknown>))
		throw new Error("CONSEQUENCE_PROOF_DIGEST");
	for (const projection of proof.projections) assertConsequenceProjection(projection);
	assertConsequenceGuidance(proof.guidance);
	if (
		proof.guidance.leftProjectionId !== proof.projections[0].id ||
		proof.guidance.rightProjectionId !== proof.projections[1].id
	)
		throw new Error("CONSEQUENCE_PROOF_GUIDANCE");
	for (const [index, evidence] of proof.sourceEvidence.entries()) {
		assertEvidenceManifest(evidence.manifest);
		assertConsequenceChangeSet(evidence.sourceArtifact.change);
		for (const record of [
			...evidence.sourceArtifact.anchors,
			...evidence.sourceArtifact.resolutions,
			...evidence.sourceArtifact.bindings,
		])
			assertSourceRecord(record);
		const { id: _sourceId, ...sourceBody } = evidence.sourceArtifact;
		const verifierResultDigest = sha256Jcs(evidence.verifierResult);
		const testResultDigest = sha256Jcs(evidence.testResult);
		const verifierAuthority = evidence.manifest.authorities.find(
			(authority) => authority.ref === evidence.verifierObservation.authorityRef,
		);
		const testAuthority = evidence.manifest.authorities.find(
			(authority) => authority.kind === "test",
		);
		const integrationAuthority = evidence.manifest.authorities.find(
			(authority) => authority.ref === proof.integration.verification.verifierRef,
		);
		if (
			evidence.sourceArtifact.id !== sha256Jcs(sourceBody) ||
			evidence.changeId !== evidence.sourceArtifact.changeId ||
			evidence.changeId !== evidence.sourceArtifact.change.id ||
			!same(evidence.sourceArtifact.change.subject, evidence.sourceArtifact.subject) ||
			canonicalize(evidence.manifest.subject) !== canonicalize(evidence.sourceArtifact.subject) ||
			canonicalize(evidence.manifest.blueprint) !==
				canonicalize(evidence.sourceArtifact.blueprint) ||
			canonicalize(evidence.manifest.bindingRefs) !==
				canonicalize(evidence.sourceArtifact.bindings.map((binding) => binding.id).sort()) ||
			evidence.changeId !== proof.projections[index]?.changeId ||
			evidence.manifest.id !== proof.projections[index]?.manifestId ||
			canonicalize(evidence.manifest.subject) !== canonicalize(proof.projections[index]?.subject) ||
			canonicalize(evidence.manifest.blueprint) !==
				canonicalize(proof.projections[index]?.blueprint) ||
			canonicalize(evidence.verifierObservation.subject) !==
				canonicalize(evidence.manifest.subject) ||
			canonicalize(evidence.verifierObservation.attestation) !==
				canonicalize(evidence.verifierResult) ||
			evidence.verifierObservation.topologyHash !== evidence.manifest.blueprint.topologyHash ||
			evidence.verifierObservation.result !==
				(evidence.verifierResult.result as { status?: unknown }).status ||
			sha256Jcs(evidence.sourceArtifact.topology) !== evidence.manifest.blueprint.topologyHash ||
			verifierAuthority?.digest !== verifierResultDigest ||
			evidence.verifierObservation.authorityDigest !== verifierResultDigest ||
			evidence.verifierObservation.resultDigest !== verifierResultDigest ||
			canonicalize(evidence.verifierObservation.coverage) !==
				canonicalize(
					[
						...evidence.verifierObservation.attestation.coverage.required,
						...evidence.verifierObservation.attestation.coverage.unchangedControls,
					].sort(),
				) ||
			testAuthority?.digest !== testResultDigest ||
			integrationAuthority?.kind !== "verifier" ||
			integrationAuthority.digest !== proof.integration.verification.id
		)
			throw new Error("CONSEQUENCE_PROOF_SOURCE_EVIDENCE");
		const projection = proof.projections[index];
		if (projection === undefined) throw new Error("CONSEQUENCE_PROOF_SOURCE_EVIDENCE");
		const anchorById = new Map(
			evidence.sourceArtifact.anchors.map((anchor) => [anchor.id, anchor]),
		);
		const resolutionByAnchor = new Map<string, ResolutionResult[]>();
		for (const resolution of evidence.sourceArtifact.resolutions) {
			const values = resolutionByAnchor.get(resolution.anchorId) ?? [];
			values.push(resolution);
			resolutionByAnchor.set(resolution.anchorId, values);
		}
		const bindingByAnchor = new Map<string, GraphSourceBinding[]>();
		for (const binding of evidence.sourceArtifact.bindings) {
			const values = bindingByAnchor.get(binding.anchorId) ?? [];
			values.push(binding);
			bindingByAnchor.set(binding.anchorId, values);
		}
		if (
			anchorById.size !== evidence.sourceArtifact.anchors.length ||
			resolutionByAnchor.size !== anchorById.size ||
			bindingByAnchor.size !== anchorById.size ||
			[...resolutionByAnchor.keys()].some((anchorId) => !anchorById.has(anchorId)) ||
			[...bindingByAnchor.keys()].some((anchorId) => !anchorById.has(anchorId)) ||
			evidence.sourceArtifact.anchors.some((anchor) => {
				const resolutions = resolutionByAnchor.get(anchor.id) ?? [];
				const bindings = bindingByAnchor.get(anchor.id) ?? [];
				return (
					resolutions.length !== 1 ||
					bindings.length !== 1 ||
					resolutions[0]?.disposition !== "exact" ||
					resolutions[0]?.freshness !== "current" ||
					!same(resolutions[0]?.candidates[0], anchor.candidate) ||
					!bindings[0] ||
					!same(bindings[0].coordinate, anchor.coordinate) ||
					bindings[0].topologyHash !== evidence.sourceArtifact.blueprint.topologyHash
				);
			})
		)
			throw new Error("CONSEQUENCE_PROOF_SOURCE_EVIDENCE");
		const expectedSourceScope = uniqueSorted(
			evidence.sourceArtifact.anchors.map((anchor) => anchor.candidate.symbol.name),
		);
		const expectedBindingRefs = uniqueSorted(
			evidence.sourceArtifact.bindings.map((binding) => binding.id),
		);
		const expectedDirect = uniqueSorted(
			evidence.sourceArtifact.bindings.map((binding) => ({
				nodeId: binding.nodeId,
				bindingRef: binding.id,
			})),
		);
		const directNodes = new Set(expectedDirect.map((entry) => entry.nodeId));
		const expectedReachable = uniqueSorted(
			expectedDirect
				.flatMap((entry) =>
					structuralPaths(
						entry.nodeId,
						evidence.sourceArtifact.topology as { nodes: { id: string; deps: string[] }[] },
					),
				)
				.filter((entry) => !directNodes.has(entry.to)),
		);
		const expectedRequired = uniqueSorted(evidence.verifierResult.coverage.required);
		const expectedUnchanged = uniqueSorted(
			evidence.verifierResult.coverage.unchangedControls.map((scope) => ({
				scope,
				verifierRef: evidence.verifierObservation.authorityRef,
				verifierDigest: evidence.verifierObservation.resultDigest,
			})),
		);
		const expectedDeclared = uniqueSorted([
			...expectedSourceScope,
			...expectedRequired,
			...evidence.verifierResult.coverage.unchangedControls,
		]);
		if (
			!same(projection.sourceScope, expectedSourceScope) ||
			!same(projection.direct, expectedDirect) ||
			!same(projection.reachable, expectedReachable) ||
			!same(projection.verificationRequired, expectedRequired) ||
			!same(projection.verifiedUnchanged, expectedUnchanged) ||
			!same(projection.unknowns, []) ||
			!same(projection.coverage, {
				bindings: "complete",
				evidence: "complete",
				declared: expectedDeclared,
			}) ||
			!same(
				projection.provenance.sourceResolutionRefs,
				uniqueSorted(evidence.sourceArtifact.resolutions.map((resolution) => resolution.id)),
			) ||
			!same(projection.provenance.bindingRefs, expectedBindingRefs) ||
			!same(
				projection.provenance.authorityRefs,
				uniqueSorted(evidence.manifest.authorities.map((authority) => authority.ref)),
			) ||
			!same(projection.readiness, { status: "verified", reasons: [] }) ||
			evidence.verifierObservation.freshness !== "current" ||
			evidence.verifierObservation.result !== "passed" ||
			!same(expectedBindingRefs, uniqueSorted(evidence.manifest.bindingRefs))
		)
			throw new Error("CONSEQUENCE_PROOF_SOURCE_EVIDENCE");
	}
	assertConsequenceIntegration(proof.integration.candidate, proof.integration.result);
	if (proof.integration.resultDigest !== sha256Jcs(proof.integration.result))
		throw new Error("CONSEQUENCE_PROOF_INTEGRATION_DIGEST");
	const candidate = proof.integration.candidate as {
		revisions: {
			mergeBase: { value: string } | null;
			target: { value: string };
			head: { value: string };
		};
		merge: { tree: { value: string } | null };
		provider: { runtimeVersion: string };
		evidence: {
			targetBlueprint: { blueprintHash: { value: string } } | null;
			headBlueprint: { blueprintHash: { value: string } } | null;
		};
	};
	const result = proof.integration.result as {
		candidateDigest: { value: string };
		outcome: "compatible" | "conflict" | "error";
	};
	const { id: _verificationId, ...verificationBody } = proof.integration.verification;
	if (
		proof.repository.identity !== proof.projections[0].subject.repository ||
		proof.repository.identity !== proof.projections[1].subject.repository ||
		proof.repository.base !== proof.projections[0].subject.base ||
		proof.repository.base !== proof.projections[1].subject.base ||
		proof.repository.left !== proof.projections[0].subject.head ||
		proof.repository.right !== proof.projections[1].subject.head ||
		candidate.revisions.mergeBase?.value !== proof.repository.base ||
		candidate.revisions.target.value !== proof.repository.left ||
		candidate.revisions.head.value !== proof.repository.right ||
		candidate.merge.tree?.value !== proof.repository.candidateTree ||
		candidate.provider.runtimeVersion !== proof.runtime.version ||
		candidate.evidence.targetBlueprint?.blueprintHash.value !==
			proof.projections[0].blueprint.topologyHash ||
		candidate.evidence.headBlueprint?.blueprintHash.value !==
			proof.projections[1].blueprint.topologyHash ||
		result.candidateDigest.value !== sha256Jcs(proof.integration.candidate) ||
		proof.integration.verification.id !== sha256Jcs(verificationBody) ||
		proof.integration.verification.candidateDigest !== result.candidateDigest.value ||
		proof.integration.verification.resultDigest !== proof.integration.resultDigest ||
		proof.integration.verification.candidateTree !== proof.repository.candidateTree ||
		proof.guidance.integration?.candidateDigest !== result.candidateDigest.value ||
		proof.guidance.integration?.resultDigest !== proof.integration.resultDigest ||
		proof.guidance.integration?.verifierDigest !== proof.integration.verification.id ||
		proof.guidance.integration?.outcome !== result.outcome
	)
		throw new Error("CONSEQUENCE_PROOF_CROSS_BINDING");
	const intersection = (left: string[], right: string[]) =>
		left.filter((entry) => right.includes(entry));
	const leftGraph = uniqueSorted([
		...proof.projections[0].direct.map((entry) => entry.nodeId),
		...proof.projections[0].reachable.map((entry) => entry.to),
	]);
	const rightGraph = uniqueSorted([
		...proof.projections[1].direct.map((entry) => entry.nodeId),
		...proof.projections[1].reachable.map((entry) => entry.to),
	]);
	const frameworkAuthorityRefs = new Set([
		"graphrefly-stack:D57",
		"graphrefly-stack:D58",
		"graphrefly-stack:D59",
	]);
	const relevantAuthorities = (projection: ConsequenceProjection) =>
		projection.provenance.authorityRefs.filter(
			(ref) =>
				ref !== proof.integration.verification.verifierRef && !frameworkAuthorityRefs.has(ref),
		);
	const expectedWitnesses: ConsequenceGuidance["witnesses"] = uniqueSorted([
		...intersection(
			proof.projections[0].provenance.sourceResolutionRefs,
			proof.projections[1].provenance.sourceResolutionRefs,
		).map((value) => ({ kind: "source" as const, value })),
		...intersection(leftGraph, rightGraph).map((value) => ({ kind: "graph" as const, value })),
		...intersection(
			relevantAuthorities(proof.projections[0]),
			relevantAuthorities(proof.projections[1]),
		).map((value) => ({ kind: "authority" as const, value })),
	]);
	const expectedGuidanceStatus =
		result.outcome === "conflict"
			? "incompatible"
			: expectedWitnesses.length > 0
				? "overlap-observed"
				: "no-overlap-observed";
	if (
		proof.guidance.status !== expectedGuidanceStatus ||
		!same(proof.guidance.witnesses, expectedWitnesses) ||
		!same(proof.guidance.coverage, {
			complete: true,
			scope: uniqueSorted([
				...proof.projections[0].coverage.declared,
				...proof.projections[1].coverage.declared,
			]),
		})
	)
		throw new Error("CONSEQUENCE_PROOF_GUIDANCE_DERIVATION");
	if (
		proof.axes.length !== proof.projections.length ||
		proof.axes.some(
			(axis, index) =>
				canonicalize(axis.evidence) !== canonicalize(proof.projections[index]?.readiness) ||
				(axis.human.status !== "outdated" &&
					axis.human.targetDigest !== proof.projections[index]?.id) ||
				(axis.ownerAdmission !== null &&
					axis.ownerAdmission.targetDigest !== proof.projections[index]?.id),
		)
	)
		throw new Error("CONSEQUENCE_PROOF_AXES");
}
