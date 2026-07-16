#!/usr/bin/env node
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

import {
	redactProviderError,
	replayFallback,
	runLivePlan,
	runLiveReplan,
} from "./codex-plan-provider.js";
import { exportEvidenceBundle, type LiveRunRecord } from "./exporter.js";
import { createFlagshipFixture, readRuntimeSuite } from "./fixture.js";
import { startReviewServer } from "./review-server.js";
import { SystemGitAdapter } from "./system-git.js";

const help = `GraphReFly Stack

Usage:
  graphrefly-stack fixture create [--output <path>] [--force] [--json]
  graphrefly-stack plan [--fixture <runtime-suite.json>] [--mode replay|live] --json
  graphrefly-stack gate [--fixture <runtime-suite.json>] [--case <case-id>] --json
  graphrefly-stack replan [--mode replay|live] [--fallback none|replay] --json
  graphrefly-stack review [--bundle <path>] [--host 127.0.0.1] [--port 4173]
  graphrefly-stack export [--fixture <runtime-suite.json>] [--plan-run <path>] [--replan-run <path>] [--output <path>] --json

STACK-5 provides deterministic fixture replay, semantic gating, selective replan, and bundle export.
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
	const root = resolve(bundle);
	const [plan, gateResult, delta, stack, reviewDecision, checks, manifest, ...rawDiffs] =
		await Promise.all([
			readJson(resolve(root, "plan/change-plan.json")),
			readJson(resolve(root, "gates/after-change.json")),
			readJson(resolve(root, "blueprints/delta.json")),
			readJson(resolve(root, "stack.json")),
			readJson(resolve(root, "review/decision.json")),
			readJson(resolve(root, "checks/after-rebase.json")),
			readJson(resolve(root, "manifest.json")),
			...(["u1", "u2", "u3"] as const).map((unit) => readJson(resolve(root, `diffs/${unit}.json`))),
		]);
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
		manifest: {
			runId: manifest.runId,
			model: manifest.model,
			promptVersion: manifest.promptVersion,
			artifactCount: (manifest.artifacts as unknown[]).length,
		},
		bundleAvailable: true,
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
		const runtime = await readRuntimeSuite(readOption(argv, "--fixture") ?? defaultRuntimeSuite);
		const caseId = readOption(argv, "--case") ?? "clean-rebase-semantic-stale";
		const fixtureCase = caseFrom(runtime, caseId);
		if (fixtureCase === undefined) return failure(command, json, "UNKNOWN_CASE", caseId);
		const result = computeGate(fixtureCase.input);
		success(command, "deterministic", result, json);
		return result.verdict === "blocked" ? 2 : result.verdict === "error" ? 1 : 0;
	}

	if (command === "replan") {
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

	let reviewData: unknown;
	const bundle = readOption(argv, "--bundle");
	if (bundle !== undefined) {
		reviewData = await reviewDataFromBundle(bundle);
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
			manifest: null,
			bundleAvailable: false,
		};
	}
	const host = readOption(argv, "--host") ?? "127.0.0.1";
	const portValue = readOption(argv, "--port") ?? "4173";
	const port = Number.parseInt(portValue, 10);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		process.stderr.write(`INVALID_PORT: ${portValue}\n`);
		return 1;
	}

	const running = await startReviewServer({
		host,
		port,
		reviewData,
		evidenceBundlePath: bundle === undefined ? undefined : resolve(bundle, "evidence-bundle.json"),
	});
	process.stderr.write(
		`GraphReFly Stack review shell (${CORE_ARCHITECTURE.version}) listening at ${running.url}\n`,
	);
	const close = () => running.server.close();
	process.once("SIGINT", close);
	process.once("SIGTERM", close);
	return 0;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
	runCli().then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			const argv = process.argv.slice(2);
			const command = commandFrom(argv);
			const message = error instanceof Error ? error.message : String(error);
			if (command !== null && command !== "review" && argv.includes("--json")) {
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
