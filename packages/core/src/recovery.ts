import { createHash } from "node:crypto";
import {
	assertDagSemanticIntegrity,
	assertDagTopologyIntegrity,
	assertPlanQualifiedCommitIntegrity,
	canonicalize,
	RECOVERY_IMPACT_SCHEMA,
	RECOVERY_PLAN_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export class RecoveryDomainError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoveryDomainError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RecoveryDomainError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new RecoveryDomainError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new RecoveryDomainError(`${label} must be a string array`);
	}
	return value;
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function patchHash(value: string): Hash {
	return {
		algorithm: "sha256",
		value: createHash("sha256").update(value, "utf8").digest("hex"),
	};
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function canonicalOrder(units: readonly JsonObject[]): string[] {
	const byId = new Map<string, JsonObject>();
	for (const unit of units) {
		const id = String(unit.id);
		if (byId.has(id)) throw new RecoveryDomainError(`WorkUnit ${id} is duplicated`);
		byId.set(id, unit);
	}
	const result: string[] = [];
	const remaining = new Set(byId.keys());
	while (remaining.size > 0) {
		const next = [...remaining]
			.filter((id) =>
				strings(byId.get(id)?.dependencies, `${id} dependencies`).every((dependency) =>
					result.includes(dependency),
				),
			)
			.sort()[0];
		if (next === undefined) throw new RecoveryDomainError("Recovery dependency graph is cyclic");
		result.push(next);
		remaining.delete(next);
	}
	return result;
}

function oidKey(value: unknown): string {
	return canonicalize(object(value, "Git OID"));
}

function transport(entry: JsonObject): JsonObject {
	return {
		oid: structuredClone(entry.oid),
		parents: structuredClone(entry.parents),
		layer: entry.layer,
		kind: "transport",
		workUnitId: null,
		blueprintHash: structuredClone(entry.blueprintHash),
	};
}

export function computeRecoveryImpactV1(options: {
	repository: { provider: string; owner: string; name: string };
	sourceBundle: JsonObject;
	sourcePlan: JsonObject;
	policy: JsonObject;
	selection: "work-units" | "plan";
	targetWorkUnitIds: string[];
}): JsonObject {
	assertDagSemanticIntegrity({
		topology: options.sourceBundle.topology,
		dependencyGraph: options.sourceBundle.dependencyGraph,
		bindings: options.sourceBundle.bindings,
		records: options.sourceBundle.records,
		unitEvaluations: options.sourceBundle.unitEvaluations,
		joinEvaluations: options.sourceBundle.joinEvaluations,
		gateInput: options.sourceBundle.gateInput,
		gateResult: options.sourceBundle.gateResult,
	});
	const planId = String(options.sourcePlan.planId);
	const sourceTopology = object(options.sourceBundle.topology, "source topology");
	if (!equal(sourceTopology.repository, options.repository)) {
		throw new RecoveryDomainError("Repository identity does not match the source DAG bundle");
	}
	if (options.sourceBundle.dependencyGraph !== undefined) {
		const graph = object(options.sourceBundle.dependencyGraph, "source dependency graph");
		if (graph.planId !== planId)
			throw new RecoveryDomainError("Source Plan ID does not match gate");
	}
	const sourceInput = object(options.sourceBundle.gateInput, "source GateInput");
	if (
		!equal(sourceInput.planDigest, hash(options.sourcePlan)) ||
		!equal(sourceInput.policyDigest, hash(options.policy))
	) {
		throw new RecoveryDomainError("Source Plan or policy does not match the gate bundle");
	}
	const units = objects(options.sourcePlan.workUnits, "source WorkUnits");
	const order = canonicalOrder(units);
	const unitById = new Map(units.map((unit) => [String(unit.id), unit] as const));
	const records = objects(options.sourceBundle.records, "source records");
	const recordById = new Map(records.map((record) => [String(record.workUnitId), record] as const));
	if (recordById.size !== order.length || order.some((id) => !recordById.has(id))) {
		throw new RecoveryDomainError("Source records do not cover the accepted Plan");
	}
	const requested = [...new Set(options.targetWorkUnitIds)].sort();
	if (requested.length === 0 || requested.some((id) => !unitById.has(id))) {
		throw new RecoveryDomainError("Recovery targets must be unique WorkUnits in the source Plan");
	}
	const targets = options.selection === "plan" ? [...order] : requested;
	if (options.selection === "plan" && !equal(requested, [...order].sort())) {
		throw new RecoveryDomainError("Whole-Plan recovery must explicitly bind every source WorkUnit");
	}
	const targetSet = new Set(targets);
	const dependants = new Map(order.map((id) => [id, [] as string[]]));
	for (const id of order) {
		for (const dependency of strings(unitById.get(id)?.dependencies, `${id} dependencies`)) {
			if (!unitById.has(dependency)) {
				throw new RecoveryDomainError(`${id} depends on missing WorkUnit ${dependency}`);
			}
			dependants.get(dependency)?.push(id);
		}
	}
	for (const values of dependants.values()) values.sort();
	const witnessById = new Map<string, string[]>();
	for (const target of targets) {
		const queue: string[][] = [[target]];
		while (queue.length > 0) {
			const path = queue.shift() as string[];
			const current = path[path.length - 1] as string;
			const prior = witnessById.get(current);
			if (
				prior !== undefined &&
				(prior.length < path.length ||
					(prior.length === path.length && canonicalize(prior) <= canonicalize(path)))
			) {
				continue;
			}
			witnessById.set(current, path);
			for (const dependant of dependants.get(current) ?? []) {
				if (!path.includes(dependant)) queue.push([...path, dependant]);
			}
		}
	}
	const affectedSet = new Set(witnessById.keys());
	const targetEntries = [...targets].sort().map((workUnitId) => ({
		planId,
		workUnitId,
		recordDigest: hash(recordById.get(workUnitId)),
	}));
	const affected = order
		.filter((id) => affectedSet.has(id))
		.map((workUnitId) => ({
			planId,
			workUnitId,
			role: targetSet.has(workUnitId) ? "target" : "dependent",
			recordDigest: hash(recordById.get(workUnitId)),
			dependencies: [
				...strings(unitById.get(workUnitId)?.dependencies, `${workUnitId} dependencies`),
			].sort(),
			witnessPath: witnessById.get(workUnitId),
		}));
	const unaffected = order
		.filter((id) => !affectedSet.has(id))
		.map((workUnitId) => ({
			planId,
			workUnitId,
			recordDigest: hash(recordById.get(workUnitId)),
			dependencies: [
				...strings(unitById.get(workUnitId)?.dependencies, `${workUnitId} dependencies`),
			].sort(),
		}));
	return {
		schema: RECOVERY_IMPACT_SCHEMA,
		repository: structuredClone(options.repository),
		expectedHead: structuredClone(object(options.sourceBundle.topology, "source topology").head),
		sourceBundle: structuredClone(options.sourceBundle),
		sourceBundleDigest: hash(options.sourceBundle),
		sourcePlan: structuredClone(options.sourcePlan),
		policy: structuredClone(options.policy),
		selection: options.selection,
		targets: targetEntries,
		affected,
		unaffected,
	};
}

export function createRecoveryPlanV1(options: {
	impact: JsonObject;
	proposal: JsonObject;
	acceptedBy: string;
}): JsonObject {
	const impact = options.impact;
	const proposal = options.proposal;
	const sourcePlan = object(impact.sourcePlan, "source Plan");
	const sourceUnits = objects(sourcePlan.workUnits, "source WorkUnits");
	const sourceUnitById = new Map(sourceUnits.map((unit) => [String(unit.id), unit] as const));
	const affected = objects(impact.affected, "affected units");
	const affectedIds = affected.map((entry) => String(entry.workUnitId));
	if (
		proposal.selection !== impact.selection ||
		!equal(
			[...strings(proposal.targetWorkUnitIds, "proposal targets")].sort(),
			objects(impact.targets, "impact targets")
				.map((entry) => String(entry.workUnitId))
				.sort(),
		)
	) {
		throw new RecoveryDomainError("Recovery proposal target does not match impact");
	}
	const steps = objects(proposal.steps, "recovery steps");
	const stepById = new Map<string, JsonObject>();
	for (const step of steps) {
		const id = String(step.workUnitId);
		if (stepById.has(id) || !affectedIds.includes(id)) {
			throw new RecoveryDomainError(`Recovery step ${id} is duplicated or outside the impact`);
		}
		if (object(step.postRecoveryWorkUnit, `${id} post-recovery WorkUnit`).id !== id) {
			throw new RecoveryDomainError(`${id} post-recovery WorkUnit identity changed`);
		}
		const operation = object(step.operation, `${id} operation`);
		if (step.disposition !== operation.kind) {
			throw new RecoveryDomainError(`${id} disposition does not match its operation`);
		}
		if (
			operation.kind === "compensate" &&
			!equal(operation.patchDigest, patchHash(String(operation.patch)))
		) {
			throw new RecoveryDomainError(`${id} compensation patch digest changed`);
		}
		if (operation.kind === "inverse") {
			const binding = objects(
				object(impact.sourceBundle, "source bundle").bindings,
				"source bindings",
			).find((entry) => entry.workUnitId === id);
			if (binding === undefined || !equal(operation.sourceCommit, binding.commit)) {
				throw new RecoveryDomainError(`${id} inverse does not bind the source implementation`);
			}
		}
		if (operation.kind === "retain" && !equal(step.postRecoveryWorkUnit, sourceUnitById.get(id))) {
			throw new RecoveryDomainError(`${id} retain must preserve the complete WorkUnit definition`);
		}
		for (const effect of objects(step.externalEffects, `${id} external effects`)) {
			if (
				(effect.status === "resolved") !== (effect.evidenceDigest !== null) ||
				(effect.status !== "resolved" && effect.evidenceDigest !== null)
			) {
				throw new RecoveryDomainError(
					`${id} external-effect status lacks exact evidence semantics`,
				);
			}
		}
		stepById.set(id, step);
	}
	if (stepById.size !== affectedIds.length || affectedIds.some((id) => !stepById.has(id))) {
		throw new RecoveryDomainError("Recovery steps do not exactly cover the impact closure");
	}
	const postUnits = sourceUnits.map((unit) =>
		structuredClone(stepById.get(String(unit.id))?.postRecoveryWorkUnit ?? unit),
	) as JsonObject[];
	const postOrder = canonicalOrder(postUnits);
	const postUnitById = new Map(postUnits.map((unit) => [String(unit.id), unit] as const));
	const nonRetain = new Set(
		steps.filter((step) => step.disposition !== "retain").map((step) => String(step.workUnitId)),
	);
	for (const step of steps) {
		const id = String(step.workUnitId);
		const expected = strings(postUnitById.get(id)?.dependencies, `${id} dependencies`)
			.filter((dependency) => nonRetain.has(dependency))
			.sort();
		if (!equal(strings(step.dependsOnSteps, `${id} step dependencies`), expected)) {
			throw new RecoveryDomainError(
				`${id} execution dependencies do not match the post-recovery DAG`,
			);
		}
	}
	const topology = object(object(impact.sourceBundle, "source bundle").topology, "source topology");
	const expectedHeadValue = String(object(impact.expectedHead, "expected head").value);
	const headBlueprintHash = equal(topology.head, topology.base)
		? topology.baseBlueprintHash
		: objects(topology.objects, "source topology objects").find(
				(entry) => object(entry.oid, "topology object OID").value === expectedHeadValue,
			)?.blueprintHash;
	if (headBlueprintHash === undefined) {
		throw new RecoveryDomainError("Source topology does not contain the expected head Blueprint");
	}
	const policy = object(impact.policy, "policy");
	const policyDigest = hash(policy);
	const postRecoveryPlan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: proposal.postRecoveryPlanId,
		taskDigest: hash({ impactDigest: hash(impact), proposalDigest: hash(proposal) }),
		taskSummary: `Recover ${String(sourcePlan.planId)} through ${String(proposal.recoveryPlanId)}`,
		baseCommit: structuredClone(impact.expectedHead),
		baseBlueprintHash: structuredClone(headBlueprintHash),
		policy: {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: policyDigest,
		},
		proposalSource: proposal.proposalSource,
		acceptedBy: { label: options.acceptedBy.trim(), identityVerified: false },
		workUnits: postOrder.map((id) => structuredClone(postUnitById.get(id))),
	};
	return {
		schema: RECOVERY_PLAN_SCHEMA,
		recoveryPlanId: proposal.recoveryPlanId,
		sourcePlanId: sourcePlan.planId,
		impactDigest: hash(impact),
		proposal: structuredClone(proposal),
		proposalDigest: hash(proposal),
		expectedHead: structuredClone(impact.expectedHead),
		policyDigest,
		acceptedBy: { label: options.acceptedBy.trim(), identityVerified: false },
		postRecoveryPlan,
		steps: postOrder
			.filter((id) => stepById.has(id))
			.map((id) => structuredClone(stepById.get(id))),
		executionOrder: postOrder.filter((id) => nonRetain.has(id)),
	};
}

