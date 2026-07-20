import { INTEGRATION_REASON_ORDER } from "./integration.js";
import { canonicalize, sha256Jcs } from "./jcs.js";
import { GROUP_INTEGRATION_RESULT_SCHEMA, MULTI_PLAN_LIMITS } from "./merge-group.js";

type JsonObject = Record<string, unknown>;

const graphReasons = new Set([
	"NODE_DELETE_CHANGE",
	"NODE_INCOMPATIBLE_CHANGE",
	"EDGE_INCOMPATIBLE_CHANGE",
	"SUBGRAPH_INCOMPATIBLE_CHANGE",
	"METADATA_INCOMPATIBLE_CHANGE",
]);
const semanticReasons = new Set(["CLAIM_INVALIDATED", "DEPENDENCY_INVALIDATED"]);

export class GroupIntegrationIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GroupIntegrationIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new GroupIntegrationIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) {
		throw new GroupIntegrationIntegrityError(`${label} must be an array`);
	}
	return value.map((entry) => object(entry, label));
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") {
		throw new GroupIntegrationIntegrityError(`${label} must be a string`);
	}
	return value;
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function isCanonical(values: readonly unknown[]): boolean {
	return values.every(
		(value, index) => index === 0 || canonicalize(values[index - 1]) < canonicalize(value),
	);
}

function sorted<T>(values: readonly T[]): T[] {
	return [...values].sort((left, right) => {
		const leftBytes = canonicalize(left);
		const rightBytes = canonicalize(right);
		return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
	});
}

function orderedReasons(conflicts: readonly JsonObject[]): string[] {
	const present = new Set(
		conflicts.map((entry) => object(entry.conflict, "group conflict").reasonCode as string),
	);
	return INTEGRATION_REASON_ORDER.filter((reason) => present.has(reason));
}

function validateInput(input: JsonObject): void {
	const plans = objects(input.plans, "group plans");
	if (plans.length < 1 || plans.length > MULTI_PLAN_LIMITS.maxPlans) {
		throw new GroupIntegrationIntegrityError("group must bind between one and eight Plans");
	}
	const planIds = plans.map((plan) => string(plan.planId, "group Plan ID"));
	if (
		new Set(planIds).size !== planIds.length ||
		!planIds.every((id, index) => index === 0 || (planIds[index - 1] as string) < id)
	) {
		throw new GroupIntegrationIntegrityError(
			"group Plans are duplicated or not ordered by Plan ID",
		);
	}
	const planSet = new Set(planIds);
	const qualified = objects(input.qualifiedCommitDigests, "qualified commit digests");
	const qualifiedKeys = qualified.map((entry) => {
		const planId = string(entry.planId, "qualified Plan ID");
		const workUnitId = string(entry.workUnitId, "qualified WorkUnit ID");
		if (!planSet.has(planId)) {
			throw new GroupIntegrationIntegrityError("qualified commit belongs to an unknown Plan");
		}
		return `${planId}\u0000${workUnitId}`;
	});
	if (
		new Set(qualifiedKeys).size !== qualifiedKeys.length ||
		!qualifiedKeys.every((key, index) => index === 0 || (qualifiedKeys[index - 1] as string) < key)
	) {
		throw new GroupIntegrationIntegrityError(
			"qualified commit identities are duplicated or not canonical",
		);
	}
	for (const planId of planIds) {
		if (!qualifiedKeys.some((key) => key.startsWith(`${planId}\u0000`))) {
			throw new GroupIntegrationIntegrityError(`${planId} has no qualified implementation`);
		}
	}

	const joins = objects(input.joins, "join effect evidence");
	const joinKeys = joins.map((join) => {
		const oid = object(join.oid, "join OID");
		return `${String(join.layer).padStart(3, "0")}\u0000${string(oid.value, "join OID value")}`;
	});
	if (
		new Set(joinKeys).size !== joinKeys.length ||
		!joinKeys.every((key, index) => index === 0 || (joinKeys[index - 1] as string) < key)
	) {
		throw new GroupIntegrationIntegrityError(
			"join effects are duplicated or not in topology order",
		);
	}
	for (const join of joins) {
		const overlaps = objects(join.overlaps, "join overlaps");
		const conflicts = objects(join.conflicts, "join conflicts");
		if (!isCanonical(overlaps) || !isCanonical(conflicts)) {
			throw new GroupIntegrationIntegrityError("join effects are not canonically ordered");
		}
		for (const conflict of conflicts) {
			if (!graphReasons.has(string(conflict.reasonCode, "join conflict reason"))) {
				throw new GroupIntegrationIntegrityError("join contains a non-graph conflict reason");
			}
		}
	}

	const semanticConflicts = objects(input.semanticConflicts, "semantic conflicts");
	if (!isCanonical(semanticConflicts)) {
		throw new GroupIntegrationIntegrityError("semantic conflicts are not canonical");
	}
	for (const conflict of semanticConflicts) {
		const planId = string(conflict.planId, "semantic conflict Plan ID");
		const workUnitId = string(conflict.workUnitId, "semantic conflict WorkUnit ID");
		const inner = object(conflict.conflict, "semantic conflict");
		const witness = object(inner.witness, "semantic conflict witness");
		const reason = string(inner.reasonCode, "semantic conflict reason");
		const witnessKind = string(witness.kind, "semantic conflict witness kind");
		const dependencyIsLocal =
			reason !== "DEPENDENCY_INVALIDATED" ||
			(typeof witness.dependencyId === "string" &&
				qualifiedKeys.includes(`${planId}\u0000${witness.dependencyId}`));
		if (
			conflict.join !== null ||
			!planSet.has(planId) ||
			!qualifiedKeys.includes(`${planId}\u0000${workUnitId}`) ||
			!semanticReasons.has(reason) ||
			witness.workUnitId !== workUnitId ||
			(reason === "CLAIM_INVALIDATED" && witnessKind !== "claim") ||
			(reason === "DEPENDENCY_INVALIDATED" && witnessKind !== "dependency") ||
			!dependencyIsLocal
		) {
			throw new GroupIntegrationIntegrityError("semantic conflict is not Plan-qualified");
		}
	}
}

