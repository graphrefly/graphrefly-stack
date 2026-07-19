import { DAG_REASON_ORDER, type DagReasonCode } from "./dag.js";
import { assertDagTopologyIntegrity, DagIntegrityError } from "./dag-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";

type JsonObject = Record<string, unknown>;

export class DagSemanticIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagSemanticIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagSemanticIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function array(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new DagSemanticIntegrityError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") throw new DagSemanticIntegrityError(`${label} must be a string`);
	return value;
}

function oid(value: unknown, label: string): string {
	const entry = object(value, label);
	return `${string(entry.algorithm, `${label} algorithm`)}:${string(entry.value, `${label} value`)}`;
}

function hash(value: unknown, label: string): string {
	const entry = object(value, label);
	if (entry.algorithm !== "sha256") throw new DagSemanticIntegrityError(`${label} is not SHA-256`);
	return string(entry.value, `${label} value`);
}

function hashObject(value: unknown): { algorithm: "sha256"; value: string } {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function assertSortedUnique(values: string[], label: string): void {
	for (let index = 0; index < values.length; index += 1) {
		if (index > 0 && (values[index - 1] as string) >= (values[index] as string)) {
			throw new DagSemanticIntegrityError(`${label} is not strictly sorted and unique`);
		}
	}
}

function assertReasonOrder(reasons: unknown, label: string): DagReasonCode[] {
	if (!Array.isArray(reasons)) throw new DagSemanticIntegrityError(`${label} must be an array`);
	const values = reasons.map((reason) => string(reason, label) as DagReasonCode);
	let previous = -1;
	for (const reason of values) {
		const current = DAG_REASON_ORDER.indexOf(reason);
		if (current === -1 || current <= previous) {
			throw new DagSemanticIntegrityError(`${label} is not in canonical reason order`);
		}
		previous = current;
	}
	return values;
}

function assertWitnessOrder(witnesses: unknown, label: string): void {
	if (!Array.isArray(witnesses)) throw new DagSemanticIntegrityError(`${label} must be an array`);
	const keys = witnesses.map(canonicalize);
	assertSortedUnique(keys, label);
}

function sortedReasons(reasons: ReadonlySet<DagReasonCode>): DagReasonCode[] {
	return [...reasons].sort(
		(left, right) => DAG_REASON_ORDER.indexOf(left) - DAG_REASON_ORDER.indexOf(right),
	);
}

function sortedWitnesses(witnesses: readonly JsonObject[]): JsonObject[] {
	const byBytes = new Map(witnesses.map((witness) => [canonicalize(witness), witness] as const));
	return [...byBytes.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, witness]) => witness);
}

