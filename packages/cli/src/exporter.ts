import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrictAjv, sha256Jcs } from "@graphrefly-stack/contracts";
import { computeGate } from "@graphrefly-stack/core";

import type { RuntimeSuite } from "./fixture.js";
import { SystemGitAdapter } from "./system-git.js";

const recordedAt = "2026-07-16T00:00:00Z";
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface LiveRunRecord {
	schema: "urn:graphrefly-stack:live-run:v1";
	kind: "plan" | "replan";
	mode: "live";
	output: unknown;
	provenance: {
		provider: "codex-sdk";
		model: string;
		reasoningEffort: string;
		promptVersion: string;
		responseDigest: { algorithm: "sha256"; value: string };
		[key: string]: unknown;
	};
}

interface ExportWorkUnit {
	id: string;
	dependencies: string[];
	allowedSourceScopes: string[];
	blueprintClaims: { id: string; statement: string }[];
	requiredChecks: string[];
}

function workUnitAnchors(units: ExportWorkUnit[]) {
	return units.map((unit) => ({
		id: unit.id,
		dependencies: unit.dependencies,
		allowedSourceScopes: unit.allowedSourceScopes,
		blueprintClaimIds: unit.blueprintClaims.map((claim) => claim.id),
		requiredChecks: unit.requiredChecks,
	}));
}

async function validateLiveRuns(
	runtime: RuntimeSuite,
	liveRuns: { plan?: LiveRunRecord; replan?: LiveRunRecord },
): Promise<void> {
	const schema = JSON.parse(
		await readFile(resolve(workspaceRoot, "contracts/v1/schemas/artifacts.schema.json"), "utf8"),
	) as object;
	const ajv = createStrictAjv();
	ajv.addSchema(schema);
	const validateChangePlan = ajv.getSchema(
		"urn:graphrefly-stack:schema:artifacts:v1#/definitions/ChangePlan",
	);
	const validateWorkUnit = ajv.getSchema(
		"urn:graphrefly-stack:schema:artifacts:v1#/definitions/WorkUnit",
	);
	const canonicalUnits = (runtime.changePlan.workUnits as ExportWorkUnit[]) ?? [];
	for (const [kind, run] of Object.entries(liveRuns) as ["plan" | "replan", LiveRunRecord][]) {
		if (run.kind !== kind || run.mode !== "live" || run.provenance.provider !== "codex-sdk") {
			throw new Error(`Invalid ${kind} live-run envelope`);
		}
		const digest = (run.provenance.outputDigest as { value?: unknown } | undefined)?.value;
		if (digest !== sha256Jcs(run.output))
			throw new Error(`${kind} live-run output digest mismatch`);
		for (const field of ["model", "reasoningEffort", "promptVersion"] as const) {
			if (typeof run.provenance[field] !== "string" || run.provenance[field].length === 0) {
				throw new Error(`${kind} live-run provenance is missing ${field}`);
			}
		}
		if (run.provenance.promptVersion !== `stack.${kind}.v1`) {
			throw new Error(`${kind} live-run uses an unsupported prompt version`);
		}
	}
	if (
		liveRuns.plan !== undefined &&
		(validateChangePlan === undefined || !validateChangePlan(liveRuns.plan.output))
	) {
		throw new Error(
			`Plan live-run output is invalid: ${JSON.stringify(validateChangePlan?.errors)}`,
		);
	}
	if (liveRuns.plan !== undefined) {
		const output = liveRuns.plan.output as { source: unknown; workUnits: ExportWorkUnit[] };
		if (
			output.source !== "codex" ||
			sha256Jcs(workUnitAnchors(output.workUnits)) !== sha256Jcs(workUnitAnchors(canonicalUnits))
		) {
			throw new Error("Plan live-run changed locked work-unit anchors");
		}
	}
	if (liveRuns.replan !== undefined) {
		const output = liveRuns.replan.output as Record<string, unknown>;
		const proposed = output.proposedWorkUnits;
		if (
			!Array.isArray(proposed) ||
			proposed.some((unit) => validateWorkUnit === undefined || !validateWorkUnit(unit))
		) {
			throw new Error("Replan live-run proposed work units are invalid");
		}
		const deterministic = { ...output };
		delete deterministic.proposedWorkUnits;
		if (sha256Jcs(deterministic) !== sha256Jcs(runtime.selectiveReplan)) {
			throw new Error("Replan live-run changed deterministic replacement evidence");
		}
		const canonicalReplanUnits = canonicalUnits.filter((unit) => ["U2", "U3"].includes(unit.id));
		if (
			sha256Jcs(workUnitAnchors(proposed as ExportWorkUnit[])) !==
			sha256Jcs(workUnitAnchors(canonicalReplanUnits))
		) {
			throw new Error("Replan live-run changed locked selective-replan anchors");
		}
		const currentPolicy = runtime.cases.find(
			(fixtureCase) => fixtureCase.caseId === "clean-rebase-semantic-stale",
		)?.input.snapshot.policyRevision;
		const u2Claim = (proposed as ExportWorkUnit[])
			.find((unit) => unit.id === "U2")
			?.blueprintClaims.find((claim) => claim.id === "session-write-path")?.statement;
		if (
			currentPolicy === undefined ||
			u2Claim === undefined ||
			!u2Claim.includes("sessionMutationBroker") ||
			!u2Claim.includes(currentPolicy)
		) {
			throw new Error("Replan live-run is not grounded in the current broker policy");
		}
	}
	if (
		liveRuns.plan !== undefined &&
		liveRuns.replan !== undefined &&
		(liveRuns.plan.provenance.model !== liveRuns.replan.provenance.model ||
			liveRuns.plan.provenance.reasoningEffort !== liveRuns.replan.provenance.reasoningEffort)
	) {
		throw new Error("Plan and replan live runs use inconsistent model configuration");
	}
}

