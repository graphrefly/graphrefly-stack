import {
	assertDagSemanticIntegrity,
	canonicalize,
	DAG_REASON_ORDER,
	type DagReasonCode,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

export interface DagGateV2Request {
	readonly topology: JsonObject;
	readonly dependencyGraph: JsonObject;
	readonly bindings: readonly JsonObject[];
	readonly records: readonly JsonObject[];
	readonly unitEvaluations: readonly JsonObject[];
	readonly joinEvaluations: readonly JsonObject[];
	readonly policyDigest: JsonObject;
	readonly planDigest: JsonObject;
}

export interface DagGateV2Computation {
	readonly gateInput: JsonObject;
	readonly gateResult: JsonObject;
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function digest(value: unknown): { algorithm: "sha256"; value: string } {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function oidKey(value: unknown): string {
	return canonicalize(object(value, "Git OID"));
}

function indexUnique(
	values: readonly JsonObject[],
	key: (value: JsonObject) => string,
	label: string,
): Map<string, JsonObject> {
	const result = new Map<string, JsonObject>();
	for (const value of values) {
		const id = key(value);
		if (result.has(id)) throw new TypeError(`${label} repeats ${id}`);
		result.set(id, value);
	}
	return result;
}

function sortReasons(reasons: ReadonlySet<DagReasonCode>): DagReasonCode[] {
	return [...reasons].sort(
		(left, right) => DAG_REASON_ORDER.indexOf(left) - DAG_REASON_ORDER.indexOf(right),
	);
}

function sortWitnesses(witnesses: readonly JsonObject[]): JsonObject[] {
	const byBytes = new Map(witnesses.map((witness) => [canonicalize(witness), witness] as const));
	return [...byBytes.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, witness]) => witness);
}

/**
 * Computes the bounded DAG v2 gate from immutable evidence. Result reasons,
 * affected-cut membership, and the aggregate verdict are derived values rather
 * than caller-editable inputs.
 */
export function computeDagGateV2(request: DagGateV2Request): DagGateV2Computation {
	const nodes = objects(request.dependencyGraph.workUnits, "dependency WorkUnits");
	const order = nodes.map((node) => string(node.workUnitId, "WorkUnit ID"));
	const nodeById = indexUnique(nodes, (node) => string(node.workUnitId, "WorkUnit ID"), "graph");
	const bindingById = indexUnique(
		request.bindings,
		(binding) => string(binding.workUnitId, "binding WorkUnit ID"),
		"bindings",
	);
	const recordById = indexUnique(
		request.records,
		(record) => string(record.workUnitId, "record WorkUnit ID"),
		"records",
	);
	const evaluationById = indexUnique(
		request.unitEvaluations,
		(evaluation) => string(evaluation.workUnitId, "evaluation WorkUnit ID"),
		"unit evaluations",
	);
	const joins = objects(request.topology.joins, "topology joins");
	const joinEvaluationByOid = indexUnique(
		request.joinEvaluations,
		(evaluation) => oidKey(evaluation.oid),
		"join evaluations",
	);

	const bindings = order.map((id) => object(bindingById.get(id), `${id} binding`));
	const records = order.map((id) => object(recordById.get(id), `${id} record`));
	const unitEvaluations = order.map((id) => object(evaluationById.get(id), `${id} evaluation`));
	const joinEvaluations = joins.map((join) =>
		object(joinEvaluationByOid.get(oidKey(join.oid)), "join evaluation"),
	);
	const checkDigests = unitEvaluations.flatMap((evaluation) =>
		objects(evaluation.checks, "evaluated checks").map((check) => ({
			workUnitId: evaluation.workUnitId,
			checkId: check.checkId,
			digest: check.digest,
		})),
	);

	const gateInput: JsonObject = {
		schema: "graphrefly.stack.dag-gate-input.v2",
		topologyDigest: digest(request.topology),
		dependencyGraphDigest: digest(request.dependencyGraph),
		policyDigest: request.policyDigest,
		planDigest: request.planDigest,
		bindingDigests: bindings.map((binding) => ({
			workUnitId: binding.workUnitId,
			digest: digest(binding),
		})),
		recordDigests: records.map((record) => ({
			workUnitId: record.workUnitId,
			digest: digest(record),
		})),
		joinDigests: joins.map((join) => ({ oid: join.oid, digest: digest(join) })),
		checkDigests,
		unitEvaluationDigests: unitEvaluations.map((evaluation) => ({
			workUnitId: evaluation.workUnitId,
			digest: digest(evaluation),
		})),
		joinEvaluationDigests: joinEvaluations.map((evaluation) => ({
			oid: evaluation.oid,
			digest: digest(evaluation),
		})),
	};

	const invalid = new Set<string>();
	const units = order.map((id) => {
		const node = object(nodeById.get(id), `${id} dependency node`);
		const record = object(recordById.get(id), `${id} record`);
		const evaluation = object(evaluationById.get(id), `${id} evaluation`);
		const reasons = new Set<DagReasonCode>();
		const witnesses: JsonObject[] = [];
		const sourceScope = object(evaluation.sourceScope, `${id} source-scope evaluation`);
		if (sourceScope.valid !== true) {
			reasons.add("SOURCE_SCOPE_VIOLATION");
			witnesses.push({
				kind: "source-scope",
				workUnitId: id,
				witnessDigest: sourceScope.witnessDigest,
			});
		}
		if (!equal(evaluation.blueprintHash, record.blueprintHash)) {
			reasons.add("BLUEPRINT_WITNESS_STALE");
			witnesses.push({ kind: "artifact", artifactKind: "record", digest: digest(record) });
		}
		if (!equal(evaluation.policyDigest, record.policyDigest)) {
			reasons.add("POLICY_REVISION_STALE");
			witnesses.push({
				kind: "policy",
				workUnitId: id,
				expected: record.policyDigest,
				observed: evaluation.policyDigest,
			});
		}
		const recordedClaims = indexUnique(
			objects(record.claimWitnesses, `${id} recorded claims`),
			(claim) => string(claim.claimId, "claim ID"),
			"recorded claims",
		);
		for (const claim of objects(evaluation.claims, `${id} evaluated claims`)) {
			const claimId = string(claim.claimId, "claim ID");
			if (claim.valid !== true || recordedClaims.get(claimId)?.status !== "satisfied") {
				reasons.add("CLAIM_INVALID");
				witnesses.push({ kind: "claim", workUnitId: id, claimId });
			}
		}
		for (const check of objects(evaluation.checks, `${id} evaluated checks`)) {
			const checkId = string(check.checkId, "check ID");
			if (check.status === "missing") reasons.add("REQUIRED_CHECK_MISSING");
			if (check.status === "failed") reasons.add("REQUIRED_CHECK_FAILED");
			if (check.status !== "passed") {
				witnesses.push({ kind: "check", workUnitId: id, checkId, digest: check.digest });
			}
		}
		for (const dependencyId of node.dependencies as string[]) {
			if (invalid.has(dependencyId)) {
				reasons.add("DEPENDENCY_INVALID");
				witnesses.push({ kind: "dependency", workUnitId: id, dependencyId });
			}
		}
		if (reasons.size > 0) invalid.add(id);
		return {
			workUnitId: id,
			verdict: reasons.size === 0 ? "valid" : "invalid",
			reasonCodes: sortReasons(reasons),
			witnesses: sortWitnesses(witnesses),
			recordId: record.recordId,
		};
	});

	const joinResults = joins.map((join, index) => {
		const evaluation = joinEvaluations[index] as JsonObject;
		const valid = evaluation.valid === true;
		const witnesses = objects(evaluation.witnesses, "join witnesses");
		return {
			oid: join.oid,
			verdict: valid ? "valid" : "invalid",
			reasonCodes: valid ? [] : ["JOIN_INVALID"],
			witnesses: sortWitnesses(witnesses),
		};
	});
	const minimalAffectedCut = order.filter(
		(id) =>
			invalid.has(id) &&
			!(nodeById.get(id)?.dependencies as string[]).some((dependency) => invalid.has(dependency)),
	);
	const hasInvalidJoin = joinResults.some((join) => join.verdict === "invalid");
	const gateResult: JsonObject = {
		schema: "graphrefly.stack.dag-gate-result.v2",
		inputDigest: digest(gateInput),
		verdict: invalid.size === 0 && !hasInvalidJoin ? "pass" : "blocked",
		minimalAffectedCut,
		units,
		joins: joinResults,
	};

	assertDagSemanticIntegrity({
		topology: request.topology,
		dependencyGraph: request.dependencyGraph,
		bindings,
		records,
		unitEvaluations,
		joinEvaluations,
		gateInput,
		gateResult,
	});
	return { gateInput, gateResult };
}
