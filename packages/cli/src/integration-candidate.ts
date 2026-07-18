import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createStrictAjv,
	INTEGRATION_ARTIFACTS_SCHEMA,
	INTEGRATION_CANDIDATE_SCHEMA,
	INTEGRATION_CONFLICT_REASONS,
	type IntegrationReasonCode,
} from "@graphrefly-stack/contracts";

import {
	createRepositoryBlueprintSnapshot,
	diffRepositoryBlueprintSnapshots,
} from "./repository-review.js";
import { runtimeAssetPath } from "./runtime-paths.js";

const maxHeadCommits = 64;
const maxGitOutput = 16 * 1024 * 1024;
const integrationSchemaPath = runtimeAssetPath("contracts/integration/v1/artifacts.schema.json");

type Hash = { algorithm: "sha256"; value: string };

export class IntegrationCandidateError extends Error {
	constructor(
		readonly code:
			| "REPOSITORY_INVALID"
			| "REVISION_INVALID"
			| "ANCESTRY_AMBIGUOUS"
			| "HEAD_RANGE_NON_LINEAR"
			| "TEXT_CONFLICT"
			| "TARGET_MOVED"
			| "HEAD_MOVED"
			| "CONTRACT_INVALID"
			| "GIT_FAILED",
		message: string,
		readonly context?: IntegrationFailureContext,
	) {
		super(message);
		this.name = "IntegrationCandidateError";
	}
}

export interface IntegrationFailureContext {
	sourceRepository: string;
	revisions: {
		mergeBase: { algorithm: "sha1" | "sha256"; value: string } | null;
		target: { algorithm: "sha1" | "sha256"; value: string };
		head: { algorithm: "sha1" | "sha256"; value: string };
	};
	topology: {
		mergeBase: "unique" | "ambiguous" | "missing";
		headRange: "linear" | "non-linear" | "unavailable";
	};
	merge: {
		algorithm: "git-ort-three-way";
		revision: "v1";
		status: "merged" | "conflict" | "unavailable";
		tree: { algorithm: "sha1" | "sha256"; value: string } | null;
	};
	conflictPaths: string[];
	observedRevisions?: {
		target: { algorithm: "sha1" | "sha256"; value: string };
		head: { algorithm: "sha1" | "sha256"; value: string };
	};
}

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runGit(repository: string, args: readonly string[], allowedStatuses = [0]): GitResult {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "GraphReFly Stack",
			GIT_AUTHOR_EMAIL: "stack@example.invalid",
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_NAME: "GraphReFly Stack",
			GIT_COMMITTER_EMAIL: "stack@example.invalid",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		},
		maxBuffer: maxGitOutput,
		shell: false,
	});
	if (result.error !== undefined) {
		throw new IntegrationCandidateError("GIT_FAILED", "Git could not be executed");
	}
	const status = result.status ?? 1;
	if (!allowedStatuses.includes(status)) {
		throw new IntegrationCandidateError(
			"GIT_FAILED",
			(result.stderr ?? "").trim() || `git ${args[0]} failed`,
		);
	}
	return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitText(repository: string, args: readonly string[]): string {
	return runGit(repository, args).stdout.trim();
}

function oid(value: string): { algorithm: "sha1" | "sha256"; value: string } {
	return { algorithm: value.length === 40 ? "sha1" : "sha256", value };
}

function failureContext(options: {
	repository: string;
	target: string;
	head: string;
	mergeBase?: string;
	mergeBaseStatus: "unique" | "ambiguous" | "missing";
	headRange: "linear" | "non-linear" | "unavailable";
	mergeStatus?: "merged" | "conflict" | "unavailable";
	tree?: string;
	conflictPaths?: string[];
	observedTarget?: string;
	observedHead?: string;
}): IntegrationFailureContext {
	return {
		sourceRepository: options.repository,
		revisions: {
			mergeBase: options.mergeBase === undefined ? null : oid(options.mergeBase),
			target: oid(options.target),
			head: oid(options.head),
		},
		topology: { mergeBase: options.mergeBaseStatus, headRange: options.headRange },
		merge: {
			algorithm: "git-ort-three-way",
			revision: "v1",
			status: options.mergeStatus ?? "unavailable",
			tree: options.tree === undefined ? null : oid(options.tree),
		},
		conflictPaths: [...(options.conflictPaths ?? [])].sort(),
		...(options.observedTarget !== undefined && options.observedHead !== undefined
			? {
					observedRevisions: {
						target: oid(options.observedTarget),
						head: oid(options.observedHead),
					},
				}
			: {}),
	};
}

