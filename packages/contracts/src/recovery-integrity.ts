import { createHash } from "node:crypto";
import { assertDagTopologyIntegrity } from "./dag-integrity.js";
import { assertDagSemanticIntegrity } from "./dag-semantic-integrity.js";
import { assertDagStructuralErrorBundleIntegrity } from "./dag-structural-error-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";
import { assertPlanQualifiedCommitIntegrity } from "./linear-v1-conversion.js";

type JsonObject = Record<string, unknown>;

export class RecoveryIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecoveryIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RecoveryIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new RecoveryIntegrityError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new RecoveryIntegrityError(`${label} must be a string array`);
	}
	return value;
}

function hash(value: unknown): JsonObject {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function patchHash(value: string): JsonObject {
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
		if (byId.has(id)) throw new RecoveryIntegrityError(`WorkUnit ${id} is duplicated`);
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
		if (next === undefined) throw new RecoveryIntegrityError("Recovery dependency graph is cyclic");
		result.push(next);
		remaining.delete(next);
	}
	return result;
}

function assertSourceBundle(bundle: JsonObject): void {
	assertDagSemanticIntegrity({
		topology: bundle.topology,
		dependencyGraph: bundle.dependencyGraph,
		bindings: bundle.bindings,
		records: bundle.records,
		unitEvaluations: bundle.unitEvaluations,
		joinEvaluations: bundle.joinEvaluations,
		gateInput: bundle.gateInput,
		gateResult: bundle.gateResult,
	});
}

