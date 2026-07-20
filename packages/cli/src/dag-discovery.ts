import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { assertPlanQualifiedCommitIntegrity, DAG_LIMITS } from "@graphrefly-stack/contracts";

type GitOid = { algorithm: "sha1" | "sha256"; value: string };

export type DiscoveredDagObject = {
	oid: GitOid;
	parents: GitOid[];
	layer: number;
	kind: "implementation" | "transport" | "join";
	workUnitId: string | null;
};

export type DiscoveredJoin = {
	oid: GitOid;
	parents: [GitOid, GitOid];
	layer: number;
	mergeBase: GitOid;
	merge: {
		algorithm: "git-ort-three-way";
		revision: "v1";
		candidateTree: GitOid;
		observedTree: GitOid;
	};
};

export type DiscoveredGitDag = {
	repository: string;
	base: GitOid;
	head: GitOid;
	objects: DiscoveredDagObject[];
	joins: DiscoveredJoin[];
};

export type DiscoveredPlanQualifiedGitDag = DiscoveredGitDag & {
	qualifiedCommits: Array<{
		schema: "graphrefly.stack.plan-qualified-commit.v1";
		planId: string;
		workUnitId: string;
		commit: GitOid;
		ownership: {
			kind: "native";
			planTrailer: { name: "GraphReFly-Plan"; value: string; occurrences: 1 };
			workUnitTrailer: {
				name: "GraphReFly-Work-Unit";
				value: string;
				occurrences: 1;
			};
		};
	}>;
};

export class DagDiscoveryError extends Error {
	constructor(
		readonly code:
			| "REPOSITORY_INVALID"
			| "REVISION_INVALID"
			| "BASE_NOT_ANCESTOR"
			| "RANGE_TOO_LARGE"
			| "WIDTH_TOO_LARGE"
			| "PARENT_UNSUPPORTED"
			| "SLICE_NOT_CLOSED"
			| "WORK_UNIT_TRAILER_INVALID"
			| "WORK_UNIT_TRAILER_DUPLICATE"
			| "WORK_UNIT_BINDING_AMBIGUOUS"
			| "PLAN_TRAILER_INVALID"
			| "PLAN_TRAILER_DUPLICATE"
			| "PLAN_OWNERSHIP_INVALID"
			| "PLAN_WORK_UNIT_BINDING_AMBIGUOUS"
			| "MERGE_WORK_UNIT_TRAILER"
			| "ANCESTRY_AMBIGUOUS"
			| "JOIN_NOT_CLEAN"
			| "JOIN_TREE_MISMATCH"
			| "REVISION_MOVED"
			| "GIT_FAILED",
		message: string,
	) {
		super(message);
		this.name = "DagDiscoveryError";
	}
}

function git(
	repository: string,
	args: readonly string[],
	allowedStatuses: readonly number[] = [0],
	input?: string,
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		input,
		maxBuffer: 16 * 1024 * 1024,
		shell: false,
	});
	if (result.error !== undefined) throw new DagDiscoveryError("GIT_FAILED", "Git is unavailable");
	const status = result.status ?? 1;
	if (!allowedStatuses.includes(status)) {
		throw new DagDiscoveryError(
			"GIT_FAILED",
			(result.stderr ?? "").trim() || `git ${args[0]} failed`,
		);
	}
	return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function text(repository: string, args: readonly string[]): string {
	return git(repository, args).stdout.trim();
}

function oid(value: string): GitOid {
	return { algorithm: value.length === 40 ? "sha1" : "sha256", value };
}

function trailerValues(repository: string, revision: string, name: string): string[] {
	const message = text(repository, ["show", "-s", "--format=%B", revision]);
	const parsed = git(repository, ["interpret-trailers", "--parse"], [0], message);
	return parsed.stdout.split("\n").flatMap((line) => {
		const separator = line.indexOf(":");
		return separator !== -1 && line.slice(0, separator) === name
			? [line.slice(separator + 1).trim()]
			: [];
	});
}

function workUnitTrailers(repository: string, revision: string): string[] {
	return trailerValues(repository, revision, "GraphReFly-Work-Unit");
}

function planTrailers(repository: string, revision: string): string[] {
	return trailerValues(repository, revision, "GraphReFly-Plan");
}