function resolveCommit(repository: string, revision: string): string {
	try {
		return gitText(repository, ["rev-parse", "--verify", `${revision}^{commit}`]);
	} catch {
		throw new IntegrationCandidateError(
			"REVISION_INVALID",
			"Target and head must resolve to commits",
		);
	}
}

function assertLinearHeadRange(repository: string, mergeBase: string, head: string): void {
	const revisions = gitText(repository, [
		"rev-list",
		"--reverse",
		"--first-parent",
		`${mergeBase}..${head}`,
	])
		.split("\n")
		.filter(Boolean);
	const ancestry = gitText(repository, [
		"rev-list",
		"--reverse",
		"--ancestry-path",
		`${mergeBase}..${head}`,
	])
		.split("\n")
		.filter(Boolean);
	if (revisions.length > maxHeadCommits) {
		throw new IntegrationCandidateError(
			"HEAD_RANGE_NON_LINEAR",
			`Pull-request head range exceeds ${maxHeadCommits} commits`,
		);
	}
	if (revisions.length === 0 || revisions.join("\n") !== ancestry.join("\n")) {
		throw new IntegrationCandidateError(
			"HEAD_RANGE_NON_LINEAR",
			"Pull-request head must be one nonempty merge-free chain from the merge base",
		);
	}
	let expectedParent = mergeBase;
	for (const revision of revisions) {
		const parents = gitText(repository, ["rev-list", "--parents", "-n", "1", revision]).split(" ");
		if (parents.length !== 2 || parents[1] !== expectedParent) {
			throw new IntegrationCandidateError(
				"HEAD_RANGE_NON_LINEAR",
				"Pull-request head must be one nonempty merge-free chain from the merge base",
			);
		}
		expectedParent = revision;
	}
}

export interface IsolatedGitCandidate {
	sourceRepository: string;
	isolatedRepository: string;
	mergeBase: { algorithm: "sha1" | "sha256"; value: string };
	target: { algorithm: "sha1" | "sha256"; value: string };
	head: { algorithm: "sha1" | "sha256"; value: string };
	tree: { algorithm: "sha1" | "sha256"; value: string };
	mergeAlgorithm: "git-ort-three-way";
	mergeRevision: "v1";
}

export interface IsolatedGraphEvidence {
	graphreflyVersion: string;
	base: {
		blueprint: Record<string, unknown>;
		blueprintHash: { algorithm: "sha256"; value: string };
	};
	target: {
		blueprint: Record<string, unknown>;
		blueprintHash: { algorithm: "sha256"; value: string };
	};
	head: {
		blueprint: Record<string, unknown>;
		blueprintHash: { algorithm: "sha256"; value: string };
	};
	candidate: {
		blueprint: Record<string, unknown>;
		blueprintHash: { algorithm: "sha256"; value: string };
	};
	targetDelta: {
		delta: Record<string, unknown>;
		digest: { algorithm: "sha256"; value: string };
	};
	headDelta: {
		delta: Record<string, unknown>;
		digest: { algorithm: "sha256"; value: string };
	};
	candidateDelta: {
		delta: Record<string, unknown>;
		digest: { algorithm: "sha256"; value: string };
	};
}

