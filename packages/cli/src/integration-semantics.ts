import { readFile } from "node:fs/promises";
import {
	assertIntegrationIntegrity,
	canonicalize,
	createStrictAjv,
	INTEGRATION_ARTIFACTS_SCHEMA,
	INTEGRATION_CONFLICT_REASONS,
	INTEGRATION_REASON_ORDER,
	INTEGRATION_RESULT_SCHEMA,
	type IntegrationReasonCode,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import type {
	IntegrationEffectConflict,
	IntegrationEffectEvaluation,
	IntegrationEffectWitness,
} from "@graphrefly-stack/core";

import type { IntegrationCandidateArtifact } from "./integration-candidate.js";
import { runtimeAssetPath } from "./runtime-paths.js";
import { evaluateSemanticPredicate } from "./semantic-repository.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export type IntegrationSemanticWitness =
	| { kind: "path"; path: string }
	| { kind: "claim"; workUnitId: string; claimId: string }
	| { kind: "dependency"; workUnitId: string; dependencyId: string }
	| { kind: "policy"; policyDigest: Hash }
	| { kind: "diagnostics"; code: string; path: string | null };

export interface IntegrationSemanticEvaluation {
	reasonCodes: IntegrationReasonCode[];
	conflicts: { reasonCode: IntegrationReasonCode; witness: IntegrationSemanticWitness }[];
	headGate: { inputDigest: Hash; resultDigest: Hash; verdict: unknown };
}

type IntegrationConflictRecord =
	| IntegrationEffectConflict
	| { reasonCode: IntegrationReasonCode; witness: IntegrationSemanticWitness };

export interface IntegrationResultArtifact {
	schema: typeof INTEGRATION_RESULT_SCHEMA;
	candidateDigest: Hash;
	observedRevisions: {
		target: IntegrationCandidateArtifact["revisions"]["target"];
		head: IntegrationCandidateArtifact["revisions"]["head"];
	};
	outcome: "compatible" | "conflict" | "error";
	reasonCodes: IntegrationReasonCode[];
	overlaps: IntegrationEffectWitness[];
	conflicts: IntegrationConflictRecord[];
}

const integrationSchemaPath = runtimeAssetPath("contracts/integration/v1/artifacts.schema.json");

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function objects(value: unknown): JsonObject[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is JsonObject =>
					typeof entry === "object" && entry !== null && !Array.isArray(entry),
			)
		: [];
}

function compareCanonical(left: unknown, right: unknown): number {
	const leftBytes = canonicalize(left);
	const rightBytes = canonicalize(right);
	return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
}

function addUnique<T>(values: T[], value: T): void {
	const bytes = canonicalize(value);
	if (!values.some((entry) => canonicalize(entry) === bytes)) values.push(value);
}

export function evaluateIntegrationSemantics(options: {
	plan: JsonObject;
	candidateBlueprint: JsonObject;
	acceptedPolicyDigest: Hash;
	candidatePolicyDigest: Hash;
	headGateInput: JsonObject;
	headGateResult: JsonObject;
}): IntegrationSemanticEvaluation {
	const conflicts: IntegrationSemanticEvaluation["conflicts"] = [];
	const invalid = new Set<string>();
	if (canonicalize(options.acceptedPolicyDigest) !== canonicalize(options.candidatePolicyDigest)) {
		addUnique(conflicts, {
			reasonCode: "POLICY_INVALIDATED",
			witness: { kind: "policy", policyDigest: options.acceptedPolicyDigest },
		});
	}
	if (options.headGateResult.verdict !== "pass") {
		addUnique(conflicts, {
			reasonCode: "HEAD_GATE_NOT_PASSING",
			witness: { kind: "diagnostics", code: "HEAD_GATE_NOT_PASSING", path: null },
		});
	}
	for (const unit of objects(options.plan.workUnits)) {
		const workUnitId = typeof unit.id === "string" ? unit.id : "unknown";
		for (const dependencyId of strings(unit.dependencies)) {
			if (!invalid.has(dependencyId)) continue;
			invalid.add(workUnitId);
			addUnique(conflicts, {
				reasonCode: "DEPENDENCY_INVALIDATED",
				witness: { kind: "dependency", workUnitId, dependencyId },
			});
		}
		for (const claim of objects(unit.claims)) {
			const claimId = typeof claim.id === "string" ? claim.id : "unknown";
			const predicate =
				typeof claim.predicate === "object" &&
				claim.predicate !== null &&
				!Array.isArray(claim.predicate)
					? (claim.predicate as JsonObject)
					: {};
			if (evaluateSemanticPredicate(options.candidateBlueprint, predicate).ok) continue;
			invalid.add(workUnitId);
			addUnique(conflicts, {
				reasonCode: "CLAIM_INVALIDATED",
				witness: { kind: "claim", workUnitId, claimId },
			});
		}
	}
	conflicts.sort(compareCanonical);
	const present = new Set(conflicts.map((conflict) => conflict.reasonCode));
	return {
		reasonCodes: INTEGRATION_REASON_ORDER.filter((reason) => present.has(reason)),
		conflicts,
		headGate: {
			inputDigest: { algorithm: "sha256", value: sha256Jcs(options.headGateInput) },
			resultDigest: { algorithm: "sha256", value: sha256Jcs(options.headGateResult) },
			verdict: options.headGateResult.verdict,
		},
	};
}

