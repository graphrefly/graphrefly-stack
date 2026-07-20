import { canonicalize, MERGE_GROUP_RESULT_SCHEMA, sha256Jcs } from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function digest(value: unknown): { algorithm: "sha256"; value: string } {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function byPlanId<T extends JsonObject>(values: readonly T[]): T[] {
	return [...values].sort((left, right) =>
		String(left.planId) < String(right.planId)
			? -1
			: String(left.planId) > String(right.planId)
				? 1
				: 0,
	);
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

export interface MergeGroupResultSourcesV1 {
	invocation: JsonObject;
	topology: JsonObject;
	qualifiedCommits: JsonObject[];
	conversions: Array<{ planId: string; bundle: JsonObject }>;
	plans: Array<{
		planId: string;
		plan: JsonObject;
		policy: JsonObject;
		gateBundle: JsonObject;
	}>;
	groupIntegrationInput: JsonObject;
	groupIntegrationResult: JsonObject;
}

export function computeMergeGroupResultV1(sources: MergeGroupResultSourcesV1): JsonObject {
	const plans = byPlanId(sources.plans);
	const planResults = plans.map((entry) => {
		const gateResult = object(entry.gateBundle.gateResult, `${entry.planId} GateResult`);
		return {
			planId: entry.planId,
			planDigest: digest(entry.plan),
			policyDigest: digest(entry.policy),
			gateBundleDigest: digest(entry.gateBundle),
			gateResult: structuredClone(gateResult),
		};
	});
	const failedPlanIds = planResults
		.filter((entry) => entry.gateResult.verdict !== "pass")
		.map((entry) => entry.planId);
	const groupVerdict = sources.groupIntegrationResult.verdict;
	const hasError =
		groupVerdict === "error" || planResults.some((entry) => entry.gateResult.verdict === "error");
	const outcome = hasError
		? "error"
		: groupVerdict === "pass" && failedPlanIds.length === 0
			? "pass"
			: "blocked";
	const qualifiedCommitDigests = [...sources.qualifiedCommits]
		.map((entry) => ({
			planId: String(entry.planId),
			workUnitId: String(entry.workUnitId),
			digest: digest(entry),
		}))
		.sort((left, right) => {
			const leftKey = `${left.planId}\u0000${left.workUnitId}`;
			const rightKey = `${right.planId}\u0000${right.workUnitId}`;
			return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
		});
	const conversionDigests = byPlanId(sources.conversions).map((entry) => ({
		planId: entry.planId,
		digest: digest(entry.bundle),
	}));
	const result = {
		schema: MERGE_GROUP_RESULT_SCHEMA,
		invocationDigest: digest(sources.invocation),
		topologyDigest: digest(sources.topology),
		qualifiedCommitDigests,
		conversionDigests,
		plans: planResults,
		groupIntegration: structuredClone(sources.groupIntegrationResult),
		outcome,
		failedPlanIds,
	};
	if (
		!equal(
			sources.groupIntegrationInput.plans,
			planResults.map((entry) => ({
				planId: entry.planId,
				planDigest: entry.planDigest,
				policyDigest: entry.policyDigest,
				gateResultDigest: digest(entry.gateResult),
				verdict: entry.gateResult.verdict,
			})),
		)
	) {
		throw new TypeError("group integration Plan summaries do not match merge-group Plans");
	}
	return result;
}
