#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CLI_RESULT_SCHEMA,
	type CliCommand,
	type CliResult,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import { CORE_ARCHITECTURE, computeGate } from "@graphrefly-stack/core";
import { CiRunnerError, initializeCiWorkflow, runCi } from "./ci-runner.js";
import {
	redactProviderError,
	replayFallback,
	runLivePlan,
	runLiveReplan,
} from "./codex-plan-provider.js";
import { exportEvidenceBundle, type LiveRunRecord } from "./exporter.js";
import { createFlagshipFixture, readRuntimeSuite } from "./fixture.js";
import {
	HostedRunnerError,
	initializeHostedWorkflow,
	syncHostedEvidence,
} from "./hosted-runner.js";
import { readPortableEvidenceBundle } from "./portable-bundle.js";
import { initializeRepository, RepositoryInitError } from "./repository-init.js";
import { createRepositoryReview, RepositoryReviewError } from "./repository-review.js";
import { startReviewServer } from "./review-server.js";
import {
	bindSemanticPlan,
	createSemanticGate,
	createSemanticPlan,
	createSemanticRepositoryReview,
	exportSemanticBundle,
	replanSemanticPlan,
	SemanticRepositoryError,
	verifySemanticBundle,
} from "./semantic-repository.js";
import { SystemGitAdapter } from "./system-git.js";

const help = `GraphReFly Stack (grfs)

Usage:
  grfs init [--repo <path>] --graph-module <path> [--graph-export <name>] [--force] [--json]
  grfs ci init [--repo <path>] [--force] [--json]
  grfs ci run [--repo <path>] --event <github-event.json> [--plan-id <id>] --output <artifact.json> [--json]
  grfs hosted init [--repo <path>] --endpoint <https-url> [--profile gate-summary-v1|semantic-review-v1] [--force] [--json]
  grfs hosted sync --artifact <ci-artifact.json> --endpoint <https-url> [--profile gate-summary-v1|semantic-review-v1] --json
  grfs review --repo <path> --base <revision> --head <revision> [--host 127.0.0.1] [--port 4173] [--json]
  grfs fixture create [--output <path>] [--force] [--json]
  grfs plan --repo <path> --task <summary> --policy <policy.json> [--proposal <proposal.json>] [--context <manifest.json> --authorize-context] [--mode replay|live] [--accept --accept-by <label>] --json
  grfs plan --repo <path> --bind --plan-id <id> [--head <revision>] --json
  grfs plan [--fixture <runtime-suite.json>] [--mode replay|live] --json
  grfs gate --repo <path> --plan-id <id> [--head <revision>] --json
  grfs gate [--fixture <runtime-suite.json>] [--case <case-id>] --json
  grfs replan --repo <path> --plan-id <id> [--head <revision>] [--proposal <proposal.json>] [--context <manifest.json> --authorize-context] [--mode replay|live] [--accept --accept-by <label>] --json
  grfs replan [--mode replay|live] [--fallback none|replay] --json
  grfs review [--bundle <path>] [--fixture <runtime-suite.json>] [--host 127.0.0.1] [--port 4173]
  grfs export --repo <path> --plan-id <id> [--head <revision>] --output <bundle.json> --json
  grfs export --verify <bundle.json> --json
  grfs export [--fixture <runtime-suite.json>] [--plan-run <path>] [--replan-run <path>] [--output <path>] --json
`;

const defaultFixtureOutput = resolve(".private/fixtures/refresh-token-rotation-v1");
const defaultRuntimeSuite = resolve(defaultFixtureOutput, ".graphrefly-stack/runtime-suite.json");

function isWithin(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedCandidate = resolve(candidate);
	return (
		normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
	);
}

function commandFrom(argv: readonly string[]): CliCommand | null {
	if (argv[0] === "init") return "init";
	if (argv[0] === "ci" && argv[1] === "init") return "ci-init";
	if (argv[0] === "ci" && argv[1] === "run") return "ci-run";
	if (argv[0] === "hosted" && argv[1] === "init") return "hosted-init";
	if (argv[0] === "hosted" && argv[1] === "sync") return "hosted-sync";
	if (argv[0] === "fixture" && argv[1] === "create") return "fixture-create";
	if (["plan", "gate", "replan", "review", "export"].includes(argv[0] ?? "")) {
		return argv[0] as CliCommand;
	}
	return null;
}