async function discoverGitDagInternal(options: {
	repository: string;
	base: string;
	head: string;
	allowAmbiguousWorkUnits: boolean;
}): Promise<DiscoveredGitDag> {
	let repository: string;
	try {
		repository = await realpath(
			text(await realpath(resolve(options.repository)), ["rev-parse", "--show-toplevel"]),
		);
	} catch {
		throw new DagDiscoveryError(
			"REPOSITORY_INVALID",
			"DAG discovery requires a local Git worktree",
		);
	}
	let baseValue: string;
	let headValue: string;
	try {
		baseValue = text(repository, ["rev-parse", "--verify", `${options.base}^{commit}`]);
		headValue = text(repository, ["rev-parse", "--verify", `${options.head}^{commit}`]);
	} catch {
		throw new DagDiscoveryError("REVISION_INVALID", "Base and head must resolve to commits");
	}
	if (
		baseValue === headValue ||
		git(repository, ["merge-base", "--is-ancestor", baseValue, headValue], [0, 1]).status !== 0
	) {
		throw new DagDiscoveryError("BASE_NOT_ANCESTOR", "Base must be a strict ancestor of head");
	}

	const lines = text(repository, ["rev-list", "--parents", `${baseValue}..${headValue}`])
		.split("\n")
		.filter(Boolean);
	if (lines.length === 0 || lines.length > DAG_LIMITS.maxObjects) {
		throw new DagDiscoveryError(
			"RANGE_TOO_LARGE",
			"DAG range must contain between 1 and 64 objects",
		);
	}
	const raw = new Map(
		lines.map((line) => {
			const [revision, ...parents] = line.split(" ");
			return [revision as string, parents];
		}),
	);
	for (const [revision, parents] of raw) {
		if (parents.length < 1 || parents.length > DAG_LIMITS.maxParents) {
			throw new DagDiscoveryError(
				"PARENT_UNSUPPORTED",
				`${revision} has ${parents.length} parents`,
			);
		}
		if (parents.some((parent) => parent !== baseValue && !raw.has(parent))) {
			throw new DagDiscoveryError("SLICE_NOT_CLOSED", `${revision} has a parent outside the slice`);
		}
	}
	const layers = new Map<string, number>();
	const layerOf = (revision: string): number => {
		if (revision === baseValue) return 0;
		const cached = layers.get(revision);
		if (cached !== undefined) return cached;
		const parents = raw.get(revision);
		if (parents === undefined) throw new DagDiscoveryError("SLICE_NOT_CLOSED", revision);
		const layer = Math.max(...parents.map(layerOf)) + 1;
		layers.set(revision, layer);
		return layer;
	};
	const ancestryMemo = new Map<string, boolean>();
	const isAncestor = (ancestor: string, descendant: string): boolean => {
		if (ancestor === descendant) return true;
		if (descendant === baseValue) return ancestor === baseValue;
		const key = `${ancestor}>${descendant}`;
		const cached = ancestryMemo.get(key);
		if (cached !== undefined) return cached;
		const result = raw.get(descendant)?.some((parent) => isAncestor(ancestor, parent)) === true;
		ancestryMemo.set(key, result);
		return result;
	};
	const revisions = [...raw.keys()];
	const matching = new Map<string, string>();
	const augment = (left: string, visited: Set<string>): boolean => {
		for (const right of revisions) {
			if (left === right || !isAncestor(left, right) || visited.has(right)) continue;
			visited.add(right);
			const previous = matching.get(right);
			if (previous === undefined || augment(previous, visited)) {
				matching.set(right, left);
				return true;
			}
		}
		return false;
	};
	let matchingSize = 0;
	for (const revision of revisions) {
		if (augment(revision, new Set())) matchingSize += 1;
	}
	if (revisions.length - matchingSize > DAG_LIMITS.maxWidth) {
		throw new DagDiscoveryError("WIDTH_TOO_LARGE", "DAG topological width exceeds eight");
	}

	const joins: DiscoveredJoin[] = [];
	const objects: DiscoveredDagObject[] = [];
	const boundWorkUnits = new Set<string>();
	for (const [revision, parents] of raw) {
		const trailers = workUnitTrailers(repository, revision);
		if (trailers.length > 1) {
			throw new DagDiscoveryError("WORK_UNIT_TRAILER_DUPLICATE", revision);
		}
		if (trailers[0] !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(trailers[0])) {
			throw new DagDiscoveryError("WORK_UNIT_TRAILER_INVALID", revision);
		}
		const layer = layerOf(revision);
		if (parents.length === 1) {
			if (
				trailers[0] !== undefined &&
				boundWorkUnits.has(trailers[0]) &&
				options.allowAmbiguousWorkUnits !== true
			) {
				throw new DagDiscoveryError("WORK_UNIT_BINDING_AMBIGUOUS", trailers[0]);
			}
			if (trailers[0] !== undefined) boundWorkUnits.add(trailers[0]);
			objects.push({
				oid: oid(revision),
				parents: parents.map(oid),
				layer,
				kind: trailers.length === 1 ? "implementation" : "transport",
				workUnitId: trailers[0] ?? null,
			});
			continue;
		}
		if (trailers.length !== 0) throw new DagDiscoveryError("MERGE_WORK_UNIT_TRAILER", revision);
		const mergeBases = git(
			repository,
			["merge-base", "--all", parents[0] as string, parents[1] as string],
			[0, 1],
		)
			.stdout.trim()
			.split("\n")
			.filter(Boolean);
		if (mergeBases.length !== 1) {
			throw new DagDiscoveryError("ANCESTRY_AMBIGUOUS", revision);
		}
		const merge = git(
			repository,
			[
				"merge-tree",
				"--write-tree",
				"--name-only",
				"-z",
				"--no-messages",
				`--merge-base=${mergeBases[0] as string}`,
				parents[0] as string,
				parents[1] as string,
			],
			[0, 1],
		);
		if (merge.status !== 0) throw new DagDiscoveryError("JOIN_NOT_CLEAN", revision);
		const candidateTree = merge.stdout.split("\0").find(Boolean) ?? "";
		const observedTree = text(repository, ["show", "-s", "--format=%T", revision]);
		if (candidateTree !== observedTree) {
			throw new DagDiscoveryError("JOIN_TREE_MISMATCH", revision);
		}
		const parentOids = parents.map(oid) as [GitOid, GitOid];
		objects.push({
			oid: oid(revision),
			parents: parentOids,
			layer,
			kind: "join",
			workUnitId: null,
		});
		joins.push({
			oid: oid(revision),
			parents: parentOids,
			layer,
			mergeBase: oid(mergeBases[0] as string),
			merge: {
				algorithm: "git-ort-three-way",
				revision: "v1",
				candidateTree: oid(candidateTree),
				observedTree: oid(observedTree),
			},
		});
	}
	objects.sort(
		(left, right) => left.layer - right.layer || left.oid.value.localeCompare(right.oid.value),
	);
	joins.sort(
		(left, right) => left.layer - right.layer || left.oid.value.localeCompare(right.oid.value),
	);

	const observedBase = text(repository, ["rev-parse", "--verify", `${options.base}^{commit}`]);
	const observedHead = text(repository, ["rev-parse", "--verify", `${options.head}^{commit}`]);
	if (observedBase !== baseValue || observedHead !== headValue) {
		throw new DagDiscoveryError("REVISION_MOVED", "Base or head moved during DAG discovery");
	}
	return { repository, base: oid(baseValue), head: oid(headValue), objects, joins };
}