export interface IntegrationCandidateArtifact {
	schema: typeof INTEGRATION_CANDIDATE_SCHEMA;
	repository: { provider: string; owner: string; name: string };
	provider: { kind: "graphrefly"; runtimeVersion: string };
	revisions: {
		mergeBase: IsolatedGitCandidate["mergeBase"] | null;
		target: IsolatedGitCandidate["target"];
		head: IsolatedGitCandidate["head"];
	};
	topology: {
		mergeBase: "unique" | "ambiguous" | "missing";
		headRange: "linear" | "non-linear" | "unavailable";
	};
	merge: {
		algorithm: IsolatedGitCandidate["mergeAlgorithm"];
		revision: IsolatedGitCandidate["mergeRevision"];
		status: "merged" | "conflict" | "unavailable";
		tree: IsolatedGitCandidate["tree"] | null;
	};
	accepted: { planDigest: Hash; policyDigest: Hash };
	evidence: {
		baseBlueprint: { revision: IsolatedGitCandidate["mergeBase"]; blueprintHash: Hash } | null;
		targetBlueprint: { revision: IsolatedGitCandidate["target"]; blueprintHash: Hash } | null;
		headBlueprint: { revision: IsolatedGitCandidate["head"]; blueprintHash: Hash } | null;
		candidateBlueprint: { revision: IsolatedGitCandidate["tree"]; blueprintHash: Hash } | null;
		targetDelta: {
			from: IsolatedGitCandidate["mergeBase"];
			to: IsolatedGitCandidate["target"];
			deltaDigest: Hash;
		} | null;
		headDelta: {
			from: IsolatedGitCandidate["mergeBase"];
			to: IsolatedGitCandidate["head"];
			deltaDigest: Hash;
		} | null;
	};
	headGate: { inputDigest: Hash; resultDigest: Hash; verdict: "pass" | "blocked" | "error" };
	status: "ready" | "conflict" | "error";
}

async function validateIntegrationCandidate(
	candidate: IntegrationCandidateArtifact,
): Promise<IntegrationCandidateArtifact> {
	const schema = JSON.parse(await readFile(integrationSchemaPath, "utf8"));
	const ajv = createStrictAjv();
	ajv.addSchema(schema);
	const validate = ajv.getSchema(
		`${INTEGRATION_ARTIFACTS_SCHEMA}#/definitions/IntegrationCandidate`,
	);
	if (validate === undefined || !validate(candidate)) {
		throw new IntegrationCandidateError(
			"CONTRACT_INVALID",
			`IntegrationCandidate failed validation: ${JSON.stringify(validate?.errors)}`,
		);
	}
	return candidate;
}

export async function assembleIntegrationCandidate(options: {
	git: IsolatedGitCandidate;
	graph: IsolatedGraphEvidence;
	repository: IntegrationCandidateArtifact["repository"];
	planDigest: Hash;
	policyDigest: Hash;
	headGate: IntegrationCandidateArtifact["headGate"];
}): Promise<IntegrationCandidateArtifact> {
	const candidate: IntegrationCandidateArtifact = {
		schema: INTEGRATION_CANDIDATE_SCHEMA,
		repository: options.repository,
		provider: { kind: "graphrefly", runtimeVersion: options.graph.graphreflyVersion },
		revisions: {
			mergeBase: options.git.mergeBase,
			target: options.git.target,
			head: options.git.head,
		},
		topology: { mergeBase: "unique", headRange: "linear" },
		merge: {
			algorithm: options.git.mergeAlgorithm,
			revision: options.git.mergeRevision,
			status: "merged",
			tree: options.git.tree,
		},
		accepted: { planDigest: options.planDigest, policyDigest: options.policyDigest },
		evidence: {
			baseBlueprint: {
				revision: options.git.mergeBase,
				blueprintHash: options.graph.base.blueprintHash,
			},
			targetBlueprint: {
				revision: options.git.target,
				blueprintHash: options.graph.target.blueprintHash,
			},
			headBlueprint: {
				revision: options.git.head,
				blueprintHash: options.graph.head.blueprintHash,
			},
			candidateBlueprint: {
				revision: options.git.tree,
				blueprintHash: options.graph.candidate.blueprintHash,
			},
			targetDelta: {
				from: options.git.mergeBase,
				to: options.git.target,
				deltaDigest: options.graph.targetDelta.digest,
			},
			headDelta: {
				from: options.git.mergeBase,
				to: options.git.head,
				deltaDigest: options.graph.headDelta.digest,
			},
		},
		headGate: options.headGate,
		status: "ready",
	};
	return validateIntegrationCandidate(candidate);
}