function expectedImpact(impact: JsonObject): JsonObject {
	const bundle = object(impact.sourceBundle, "source bundle");
	assertSourceBundle(bundle);
	const sourcePlan = object(impact.sourcePlan, "source Plan");
	const policy = object(impact.policy, "policy");
	const gateInput = object(bundle.gateInput, "source GateInput");
	if (
		!equal(gateInput.planDigest, hash(sourcePlan)) ||
		!equal(gateInput.policyDigest, hash(policy))
	) {
		throw new RecoveryIntegrityError("Source Plan or policy does not match the source gate");
	}
	const graph = object(bundle.dependencyGraph, "source dependency graph");
	if (!equal(object(bundle.topology, "source topology").repository, impact.repository)) {
		throw new RecoveryIntegrityError("Recovery repository identity changed");
	}
	if (graph.planId !== sourcePlan.planId) {
		throw new RecoveryIntegrityError("Source Plan ID does not match dependency evidence");
	}
	const units = objects(sourcePlan.workUnits, "source WorkUnits");
	const order = canonicalOrder(units);
	const unitById = new Map(units.map((unit) => [String(unit.id), unit] as const));
	const recordById = new Map(
		objects(bundle.records, "source records").map(
			(record) => [String(record.workUnitId), record] as const,
		),
	);
	if (recordById.size !== order.length || order.some((id) => !recordById.has(id))) {
		throw new RecoveryIntegrityError("Source records do not cover the source Plan");
	}
	const targets = objects(impact.targets, "recovery targets").map((entry) =>
		String(entry.workUnitId),
	);
	if (
		new Set(targets).size !== targets.length ||
		targets.some((id) => !unitById.has(id)) ||
		(impact.selection === "plan" && !equal([...targets].sort(), [...order].sort()))
	) {
		throw new RecoveryIntegrityError("Recovery target selection is invalid");
	}
	const targetSet = new Set(targets);
	const dependants = new Map(order.map((id) => [id, [] as string[]]));
	for (const id of order) {
		for (const dependency of strings(unitById.get(id)?.dependencies, `${id} dependencies`)) {
			if (!unitById.has(dependency)) {
				throw new RecoveryIntegrityError(`${id} depends on a missing WorkUnit`);
			}
			dependants.get(dependency)?.push(id);
		}
	}
	for (const values of dependants.values()) values.sort();
	const witnessById = new Map<string, string[]>();
	for (const target of [...targets].sort()) {
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
	return {
		schema: "graphrefly.stack.recovery-impact.v1",
		repository: structuredClone(impact.repository),
		expectedHead: structuredClone(object(bundle.topology, "source topology").head),
		sourceBundle: structuredClone(bundle),
		sourceBundleDigest: hash(bundle),
		sourcePlan: structuredClone(sourcePlan),
		policy: structuredClone(policy),
		selection: impact.selection,
		targets: [...targets].sort().map((workUnitId) => ({
			planId: sourcePlan.planId,
			workUnitId,
			recordDigest: hash(recordById.get(workUnitId)),
		})),
		affected: order
			.filter((id) => affectedSet.has(id))
			.map((workUnitId) => ({
				planId: sourcePlan.planId,
				workUnitId,
				role: targetSet.has(workUnitId) ? "target" : "dependent",
				recordDigest: hash(recordById.get(workUnitId)),
				dependencies: [
					...strings(unitById.get(workUnitId)?.dependencies, `${workUnitId} dependencies`),
				].sort(),
				witnessPath: witnessById.get(workUnitId),
			})),
		unaffected: order
			.filter((id) => !affectedSet.has(id))
			.map((workUnitId) => ({
				planId: sourcePlan.planId,
				workUnitId,
				recordDigest: hash(recordById.get(workUnitId)),
				dependencies: [
					...strings(unitById.get(workUnitId)?.dependencies, `${workUnitId} dependencies`),
				].sort(),
			})),
	};
}

export function assertRecoveryImpactIntegrity(impact: JsonObject): void {
	if (impact.schema !== "graphrefly.stack.recovery-impact.v1") {
		throw new RecoveryIntegrityError("RecoveryImpact schema is unsupported");
	}
	if (!equal(impact, expectedImpact(impact))) {
		throw new RecoveryIntegrityError("RecoveryImpact is not the canonical dependant projection");
	}
}

export function assertRecoveryPlanIntegrity(impact: JsonObject, plan: JsonObject): void {
	assertRecoveryImpactIntegrity(impact);
	if (plan.schema !== "graphrefly.stack.recovery-plan.v1") {
		throw new RecoveryIntegrityError("RecoveryPlan schema is unsupported");
	}
	const sourcePlan = object(impact.sourcePlan, "source Plan");
	const policy = object(impact.policy, "policy");
	const proposal = object(plan.proposal, "RecoveryPlan proposal");
	if (
		plan.sourcePlanId !== sourcePlan.planId ||
		!equal(plan.impactDigest, hash(impact)) ||
		!equal(plan.proposalDigest, hash(proposal)) ||
		plan.recoveryPlanId !== proposal.recoveryPlanId ||
		!equal(plan.expectedHead, impact.expectedHead) ||
		!equal(plan.policyDigest, hash(policy))
	) {
		throw new RecoveryIntegrityError("RecoveryPlan bindings do not match RecoveryImpact");
	}
	const sourceUnits = objects(sourcePlan.workUnits, "source WorkUnits");
	const sourceById = new Map(sourceUnits.map((unit) => [String(unit.id), unit] as const));
	const affectedIds = objects(impact.affected, "affected units").map((entry) =>
		String(entry.workUnitId),
	);
	if (
		proposal.selection !== impact.selection ||
		!equal(
			[...strings(proposal.targetWorkUnitIds, "proposal targets")].sort(),
			objects(impact.targets, "impact targets")
				.map((entry) => String(entry.workUnitId))
				.sort(),
		)
	) {
		throw new RecoveryIntegrityError("Recovery proposal target does not match its impact");
	}
	const proposedStepById = new Map(
		objects(proposal.steps, "proposed recovery steps").map(
			(step) => [String(step.workUnitId), step] as const,
		),
	);
	if (
		proposedStepById.size !== objects(proposal.steps, "proposed recovery steps").length ||
		proposedStepById.size !== affectedIds.length ||
		affectedIds.some((id) => !proposedStepById.has(id))
	) {
		throw new RecoveryIntegrityError("Recovery proposal does not exactly cover its impact");
	}
	const steps = objects(plan.steps, "recovery steps");
	const stepById = new Map<string, JsonObject>();
	for (const step of steps) {
		const id = String(step.workUnitId);
		if (stepById.has(id) || !affectedIds.includes(id)) {
			throw new RecoveryIntegrityError(`Recovery step ${id} is duplicated or outside impact`);
		}
		if (!equal(step, proposedStepById.get(id))) {
			throw new RecoveryIntegrityError(`${id} accepted step differs from its proposal`);
		}
		const operation = object(step.operation, `${id} operation`);
		if (
			step.disposition !== operation.kind ||
			object(step.postRecoveryWorkUnit, `${id} WorkUnit`).id !== id
		) {
			throw new RecoveryIntegrityError(`${id} recovery operation identity changed`);
		}
		if (
			operation.kind === "compensate" &&
			!equal(operation.patchDigest, patchHash(String(operation.patch)))
		) {
			throw new RecoveryIntegrityError(`${id} compensation patch digest changed`);
		}
		if (operation.kind === "inverse") {
			const binding = objects(
				object(impact.sourceBundle, "source bundle").bindings,
				"source bindings",
			).find((entry) => entry.workUnitId === id);
			if (binding === undefined || !equal(operation.sourceCommit, binding.commit)) {
				throw new RecoveryIntegrityError(`${id} inverse source binding changed`);
			}
		}
		if (operation.kind === "retain" && !equal(step.postRecoveryWorkUnit, sourceById.get(id))) {
			throw new RecoveryIntegrityError(`${id} retain changed its WorkUnit definition`);
		}
		for (const effect of objects(step.externalEffects, `${id} external effects`)) {
			if (
				(effect.status === "resolved") !== (effect.evidenceDigest !== null) ||
				(effect.status !== "resolved" && effect.evidenceDigest !== null)
			) {
				throw new RecoveryIntegrityError(`${id} external-effect evidence semantics changed`);
			}
		}
		stepById.set(id, step);
	}
	if (stepById.size !== affectedIds.length || affectedIds.some((id) => !stepById.has(id))) {
		throw new RecoveryIntegrityError("RecoveryPlan does not cover the complete impact closure");
	}
	const postPlan = object(plan.postRecoveryPlan, "post-recovery Plan");
	const sourceTopology = object(
		object(impact.sourceBundle, "source bundle").topology,
		"source topology",
	);
	const expectedHeadValue = String(object(impact.expectedHead, "expected head").value);
	const headBlueprintHash = equal(sourceTopology.head, sourceTopology.base)
		? sourceTopology.baseBlueprintHash
		: objects(sourceTopology.objects, "source topology objects").find(
				(entry) => object(entry.oid, "topology object OID").value === expectedHeadValue,
			)?.blueprintHash;
	if (
		postPlan.planId !== proposal.postRecoveryPlanId ||
		postPlan.planId === sourcePlan.planId ||
		!equal(postPlan.baseCommit, impact.expectedHead) ||
		headBlueprintHash === undefined ||
		!equal(postPlan.baseBlueprintHash, headBlueprintHash) ||
		!equal(
			postPlan.taskDigest,
			hash({ impactDigest: hash(impact), proposalDigest: hash(proposal) }),
		) ||
		postPlan.taskSummary !==
			`Recover ${String(sourcePlan.planId)} through ${String(proposal.recoveryPlanId)}` ||
		postPlan.proposalSource !== proposal.proposalSource ||
		!equal(postPlan.policy, {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: hash(policy),
		}) ||
		!equal(postPlan.acceptedBy, plan.acceptedBy)
	) {
		throw new RecoveryIntegrityError("Post-recovery accepted Plan binding changed");
	}
	const postUnits = objects(postPlan.workUnits, "post-recovery WorkUnits");
	const postOrder = canonicalOrder(postUnits);
	const postById = new Map(postUnits.map((unit) => [String(unit.id), unit] as const));
	if (postById.size !== sourceById.size || [...sourceById].some(([id]) => !postById.has(id))) {
		throw new RecoveryIntegrityError("Post-recovery Plan changed the WorkUnit identity set");
	}
	for (const [id, sourceUnit] of sourceById) {
		const step = stepById.get(id);
		if (step === undefined && !equal(postById.get(id), sourceUnit)) {
			throw new RecoveryIntegrityError(`${id} changed without an impact disposition`);
		}
		if (step !== undefined && !equal(postById.get(id), step.postRecoveryWorkUnit)) {
			throw new RecoveryIntegrityError(`${id} Plan definition does not match its recovery step`);
		}
	}
	const nonRetain = new Set(
		steps.filter((step) => step.disposition !== "retain").map((step) => String(step.workUnitId)),
	);
	for (const step of steps) {
		const id = String(step.workUnitId);
		const expected = strings(postById.get(id)?.dependencies, `${id} dependencies`)
			.filter((dependency) => nonRetain.has(dependency))
			.sort();
		if (!equal(step.dependsOnSteps, expected)) {
			throw new RecoveryIntegrityError(`${id} recovery step dependencies changed`);
		}
	}
	if (
		!equal(
			plan.executionOrder,
			postOrder.filter((id) => nonRetain.has(id)),
		)
	) {
		throw new RecoveryIntegrityError("Recovery execution order is not canonical");
	}
}

export function assertRecoveryAttemptChainIntegrity(options: {
	plan: JsonObject;
	authorization: JsonObject;
	attempts: JsonObject[];
}): void {
	const { plan, authorization, attempts } = options;
	if (
		authorization.schema !== "graphrefly.stack.recovery-authorization.v1" ||
		authorization.recoveryPlanId !== plan.recoveryPlanId ||
		!equal(authorization.planDigest, hash(plan)) ||
		!equal(authorization.impactDigest, plan.impactDigest) ||
		!equal(authorization.policyDigest, plan.policyDigest) ||
		!equal(authorization.expectedHead, plan.expectedHead) ||
		authorization.recoveryRef !== `refs/heads/grfs/recovery/${String(plan.recoveryPlanId)}`
	) {
		throw new RecoveryIntegrityError("RecoveryAuthorization does not bind the exact plan and ref");
	}
	if (attempts.length === 0) throw new RecoveryIntegrityError("Recovery attempt chain is empty");
	let previous: JsonObject | undefined;
	for (let index = 0; index < attempts.length; index += 1) {
		const attempt = attempts[index] as JsonObject;
		if (
			attempt.schema !== "graphrefly.stack.recovery-attempt.v1" ||
			attempt.sequence !== index ||
			attempt.recoveryPlanId !== plan.recoveryPlanId ||
			!equal(attempt.planDigest, hash(plan)) ||
			!equal(attempt.authorizationDigest, hash(authorization)) ||
			!equal(attempt.previousAttemptDigest, previous === undefined ? null : hash(previous)) ||
			(previous !== undefined && !equal(attempt.expectedBefore, previous.observedAfter))
		) {
			throw new RecoveryIntegrityError(`RecoveryAttempt ${index} breaks the append-only chain`);
		}
		const isStep = ["step-retained", "step-applied", "step-failed"].includes(
			String(attempt.status),
		);
		if (isStep !== (attempt.workUnitId !== null)) {
			throw new RecoveryIntegrityError(`RecoveryAttempt ${index} has invalid step attribution`);
		}
		if ((attempt.status === "step-failed") !== (attempt.failure !== null)) {
			throw new RecoveryIntegrityError(`RecoveryAttempt ${index} has invalid failure evidence`);
		}
		const mutates = ["plan-accepted", "step-applied"].includes(String(attempt.status));
		if (mutates === equal(attempt.expectedBefore, attempt.observedAfter)) {
			throw new RecoveryIntegrityError(`RecoveryAttempt ${index} has invalid mutation receipt`);
		}
		previous = attempt;
	}
	const first = attempts[0] as JsonObject;
	if (
		first.status !== "branch-created" ||
		!equal(first.expectedBefore, plan.expectedHead) ||
		!equal(first.observedAfter, plan.expectedHead)
	) {
		throw new RecoveryIntegrityError("Recovery attempt chain does not start at authorized head");
	}
	const statuses = attempts.map((attempt) => String(attempt.status));
	if (statuses.slice(1).includes("branch-created")) {
		throw new RecoveryIntegrityError("Recovery branch creation is not the first and only event");
	}
	const planAcceptedIndexes = statuses
		.map((status, index) => (status === "plan-accepted" ? index : -1))
		.filter((index) => index >= 0);
	if (
		planAcceptedIndexes.length > 1 ||
		(planAcceptedIndexes.length === 1 && planAcceptedIndexes[0] !== 1)
	) {
		throw new RecoveryIntegrityError("Recovery Plan acceptance is out of order");
	}
	const planAccepted = planAcceptedIndexes.length === 1;
	if (!planAccepted && statuses.slice(1).some((status) => status !== "aborted")) {
		throw new RecoveryIntegrityError("Recovery execution began before Plan acceptance");
	}
	const expectedRetained = objects(plan.steps, "recovery steps")
		.filter((step) => step.disposition === "retain")
		.map((step) => String(step.workUnitId));
	const executionOrder = strings(plan.executionOrder, "recovery execution order");
	const retained: string[] = [];
	const applied: string[] = [];
	let executionBegan = false;
	for (const attempt of attempts.slice(planAccepted ? 2 : 1)) {
		const status = String(attempt.status);
		if (status === "step-retained") {
			if (executionBegan || attempt.workUnitId !== expectedRetained[retained.length]) {
				throw new RecoveryIntegrityError(
					"Retained recovery evidence is incomplete or out of order",
				);
			}
			retained.push(String(attempt.workUnitId));
			continue;
		}
		if (["step-applied", "step-failed", "partial", "completed"].includes(status)) {
			executionBegan = true;
			if (!equal(retained, expectedRetained)) {
				throw new RecoveryIntegrityError(
					"Recovery execution began before retain evidence completed",
				);
			}
		}
		if (status === "step-applied") {
			if (attempt.workUnitId !== executionOrder[applied.length]) {
				throw new RecoveryIntegrityError("Recovery step application is duplicated or out of order");
			}
			applied.push(String(attempt.workUnitId));
		}
		if (status === "step-failed" && attempt.workUnitId !== executionOrder[applied.length]) {
			throw new RecoveryIntegrityError("Recovery failure does not bind the next unapplied step");
		}
		if (status === "completed" && !equal(applied, executionOrder)) {
			throw new RecoveryIntegrityError("Recovery completed before every step was applied");
		}
	}
	const terminalIndexes = attempts
		.map((attempt, index) =>
			["completed", "aborted"].includes(String(attempt.status)) ? index : -1,
		)
		.filter((index) => index >= 0);
	if (
		terminalIndexes.length > 1 ||
		(terminalIndexes.length === 1 && terminalIndexes[0] !== attempts.length - 1)
	) {
		throw new RecoveryIntegrityError("Recovery attempt chain continues after a terminal outcome");
	}
}

function projectedTopology(result: JsonObject): JsonObject {
	const topology = object(result.sharedTopology, "shared topology");
	assertDagTopologyIntegrity(topology);
	const plan = object(result.plan, "RecoveryPlan");
	const postPlan = object(plan.postRecoveryPlan, "post-recovery Plan");
	const sourcePlanId = String(plan.sourcePlanId);
	const recoveryPlanId = String(postPlan.planId);
	const steps = objects(plan.steps, "recovery steps");
	const changed = new Set(
		steps.filter((step) => step.disposition !== "retain").map((step) => String(step.workUnitId)),
	);
	const retained = new Set(
		objects(postPlan.workUnits, "post-recovery WorkUnits")
			.map((unit) => String(unit.id))
			.filter((id) => !changed.has(id)),
	);
	const entries = objects(topology.objects, "topology objects");
	const key = (value: unknown) => canonicalize(object(value, "Git OID"));
	const entryByOid = new Map(entries.map((entry) => [key(entry.oid), entry] as const));
	const owners = new Map<string, JsonObject>();
	for (const qualified of objects(result.qualifiedCommits, "qualified commits")) {
		assertPlanQualifiedCommitIntegrity(qualified);
		const oid = key(qualified.commit);
		if (owners.has(oid))
			throw new RecoveryIntegrityError("One recovery commit has multiple owners");
		const entry = entryByOid.get(oid);
		if (
			entry === undefined ||
			entry.kind !== "implementation" ||
			entry.workUnitId !== qualified.workUnitId
		) {
			throw new RecoveryIntegrityError("Qualified recovery ownership does not match topology");
		}
		owners.set(oid, qualified);
	}
	if (owners.size !== entries.filter((entry) => entry.kind === "implementation").length) {
		throw new RecoveryIntegrityError("Qualified commits do not cover shared topology");
	}
	const selected = new Set<string>();
	const projectionObjects = entries.map((entry) => {
		if (entry.kind !== "implementation") return structuredClone(entry);
		const owner = owners.get(key(entry.oid)) as JsonObject;
		const id = String(owner.workUnitId);
		const keep =
			(owner.planId === sourcePlanId && retained.has(id)) ||
			(owner.planId === recoveryPlanId && changed.has(id));
		if (!keep) {
			return {
				oid: structuredClone(entry.oid),
				parents: structuredClone(entry.parents),
				layer: entry.layer,
				kind: "transport",
				workUnitId: null,
				blueprintHash: structuredClone(entry.blueprintHash),
			};
		}
		if (selected.has(id)) throw new RecoveryIntegrityError(`Recovery selects ${id} more than once`);
		selected.add(id);
		return structuredClone(entry);
	});
	const expected = new Set([...retained, ...changed]);
	if (selected.size !== expected.size || [...expected].some((id) => !selected.has(id))) {
		throw new RecoveryIntegrityError("Recovery topology does not select the complete post-state");
	}
	return { ...structuredClone(topology), objects: projectionObjects };
}

export function assertRecoveryResultIntegrity(result: JsonObject): void {
	if (result.schema !== "graphrefly.stack.recovery-result.v1") {
		throw new RecoveryIntegrityError("RecoveryResult schema is unsupported");
	}
	const impact = object(result.impact, "RecoveryImpact");
	const plan = object(result.plan, "RecoveryPlan");
	const authorization = object(result.authorization, "RecoveryAuthorization");
	const attempts = objects(result.attempts, "RecoveryAttempt chain");
	assertRecoveryPlanIntegrity(impact, plan);
	assertRecoveryAttemptChainIntegrity({ plan, authorization, attempts });
	const last = attempts[attempts.length - 1] as JsonObject;
	if (last.status !== "completed") {
		throw new RecoveryIntegrityError("RecoveryResult requires one completed attempt chain");
	}
	const shared = object(result.sharedTopology, "shared topology");
	const sourceTopology = object(
		object(impact.sourceBundle, "source bundle").topology,
		"source topology",
	);
	if (!equal(shared.base, sourceTopology.base) || !equal(shared.head, last.observedAfter)) {
		throw new RecoveryIntegrityError(
			"Recovery topology does not bind source base and final attempt",
		);
	}
	const sharedByOid = new Map(
		objects(shared.objects, "shared objects").map(
			(entry) => [canonicalize(entry.oid), entry] as const,
		),
	);
	for (const sourceEntry of objects(sourceTopology.objects, "source objects")) {
		const sharedEntry = sharedByOid.get(canonicalize(sourceEntry.oid));
		if (sharedEntry === undefined || !equal(sharedEntry, sourceEntry)) {
			throw new RecoveryIntegrityError("Recovery shared topology rewrites source history");
		}
	}
	const expectedProjection = projectedTopology(result);
	if (!equal(result.effectiveTopology, expectedProjection)) {
		throw new RecoveryIntegrityError(
			"Recovery effective topology is not the exact lineage projection",
		);
	}
	assertDagTopologyIntegrity(result.effectiveTopology);
	const postBundle = object(result.postRecoveryBundle, "post-recovery bundle");
	if (postBundle.schema === "graphrefly.stack.dag-gate-bundle.v2") {
		assertSourceBundle(postBundle);
	} else if (postBundle.schema === "graphrefly.stack.dag-structural-error-bundle.v2") {
		assertDagStructuralErrorBundleIntegrity(postBundle);
	} else {
		throw new RecoveryIntegrityError("Post-recovery bundle schema is unsupported");
	}
	if (!equal(postBundle.topology, result.effectiveTopology)) {
		throw new RecoveryIntegrityError("Post-recovery gate does not evaluate the effective topology");
	}
	const gateInput = object(
		postBundle.schema === "graphrefly.stack.dag-gate-bundle.v2"
			? postBundle.gateInput
			: postBundle.errorInput,
		"post-recovery gate input",
	);
	if (
		!equal(gateInput.planDigest, hash(plan.postRecoveryPlan)) ||
		!equal(gateInput.policyDigest, plan.policyDigest)
	) {
		throw new RecoveryIntegrityError("Post-recovery gate does not bind the accepted recovery Plan");
	}
	const stepById = new Map(
		objects(plan.steps, "steps").map((step) => [String(step.workUnitId), step] as const),
	);
	const applied = attempts
		.filter((attempt) => attempt.status === "step-applied")
		.map((attempt) => String(attempt.workUnitId));
	if (!equal(applied, plan.executionOrder)) {
		throw new RecoveryIntegrityError("Attempt chain does not apply the canonical execution order");
	}
	const postPlanId = String(object(plan.postRecoveryPlan, "post-recovery Plan").planId);
	const recoveryOwnerById = new Map(
		objects(result.qualifiedCommits, "qualified commits")
			.filter((entry) => entry.planId === postPlanId)
			.map((entry) => [String(entry.workUnitId), entry] as const),
	);
	for (const attempt of attempts.filter((entry) => entry.status === "step-applied")) {
		const owner = recoveryOwnerById.get(String(attempt.workUnitId));
		if (owner === undefined || !equal(owner.commit, attempt.observedAfter)) {
			throw new RecoveryIntegrityError("Applied attempt does not bind its recovery commit owner");
		}
	}
	const planAcceptances = attempts.filter((attempt) => attempt.status === "plan-accepted");
	const topologyByOid = new Map(
		objects(
			object(result.sharedTopology, "shared topology").objects,
			"shared topology objects",
		).map((entry) => [canonicalize(entry.oid), entry] as const),
	);
	if (
		planAcceptances.length !== 1 ||
		topologyByOid.get(canonicalize(planAcceptances[0]?.observedAfter))?.kind !== "transport"
	) {
		throw new RecoveryIntegrityError("Recovery Plan acceptance is not one transport receipt");
	}
	const retained = attempts
		.filter((attempt) => attempt.status === "step-retained")
		.map((attempt) => String(attempt.workUnitId));
	const expectedRetained = objects(plan.steps, "steps")
		.filter((step) => step.disposition === "retain")
		.map((step) => String(step.workUnitId));
	if (!equal(retained, expectedRetained)) {
		throw new RecoveryIntegrityError("Attempt chain does not record every retained impact unit");
	}
	for (const id of [...applied, ...retained]) {
		if (!stepById.has(id))
			throw new RecoveryIntegrityError(`Attempt references unknown step ${id}`);
	}
	const externalEffectsResolved = objects(plan.steps, "steps").every((step) =>
		objects(step.externalEffects, `${String(step.workUnitId)} external effects`).every(
			(effect) => effect.status !== "unresolved",
		),
	);
	if (result.externalEffectsResolved !== externalEffectsResolved) {
		throw new RecoveryIntegrityError("External-effect resolution was translated");
	}
	const verdict = String(object(postBundle.gateResult, "post-recovery GateResult").verdict);
	const expectedOutcome =
		verdict === "error"
			? "error"
			: verdict === "pass" && externalEffectsResolved
				? "recovered"
				: "blocked";
	if (result.outcome !== expectedOutcome) {
		throw new RecoveryIntegrityError("Recovery outcome does not preserve the nested GateResult");
	}
}

export function assertRecoveryPortableBundleIntegrity(bundle: JsonObject): void {
	if (bundle.schema !== "graphrefly.stack.recovery-portable-bundle.v1") {
		throw new RecoveryIntegrityError("Recovery portable bundle schema is unsupported");
	}
	const result = object(bundle.result, "portable RecoveryResult");
	assertRecoveryResultIntegrity(result);
	if (!equal(bundle.resultDigest, hash(result))) {
		throw new RecoveryIntegrityError("Recovery portable bundle content address changed");
	}
}
