import { assertDagTopologyIntegrity } from "./dag-integrity.js";
import { assertDagSemanticIntegrity } from "./dag-semantic-integrity.js";
import { assertDagStructuralErrorBundleIntegrity } from "./dag-structural-error-integrity.js";
import { assertGroupIntegrationIntegrity } from "./group-integration-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";
import {
	assertLinearV1ConversionIntegrity,
	assertPlanQualifiedCommitIntegrity,
} from "./linear-v1-conversion.js";
import { MERGE_GROUP_INVOCATION_SCHEMA, MERGE_GROUP_RESULT_SCHEMA } from "./merge-group.js";

type JsonObject = Record<string, unknown>;
type PlanSource = { planId: string; plan: JsonObject; policy: JsonObject; gateBundle: JsonObject };

export interface MergeGroupIntegritySourcesV1 {
	invocation: JsonObject;
	topology: JsonObject;
	qualifiedCommits: JsonObject[];
	conversions: Array<{ planId: string; bundle: JsonObject }>;
	plans: PlanSource[];
	groupIntegrationInput: JsonObject;
	groupIntegrationResult: JsonObject;
}

export class MergeGroupIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MergeGroupIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MergeGroupIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new MergeGroupIntegrityError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") throw new MergeGroupIntegrityError(`${label} must be a string`);
	return value;
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function digest(value: unknown): JsonObject {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function sortedByPlan<T extends { planId: string }>(values: readonly T[]): T[] {
	return [...values].sort((left, right) =>
		left.planId < right.planId ? -1 : left.planId > right.planId ? 1 : 0,
	);
}

function compareQualified(
	left: { planId: unknown; workUnitId: unknown },
	right: { planId: unknown; workUnitId: unknown },
): number {
	const leftKey = `${String(left.planId)}\u0000${String(left.workUnitId)}`;
	const rightKey = `${String(right.planId)}\u0000${String(right.workUnitId)}`;
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function oidKey(value: unknown): string {
	return canonicalize(object(value, "Git OID"));
}

function projection(topology: JsonObject, qualified: JsonObject[], planId: string): JsonObject {
	const owners = new Map(qualified.map((entry) => [oidKey(entry.commit), entry] as const));
	const projected = objects(topology.objects, "topology objects").map((entry) => {
		if (entry.kind !== "implementation") return structuredClone(entry);
		const owner = owners.get(oidKey(entry.oid));
		if (owner === undefined) {
			throw new MergeGroupIntegrityError("implementation object has no Plan owner");
		}
		if (owner.planId === planId) return structuredClone(entry);
		return {
			oid: structuredClone(entry.oid),
			parents: structuredClone(entry.parents),
			layer: entry.layer,
			kind: "transport",
			workUnitId: null,
			blueprintHash: structuredClone(entry.blueprintHash),
		};
	});
	return { ...structuredClone(topology), objects: projected };
}

function assertInvocation(sources: MergeGroupIntegritySourcesV1): void {
	const invocation = sources.invocation;
	if (invocation.schema !== MERGE_GROUP_INVOCATION_SCHEMA) {
		throw new MergeGroupIntegrityError("merge-group invocation schema is unsupported");
	}
	const adapter = object(invocation.adapter, "invocation adapter");
	const repository = object(invocation.repository, "invocation repository");
	const event = object(invocation.event, "merge-group event");
	const checkout = object(invocation.checkout, "merge-group checkout");
	const concurrency = object(invocation.concurrency, "merge-group concurrency");
	const identity = object(invocation.identity, "invocation identity");
	if (
		adapter.provider !== "github-actions" ||
		adapter.version !== "v1" ||
		event.name !== "merge_group" ||
		event.action !== "checks_requested" ||
		concurrency.cancelInProgress !== false ||
		identity.assurance !== "platform-asserted"
	) {
		throw new MergeGroupIntegrityError("merge-group invocation is not a supported platform event");
	}
	if (
		!equal(repository.identity, sources.topology.repository) ||
		!equal(event.base, sources.topology.base) ||
		!equal(event.head, sources.topology.head) ||
		!equal(checkout.sha, sources.topology.head) ||
		checkout.ref !== event.headRef ||
		!equal(invocation.topologyDigest, digest(sources.topology))
	) {
		throw new MergeGroupIntegrityError("merge-group event or checkout does not bind the topology");
	}
	const expectedConcurrency = digest({
		repositoryId: repository.id,
		event: "merge_group",
		headRef: event.headRef,
		head: event.head,
	});
	if (!equal(concurrency.identityDigest, expectedConcurrency)) {
		throw new MergeGroupIntegrityError("merge-group concurrency identity is not deterministic");
	}
}

function validateSources(sources: MergeGroupIntegritySourcesV1): void {
	assertDagTopologyIntegrity(sources.topology);
	assertInvocation(sources);
	const plans = sortedByPlan(sources.plans);
	if (plans.length === 0 || plans.length > 8) {
		throw new MergeGroupIntegrityError("merge group must contain between one and eight Plans");
	}
	if (new Set(plans.map((entry) => entry.planId)).size !== plans.length) {
		throw new MergeGroupIntegrityError("merge group repeats a Plan identity");
	}
	const invocationPlans = objects(sources.invocation.plans, "invocation Plans");
	const expectedInvocationPlans = plans.map((entry) => ({
		planId: entry.planId,
		planDigest: digest(entry.plan),
		policyDigest: digest(entry.policy),
	}));
	if (!equal(invocationPlans, expectedInvocationPlans)) {
		throw new MergeGroupIntegrityError(
			"invocation Plans are not canonical or do not match sources",
		);
	}

	const qualifiedByOid = new Map<string, JsonObject>();
	for (const entry of sources.qualifiedCommits) {
		assertPlanQualifiedCommitIntegrity(entry);
		const key = oidKey(entry.commit);
		if (qualifiedByOid.has(key)) {
			throw new MergeGroupIntegrityError("one Git commit has multiple Plan owners");
		}
		qualifiedByOid.set(key, entry);
	}
	for (const entry of objects(sources.topology.objects, "topology objects")) {
		const owner = qualifiedByOid.get(oidKey(entry.oid));
		if (entry.kind === "implementation") {
			if (
				owner === undefined ||
				owner.workUnitId !== entry.workUnitId ||
				!plans.some((plan) => plan.planId === owner.planId)
			) {
				throw new MergeGroupIntegrityError("implementation ownership does not match topology");
			}
		} else if (owner !== undefined) {
			throw new MergeGroupIntegrityError("non-implementation object has a Plan owner");
		}
	}
	if (
		qualifiedByOid.size !==
		objects(sources.topology.objects, "topology objects").filter(
			(entry) => entry.kind === "implementation",
		).length
	) {
		throw new MergeGroupIntegrityError("qualified commits do not exactly cover implementations");
	}

	for (const entry of plans) {
		const bundle = entry.gateBundle;
		const expectedTopology = projection(sources.topology, sources.qualifiedCommits, entry.planId);
		if (!equal(bundle.topology, expectedTopology)) {
			throw new MergeGroupIntegrityError(
				`${entry.planId} gate topology is not its exact projection`,
			);
		}
		const graph = object(bundle.dependencyGraph, `${entry.planId} dependency graph`);
		if (graph.planId !== entry.planId) {
			throw new MergeGroupIntegrityError(`${entry.planId} dependency graph identity drifted`);
		}
		if (bundle.schema === "graphrefly.stack.dag-gate-bundle.v2") {
			const gateInput = object(bundle.gateInput, `${entry.planId} GateInput`);
			if (
				!equal(gateInput.planDigest, digest(entry.plan)) ||
				!equal(gateInput.policyDigest, digest(entry.policy))
			) {
				throw new MergeGroupIntegrityError(
					`${entry.planId} gate does not bind its Plan and policy`,
				);
			}
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
		} else if (bundle.schema === "graphrefly.stack.dag-structural-error-bundle.v2") {
			if (!equal(bundle.plan, entry.plan) || !equal(bundle.policy, entry.policy)) {
				throw new MergeGroupIntegrityError(
					`${entry.planId} structural error does not bind its Plan and policy`,
				);
			}
			assertDagStructuralErrorBundleIntegrity(bundle);
		} else {
			throw new MergeGroupIntegrityError(`${entry.planId} gate bundle schema is unsupported`);
		}
	}

	const convertedPlans = new Set<string>();
	for (const conversion of sources.conversions) {
		if (convertedPlans.has(conversion.planId)) {
			throw new MergeGroupIntegrityError("merge group repeats a v1 conversion Plan");
		}
		assertLinearV1ConversionIntegrity(conversion.bundle);
		for (const qualified of objects(conversion.bundle.qualifiedCommits, "conversion commits")) {
			if (
				qualified.planId !== conversion.planId ||
				!sources.qualifiedCommits.some((entry) => equal(entry, qualified))
			) {
				throw new MergeGroupIntegrityError("v1 conversion ownership is not included exactly");
			}
		}
		convertedPlans.add(conversion.planId);
	}
	for (const qualified of sources.qualifiedCommits) {
		const ownership = object(qualified.ownership, "qualified ownership");
		if (
			ownership.kind === "converted-v1" &&
			!convertedPlans.has(string(qualified.planId, "Plan ID"))
		) {
			throw new MergeGroupIntegrityError(
				"converted v1 ownership has no verified conversion bundle",
			);
		}
	}

	assertGroupIntegrationIntegrity(sources.groupIntegrationInput, sources.groupIntegrationResult);
	const groupInput = sources.groupIntegrationInput;
	const planSummaries = plans.map((entry) => {
		const result = object(entry.gateBundle.gateResult, `${entry.planId} GateResult`);
		return {
			planId: entry.planId,
			planDigest: digest(entry.plan),
			policyDigest: digest(entry.policy),
			gateResultDigest: digest(result),
			verdict: result.verdict,
		};
	});
	const qualifiedDigests = [...sources.qualifiedCommits]
		.map((entry) => ({ planId: entry.planId, workUnitId: entry.workUnitId, digest: digest(entry) }))
		.sort(compareQualified);
	if (
		!equal(groupInput.topologyDigest, digest(sources.topology)) ||
		!equal(groupInput.qualifiedCommitDigests, qualifiedDigests) ||
		!equal(groupInput.plans, planSummaries)
	) {
		throw new MergeGroupIntegrityError("group integration input does not bind aggregate sources");
	}
}

export function assertMergeGroupBundleIntegrityV1(value: unknown): void {
	const bundle = object(value, "merge-group bundle");
	if (bundle.schema !== "graphrefly.stack.merge-group-bundle.v1") {
		throw new MergeGroupIntegrityError("merge-group bundle schema is unsupported");
	}
	assertMergeGroupIntegrityV1(
		{
			invocation: object(bundle.invocation, "merge-group invocation"),
			topology: object(bundle.topology, "merge-group topology"),
			qualifiedCommits: objects(bundle.qualifiedCommits, "qualified commits"),
			conversions: objects(bundle.conversions, "conversions").map((entry) => ({
				planId: string(entry.planId, "conversion Plan ID"),
				bundle: object(entry.bundle, "conversion bundle"),
			})),
			plans: objects(bundle.plans, "merge-group Plans").map((entry) => ({
				planId: string(entry.planId, "Plan ID"),
				plan: object(entry.plan, "Plan"),
				policy: object(entry.policy, "policy"),
				gateBundle: object(entry.gateBundle, "gate bundle"),
			})),
			groupIntegrationInput: object(bundle.groupIntegrationInput, "group integration input"),
			groupIntegrationResult: object(bundle.groupIntegrationResult, "group integration result"),
		},
		bundle.result,
	);
}

function deriveResult(sources: MergeGroupIntegritySourcesV1): JsonObject {
	const plans = sortedByPlan(sources.plans).map((entry) => {
		const gateResult = object(entry.gateBundle.gateResult, `${entry.planId} GateResult`);
		return {
			planId: entry.planId,
			planDigest: digest(entry.plan),
			policyDigest: digest(entry.policy),
			gateBundleDigest: digest(entry.gateBundle),
			gateResult: structuredClone(gateResult),
		};
	});
	const failedPlanIds = plans
		.filter((entry) => entry.gateResult.verdict !== "pass")
		.map((entry) => entry.planId);
	const error =
		sources.groupIntegrationResult.verdict === "error" ||
		plans.some((entry) => entry.gateResult.verdict === "error");
	return {
		schema: MERGE_GROUP_RESULT_SCHEMA,
		invocationDigest: digest(sources.invocation),
		topologyDigest: digest(sources.topology),
		qualifiedCommitDigests: [...sources.qualifiedCommits]
			.map((entry) => ({
				planId: entry.planId,
				workUnitId: entry.workUnitId,
				digest: digest(entry),
			}))
			.sort(compareQualified),
		conversionDigests: sortedByPlan(sources.conversions).map((entry) => ({
			planId: entry.planId,
			digest: digest(entry.bundle),
		})),
		plans,
		groupIntegration: structuredClone(sources.groupIntegrationResult),
		outcome: error
			? "error"
			: sources.groupIntegrationResult.verdict === "pass" && failedPlanIds.length === 0
				? "pass"
				: "blocked",
		failedPlanIds,
	};
}

export function assertMergeGroupIntegrityV1(
	sources: MergeGroupIntegritySourcesV1,
	resultValue: unknown,
): void {
	try {
		validateSources(sources);
		const result = object(resultValue, "merge-group result");
		if (!equal(result, deriveResult(sources))) {
			throw new MergeGroupIntegrityError("merge-group result is not independently derived");
		}
	} catch (error) {
		if (error instanceof MergeGroupIntegrityError) throw error;
		throw new MergeGroupIntegrityError(
			error instanceof Error ? error.message : "merge-group integrity verification failed",
		);
	}
}
