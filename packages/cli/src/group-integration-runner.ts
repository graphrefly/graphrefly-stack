import { readFile } from "node:fs/promises";
import {
	assertDagTopologyIntegrity,
	assertGroupIntegrationIntegrity,
	assertPlanQualifiedCommitIntegrity,
	canonicalize,
	createStrictAjv,
	GROUP_INTEGRATION_INPUT_SCHEMA,
	MERGE_GROUP_ARTIFACTS_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import { computeGroupIntegrationV1, evaluateIntegrationEffects } from "@graphrefly-stack/core";

import { diffRepositoryBlueprintSnapshots } from "./repository-review.js";
import { runtimeAssetPath } from "./runtime-paths.js";
import { evaluateSemanticPredicate } from "./semantic-repository.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

type DeltaEvidence = {
	from: JsonObject;
	to: JsonObject;
	delta: JsonObject;
	digest: Hash;
};

export class GroupIntegrationRunnerError extends Error {
	constructor(
		readonly code:
			| "GROUP_INPUT_INVALID"
			| "GROUP_PLAN_INVALID"
			| "GROUP_OWNERSHIP_INVALID"
			| "GROUP_JOIN_INVALID"
			| "CROSS_PLAN_DEPENDENCY_UNSUPPORTED"
			| "GROUP_CONTRACT_INVALID",
		message: string,
	) {
		super(message);
		this.name = "GroupIntegrationRunnerError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new GroupIntegrationRunnerError("GROUP_INPUT_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) {
		throw new GroupIntegrationRunnerError("GROUP_INPUT_INVALID", `${label} must be an array`);
	}
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new GroupIntegrationRunnerError("GROUP_PLAN_INVALID", `${label} must be strings`);
	}
	return value;
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function compareCanonical(left: unknown, right: unknown): number {
	const leftBytes = canonicalize(left);
	const rightBytes = canonicalize(right);
	return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalUnits(planId: string, units: JsonObject[]): JsonObject[] {
	const byId = new Map<string, JsonObject>();
	for (const unit of units) {
		const id = String(unit.id);
		if (byId.has(id)) {
			throw new GroupIntegrationRunnerError(
				"GROUP_PLAN_INVALID",
				`${planId} repeats WorkUnit ${id}`,
			);
		}
		byId.set(id, unit);
	}
	const ordered: JsonObject[] = [];
	const admitted = new Set<string>();
	while (ordered.length < units.length) {
		const next = [...byId]
			.filter(
				([id, unit]) =>
					!admitted.has(id) &&
					strings(unit.dependencies, `${planId}/${id} dependencies`).every((dependency) =>
						admitted.has(dependency),
					),
			)
			.sort(([left], [right]) => compareText(left, right))[0];
		if (next === undefined) {
			throw new GroupIntegrationRunnerError(
				"GROUP_PLAN_INVALID",
				`${planId} dependencies are missing or cyclic`,
			);
		}
		admitted.add(next[0]);
		ordered.push(next[1]);
	}
	return ordered;
}

async function validators() {
	const paths = [
		"contracts/semantic/v1/artifacts.schema.json",
		"contracts/dag/v2/artifacts.schema.json",
		"contracts/dag/v2/semantic.schema.json",
		"contracts/integration/v1/artifacts.schema.json",
		"contracts/dag/v2/merge-group.schema.json",
	];
	const schemas = await Promise.all(
		paths.map(async (path) => JSON.parse(await readFile(runtimeAssetPath(path), "utf8"))),
	);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	return {
		input: ajv.getSchema(`${MERGE_GROUP_ARTIFACTS_SCHEMA}#/definitions/GroupIntegrationInput`),
		result: ajv.getSchema(`${MERGE_GROUP_ARTIFACTS_SCHEMA}#/definitions/GroupIntegrationResult`),
	};
}

function assertDelta(
	evidence: DeltaEvidence,
	from: JsonObject,
	to: JsonObject,
	label: string,
): void {
	if (
		!equal(evidence.from, from) ||
		!equal(evidence.to, to) ||
		!equal(evidence.digest, hash(evidence.delta))
	) {
		throw new GroupIntegrationRunnerError(
			"GROUP_JOIN_INVALID",
			`${label} does not bind its exact endpoints and delta`,
		);
	}
}

export async function createGroupJoinEvidence(options: {
	repository: string;
	topology: JsonObject;
	blueprints: Array<{ revision: JsonObject; blueprint: JsonObject }>;
}): Promise<
	Array<{
		oid: JsonObject;
		target: DeltaEvidence;
		head: DeltaEvidence;
		candidate: DeltaEvidence;
	}>
> {
	assertDagTopologyIntegrity(options.topology);
	const blueprintByRevision = new Map(
		options.blueprints.map((entry) => [String(entry.revision.value), entry.blueprint] as const),
	);
	const result = [];
	for (const join of objects(options.topology.joins, "topology joins")) {
		const oid = object(join.oid, "join OID");
		const mergeBase = object(join.mergeBase, "join merge base");
		const parents = objects(join.parents, "join parents");
		const baseBlueprint = blueprintByRevision.get(String(mergeBase.value));
		const targetBlueprint = blueprintByRevision.get(String(parents[0]?.value));
		const headBlueprint = blueprintByRevision.get(String(parents[1]?.value));
		const candidateBlueprint = blueprintByRevision.get(String(oid.value));
		if (
			baseBlueprint === undefined ||
			targetBlueprint === undefined ||
			headBlueprint === undefined ||
			candidateBlueprint === undefined
		) {
			throw new GroupIntegrationRunnerError(
				"GROUP_JOIN_INVALID",
				"join lacks exact merge-base, parent or candidate Blueprint evidence",
			);
		}
		const [target, head, candidate] = await Promise.all([
			diffRepositoryBlueprintSnapshots({
				repository: options.repository,
				previous: baseBlueprint,
				next: targetBlueprint,
				executionCache: true,
			}),
			diffRepositoryBlueprintSnapshots({
				repository: options.repository,
				previous: baseBlueprint,
				next: headBlueprint,
				executionCache: true,
			}),
			diffRepositoryBlueprintSnapshots({
				repository: options.repository,
				previous: baseBlueprint,
				next: candidateBlueprint,
				executionCache: true,
			}),
		]);
		result.push({
			oid,
			target: {
				from: mergeBase,
				to: parents[0] as JsonObject,
				delta: target.delta,
				digest: target.digest,
			},
			head: {
				from: mergeBase,
				to: parents[1] as JsonObject,
				delta: head.delta,
				digest: head.digest,
			},
			candidate: { from: mergeBase, to: oid, delta: candidate.delta, digest: candidate.digest },
		});
	}
	return result;
}

export async function assembleGroupIntegration(options: {
	topology: JsonObject;
	repositoryPolicy: JsonObject;
	qualifiedCommits: JsonObject[];
	plans: Array<{ plan: JsonObject; policy: JsonObject; gateResult: JsonObject }>;
	headBlueprint: { revision: JsonObject; blueprint: JsonObject; blueprintHash: JsonObject };
	joinEvidence: Array<{
		oid: JsonObject;
		target: DeltaEvidence;
		head: DeltaEvidence;
		candidate: DeltaEvidence;
	}>;
}): Promise<{ input: JsonObject; result: JsonObject }> {
	if (options.plans.length < 1 || options.plans.length > 8) {
		throw new GroupIntegrationRunnerError("GROUP_INPUT_INVALID", "group bounds are invalid");
	}
	try {
		assertDagTopologyIntegrity(options.topology);
	} catch (error) {
		throw new GroupIntegrationRunnerError(
			"GROUP_INPUT_INVALID",
			error instanceof Error ? error.message : "group topology is invalid",
		);
	}
	const topologyHead = object(options.topology.head, "topology head");
	const headEntry = objects(options.topology.objects, "topology objects").find((entry) =>
		equal(entry.oid, topologyHead),
	);
	if (
		headEntry === undefined ||
		!equal(options.headBlueprint.revision, topologyHead) ||
		!equal(options.headBlueprint.blueprintHash, headEntry.blueprintHash)
	) {
		throw new GroupIntegrationRunnerError(
			"GROUP_INPUT_INVALID",
			"final Blueprint evidence does not bind the exact topology head",
		);
	}
	const plans = [...options.plans].sort((left, right) =>
		compareText(String(left.plan.planId), String(right.plan.planId)),
	);
	const planIds = plans.map(({ plan }) => String(plan.planId));
	if (new Set(planIds).size !== planIds.length) {
		throw new GroupIntegrationRunnerError("GROUP_PLAN_INVALID", "group Plan IDs are duplicated");
	}
	const qualifiedCommitDigests = options.qualifiedCommits
		.map((commit) => {
			assertPlanQualifiedCommitIntegrity(commit);
			return {
				planId: commit.planId,
				workUnitId: commit.workUnitId,
				digest: hash(commit),
			};
		})
		.sort((left, right) =>
			compareText(
				`${left.planId}\u0000${left.workUnitId}`,
				`${right.planId}\u0000${right.workUnitId}`,
			),
		);
	const qualifiedPairs = new Set(
		qualifiedCommitDigests.map((entry) => `${entry.planId}\u0000${entry.workUnitId}`),
	);
	const allWorkUnits = new Map<string, Set<string>>();
	const planUnits = new Map<string, JsonObject[]>();
	for (const { plan, policy } of plans) {
		const planId = String(plan.planId);
		const policyBinding = object(plan.policy, `${planId} policy binding`);
		if (
			policyBinding.policyId !== policy.policyId ||
			policyBinding.revision !== policy.revision ||
			!equal(policyBinding.digest, hash(policy))
		) {
			throw new GroupIntegrationRunnerError(
				"GROUP_PLAN_INVALID",
				`${planId} does not bind its exact policy`,
			);
		}
		const units = objects(plan.workUnits, `${planId} WorkUnits`);
		const ids = new Set<string>();
		for (const unit of units) {
			const id = String(unit.id);
			if (ids.has(id)) {
				throw new GroupIntegrationRunnerError(
					"GROUP_PLAN_INVALID",
					`${planId} repeats WorkUnit ${id}`,
				);
			}
			ids.add(id);
		}
		allWorkUnits.set(planId, ids);
		planUnits.set(planId, units);
		for (const id of ids) {
			if (!qualifiedPairs.has(`${planId}\u0000${id}`)) {
				throw new GroupIntegrationRunnerError(
					"GROUP_OWNERSHIP_INVALID",
					`${planId}/${id} has no qualified implementation`,
				);
			}
		}
	}
	if (qualifiedPairs.size !== qualifiedCommitDigests.length) {
		throw new GroupIntegrationRunnerError(
			"GROUP_OWNERSHIP_INVALID",
			"qualified implementation identity is duplicated",
		);
	}
	for (const pair of qualifiedPairs) {
		const [planId, workUnitId] = pair.split("\u0000");
		if (
			planId === undefined ||
			workUnitId === undefined ||
			!allWorkUnits.get(planId)?.has(workUnitId)
		) {
			throw new GroupIntegrationRunnerError(
				"GROUP_OWNERSHIP_INVALID",
				`${pair} is outside the accepted Plans`,
			);
		}
	}
	for (const [planId, units] of planUnits) {
		const localUnits = allWorkUnits.get(planId) as Set<string>;
		for (const unit of units) {
			const workUnitId = String(unit.id);
			for (const dependencyId of strings(
				unit.dependencies,
				`${planId}/${workUnitId} dependencies`,
			)) {
				if (localUnits.has(dependencyId)) continue;
				const foreignPlan = [...allWorkUnits].find(
					([candidatePlanId, ids]) => candidatePlanId !== planId && ids.has(dependencyId),
				);
				throw new GroupIntegrationRunnerError(
					foreignPlan === undefined ? "GROUP_PLAN_INVALID" : "CROSS_PLAN_DEPENDENCY_UNSUPPORTED",
					foreignPlan === undefined
						? `${planId}/${workUnitId} depends on missing ${dependencyId}`
						: `${planId}/${workUnitId} depends on ${foreignPlan[0]}/${dependencyId}`,
				);
			}
		}
	}

	const semanticConflicts: JsonObject[] = [];
	for (const { plan } of plans) {
		const planId = String(plan.planId);
		const localUnits = allWorkUnits.get(planId) as Set<string>;
		const invalid = new Set<string>();
		for (const unit of canonicalUnits(planId, planUnits.get(planId) as JsonObject[])) {
			const workUnitId = String(unit.id);
			for (const dependencyId of strings(
				unit.dependencies,
				`${planId}/${workUnitId} dependencies`,
			)) {
				if (!localUnits.has(dependencyId)) {
					throw new GroupIntegrationRunnerError(
						"GROUP_PLAN_INVALID",
						`${planId}/${workUnitId} dependency prevalidation drifted`,
					);
				}
				if (invalid.has(dependencyId)) {
					invalid.add(workUnitId);
					semanticConflicts.push({
						planId,
						workUnitId,
						join: null,
						conflict: {
							reasonCode: "DEPENDENCY_INVALIDATED",
							witness: { kind: "dependency", workUnitId, dependencyId },
						},
					});
				}
			}
			for (const claim of objects(unit.claims, `${planId}/${workUnitId} claims`)) {
				const predicate = object(claim.predicate, `${planId}/${workUnitId} predicate`);
				if (evaluateSemanticPredicate(options.headBlueprint.blueprint, predicate).ok) continue;
				invalid.add(workUnitId);
				semanticConflicts.push({
					planId,
					workUnitId,
					join: null,
					conflict: {
						reasonCode: "CLAIM_INVALIDATED",
						witness: { kind: "claim", workUnitId, claimId: claim.id },
					},
				});
			}
		}
	}

	const topologyJoins = objects(options.topology.joins, "topology joins");
	if (topologyJoins.length !== options.joinEvidence.length) {
		throw new GroupIntegrationRunnerError(
			"GROUP_JOIN_INVALID",
			"join evidence does not exactly cover topology joins",
		);
	}
	const joins = topologyJoins.map((join, index) => {
		const evidence = options.joinEvidence[index];
		if (evidence === undefined || !equal(evidence.oid, join.oid)) {
			throw new GroupIntegrationRunnerError(
				"GROUP_JOIN_INVALID",
				"join evidence is not in topology order",
			);
		}
		const parents = objects(join.parents, "join parents");
		const mergeBase = object(join.mergeBase, "join merge base");
		assertDelta(evidence.target, mergeBase, parents[0] as JsonObject, "target join delta");
		assertDelta(evidence.head, mergeBase, parents[1] as JsonObject, "head join delta");
		assertDelta(evidence.candidate, mergeBase, object(join.oid, "join OID"), "candidate delta");
		const effects = evaluateIntegrationEffects({
			targetDelta: evidence.target.delta,
			headDelta: evidence.head.delta,
			candidateDelta: evidence.candidate.delta,
		});
		return {
			oid: join.oid,
			layer: join.layer,
			joinDigest: hash(join),
			targetDeltaDigest: evidence.target.digest,
			headDeltaDigest: evidence.head.digest,
			candidateDeltaDigest: evidence.candidate.digest,
			overlaps: effects.overlaps,
			conflicts: effects.conflicts,
		};
	});

	const input: JsonObject = {
		schema: GROUP_INTEGRATION_INPUT_SCHEMA,
		topologyDigest: hash(options.topology),
		headBlueprintDigest: hash(options.headBlueprint.blueprint),
		repositoryPolicyDigest: hash(options.repositoryPolicy),
		qualifiedCommitDigests,
		plans: plans.map(({ plan, policy, gateResult }) => ({
			planId: plan.planId,
			planDigest: hash(plan),
			policyDigest: hash(policy),
			gateResultDigest: hash(gateResult),
			verdict: gateResult.verdict,
		})),
		joins,
		semanticConflicts: semanticConflicts.sort(compareCanonical),
	};
	const result = computeGroupIntegrationV1(input);
	const validate = await validators();
	if (validate.input === undefined || !validate.input(input)) {
		throw new GroupIntegrationRunnerError(
			"GROUP_CONTRACT_INVALID",
			`GroupIntegrationInput: ${JSON.stringify(validate.input?.errors)}`,
		);
	}
	if (validate.result === undefined || !validate.result(result)) {
		throw new GroupIntegrationRunnerError(
			"GROUP_CONTRACT_INVALID",
			`GroupIntegrationResult: ${JSON.stringify(validate.result?.errors)}`,
		);
	}
	assertGroupIntegrationIntegrity(input, result);
	return { input, result };
}
