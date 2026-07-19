import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export type ReviewRoute = "structural-linear" | "semantic-linear" | "semantic-dag";

export type RepositoryIdentity = {
	provider: string;
	owner: string;
	name: string;
};

export class ReviewRoutingError extends Error {
	constructor(
		readonly code:
			| "REPOSITORY_INVALID"
			| "REVISION_INVALID"
			| "BASE_NOT_ANCESTOR"
			| "DAG_REVIEW_PLAN_REQUIRED"
			| "REPOSITORY_IDENTITY_INCOMPLETE"
			| "REPOSITORY_IDENTITY_UNAVAILABLE",
		message: string,
	) {
		super(message);
		this.name = "ReviewRoutingError";
	}
}

function git(
	repository: string,
	args: readonly string[],
	allowedStatuses: readonly number[] = [0],
): { status: number; stdout: string } {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		shell: false,
	});
	const status = result.status ?? 1;
	if (result.error !== undefined || !allowedStatuses.includes(status)) {
		throw new ReviewRoutingError(
			"REVISION_INVALID",
			(result.stderr ?? "").trim() || `git ${args[0]} failed`,
		);
	}
	return { status, stdout: (result.stdout ?? "").trim() };
}

async function repositoryRoot(repository: string): Promise<string> {
	try {
		const requested = await realpath(resolve(repository));
		return await realpath(git(requested, ["rev-parse", "--show-toplevel"]).stdout);
	} catch (error) {
		if (error instanceof ReviewRoutingError && error.code !== "REVISION_INVALID") throw error;
		throw new ReviewRoutingError("REPOSITORY_INVALID", "Review requires a local Git worktree");
	}
}

export async function selectReviewRoute(options: {
	repository: string;
	base: string;
	head: string;
	planId?: string;
}): Promise<{ repository: string; route: ReviewRoute }> {
	const repository = await repositoryRoot(options.repository);
	let base: string;
	let head: string;
	try {
		base = git(repository, ["rev-parse", "--verify", `${options.base}^{commit}`]).stdout;
		head = git(repository, ["rev-parse", "--verify", `${options.head}^{commit}`]).stdout;
	} catch {
		throw new ReviewRoutingError("REVISION_INVALID", "Base and head must resolve to commits");
	}
	const ancestry = git(repository, ["merge-base", "--is-ancestor", base, head], [0, 1]);
	if (ancestry.status !== 0) {
		throw new ReviewRoutingError("BASE_NOT_ANCESTOR", "Base must be an ancestor of head");
	}
	const mergeCount = Number.parseInt(
		git(repository, ["rev-list", "--min-parents=2", "--count", `${base}..${head}`]).stdout,
		10,
	);
	if (!Number.isInteger(mergeCount)) {
		throw new ReviewRoutingError("REVISION_INVALID", "Git topology could not be inspected");
	}
	if (mergeCount > 0) {
		if (options.planId === undefined) {
			throw new ReviewRoutingError(
				"DAG_REVIEW_PLAN_REQUIRED",
				"A semantic plan is required when the selected Git history contains a merge commit",
			);
		}
		return { repository, route: "semantic-dag" };
	}
	return {
		repository,
		route: options.planId === undefined ? "structural-linear" : "semantic-linear",
	};
}

function parseRemoteIdentity(remote: string): RepositoryIdentity | undefined {
	let host: string;
	let path: string;
	const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(remote);
	if (scp !== null && !remote.includes("://")) {
		host = scp[1] ?? "";
		path = scp[2] ?? "";
	} else {
		let url: URL;
		try {
			url = new URL(remote);
		} catch {
			return undefined;
		}
		host = url.hostname;
		path = url.pathname.replace(/^\/+/, "");
	}
	const segments = path
		.replace(/\.git$/u, "")
		.split("/")
		.filter(Boolean);
	if (segments.length < 2) return undefined;
	const name = segments.pop() as string;
	const owner = segments.join("/");
	const normalizedHost = host.toLowerCase();
	const provider =
		normalizedHost === "github.com"
			? "github"
			: normalizedHost === "gitlab.com"
				? "gitlab"
				: normalizedHost === "bitbucket.org"
					? "bitbucket"
					: normalizedHost
							.split(".")[0]
							?.replace(/[^a-z0-9-]/gu, "-")
							.slice(0, 32);
	if (provider === undefined || !/^[a-z][a-z0-9-]{0,31}$/u.test(provider)) return undefined;
	return { provider, owner, name };
}

export async function resolveRepositoryIdentity(options: {
	repository: string;
	provider?: string;
	owner?: string;
	name?: string;
}): Promise<RepositoryIdentity> {
	const explicit = [options.provider, options.owner, options.name];
	if (explicit.some((value) => value !== undefined)) {
		if (explicit.some((value) => value === undefined)) {
			throw new ReviewRoutingError(
				"REPOSITORY_IDENTITY_INCOMPLETE",
				"--provider, --owner, and --name must be supplied together",
			);
		}
		return {
			provider: options.provider as string,
			owner: options.owner as string,
			name: options.name as string,
		};
	}
	const repository = await repositoryRoot(options.repository);
	let remote: string;
	try {
		remote = git(repository, ["remote", "get-url", "origin"]).stdout;
	} catch {
		throw new ReviewRoutingError(
			"REPOSITORY_IDENTITY_UNAVAILABLE",
			"DAG review could not infer repository identity from origin; supply --provider, --owner, and --name",
		);
	}
	const identity = parseRemoteIdentity(remote);
	if (identity === undefined) {
		throw new ReviewRoutingError(
			"REPOSITORY_IDENTITY_UNAVAILABLE",
			"DAG review could not infer repository identity from origin; supply --provider, --owner, and --name",
		);
	}
	return identity;
}
