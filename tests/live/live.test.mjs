import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
	redactProviderError,
	replayFallback,
	runLivePlan,
	runLiveReplan,
} from "../../packages/cli/dist/codex-plan-provider.js";
import { exportEvidenceBundle } from "../../packages/cli/dist/exporter.js";
import { createFlagshipFixture } from "../../packages/cli/dist/fixture.js";
import { createStrictAjv, sha256Jcs } from "../../packages/contracts/dist/index.js";
import { computeGate } from "../../packages/core/dist/index.js";

const runRoot = resolve(tmpdir(), `graphrefly-stack-live-${process.pid}`);
const runtime = await createFlagshipFixture(resolve(runRoot, "fixture"), true);

test.after(async () => {
	await rm(runRoot, { recursive: true, force: true });
});

function fakeRunner(outputFactory) {
	return {
		requests: [],
		async run(request) {
			this.requests.push(request);
			return {
				finalResponse: JSON.stringify(outputFactory(request)),
				threadId: "thread_fixture",
				usage: {
					input_tokens: 100,
					cached_input_tokens: 20,
					output_tokens: 30,
					reasoning_output_tokens: 10,
				},
			};
		},
	};
}

test("validated Codex plan output is deterministically bound without changing gate semantics", async () => {
	const proposedUnits = structuredClone(runtime.changePlan.workUnits);
	proposedUnits[0].title = "Rotate the refresh-token signer with an explicit migration boundary";
	const runner = fakeRunner(() => ({
		schema: "urn:graphrefly-stack:schema:plan-proposal:v1",
		workUnits: proposedUnits,
	}));
	const before = computeGate(runtime.cases[1].input);
	const result = await runLivePlan(runtime, runner);
	const after = computeGate({ ...runtime.cases[1].input, workUnits: result.output.workUnits });
	assert.notEqual(after.inputDigest.value, before.inputDigest.value);
	assert.deepEqual(
		{ verdict: after.verdict, units: after.units, checkIds: after.checkIds },
		{ verdict: before.verdict, units: before.units, checkIds: before.checkIds },
	);
	assert.equal(result.output.source, "codex");
	assert.equal(result.provenance.provider, "codex-sdk");
	assert.equal(result.provenance.codexSdkVersion, "0.143.0");
	assert.equal(result.provenance.promptVersion, "stack.plan.v1");
	assert.equal(result.provenance.threadId, "thread_fixture");
	assert.equal(
		JSON.stringify(runner.requests[0].outputSchema).includes(
			"urn:graphrefly-stack:schema:artifacts:v1",
		),
		false,
	);
	assert.equal(runner.requests[0].workingDirectory, runtime.repository);
	const liveRun = JSON.parse(await readFile(result.runArtifact, "utf8"));
	assert.equal(liveRun.provenance.outputDigest.value.length, 64);
	const bundle = resolve(runRoot, "live-bundle");
	await exportEvidenceBundle(runtime, bundle, { plan: liveRun });
	const manifest = JSON.parse(await readFile(resolve(bundle, "manifest.json"), "utf8"));
	const artifactsSchema = JSON.parse(
		await readFile(resolve("contracts/v1/schemas/artifacts.schema.json"), "utf8"),
	);
	const ajv = createStrictAjv();
	ajv.addSchema(artifactsSchema);
	const validateManifest = ajv.getSchema(
		"urn:graphrefly-stack:schema:artifacts:v1#/definitions/BundleManifest",
	);
	assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors, null, 2));
	assert.deepEqual(manifest.model, {
		source: "codex",
		id: result.provenance.model,
		reasoningEffort: result.provenance.reasoningEffort,
	});
	assert.equal(manifest.promptVersion, "stack.plan.v1");
	assert.equal(
		JSON.parse(await readFile(resolve(bundle, "plan/change-plan.json"), "utf8")).workUnits[0].title,
		proposedUnits[0].title,
	);
	for (const artifact of manifest.artifacts) {
		const value = JSON.parse(await readFile(resolve(bundle, artifact.path), "utf8"));
		assert.equal(sha256Jcs(value), artifact.hash.value, artifact.path);
	}
	assert.equal(
		JSON.parse(await readFile(resolve(bundle, "provenance/live-plan.json"), "utf8")).kind,
		"plan",
	);
});