export function projectRecoveryTopologyV1(options: {
	topology: JsonObject;
	qualifiedCommits: JsonObject[];
	sourcePlanId: string;
	recoveryPlanId: string;
	retainedUnits: string[];
	changedUnits: string[];
}): JsonObject {
	assertDagTopologyIntegrity(options.topology);
	const retained = new Set(options.retainedUnits);
	const changed = new Set(options.changedUnits);
	if (
		options.sourcePlanId === options.recoveryPlanId ||
		[...retained].some((id) => changed.has(id)) ||
		retained.size + changed.size === 0
	) {
		throw new RecoveryDomainError("Recovery topology selection is invalid");
	}
	const entries = objects(options.topology.objects, "topology objects");
	const byOid = new Map(entries.map((entry) => [oidKey(entry.oid), entry] as const));
	const owners = new Map<string, JsonObject>();
	for (const qualified of options.qualifiedCommits) {
		assertPlanQualifiedCommitIntegrity(qualified);
		const key = oidKey(qualified.commit);
		if (owners.has(key)) throw new RecoveryDomainError("One commit has multiple Plan owners");
		const entry = byOid.get(key);
		if (
			entry === undefined ||
			entry.kind !== "implementation" ||
			entry.workUnitId !== qualified.workUnitId
		) {
			throw new RecoveryDomainError("Qualified recovery commit does not match topology");
		}
		owners.set(key, qualified);
	}
	if (owners.size !== entries.filter((entry) => entry.kind === "implementation").length) {
		throw new RecoveryDomainError("Qualified commits do not cover recovery implementations");
	}
	const selected = new Set<string>();
	const projectionObjects = entries.map((entry) => {
		if (entry.kind !== "implementation") return structuredClone(entry);
		const owner = owners.get(oidKey(entry.oid));
		if (owner === undefined) throw new RecoveryDomainError("Implementation has no Plan owner");
		const id = String(owner.workUnitId);
		const keep =
			(owner.planId === options.sourcePlanId && retained.has(id)) ||
			(owner.planId === options.recoveryPlanId && changed.has(id));
		if (!keep) return transport(entry);
		if (selected.has(id)) throw new RecoveryDomainError(`Recovery selects ${id} more than once`);
		selected.add(id);
		return structuredClone(entry);
	});
	const expected = new Set([...retained, ...changed]);
	if (selected.size !== expected.size || [...expected].some((id) => !selected.has(id))) {
		throw new RecoveryDomainError("Recovery topology does not select every post-recovery WorkUnit");
	}
	const projection = { ...structuredClone(options.topology), objects: projectionObjects };
	assertDagTopologyIntegrity(projection);
	return projection;
}