export async function assembleIntegrationFailureCandidate(options: {
	context: IntegrationFailureContext;
	repository: IntegrationCandidateArtifact["repository"];
	runtimeVersion: string;
	planDigest: Hash;
	policyDigest: Hash;
	headGate: IntegrationCandidateArtifact["headGate"];
	reasonCode: IntegrationReasonCode;
}): Promise<IntegrationCandidateArtifact> {
	const conflictReasons = new Set<IntegrationReasonCode>(INTEGRATION_CONFLICT_REASONS);
	return validateIntegrationCandidate({
		schema: INTEGRATION_CANDIDATE_SCHEMA,
		repository: options.repository,
		provider: { kind: "graphrefly", runtimeVersion: options.runtimeVersion },
		revisions: options.context.revisions,
		topology: options.context.topology,
		merge: options.context.merge,
		accepted: { planDigest: options.planDigest, policyDigest: options.policyDigest },
		evidence: {
			baseBlueprint: null,
			targetBlueprint: null,
			headBlueprint: null,
			candidateBlueprint: null,
			targetDelta: null,
			headDelta: null,
		},
		headGate: options.headGate,
		status: conflictReasons.has(options.reasonCode) ? "conflict" : "error",
	});
}

export async function evaluateIsolatedGraphCandidate(
	candidate: IsolatedGitCandidate,
): Promise<IsolatedGraphEvidence> {
	runGit(candidate.isolatedRepository, ["checkout", "--detach", "--force", candidate.target.value]);
	const sourceNodeModules = await realpath(join(candidate.sourceRepository, "node_modules"));
	await symlink(sourceNodeModules, join(candidate.isolatedRepository, "node_modules"), "dir");
	const candidateCommit = gitText(candidate.isolatedRepository, [
		"commit-tree",
		candidate.tree.value,
		"-p",
		candidate.target.value,
		"-p",
		candidate.head.value,
		"-m",
		"GraphReFly Stack isolated integration candidate",
	]);
	const snapshots = [];
	for (const revision of [
		candidate.mergeBase.value,
		candidate.target.value,
		candidate.head.value,
		candidateCommit,
	]) {
		snapshots.push(
			await createRepositoryBlueprintSnapshot({
				repository: candidate.isolatedRepository,
				revision,
				requireEntrypointAtRevision: true,
			}),
		);
	}
	const [base, target, head, merged] = snapshots;
	if (base === undefined || target === undefined || head === undefined || merged === undefined) {
		throw new IntegrationCandidateError(
			"GIT_FAILED",
			"Integration Blueprint evidence is incomplete",
		);
	}
	const [targetDelta, headDelta, candidateDelta] = await Promise.all([
		diffRepositoryBlueprintSnapshots({
			repository: candidate.isolatedRepository,
			previous: base.blueprint,
			next: target.blueprint,
		}),
		diffRepositoryBlueprintSnapshots({
			repository: candidate.isolatedRepository,
			previous: base.blueprint,
			next: head.blueprint,
		}),
		diffRepositoryBlueprintSnapshots({
			repository: candidate.isolatedRepository,
			previous: base.blueprint,
			next: merged.blueprint,
		}),
	]);
	return {
		graphreflyVersion: merged.graphreflyVersion,
		base: { blueprint: base.blueprint, blueprintHash: base.blueprintHash },
		target: { blueprint: target.blueprint, blueprintHash: target.blueprintHash },
		head: { blueprint: head.blueprint, blueprintHash: head.blueprintHash },
		candidate: { blueprint: merged.blueprint, blueprintHash: merged.blueprintHash },
		targetDelta,
		headDelta,
		candidateDelta,
	};
}