test("validated Codex selective replan preserves U1 and accepts only U2 and U3", async () => {
	const units = structuredClone(
		runtime.changePlan.workUnits.filter((unit) => ["U2", "U3"].includes(unit.id)),
	);
	units[0].blueprintClaims[0].statement =
		"The online session mutation persists through sessionMutationBroker under session-writes.v2.";
	const runner = fakeRunner(() => ({
		schema: "urn:graphrefly-stack:schema:replan-proposal:v1",
		inputUnits: ["U2", "U3"],
		preservedUnits: ["U1"],
		workUnits: units,
	}));
	const result = await runLiveReplan(runtime, runner);
	assert.deepEqual(
		result.output.proposedWorkUnits.map((unit) => unit.id),
		["U2", "U3"],
	);
	assert.deepEqual(result.output.preservedUnits, ["U1"]);
	assert.equal(result.provenance.promptVersion, "stack.replan.v1");
	const liveRun = JSON.parse(await readFile(result.runArtifact, "utf8"));
	const bundle = resolve(runRoot, "live-replan-bundle");
	await exportEvidenceBundle(runtime, bundle, { replan: liveRun });
	const exportedRun = JSON.parse(
		await readFile(resolve(bundle, "provenance/live-replan.json"), "utf8"),
	);
	assert.match(
		exportedRun.output.proposedWorkUnits[0].blueprintClaims[0].statement,
		/sessionMutationBroker.*session-writes\.v2/,
	);
	const replayGate = computeGate(runtime.cases[5].input);
	const liveGate = JSON.parse(await readFile(resolve(bundle, "gates/final.json"), "utf8"));
	assert.notEqual(liveGate.inputDigest.value, replayGate.inputDigest.value);
	assert.deepEqual(
		{ verdict: liveGate.verdict, units: liveGate.units, checkIds: liveGate.checkIds },
		{ verdict: replayGate.verdict, units: replayGate.units, checkIds: replayGate.checkIds },
	);
});

test("Codex cannot widen a locked scope and explicit replay fallback is labelled", async () => {
	const widened = structuredClone(runtime.changePlan.workUnits);
	widened[1].allowedSourceScopes.push("src/attacker.ts");
	const runner = fakeRunner(() => ({
		schema: "urn:graphrefly-stack:schema:plan-proposal:v1",
		workUnits: widened,
	}));
	await assert.rejects(() => runLivePlan(runtime, runner), /changed locked work-unit/);
	const fallback = replayFallback(
		"plan",
		runtime,
		new Error(`${process.cwd()}/private sk-abcdefghijklmnopqrstuvwxyz failed`),
	);
	assert.equal(fallback.provenance.provider, "replay");
	assert.match(fallback.provenance.fallbackReason, /<workspace>/);
	assert.match(fallback.provenance.fallbackReason, /<redacted-credential>/);
	assert.equal(fallback.output, runtime.changePlan);
	assert.equal(
		redactProviderError(new Error("key-abcdefghijklmnopqrstuvwxyz")),
		"<redacted-credential>",
	);
});

test("the CLI uses replay fallback only when it is explicitly enabled", () => {
	const runtimePath = resolve(runRoot, "fixture/.graphrefly-stack/runtime-suite.json");
	const baseArgs = [
		"packages/cli/dist/cli.js",
		"plan",
		"--fixture",
		runtimePath,
		"--mode",
		"live",
		"--json",
	];
	const env = { ...process.env, GRAPHREFLY_STACK_REASONING_EFFORT: "invalid" };
	const withoutFallback = spawnSync(process.execPath, baseArgs, {
		cwd: new URL("../..", import.meta.url),
		encoding: "utf8",
		env,
	});
	assert.equal(withoutFallback.status, 1);
	assert.equal(JSON.parse(withoutFallback.stdout).mode, "live");
	assert.equal(JSON.parse(withoutFallback.stdout).error.code, "LIVE_PROVIDER_FAILED");
	const withFallback = spawnSync(
		process.execPath,
		[...baseArgs.slice(0, -1), "--fallback", "replay", "--json"],
		{
			cwd: new URL("../..", import.meta.url),
			encoding: "utf8",
			env,
		},
	);
	assert.equal(withFallback.status, 0);
	const envelope = JSON.parse(withFallback.stdout);
	assert.equal(envelope.mode, "replay-fallback");
	assert.equal(envelope.data.provenance.provider, "replay");
});