export function discoverGitDag(options: {
	repository: string;
	base: string;
	head: string;
}): Promise<DiscoveredGitDag> {
	return discoverGitDagInternal({ ...options, allowAmbiguousWorkUnits: false });
}

export function discoverGitDagForSemanticGate(options: {
	repository: string;
	base: string;
	head: string;
}): Promise<DiscoveredGitDag> {
	return discoverGitDagInternal({ ...options, allowAmbiguousWorkUnits: true });
}

export async function discoverPlanQualifiedGitDag(options: {
	repository: string;
	base: string;
	head: string;
}): Promise<DiscoveredPlanQualifiedGitDag> {
	const discovered = await discoverGitDagInternal({
		...options,
		allowAmbiguousWorkUnits: true,
	});
	const qualifiedCommits: DiscoveredPlanQualifiedGitDag["qualifiedCommits"] = [];
	const identities = new Set<string>();
	for (const entry of discovered.objects) {
		const plans = planTrailers(discovered.repository, entry.oid.value);
		if (plans.length > 1) {
			throw new DagDiscoveryError("PLAN_TRAILER_DUPLICATE", entry.oid.value);
		}
		if (plans[0] !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(plans[0])) {
			throw new DagDiscoveryError("PLAN_TRAILER_INVALID", entry.oid.value);
		}
		if (entry.kind !== "implementation") {
			if (plans.length !== 0) {
				throw new DagDiscoveryError(
					"PLAN_OWNERSHIP_INVALID",
					`${entry.oid.value} is not an implementation commit`,
				);
			}
			continue;
		}
		if (plans.length !== 1 || entry.workUnitId === null) {
			throw new DagDiscoveryError(
				"PLAN_OWNERSHIP_INVALID",
				`${entry.oid.value} requires one Plan and one WorkUnit trailer`,
			);
		}
		const planId = plans[0] as string;
		const identity = `${planId}\u0000${entry.workUnitId}`;
		if (identities.has(identity)) {
			throw new DagDiscoveryError("PLAN_WORK_UNIT_BINDING_AMBIGUOUS", identity);
		}
		identities.add(identity);
		const qualified = {
			schema: "graphrefly.stack.plan-qualified-commit.v1" as const,
			planId,
			workUnitId: entry.workUnitId,
			commit: entry.oid,
			ownership: {
				kind: "native" as const,
				planTrailer: { name: "GraphReFly-Plan" as const, value: planId, occurrences: 1 as const },
				workUnitTrailer: {
					name: "GraphReFly-Work-Unit" as const,
					value: entry.workUnitId,
					occurrences: 1 as const,
				},
			},
		};
		assertPlanQualifiedCommitIntegrity(qualified);
		qualifiedCommits.push(qualified);
	}
	qualifiedCommits.sort(
		(left, right) =>
			left.planId.localeCompare(right.planId) ||
			left.workUnitId.localeCompare(right.workUnitId) ||
			left.commit.value.localeCompare(right.commit.value),
	);
	return { ...discovered, qualifiedCommits };
}
