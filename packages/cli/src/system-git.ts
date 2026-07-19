import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { GitAdapter, GitOid } from "@graphrefly-stack/core";

function git(repository: string, args: readonly string[], input?: Uint8Array): Buffer {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: null,
		input,
		maxBuffer: 16 * 1024 * 1024,
		shell: false,
	});
	if (result.status !== 0) {
		throw new Error(
			Buffer.from(result.stderr ?? [])
				.toString("utf8")
				.trim() || `git ${args[0]} failed`,
		);
	}
	return Buffer.from(result.stdout ?? []);
}

export function gitText(repository: string, args: readonly string[]): string {
	return git(repository, args).toString("utf8").trim();
}

export function gitDiffBetween(
	repository: string,
	fromRevision: string,
	toRevision: string,
): Uint8Array {
	return git(repository, ["diff", "--no-ext-diff", "--binary", fromRevision, toRevision]);
}

export class SystemGitAdapter implements GitAdapter {
	async resolveCommit(repository: string, revision: string): Promise<GitOid> {
		const value = gitText(repository, ["rev-parse", "--verify", `${revision}^{commit}`]);
		return { algorithm: value.length === 40 ? "sha1" : "sha256", value };
	}

	async changedPaths(repository: string, commit: GitOid): Promise<readonly string[]> {
		const output = gitText(repository, [
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"-r",
			"--root",
			commit.value,
		]);
		return output === "" ? [] : output.split("\n").sort();
	}

	async canonicalDiff(repository: string, commit: GitOid): Promise<Uint8Array> {
		return git(repository, ["show", "--format=", "--no-ext-diff", "--binary", commit.value]);
	}

	async parent(repository: string, commit: GitOid): Promise<GitOid | null> {
		const parents = gitText(repository, ["show", "-s", "--format=%P", commit.value]);
		const value = parents.split(" ")[0];
		return value ? { algorithm: value.length === 40 ? "sha1" : "sha256", value } : null;
	}

	async stablePatchId(repository: string, commit: GitOid): Promise<string> {
		const diff = await this.canonicalDiff(repository, commit);
		return (
			git(repository, ["patch-id", "--stable"], diff).toString("utf8").trim().split(/\s+/)[0] ?? ""
		);
	}

	async fact(repository: string, revision: string, workUnitId: string) {
		const commit = await this.resolveCommit(repository, revision);
		const diff = await this.canonicalDiff(repository, commit);
		return {
			workUnitId,
			exists: true,
			commit,
			parent: await this.parent(repository, commit),
			stablePatchId: await this.stablePatchId(repository, commit),
			diffDigest: {
				algorithm: "sha256" as const,
				value: createHash("sha256").update(diff).digest("hex"),
			},
			changedPaths: await this.changedPaths(repository, commit),
		};
	}
}
