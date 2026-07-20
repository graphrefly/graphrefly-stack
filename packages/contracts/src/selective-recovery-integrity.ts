import { assertDagTopologyIntegrity } from "./dag-integrity.js";
import { assertDagSemanticIntegrity } from "./dag-semantic-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";
import { assertPlanQualifiedCommitIntegrity } from "./linear-v1-conversion.js";

type JsonObject = Record<string, unknown>;

export class SelectiveRecoveryIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SelectiveRecoveryIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SelectiveRecoveryIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new SelectiveRecoveryIntegrityError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new SelectiveRecoveryIntegrityError(`${label} must be a string array`);
	}
	return value;
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function digest(value: unknown): JsonObject {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function oidKey(value: unknown): string {
	return canonicalize(object(value, "Git OID"));
}

function dependencyNodes(plan: JsonObject): JsonObject[] {
	const units = objects(plan.workUnits, "Plan WorkUnits");
	const byId = new Map<string, JsonObject>();
	for (const unit of units) {
		const id = String(unit.id);
		if (byId.has(id)) throw new SelectiveRecoveryIntegrityError("Plan repeats a WorkUnit");
		byId.set(id, unit);
	}
	for (const [id, unit] of byId) {
		for (const dependency of strings(unit.dependencies, `${id} dependencies`)) {
			if (!byId.has(dependency)) {
				throw new SelectiveRecoveryIntegrityError(`${id} has a missing dependency`);
			}
		}
	}
	const order: string[] = [];
	const remaining = new Set(byId.keys());
	while (remaining.size > 0) {
		const next = [...remaining]
			.filter((id) =>
				strings(byId.get(id)?.dependencies, `${id} dependencies`).every((dependency) =>
					order.includes(dependency),
				),
			)
			.sort()[0];
		if (next === undefined)
			throw new SelectiveRecoveryIntegrityError("Plan dependencies are cyclic");
		order.push(next);
		remaining.delete(next);
	}
	return order.map((workUnitId) => ({
		workUnitId,
		dependencies: [
			...strings(byId.get(workUnitId)?.dependencies, `${workUnitId} dependencies`),
		].sort(),
	}));
}

function assertGateBundle(bundle: JsonObject, label: string): void {
	if (bundle.schema !== "graphrefly.stack.dag-gate-bundle.v2") {
		throw new SelectiveRecoveryIntegrityError(`${label} schema is unsupported`);
	}
	assertDagSemanticIntegrity({
		topology: object(bundle.topology, `${label} topology`),
		dependencyGraph: object(bundle.dependencyGraph, `${label} dependency graph`),
		bindings: objects(bundle.bindings, `${label} bindings`),
		records: objects(bundle.records, `${label} records`),
		unitEvaluations: objects(bundle.unitEvaluations, `${label} unit evaluations`),
		joinEvaluations: objects(bundle.joinEvaluations, `${label} join evaluations`),
		gateInput: object(bundle.gateInput, `${label} GateInput`),
		gateResult: object(bundle.gateResult, `${label} GateResult`),
	});
}

function projectedTopology(
	topology: JsonObject,
	qualifiedCommits: JsonObject[],
	sourcePlanId: string,
	replacementPlanId: string,
	preservedUnits: string[],
	invalidUnits: string[],
): JsonObject {
	const objectsInTopology = objects(topology.objects, "shared topology objects");
	const owners = new Map<string, JsonObject>();
	for (const qualified of qualifiedCommits) {
		assertPlanQualifiedCommitIntegrity(qualified);
		const key = oidKey(qualified.commit);
		if (owners.has(key)) {
			throw new SelectiveRecoveryIntegrityError("one Git commit has multiple Plan owners");
		}
		owners.set(key, qualified);
	}
	const preserved = new Set(preservedUnits);
	const invalid = new Set(invalidUnits);
	const selected = new Set<string>();
	const projected = objectsInTopology.map((entry) => {
		const owner = owners.get(oidKey(entry.oid));
		if (entry.kind !== "implementation") {
			if (owner !== undefined) {
				throw new SelectiveRecoveryIntegrityError("non-implementation object has a Plan owner");
			}
			return structuredClone(entry);
		}
		if (owner === undefined || owner.workUnitId !== entry.workUnitId) {
			throw new SelectiveRecoveryIntegrityError("implementation ownership does not match topology");
		}
		const workUnitId = String(owner.workUnitId);
		const keep =
			(owner.planId === sourcePlanId && preserved.has(workUnitId)) ||
			(owner.planId === replacementPlanId && invalid.has(workUnitId));
		if (keep) {
			if (selected.has(workUnitId)) {
				throw new SelectiveRecoveryIntegrityError("recovery selects a WorkUnit more than once");
			}
			selected.add(workUnitId);
			return structuredClone(entry);
		}
		return {
			oid: structuredClone(entry.oid),
			parents: structuredClone(entry.parents),
			layer: entry.layer,
			kind: "transport",
			workUnitId: null,
			blueprintHash: structuredClone(entry.blueprintHash),
		};
	});
	if (
		owners.size !== objectsInTopology.filter((entry) => entry.kind === "implementation").length ||
		selected.size !== preservedUnits.length + invalidUnits.length
	) {
		throw new SelectiveRecoveryIntegrityError(
			"qualified ownership or selected recovery is incomplete",
		);
	}
	const result = { ...structuredClone(topology), objects: projected };
	assertDagTopologyIntegrity(result);
	return result;
}

function assertDagSelectiveRecoveryIntegrityInternal(bundle: JsonObject): void {
	if (bundle.schema !== "graphrefly.stack.dag-selective-recovery-bundle.v1") {
		throw new SelectiveRecoveryIntegrityError("selective recovery schema is unsupported");
	}
	const sourceBundle = object(bundle.sourceBundle, "source bundle");
	const replacementBundle = object(bundle.replacementBundle, "replacement bundle");
	const sourcePlan = object(bundle.sourcePlan, "source Plan");
	const replacementPlan = object(bundle.replacementPlan, "replacement Plan");
	const policy = object(bundle.policy, "repository policy");
	const replan = object(bundle.selectiveReplan, "selective replan");
	const sharedTopology = object(bundle.sharedTopology, "shared topology");
	const effectiveTopology = object(bundle.effectiveTopology, "effective topology");
	const qualifiedCommits = objects(bundle.qualifiedCommits, "qualified commits");
	assertGateBundle(sourceBundle, "source bundle");
	assertGateBundle(replacementBundle, "replacement bundle");
	assertDagTopologyIntegrity(sharedTopology);
	if (
		object(sourceBundle.gateResult, "source GateResult").verdict !== "blocked" ||
		!equal(bundle.sourceBundleDigest, digest(sourceBundle))
	) {
		throw new SelectiveRecoveryIntegrityError("source evidence is not the exact blocked bundle");
	}

	const sourcePlanId = String(sourcePlan.planId);
	const replacementPlanId = String(replacementPlan.planId);
	if (
		sourcePlanId === replacementPlanId ||
		replan.schema !== "graphrefly.stack.semantic-selective-replan.v1" ||
		replan.sourcePlanId !== sourcePlanId ||
		replan.replacementPlanId !== replacementPlanId
	) {
		throw new SelectiveRecoveryIntegrityError("selective replan Plan identities drifted");
	}
	const sourceGateInput = object(sourceBundle.gateInput, "source GateInput");
	const replacementGateInput = object(replacementBundle.gateInput, "replacement GateInput");
	if (
		!equal(sourceGateInput.planDigest, digest(sourcePlan)) ||
		!equal(replacementGateInput.planDigest, digest(replacementPlan)) ||
		!equal(sourceGateInput.policyDigest, digest(policy)) ||
		!equal(replacementGateInput.policyDigest, digest(policy)) ||
		object(sourceBundle.dependencyGraph, "source dependency graph").planId !== sourcePlanId ||
		object(replacementBundle.dependencyGraph, "replacement dependency graph").planId !==
			replacementPlanId
	) {
		throw new SelectiveRecoveryIntegrityError("nested gate does not bind its Plan and policy");
	}
	if (
		!equal(
			object(sourceBundle.dependencyGraph, "source dependency graph").workUnits,
			dependencyNodes(sourcePlan),
		) ||
		!equal(
			object(replacementBundle.dependencyGraph, "replacement dependency graph").workUnits,
			dependencyNodes(replacementPlan),
		)
	) {
		throw new SelectiveRecoveryIntegrityError("nested dependency graph does not match its Plan");
	}
	for (const plan of [sourcePlan, replacementPlan]) {
		const binding = object(plan.policy, "Plan policy binding");
		if (
			binding.policyId !== policy.policyId ||
			binding.revision !== policy.revision ||
			!equal(binding.digest, digest(policy))
		) {
			throw new SelectiveRecoveryIntegrityError("Plan policy identity or digest drifted");
		}
	}

	const sourceUnits = objects(sourcePlan.workUnits, "source WorkUnits");
	const replacementUnits = objects(replacementPlan.workUnits, "replacement WorkUnits");
	const sourceIds = sourceUnits.map((unit) => String(unit.id));
	const replacementIds = replacementUnits.map((unit) => String(unit.id));
	if (new Set(sourceIds).size !== sourceIds.length || !equal(sourceIds, replacementIds)) {
		throw new SelectiveRecoveryIntegrityError("replacement Plan changes the WorkUnit identity set");
	}
	if (
		!equal(sourcePlan.taskDigest, replacementPlan.taskDigest) ||
		sourcePlan.taskSummary !== replacementPlan.taskSummary ||
		replacementPlan.proposalSource !== replan.proposalSource
	) {
		throw new SelectiveRecoveryIntegrityError("replacement Plan changes task or proposal identity");
	}
	const preservedUnits = strings(replan.preservedUnits, "preserved units");
	const invalidUnits = strings(replan.invalidUnits, "invalid units");
	const invalid = new Set(invalidUnits);
	if (
		invalidUnits.length === 0 ||
		new Set(preservedUnits).size !== preservedUnits.length ||
		invalid.size !== invalidUnits.length ||
		preservedUnits.some((id) => invalid.has(id)) ||
		!equal(
			preservedUnits,
			sourceIds.filter((id) => !invalid.has(id)),
		) ||
		!equal(
			invalidUnits,
			sourceIds.filter((id) => invalid.has(id)),
		)
	) {
		throw new SelectiveRecoveryIntegrityError("selective replan is not the exact source partition");
	}
	const sourceVerdicts = new Map(
		objects(object(sourceBundle.gateResult, "source GateResult").units, "source unit results").map(
			(entry) => [String(entry.workUnitId), entry.verdict],
		),
	);
	if (
		sourceIds.some((id) =>
			invalid.has(id) ? sourceVerdicts.get(id) === "valid" : sourceVerdicts.get(id) !== "valid",
		)
	) {
		throw new SelectiveRecoveryIntegrityError(
			"selective replan partition does not match the blocked source verdicts",
		);
	}
	for (let index = 0; index < sourceUnits.length; index += 1) {
		const sourceUnit = sourceUnits[index] as JsonObject;
		const replacementUnit = replacementUnits[index] as JsonObject;
		const isInvalid = invalid.has(String(sourceUnit.id));
		if (
			(!isInvalid && !equal(sourceUnit, replacementUnit)) ||
			(isInvalid && equal(sourceUnit, replacementUnit))
		) {
			throw new SelectiveRecoveryIntegrityError(
				isInvalid ? "invalid WorkUnit was not replaced" : "preserved WorkUnit definition changed",
			);
		}
	}

	const sourceTopology = object(sourceBundle.topology, "source topology");
	if (
		!equal(sourcePlan.baseCommit, sourceTopology.base) ||
		!equal(sourcePlan.baseBlueprintHash, sourceTopology.baseBlueprintHash)
	) {
		throw new SelectiveRecoveryIntegrityError("source Plan base does not bind the source topology");
	}
	if (
		!equal(sourceTopology.base, sharedTopology.base) ||
		!equal(sourceTopology.baseBlueprintHash, sharedTopology.baseBlueprintHash) ||
		!equal(sourceTopology.repository, sharedTopology.repository) ||
		!equal(sourceTopology.provider, sharedTopology.provider)
	) {
		throw new SelectiveRecoveryIntegrityError(
			"shared topology does not extend the source topology",
		);
	}
	const sharedByOid = new Map(
		objects(sharedTopology.objects, "shared topology objects").map((entry) => [
			oidKey(entry.oid),
			entry,
		]),
	);
	for (const entry of objects(sourceTopology.objects, "source topology objects")) {
		if (!equal(sharedByOid.get(oidKey(entry.oid)), entry)) {
			throw new SelectiveRecoveryIntegrityError(
				"source topology object changed in shared evidence",
			);
		}
	}
	const sharedJoins = new Map(
		objects(sharedTopology.joins, "shared topology joins").map((entry) => [
			oidKey(entry.oid),
			entry,
		]),
	);
	for (const join of objects(sourceTopology.joins, "source topology joins")) {
		if (!equal(sharedJoins.get(oidKey(join.oid)), join)) {
			throw new SelectiveRecoveryIntegrityError("source join changed in shared evidence");
		}
	}
	const sourceHead = object(sourceTopology.head, "source topology head");
	const sourceHeadEntry = sharedByOid.get(oidKey(sourceHead));
	if (
		sourceHeadEntry === undefined ||
		!equal(replacementPlan.baseCommit, sourceHead) ||
		!equal(replacementPlan.baseBlueprintHash, sourceHeadEntry.blueprintHash)
	) {
		throw new SelectiveRecoveryIntegrityError("replacement Plan base is not the source gate head");
	}

	const sortedQualified = [...qualifiedCommits].sort((left, right) => {
		const leftKey = `${String(left.planId)}\u0000${String(left.workUnitId)}\u0000${oidKey(left.commit)}`;
		const rightKey = `${String(right.planId)}\u0000${String(right.workUnitId)}\u0000${oidKey(right.commit)}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
	if (!equal(qualifiedCommits, sortedQualified)) {
		throw new SelectiveRecoveryIntegrityError("qualified commits are not canonical");
	}
	const expectedEffective = projectedTopology(
		sharedTopology,
		qualifiedCommits,
		sourcePlanId,
		replacementPlanId,
		preservedUnits,
		invalidUnits,
	);
	if (
		!equal(effectiveTopology, expectedEffective) ||
		!equal(replacementBundle.topology, expectedEffective)
	) {
		throw new SelectiveRecoveryIntegrityError(
			"effective topology is not the exact recovery projection",
		);
	}

	const sourceBindings = new Map(
		objects(sourceBundle.bindings, "source bindings").map((entry) => [
			String(entry.workUnitId),
			entry,
		]),
	);
	const sourceRecords = new Map(
		objects(sourceBundle.records, "source records").map((entry) => [
			String(entry.workUnitId),
			entry,
		]),
	);
	const replacementBindings = new Map(
		objects(replacementBundle.bindings, "replacement bindings").map((entry) => [
			String(entry.workUnitId),
			entry,
		]),
	);
	const replacementRecords = new Map(
		objects(replacementBundle.records, "replacement records").map((entry) => [
			String(entry.workUnitId),
			entry,
		]),
	);
	const ownerByCommit = new Map(
		qualifiedCommits.map((entry) => [oidKey(entry.commit), entry] as const),
	);
	for (const workUnitId of sourceIds) {
		const sourceBinding = sourceBindings.get(workUnitId);
		const replacementBinding = replacementBindings.get(workUnitId);
		if (!sourceBinding || !replacementBinding) {
			throw new SelectiveRecoveryIntegrityError("binding lineage is incomplete");
		}
		const sourceOwner = ownerByCommit.get(oidKey(sourceBinding.commit));
		const replacementOwner = ownerByCommit.get(oidKey(replacementBinding.commit));
		if (sourceOwner?.planId !== sourcePlanId || sourceOwner.workUnitId !== workUnitId) {
			throw new SelectiveRecoveryIntegrityError("source binding lost its Plan-qualified ownership");
		}
		if (invalid.has(workUnitId)) {
			if (
				replacementOwner?.planId !== replacementPlanId ||
				replacementOwner.workUnitId !== workUnitId ||
				equal(sourceBinding.commit, replacementBinding.commit)
			) {
				throw new SelectiveRecoveryIntegrityError(
					"replacement binding is not the exact replacement implementation",
				);
			}
		} else if (
			!equal(sourceBinding.commit, replacementBinding.commit) ||
			replacementOwner?.planId !== sourcePlanId ||
			replacementOwner.workUnitId !== workUnitId
		) {
			throw new SelectiveRecoveryIntegrityError(
				"preserved binding is not carried from the source Plan",
			);
		}
	}
	const expectedLineage = sourceIds.map((workUnitId) => {
		const sourceBinding = sourceBindings.get(workUnitId);
		const sourceRecord = sourceRecords.get(workUnitId);
		const replacementBinding = replacementBindings.get(workUnitId);
		const replacementRecord = replacementRecords.get(workUnitId);
		if (!sourceBinding || !sourceRecord || !replacementBinding || !replacementRecord) {
			throw new SelectiveRecoveryIntegrityError("lineage source is incomplete");
		}
		if (replacementBinding.rebindFrom !== null || replacementRecord.rebindFrom !== null) {
			throw new SelectiveRecoveryIntegrityError("Plan replacement may not claim Git rebinding");
		}
		return {
			workUnitId,
			disposition: invalid.has(workUnitId) ? "replaced" : "preserved",
			sourcePlanId,
			replacementPlanId,
			sourceBindingDigest: digest(sourceBinding),
			sourceRecordDigest: digest(sourceRecord),
			replacementBindingDigest: digest(replacementBinding),
			replacementRecordDigest: digest(replacementRecord),
		};
	});
	if (!equal(bundle.lineage, expectedLineage)) {
		throw new SelectiveRecoveryIntegrityError("WorkUnit lineage is incomplete or non-canonical");
	}
}

export function assertDagSelectiveRecoveryIntegrity(bundle: JsonObject): void {
	try {
		assertDagSelectiveRecoveryIntegrityInternal(bundle);
	} catch (error) {
		if (error instanceof SelectiveRecoveryIntegrityError) throw error;
		throw new SelectiveRecoveryIntegrityError(
			error instanceof Error ? error.message : "Selective recovery integrity failed",
		);
	}
}