function derive(input: JsonObject): JsonObject {
	const plans = objects(input.plans, "group plans");
	const joins = objects(input.joins, "group joins");
	const repositoryPolicyDigest = object(input.repositoryPolicyDigest, "repository policy digest");
	const conflicts = [...objects(input.semanticConflicts, "semantic conflicts")];
	for (const plan of plans) {
		if (!equal(plan.policyDigest, repositoryPolicyDigest)) {
			conflicts.push({
				planId: plan.planId,
				workUnitId: null,
				join: null,
				conflict: {
					reasonCode: "POLICY_INVALIDATED",
					witness: { kind: "policy", policyDigest: plan.policyDigest },
				},
			});
		}
		if (plan.verdict !== "pass") {
			conflicts.push({
				planId: plan.planId,
				workUnitId: null,
				join: null,
				conflict: {
					reasonCode: "HEAD_GATE_NOT_PASSING",
					witness: { kind: "diagnostics", code: "HEAD_GATE_NOT_PASSING", path: null },
				},
			});
		}
	}
	const joinEvaluations = joins.map((join) => {
		const joinConflicts = objects(join.conflicts, "join conflicts");
		for (const conflict of joinConflicts) {
			conflicts.push({
				planId: null,
				workUnitId: null,
				join: join.oid,
				conflict,
			});
		}
		return {
			oid: join.oid,
			joinDigest: join.joinDigest,
			valid: joinConflicts.length === 0,
			reasonCodes: orderedReasons(joinConflicts.map((conflict) => ({ conflict }))),
			overlaps: sorted(objects(join.overlaps, "join overlaps")),
			conflicts: sorted(joinConflicts),
		};
	});
	const orderedConflicts = sorted(conflicts);
	return {
		schema: GROUP_INTEGRATION_RESULT_SCHEMA,
		inputDigest: { algorithm: "sha256", value: sha256Jcs(input) },
		verdict: plans.some((plan) => plan.verdict === "error")
			? "error"
			: orderedConflicts.length === 0
				? "pass"
				: "blocked",
		reasonCodes: orderedReasons(orderedConflicts),
		plans: structuredClone(plans),
		joins: joinEvaluations,
		conflicts: orderedConflicts,
	};
}

export function assertGroupIntegrationIntegrity(inputValue: unknown, resultValue: unknown): void {
	const input = object(inputValue, "group integration input");
	const result = object(resultValue, "group integration result");
	validateInput(input);
	if (!equal(result, derive(input))) {
		throw new GroupIntegrationIntegrityError(
			"group integration result is not independently derived",
		);
	}
}