export function assertDagSemanticIntegrity(value: {
	topology: unknown;
	dependencyGraph: unknown;
	bindings: unknown;
	records: unknown;
	unitEvaluations: unknown;
	joinEvaluations: unknown;
	gateInput: unknown;
	gateResult: unknown;
}): void {
	try {
		assertDagTopologyIntegrity(value.topology);
	} catch (error) {
		throw new DagSemanticIntegrityError(
			error instanceof DagIntegrityError ? error.message : "DAG topology integrity failed",
		);
	}
	const topology = object(value.topology, "topology");
	const graph = object(value.dependencyGraph, "dependency graph");
	const bindings = array(value.bindings, "binding");
	const records = array(value.records, "record");
	const unitEvaluations = array(value.unitEvaluations, "unit evaluation");
	const joinEvaluations = array(value.joinEvaluations, "join evaluation");
	const input = object(value.gateInput, "gate input");
	const result = object(value.gateResult, "gate result");
	if (!equal(graph.topologyDigest, hashObject(topology))) {
		throw new DagSemanticIntegrityError("dependency graph topology digest does not match");
	}

	const nodes = array(graph.workUnits, "dependency node");
	const nodeById = new Map<string, JsonObject>();
	for (const node of nodes) {
		const id = string(node.workUnitId, "WorkUnit ID");
		if (nodeById.has(id))
			throw new DagSemanticIntegrityError("dependency graph repeats a WorkUnit");
		const dependencies = Array.isArray(node.dependencies)
			? node.dependencies.map((dependency) => string(dependency, "dependency ID"))
			: [];
		assertSortedUnique(dependencies, `${id} dependencies`);
		if (dependencies.includes(id))
			throw new DagSemanticIntegrityError("dependency graph is cyclic");
		nodeById.set(id, node);
	}
	for (const [id, node] of nodeById) {
		for (const dependency of node.dependencies as string[]) {
			if (!nodeById.has(dependency)) {
				throw new DagSemanticIntegrityError(`${id} has a missing dependency`);
			}
		}
	}
	const canonicalOrder: string[] = [];
	const remaining = new Set(nodeById.keys());
	while (remaining.size > 0) {
		const next = [...remaining]
			.filter((id) =>
				(nodeById.get(id)?.dependencies as string[]).every((dependency) =>
					canonicalOrder.includes(dependency),
				),
			)
			.sort()[0];
		if (next === undefined) throw new DagSemanticIntegrityError("dependency graph is cyclic");
		canonicalOrder.push(next);
		remaining.delete(next);
	}
	if (
		!equal(
			nodes.map((node) => node.workUnitId),
			canonicalOrder,
		)
	) {
		throw new DagSemanticIntegrityError("dependency graph is not in canonical partial order");
	}

	const topologyObjects = array(topology.objects, "topology object");
	const topologyByOid = new Map(
		topologyObjects.map((entry) => [oid(entry.oid, "topology OID"), entry] as const),
	);
	const implementationByWorkUnit = new Map<string, JsonObject>();
	for (const entry of topologyObjects) {
		if (entry.kind !== "implementation") continue;
		const workUnitId = string(entry.workUnitId, "topology WorkUnit ID");
		if (implementationByWorkUnit.has(workUnitId)) {
			throw new DagSemanticIntegrityError("topology repeats a WorkUnit binding");
		}
		implementationByWorkUnit.set(workUnitId, entry);
	}
	if (
		implementationByWorkUnit.size !== canonicalOrder.length ||
		canonicalOrder.some((id) => !implementationByWorkUnit.has(id))
	) {
		throw new DagSemanticIntegrityError(
			"semantic WorkUnits do not exactly match implementation objects",
		);
	}

	const ancestryMemo = new Map<string, boolean>();
	const base = oid(topology.base, "topology base");
	const isAncestor = (ancestor: string, descendant: string): boolean => {
		if (ancestor === descendant) return true;
		if (descendant === base) return ancestor === base;
		const key = `${ancestor}>${descendant}`;
		const cached = ancestryMemo.get(key);
		if (cached !== undefined) return cached;
		const entry = topologyByOid.get(descendant);
		const answer =
			entry !== undefined &&
			(entry.parents as unknown[]).some((parent) => isAncestor(ancestor, oid(parent, "parent")));
		ancestryMemo.set(key, answer);
		return answer;
	};

	if (bindings.length !== canonicalOrder.length) {
		throw new DagSemanticIntegrityError("binding count does not match semantic graph");
	}
	const bindingById = new Map<string, JsonObject>();
	for (const binding of bindings) {
		const id = string(binding.workUnitId, "binding WorkUnit ID");
		if (bindingById.has(id)) throw new DagSemanticIntegrityError("bindings repeat a WorkUnit");
		bindingById.set(id, binding);
	}
	if (
		!equal(
			bindings.map((binding) => binding.workUnitId),
			canonicalOrder,
		)
	) {
		throw new DagSemanticIntegrityError("bindings are not in canonical partial order");
	}
	for (const id of canonicalOrder) {
		const binding = bindingById.get(id) as JsonObject;
		const objectEntry = implementationByWorkUnit.get(id) as JsonObject;
		if (
			binding.planId !== graph.planId ||
			!equal(binding.commit, objectEntry.oid) ||
			!equal(binding.parentCommit, (objectEntry.parents as unknown[])[0]) ||
			!equal(binding.blueprintHash, objectEntry.blueprintHash) ||
			object(binding.trailer, "binding trailer").value !== id
		) {
			throw new DagSemanticIntegrityError(`${id} binding does not match topology`);
		}
		const changedPaths = Array.isArray(binding.changedPaths)
			? binding.changedPaths.map((path) => string(path, "changed path"))
			: [];
		assertSortedUnique(changedPaths, `${id} changed paths`);
		if (binding.rebindFrom !== null) {
			const rebind = object(binding.rebindFrom, "rebind evidence");
			if (rebind.stablePatchId !== binding.stablePatchId) {
				throw new DagSemanticIntegrityError(`${id} rebind does not preserve stable patch identity`);
			}
		}
		const dependentCommit = oid(binding.commit, "dependent commit");
		for (const dependencyId of nodeById.get(id)?.dependencies as string[]) {
			const dependencyBinding = bindingById.get(dependencyId) as JsonObject;
			if (!isAncestor(oid(dependencyBinding.commit, "dependency commit"), dependentCommit)) {
				throw new DagSemanticIntegrityError(`${dependencyId} is not an ancestor of ${id}`);
			}
		}
	}

	if (
		records.length !== canonicalOrder.length ||
		!equal(
			records.map((record) => record.workUnitId),
			canonicalOrder,
		)
	) {
		throw new DagSemanticIntegrityError("records are not in canonical partial order");
	}
	const recordById = new Map<string, JsonObject>();
	for (const record of records) {
		const id = string(record.workUnitId, "record WorkUnit ID");
		const recordId = string(record.recordId, "record ID");
		if (recordById.has(id)) throw new DagSemanticIntegrityError("records repeat a WorkUnit");
		recordById.set(id, record);
		const binding = bindingById.get(id) as JsonObject;
		const dependencies = nodeById.get(id)?.dependencies as string[];
		const dependencyRecordIds = dependencies
			.map((dependency) => string(recordById.get(dependency)?.recordId, "dependency record ID"))
			.sort();
		if (
			record.planId !== graph.planId ||
			!equal(record.bindingDigest, hashObject(binding)) ||
			!equal(record.directDependencyRecordIds, dependencyRecordIds) ||
			!equal(record.blueprintHash, binding.blueprintHash) ||
			!equal(record.policyDigest, input.policyDigest)
		) {
			throw new DagSemanticIntegrityError(`${recordId} does not match its binding or dependencies`);
		}
		const requiredChecks = (record.requiredChecks as string[]).map((entry) =>
			string(entry, "required check"),
		);
		assertSortedUnique(requiredChecks, `${id} required checks`);
		const claimIds = array(record.claimWitnesses, "claim witness").map((entry) =>
			string(entry.claimId, "claim ID"),
		);
		assertSortedUnique(claimIds, `${id} claim witnesses`);
	}

	const expectedBindingDigests = canonicalOrder.map((id) => ({
		workUnitId: id,
		digest: hashObject(bindingById.get(id)),
	}));
	const expectedRecordDigests = canonicalOrder.map((id) => ({
		workUnitId: id,
		digest: hashObject(recordById.get(id)),
	}));
	const joins = array(topology.joins, "join");
	const expectedJoinDigests = joins.map((join) => ({
		oid: join.oid,
		digest: hashObject(join),
	}));
	if (
		unitEvaluations.length !== canonicalOrder.length ||
		!equal(
			unitEvaluations.map((entry) => entry.workUnitId),
			canonicalOrder,
		)
	) {
		throw new DagSemanticIntegrityError("unit evaluations are not in canonical partial order");
	}
	const evaluationById = new Map<string, JsonObject>();
	for (const evaluation of unitEvaluations) {
		const id = string(evaluation.workUnitId, "evaluation WorkUnit ID");
		evaluationById.set(id, evaluation);
		const binding = bindingById.get(id) as JsonObject;
		const record = recordById.get(id) as JsonObject;
		if (
			!equal(evaluation.bindingDigest, hashObject(binding)) ||
			!equal(evaluation.recordDigest, hashObject(record))
		) {
			throw new DagSemanticIntegrityError(`${id} evaluation does not match immutable evidence`);
		}
		const claimIds = array(evaluation.claims, "evaluated claim").map((entry) =>
			string(entry.claimId, "evaluated claim ID"),
		);
		assertSortedUnique(claimIds, `${id} evaluated claims`);
		if (
			!equal(
				claimIds,
				array(record.claimWitnesses, "record claim").map((entry) => entry.claimId),
			)
		) {
			throw new DagSemanticIntegrityError(`${id} evaluation claims do not match the record`);
		}
		for (const claim of array(evaluation.claims, "evaluated claim")) {
			if (typeof claim.valid !== "boolean") {
				throw new DagSemanticIntegrityError(`${id} evaluated claim validity is not boolean`);
			}
		}
		const checkIds = array(evaluation.checks, "evaluated check").map((entry) =>
			string(entry.checkId, "evaluated check ID"),
		);
		assertSortedUnique(checkIds, `${id} evaluated checks`);
		if (!equal(checkIds, record.requiredChecks)) {
			throw new DagSemanticIntegrityError(`${id} evaluation checks do not match the record`);
		}
		for (const check of array(evaluation.checks, "evaluated check")) {
			if (!new Set(["passed", "missing", "failed"]).has(check.status as string)) {
				throw new DagSemanticIntegrityError(`${id} evaluated check has an unsupported status`);
			}
		}
		if (typeof object(evaluation.sourceScope, "source scope").valid !== "boolean") {
			throw new DagSemanticIntegrityError(`${id} source-scope validity is not boolean`);
		}
	}
	if (
		joinEvaluations.length !== joins.length ||
		!equal(
			joinEvaluations.map((entry) => entry.oid),
			joins.map((entry) => entry.oid),
		)
	) {
		throw new DagSemanticIntegrityError("join evaluations are not in topology order");
	}
	for (let index = 0; index < joins.length; index += 1) {
		if (!equal(joinEvaluations[index]?.joinDigest, hashObject(joins[index]))) {
			throw new DagSemanticIntegrityError("join evaluation does not match immutable evidence");
		}
		assertWitnessOrder(joinEvaluations[index]?.witnesses, "join evaluation witnesses");
		const evaluation = joinEvaluations[index] as JsonObject;
		const witnesses = array(evaluation.witnesses, "join evaluation witnesses");
		if (
			typeof evaluation.valid !== "boolean" ||
			(evaluation.valid === true && witnesses.length !== 0) ||
			(evaluation.valid === false && witnesses.length === 0)
		) {
			throw new DagSemanticIntegrityError(
				"join evaluation validity and witnesses are inconsistent",
			);
		}
	}
	const expectedUnitEvaluationDigests = unitEvaluations.map((entry) => ({
		workUnitId: entry.workUnitId,
		digest: hashObject(entry),
	}));
	const expectedJoinEvaluationDigests = joinEvaluations.map((entry) => ({
		oid: entry.oid,
		digest: hashObject(entry),
	}));
	if (
		!equal(input.topologyDigest, hashObject(topology)) ||
		!equal(input.dependencyGraphDigest, hashObject(graph)) ||
		!equal(input.bindingDigests, expectedBindingDigests) ||
		!equal(input.recordDigests, expectedRecordDigests) ||
		!equal(input.joinDigests, expectedJoinDigests) ||
		!equal(input.unitEvaluationDigests, expectedUnitEvaluationDigests) ||
		!equal(input.joinEvaluationDigests, expectedJoinEvaluationDigests)
	) {
		throw new DagSemanticIntegrityError("gate input digests do not match immutable evidence");
	}
	const checkDigests = array(input.checkDigests, "check digest");
	let checkOrder = "";
	for (const entry of checkDigests) {
		const id = string(entry.workUnitId, "check WorkUnit ID");
		const checkId = string(entry.checkId, "check ID");
		const order = `${String(canonicalOrder.indexOf(id)).padStart(3, "0")}:${checkId}`;
		if (!nodeById.has(id) || order <= checkOrder) {
			throw new DagSemanticIntegrityError("check digests are unknown, duplicated or unordered");
		}
		checkOrder = order;
		hash(entry.digest, "check digest");
	}
	for (const id of canonicalOrder) {
		const record = recordById.get(id) as JsonObject;
		const required = record.requiredChecks as string[];
		const evidence = checkDigests.filter((entry) => entry.workUnitId === id);
		const evaluatedChecks = array(
			unitEvaluations.find((entry) => entry.workUnitId === id)?.checks,
			"evaluated check",
		);
		if (
			!equal(
				evidence.map((entry) => entry.checkId),
				required,
			)
		) {
			throw new DagSemanticIntegrityError(`${id} check evidence does not match required checks`);
		}
		if (!equal(record.checksDigest, hashObject(evidence))) {
			throw new DagSemanticIntegrityError(`${id} checks digest does not match evidence`);
		}
		if (
			!equal(
				evidence.map((entry) => ({ checkId: entry.checkId, digest: entry.digest })),
				evaluatedChecks.map((entry) => ({ checkId: entry.checkId, digest: entry.digest })),
			)
		) {
			throw new DagSemanticIntegrityError(`${id} evaluated checks do not match input evidence`);
		}
	}

	if (!equal(result.inputDigest, hashObject(input))) {
		throw new DagSemanticIntegrityError("gate result input digest does not match");
	}
	const units = array(result.units, "gate unit");
	if (
		!equal(
			units.map((unit) => unit.workUnitId),
			canonicalOrder,
		)
	) {
		throw new DagSemanticIntegrityError("gate units are not in canonical partial order");
	}
	const invalidUnits = new Set<string>();
	const allReasons: DagReasonCode[] = [];
	for (const unit of units) {
		const id = string(unit.workUnitId, "gate WorkUnit ID");
		const reasons = assertReasonOrder(unit.reasonCodes, `${id} reasons`);
		assertWitnessOrder(unit.witnesses, `${id} witnesses`);
		const node = nodeById.get(id) as JsonObject;
		const record = recordById.get(id) as JsonObject;
		const evaluation = evaluationById.get(id) as JsonObject;
		const expectedReasons = new Set<DagReasonCode>();
		const expectedWitnesses: JsonObject[] = [];
		const sourceScope = object(evaluation.sourceScope, `${id} source-scope evaluation`);
		if (sourceScope.valid !== true) {
			expectedReasons.add("SOURCE_SCOPE_VIOLATION");
			expectedWitnesses.push({
				kind: "source-scope",
				workUnitId: id,
				witnessDigest: sourceScope.witnessDigest,
			});
		}
		if (!equal(evaluation.blueprintHash, record.blueprintHash)) {
			expectedReasons.add("BLUEPRINT_WITNESS_STALE");
			expectedWitnesses.push({
				kind: "artifact",
				artifactKind: "record",
				digest: hashObject(record),
			});
		}
		if (!equal(evaluation.policyDigest, record.policyDigest)) {
			expectedReasons.add("POLICY_REVISION_STALE");
			expectedWitnesses.push({
				kind: "policy",
				workUnitId: id,
				expected: record.policyDigest,
				observed: evaluation.policyDigest,
			});
		}
		const recordedClaims = new Map(
			array(record.claimWitnesses, "record claim").map((claim) => [claim.claimId, claim] as const),
		);
		for (const claim of array(evaluation.claims, "evaluated claim")) {
			const claimId = string(claim.claimId, "claim ID");
			if (claim.valid !== true || recordedClaims.get(claimId)?.status !== "satisfied") {
				expectedReasons.add("CLAIM_INVALID");
				expectedWitnesses.push({ kind: "claim", workUnitId: id, claimId });
			}
		}
		for (const check of array(evaluation.checks, "evaluated check")) {
			const checkId = string(check.checkId, "check ID");
			if (check.status === "missing") expectedReasons.add("REQUIRED_CHECK_MISSING");
			if (check.status === "failed") expectedReasons.add("REQUIRED_CHECK_FAILED");
			if (check.status !== "passed") {
				expectedWitnesses.push({
					kind: "check",
					workUnitId: id,
					checkId,
					digest: check.digest,
				});
			}
		}
		for (const dependencyId of node.dependencies as string[]) {
			if (invalidUnits.has(dependencyId)) {
				expectedReasons.add("DEPENDENCY_INVALID");
				expectedWitnesses.push({ kind: "dependency", workUnitId: id, dependencyId });
			}
		}
		const expectedUnit = {
			workUnitId: id,
			verdict: expectedReasons.size === 0 ? "valid" : "invalid",
			reasonCodes: sortedReasons(expectedReasons),
			witnesses: sortedWitnesses(expectedWitnesses),
			recordId: record.recordId,
		};
		if (!equal(unit, expectedUnit)) {
			throw new DagSemanticIntegrityError(`${id} gate result is not derived from its evidence`);
		}
		allReasons.push(...reasons);
		if (unit.verdict === "valid") {
			if (reasons.length !== 0 || !equal(unit.recordId, recordById.get(id)?.recordId)) {
				throw new DagSemanticIntegrityError(`${id} valid result is inconsistent`);
			}
		} else {
			if (unit.verdict !== "invalid" || reasons.length === 0) {
				throw new DagSemanticIntegrityError(`${id} invalid result has no reason`);
			}
			invalidUnits.add(id);
		}
	}
	const joinResults = array(result.joins, "gate join");
	if (
		!equal(
			joinResults.map((entry) => entry.oid),
			joins.map((join) => join.oid),
		)
	) {
		throw new DagSemanticIntegrityError("gate joins are not in topology order");
	}
	let invalidJoin = false;
	for (let index = 0; index < joinResults.length; index += 1) {
		const join = joinResults[index] as JsonObject;
		const reasons = assertReasonOrder(join.reasonCodes, "join reasons");
		assertWitnessOrder(join.witnesses, "join witnesses");
		const evaluation = joinEvaluations[index] as JsonObject;
		const expectedJoin = {
			oid: joins[index]?.oid,
			verdict: evaluation.valid === true ? "valid" : "invalid",
			reasonCodes: evaluation.valid === true ? [] : ["JOIN_INVALID"],
			witnesses: sortedWitnesses(array(evaluation.witnesses, "join evaluation witnesses")),
		};
		if (!equal(join, expectedJoin)) {
			throw new DagSemanticIntegrityError("join gate result is not derived from its evidence");
		}
		allReasons.push(...reasons);
		if (join.verdict === "valid" && reasons.length !== 0) {
			throw new DagSemanticIntegrityError("valid join has failure reasons");
		}
		if (join.verdict === "invalid") {
			if (reasons.length === 0) throw new DagSemanticIntegrityError("invalid join has no reason");
			invalidJoin = true;
		}
	}
	const minimalAffectedCut = canonicalOrder.filter(
		(id) =>
			invalidUnits.has(id) &&
			!(nodeById.get(id)?.dependencies as string[]).some((dependency) =>
				invalidUnits.has(dependency),
			),
	);
	if (!equal(result.minimalAffectedCut, minimalAffectedCut)) {
		throw new DagSemanticIntegrityError("minimal affected cut is inconsistent");
	}
	const errorReasons = new Set<DagReasonCode>([
		"SCHEMA_INVALID",
		"BINDING_MISSING",
		"BINDING_AMBIGUOUS",
		"DEPENDENCY_MISSING",
		"DEPENDENCY_CYCLE",
		"ARTIFACT_HASH_MISMATCH",
	]);
	const expectedVerdict =
		invalidUnits.size === 0 && !invalidJoin
			? "pass"
			: allReasons.some((reason) => errorReasons.has(reason))
				? "error"
				: "blocked";
	if (result.verdict !== expectedVerdict) {
		throw new DagSemanticIntegrityError("gate verdict does not match ordered results");
	}
}