function readOption(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

function writeJson(result: CliResult<unknown>): void {
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

function failure(
	command: CliCommand,
	json: boolean,
	code: string,
	message: string,
	mode: "deterministic" | "replay" | "live" = "deterministic",
): number {
	const error = { code, message };
	if (json) {
		writeJson({
			schema: CLI_RESULT_SCHEMA,
			command,
			ok: false,
			mode,
			error,
		});
	} else {
		process.stderr.write(`${error.code}: ${error.message}\n`);
	}
	return 1;
}

function success(
	command: CliCommand,
	mode: "deterministic" | "replay" | "live" | "replay-fallback",
	data: unknown,
	json: boolean,
) {
	if (json) {
		writeJson({ schema: CLI_RESULT_SCHEMA, command, ok: true, mode, data });
	} else {
		process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
	}
}

function caseFrom(runtime: Awaited<ReturnType<typeof readRuntimeSuite>>, caseId: string) {
	return runtime.cases.find((fixtureCase) => fixtureCase.caseId === caseId);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function readLiveRun(path: string | undefined, kind: "plan" | "replan") {
	if (path === undefined) return undefined;
	const value = await readJson(resolve(path));
	if (
		value.schema !== "urn:graphrefly-stack:live-run:v1" ||
		value.kind !== kind ||
		value.mode !== "live" ||
		typeof value.provenance !== "object" ||
		value.provenance === null
	) {
		throw new Error(`Invalid ${kind} live-run artifact`);
	}
	const provenance = value.provenance as Record<string, unknown>;
	const outputDigest = provenance.outputDigest as Record<string, unknown> | undefined;
	if (outputDigest?.value !== sha256Jcs(value.output)) {
		throw new Error(`${kind} live-run output digest mismatch`);
	}
	return value as unknown as LiveRunRecord;
}

async function reviewDataFromBundle(bundle: string) {
	const portable = await readPortableEvidenceBundle(bundle);
	const artifact = (path: string): Record<string, unknown> => {
		const value = portable.artifacts[path];
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`Portable evidence artifact is not an object: ${path}`);
		}
		return value as Record<string, unknown>;
	};
	const plan = artifact("plan/change-plan.json");
	const gateResult = artifact("gates/after-change.json");
	const delta = artifact("blueprints/delta.json");
	const stack = artifact("stack.json");
	const reviewDecision = artifact("review/decision.json");
	const checks = portable.artifacts["checks/after-rebase.json"];
	const manifest = portable.manifest;
	const rawDiffs = (["u1", "u2", "u3"] as const).map((unit) => artifact(`diffs/${unit}.json`));
	const blueprintKeys = ["base", "u1", "u2", "u3"] as const;
	const blueprintArtifacts = blueprintKeys.map((key) => ({
		workUnitId: key === "base" ? "BASE" : key.toUpperCase(),
		snapshot: artifact(`blueprints/commits/${key}.json`),
		diagram: artifact(`blueprints/diagrams/${key}.json`),
		delta: key === "base" ? null : artifact(`blueprints/deltas/${key}.json`),
	}));
	const commits = (stack.commits as Record<string, unknown>[])
		.filter((commit) => typeof commit.workUnitId === "string")
		.map((commit) => ({
			workUnitId: commit.workUnitId,
			oid: (commit.oid as Record<string, unknown>).value,
		}));
	const concurrent = (stack.commits as Record<string, unknown>[]).find(
		(commit) => commit.role === "concurrent",
	);
	return {
		path: portable.path,
		reviewData: {
			source: "redacted-bundle",
			caseId: "clean-rebase-semantic-stale",
			baseOid:
				((concurrent?.oid as Record<string, unknown> | undefined)?.value as string) ?? "unknown",
			commits,
			workUnits: plan.workUnits,
			gateResult,
			delta,
			reviewDecision,
			checks,
			rawDiffs,
			blueprints: blueprintArtifacts.map((blueprintArtifact) => ({
				...blueprintArtifact,
				oid: (blueprintArtifact.snapshot.commit as Record<string, unknown>).value as string,
				parentOid:
					((blueprintArtifact.snapshot.semanticParent as Record<string, unknown> | null)
						?.value as string) ?? null,
			})),
			manifest: {
				runId: manifest.runId,
				model: manifest.model,
				promptVersion: manifest.promptVersion,
				artifactCount: manifest.artifacts.length,
			},
			bundleAvailable: true,
		},
	};
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(help);
		return 0;
	}

	const command = commandFrom(argv);
	if (command === null) {
		process.stderr.write(`Unknown command.\n\n${help}`);
		return 1;
	}

	const json = argv.includes("--json");
	const requestedMode = readOption(argv, "--mode") ?? "replay";
	if (requestedMode !== "replay" && requestedMode !== "live") {
		return failure(command, json, "INVALID_MODE", requestedMode, "replay");
	}
	if (requestedMode === "live" && command !== "plan" && command !== "replan") {
		return failure(command, json, "LIVE_MODE_UNSUPPORTED_FOR_COMMAND", command, "live");
	}
	const fallback = readOption(argv, "--fallback") ?? "none";
	if (fallback !== "none" && fallback !== "replay") {
		return failure(command, json, "INVALID_FALLBACK", fallback, requestedMode);
	}
	if (command === "ci-init") {
		try {
			success(
				command,
				"deterministic",
				await initializeCiWorkflow({
					repository: readOption(argv, "--repo") ?? ".",
					force: argv.includes("--force"),
				}),
				json,
			);
			return 0;
		} catch (error) {
			if (error instanceof CiRunnerError) {
				return failure(command, json, error.code, error.message);
			}
			throw error;
		}
	}

	if (command === "ci-run") {
		const eventPath = readOption(argv, "--event");
		const output = readOption(argv, "--output");
		if (eventPath === undefined || output === undefined) {
			return failure(
				command,
				json,
				"CI_RUN_INPUT_REQUIRED",
				"--event and --output are required for CI execution",
			);
		}
		try {
			const result = await runCi({
				repository: readOption(argv, "--repo") ?? ".",
				eventPath,
				planId: readOption(argv, "--plan-id"),
				output,
			});
			success(command, "deterministic", result, json);
			return result.outcome === "pass" ? 0 : result.outcome === "blocked" ? 2 : 1;
		} catch (error) {
			if (
				error instanceof CiRunnerError ||
				error instanceof SemanticRepositoryError ||
				error instanceof RepositoryReviewError
			) {
				return failure(command, json, error.code, error.message);
			}
			throw error;
		}
	}
	if (command === "hosted-init") {
		const endpoint = readOption(argv, "--endpoint");
		const profile = readOption(argv, "--profile") ?? "gate-summary-v1";
		if (endpoint === undefined) {
			return failure(command, json, "HOSTED_ENDPOINT_REQUIRED", "--endpoint is required");
		}
		if (profile !== "gate-summary-v1" && profile !== "semantic-review-v1") {
			return failure(command, json, "HOSTED_PROFILE_INVALID", profile);
		}
		try {
			success(
				command,
				"deterministic",
				await initializeHostedWorkflow({
					repository: readOption(argv, "--repo") ?? ".",
					endpoint,
					profile,
					force: argv.includes("--force"),
				}),
				json,
			);
			return 0;
		} catch (error) {
			if (error instanceof HostedRunnerError) {
				return failure(command, json, error.code, error.message);
			}
			throw error;
		}
	}
	if (command === "hosted-sync") {
		const artifact = readOption(argv, "--artifact");
		const endpoint = readOption(argv, "--endpoint");
		const profile = readOption(argv, "--profile") ?? "gate-summary-v1";
		if (artifact === undefined || endpoint === undefined) {
			return failure(
				command,
				json,
				"HOSTED_SYNC_INPUT_REQUIRED",
				"--artifact and --endpoint are required",
			);
		}
		if (profile !== "gate-summary-v1" && profile !== "semantic-review-v1") {
			return failure(command, json, "HOSTED_PROFILE_INVALID", profile);
		}
		try {
			success(
				command,
				"deterministic",
				await syncHostedEvidence({ artifact, endpoint, profile }),
				true,
			);
			return 0;
		} catch (error) {
			if (error instanceof HostedRunnerError) {
				return failure(command, true, error.code, error.message);
			}
			throw error;
		}
	}
	if (command === "init") {
		const graphModule = readOption(argv, "--graph-module");
		if (graphModule === undefined) {
			return failure(command, json, "INIT_GRAPH_MODULE_REQUIRED", "--graph-module is required");
		}
		try {
			const result = await initializeRepository({
				repository: readOption(argv, "--repo") ?? ".",
				graphModule,
				graphExport: readOption(argv, "--graph-export") ?? "createApplicationGraph",
				force: argv.includes("--force"),
			});
			success(command, "deterministic", result, json);
			return 0;
		} catch (error) {
			if (error instanceof RepositoryInitError) {
				return failure(command, json, error.code, error.message);
			}
			throw error;
		}
	}

	if (command === "fixture-create") {
		const output = resolve(readOption(argv, "--output") ?? defaultFixtureOutput);
		if (!isWithin(resolve(".private"), output)) {
			return failure(command, json, "OUTPUT_OUTSIDE_PRIVATE_ROOT", output, "replay");
		}
		const runtime = await createFlagshipFixture(output, argv.includes("--force"));
		success(
			command,
			"replay",
			{
				repository: runtime.repository,
				runtimeSuite: resolve(output, ".graphrefly-stack/runtime-suite.json"),
				refs: runtime.refs,
			},
			json,
		);
		return 0;
	}

	if (command === "plan") {
		const repository = readOption(argv, "--repo");
		if (repository !== undefined) {
			try {
				if (argv.includes("--bind")) {
					const planId = readOption(argv, "--plan-id");
					if (planId === undefined) {
						return failure(command, json, "PLAN_ID_REQUIRED", "--plan-id is required with --bind");
					}
					success(
						command,
						"deterministic",
						await bindSemanticPlan({
							repository,
							planId,
							head: readOption(argv, "--head"),
						}),
						json,
					);
					return 0;
				}
				const taskSummary = readOption(argv, "--task");
				const policyPath = readOption(argv, "--policy");
				if (taskSummary === undefined || policyPath === undefined) {
					return failure(
						command,
						json,
						"SEMANTIC_PLAN_INPUT_REQUIRED",
						"--task and --policy are required for generic semantic planning",
						requestedMode,
					);
				}
				if (fallback !== "none") {
					return failure(
						command,
						json,
						"GENERIC_PLAN_FALLBACK_UNSUPPORTED",
						"Generic live planning fails closed instead of impersonating replay",
						requestedMode,
					);
				}
				const result = await createSemanticPlan({
					repository,
					taskSummary,
					policyPath,
					proposalPath: readOption(argv, "--proposal"),
					contextPath: readOption(argv, "--context"),
					base: readOption(argv, "--base"),
					mode: requestedMode,
					authorizeContext: argv.includes("--authorize-context"),
					accept: argv.includes("--accept"),
					acceptedBy: readOption(argv, "--accept-by"),
				});
				success(command, requestedMode, result, json);
				return 0;
			} catch (error) {
				if (error instanceof SemanticRepositoryError || error instanceof RepositoryReviewError) {
					return failure(command, json, error.code, error.message, requestedMode);
				}
				throw error;
			}
		}
		const runtime = await readRuntimeSuite(readOption(argv, "--fixture") ?? defaultRuntimeSuite);
		if (requestedMode === "live") {
			try {
				success(command, "live", await runLivePlan(runtime), json);
				return 0;
			} catch (error) {
				if (fallback === "replay") {
					success(command, "replay-fallback", replayFallback("plan", runtime, error), json);
					return 0;
				}
				return failure(command, json, "LIVE_PROVIDER_FAILED", redactProviderError(error), "live");
			}
		}
		success(command, "replay", runtime.changePlan, json);
		return 0;
	}

	if (command === "gate") {
		const repository = readOption(argv, "--repo");
		if (repository !== undefined) {
			const planId = readOption(argv, "--plan-id");
			if (planId === undefined) {
				return failure(command, json, "PLAN_ID_REQUIRED", "--plan-id is required with --repo");
			}
			try {
				const output = await createSemanticGate({
					repository,
					planId,
					head: readOption(argv, "--head"),
				});
				success(command, "deterministic", output, json);
				return output.gateResult.verdict === "pass"
					? 0
					: output.gateResult.verdict === "blocked"
						? 2
						: 1;
			} catch (error) {
				if (error instanceof SemanticRepositoryError || error instanceof RepositoryReviewError) {
					return failure(command, json, error.code, error.message);
				}
				throw error;
			}
		}
		const runtime = await readRuntimeSuite(readOption(argv, "--fixture") ?? defaultRuntimeSuite);
		const caseId = readOption(argv, "--case") ?? "clean-rebase-semantic-stale";
		const fixtureCase = caseFrom(runtime, caseId);
		if (fixtureCase === undefined) return failure(command, json, "UNKNOWN_CASE", caseId);
		const result = computeGate(fixtureCase.input);
		success(command, "deterministic", result, json);
		return result.verdict === "blocked" ? 2 : result.verdict === "error" ? 1 : 0;
	}

	if (command === "replan") {
		const repository = readOption(argv, "--repo");
		if (repository !== undefined) {
			const planId = readOption(argv, "--plan-id");
			if (planId === undefined) {
				return failure(command, json, "PLAN_ID_REQUIRED", "--plan-id is required with --repo");
			}
			if (requestedMode === "live" && fallback !== "none") {
				return failure(
					command,
					json,
					"GENERIC_REPLAN_FALLBACK_UNSUPPORTED",
					"Generic live replan fails closed instead of impersonating replay",
					requestedMode,
				);
			}
			try {
				const output = await replanSemanticPlan({
					repository,
					planId,
					head: readOption(argv, "--head"),
					proposalPath: readOption(argv, "--proposal"),
					contextPath: readOption(argv, "--context"),
					mode: requestedMode,
					authorizeContext: argv.includes("--authorize-context"),
					accept: argv.includes("--accept"),
					acceptedBy: readOption(argv, "--accept-by"),
				});
				success(command, requestedMode, output, json);
				return 0;
			} catch (error) {
				if (error instanceof SemanticRepositoryError || error instanceof RepositoryReviewError) {
					return failure(command, json, error.code, error.message, requestedMode);
				}
				throw error;
			}
		}
		const runtime = await readRuntimeSuite(readOption(argv, "--fixture") ?? defaultRuntimeSuite);
		if (requestedMode === "live") {
			try {
				success(command, "live", await runLiveReplan(runtime), json);
				return 0;
			} catch (error) {
				if (fallback === "replay") {
					success(command, "replay-fallback", replayFallback("replan", runtime, error), json);
					return 0;
				}
				return failure(command, json, "LIVE_PROVIDER_FAILED", redactProviderError(error), "live");
			}
		}
		success(command, "replay", runtime.selectiveReplan, json);
		return 0;
	}

	if (command === "export") {
		const repository = readOption(argv, "--repo");
		const verify = readOption(argv, "--verify");
		if (verify !== undefined) {
			if (repository !== undefined || readOption(argv, "--output") !== undefined) {
				return failure(
					command,
					json,
					"SEMANTIC_EXPORT_CONFLICT",
					"--verify cannot be combined with --repo or --output",
				);
			}
			try {
				success(command, "deterministic", await verifySemanticBundle(verify), json);
				return 0;
			} catch (error) {
				if (error instanceof SemanticRepositoryError) {
					return failure(command, json, error.code, error.message);
				}
				throw error;
			}
		}
		if (repository !== undefined) {
			const planId = readOption(argv, "--plan-id");
			const output = readOption(argv, "--output");
			if (planId === undefined || output === undefined) {
				return failure(
					command,
					json,
					"SEMANTIC_EXPORT_INCOMPLETE",
					"--plan-id and --output are required with --repo",
				);
			}
			try {
				success(
					command,
					"deterministic",
					await exportSemanticBundle({
						repository,
						planId,
						head: readOption(argv, "--head"),
						output,
					}),
					json,
				);
				return 0;
			} catch (error) {
				if (error instanceof SemanticRepositoryError || error instanceof RepositoryReviewError) {
					return failure(command, json, error.code, error.message);
				}
				throw error;
			}
		}
		const runtime = await readRuntimeSuite(readOption(argv, "--fixture") ?? defaultRuntimeSuite);
		const requestedOutput = resolve(
			readOption(argv, "--output") ?? resolve(".private/exports/refresh-token-rotation-v1"),
		);
		if (
			!isWithin(resolve(".private"), requestedOutput) &&
			!isWithin(resolve("evidence/runs"), requestedOutput)
		) {
			return failure(command, json, "OUTPUT_OUTSIDE_EVIDENCE_ROOT", requestedOutput);
		}
		const liveRuns = {
			plan: await readLiveRun(readOption(argv, "--plan-run"), "plan"),
			replan: await readLiveRun(readOption(argv, "--replan-run"), "replan"),
		};
		const output = await exportEvidenceBundle(runtime, requestedOutput, liveRuns);
		success(command, "deterministic", { bundle: output }, json);
		return 0;
	}

	const host = readOption(argv, "--host") ?? "127.0.0.1";
	if (host !== "127.0.0.1") {
		return failure(
			command,
			json,
			"REVIEW_HOST_NOT_LOOPBACK",
			"The local review server only binds to 127.0.0.1",
		);
	}
	const portValue = readOption(argv, "--port") ?? "4173";
	const port = Number.parseInt(portValue, 10);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		return failure(command, json, "INVALID_PORT", portValue);
	}

	let reviewData: unknown;
	let evidenceBundlePath: string | undefined;
	let repositoryReviewState:
		| { repository: string; review: Awaited<ReturnType<typeof createRepositoryReview>> }
		| undefined;
	const repository = readOption(argv, "--repo");
	const base = readOption(argv, "--base");
	const head = readOption(argv, "--head");
	const hasRepositoryReviewOption = ["--repo", "--base", "--head"].some((option) =>
		argv.includes(option),
	);
	const bundle = readOption(argv, "--bundle");
	if (hasRepositoryReviewOption) {
		if (repository === undefined || base === undefined || head === undefined) {
			return failure(
				command,
				json,
				"REVIEW_RANGE_INCOMPLETE",
				"--repo, --base, and --head are required together",
			);
		}
		if (bundle !== undefined || argv.includes("--fixture")) {
			return failure(
				command,
				json,
				"REVIEW_SOURCE_CONFLICT",
				"Generic repository review cannot be mixed with fixture or bundle input",
			);
		}
		try {
			const planId = readOption(argv, "--plan-id");
			const repositoryReview =
				planId === undefined
					? await createRepositoryReview({ repository, base, head })
					: await createSemanticRepositoryReview({ repository, base, head, planId });
			reviewData = repositoryReview;
			repositoryReviewState = { repository: resolve(repository), review: repositoryReview };
		} catch (error) {
			if (error instanceof RepositoryReviewError) {
				return failure(command, json, error.code, error.message);
			}
			throw error;
		}
	} else if (bundle !== undefined) {
		const loaded = await reviewDataFromBundle(bundle);
		reviewData = loaded.reviewData;
		evidenceBundlePath = loaded.path;
	} else {
		const runtime = await readRuntimeSuite(readOption(argv, "--fixture") ?? defaultRuntimeSuite);
		const fixtureCase = caseFrom(runtime, "clean-rebase-semantic-stale");
		if (fixtureCase === undefined)
			return failure(command, json, "UNKNOWN_CASE", "clean-rebase-semantic-stale");
		const git = new SystemGitAdapter();
		const rawDiffs = await Promise.all(
			fixtureCase.input.gitFacts.map(async (fact) => ({
				schema: "urn:graphrefly-stack:schema:raw-diff:v1",
				workUnitId: fact.workUnitId,
				commit: fact.commit,
				paths: fact.changedPaths,
				patch: Buffer.from(await git.canonicalDiff(runtime.repository, fact.commit)).toString(
					"utf8",
				),
			})),
		);
		reviewData = {
			source: "real-git-runtime",
			caseId: fixtureCase.caseId,
			baseOid: runtime.refs.A1,
			commits: fixtureCase.input.gitFacts.map((fact) => ({
				workUnitId: fact.workUnitId,
				oid: fact.commit.value,
			})),
			workUnits: fixtureCase.input.workUnits,
			gateResult: computeGate(fixtureCase.input),
			delta: fixtureCase.input.delta,
			reviewDecision: { decision: "defer" },
			checks: runtime.ordinaryChecks,
			rawDiffs,
			blueprints: runtime.reviewBlueprints,
			manifest: null,
			bundleAvailable: false,
		};
	}
	if (json) {
		success(command, "deterministic", reviewData, true);
		return 0;
	}
	const running = await startReviewServer({
		host,
		port,
		reviewData,
		evidenceBundlePath,
		repositoryReviewState,
	});
	process.stderr.write(
		`GraphReFly Stack review shell (${CORE_ARCHITECTURE.version}) listening at ${running.url}\n`,
	);
	const close = () => running.server.close();
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	return 0;
}

let entry = "";
try {
	entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
} catch {
	// A missing executable path cannot be the current module.
}
if (import.meta.url === entry) {
	runCli().then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			const argv = process.argv.slice(2);
			const command = commandFrom(argv);
			const message = error instanceof Error ? error.message : String(error);
			if (command !== null && argv.includes("--json")) {
				const mode =
					readOption(argv, "--mode") === "live"
						? "live"
						: command === "plan" || command === "replan" || command === "fixture-create"
							? "replay"
							: "deterministic";
				failure(command, true, "RUNTIME_ERROR", message, mode);
			} else {
				process.stderr.write(`RUNTIME_ERROR: ${message}\n`);
			}
			process.exitCode = 1;
		},
	);
}
