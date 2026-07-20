import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import {
	assertMergeGroupBundleIntegrityV1,
	CI_ARTIFACTS_SCHEMA,
	CI_BUNDLE_SCHEMA,
	CI_INVOCATION_SCHEMA,
	CI_JOB_NAME,
	CI_REDACTION_EXCLUDES,
	CI_RESULT_SCHEMA,
	CI_WORKFLOW_PATH,
	canonicalize,
	createStrictAjv,
	MERGE_GROUP_ARTIFACTS_SCHEMA,
	MERGE_GROUP_BUNDLE_SCHEMA,
	SEMANTIC_ARTIFACTS_SCHEMA,
	SEMANTIC_REASON_ORDER,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import {
	computeMergeGroupResultV1,
	MultiPlanProjectionError,
	projectMultiPlanTopologyV1,
} from "@graphrefly-stack/core";
import { DagDiscoveryError, discoverPlanQualifiedGitDag } from "./dag-discovery.js";
import { createDagGraphEvidenceForSemanticGate, DagEvidenceError } from "./dag-evidence.js";
import { createDagSemanticGate, DagSemanticRunnerError } from "./dag-semantic-runner.js";
import {
	assembleGroupIntegration,
	createGroupJoinEvidence,
	GroupIntegrationRunnerError,
} from "./group-integration-runner.js";
import { runtimeAssetPath } from "./runtime-paths.js";
import {
	bindSemanticPlan,
	createSemanticPortableBundle,
	SemanticRepositoryError,
} from "./semantic-repository.js";
import { gitText } from "./system-git.js";

type JsonObject = Record<string, unknown>;

const ciSchemaPath = runtimeAssetPath("contracts/ci/v1/artifacts.schema.json");
const semanticSchemaPath = runtimeAssetPath("contracts/semantic/v1/artifacts.schema.json");
const maxEventBytes = 2 * 1024 * 1024;

export class CiRunnerError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CiRunnerError";
	}
}

function hashBytes(value: Uint8Array) {
	return { algorithm: "sha256" as const, value: createHash("sha256").update(value).digest("hex") };
}

function hash(value: unknown) {
	return { algorithm: "sha256" as const, value: sha256Jcs(value) };
}

function gitOid(value: string) {
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
		throw new CiRunnerError("CI_EVENT_INVALID", "GitHub event contains an invalid Git OID");
	}
	return { algorithm: value.length === 40 ? ("sha1" as const) : ("sha256" as const), value };
}

function validHeadRef(value: string): boolean {
	return (
		value.startsWith("refs/heads/") &&
		value.length > "refs/heads/".length &&
		value.length <= 1024 &&
		![...value].some((character) => (character.codePointAt(0) ?? 0) < 32)
	);
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CiRunnerError("CI_EVENT_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function decimalId(value: unknown, label: string): string {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) return value;
	throw new CiRunnerError("CI_EVENT_INVALID", `${label} must be a positive immutable ID`);
}

function positiveInteger(value: unknown, label: string): number {
	const result = typeof value === "string" ? Number(value) : value;
	if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 1) {
		throw new CiRunnerError("CI_EVENT_INVALID", `${label} must be a positive integer`);
	}
	return result;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name];
	if (value === undefined || value.length === 0) {
		throw new CiRunnerError("CI_ENVIRONMENT_INVALID", `${name} is required`);
	}
	return value;
}