export async function assembleIntegrationResult(options: {
	candidate: IntegrationCandidateArtifact;
	graph: IntegrationEffectEvaluation;
	semantic: IntegrationSemanticEvaluation;
}): Promise<IntegrationResultArtifact> {
	if (canonicalize(options.candidate.headGate) !== canonicalize(options.semantic.headGate)) {
		throw new Error(
			"IntegrationResult head GateInput or GateResult identity does not match candidate",
		);
	}
	const conflicts = [...options.graph.conflicts, ...options.semantic.conflicts];
	conflicts.sort(compareCanonical);
	const present = new Set(conflicts.map((conflict) => conflict.reasonCode));
	const result = {
		schema: INTEGRATION_RESULT_SCHEMA,
		candidateDigest: { algorithm: "sha256" as const, value: sha256Jcs(options.candidate) },
		observedRevisions: {
			target: options.candidate.revisions.target,
			head: options.candidate.revisions.head,
		},
		outcome: conflicts.length === 0 ? ("compatible" as const) : ("conflict" as const),
		reasonCodes: INTEGRATION_REASON_ORDER.filter((reason) => present.has(reason)),
		overlaps: [...options.graph.overlaps].sort(compareCanonical),
		conflicts,
	};
	const schema = JSON.parse(await readFile(integrationSchemaPath, "utf8"));
	const ajv = createStrictAjv();
	ajv.addSchema(schema);
	const validate = ajv.getSchema(`${INTEGRATION_ARTIFACTS_SCHEMA}#/definitions/IntegrationResult`);
	if (validate === undefined || !validate(result)) {
		throw new Error(`IntegrationResult failed validation: ${JSON.stringify(validate?.errors)}`);
	}
	assertIntegrationIntegrity(options.candidate, result);
	return result;
}

export async function assembleIntegrationFailureResult(options: {
	candidate: IntegrationCandidateArtifact;
	reasonCode: IntegrationReasonCode;
	observedRevisions?: IntegrationResultArtifact["observedRevisions"];
	witnesses?: IntegrationSemanticWitness[];
}): Promise<IntegrationResultArtifact> {
	const conflictReasons = new Set<IntegrationReasonCode>(INTEGRATION_CONFLICT_REASONS);
	const outcome = conflictReasons.has(options.reasonCode) ? "conflict" : "error";
	if (options.candidate.status !== outcome) {
		throw new Error("Integration failure candidate status does not match its result outcome");
	}
	const witnesses = options.witnesses ?? [
		{ kind: "diagnostics", code: options.reasonCode, path: null } as const,
	];
	const conflicts = witnesses.map((witness) => ({ reasonCode: options.reasonCode, witness }));
	conflicts.sort(compareCanonical);
	const result: IntegrationResultArtifact = {
		schema: INTEGRATION_RESULT_SCHEMA,
		candidateDigest: { algorithm: "sha256", value: sha256Jcs(options.candidate) },
		observedRevisions: options.observedRevisions ?? {
			target: options.candidate.revisions.target,
			head: options.candidate.revisions.head,
		},
		outcome,
		reasonCodes: INTEGRATION_REASON_ORDER.filter((reason) => reason === options.reasonCode),
		overlaps: [],
		conflicts,
	};
	const schema = JSON.parse(await readFile(integrationSchemaPath, "utf8"));
	const ajv = createStrictAjv();
	ajv.addSchema(schema);
	const validate = ajv.getSchema(`${INTEGRATION_ARTIFACTS_SCHEMA}#/definitions/IntegrationResult`);
	if (validate === undefined || !validate(result)) {
		throw new Error(`IntegrationResult failed validation: ${JSON.stringify(validate?.errors)}`);
	}
	assertIntegrationIntegrity(options.candidate, result);
	return result;
}
