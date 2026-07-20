import {
	canonicalize,
	GROUP_INTEGRATION_RESULT_SCHEMA,
	INTEGRATION_REASON_ORDER,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

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

export function computeGroupIntegrationV1(inputValue: unknown): JsonObject {
	const input = object(inputValue, "group integration input");
	const plans = objects(input.plans, "group plans");
	const joins = objects(input.joins, "group join effects");
	const conflicts = [...objects(input.semanticConflicts, "group semantic conflicts")];
	const repositoryPolicyDigest = object(input.repositoryPolicyDigest, "repository policy digest");

	for (const plan of plans) {
		if (canonicalize(plan.policyDigest) !== canonicalize(repositoryPolicyDigest)) {
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
		if (plan.verdict === "pass") continue;
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
	const hasError = plans.some((plan) => plan.verdict === "error");
	return {
		schema: GROUP_INTEGRATION_RESULT_SCHEMA,
		inputDigest: { algorithm: "sha256", value: sha256Jcs(input) },
		verdict: hasError ? "error" : orderedConflicts.length === 0 ? "pass" : "blocked",
		reasonCodes: orderedReasons(orderedConflicts),
		plans: structuredClone(plans),
		joins: joinEvaluations,
		conflicts: orderedConflicts,
	};
}
