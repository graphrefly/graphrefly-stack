import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
	createStrictAjv,
	SEMANTIC_REASON_ORDER,
	SEMANTIC_STORAGE,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

import { type CodexRunner, SdkCodexRunner } from "./codex-plan-provider.js";
import {
	DagExecutionCacheError,
	readDagExecutionCache,
	writeDagExecutionCache,
} from "./dag-execution-cache.js";
import {
	createRepositoryBlueprintSnapshot,
	createRepositoryReview,
	validateRepositoryReview,
} from "./repository-review.js";
import { repositoryReviewStateRoot } from "./repository-review-state.js";
import { runtimeAssetPath } from "./runtime-paths.js";
import { gitText, SystemGitAdapter } from "./system-git.js";

const artifactsSchemaPath = runtimeAssetPath("contracts/semantic/v1/artifacts.schema.json");
const maxContextFileBytes = 256 * 1024;
const maxContextBytes = 1024 * 1024;

type JsonObject = Record<string, unknown>;

export class SemanticRepositoryError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SemanticRepositoryError";
	}
}

function hash(value: unknown) {
	return { algorithm: "sha256" as const, value: sha256Jcs(value) };
}

async function readJsonFile(path: string, code: string): Promise<JsonObject> {
	try {
		const value = JSON.parse(await readFile(resolve(path), "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
		return value as JsonObject;
	} catch {
		throw new SemanticRepositoryError(code, `Invalid JSON artifact: ${resolve(path)}`);
	}
}

async function validators() {
	const schema = JSON.parse(await readFile(artifactsSchemaPath, "utf8")) as JsonObject;
	const ajv = createStrictAjv();
	ajv.addSchema(schema);
	const definition = (name: string) => {
		const validate = ajv.getSchema(
			`urn:graphrefly-stack:schema:semantic-artifacts:v1#/definitions/${name}`,
		);
		if (validate === undefined) throw new Error(`Missing semantic schema definition: ${name}`);
		return validate;
	};
	return { schema, definition };
}

function assertValid(
	validate: ReturnType<Awaited<ReturnType<typeof validators>>["definition"]>,
	value: unknown,
	code: string,
): void {
	if (!validate(value)) {
		throw new SemanticRepositoryError(code, JSON.stringify(validate.errors));
	}
}

async function repositoryRoot(requested: string): Promise<string> {
	try {
		const candidate = await realpath(resolve(requested));
		return await realpath(gitText(candidate, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new SemanticRepositoryError(
			"REPOSITORY_INVALID",
			"Repository must be a local Git worktree",
		);
	}
}

function withinScope(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function strings(value: unknown): string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function admitProposal(policy: JsonObject, proposal: JsonObject): void {
	const allowedRoots = strings(policy.allowedSourceRoots);
	const allowedCapabilities = new Set(strings(policy.allowedCapabilities));
	const allowedChecks = new Set(
		(Array.isArray(policy.checks) ? policy.checks : []).flatMap((check) =>
			typeof check === "object" && check !== null && typeof check.id === "string" ? [check.id] : [],
		),
	);
	const checkCount = Array.isArray(policy.checks) ? policy.checks.length : 0;
	if (allowedChecks.size !== checkCount) {
		throw new SemanticRepositoryError("POLICY_CHECK_DUPLICATE", "Policy check IDs must be unique");
	}
	const units = Array.isArray(proposal.workUnits) ? (proposal.workUnits as JsonObject[]) : [];
	const admitted = new Set<string>();
	for (const unit of units) {
		const id = unit.id as string;
		if (admitted.has(id)) {
			throw new SemanticRepositoryError("PLAN_WORK_UNIT_DUPLICATE", id);
		}
		for (const dependency of strings(unit.dependencies)) {
			if (!admitted.has(dependency)) {
				throw new SemanticRepositoryError(
					"PLAN_DEPENDENCY_INVALID",
					`${id} depends on unknown or later work unit ${dependency}`,
				);
			}
		}
		for (const sourceScope of strings(unit.allowedSourceScopes)) {
			if (!withinScope(sourceScope, allowedRoots)) {
				throw new SemanticRepositoryError("PLAN_SOURCE_SCOPE_WIDENED", `${id}: ${sourceScope}`);
			}
		}
		for (const capability of strings(unit.capabilities)) {
			if (!allowedCapabilities.has(capability)) {
				throw new SemanticRepositoryError("PLAN_CAPABILITY_WIDENED", `${id}: ${capability}`);
			}
		}
		for (const check of strings(unit.requiredChecks)) {
			if (!allowedChecks.has(check)) {
				throw new SemanticRepositoryError("PLAN_CHECK_UNDECLARED", `${id}: ${check}`);
			}
		}
		const claimIds = new Set<string>();
		for (const claim of Array.isArray(unit.claims) ? (unit.claims as JsonObject[]) : []) {
			const claimId = claim.id as string;
			if (claimIds.has(claimId)) {
				throw new SemanticRepositoryError("PLAN_CLAIM_DUPLICATE", `${id}: ${claimId}`);
			}
			claimIds.add(claimId);
		}
		admitted.add(id);
	}
}

function projectedPolicy(policy: JsonObject, fields: string[]): JsonObject {
	const projection: JsonObject = {};
	for (const field of [
		"policyId",
		"revision",
		"allowedSourceRoots",
		"allowedCapabilities",
	] as const) {
		if (fields.includes(field)) projection[field] = policy[field];
	}
	if (fields.includes("checkIds")) {
		projection.checkIds = (Array.isArray(policy.checks) ? policy.checks : []).flatMap((check) =>
			typeof check === "object" && check !== null && typeof check.id === "string" ? [check.id] : [],
		);
	}
	return projection;
}

async function persistLocalArtifact(repository: string, directory: string, value: unknown) {
	const root = await repositoryReviewStateRoot(repository);
	const targetDirectory = resolve(root, directory);
	if (!targetDirectory.startsWith(`${root}${sep}`)) {
		throw new SemanticRepositoryError("LOCAL_STATE_PATH_INVALID", directory);
	}
	await mkdir(targetDirectory, { recursive: true });
	const digest = sha256Jcs(value);
	const path = resolve(targetDirectory, `${digest}.json`);
	try {
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return { path, digest: hash(value) };
}

async function persistModelContext(repository: string, value: unknown) {
	const root = await repositoryReviewStateRoot(repository);
	const digest = sha256Jcs(value);
	const directory = resolve(root, "model-context", digest);
	if (!directory.startsWith(`${root}${sep}`)) {
		throw new SemanticRepositoryError("LOCAL_STATE_PATH_INVALID", directory);
	}
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = resolve(directory, "request.json");
	try {
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return { path, digest: hash(value) };
}

function projectedBlueprint(blueprint: JsonObject, fields: string[]): JsonObject {
	const projection: JsonObject = {};
	const topology = blueprint.topology as JsonObject;
	if (fields.includes("version")) projection.version = blueprint.version;
	if (fields.includes("hash")) projection.hash = blueprint.hash;
	const projectedTopology: JsonObject = {};
	for (const field of ["nodes", "edges", "subgraphs", "metadata"] as const) {
		if (fields.includes(`topology.${field}`)) projectedTopology[field] = topology?.[field];
	}
	if (Object.keys(projectedTopology).length > 0) projection.topology = projectedTopology;
	return projection;
}

function sdkProposalSchema(artifacts: JsonObject): JsonObject {
	const allDefinitions = artifacts.definitions as JsonObject;
	const definitions = Object.fromEntries(
		[
			"SemanticPlanProposal",
			"SemanticWorkUnit",
			"ClaimDraft",
			"BlueprintPredicate",
			"BlueprintSelector",
			"Identifier",
			"WorkUnitId",
			"RepoPath",
			"BlueprintNodeId",
		].map((name) => [name, structuredClone(allDefinitions[name])]),
	);
	const proposal = structuredClone(definitions.SemanticPlanProposal as JsonObject);
	const output = { ...proposal, definitions } as JsonObject;
	const clean = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) clean(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const record = value as JsonObject;
		delete record.pattern;
		delete record.uniqueItems;
		if (Array.isArray(record.oneOf)) {
			record.anyOf = record.oneOf;
			delete record.oneOf;
		}
		if (record.const !== undefined && record.type === undefined) record.type = typeof record.const;
		for (const child of Object.values(record)) clean(child);
	};
	clean(output);
	return output;
}

async function liveProposal(
	repository: string,
	taskSummary: string,
	policy: JsonObject,
	contextPath: string | undefined,
	authorized: boolean,
	snapshot: Awaited<ReturnType<typeof createRepositoryBlueprintSnapshot>>,
	artifacts: JsonObject,
	definition: Awaited<ReturnType<typeof validators>>["definition"],
	runner: CodexRunner,
	purpose: "plan" | "selective-replan" = "plan",
	selectiveBoundary?: JsonObject,
): Promise<{ proposal: JsonObject; provenance: JsonObject }> {
	if (contextPath === undefined || !authorized) {
		throw new SemanticRepositoryError(
			"MODEL_CONTEXT_UNAUTHORIZED",
			"Live planning requires --context and --authorize-context",
		);
	}
	const manifest = await readJsonFile(contextPath, "MODEL_CONTEXT_INVALID");
	assertValid(definition("ModelContextManifest"), manifest, "MODEL_CONTEXT_INVALID");
	const taskDigest = hash({ taskSummary });
	const policyDigest = hash(policy);
	if (
		(manifest.taskDigest as JsonObject).value !== taskDigest.value ||
		(manifest.policyDigest as JsonObject).value !== policyDigest.value ||
		manifest.purpose !== purpose
	) {
		throw new SemanticRepositoryError("MODEL_CONTEXT_UNAUTHORIZED", "Context digest mismatch");
	}
	const allowedRoots = strings(policy.allowedSourceRoots);
	let contextBytes = 0;
	const sources: Record<string, string> = {};
	for (const sourcePath of strings(manifest.sourcePaths)) {
		if (!withinScope(sourcePath, allowedRoots)) {
			throw new SemanticRepositoryError("MODEL_CONTEXT_UNAUTHORIZED", sourcePath);
		}
		const target = await realpath(resolve(repository, sourcePath));
		if (!target.startsWith(`${repository}${sep}`)) {
			throw new SemanticRepositoryError("MODEL_CONTEXT_UNAUTHORIZED", sourcePath);
		}
		const source = await readFile(target, "utf8");
		const bytes = Buffer.byteLength(source);
		if (bytes > maxContextFileBytes || contextBytes + bytes > maxContextBytes) {
			throw new SemanticRepositoryError("MODEL_CONTEXT_TOO_LARGE", sourcePath);
		}
		contextBytes += bytes;
		sources[sourcePath] = source;
	}
	const request = {
		schema: "graphrefly.stack.semantic-model-request.v1",
		purpose,
		manifest,
		taskSummary,
		policy: projectedPolicy(policy, strings(manifest.policyFields)),
		blueprint: projectedBlueprint(snapshot.blueprint, strings(manifest.blueprintFields)),
		sources,
		...(purpose === "selective-replan" ? { selectiveBoundary } : {}),
	};
	const local = await persistModelContext(repository, request);
	const model = process.env.GRAPHREFLY_STACK_MODEL ?? "gpt-5.6-sol";
	const reasoningEffort = process.env.GRAPHREFLY_STACK_REASONING_EFFORT ?? "high";
	if (!["minimal", "low", "medium", "high", "xhigh"].includes(reasoningEffort)) {
		throw new SemanticRepositoryError("MODEL_REASONING_INVALID", reasoningEffort);
	}
	const response = await runner.run({
		prompt: [
			purpose === "plan"
				? "Propose a typed GraphReFly Stack semantic plan only; never edit files or decide validity."
				: "Replace only the invalid WorkUnits named in request.json; never edit files or decide validity.",
			"Use only request.json. Keep every scope, capability and check within its policy.",
			"Return only JSON matching the provided schema with proposalSource codex.",
		].join("\n"),
		outputSchema: sdkProposalSchema(artifacts),
		workingDirectory: dirname(local.path),
		model,
		reasoningEffort: reasoningEffort as Parameters<CodexRunner["run"]>[0]["reasoningEffort"],
	});
	let proposal: JsonObject;
	try {
		proposal = JSON.parse(response.finalResponse) as JsonObject;
	} catch {
		throw new SemanticRepositoryError("MODEL_PROPOSAL_INVALID", "Provider returned invalid JSON");
	}
	assertValid(definition("SemanticPlanProposal"), proposal, "MODEL_PROPOSAL_INVALID");
	if (proposal.proposalSource !== "codex") {
		throw new SemanticRepositoryError(
			"MODEL_PROPOSAL_INVALID",
			"Live proposal source must be codex",
		);
	}
	const responseDigest = createHash("sha256").update(response.finalResponse).digest("hex");
	const provenance = {
		provider: "codex-sdk",
		model,
		reasoningEffort,
		threadId: response.threadId,
		contextDigest: local.digest,
		responseDigest: { algorithm: "sha256", value: responseDigest },
		outputDigest: hash(proposal),
	};
	await persistLocalArtifact(repository, "live-responses", { response, provenance });
	return { proposal, provenance };
}

async function compatibleFile(path: string, value: unknown): Promise<boolean> {
	try {
		return sha256Jcs(JSON.parse(await readFile(path, "utf8"))) === sha256Jcs(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_INVALID", path);
	}
}

async function acceptArtifacts(repository: string, policy: JsonObject, plan: JsonObject) {
	const policyPath = resolve(repository, SEMANTIC_STORAGE.policy);
	const planDirectory = resolve(repository, SEMANTIC_STORAGE.plans);
	const planPath = resolve(planDirectory, `${plan.planId as string}.json`);
	for (const [path, value] of [
		[policyPath, policy],
		[planPath, plan],
	] as const) {
		try {
			await access(path);
			if (!(await compatibleFile(path, value))) {
				throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_EXISTS", path);
			}
		} catch (error) {
			if (error instanceof SemanticRepositoryError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await mkdir(planDirectory, { recursive: true });
	if (!(await compatibleFile(policyPath, policy))) {
		await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx" });
	}
	if (!(await compatibleFile(planPath, plan))) {
		await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
	}
	return { policyPath, planPath };
}

export async function createSemanticPlan(
	options: {
		repository: string;
		taskSummary: string;
		policyPath: string;
		proposalPath?: string;
		contextPath?: string;
		base?: string;
		mode: "replay" | "live";
		authorizeContext: boolean;
		accept: boolean;
		acceptedBy?: string;
	},
	runner: CodexRunner = new SdkCodexRunner(),
) {
	if (options.taskSummary.length === 0 || options.taskSummary.length > 2048) {
		throw new SemanticRepositoryError(
			"PLAN_TASK_INVALID",
			"--task must contain between 1 and 2048 characters",
		);
	}
	const repository = await repositoryRoot(options.repository);
	const policy = await readJsonFile(options.policyPath, "POLICY_INVALID");
	const { schema, definition } = await validators();
	assertValid(definition("RepositoryPolicy"), policy, "POLICY_INVALID");
	const snapshot = await createRepositoryBlueprintSnapshot({
		repository,
		revision: options.base ?? "HEAD",
	});
	let proposal: JsonObject;
	let provenance: JsonObject | null = null;
	if (options.mode === "live") {
		({ proposal, provenance } = await liveProposal(
			repository,
			options.taskSummary,
			policy,
			options.contextPath,
			options.authorizeContext,
			snapshot,
			schema,
			definition,
			runner,
		));
	} else {
		if (options.proposalPath === undefined) {
			throw new SemanticRepositoryError("PLAN_PROPOSAL_REQUIRED", "Replay requires --proposal");
		}
		proposal = await readJsonFile(options.proposalPath, "PLAN_PROPOSAL_INVALID");
		assertValid(definition("SemanticPlanProposal"), proposal, "PLAN_PROPOSAL_INVALID");
	}
	admitProposal(policy, proposal);
	const admission = {
		baseCommit: snapshot.commit,
		baseBlueprintHash: snapshot.blueprintHash,
		taskDigest: hash({ taskSummary: options.taskSummary }),
		policyDigest: hash(policy),
	};
	const draft = { proposal, admission, provenance };
	const draftArtifact = await persistLocalArtifact(repository, "drafts", draft);
	if (!options.accept) return { repository, draft, draftArtifact };
	if (options.acceptedBy === undefined || options.acceptedBy.trim() === "") {
		throw new SemanticRepositoryError(
			"PLAN_ACCEPTOR_REQUIRED",
			"--accept-by is required with --accept",
		);
	}
	const plan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: proposal.planId,
		taskDigest: admission.taskDigest,
		taskSummary: options.taskSummary,
		baseCommit: admission.baseCommit,
		baseBlueprintHash: admission.baseBlueprintHash,
		policy: {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: admission.policyDigest,
		},
		proposalSource: proposal.proposalSource,
		acceptedBy: { label: options.acceptedBy.trim(), identityVerified: false },
		workUnits: proposal.workUnits,
	};
	assertValid(definition("AcceptedChangePlan"), plan, "PLAN_ACCEPTED_INVALID");
	const paths = await acceptArtifacts(repository, policy, plan);
	return { repository, plan, paths, draftArtifact };
}

function gitResult(repository: string, args: string[], input?: string) {
	return spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		input,
		maxBuffer: 16 * 1024 * 1024,
		shell: false,
	});
}

function gitObject(repository: string, revision: string, path: string): JsonObject {
	const result = gitResult(repository, ["show", `${revision}:${path}`]);
	if (result.status !== 0) {
		throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_MISSING", `${revision}:${path}`);
	}
	try {
		return JSON.parse(result.stdout) as JsonObject;
	} catch {
		throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_INVALID", `${revision}:${path}`);
	}
}

function gitHasObject(repository: string, revision: string, path: string): boolean {
	return gitResult(repository, ["cat-file", "-e", `${revision}:${path}`]).status === 0;
}

function workUnitTrailers(repository: string, revision: string): string[] {
	const message = gitText(repository, ["show", "-s", "--format=%B", revision]);
	const parsed = gitResult(repository, ["interpret-trailers", "--parse"], message);
	if (parsed.status !== 0) throw new SemanticRepositoryError("COMMIT_MESSAGE_INVALID", revision);
	return parsed.stdout.split("\n").flatMap((line) => {
		const separator = line.indexOf(":");
		return separator !== -1 && line.slice(0, separator) === SEMANTIC_STORAGE.workUnitTrailer
			? [line.slice(separator + 1).trim()]
			: [];
	});
}

export async function bindSemanticPlan(options: {
	repository: string;
	planId: string;
	head?: string;
}) {
	if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(options.planId)) {
		throw new SemanticRepositoryError("PLAN_ID_INVALID", options.planId);
	}
	const repository = await repositoryRoot(options.repository);
	const git = new SystemGitAdapter();
	const head = await git.resolveCommit(repository, options.head ?? "HEAD");
	const planPath = `${SEMANTIC_STORAGE.plans}/${options.planId}.json`;
	const replanPath = `${SEMANTIC_STORAGE.plans}/${options.planId}.replan.json`;
	const plan = gitObject(repository, head.value, planPath);
	const policy = gitObject(repository, head.value, SEMANTIC_STORAGE.policy);
	const { definition } = await validators();
	assertValid(definition("AcceptedChangePlan"), plan, "PLAN_ACCEPTED_INVALID");
	assertValid(definition("RepositoryPolicy"), policy, "POLICY_INVALID");
	const selectiveReplan = gitHasObject(repository, head.value, replanPath)
		? gitObject(repository, head.value, replanPath)
		: undefined;
	if (selectiveReplan !== undefined) {
		assertValid(definition("SelectiveReplan"), selectiveReplan, "SELECTIVE_REPLAN_INVALID");
		if (selectiveReplan.replacementPlanId !== options.planId) {
			throw new SemanticRepositoryError("SELECTIVE_REPLAN_INVALID", options.planId);
		}
	}
	if (
		(plan.policy as JsonObject).digest === undefined ||
		((plan.policy as JsonObject).digest as JsonObject).value !== sha256Jcs(policy)
	) {
		throw new SemanticRepositoryError("POLICY_MISMATCH", options.planId);
	}
	const base = (plan.baseCommit as { value: string }).value;
	if (base === head.value || gitText(repository, ["merge-base", base, head.value]) !== base) {
		throw new SemanticRepositoryError("PLAN_HISTORY_INVALID", "Plan base must precede head");
	}
	const firstParent = gitText(repository, [
		"rev-list",
		"--reverse",
		"--first-parent",
		`${base}..${head.value}`,
	])
		.split("\n")
		.filter(Boolean);
	const ancestry = gitText(repository, [
		"rev-list",
		"--reverse",
		"--ancestry-path",
		`${base}..${head.value}`,
	])
		.split("\n")
		.filter(Boolean);
	if (firstParent.join("\n") !== ancestry.join("\n")) {
		throw new SemanticRepositoryError(
			"PLAN_HISTORY_INVALID",
			"Implementation history must be linear",
		);
	}
	let expectedParent = base;
	for (const revision of firstParent) {
		const parents = gitText(repository, ["show", "-s", "--format=%P", revision]).split(" ");
		if (parents.length !== 1 || parents[0] !== expectedParent) {
			throw new SemanticRepositoryError("PLAN_HISTORY_INVALID", revision);
		}
		expectedParent = revision;
	}
	let acceptanceCommit: string | null = null;
	let implementation = [...firstParent];
	if (!gitHasObject(repository, base, planPath)) {
		const acceptanceIndex = implementation.findIndex((candidate) =>
			gitHasObject(repository, candidate, planPath),
		);
		if (acceptanceIndex === -1) {
			throw new SemanticRepositoryError("PLAN_ACCEPTANCE_COMMIT_MISSING", options.planId);
		}
		const candidate = implementation[acceptanceIndex] as string;
		for (const concurrent of implementation.slice(0, acceptanceIndex)) {
			if (workUnitTrailers(repository, concurrent).length !== 0) {
				throw new SemanticRepositoryError("PLAN_ACCEPTANCE_COMMIT_MIXED", concurrent);
			}
		}
		const acceptedPlan = gitObject(repository, candidate, planPath);
		const acceptedPolicy = gitObject(repository, candidate, SEMANTIC_STORAGE.policy);
		if (
			sha256Jcs(acceptedPlan) !== sha256Jcs(plan) ||
			sha256Jcs(acceptedPolicy) !== sha256Jcs(policy) ||
			(selectiveReplan !== undefined &&
				(!gitHasObject(repository, candidate, replanPath) ||
					sha256Jcs(gitObject(repository, candidate, replanPath)) !== sha256Jcs(selectiveReplan)))
		) {
			throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_CHANGED", candidate);
		}
		const changed = await git.changedPaths(
			repository,
			await git.resolveCommit(repository, candidate),
		);
		if (
			changed.some(
				(path) => path !== planPath && path !== SEMANTIC_STORAGE.policy && path !== replanPath,
			)
		) {
			throw new SemanticRepositoryError("PLAN_ACCEPTANCE_COMMIT_MIXED", candidate);
		}
		if (workUnitTrailers(repository, candidate).length !== 0) {
			throw new SemanticRepositoryError("PLAN_ACCEPTANCE_COMMIT_MIXED", candidate);
		}
		acceptanceCommit = candidate;
		implementation = implementation.slice(acceptanceIndex + 1);
	} else if (sha256Jcs(gitObject(repository, base, planPath)) !== sha256Jcs(plan)) {
		throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_CHANGED", base);
	}
	const units = plan.workUnits as JsonObject[];
	admitProposal(policy, { workUnits: units });
	const invalidUnitIds = new Set(
		selectiveReplan === undefined
			? units.map((unit) => unit.id as string)
			: strings(selectiveReplan.invalidUnits),
	);
	const preservedUnitIds = new Set(
		selectiveReplan === undefined ? [] : strings(selectiveReplan.preservedUnits),
	);
	if (
		invalidUnitIds.size + preservedUnitIds.size !== units.length ||
		units.some(
			(unit) =>
				(!invalidUnitIds.has(unit.id as string) && !preservedUnitIds.has(unit.id as string)) ||
				(invalidUnitIds.has(unit.id as string) && preservedUnitIds.has(unit.id as string)),
		)
	) {
		throw new SemanticRepositoryError("SELECTIVE_REPLAN_INVALID", "Invalid unit partition");
	}
	if (implementation.length !== invalidUnitIds.size) {
		throw new SemanticRepositoryError(
			"WORK_UNIT_COMMIT_COUNT_MISMATCH",
			`${implementation.length} commits for ${invalidUnitIds.size} replacement work units`,
		);
	}
	const byId = new Map(
		units
			.filter((unit) => invalidUnitIds.has(unit.id as string))
			.map((unit) => [unit.id as string, unit]),
	);
	const seen = new Set(preservedUnitIds);
	let bindings: JsonObject[] = [];
	for (const revision of implementation) {
		const trailers = workUnitTrailers(repository, revision);
		if (trailers.length === 0) {
			throw new SemanticRepositoryError("WORK_UNIT_TRAILER_MISSING", revision);
		}
		if (trailers.length !== 1) {
			throw new SemanticRepositoryError("WORK_UNIT_TRAILER_DUPLICATE", revision);
		}
		const workUnitId = trailers[0] as string;
		const unit = byId.get(workUnitId);
		if (unit === undefined) throw new SemanticRepositoryError("WORK_UNIT_UNKNOWN", workUnitId);
		if (seen.has(workUnitId)) throw new SemanticRepositoryError("WORK_UNIT_DUPLICATE", workUnitId);
		for (const dependency of strings(unit.dependencies)) {
			if (!seen.has(dependency)) {
				throw new SemanticRepositoryError(
					"WORK_UNIT_ORDER_INVALID",
					`${workUnitId}: ${dependency}`,
				);
			}
		}
		const commit = await git.resolveCommit(repository, revision);
		const parentCommit = await git.parent(repository, commit);
		if (parentCommit === null) throw new SemanticRepositoryError("PLAN_HISTORY_INVALID", revision);
		const diff = await git.canonicalDiff(repository, commit);
		const binding = {
			schema: "graphrefly.stack.semantic-binding.v1",
			planId: options.planId,
			workUnitId,
			commit,
			parentCommit,
			trailer: { name: SEMANTIC_STORAGE.workUnitTrailer, value: workUnitId, occurrences: 1 },
			stablePatchId: await git.stablePatchId(repository, commit),
			diffDigest: {
				algorithm: "sha256",
				value: createHash("sha256").update(diff).digest("hex"),
			},
			changedPaths: await git.changedPaths(repository, commit),
		};
		assertValid(definition("CommitWorkUnitBinding"), binding, "COMMIT_BINDING_INVALID");
		bindings.push(binding);
		seen.add(workUnitId);
	}
	if (selectiveReplan !== undefined) {
		const sourcePlanId = selectiveReplan.sourcePlanId as string;
		if (sourcePlanId === options.planId) {
			throw new SemanticRepositoryError("SELECTIVE_REPLAN_INVALID", "Source and replacement match");
		}
		const sourcePlan = gitObject(
			repository,
			base,
			`${SEMANTIC_STORAGE.plans}/${sourcePlanId}.json`,
		);
		assertValid(definition("AcceptedChangePlan"), sourcePlan, "PLAN_ACCEPTED_INVALID");
		const sourceUnits = new Map(
			(sourcePlan.workUnits as JsonObject[]).map((unit) => [unit.id as string, unit]),
		);
		for (const unit of units) {
			if (
				preservedUnitIds.has(unit.id as string) &&
				sha256Jcs(sourceUnits.get(unit.id as string)) !== sha256Jcs(unit)
			) {
				throw new SemanticRepositoryError(
					"REPLAN_BOUNDARY_WIDENED",
					`Preserved WorkUnit changed: ${unit.id as string}`,
				);
			}
		}
		const source = await bindSemanticPlan({
			repository,
			planId: sourcePlanId,
			head: base,
		});
		const sourceBindings = new Map(
			(source.bindings as JsonObject[]).map((binding) => [binding.workUnitId as string, binding]),
		);
		const replacementBindings = new Map(
			bindings.map((binding) => [binding.workUnitId as string, binding]),
		);
		bindings = units.map((unit) => {
			const workUnitId = unit.id as string;
			if (invalidUnitIds.has(workUnitId)) return replacementBindings.get(workUnitId) as JsonObject;
			const sourceBinding = sourceBindings.get(workUnitId);
			if (sourceBinding === undefined) {
				throw new SemanticRepositoryError("COMMIT_BINDING_MISMATCH", workUnitId);
			}
			const rebound = { ...sourceBinding, planId: options.planId };
			assertValid(definition("CommitWorkUnitBinding"), rebound, "COMMIT_BINDING_INVALID");
			return rebound;
		});
	}
	const patchIds = bindings.map((binding) => binding.stablePatchId as string);
	if (new Set(patchIds).size !== patchIds.length) {
		throw new SemanticRepositoryError(
			"PATCH_ID_AMBIGUOUS",
			"More than one WorkUnit resolved to the same stable patch-id",
		);
	}
	const bundle = {
		schema: "graphrefly.stack.semantic-bindings.v1",
		planId: options.planId,
		head,
		acceptanceCommit,
		bindings,
	};
	const artifact = await persistLocalArtifact(repository, `bindings/${options.planId}`, bundle);
	return { repository, ...bundle, artifact };
}

export type PredicateEvaluation = {
	ok: boolean;
	reason?:
		| "PREDICATE_SELECTOR_AMBIGUOUS"
		| "PREDICATE_UNSUPPORTED"
		| "BLUEPRINT_PREDICATE_UNSATISFIED";
	witnessDigest?: { algorithm: "sha256"; value: string };
};

function topologyFacts(blueprint: JsonObject) {
	const nodes: JsonObject[] = [];
	const edges: JsonObject[] = [];
	const subgraphs: { mountPath: string[]; value: JsonObject }[] = [];
	const visit = (value: unknown, mountPath: string[]) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		const topology = value as JsonObject;
		for (const node of Array.isArray(topology.nodes) ? topology.nodes : []) {
			if (typeof node === "object" && node !== null && !Array.isArray(node)) {
				nodes.push(node as JsonObject);
			}
		}
		for (const edge of Array.isArray(topology.edges) ? topology.edges : []) {
			if (typeof edge === "object" && edge !== null && !Array.isArray(edge)) {
				edges.push(edge as JsonObject);
			}
		}
		for (const child of Array.isArray(topology.subgraphs) ? topology.subgraphs : []) {
			if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
			const subgraph = child as JsonObject;
			if (typeof subgraph.mountId !== "string") continue;
			const childPath = [...mountPath, subgraph.mountId];
			subgraphs.push({ mountPath: childPath, value: subgraph });
			visit(subgraph, childPath);
		}
	};
	visit(blueprint.topology, []);
	return { nodes, edges, subgraphs };
}

function selectorMatches(
	facts: ReturnType<typeof topologyFacts>,
	selector: JsonObject,
): JsonObject[] {
	if (selector.kind === "node") {
		return facts.nodes.filter((node) => node.id === selector.nodeId);
	}
	if (selector.kind === "edge") {
		return facts.edges.filter(
			(edge) => edge.from === selector.fromNodeId && edge.to === selector.toNodeId,
		);
	}
	if (selector.kind === "subgraph") {
		return facts.subgraphs
			.filter(
				(subgraph) => JSON.stringify(subgraph.mountPath) === JSON.stringify(selector.mountPath),
			)
			.map((subgraph) => subgraph.value);
	}
	return [];
}

function evaluatePredicate(blueprint: JsonObject, predicate: JsonObject): PredicateEvaluation {
	const facts = topologyFacts(blueprint);
	if (predicate.operator === "depends-on") {
		const nodes = facts.nodes.filter((node) => node.id === predicate.fromNodeId);
		const targets = facts.nodes.filter((node) => node.id === predicate.toNodeId);
		if (nodes.length > 1 || targets.length > 1) {
			return { ok: false, reason: "PREDICATE_SELECTOR_AMBIGUOUS" };
		}
		const edge = facts.edges.filter(
			(candidate) => candidate.from === predicate.fromNodeId && candidate.to === predicate.toNodeId,
		);
		if (edge.length > 1) return { ok: false, reason: "PREDICATE_SELECTOR_AMBIGUOUS" };
		const dependency =
			nodes.length === 1 &&
			targets.length === 1 &&
			(strings(nodes[0]?.deps).includes(predicate.toNodeId as string) || edge.length === 1);
		if (!dependency) return { ok: false, reason: "BLUEPRINT_PREDICATE_UNSATISFIED" };
		return {
			ok: true,
			witnessDigest: hash({
				predicate,
				witness: { from: predicate.fromNodeId, to: predicate.toNodeId },
			}),
		};
	}
	const rawSelector = predicate.selector;
	if (typeof rawSelector !== "object" || rawSelector === null || Array.isArray(rawSelector)) {
		return { ok: false, reason: "PREDICATE_UNSUPPORTED" };
	}
	const selector = rawSelector as JsonObject;
	const matches = selectorMatches(facts, selector);
	if (matches.length > 1) return { ok: false, reason: "PREDICATE_SELECTOR_AMBIGUOUS" };
	if (predicate.operator === "present" || predicate.operator === "absent") {
		const satisfied =
			predicate.operator === "present" ? matches.length === 1 : matches.length === 0;
		if (!satisfied) return { ok: false, reason: "BLUEPRINT_PREDICATE_UNSATISFIED" };
		return {
			ok: true,
			witnessDigest: hash({
				predicate,
				witness:
					matches.length === 0
						? { absent: true, selector }
						: selector.kind === "node"
							? { kind: "node", nodeId: selector.nodeId }
							: selector.kind === "edge"
								? {
										kind: "edge",
										fromNodeId: selector.fromNodeId,
										toNodeId: selector.toNodeId,
									}
								: { kind: "subgraph", mountPath: selector.mountPath },
			}),
		};
	}
	if (predicate.operator === "metadata-equals") {
		if ((selector as JsonObject).kind !== "node") {
			return { ok: false, reason: "PREDICATE_UNSUPPORTED" };
		}
		const metadata = matches[0]?.meta;
		const satisfied =
			matches.length === 1 &&
			typeof metadata === "object" &&
			metadata !== null &&
			!Array.isArray(metadata) &&
			Object.hasOwn(metadata, predicate.key as string) &&
			(metadata as JsonObject)[predicate.key as string] === predicate.value;
		if (!satisfied) return { ok: false, reason: "BLUEPRINT_PREDICATE_UNSATISFIED" };
		return {
			ok: true,
			witnessDigest: hash({
				predicate,
				witness: {
					nodeId: (selector as JsonObject).nodeId,
					key: predicate.key,
					value: predicate.value,
				},
			}),
		};
	}
	return { ok: false, reason: "PREDICATE_UNSUPPORTED" };
}

export function evaluateSemanticPredicate(
	blueprint: Record<string, unknown>,
	predicate: Record<string, unknown>,
): PredicateEvaluation {
	return evaluatePredicate(blueprint, predicate);
}

async function fileIdentity(path: string): Promise<JsonObject | undefined> {
	try {
		const canonical = await realpath(path);
		return {
			path: canonical,
			digest: createHash("sha256")
				.update(await readFile(canonical))
				.digest("hex"),
		};
	} catch {
		return undefined;
	}
}

async function policyCheckExecutionIdentity(
	repository: string,
	check: JsonObject,
): Promise<JsonObject> {
	const argv = strings(check.argv);
	const executable = argv[0] as string;
	let executableIdentity: JsonObject | undefined;
	if (executable.includes("/")) {
		executableIdentity = await fileIdentity(
			executable.startsWith("/") ? executable : resolve(repository, executable),
		);
	} else {
		for (const directory of (process.env.PATH ?? "").split(":")) {
			const candidate = resolve(directory, executable);
			const identity = await fileIdentity(candidate);
			if (identity !== undefined) {
				executableIdentity = identity;
				break;
			}
		}
	}
	const absoluteArguments: JsonObject[] = [];
	for (const argument of argv.slice(1)) {
		if (!argument.startsWith("/")) continue;
		const identity = await fileIdentity(argument);
		if (identity !== undefined) absoluteArguments.push(identity);
	}
	let nodeModules: JsonObject | null = null;
	try {
		const root = await realpath(resolve(repository, "node_modules"));
		const metadata = await Promise.all(
			[".modules.yaml", ".package-lock.json"].map(async (name) => {
				try {
					return {
						name,
						digest: createHash("sha256")
							.update(await readFile(resolve(root, name)))
							.digest("hex"),
					};
				} catch {
					return undefined;
				}
			}),
		);
		nodeModules = { root, metadata: metadata.filter((entry) => entry !== undefined) };
	} catch {
		// A dependency-free check can execute without an installed package tree.
	}
	return {
		executable: executableIdentity ?? null,
		absoluteArguments,
		nodeModules,
	};
}

export async function runRepositoryPolicyChecks(
	repository: string,
	head: string,
	policy: JsonObject,
	requiredIds: readonly string[],
): Promise<JsonObject[]> {
	return (await runRepositoryPolicyChecksWithCacheReport(repository, head, policy, requiredIds))
		.results;
}

export async function runRepositoryPolicyChecksWithCacheReport(
	repository: string,
	head: string,
	policy: JsonObject,
	requiredIds: readonly string[],
): Promise<{
	results: JsonObject[];
	executions: Array<{ checkId: string; execution: "executed" | "cache-hit" }>;
}> {
	const stableOutput = (value: string | null | undefined, worktree: string) =>
		(value ?? "")
			.replaceAll("\r\n", "\n")
			.replaceAll(worktree, "<detached-worktree>")
			.split("\n")
			.filter(
				(line) =>
					!/^(?:[^A-Za-z0-9]*)(?:duration_ms|duration)\s+[0-9]+(?:\.[0-9]+)?\s*$/iu.test(line),
			)
			.join("\n");
	const declared = new Map(
		(Array.isArray(policy.checks) ? (policy.checks as JsonObject[]) : []).map((check) => [
			check.id as string,
			check,
		]),
	);
	const resolvedHead = gitText(repository, ["rev-parse", `${head}^{commit}`]);
	const sandbox =
		process.platform === "darwin"
			? "sandbox-exec-v1"
			: process.platform === "linux"
				? await access("/usr/bin/bwrap")
						.then(() => "bwrap-v1")
						.catch(() => "unavailable")
				: "unavailable";
	const resultsById = new Map<string, JsonObject>();
	const executions: Array<{ checkId: string; execution: "executed" | "cache-hit" }> = [];
	const misses: Array<{ checkId: string; check: JsonObject; cacheInput: JsonObject }> = [];
	try {
		for (const checkId of requiredIds) {
			const check = declared.get(checkId);
			if (check === undefined) continue;
			const cacheInput: JsonObject = {
				revision: 1,
				head: resolvedHead,
				tree: gitText(repository, ["show", "-s", "--format=%T", resolvedHead]),
				parents: gitText(repository, ["show", "-s", "--format=%P", resolvedHead])
					.split(" ")
					.filter(Boolean),
				policyDigest: sha256Jcs(policy),
				check,
				executionEnvironment: await policyCheckExecutionIdentity(repository, check),
				runner: {
					revision: 1,
					sandbox,
					nodeVersion: process.version,
					platform: process.platform,
					arch: process.arch,
					path: process.env.PATH ?? "",
				},
			};
			const cached = await readDagExecutionCache(repository, "policy-checks", cacheInput);
			if (cached.hit) {
				if (
					typeof cached.value !== "object" ||
					cached.value === null ||
					Array.isArray(cached.value)
				) {
					throw new DagExecutionCacheError("Cached policy check result must be an object");
				}
				const result = cached.value as JsonObject;
				const expectedCommandDigest = hash({
					argv: strings(check.argv),
					network: false,
					shell: false,
				});
				if (
					Object.keys(result).sort().join("\0") !==
						["checkId", "commandDigest", "exitCode", "schema", "stderrDigest", "stdoutDigest"]
							.sort()
							.join("\0") ||
					result.schema !== "graphrefly.stack.semantic-check-result.v1" ||
					result.checkId !== checkId ||
					sha256Jcs(result.commandDigest) !== sha256Jcs(expectedCommandDigest) ||
					!Number.isInteger(result.exitCode) ||
					![result.stdoutDigest, result.stderrDigest].every(
						(value) =>
							typeof value === "object" &&
							value !== null &&
							(value as JsonObject).algorithm === "sha256" &&
							typeof (value as JsonObject).value === "string" &&
							/^[0-9a-f]{64}$/u.test((value as JsonObject).value as string),
					)
				) {
					throw new DagExecutionCacheError("Cached policy check result is invalid");
				}
				resultsById.set(checkId, result);
				executions.push({ checkId, execution: "cache-hit" });
			} else {
				misses.push({ checkId, check, cacheInput });
			}
		}
	} catch (error) {
		if (error instanceof DagExecutionCacheError) {
			throw new SemanticRepositoryError("EXECUTION_CACHE_INVALID", error.message);
		}
		throw error;
	}
	if (misses.length === 0) {
		return {
			results: requiredIds.flatMap((checkId) => {
				const result = resultsById.get(checkId);
				return result === undefined ? [] : [result];
			}),
			executions,
		};
	}
	const root = await mkdtemp(resolve(dirname(repository), ".graphrefly-stack-check-"));
	const worktree = resolve(root, "checkout");
	const scratch = resolve(root, "tmp");
	let added = false;
	try {
		await mkdir(scratch);
		gitText(repository, ["worktree", "add", "--detach", "--force", worktree, head]);
		added = true;
		try {
			const modules = await realpath(resolve(repository, "node_modules"));
			await symlink(modules, resolve(worktree, "node_modules"), "dir");
		} catch {
			// Dependency-free checks remain valid; package checks fail closed if install state is absent.
		}
		for (const { checkId, check, cacheInput } of misses) {
			const argv = strings(check.argv);
			const command: string[] | undefined =
				process.platform === "darwin"
					? [
							"/usr/bin/sandbox-exec",
							"-p",
							`(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(scratch)}))`,
							...argv,
						]
					: process.platform === "linux"
						? await access("/usr/bin/bwrap")
								.then(() => [
									"/usr/bin/bwrap",
									"--unshare-net",
									"--die-with-parent",
									"--ro-bind",
									"/",
									"/",
									"--dev",
									"/dev",
									"--proc",
									"/proc",
									"--bind",
									scratch,
									scratch,
									"--chdir",
									worktree,
									"--",
									...argv,
								])
								.catch(() => undefined)
						: undefined;
			if (command === undefined) {
				const result = {
					schema: "graphrefly.stack.semantic-check-result.v1",
					checkId,
					commandDigest: hash({ argv, network: false, shell: false }),
					exitCode: 255,
					stdoutDigest: hash(""),
					stderrDigest: hash("network sandbox unavailable"),
				};
				resultsById.set(checkId, result);
				await writeDagExecutionCache(repository, "policy-checks", cacheInput, result);
				executions.push({ checkId, execution: "executed" });
				continue;
			}
			const result = spawnSync(command[0] as string, command.slice(1), {
				cwd: worktree,
				encoding: "utf8",
				env: {
					CI: "1",
					HOME: scratch,
					NO_PROXY: "*",
					PATH: process.env.PATH,
					TMPDIR: scratch,
					XDG_CACHE_HOME: scratch,
					npm_config_offline: "true",
				},
				maxBuffer: 4 * 1024 * 1024,
				shell: false,
				timeout: check.timeoutMs as number,
			});
			const checkResult = {
				schema: "graphrefly.stack.semantic-check-result.v1",
				checkId,
				commandDigest: hash({ argv, network: false, shell: false }),
				exitCode: result.status ?? 255,
				stdoutDigest: hash(stableOutput(result.stdout, worktree)),
				stderrDigest: hash(stableOutput(result.stderr ?? result.error?.message, worktree)),
			};
			resultsById.set(checkId, checkResult);
			await writeDagExecutionCache(repository, "policy-checks", cacheInput, checkResult);
			executions.push({ checkId, execution: "executed" });
		}
		return {
			results: requiredIds.flatMap((checkId) => {
				const result = resultsById.get(checkId);
				return result === undefined ? [] : [result];
			}),
			executions,
		};
	} catch (error) {
		if (error instanceof DagExecutionCacheError) {
			throw new SemanticRepositoryError("EXECUTION_CACHE_INVALID", error.message);
		}
		throw error;
	} finally {
		try {
			if (added) gitText(repository, ["worktree", "remove", "--force", worktree]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
}

async function priorGateBundle(repository: string, planId: string, bindings: JsonObject[]) {
	const root = await repositoryReviewStateRoot(repository);
	const directory = resolve(root, "gates", planId);
	let entries: string[];
	try {
		entries = (await readdir(directory)).filter((entry) => entry.endsWith(".json")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const currentPatches = new Map(
		bindings.map((binding) => [binding.workUnitId as string, binding.stablePatchId as string]),
	);
	const currentCommits = new Map(
		bindings.map((binding) => [
			binding.workUnitId as string,
			(binding.commit as JsonObject).value as string,
		]),
	);
	let best: { exact: number; score: number; digest: string; value: JsonObject } | undefined;
	for (const entry of entries) {
		let value: JsonObject;
		try {
			value = JSON.parse(await readFile(resolve(directory, entry), "utf8")) as JsonObject;
		} catch {
			continue;
		}
		if (entry !== `${sha256Jcs(value)}.json`) {
			throw new SemanticRepositoryError("ARTIFACT_HASH_MISMATCH", entry);
		}
		const input = value.input as JsonObject | undefined;
		const priorBindings = Array.isArray(input?.bindings) ? (input.bindings as JsonObject[]) : [];
		const score = priorBindings.filter(
			(binding) =>
				currentPatches.get(binding.workUnitId as string) === (binding.stablePatchId as string),
		).length;
		const exact = priorBindings.filter(
			(binding) =>
				currentCommits.get(binding.workUnitId as string) ===
				((binding.commit as JsonObject | undefined)?.value as string | undefined),
		).length;
		if (
			best === undefined ||
			exact > best.exact ||
			(exact === best.exact && score > best.score) ||
			(exact === best.exact && score === best.score && entry < best.digest)
		) {
			best = { exact, score, digest: entry, value };
		}
	}
	return best?.score === 0 ? undefined : best?.value;
}

function orderedReasons(reasons: Iterable<string>): string[] {
	const values = new Set(reasons);
	return SEMANTIC_REASON_ORDER.filter((reason) => values.has(reason));
}

export async function createSemanticGate(options: {
	repository: string;
	planId: string;
	head?: string;
}) {
	const bound = await bindSemanticPlan(options);
	const repository = bound.repository;
	const head = bound.head.value;
	const planPath = `${SEMANTIC_STORAGE.plans}/${options.planId}.json`;
	const plan = gitObject(repository, head, planPath);
	const policy = gitObject(repository, head, SEMANTIC_STORAGE.policy);
	const { definition } = await validators();
	assertValid(definition("AcceptedChangePlan"), plan, "PLAN_ACCEPTED_INVALID");
	assertValid(definition("RepositoryPolicy"), policy, "POLICY_INVALID");
	const bindings = bound.bindings as JsonObject[];
	const prior = await priorGateBundle(repository, options.planId, bindings);
	const priorInput = prior?.input as JsonObject | undefined;
	if (prior !== undefined) {
		const priorResult = prior.gateResult as JsonObject | undefined;
		if (priorResult === undefined) {
			throw new SemanticRepositoryError("ARTIFACT_HASH_MISMATCH", options.planId);
		}
		assertValid(definition("GateInput"), priorInput, "ARTIFACT_HASH_MISMATCH");
		assertValid(definition("GateResult"), priorResult, "ARTIFACT_HASH_MISMATCH");
		if ((priorResult.inputDigest as JsonObject).value !== sha256Jcs(priorInput)) {
			throw new SemanticRepositoryError("ARTIFACT_HASH_MISMATCH", options.planId);
		}
	}
	const priorBindings = new Map(
		(Array.isArray(priorInput?.bindings) ? (priorInput.bindings as JsonObject[]) : []).map(
			(binding) => [binding.workUnitId as string, binding],
		),
	);
	const priorRecords = new Map(
		(Array.isArray(priorInput?.records) ? (priorInput.records as JsonObject[]) : []).map(
			(record) => [record.workUnitId as string, record],
		),
	);
	const units = plan.workUnits as JsonObject[];
	const planPolicy = plan.policy as JsonObject;
	const policyDigest = hash(policy);
	const policyMatches =
		planPolicy.policyId === policy.policyId &&
		planPolicy.revision === policy.revision &&
		(planPolicy.digest as JsonObject)?.value === policyDigest.value;
	const requiredIds = [...new Set(units.flatMap((unit) => strings(unit.requiredChecks)))];
	const declaredChecks = new Set(
		(Array.isArray(policy.checks) ? (policy.checks as JsonObject[]) : []).map(
			(check) => check.id as string,
		),
	);
	const checks = policyMatches
		? await runRepositoryPolicyChecks(repository, head, policy, requiredIds)
		: [];
	for (const check of checks) assertValid(definition("CheckResult"), check, "CHECK_RESULT_INVALID");
	const checkById = new Map(checks.map((check) => [check.checkId as string, check]));
	const records: JsonObject[] = [];
	const results: JsonObject[] = [];
	const invalid = new Set<string>();
	let semanticParentRecordId: string | null = null;
	for (const unit of units) {
		const workUnitId = unit.id as string;
		const binding = bindings.find((candidate) => candidate.workUnitId === workUnitId);
		const reasons = new Set<string>();
		const invalidDependencies = strings(unit.dependencies).filter((dependency) =>
			invalid.has(dependency),
		);
		if (invalidDependencies.length > 0) reasons.add("DEPENDENCY_INVALID");
		if (!policyMatches) reasons.add("POLICY_REVISION_STALE");
		if (binding === undefined) reasons.add("COMMIT_BINDING_MISMATCH");
		if (
			binding !== undefined &&
			strings(binding.changedPaths).some(
				(path) => !withinScope(path, strings(unit.allowedSourceScopes)),
			)
		) {
			reasons.add("SOURCE_SCOPE_VIOLATION");
		}
		const witnesses: JsonObject[] = [];
		if (binding !== undefined && reasons.size === 0) {
			const snapshot = await createRepositoryBlueprintSnapshot({
				repository,
				revision: (binding.commit as JsonObject).value as string,
			});
			for (const claim of unit.claims as JsonObject[]) {
				const evaluation = evaluatePredicate(snapshot.blueprint, claim.predicate as JsonObject);
				if (!evaluation.ok) {
					reasons.add(evaluation.reason as string);
					continue;
				}
				witnesses.push({
					claimId: claim.id,
					predicateDigest: evaluation.witnessDigest,
					status: "satisfied",
				});
			}
			const priorBinding = priorBindings.get(workUnitId);
			const priorRecord = priorRecords.get(workUnitId);
			const stableRebind =
				priorBinding?.stablePatchId === binding.stablePatchId && priorRecord !== undefined;
			if (stableRebind && reasons.size === 0) {
				const priorWitnesses = priorRecord.claimWitnesses as JsonObject[];
				if (sha256Jcs(priorWitnesses) !== sha256Jcs(witnesses)) {
					reasons.add("BLUEPRINT_WITNESS_STALE");
				}
			}
			for (const checkId of strings(unit.requiredChecks)) {
				if (!declaredChecks.has(checkId)) reasons.add("REQUIRED_CHECK_UNDECLARED");
				else if (!checkById.has(checkId)) reasons.add("REQUIRED_CHECK_MISSING");
				else if (checkById.get(checkId)?.exitCode !== 0) reasons.add("REQUIRED_CHECK_FAILED");
			}
			if (reasons.size === 0) {
				const priorCommit = (priorBinding?.commit as JsonObject | undefined)?.value;
				const currentCommit = (binding.commit as JsonObject).value;
				const rebindFrom =
					priorRecord === undefined || priorCommit === currentCommit
						? ((priorRecord?.rebindFrom as string | null | undefined) ?? null)
						: (priorRecord.recordId as string);
				const recordBody: JsonObject = {
					schema: "graphrefly.stack.semantic-record.v1",
					planId: options.planId,
					workUnitId,
					bindingDigest: hash(binding),
					semanticParentRecordId,
					policyDigest,
					blueprintHash: snapshot.blueprintHash,
					sourceScopeDigest: hash(strings(binding.changedPaths)),
					claimWitnesses: witnesses,
					requiredChecks: unit.requiredChecks,
					rebindFrom,
				};
				const record: JsonObject = {
					...recordBody,
					recordId: `record-${sha256Jcs(recordBody).slice(0, 24)}`,
				};
				assertValid(definition("SemanticChangeRecord"), record, "SEMANTIC_RECORD_INVALID");
				records.push(record);
				semanticParentRecordId = record.recordId as string;
			}
		}
		if (reasons.size > 0) invalid.add(workUnitId);
		const reasonCodes = orderedReasons(reasons);
		results.push({
			workUnitId,
			verdict: reasonCodes.length === 0 ? "valid" : "invalid",
			reasonCodes,
			invalidDependencies,
			recordId:
				reasonCodes.length === 0
					? ((records.find((record) => record.workUnitId === workUnitId)?.recordId as string) ??
						null)
					: null,
		});
	}
	const current = await createRepositoryBlueprintSnapshot({ repository, revision: head });
	const input = {
		schema: "graphrefly.stack.semantic-gate-input.v1",
		policy,
		plan,
		bindings,
		records,
		currentBlueprintHash: current.blueprintHash,
		checks,
	};
	assertValid(definition("GateInput"), input, "GATE_INPUT_INVALID");
	const errorReasons = new Set([
		"SCHEMA_INVALID",
		"PLAN_NOT_ACCEPTED",
		"POLICY_MISMATCH",
		"COMMIT_BINDING_MISMATCH",
		"PATCH_ID_AMBIGUOUS",
		"PREDICATE_SELECTOR_AMBIGUOUS",
		"PREDICATE_UNSUPPORTED",
		"ARTIFACT_HASH_MISMATCH",
	]);
	const allReasons = results.flatMap((result) => strings(result.reasonCodes));
	const verdict =
		allReasons.length === 0
			? "pass"
			: allReasons.some((reason) => errorReasons.has(reason))
				? "error"
				: "blocked";
	const gateResult = {
		schema: "graphrefly.stack.semantic-gate-result.v1",
		gateVersion: "v1",
		inputDigest: hash(input),
		verdict,
		units: results,
		checkIds: requiredIds,
	};
	assertValid(definition("GateResult"), gateResult, "GATE_RESULT_INVALID");
	const bundle = {
		schema: "graphrefly.stack.semantic-gate-bundle.v1",
		head: bound.head,
		input,
		gateResult,
	};
	const artifact = await persistLocalArtifact(repository, `gates/${options.planId}`, bundle);
	return { repository, head: bound.head, input, gateResult, artifact };
}

export async function createSemanticRepositoryReview(options: {
	repository: string;
	planId: string;
	base: string;
	head: string;
}) {
	const review = await createRepositoryReview({
		repository: options.repository,
		base: options.base,
		head: options.head,
	});
	const gate = await createSemanticGate({
		repository: options.repository,
		planId: options.planId,
		head: options.head,
	});
	const gateUnits = gate.gateResult.units as JsonObject[];
	const semanticReview = {
		...review,
		semanticStatus: "evaluated" as const,
		semantic: {
			plan: gate.input.plan,
			bindings: gate.input.bindings,
			records: gate.input.records,
			checks: gate.input.checks,
			gateResult: gate.gateResult,
			invalidWorkUnitIds: gateUnits
				.filter((unit) => unit.verdict === "invalid")
				.map((unit) => unit.workUnitId as string),
		},
	};
	await validateRepositoryReview(semanticReview);
	return semanticReview;
}

export async function replanSemanticPlan(
	options: {
		repository: string;
		planId: string;
		head?: string;
		proposalPath?: string;
		contextPath?: string;
		mode: "replay" | "live";
		authorizeContext: boolean;
		accept: boolean;
		acceptedBy?: string;
	},
	runner: CodexRunner = new SdkCodexRunner(),
) {
	const gate = await createSemanticGate({
		repository: options.repository,
		planId: options.planId,
		head: options.head,
	});
	const sourcePlan = gate.input.plan as JsonObject;
	const policy = gate.input.policy as JsonObject;
	const invalidUnits = (gate.gateResult.units as JsonObject[])
		.filter((unit) => unit.verdict === "invalid")
		.map((unit) => unit.workUnitId as string);
	if (invalidUnits.length === 0) {
		throw new SemanticRepositoryError("REPLAN_NOT_REQUIRED", "The accepted plan is already valid");
	}
	const { schema, definition } = await validators();
	let proposal: JsonObject;
	let provenance: JsonObject | null = null;
	if (options.mode === "live") {
		const snapshot = await createRepositoryBlueprintSnapshot({
			repository: gate.repository,
			revision: gate.head.value,
		});
		({ proposal, provenance } = await liveProposal(
			gate.repository,
			sourcePlan.taskSummary as string,
			policy,
			options.contextPath,
			options.authorizeContext,
			snapshot,
			schema,
			definition,
			runner,
			"selective-replan",
			{
				sourcePlanId: options.planId,
				invalidUnits,
				preservedUnits: (sourcePlan.workUnits as JsonObject[])
					.map((unit) => unit.id as string)
					.filter((id) => !invalidUnits.includes(id)),
			},
		));
	} else {
		if (options.proposalPath === undefined) {
			throw new SemanticRepositoryError("REPLAN_PROPOSAL_REQUIRED", "Replay requires --proposal");
		}
		proposal = await readJsonFile(options.proposalPath, "REPLAN_PROPOSAL_INVALID");
		assertValid(definition("SemanticPlanProposal"), proposal, "REPLAN_PROPOSAL_INVALID");
	}
	if (proposal.planId === options.planId) {
		throw new SemanticRepositoryError(
			"REPLAN_ID_UNCHANGED",
			"A replacement plan requires a new planId",
		);
	}
	const replacements = new Map(
		(Array.isArray(proposal.workUnits) ? (proposal.workUnits as JsonObject[]) : []).map((unit) => [
			unit.id as string,
			unit,
		]),
	);
	if (
		replacements.size !== invalidUnits.length ||
		invalidUnits.some((id) => !replacements.has(id)) ||
		[...replacements].some(([id]) => !invalidUnits.includes(id))
	) {
		throw new SemanticRepositoryError(
			"REPLAN_BOUNDARY_WIDENED",
			"Selective replan must replace exactly the invalid WorkUnits",
		);
	}
	const sourceUnits = sourcePlan.workUnits as JsonObject[];
	const combinedUnits = sourceUnits.map((unit) => replacements.get(unit.id as string) ?? unit);
	admitProposal(policy, { ...proposal, workUnits: combinedUnits });
	const preservedUnits = sourceUnits
		.map((unit) => unit.id as string)
		.filter((id) => !invalidUnits.includes(id));
	const contextManifestDigest =
		(provenance?.contextDigest as JsonObject | undefined) ?? hash({ mode: "replay", proposal });
	const selectiveReplan = {
		schema: "graphrefly.stack.semantic-selective-replan.v1",
		sourcePlanId: options.planId,
		replacementPlanId: proposal.planId,
		preservedUnits,
		invalidUnits,
		contextManifestDigest,
		proposalSource: proposal.proposalSource,
	};
	assertValid(definition("SelectiveReplan"), selectiveReplan, "SELECTIVE_REPLAN_INVALID");
	const draft = {
		selectiveReplan,
		proposal,
		combinedUnits,
		provenance,
		sourceGate: gate.gateResult,
	};
	const draftArtifact = await persistLocalArtifact(
		gate.repository,
		`replans/${options.planId}`,
		draft,
	);
	if (!options.accept) return { repository: gate.repository, draft, draftArtifact };
	if (options.acceptedBy === undefined || options.acceptedBy.trim() === "") {
		throw new SemanticRepositoryError(
			"PLAN_ACCEPTOR_REQUIRED",
			"--accept-by is required with --accept",
		);
	}
	const replacementPlan = {
		schema: "graphrefly.stack.semantic-plan.v1",
		planId: proposal.planId,
		taskDigest: sourcePlan.taskDigest,
		taskSummary: sourcePlan.taskSummary,
		baseCommit: gate.head,
		baseBlueprintHash: gate.input.currentBlueprintHash,
		policy: {
			policyId: policy.policyId,
			revision: policy.revision,
			digest: hash(policy),
		},
		proposalSource: proposal.proposalSource,
		acceptedBy: { label: options.acceptedBy.trim(), identityVerified: false },
		workUnits: combinedUnits,
	};
	assertValid(definition("AcceptedChangePlan"), replacementPlan, "PLAN_ACCEPTED_INVALID");
	const selectiveReplanPath = resolve(
		gate.repository,
		SEMANTIC_STORAGE.plans,
		`${proposal.planId as string}.replan.json`,
	);
	try {
		await access(selectiveReplanPath);
		if (!(await compatibleFile(selectiveReplanPath, selectiveReplan))) {
			throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_EXISTS", selectiveReplanPath);
		}
	} catch (error) {
		if (error instanceof SemanticRepositoryError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const paths = await acceptArtifacts(gate.repository, policy, replacementPlan);
	if (!(await compatibleFile(selectiveReplanPath, selectiveReplan))) {
		try {
			await writeFile(selectiveReplanPath, `${JSON.stringify(selectiveReplan, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
			});
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "EEXIST" ||
				!(await compatibleFile(selectiveReplanPath, selectiveReplan))
			) {
				throw new SemanticRepositoryError("ACCEPTED_ARTIFACT_EXISTS", selectiveReplanPath);
			}
		}
	}
	return {
		repository: gate.repository,
		selectiveReplan,
		replacementPlan,
		paths: { ...paths, selectiveReplanPath },
		draftArtifact,
	};
}

export async function createSemanticPortableBundle(options: {
	repository: string;
	planId: string;
	head?: string;
}) {
	const gate = await createSemanticGate(options);
	const artifacts: Record<string, unknown> = {
		"policy.json": gate.input.policy,
		"plan.json": gate.input.plan,
		"bindings.json": gate.input.bindings,
		"records.json": gate.input.records,
		"checks.json": gate.input.checks,
		"gate-input.json": gate.input,
		"gate-result.json": gate.gateResult,
	};
	const manifest = {
		schema: "graphrefly.stack.semantic-export-manifest.v1",
		planId: options.planId,
		head: gate.head,
		inputDigest: gate.gateResult.inputDigest,
		redaction: {
			excludes: [
				"source-content",
				"raw-blueprint",
				"check-output",
				"credentials",
				"environment",
				"model-response",
			],
		},
		artifacts: Object.entries(artifacts).map(([path, value]) => ({ path, hash: hash(value) })),
	};
	const bundle = {
		schema: "graphrefly.stack.semantic-portable-bundle.v1",
		manifest,
		artifacts,
	};
	const { definition } = await validators();
	assertValid(definition("SemanticPortableBundle"), bundle, "EXPORT_BUNDLE_INVALID");
	for (const artifact of manifest.artifacts) {
		if (sha256Jcs(artifacts[artifact.path]) !== artifact.hash.value) {
			throw new SemanticRepositoryError("ARTIFACT_HASH_MISMATCH", artifact.path);
		}
	}
	return { gate, bundle };
}

export async function exportSemanticBundle(options: {
	repository: string;
	planId: string;
	head?: string;
	output: string;
}) {
	const { gate, bundle } = await createSemanticPortableBundle(options);
	const output = resolve(options.output);
	await mkdir(dirname(output), { recursive: true });
	try {
		await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "EEXIST" ||
			!(await compatibleFile(output, bundle))
		) {
			throw new SemanticRepositoryError("EXPORT_OUTPUT_EXISTS", output);
		}
	}
	return { repository: gate.repository, output, manifest: bundle.manifest };
}

export async function verifySemanticBundle(input: string) {
	const path = resolve(input);
	const bundle = await readJsonFile(path, "EXPORT_BUNDLE_INVALID");
	const { definition } = await validators();
	assertValid(definition("SemanticPortableBundle"), bundle, "EXPORT_BUNDLE_INVALID");
	const manifest = bundle.manifest as JsonObject;
	const artifacts = bundle.artifacts as Record<string, unknown>;
	const entries = manifest.artifacts as JsonObject[];
	const paths = entries.map((entry) => entry.path as string);
	if (
		new Set(paths).size !== paths.length ||
		Object.keys(artifacts).length !== paths.length ||
		Object.keys(artifacts).some((artifactPath) => !paths.includes(artifactPath))
	) {
		throw new SemanticRepositoryError("ARTIFACT_HASH_MISMATCH", path);
	}
	for (const entry of entries) {
		const artifactPath = entry.path as string;
		if (
			!Object.hasOwn(artifacts, artifactPath) ||
			sha256Jcs(artifacts[artifactPath]) !== (entry.hash as JsonObject).value
		) {
			throw new SemanticRepositoryError("ARTIFACT_HASH_MISMATCH", artifactPath);
		}
	}
	const gateInput = artifacts["gate-input.json"] as JsonObject;
	const gateResult = artifacts["gate-result.json"] as JsonObject;
	if (
		(gateResult.inputDigest as JsonObject).value !== sha256Jcs(gateInput) ||
		(manifest.inputDigest as JsonObject).value !== sha256Jcs(gateInput)
	) {
		throw new SemanticRepositoryError("ARTIFACT_HASH_MISMATCH", "gate-input.json");
	}
	return {
		path,
		planId: manifest.planId,
		head: manifest.head,
		inputDigest: manifest.inputDigest,
		artifactCount: entries.length,
	};
}
