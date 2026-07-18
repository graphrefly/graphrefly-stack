import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const maxHeadCommits = 64;
const maxGitOutput = 16 * 1024 * 1024;

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
			| "GIT_FAILED",
		message: string,
	) {
		super(message);
		this.name = "IntegrationCandidateError";
	}
}

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runGit(repository: string, args: readonly string[], allowedStatuses = [0]): GitResult {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
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
		);
	}
	const mergeBase = mergeBases[0] as string;
	assertLinearHeadRange(repository, mergeBase, head);

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
			["merge-tree", "--write-tree", `--merge-base=${mergeBase}`, target, head],
			[0, 1],
		);
		if (merge.status === 1) {
			throw new IntegrationCandidateError(
				"TEXT_CONFLICT",
				"The isolated Git three-way candidate has textual conflicts",
			);
		}
		const tree = merge.stdout.trim();
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
		if (resolveCommit(repository, options.target) !== target) {
			throw new IntegrationCandidateError("TARGET_MOVED", "Target moved during integration");
		}
		if (resolveCommit(repository, options.head) !== head) {
			throw new IntegrationCandidateError("HEAD_MOVED", "Head moved during integration");
		}
		return result;
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}