async function repositoryRoot(requested: string): Promise<string> {
	try {
		const canonical = await realpath(resolve(requested));
		return await realpath(gitText(canonical, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new CiRunnerError("CI_REPOSITORY_INVALID", "CI run requires a local Git worktree");
	}
}

function inside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function runnerOutputPath(
	repository: string,
	environment: NodeJS.ProcessEnv,
	name: "GITHUB_OUTPUT" | "GITHUB_STEP_SUMMARY",
): Promise<string | undefined> {
	const value = environment[name];
	if (value === undefined) return undefined;
	try {
		const requested = resolve(value);
		let canonical: string;
		try {
			canonical = await realpath(requested);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			canonical = resolve(await realpath(dirname(requested)), basename(requested));
		}
		if (inside(repository, canonical)) {
			throw new CiRunnerError("CI_RUNNER_OUTPUT_INVALID", `${name} must remain outside repository`);
		}
		return canonical;
	} catch (error) {
		if (error instanceof CiRunnerError) throw error;
		throw new CiRunnerError("CI_RUNNER_OUTPUT_INVALID", `${name} parent must already exist`);
	}
}

async function validators() {
	const [semanticSchema, ciSchema] = await Promise.all(
		[semanticSchemaPath, ciSchemaPath].map(async (path) =>
			JSON.parse(await readFile(path, "utf8")),
		),
	);
	const ajv = createStrictAjv();
	ajv.addSchema(semanticSchema);
	ajv.addSchema(ciSchema);
	return {
		invocation: ajv.getSchema(`${CI_ARTIFACTS_SCHEMA}#/definitions/CIInvocation`),
		result: ajv.getSchema(`${CI_ARTIFACTS_SCHEMA}#/definitions/CIResult`),
		bundle: ajv.getSchema(`${CI_ARTIFACTS_SCHEMA}#/definitions/CIBundle`),
	};
}

type CiValidator = NonNullable<Awaited<ReturnType<typeof validators>>["invocation"]>;

function assertValid(validate: CiValidator | undefined, value: unknown, code: string): void {
	if (validate === undefined || !validate(value)) {
		const errors =
			validate === undefined ? "validator unavailable" : JSON.stringify(validate.errors);
		throw new CiRunnerError(code, errors);
	}
}

function workflowSource(): string {
	return `name: GraphReFly Stack

on:
  pull_request:
  merge_group:
    types: [checks_requested]

permissions:
  contents: read

concurrency:
  group: graphrefly-stack-\${{ github.repository_id }}-\${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.event.merge_group.head_ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
  semantic-gate:
    name: ${CI_JOB_NAME}
    runs-on: ubuntu-22.04
    permissions:
      contents: read
    steps:
      - name: Check out immutable event head
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          ref: \${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24.18.0
      - name: Enable repository-pinned pnpm
        run: corepack enable
      - name: Resolve pnpm store
        id: pnpm-store
        shell: bash
        run: echo "path=$(pnpm store path --silent)" >> "$GITHUB_OUTPUT"
      - name: Restore dependency store
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: \${{ steps.pnpm-store.outputs.path }}
          key: graphrefly-stack-\${{ runner.os }}-\${{ runner.arch }}-node-24.18.0-manifest-\${{ hashFiles('package.json') }}-lock-\${{ hashFiles('pnpm-lock.yaml') }}
      - name: Install frozen dependencies without lifecycle scripts
        run: pnpm install --frozen-lockfile --ignore-scripts
      - name: Provision deny-network check sandbox
        run: |
          sudo apt-get update
          sudo apt-get install --yes --no-install-recommends bubblewrap
          test -x /usr/bin/bwrap
      - name: Run GraphReFly Stack semantic gate
        id: graphrefly_stack
        run: pnpm exec grfs ci run --event "$GITHUB_EVENT_PATH" --output "$RUNNER_TEMP/graphrefly-stack-ci.json" --json
      - name: Run GraphReFly Stack semantic integration
        if: \${{ !cancelled() && github.event_name == 'pull_request' }}
        id: graphrefly_stack_integration
        run: pnpm exec grfs integration ci --event "$GITHUB_EVENT_PATH" --output "$RUNNER_TEMP/graphrefly-stack-integration.json" --json
      - name: Upload redacted GraphReFly Stack evidence
        if: \${{ always() && steps.graphrefly_stack.outputs.artifact-name != '' }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: \${{ steps.graphrefly_stack.outputs.artifact-name }}
          path: \${{ steps.graphrefly_stack.outputs.artifact-path }}
          retention-days: 7
          if-no-files-found: error
      - name: Upload GraphReFly Stack integration evidence
        if: \${{ always() && steps.graphrefly_stack_integration.outputs.artifact-name != '' }}
        uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: \${{ steps.graphrefly_stack_integration.outputs.artifact-name }}
          path: \${{ steps.graphrefly_stack_integration.outputs.artifact-path }}
          retention-days: 7
          if-no-files-found: error
`;
}

export async function initializeCiWorkflow(options: { repository: string; force: boolean }) {
	const repository = await repositoryRoot(options.repository);
	const path = resolve(repository, CI_WORKFLOW_PATH);
	try {
		await access(path);
		if (!options.force) {
			throw new CiRunnerError(
				"CI_WORKFLOW_EXISTS",
				`${CI_WORKFLOW_PATH} already exists; pass --force to replace it`,
			);
		}
	} catch (error) {
		if (error instanceof CiRunnerError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, workflowSource(), { encoding: "utf8", mode: 0o644 });
	return {
		repository,
		workflow: CI_WORKFLOW_PATH,
		jobName: CI_JOB_NAME,
		trigger: "pull_request",
		permissions: { contents: "read" },
	};
}

async function readEvent(path: string) {
	let bytes: Buffer;
	try {
		bytes = await readFile(resolve(path));
	} catch {
		throw new CiRunnerError("CI_EVENT_INVALID", "GitHub event file could not be read");
	}
	if (bytes.byteLength === 0 || bytes.byteLength > maxEventBytes) {
		throw new CiRunnerError("CI_EVENT_INVALID", "GitHub event file size is outside the v1 bound");
	}
	try {
		return object(JSON.parse(bytes.toString("utf8")), "event");
	} catch (error) {
		if (error instanceof CiRunnerError) throw error;
		throw new CiRunnerError("CI_EVENT_INVALID", "GitHub event file is not valid JSON");
	}
}

async function findPackageManifest(start: string, expectedName: string) {
	let candidate = resolve(start);
	const filesystemRoot = resolve(candidate, "/");
	while (candidate !== filesystemRoot) {
		try {
			const value = JSON.parse(await readFile(resolve(candidate, "package.json"), "utf8"));
			if (value.name === expectedName && typeof value.version === "string") {
				return { root: candidate, value: value as JsonObject };
			}
		} catch {
			// Continue upward to the package that owns the running entrypoint.
		}
		candidate = dirname(candidate);
	}
	throw new CiRunnerError("CI_RUNTIME_INVALID", `${expectedName} package root was not found`);
}

async function installedPackageVersion(repository: string, packageName: string): Promise<string> {
	const require = createRequire(resolve(repository, "package.json"));
	let entrypoint: string;
	try {
		entrypoint = require.resolve(
			packageName === "@graphrefly/ts" ? "@graphrefly/ts/graph" : "@graphrefly/stack/package.json",
		);
	} catch {
		throw new CiRunnerError("CI_RUNTIME_INVALID", `${packageName} is not installed`);
	}
	const manifest = await findPackageManifest(dirname(entrypoint), packageName);
	return manifest.value.version as string;
}

function exactStackPin(manifest: JsonObject, installed: string): boolean {
	for (const field of ["dependencies", "devDependencies"] as const) {
		const dependencies = manifest[field];
		if (
			typeof dependencies === "object" &&
			dependencies !== null &&
			!Array.isArray(dependencies) &&
			(dependencies as JsonObject)["@graphrefly/stack"] === installed
		) {
			return true;
		}
	}
	return false;
}

async function runtimeInputs(repository: string) {
	const [manifestBytes, lockfileBytes] = await Promise.all([
		readFile(resolve(repository, "package.json")),
		readFile(resolve(repository, "pnpm-lock.yaml")),
	]).catch(() => {
		throw new CiRunnerError(
			"CI_RUNTIME_INVALID",
			"package.json and pnpm-lock.yaml are required for frozen CI execution",
		);
	});
	let manifest: JsonObject;
	try {
		manifest = object(JSON.parse(manifestBytes.toString("utf8")), "package.json");
	} catch (error) {
		if (error instanceof CiRunnerError) throw error;
		throw new CiRunnerError("CI_RUNTIME_INVALID", "package.json is not valid JSON");
	}
	const [installedStack, graphreflyVersion] = await Promise.all([
		installedPackageVersion(repository, "@graphrefly/stack"),
		installedPackageVersion(repository, "@graphrefly/ts"),
	]);
	if (!exactStackPin(manifest, installedStack)) {
		throw new CiRunnerError(
			"CI_STACK_NOT_PINNED",
			`package.json must pin @graphrefly/stack exactly to ${installedStack}`,
		);
	}
	const packageManager = manifest.packageManager;
	const pnpmMatch =
		typeof packageManager === "string"
			? /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+(?:sha256\.[0-9a-f]{64}|sha512\.[0-9a-f]{128}))?$/u.exec(
					packageManager,
				)
			: null;
	if (pnpmMatch === null) {
		throw new CiRunnerError("CI_RUNTIME_INVALID", "packageManager must pin an exact pnpm version");
	}
	const lockfileDigest = hashBytes(lockfileBytes);
	const packageManifestDigest = hashBytes(manifestBytes);
	const nodeVersion = process.versions.node;
	const pnpmVersion = pnpmMatch[1] as string;
	const operatingSystem = platform();
	const architecture = arch();
	return {
		operatingSystem,
		architecture,
		nodeVersion,
		pnpmVersion,
		lockfilePath: "pnpm-lock.yaml" as const,
		lockfileDigest,
		packageManifestDigest,
		stackVersion: installedStack,
		graphreflyVersion,
		cacheKey: [
			"graphrefly-stack",
			operatingSystem,
			architecture,
			`node-${nodeVersion}`,
			`pnpm-${pnpmVersion}`,
			`manifest-${packageManifestDigest.value}`,
			`lock-${lockfileDigest.value}`,
			`stack-${installedStack}`,
			`graphrefly-${graphreflyVersion}`,
		].join("-"),
	};
}

function planPaths(repository: string, head: string): string[] {
	let output: string;
	try {
		output = gitText(repository, [
			"ls-tree",
			"-r",
			"--name-only",
			head,
			"--",
			".graphrefly-stack/plans",
		]);
	} catch {
		return [];
	}
	return output
		.split("\n")
		.filter((path) => /^\.graphrefly-stack\/plans\/[A-Za-z][A-Za-z0-9._-]{0,63}\.json$/u.test(path))
		.filter((path) => !path.endsWith(".replan.json"))
		.sort();
}

const nonCoveringPlanCodes = new Set([
	"PLAN_HISTORY_INVALID",
	"PLAN_ACCEPTANCE_COMMIT_MISSING",
	"WORK_UNIT_COMMIT_COUNT_MISMATCH",
]);

export function requireSingleTipCoveringPlan(candidates: readonly string[]): string {
	if (candidates.length === 0) {
		throw new CiRunnerError("CI_PLAN_NOT_FOUND", "No accepted plan consumes the event head");
	}
	if (candidates.length !== 1) {
		throw new CiRunnerError("CI_PLAN_AMBIGUOUS", candidates.join(", "));
	}
	return candidates[0] as string;
}

export async function selectPlan(
	repository: string,
	head: string,
	explicit?: string,
): Promise<string> {
	if (explicit !== undefined) {
		if (!planPaths(repository, head).includes(`.graphrefly-stack/plans/${explicit}.json`)) {
			throw new CiRunnerError("CI_PLAN_NOT_FOUND", `Accepted plan was not found: ${explicit}`);
		}
		await bindSemanticPlan({ repository, planId: explicit, head });
		return explicit;
	}
	const candidates: string[] = [];
	for (const path of planPaths(repository, head)) {
		const planId = basename(path, ".json");
		try {
			await bindSemanticPlan({ repository, planId, head });
			candidates.push(planId);
		} catch (error) {
			if (error instanceof SemanticRepositoryError && nonCoveringPlanCodes.has(error.code))
				continue;
			throw new CiRunnerError(
				"CI_PLAN_CANDIDATE_INVALID",
				`${planId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return requireSingleTipCoveringPlan(candidates);
}

async function assertNetworkSandbox(): Promise<void> {
	const path = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap";
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new CiRunnerError("CI_SANDBOX_UNAVAILABLE", process.platform);
	}
	try {
		await access(path);
	} catch {
		throw new CiRunnerError("CI_SANDBOX_UNAVAILABLE", path);
	}
}

function verifyGitRange(repository: string, base: string, head: string): void {
	let current: string;
	try {
		current = gitText(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
	} catch {
		throw new CiRunnerError("CI_REVISION_UNAVAILABLE", "Checked-out HEAD is unavailable");
	}
	if (current !== head) {
		throw new CiRunnerError(
			"CI_HEAD_MISMATCH",
			`Checked-out HEAD ${current} does not match ${head}`,
		);
	}
	const result = spawnSync("git", ["-C", repository, "merge-base", "--is-ancestor", base, head], {
		shell: false,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new CiRunnerError("CI_BASE_NOT_ANCESTOR", "Event base must be an ancestor of head");
	}
}

function jsonAt(repository: string, revision: string, path: string): JsonObject {
	try {
		return object(JSON.parse(gitText(repository, ["show", `${revision}:${path}`])), path);
	} catch {
		throw new CiRunnerError("CI_PLAN_CANDIDATE_INVALID", `${revision}:${path}`);
	}
}

function exactGateBundle(run: JsonObject): JsonObject {
	if (run.schema === "graphrefly.stack.dag-gate-bundle.v2") {
		return {
			schema: run.schema,
			topology: run.topology,
			dependencyGraph: run.dependencyGraph,
			bindings: run.bindings,
			records: run.records,
			unitEvaluations: run.unitEvaluations,
			joinEvaluations: run.joinEvaluations,
			gateInput: run.gateInput,
			gateResult: run.gateResult,
		};
	}
	if (run.schema === "graphrefly.stack.dag-structural-error-bundle.v2") {
		return {
			schema: run.schema,
			topology: run.topology,
			dependencyGraph: run.dependencyGraph,
			plan: run.plan,
			policy: run.policy,
			bindings: run.bindings,
			errorInput: run.errorInput,
			gateResult: run.gateResult,
		};
	}
	throw new CiRunnerError("CI_MERGE_GROUP_GATE_INVALID", "DAG gate bundle is unsupported");
}

async function mergeGroupBundleValidator() {
	const schemas = await Promise.all(
		[
			"contracts/semantic/v1/artifacts.schema.json",
			"contracts/ci/v1/artifacts.schema.json",
			"contracts/dag/v2/artifacts.schema.json",
			"contracts/dag/v2/semantic.schema.json",
			"contracts/integration/v1/artifacts.schema.json",
			"contracts/dag/v2/merge-group.schema.json",
		].map(async (path) => JSON.parse(await readFile(runtimeAssetPath(path), "utf8"))),
	);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	return ajv.getSchema(`${MERGE_GROUP_ARTIFACTS_SCHEMA}#/definitions/MergeGroupBundle`);
}

async function runMergeGroupCi(options: {
	repository: string;
	event: JsonObject;
	output: string;
	environment: NodeJS.ProcessEnv;
	githubOutput?: string;
	githubStepSummary?: string;
}) {
	const mergeGroup = object(options.event.merge_group, "merge_group");
	if (options.event.action !== "checks_requested") {
		throw new CiRunnerError(
			"CI_EVENT_UNSUPPORTED",
			"Only merge_group checks_requested is supported",
		);
	}
	const eventRepository = object(options.event.repository, "repository");
	const owner = object(eventRepository.owner, "repository.owner");
	const base = gitOid(String(mergeGroup.base_sha ?? ""));
	const head = gitOid(String(mergeGroup.head_sha ?? ""));
	const baseRef = String(mergeGroup.base_ref ?? "");
	const headRef = String(mergeGroup.head_ref ?? "");
	if (!validHeadRef(baseRef) || !validHeadRef(headRef)) {
		throw new CiRunnerError("CI_EVENT_INVALID", "merge_group refs are invalid");
	}
	if (
		requiredEnvironment(options.environment, "GITHUB_SHA") !== head.value ||
		requiredEnvironment(options.environment, "GITHUB_REF") !== headRef
	) {
		throw new CiRunnerError("CI_HEAD_MISMATCH", "Checked-out merge-group identity drifted");
	}
	verifyGitRange(options.repository, base.value, head.value);
	await assertNetworkSandbox();
	const repositoryIdentity = {
		provider: "github",
		owner: String(owner.login ?? ""),
		name: String(eventRepository.name ?? ""),
	};
	if (repositoryIdentity.owner.length === 0 || repositoryIdentity.name.length === 0) {
		throw new CiRunnerError("CI_EVENT_INVALID", "repository identity is incomplete");
	}
	const [qualifiedDiscovery, sharedEvidence] = await Promise.all([
		discoverPlanQualifiedGitDag({
			repository: options.repository,
			base: base.value,
			head: head.value,
		}),
		createDagGraphEvidenceForSemanticGate({
			repository: options.repository,
			base: base.value,
			head: head.value,
			repositoryIdentity,
		}),
	]);
	if (!Array.isArray(sharedEvidence.topology.joins) || sharedEvidence.topology.joins.length === 0) {
		throw new CiRunnerError(
			"CI_MERGE_GROUP_TOPOLOGY_UNSUPPORTED",
			"merge_group requires an observed clean binary merge topology",
		);
	}
	const qualifiedCommits = qualifiedDiscovery.qualifiedCommits;
	const planIds = [...new Set(qualifiedCommits.map((entry) => entry.planId))].sort();
	if (planIds.length < 1 || planIds.length > 8) {
		throw new CiRunnerError("CI_PLAN_AMBIGUOUS", "merge group must contain one to eight Plans");
	}
	const policy = jsonAt(options.repository, head.value, ".graphrefly-stack/policy.json");
	const plans = [];
	for (const planId of planIds) {
		const plan = jsonAt(options.repository, head.value, `.graphrefly-stack/plans/${planId}.json`);
		const projectedTopology = projectMultiPlanTopologyV1({
			topology: sharedEvidence.topology,
			qualifiedCommits,
			planId,
		});
		const run = await createDagSemanticGate({
			repository: options.repository,
			base: base.value,
			head: head.value,
			planId,
			repositoryIdentity,
			graphEvidence: { ...sharedEvidence, topology: projectedTopology },
		});
		plans.push({ planId, plan, policy, gateBundle: exactGateBundle(run as JsonObject) });
	}
	const headBlueprint = sharedEvidence.blueprints.find(
		(entry) => entry.revision.value === head.value,
	);
	if (headBlueprint === undefined) {
		throw new CiRunnerError("CI_MERGE_GROUP_GATE_INVALID", "head Blueprint evidence is missing");
	}
	const joinEvidence = await createGroupJoinEvidence({
		repository: options.repository,
		topology: sharedEvidence.topology,
		blueprints: sharedEvidence.blueprints,
	});
	const group = await assembleGroupIntegration({
		topology: sharedEvidence.topology,
		repositoryPolicy: policy,
		qualifiedCommits,
		plans: plans.map((entry) => ({
			plan: entry.plan,
			policy: entry.policy,
			gateResult: object(entry.gateBundle.gateResult, `${entry.planId} GateResult`),
		})),
		headBlueprint,
		joinEvidence,
	});
	const repository = {
		identity: repositoryIdentity,
		id: decimalId(eventRepository.id, "repository.id"),
		ownerId: decimalId(owner.id, "repository.owner.id"),
	};
	const event = {
		name: "merge_group",
		action: "checks_requested",
		baseRef,
		headRef,
		base,
		head,
	};
	const invocation = {
		schema: "graphrefly.stack.merge-group-invocation.v1",
		adapter: { provider: "github-actions", version: "v1" },
		repository,
		event,
		workflow: {
			ref: requiredEnvironment(options.environment, "GITHUB_WORKFLOW_REF"),
			sha: gitOid(requiredEnvironment(options.environment, "GITHUB_WORKFLOW_SHA")),
		},
		run: {
			id: decimalId(requiredEnvironment(options.environment, "GITHUB_RUN_ID"), "GITHUB_RUN_ID"),
			attempt: positiveInteger(
				requiredEnvironment(options.environment, "GITHUB_RUN_ATTEMPT"),
				"GITHUB_RUN_ATTEMPT",
			),
			actorId: decimalId(
				requiredEnvironment(options.environment, "GITHUB_ACTOR_ID"),
				"GITHUB_ACTOR_ID",
			),
			jobName: CI_JOB_NAME,
		},
		checkout: { ref: headRef, sha: head },
		concurrency: {
			identityDigest: hash({ repositoryId: repository.id, event: "merge_group", headRef, head }),
			cancelInProgress: false,
		},
		topologyDigest: hash(sharedEvidence.topology),
		plans: plans.map((entry) => ({
			planId: entry.planId,
			planDigest: hash(entry.plan),
			policyDigest: hash(entry.policy),
		})),
		identity: { assurance: "platform-asserted" },
	};
	const sources = {
		invocation,
		topology: sharedEvidence.topology,
		qualifiedCommits,
		conversions: [],
		plans,
		groupIntegrationInput: group.input,
		groupIntegrationResult: group.result,
	};
	const result = computeMergeGroupResultV1(sources);
	const bundle = { schema: MERGE_GROUP_BUNDLE_SCHEMA, ...sources, result };
	const validate = await mergeGroupBundleValidator();
	assertValid(validate, bundle, "CI_MERGE_GROUP_BUNDLE_INVALID");
	assertMergeGroupBundleIntegrityV1(bundle);
	const serialized = canonicalize(bundle);
	try {
		await writeFile(options.output, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new CiRunnerError("CI_OUTPUT_EXISTS", options.output);
		}
		throw error;
	}
	if ((await readFile(options.output, "utf8")) !== serialized) {
		throw new CiRunnerError("CI_ARTIFACT_INTEGRITY_INVALID", "Persisted aggregate bytes drifted");
	}
	const bundleDigest = hash(bundle);
	const artifactName = `graphrefly-stack-merge-group-${bundleDigest.value}`;
	if (options.githubOutput !== undefined) {
		await appendFile(
			options.githubOutput,
			`artifact-name=${artifactName}\nartifact-path=${options.output}\n`,
			"utf8",
		);
	}
	if (options.githubStepSummary !== undefined) {
		await appendFile(
			options.githubStepSummary,
			`## GraphReFly Stack merge-group gate\n\n- Verdict: ${String(result.outcome)}\n- Plans: ${planIds.join(", ")}\n`,
			"utf8",
		);
	}
	return {
		repository: options.repository,
		output: options.output,
		artifactName,
		invocationDigest: result.invocationDigest,
		gateResult: result,
		outcome: result.outcome as "pass" | "blocked" | "error",
	};
}

export async function runCi(options: {
	repository: string;
	eventPath: string;
	planId?: string;
	output: string;
	environment?: NodeJS.ProcessEnv;
}) {
	const environment = options.environment ?? process.env;
	const eventName = requiredEnvironment(environment, "GITHUB_EVENT_NAME");
	if (eventName !== "pull_request" && eventName !== "merge_group") {
		throw new CiRunnerError(
			"CI_EVENT_UNSUPPORTED",
			"Only pull_request and merge_group are supported",
		);
	}
	const repository = await repositoryRoot(options.repository);
	if (/[\r\n]/u.test(options.output)) {
		throw new CiRunnerError("CI_OUTPUT_INVALID", "CI output path must not contain line breaks");
	}
	let output: string;
	try {
		const requestedOutput = resolve(options.output);
		output = resolve(await realpath(dirname(requestedOutput)), basename(requestedOutput));
	} catch {
		throw new CiRunnerError("CI_OUTPUT_PARENT_INVALID", "CI output parent must already exist");
	}
	if (inside(repository, output)) {
		throw new CiRunnerError(
			"CI_OUTPUT_INSIDE_REPOSITORY",
			"CI output must remain outside the repository",
		);
	}
	const [githubOutput, githubStepSummary] = await Promise.all([
		runnerOutputPath(repository, environment, "GITHUB_OUTPUT"),
		runnerOutputPath(repository, environment, "GITHUB_STEP_SUMMARY"),
	]);
	const event = await readEvent(options.eventPath);
	if (eventName === "merge_group") {
		if (options.planId !== undefined) {
			throw new CiRunnerError(
				"CI_PLAN_SELECTION_UNSUPPORTED",
				"merge_group always evaluates every qualified Plan",
			);
		}
		try {
			return await runMergeGroupCi({
				repository,
				event,
				output,
				environment,
				githubOutput,
				githubStepSummary,
			});
		} catch (error) {
			if (error instanceof CiRunnerError) throw error;
			if (
				error instanceof DagDiscoveryError ||
				error instanceof DagEvidenceError ||
				error instanceof DagSemanticRunnerError ||
				error instanceof GroupIntegrationRunnerError
			) {
				throw new CiRunnerError(error.code, error.message);
			}
			if (error instanceof MultiPlanProjectionError) {
				throw new CiRunnerError("MULTI_PLAN_PROJECTION_INVALID", error.message);
			}
			throw error;
		}
	}
	const eventRepository = object(event.repository, "repository");
	const owner = object(eventRepository.owner, "repository.owner");
	const pullRequest = object(event.pull_request, "pull_request");
	const base = object(pullRequest.base, "pull_request.base");
	const head = object(pullRequest.head, "pull_request.head");
	const headRepository = object(head.repo, "pull_request.head.repo");
	const baseOid = gitOid(String(base.sha ?? ""));
	const headOid = gitOid(String(head.sha ?? ""));
	verifyGitRange(repository, baseOid.value, headOid.value);
	await assertNetworkSandbox();
	const planId = await selectPlan(repository, headOid.value, options.planId);
	const [{ gate, bundle: portableBundle }, cacheInputs] = await Promise.all([
		createSemanticPortableBundle({ repository, planId, head: headOid.value }),
		runtimeInputs(repository),
	]);
	const workflowSha = gitOid(requiredEnvironment(environment, "GITHUB_WORKFLOW_SHA"));
	const invocation = {
		schema: CI_INVOCATION_SCHEMA,
		adapter: { provider: "github-actions", version: "v1" },
		repository: {
			id: decimalId(eventRepository.id, "repository.id"),
			ownerId: decimalId(owner.id, "repository.owner.id"),
			headRepositoryId: decimalId(headRepository.id, "pull_request.head.repo.id"),
		},
		event: {
			name: "pull_request",
			pullRequestNumber: positiveInteger(pullRequest.number ?? event.number, "pull_request.number"),
			base: baseOid,
			head: headOid,
		},
		workflow: {
			ref: requiredEnvironment(environment, "GITHUB_WORKFLOW_REF"),
			sha: workflowSha,
		},
		run: {
			id: decimalId(requiredEnvironment(environment, "GITHUB_RUN_ID"), "GITHUB_RUN_ID"),
			attempt: positiveInteger(
				requiredEnvironment(environment, "GITHUB_RUN_ATTEMPT"),
				"GITHUB_RUN_ATTEMPT",
			),
			actorId: decimalId(requiredEnvironment(environment, "GITHUB_ACTOR_ID"), "GITHUB_ACTOR_ID"),
			jobName: CI_JOB_NAME,
		},
		plan: {
			id: planId,
			policyDigest: hash(gate.input.policy),
		},
		cacheInputs,
		identity: { assurance: "platform-asserted" },
	};
	const {
		invocation: validateInvocation,
		result: validateResult,
		bundle: validateBundle,
	} = await validators();
	assertValid(validateInvocation, invocation, "CI_INVOCATION_INVALID");
	const portableBundleDigest = hash(portableBundle);
	const units = gate.gateResult.units as JsonObject[];
	const affectedWorkUnitIds = units
		.filter((unit) => unit.verdict === "invalid")
		.map((unit) => unit.workUnitId as string);
	const presentReasons = new Set(
		units.flatMap((unit) =>
			Array.isArray(unit.reasonCodes) ? (unit.reasonCodes as string[]) : [],
		),
	);
	const reasonCodes = SEMANTIC_REASON_ORDER.filter((reason) => presentReasons.has(reason));
	const outcome = gate.gateResult.verdict as "pass" | "blocked" | "error";
	const result = {
		schema: CI_RESULT_SCHEMA,
		invocationDigest: hash(invocation),
		outcome,
		gateInputDigest: gate.gateResult.inputDigest,
		gateResult: gate.gateResult,
		portableBundleDigest,
		provenance: {
			provider: "github-actions",
			repositoryId: invocation.repository.id,
			workflowSha,
			runId: invocation.run.id,
			attempt: invocation.run.attempt,
		},
		redaction: { excludes: [...CI_REDACTION_EXCLUDES] },
		summary: { verdict: outcome, affectedWorkUnitIds, reasonCodes },
		artifactName: `graphrefly-stack-ci-${portableBundleDigest.value}`,
	};
	assertValid(validateResult, result, "CI_RESULT_INVALID");
	const ciBundle = { schema: CI_BUNDLE_SCHEMA, invocation, result, portableBundle };
	assertValid(validateBundle, ciBundle, "CI_BUNDLE_INVALID");
	if (
		result.invocationDigest.value !== sha256Jcs(invocation) ||
		result.gateInputDigest.value !== sha256Jcs(gate.input) ||
		result.portableBundleDigest.value !== sha256Jcs(portableBundle) ||
		result.outcome !== gate.gateResult.verdict
	) {
		throw new CiRunnerError("CI_ARTIFACT_INTEGRITY_INVALID", "CI artifact cross-binding failed");
	}
	const serializedBundle = canonicalize(ciBundle);
	try {
		await writeFile(output, serializedBundle, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new CiRunnerError("CI_OUTPUT_EXISTS", output);
		}
		throw error;
	}
	if ((await readFile(output, "utf8")) !== serializedBundle) {
		throw new CiRunnerError(
			"CI_ARTIFACT_INTEGRITY_INVALID",
			"Persisted CI artifact does not match canonical bytes",
		);
	}
	if (githubOutput !== undefined) {
		await appendFile(
			githubOutput,
			`artifact-name=${result.artifactName}\nartifact-path=${output}\n`,
			"utf8",
		);
	}
	if (githubStepSummary !== undefined) {
		const affected = affectedWorkUnitIds.length === 0 ? "none" : affectedWorkUnitIds.join(", ");
		const reasons = reasonCodes.length === 0 ? "none" : reasonCodes.join(", ");
		await appendFile(
			githubStepSummary,
			`## GraphReFly Stack semantic gate\n\n- Verdict: ${outcome}\n- Affected WorkUnits: ${affected}\n- Reasons: ${reasons}\n`,
			"utf8",
		);
	}
	return {
		repository,
		output,
		artifactName: result.artifactName,
		invocationDigest: result.invocationDigest,
		gateInputDigest: result.gateInputDigest,
		gateResult: result.gateResult,
		outcome,
	};
}

export const CI_CONTRACT_IDS = {
	artifacts: CI_ARTIFACTS_SCHEMA,
	semantic: SEMANTIC_ARTIFACTS_SCHEMA,
} as const;