export function assertDagReviewIntegrity(value: {
	topology: unknown;
	dependencyGraph: unknown;
	gateResult: unknown;
	review: unknown;
}): void {
	const topology = object(value.topology, "topology");
	const graph = object(value.dependencyGraph, "dependency graph");
	const result = object(value.gateResult, "gate result");
	const review = object(value.review, "DAG review");
	if (
		!equal(review.topologyDigest, hashObject(topology)) ||
		!equal(review.dependencyGraphDigest, hashObject(graph)) ||
		!equal(review.gateResultDigest, hashObject(result)) ||
		!equal(review.summary, {
			verdict: result.verdict,
			minimalAffectedCut: result.minimalAffectedCut,
		})
	) {
		throw new DagSemanticIntegrityError("DAG review summary or artifact digests do not match");
	}
	const objects = array(topology.objects, "topology object");
	const unitById = new Map(
		array(result.units, "gate unit").map((entry) => [entry.workUnitId as string, entry] as const),
	);
	const joinByOid = new Map(
		array(result.joins, "gate join").map(
			(entry) => [oid(entry.oid, "gate join OID"), entry] as const,
		),
	);
	const expectedLanes = objects.map((entry) => {
		let verdict: unknown = "not-applicable";
		if (entry.kind === "implementation")
			verdict = unitById.get(entry.workUnitId as string)?.verdict;
		if (entry.kind === "join") verdict = joinByOid.get(oid(entry.oid, "join OID"))?.verdict;
		return { oid: entry.oid, layer: entry.layer, kind: entry.kind, verdict };
	});
	const expectedGitEdges = objects.flatMap((entry) =>
		(entry.parents as unknown[]).map((parent, parentIndex) => ({
			from: parent,
			to: entry.oid,
			parentIndex,
		})),
	);
	const expectedSemanticEdges = array(graph.workUnits, "dependency node").flatMap((entry) =>
		(entry.dependencies as string[]).map((dependency) => ({
			fromWorkUnitId: dependency,
			toWorkUnitId: entry.workUnitId,
		})),
	);
	if (
		!equal(review.gitLanes, expectedLanes) ||
		!equal(review.gitEdges, expectedGitEdges) ||
		!equal(review.semanticEdges, expectedSemanticEdges)
	) {
		throw new DagSemanticIntegrityError("DAG review lanes or edges do not match domain evidence");
	}
	const selection = object(review.selectedEvidence, "selected evidence");
	const firstCut = Array.isArray(result.minimalAffectedCut)
		? (result.minimalAffectedCut[0] as string | undefined)
		: undefined;
	const cutObject =
		firstCut === undefined
			? undefined
			: objects.find((entry) => entry.kind === "implementation" && entry.workUnitId === firstCut);
	const lastJoin = [...objects].reverse().find((entry) => entry.kind === "join");
	const lastUnit = [...objects].reverse().find((entry) => entry.kind === "implementation");
	const defaultObject = cutObject ?? (firstCut === undefined ? (lastJoin ?? lastUnit) : undefined);
	if (defaultObject === undefined && firstCut === undefined) {
		throw new DagSemanticIntegrityError("DAG review has no selectable evidence");
	}
	const expectedSelection =
		defaultObject === undefined
			? { kind: "structural-unit", workUnitId: firstCut }
			: defaultObject.kind === "join"
				? {
						kind: "join",
						join: defaultObject.oid,
						parent: (defaultObject.parents as unknown[])[0],
						parentIndex: 0,
					}
				: {
						kind: "work-unit",
						workUnitId: defaultObject.workUnitId,
						commit: defaultObject.oid,
						parent: (defaultObject.parents as unknown[])[0],
					};
	if (!equal(selection, expectedSelection)) {
		throw new DagSemanticIntegrityError("DAG review default selection is not canonical");
	}
	if (selection.kind === "structural-unit") return;
	if (selection.kind === "work-unit") {
		const selected = objects.find(
			(entry) => entry.kind === "implementation" && entry.workUnitId === selection.workUnitId,
		);
		if (
			selected === undefined ||
			!equal(selection.commit, selected.oid) ||
			!equal(selection.parent, (selected.parents as unknown[])[0])
		) {
			throw new DagSemanticIntegrityError("selected WorkUnit evidence does not match topology");
		}
		return;
	}
	if (selection.kind === "join") {
		const selected = objects.find(
			(entry) => entry.kind === "join" && equal(entry.oid, selection.join),
		);
		const parentIndex = selection.parentIndex as number;
		if (
			selected === undefined ||
			(parentIndex !== 0 && parentIndex !== 1) ||
			!equal(selection.parent, (selected.parents as unknown[])[parentIndex])
		) {
			throw new DagSemanticIntegrityError("selected join-parent evidence does not match topology");
		}
		return;
	}
	throw new DagSemanticIntegrityError("DAG review selection is unsupported");
}
