import {
	INTEGRATION_CONFLICT_REASONS,
	INTEGRATION_REASON_ORDER,
	type IntegrationReasonCode,
} from "./integration.js";
import { canonicalize, sha256Jcs } from "./jcs.js";

type JsonObject = Record<string, unknown>;

export class IntegrationIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntegrationIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new IntegrationIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function present(value: unknown): boolean {
	return value !== null && value !== undefined;
}

function isSorted(values: unknown[]): boolean {
	return values.every(
		(value, index) => index === 0 || canonicalize(values[index - 1]) < canonicalize(value),
	);
}

export function assertIntegrationIntegrity(candidateValue: unknown, resultValue: unknown): void {
	const candidate = object(candidateValue, "integration candidate");
	const result = object(resultValue, "integration result");
	const revisions = object(candidate.revisions, "candidate revisions");
	const observed = object(result.observedRevisions, "observed revisions");
	const merge = object(candidate.merge, "candidate merge");
	const evidence = object(candidate.evidence, "candidate evidence");
	const gate = object(candidate.headGate, "head gate");
	const candidateDigest = object(result.candidateDigest, "candidate digest");
	const reasons = Array.isArray(result.reasonCodes)
		? (result.reasonCodes as IntegrationReasonCode[])
		: [];
	const overlaps = Array.isArray(result.overlaps) ? result.overlaps : [];
	const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
	const presentReasons = new Set(reasons);
	const orderedReasons = INTEGRATION_REASON_ORDER.filter((reason) => presentReasons.has(reason));
	const conflictReasonSet = new Set<IntegrationReasonCode>(INTEGRATION_CONFLICT_REASONS);
	const blockingReasons = reasons.filter((reason) => conflictReasonSet.has(reason));
	const candidateReady =
		candidate.status === "ready" &&
		object(candidate.topology, "candidate topology").mergeBase === "unique" &&
		object(candidate.topology, "candidate topology").headRange === "linear" &&
		merge.status === "merged" &&
		present(merge.tree) &&
		present(revisions.mergeBase) &&
		present(evidence.baseBlueprint) &&
		present(evidence.targetBlueprint) &&
		present(evidence.headBlueprint) &&
		present(evidence.candidateBlueprint) &&
		present(evidence.targetDelta) &&
		present(evidence.headDelta);
	const baseBlueprint = present(evidence.baseBlueprint)
		? object(evidence.baseBlueprint, "base Blueprint evidence")
		: null;
	const targetBlueprint = present(evidence.targetBlueprint)
		? object(evidence.targetBlueprint, "target Blueprint evidence")
		: null;
	const headBlueprint = present(evidence.headBlueprint)
		? object(evidence.headBlueprint, "head Blueprint evidence")
		: null;
	const candidateBlueprint = present(evidence.candidateBlueprint)
		? object(evidence.candidateBlueprint, "candidate Blueprint evidence")
		: null;
	const targetDelta = present(evidence.targetDelta)
		? object(evidence.targetDelta, "target delta evidence")
		: null;
	const headDelta = present(evidence.headDelta)
		? object(evidence.headDelta, "head delta evidence")
		: null;
	const evidenceBindingsValid =
		(baseBlueprint === null || equal(baseBlueprint.revision, revisions.mergeBase)) &&
		(targetBlueprint === null || equal(targetBlueprint.revision, revisions.target)) &&
		(headBlueprint === null || equal(headBlueprint.revision, revisions.head)) &&
		(candidateBlueprint === null || equal(candidateBlueprint.revision, merge.tree)) &&
		(targetDelta === null ||
			(equal(targetDelta.from, revisions.mergeBase) && equal(targetDelta.to, revisions.target))) &&
		(headDelta === null ||
			(equal(headDelta.from, revisions.mergeBase) && equal(headDelta.to, revisions.head)));
	const targetRevisionBindingValid = presentReasons.has("TARGET_MOVED")
		? !equal(observed.target, revisions.target)
		: equal(observed.target, revisions.target);
	const headRevisionBindingValid = presentReasons.has("HEAD_MOVED")
		? !equal(observed.head, revisions.head)
		: equal(observed.head, revisions.head);

	if (
		candidateDigest.value !== sha256Jcs(candidate) ||
		!targetRevisionBindingValid ||
		!headRevisionBindingValid ||
		!equal(reasons, orderedReasons) ||
		new Set(reasons).size !== reasons.length ||
		!isSorted(overlaps) ||
		!isSorted(conflicts) ||
		!evidenceBindingsValid
	) {
		throw new IntegrationIntegrityError("integration result cross-binding or ordering is invalid");
	}

	for (const conflict of conflicts) {
		const record = object(conflict, "integration conflict");
		if (
			!reasons.includes(record.reasonCode as IntegrationReasonCode) ||
			(result.outcome === "conflict" &&
				!conflictReasonSet.has(record.reasonCode as IntegrationReasonCode))
		) {
			throw new IntegrationIntegrityError(
				"integration conflict is not represented by a reason code",
			);
		}
	}
	if (
		result.outcome === "conflict" &&
		blockingReasons.some(
			(reason) =>
				!conflicts.some(
					(conflict) => object(conflict, "integration conflict").reasonCode === reason,
				),
		)
	) {
		throw new IntegrationIntegrityError("blocking reason has no exact conflict witness");
	}

	if (
		(result.outcome === "compatible" &&
			(!candidateReady || gate.verdict !== "pass" || reasons.length > 0 || conflicts.length > 0)) ||
		(result.outcome === "conflict" && (blockingReasons.length === 0 || conflicts.length === 0)) ||
		(result.outcome === "error" && reasons.length === 0)
	) {
		throw new IntegrationIntegrityError("integration outcome is inconsistent with its evidence");
	}
}
