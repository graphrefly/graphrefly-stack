import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { gitText } from "./system-git.js";

export interface DerivedFixtureBlueprint {
	policyRevision: string;
	topology: Record<string, unknown>;
	provenance: {
		revision: string;
		entrypoint: "graphrefly-fixture.mjs";
		isolation: "detached-worktree-node-permission-read-only";
		timeoutMs: 5000;
	};
}

export interface FixtureCheckResult {
	schema: "urn:graphrefly-stack:schema:check-result:v1";
	checkId: string;
	command: string[];
	exitCode: number;
	stdoutDigest: { algorithm: "sha256"; value: string };
	stderrDigest: { algorithm: "sha256"; value: string };
}

function digest(value: string) {
	return { algorithm: "sha256" as const, value: createHash("sha256").update(value).digest("hex") };
}

function scrubbedEnvironment(worktree: string): NodeJS.ProcessEnv {
	return {
		HOME: worktree,
		LANG: "C",
		LC_ALL: "C",
		PATH: process.env.PATH,
		TZ: "UTC",
	};
}

export async function deriveFixtureBlueprint(
	repository: string,
	revision: string,
): Promise<DerivedFixtureBlueprint> {
	const worktreeRoot = resolve(
		dirname(repository),
		`.graphrefly-stack-worktrees-${basename(repository)}`,
	);
	const worktree = resolve(worktreeRoot, revision.replace(/[^a-zA-Z0-9_.-]/g, "_"));
	await mkdir(worktreeRoot, { recursive: true });
	await rm(worktree, { recursive: true, force: true });
	gitText(repository, ["worktree", "add", "--detach", "--force", worktree, revision]);
	try {
		const canonicalWorktree = await realpath(worktree);
		const entrypoint = resolve(canonicalWorktree, "graphrefly-fixture.mjs");
		const result = spawnSync(
			process.execPath,
			[
				"--permission",
				`--allow-fs-read=${canonicalWorktree}`,
				"--disable-warning=ExperimentalWarning",
				entrypoint,
			],
			{
				cwd: canonicalWorktree,
				encoding: "utf8",
				env: scrubbedEnvironment(canonicalWorktree),
				maxBuffer: 1024 * 1024,
				shell: false,
				timeout: 5_000,
			},
		);
		if (result.error !== undefined) throw result.error;
		if (result.status !== 0) {
			throw new Error(
				result.stderr.trim() || `GraphReFly fixture provider exited ${result.status}`,
			);
		}
		const parsed = JSON.parse(result.stdout) as Omit<DerivedFixtureBlueprint, "provenance">;
		if (
			typeof parsed.policyRevision !== "string" ||
			typeof parsed.topology !== "object" ||
			parsed.topology === null
		) {
			throw new Error("GraphReFly fixture provider returned an invalid payload");
		}
		return {
			...parsed,
			provenance: {
				revision,
				entrypoint: "graphrefly-fixture.mjs",
				isolation: "detached-worktree-node-permission-read-only",
				timeoutMs: 5000,
			},
		};
	} finally {
		gitText(repository, ["worktree", "remove", "--force", worktree]);
		await rm(worktree, { recursive: true, force: true });
	}
}

export async function runFixtureChecks(
	repository: string,
	revision: string,
	checkIds: readonly string[],
): Promise<FixtureCheckResult[]> {
	const worktreeRoot = resolve(
		dirname(repository),
		`.graphrefly-stack-worktrees-${basename(repository)}`,
	);
	const worktree = resolve(worktreeRoot, `${revision.replace(/[^a-zA-Z0-9_.-]/g, "_")}-checks`);
	await mkdir(worktreeRoot, { recursive: true });
	await rm(worktree, { recursive: true, force: true });
	gitText(repository, ["worktree", "add", "--detach", "--force", worktree, revision]);
	try {
		const canonicalWorktree = await realpath(worktree);
		const entrypoint = resolve(canonicalWorktree, "fixture-check.mjs");
		const checks = checkIds.map((checkId): FixtureCheckResult => {
			const result = spawnSync(
				process.execPath,
				[
					"--permission",
					`--allow-fs-read=${canonicalWorktree}`,
					"--disable-warning=ExperimentalWarning",
					entrypoint,
					checkId,
				],
				{
					cwd: canonicalWorktree,
					encoding: "utf8",
					env: scrubbedEnvironment(canonicalWorktree),
					maxBuffer: 1024 * 1024,
					shell: false,
					timeout: 5_000,
				},
			);
			if (result.error !== undefined) throw result.error;
			return {
				schema: "urn:graphrefly-stack:schema:check-result:v1",
				checkId,
				command: ["node", "fixture-check.mjs", checkId],
				exitCode: result.status ?? 1,
				stdoutDigest: digest(result.stdout),
				stderrDigest: digest(result.stderr),
			};
		});
		const failed = checks.find((check) => check.exitCode !== 0);
		if (failed !== undefined) throw new Error(`Fixture check failed: ${failed.checkId}`);
		return checks;
	} finally {
		gitText(repository, ["worktree", "remove", "--force", worktree]);
		await rm(worktree, { recursive: true, force: true });
	}
}