async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
	const target = resolve(root, relative);
	if (!target.startsWith(`${root}${sep}`)) throw new Error(`Unsafe bundle path: ${relative}`);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function exportEvidenceBundle(
	runtime: RuntimeSuite,
	output: string,
	liveRuns: { plan?: LiveRunRecord; replan?: LiveRunRecord } = {},
): Promise<string> {
	await validateLiveRuns(runtime, liveRuns);
	const root = resolve(output);
	const marker = resolve(root, ".graphrefly-stack-bundle");
	try {
		await stat(root);
		const ownership = await readFile(marker, "utf8").catch(() => "");
		const existingPortable = await readFile(resolve(root, "evidence-bundle.json"), "utf8")
			.then((contents) => JSON.parse(contents) as Record<string, unknown>)
			.catch(() => null);
		const existingManifest = existingPortable?.manifest as Record<string, unknown> | undefined;
		const ownsHistoricalRun =
			existingPortable?.schema === "urn:graphrefly-stack:schema:portable-bundle:v1" &&
			existingManifest?.runId === "fixture-refresh-token-rotation-v1-real-git";
		if (ownership.trim() !== runtime.scenario && !ownsHistoricalRun) {
			throw new Error(`Refusing to replace an output not owned by GraphReFly Stack: ${root}`);
		}
		await rm(root, { recursive: true, force: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(root, { recursive: true });
	await writeFile(marker, `${runtime.scenario}\n`, "utf8");
	const byCase = new Map(runtime.cases.map((fixtureCase) => [fixtureCase.caseId, fixtureCase]));
	const before = byCase.get("current-valid");
	const after = byCase.get("clean-rebase-semantic-stale");
	const final = byCase.get("fresh-selective-replan");
	if (before === undefined || after === undefined || final === undefined) {
		throw new Error("Runtime suite is missing required flagship cases");
	}
	const effectivePlan = (liveRuns.plan?.output ?? runtime.changePlan) as Record<string, unknown>;
	const planUnits = effectivePlan.workUnits as ExportWorkUnit[];
	const proposedReplanUnits = (
		liveRuns.replan?.output as { proposedWorkUnits?: ExportWorkUnit[] } | undefined
	)?.proposedWorkUnits;
	const replannedById = new Map(proposedReplanUnits?.map((unit) => [unit.id, unit]) ?? []);
	const finalUnits = planUnits.map((unit) => replannedById.get(unit.id) ?? unit);
	const gate = (fixtureCase: typeof before, workUnits: ExportWorkUnit[]) =>
		computeGate({ ...fixtureCase.input, workUnits });
	const beforeGate = gate(before, planUnits);
	const afterGate = gate(after, planUnits);
	const finalGate = gate(final, finalUnits);
	const git = new SystemGitAdapter();
	const rawDiffs = await Promise.all(
		after.input.gitFacts.map(async (fact) => ({
			schema: "urn:graphrefly-stack:schema:raw-diff:v1",
			workUnitId: fact.workUnitId,
			commit: fact.commit,
			paths: fact.changedPaths,
			patch: Buffer.from(await git.canonicalDiff(runtime.repository, fact.commit)).toString("utf8"),
		})),
	);

	const oid = (value: string) => ({ algorithm: "sha1" as const, value });
	const stack = {
		schema: "urn:graphrefly-stack:schema:git-stack:v1",
		linearity: "linear",
		base: oid(runtime.refs.B0 ?? ""),
		head: oid(runtime.refs.R3 ?? ""),
		commits: [
			{ oid: oid(runtime.refs.B0 ?? ""), parent: null, role: "base", workUnitId: null },
			{
				oid: oid(runtime.refs.A1 ?? ""),
				parent: oid(runtime.refs.B0 ?? ""),
				role: "concurrent",
				workUnitId: null,
			},
			{
				oid: oid(runtime.refs.R1 ?? ""),
				parent: oid(runtime.refs.A1 ?? ""),
				role: "work-unit",
				workUnitId: "U1",
			},
			{
				oid: oid(runtime.refs.R2 ?? ""),
				parent: oid(runtime.refs.R1 ?? ""),
				role: "work-unit",
				workUnitId: "U2",
			},
			{
				oid: oid(runtime.refs.R3 ?? ""),
				parent: oid(runtime.refs.R2 ?? ""),
				role: "work-unit",
				workUnitId: "U3",
			},
		],
	};
	const records = after.input.records;
	const finalRecords = final.input.records;
	const review = {
		schema: "urn:graphrefly-stack:schema:review-decision:v1",
		decision: "defer",
		reviewerLabel: "local-reviewer",
		recordIds: records.map((record) => record.recordId),
		recordedAt,
		identityVerified: false,
	};
	const files: Record<string, unknown> = {
		"task.json": runtime.task,
		"stack.json": stack,
		"blueprints/base.json": runtime.snapshots[0],
		"blueprints/current.json": runtime.snapshots[1],
		"blueprints/delta.json": runtime.deltas[1],
		"plan/change-plan.json": effectivePlan,
		"semantic-changes/u1.json": records[0],
		"semantic-changes/u2.json": records[1],
		"semantic-changes/u3.json": records[2],
		"semantic-changes/final/u1.json": finalRecords[0],
		"semantic-changes/final/u2.json": finalRecords[1],
		"semantic-changes/final/u3.json": finalRecords[2],
		"gates/before-change.json": beforeGate,
		"gates/after-change.json": afterGate,
		"replan/affected.json": runtime.selectiveReplan,
		"checks/final.json": runtime.checks,
		"checks/after-rebase.json": runtime.ordinaryChecks,
		"gates/final.json": finalGate,
		"review/decision.json": review,
	};
	for (const reviewBlueprint of runtime.reviewBlueprints) {
		const key =
			reviewBlueprint.workUnitId === "BASE" ? "base" : reviewBlueprint.workUnitId.toLowerCase();
		files[`blueprints/commits/${key}.json`] = reviewBlueprint.snapshot;
		files[`blueprints/diagrams/${key}.json`] = reviewBlueprint.diagram;
		if (reviewBlueprint.delta !== null) {
			files[`blueprints/deltas/${key}.json`] = reviewBlueprint.delta;
		}
	}
	for (const rawDiff of rawDiffs) {
		files[`diffs/${rawDiff.workUnitId.toLowerCase()}.json`] = rawDiff;
	}
	if (liveRuns.plan !== undefined) files["provenance/live-plan.json"] = liveRuns.plan;
	if (liveRuns.replan !== undefined) files["provenance/live-replan.json"] = liveRuns.replan;
	const liveProvenance = liveRuns.plan?.provenance ?? liveRuns.replan?.provenance;

	const manifest = {
		schema: "urn:graphrefly-stack:schema:bundle-manifest:v1",
		runId: "fixture-refresh-token-rotation-v1-real-git",
		recordedAt,
		sourceCommit: oid(runtime.refs.R1 ?? ""),
		canonicalInputDigest: {
			algorithm: "sha256",
			value: finalGate.inputDigest.value,
		},
		schemaVersion: "v1",
		promptVersion: liveProvenance?.promptVersion ?? "fixture.v1",
		model: liveProvenance
			? {
					source: "codex",
					id: liveProvenance.model,
					reasoningEffort: liveProvenance.reasoningEffort,
				}
			: { source: "fixture", id: "fixture", reasoningEffort: "none" },
		provider: runtime.provider,
		graphreflyVersion: "0.1.1",
		policyRevision: "session-writes.v2",
		artifacts: Object.entries(files).map(([path, value]) => ({
			path,
			hash: { algorithm: "sha256", value: sha256Jcs(value) },
		})),
	};
	const portable = {
		schema: "urn:graphrefly-stack:schema:portable-bundle:v1",
		manifest,
		artifacts: files,
	};
	for (const artifact of manifest.artifacts) {
		if (sha256Jcs(files[artifact.path]) !== artifact.hash.value) {
			throw new Error(`Artifact hash mismatch: ${artifact.path}`);
		}
	}
	await writeJson(root, "evidence-bundle.json", portable);
	await writeFile(
		resolve(root, "README.md"),
		"# GraphReFly Stack evidence bundle\n\nRedacted deterministic evidence. Gate results are computed; the local review decision is separate evidence. `evidence-bundle.json` embeds and hash-binds every logical JSON artifact; expanded run files are generated output and are not stored in Git.\n",
		"utf8",
	);
	return root;
}
