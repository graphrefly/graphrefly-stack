import {
	type IntegrationReasonCode,
	SEMANTIC_STORAGE,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import { evaluateIntegrationEffects } from "@graphrefly-stack/core";

import {
	assembleIntegrationCandidate,
	assembleIntegrationFailureCandidate,
	evaluateIsolatedGraphCandidate,
	type IntegrationCandidateArtifact,
	IntegrationCandidateError,
	type IntegrationFailureContext,
	type IsolatedGitCandidate,
	withIsolatedGitCandidate,
} from "./integration-candidate.js";
import {
	assembleIntegrationFailureResult,
	assembleIntegrationResult,
	evaluateIntegrationSemantics,
	type IntegrationResultArtifact,
} from "./integration-semantics.js";
import { createRepositoryBlueprintSnapshot, RepositoryReviewError } from "./repository-review.js";
import { createSemanticGate } from "./semantic-repository.js";
import { gitText } from "./system-git.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export interface IntegrationRunOutput {
	candidate: IntegrationCandidateArtifact;
	result: IntegrationResultArtifact;
}

export class IntegrationRunnerError extends Error {
	constructor(
		readonly code: "INTEGRATION_INPUT_INVALID" | "INTEGRATION_CONTEXT_UNAVAILABLE",
		message: string,
	) {
		super(message);
		this.name = "IntegrationRunnerError";
	}
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function oid(value: string): { algorithm: "sha1" | "sha256"; value: string } {
	return { algorithm: value.length === 40 ? "sha1" : "sha256", value };
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new IntegrationRunnerError("INTEGRATION_INPUT_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function graphFailureContext(candidate: IsolatedGitCandidate): IntegrationFailureContext {
	return {
		sourceRepository: candidate.sourceRepository,
		revisions: {
			mergeBase: candidate.mergeBase,
			target: candidate.target,
			head: candidate.head,
		},
		topology: { mergeBase: "unique", headRange: "linear" },
		merge: {
			algorithm: candidate.mergeAlgorithm,
			revision: candidate.mergeRevision,
			status: "merged",
			tree: candidate.tree,
		},
		conflictPaths: [],
	};
}

const evaluationFailureCodes = new Set([
	"ENTRYPOINT_TIMEOUT",
	"ENTRYPOINT_FAILED",
	"BLUEPRINT_DELTA_FAILED",
	"BLUEPRINT_RENDER_FAILED",
]);

function graphFailureReason(error: unknown): IntegrationReasonCode {
	return error instanceof RepositoryReviewError && evaluationFailureCodes.has(error.code)
		? "CANDIDATE_EVALUATION_FAILED"
		: "CANDIDATE_BLUEPRINT_INVALID";
}

function candidatePolicyDigest(candidate: IsolatedGitCandidate): Hash {
	try {
		const value = JSON.parse(
			gitText(candidate.isolatedRepository, [
				"show",
				`${candidate.tree.value}:${SEMANTIC_STORAGE.policy}`,
			]),
		);
		return hash(object(value, "candidate policy"));
	} catch {
		return hash({ invalidCandidatePolicy: true });
	}
}

async function failureOutput(options: {
	context: IntegrationFailureContext;
	reasonCode: IntegrationReasonCode;
	repository: IntegrationCandidateArtifact["repository"];
	runtimeVersion: string;
	planDigest: Hash;
	policyDigest: Hash;
	headGate: IntegrationCandidateArtifact["headGate"];
}): Promise<IntegrationRunOutput> {
	const candidate = await assembleIntegrationFailureCandidate({
		context: options.context,
		repository: options.repository,
		runtimeVersion: options.runtimeVersion,
		planDigest: options.planDigest,
		policyDigest: options.policyDigest,
		headGate: options.headGate,
		reasonCode: options.reasonCode,
	});
	const witnesses =
		options.reasonCode === "TEXT_CONFLICT" && options.context.conflictPaths.length > 0
			? options.context.conflictPaths.map((path) => ({ kind: "path" as const, path }))
			: undefined;
	const result = await assembleIntegrationFailureResult({
		candidate,
		reasonCode: options.reasonCode,
		...(options.context.observedRevisions === undefined
			? {}
			: { observedRevisions: options.context.observedRevisions }),
		...(witnesses === undefined ? {} : { witnesses }),
	});
	return { candidate, result };
}

const candidateErrorReasons = new Map<IntegrationCandidateError["code"], IntegrationReasonCode>([
	["ANCESTRY_AMBIGUOUS", "ANCESTRY_AMBIGUOUS"],
	["HEAD_RANGE_NON_LINEAR", "HEAD_RANGE_NON_LINEAR"],
	["TEXT_CONFLICT", "TEXT_CONFLICT"],
	["TARGET_MOVED", "TARGET_MOVED"],
	["HEAD_MOVED", "HEAD_MOVED"],
]);

export async function runIntegration(options: {
	repository: string;
	target: string;
	head: string;
	planId: string;
	repositoryIdentity: IntegrationCandidateArtifact["repository"];
}): Promise<IntegrationRunOutput> {
	const gate = await createSemanticGate({
		repository: options.repository,
		planId: options.planId,
		head: options.head,
	});
	const plan = object(gate.input.plan, "accepted plan");
	const policy = object(gate.input.policy, "accepted policy");
	const planDigest = hash(plan);
	const policyDigest = hash(policy);
	const headGate = {
		inputDigest: hash(gate.input),
		resultDigest: hash(gate.gateResult),
		verdict: gate.gateResult.verdict as "pass" | "blocked" | "error",
	};
	const targetSnapshot = await createRepositoryBlueprintSnapshot({
		repository: gate.repository,
		revision: options.target,
		requireEntrypointAtRevision: true,
	});
	try {
		const output = await withIsolatedGitCandidate(
			{ repository: gate.repository, target: options.target, head: gate.head.value },
			async (gitCandidate) => {
				let graph: Awaited<ReturnType<typeof evaluateIsolatedGraphCandidate>>;
				try {
					graph = await evaluateIsolatedGraphCandidate(gitCandidate);
				} catch (error) {
					return failureOutput({
						context: graphFailureContext(gitCandidate),
						reasonCode: graphFailureReason(error),
						repository: options.repositoryIdentity,
						runtimeVersion: targetSnapshot.graphreflyVersion,
						planDigest,
						policyDigest,
						headGate,
					});
				}
				const candidate = await assembleIntegrationCandidate({
					git: gitCandidate,
					graph,
					repository: options.repositoryIdentity,
					planDigest,
					policyDigest,
					headGate,
				});
				const effects = evaluateIntegrationEffects({
					targetDelta: graph.targetDelta.delta,
					headDelta: graph.headDelta.delta,
					candidateDelta: graph.candidateDelta.delta,
				});
				const semantic = evaluateIntegrationSemantics({
					plan,
					candidateBlueprint: graph.candidate.blueprint,
					acceptedPolicyDigest: policyDigest,
					candidatePolicyDigest: candidatePolicyDigest(gitCandidate),
					headGateInput: gate.input,
					headGateResult: gate.gateResult,
				});
				return {
					candidate,
					result: await assembleIntegrationResult({ candidate, graph: effects, semantic }),
				};
			},
		);
		const observedHead = gitText(gate.repository, [
			"rev-parse",
			"--verify",
			`${options.head}^{commit}`,
		]);
		if (observedHead !== gate.head.value) {
			return failureOutput({
				context: {
					sourceRepository: gate.repository,
					revisions: output.candidate.revisions,
					topology: output.candidate.topology,
					merge: output.candidate.merge,
					conflictPaths: [],
					observedRevisions: {
						target: output.result.observedRevisions.target,
						head: oid(observedHead),
					},
				},
				reasonCode: "HEAD_MOVED",
				repository: options.repositoryIdentity,
				runtimeVersion: targetSnapshot.graphreflyVersion,
				planDigest,
				policyDigest,
				headGate,
			});
		}
		return output;
	} catch (error) {
		if (error instanceof IntegrationCandidateError) {
			const reasonCode = candidateErrorReasons.get(error.code);
			if (reasonCode !== undefined && error.context !== undefined) {
				return failureOutput({
					context: error.context,
					reasonCode,
					repository: options.repositoryIdentity,
					runtimeVersion: targetSnapshot.graphreflyVersion,
					planDigest,
					policyDigest,
					headGate,
				});
			}
		}
		throw new IntegrationRunnerError(
			"INTEGRATION_CONTEXT_UNAVAILABLE",
			error instanceof Error ? error.message : String(error),
		);
	}
}
