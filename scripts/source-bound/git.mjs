import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
export const root = resolve(import.meta.dirname, "../..");
export const consumerRoot = resolve(root, "examples/refresh-session-source-bound");
export const retainedRoot = resolve(root, ".private/source-bound-consumer");
export const retainedFiles = [
	"package.json",
	"package-lock.json",
	"src/refresh-session.ts",
	"tests/business-verifier.mjs",
	"tests/business.test.mjs",
	"README.md",
];
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function git(repository, args, input) {
	const output = execFileSync(
		"/usr/bin/git",
		["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
		{
			cwd: repository,
			input,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				PATH: "/usr/bin:/bin",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_AUTHOR_NAME: "Source Bound Trial",
				GIT_AUTHOR_EMAIL: "source-bound@example.invalid",
				GIT_COMMITTER_NAME: "Source Bound Trial",
				GIT_COMMITTER_EMAIL: "source-bound@example.invalid",
				GIT_AUTHOR_DATE: "2026-09-06T00:00:00Z",
				GIT_COMMITTER_DATE: "2026-09-06T00:00:00Z",
			},
		},
	);
	return new TextDecoder("utf-8", { fatal: true }).decode(output);
}
export function fullCommit(repository, commit) {
	if (
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ||
		git(repository, ["rev-parse", "--verify", `${commit}^{commit}`]).trim() !== commit
	)
		throw new Error("SOURCE_COMMIT_REQUIRED");
	return commit;
}
export function safePath(path) {
	if (
		!path ||
		path.length > 500 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..") ||
		Array.from(path).some((character) => character.charCodeAt(0) < 32 || character === ":")
	)
		throw new Error("SOURCE_PATH");
	return path;
}
export function coordinate(repository, commit, overlay = null) {
	fullCommit(repository, commit);
	const roots = git(repository, ["rev-list", "--max-parents=0", commit]).trim().split("\n").sort();
	return {
		repository: `git-roots:${sha256Jcs(roots)}`,
		commit,
		overlayDigest: overlay === null ? null : sha256Jcs(overlay),
	};
}
export function readSources(repository, target, overlay = null) {
	if (canonicalize(coordinate(repository, target.commit, overlay)) !== canonicalize(target))
		throw new Error("SOURCE_COORDINATE_MISMATCH");
	const entries = git(repository, ["ls-tree", "-r", "-z", target.commit])
		.split("\0")
		.filter(Boolean);
	if (entries.length > 128) throw new Error("SOURCE_TREE_LIMIT");
	const files = {};
	for (const entry of entries) {
		const delimiter = entry.indexOf("\t");
		const metadata = entry.slice(0, delimiter);
		const path = entry.slice(delimiter + 1);
		safePath(path);
		if (!path.startsWith("src/")) continue;
		if (!metadata.startsWith("100644 blob ")) throw new Error("SOURCE_NON_REGULAR_FILE");
		files[path] = git(repository, ["show", `${target.commit}:${path}`]);
	}
	if (overlay !== null) {
		if (
			!overlay ||
			typeof overlay !== "object" ||
			Array.isArray(overlay) ||
			Object.keys(overlay).length > 64
		)
			throw new Error("SOURCE_OVERLAY");
		for (const [path, content] of Object.entries(overlay)) {
			safePath(path);
			if (!path.startsWith("src/") || (content !== null && typeof content !== "string"))
				throw new Error("SOURCE_OVERLAY");
			if (content === null) delete files[path];
			else files[path] = content;
		}
	}
	if (Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 1024 * 1024)
		throw new Error("SOURCE_BYTES_LIMIT");
	return files;
}
export function setupRetained() {
	if (
		existsSync(resolve(retainedRoot, ".git")) &&
		git(retainedRoot, ["status", "--porcelain", "--untracked-files=no"]).trim()
	)
		throw new Error("SOURCE_SETUP_DIRTY");
	mkdirSync(retainedRoot, { recursive: true });
	if (!existsSync(resolve(retainedRoot, ".git"))) git(retainedRoot, ["init", "-b", "main"]);
	for (const path of retainedFiles) {
		mkdirSync(resolve(retainedRoot, path, ".."), { recursive: true });
		writeFileSync(resolve(retainedRoot, path), readFileSync(resolve(consumerRoot, path)));
	}
	git(retainedRoot, ["add", "--", ...retainedFiles]);
	const changed = git(retainedRoot, ["diff", "--cached", "--name-only"]).trim();
	if (changed) {
		git(retainedRoot, [
			"commit",
			"--no-gpg-sign",
			"-m",
			"Retain exact RefreshSession source and independent verifier",
		]);
		const base = git(retainedRoot, ["rev-parse", "HEAD"]).trim();
		writeFileSync(resolve(retainedRoot, "proof-base.txt"), `${base}\n`);
		git(retainedRoot, ["add", "proof-base.txt"]);
		git(retainedRoot, ["commit", "--no-gpg-sign", "-m", "Record source-bound proof base"]);
	}
	return git(retainedRoot, ["rev-parse", "HEAD"]).trim();
}
export function assertRetainedCurrent(repository = retainedRoot) {
	const head = git(repository, ["rev-parse", "HEAD"]).trim();
	fullCommit(repository, head);
	for (const path of retainedFiles) {
		const committed = git(repository, ["show", `${head}:${path}`]);
		if (
			committed !== readFileSync(resolve(consumerRoot, path), "utf8") ||
			committed !== readFileSync(resolve(repository, path), "utf8")
		)
			throw new Error(`SOURCE_RETAINED_DRIFT: ${path}`);
	}
	if (git(repository, ["status", "--porcelain", "--untracked-files=no"]).trim())
		throw new Error("SOURCE_RETAINED_DIRTY");
	return head;
}