export async function withIsolatedGitCandidate<T>(
	options: { repository: string; target: string; head: string },
	use: (candidate: IsolatedGitCandidate) => Promise<T>,
): Promise<T> {
	let repository: string;
	try {
		const requested = await realpath(resolve(options.repository));
		repository = await realpath(gitText(requested, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new IntegrationCandidateError(
			"REPOSITORY_INVALID",
			"Integration requires a local Git worktree",
		);
	}
	const target = resolveCommit(repository, options.target);
	const head = resolveCommit(repository, options.head);
	const mergeBases = runGit(repository, ["merge-base", "--all", target, head], [0, 1])
		.stdout.trim()
		.split("\n")
		.filter(Boolean);
	if (mergeBases.length !== 1) {
		throw new IntegrationCandidateError(
			"ANCESTRY_AMBIGUOUS",
			"Integration requires exactly one merge base",
			failureContext({
				repository,
				target,
				head,
				mergeBaseStatus: mergeBases.length === 0 ? "missing" : "ambiguous",
				headRange: "unavailable",
			}),
		);
	}
	const mergeBase = mergeBases[0] as string;
	try {
		assertLinearHeadRange(repository, mergeBase, head);
	} catch (error) {
		if (error instanceof IntegrationCandidateError && error.code === "HEAD_RANGE_NON_LINEAR") {
			throw new IntegrationCandidateError(
				error.code,
				error.message,
				failureContext({
					repository,
					target,
					head,
					mergeBase,
					mergeBaseStatus: "unique",
					headRange: "non-linear",
				}),
			);
		}
		throw error;
	}

	const temporaryRoot = await mkdtemp(join(tmpdir(), "graphrefly-stack-integration-"));
	const isolatedRepository = join(temporaryRoot, "repository");
	try {
		runGit(repository, [
			"clone",
			"--local",
			"--no-hardlinks",
			"--no-checkout",
			"--quiet",
			repository,
			isolatedRepository,
		]);
		const merge = runGit(
			isolatedRepository,
			[
				"merge-tree",
				"--write-tree",
				"--name-only",
				"-z",
				"--no-messages",
				`--merge-base=${mergeBase}`,
				target,
				head,
			],
			[0, 1],
		);
		const [tree = "", ...mergePaths] = merge.stdout.split("\0").filter(Boolean);
		if (merge.status === 1) {
			throw new IntegrationCandidateError(
				"TEXT_CONFLICT",
				"The isolated Git three-way candidate has textual conflicts",
				failureContext({
					repository,
					target,
					head,
					mergeBase,
					mergeBaseStatus: "unique",
					headRange: "linear",
					mergeStatus: "conflict",
					conflictPaths: mergePaths,
				}),
			);
		}
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(tree)) {
			throw new IntegrationCandidateError("GIT_FAILED", "Git did not produce one candidate tree");
		}
		const result = await use({
			sourceRepository: repository,
			isolatedRepository,
			mergeBase: oid(mergeBase),
			target: oid(target),
			head: oid(head),
			tree: oid(tree),
			mergeAlgorithm: "git-ort-three-way",
			mergeRevision: "v1",
		});
		const observedTarget = resolveCommit(repository, options.target);
		const observedHead = resolveCommit(repository, options.head);
		const driftContext = failureContext({
			repository,
			target,
			head,
			mergeBase,
			mergeBaseStatus: "unique",
			headRange: "linear",
			mergeStatus: "merged",
			tree,
			observedTarget,
			observedHead,
		});
		if (observedTarget !== target) {
			throw new IntegrationCandidateError(
				"TARGET_MOVED",
				"Target moved during integration",
				driftContext,
			);
		}
		if (observedHead !== head) {
			throw new IntegrationCandidateError(
				"HEAD_MOVED",
				"Head moved during integration",
				driftContext,
			);
		}
		return result;
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}
