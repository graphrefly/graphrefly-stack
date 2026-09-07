import { canonicalize } from "../../packages/contracts/dist/jcs.js";
import { assertOwnerHandoffResult } from "../../packages/contracts/src/grounded-handoff.ts";
import { coordinate, fullCommit, git, hashBytes, retainedRoot } from "../source-bound/git.mjs";

export const ownerResultRef = "refs/heads/grounded-handoff-owner-result-v1";
export const ownerResultPath = "evidence/grounded-handoff-owner-result.json";

function render(value) {
	return `${JSON.stringify(JSON.parse(canonicalize(value)), null, "\t")}\n`;
}

export function locateOwnerResult() {
	const commit = fullCommit(
		retainedRoot,
		git(retainedRoot, ["rev-parse", "--verify", ownerResultRef]).trim(),
	);
	const refTarget = git(retainedRoot, ["rev-parse", "--verify", ownerResultRef]).trim();
	if (refTarget !== commit) throw new Error("OWNER_RESULT_REF");
	const changed = git(retainedRoot, [
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		`${commit}^`,
		commit,
	])
		.trim()
		.split("\n")
		.filter(Boolean);
	if (changed.length !== 1 || changed[0] !== ownerResultPath)
		throw new Error("OWNER_RESULT_COMMIT_SCOPE");
	const entry = git(retainedRoot, ["ls-tree", commit, "--", ownerResultPath]).trim();
	const match = /^100644 blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(entry);
	if (match === null || match[2] !== ownerResultPath) throw new Error("OWNER_RESULT_BLOB");
	const bytes = git(retainedRoot, ["show", `${commit}:${ownerResultPath}`]);
	const result = JSON.parse(bytes);
	assertOwnerHandoffResult(result);
	if (bytes !== render(result)) throw new Error("OWNER_RESULT_NON_CANONICAL_BYTES");
	const repository = coordinate(retainedRoot, commit).repository;
	if (result.owner !== repository) throw new Error("OWNER_RESULT_INDEPENDENT_OWNER");
	return {
		result,
		coordinate: {
			repository,
			ref: ownerResultRef,
			commit,
			path: ownerResultPath,
			blob: match[1],
			bytesDigest: hashBytes(bytes),
		},
	};
}
