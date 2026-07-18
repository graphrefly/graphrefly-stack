import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createStrictAjv,
	REPOSITORY_CONFIG_SCHEMA,
	REPOSITORY_REVIEW_SCHEMA,
	type RepositoryConfig,
	type RepositoryDiagram,
	type RepositoryReview,
	type RepositoryRevisionEvidence,
	SUPPORTED_GRAPHREFLY_RANGE,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import { satisfies, valid } from "semver";

import { runtimeAssetPath } from "./runtime-paths.js";
import { parseStructuredDiff } from "./structured-diff.js";
import { gitText, SystemGitAdapter } from "./system-git.js";

const configSchemaPath = runtimeAssetPath("contracts/repository/v1/repository-config.schema.json");
const reviewSchemaPath = runtimeAssetPath("contracts/repository/v1/review.schema.json");
const semanticSchemaPath = runtimeAssetPath("contracts/semantic/v1/artifacts.schema.json");
const configName = ".graphrefly-stack.json";
const lockCandidates = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"] as const;
const maxReviewCommits = 64;
const maxEntrypointBytes = 64 * 1024;

interface TargetGraphReFlyRuntime {
	version: string;
	nodeModulesRoot: string;
	parseGraphBlueprint(value: unknown): Record<string, unknown>;
	verifyBlueprintHash(
		blueprint: Record<string, unknown>,
		options: { algorithm: string; hash: (bytes: Uint8Array) => string },
	): boolean | Promise<boolean>;
	blueprintToMermaid(blueprint: Record<string, unknown>): string;
	diffGraphBlueprints(
		previous: Record<string, unknown>,
		next: Record<string, unknown>,
	): Record<string, unknown>;
}

export class RepositoryReviewError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RepositoryReviewError";
	}
}

async function readJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new RepositoryReviewError(
			"CONFIG_INVALID",
			error instanceof Error ? error.message : "Repository config is not valid JSON",
		);
	}
}

async function readSchemas() {
	return Promise.all(
		[configSchemaPath, reviewSchemaPath, semanticSchemaPath].map(async (path) =>
			JSON.parse(await readFile(path, "utf8")),
		),
	);
}

async function findPackageRoot(entrypoint: string): Promise<string> {
	let candidate = dirname(entrypoint);
	const filesystemRoot = parse(candidate).root;
	while (candidate !== filesystemRoot) {
		try {
			const manifest = JSON.parse(await readFile(resolve(candidate, "package.json"), "utf8")) as {
				name?: string;
			};
			if (manifest.name === "@graphrefly/ts") return candidate;
		} catch {
			// Continue upward until the package that owns the resolved public entrypoint is found.
		}
		candidate = dirname(candidate);
	}
	throw new RepositoryReviewError(
		"DEPENDENCY_UNSUPPORTED",
		"Installed @graphrefly/ts package root could not be identified",
	);
}

function importExportPath(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	return importExportPath(record.import) ?? importExportPath(record.default);
}

async function readRepositoryConfig(repository: string): Promise<RepositoryConfig> {
	const path = resolve(repository, configName);
	try {
		await access(path);
	} catch {
		throw new RepositoryReviewError("CONFIG_MISSING", `${configName} was not found`);
	}
	const value = await readJson(path);
	const [schema] = await readSchemas();
	const validate = createStrictAjv().compile(schema);
	if (!validate(value)) {
		throw new RepositoryReviewError(
			"CONFIG_INVALID",
			`Repository config failed validation: ${JSON.stringify(validate.errors)}`,
		);
	}
	const config = value as RepositoryConfig;
	if (config.schema !== REPOSITORY_CONFIG_SCHEMA) {
		throw new RepositoryReviewError("CONFIG_INVALID", "Unsupported repository config version");
	}
	return config;
}

function gitObject(repository: string, revision: string, path: string): string {
	return gitText(repository, ["show", `${revision}:${path}`]);
}

function graphReFlyPins(packageJson: Record<string, unknown>): string[] {
	const pins: string[] = [];
	for (const field of ["dependencies", "devDependencies"] as const) {
		const dependencies = packageJson[field];
		if (typeof dependencies !== "object" || dependencies === null) continue;
		const value = (dependencies as Record<string, unknown>)["@graphrefly/ts"];
		if (typeof value === "string") pins.push(value);
	}
	return pins;
}

function oidAlgorithm(value: string): "sha1" | "sha256" {
	return value.length === 40 ? "sha1" : "sha256";
}

function ensureInside(root: string, candidate: string): void {
	if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
		throw new RepositoryReviewError(
			"ENTRYPOINT_ESCAPE",
			"Blueprint entrypoint escapes the worktree",
		);
	}
}

async function readConfiguredEntrypoint(
	repository: string,
	entrypointPath: string,
): Promise<Uint8Array> {
	const entrypoint = resolve(repository, entrypointPath);
	ensureInside(repository, entrypoint);
	let canonicalEntrypoint: string;
	try {
		canonicalEntrypoint = await realpath(entrypoint);
	} catch {
		throw new RepositoryReviewError(
			"ENTRYPOINT_MISSING",
			"Configured Blueprint entrypoint is missing",
		);
	}
	ensureInside(repository, canonicalEntrypoint);
	const source = await readFile(canonicalEntrypoint);
	if (source.byteLength > maxEntrypointBytes) {
		throw new RepositoryReviewError(
			"ENTRYPOINT_TOO_LARGE",
			`Configured Blueprint entrypoint exceeds ${maxEntrypointBytes} bytes`,
		);
	}
	return source;
}

function containsAbsolutePath(value: unknown): boolean {
	if (typeof value === "string") return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
	if (Array.isArray(value)) return value.some(containsAbsolutePath);
	if (typeof value === "object" && value !== null) {
		return Object.values(value).some(containsAbsolutePath);
	}
	return false;
}

async function resolveTargetRuntime(repository: string): Promise<TargetGraphReFlyRuntime> {
	const require = createRequire(resolve(repository, "package.json"));
	let graphCjs: string;
	try {
		graphCjs = require.resolve("@graphrefly/ts/graph");
	} catch {
		throw new RepositoryReviewError(
			"DEPENDENCY_NOT_INSTALLED",
			"Run the target repository package-manager install before review",
		);
	}
	const packageRoot = await findPackageRoot(graphCjs);
	const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
		version?: string;
		exports?: Record<string, unknown>;
	};
	if (
		typeof packageJson.version !== "string" ||
		valid(packageJson.version) === null ||
		!satisfies(packageJson.version, SUPPORTED_GRAPHREFLY_RANGE)
	) {
		throw new RepositoryReviewError(
			"DEPENDENCY_UNSUPPORTED",
			`Installed @graphrefly/ts must satisfy ${SUPPORTED_GRAPHREFLY_RANGE}`,
		);
	}
	const graphEntry = importExportPath(packageJson.exports?.["./graph"]);
	const renderEntry = importExportPath(packageJson.exports?.["./render"]);
	if (graphEntry === undefined || renderEntry === undefined) {
		throw new RepositoryReviewError(
			"DEPENDENCY_UNSUPPORTED",
			"Target @graphrefly/ts does not expose the required public entrypoints",
		);
	}
	const [graphModule, renderModule] = await Promise.all([
		import(pathToFileURL(resolve(packageRoot, graphEntry)).href),
		import(pathToFileURL(resolve(packageRoot, renderEntry)).href),
	]);
	for (const [name, value] of [
		["parseGraphBlueprint", graphModule.parseGraphBlueprint],
		["verifyBlueprintHash", graphModule.verifyBlueprintHash],
		["diffGraphBlueprints", graphModule.diffGraphBlueprints],
		["blueprintToMermaid", renderModule.blueprintToMermaid],
	] as const) {
		if (typeof value !== "function") {
			throw new RepositoryReviewError(
				"DEPENDENCY_UNSUPPORTED",
				`Target @graphrefly/ts is missing ${name}`,
			);
		}
	}
	return {
		version: packageJson.version,
		nodeModulesRoot: await realpath(resolve(repository, "node_modules")),
		parseGraphBlueprint: graphModule.parseGraphBlueprint,
		verifyBlueprintHash: graphModule.verifyBlueprintHash,
		blueprintToMermaid: renderModule.blueprintToMermaid,
		diffGraphBlueprints: graphModule.diffGraphBlueprints,
	};
}

async function executeBlueprint(
	repository: string,
	revision: string,
	entrypointPath: string,
	entrypointSource: Uint8Array,
	runtime: TargetGraphReFlyRuntime,
): Promise<Record<string, unknown>> {
	const worktreeRoot = resolve(
		dirname(repository),
		`.graphrefly-stack-review-${basename(repository)}-${process.pid}`,
	);
	const worktree = resolve(worktreeRoot, revision.slice(0, 16));
	await mkdir(worktreeRoot, { recursive: true });
	await rm(worktree, { recursive: true, force: true });
	gitText(repository, ["worktree", "add", "--detach", "--force", worktree, revision]);
	try {
		const canonicalWorktree = await realpath(worktree);
		const entrypoint = resolve(canonicalWorktree, entrypointPath);
		ensureInside(canonicalWorktree, entrypoint);
		try {
			await access(entrypoint);
		} catch {
			let canonicalParent: string;
			try {
				canonicalParent = await realpath(dirname(entrypoint));
			} catch {
				throw new RepositoryReviewError(
					"ENTRYPOINT_MISSING",
					`Blueprint entrypoint parent is missing at ${revision.slice(0, 12)}`,
				);
			}
			ensureInside(canonicalWorktree, canonicalParent);
			await writeFile(resolve(canonicalParent, basename(entrypoint)), entrypointSource, {
				flag: "wx",
			});
		}
		const canonicalEntrypoint = await realpath(entrypoint);
		ensureInside(canonicalWorktree, canonicalEntrypoint);
		const worktreeNodeModules = resolve(canonicalWorktree, "node_modules");
		await rm(worktreeNodeModules, { recursive: true, force: true });
		await symlink(runtime.nodeModulesRoot, worktreeNodeModules, "dir");
		const result = spawnSync(
			process.execPath,
			[
				"--permission",
				`--allow-fs-read=${canonicalWorktree}`,
				`--allow-fs-read=${runtime.nodeModulesRoot}`,
				"--disable-warning=ExperimentalWarning",
				canonicalEntrypoint,
			],
			{
				cwd: canonicalWorktree,
				encoding: "utf8",
				env: {},
				maxBuffer: 1024 * 1024,
				shell: false,
				timeout: 5_000,
			},
		);
		if (result.error !== undefined) {
			const code = (result.error as NodeJS.ErrnoException).code;
			throw new RepositoryReviewError(
				code === "ETIMEDOUT" ? "ENTRYPOINT_TIMEOUT" : "ENTRYPOINT_FAILED",
				code === "ETIMEDOUT"
					? `Blueprint entrypoint timed out at ${revision.slice(0, 12)}`
					: `Blueprint entrypoint could not run at ${revision.slice(0, 12)}`,
			);
		}
		if (result.status !== 0) {
			throw new RepositoryReviewError(
				"ENTRYPOINT_FAILED",
				`Blueprint entrypoint exited ${result.status} at ${revision.slice(0, 12)}`,
			);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(result.stdout);
		} catch {
			throw new RepositoryReviewError(
				"ENTRYPOINT_OUTPUT_INVALID",
				`Blueprint entrypoint did not emit one JSON value at ${revision.slice(0, 12)}`,
			);
		}
		let blueprint: Record<string, unknown>;
		try {
			blueprint = runtime.parseGraphBlueprint(raw);
		} catch {
			throw new RepositoryReviewError(
				"BLUEPRINT_INVALID",
				`GraphBlueprint validation failed at ${revision.slice(0, 12)}`,
			);
		}
		if (blueprint.version !== "graphrefly.blueprint.v2") {
			throw new RepositoryReviewError(
				"BLUEPRINT_VERSION_UNSUPPORTED",
				`GraphBlueprint v2 is required at ${revision.slice(0, 12)}`,
			);
		}
		const diagnostics = blueprint.diagnostics as { ok?: unknown } | undefined;
		if (diagnostics?.ok !== true) {
			throw new RepositoryReviewError(
				"BLUEPRINT_DIAGNOSTICS_ERROR",
				`GraphBlueprint diagnostics are unavailable or invalid at ${revision.slice(0, 12)}`,
			);
		}
		const hash = blueprint.hash as { algorithm?: unknown } | undefined;
		if (
			hash?.algorithm !== "sha256" ||
			!(await runtime.verifyBlueprintHash(blueprint, {
				algorithm: "sha256",
				hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
			}))
		) {
			throw new RepositoryReviewError(
				"BLUEPRINT_HASH_MISMATCH",
				`GraphBlueprint hash verification failed at ${revision.slice(0, 12)}`,
			);
		}
		if (containsAbsolutePath(blueprint.topology)) {
			throw new RepositoryReviewError(
				"BLUEPRINT_PRIVATE_PATH",
				`GraphBlueprint topology contains an absolute path at ${revision.slice(0, 12)}`,
			);
		}
		const { provenance: _privateProvenance, ...publicBlueprint } = blueprint;
		return publicBlueprint;
	} finally {
		try {
			gitText(repository, ["worktree", "remove", "--force", worktree]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	}
}

function diagramFor(
	runtime: TargetGraphReFlyRuntime,
	blueprint: Record<string, unknown>,
): RepositoryDiagram {
	let source: string;
	try {
		source = runtime.blueprintToMermaid(blueprint);
	} catch {
		throw new RepositoryReviewError("BLUEPRINT_RENDER_FAILED", "Blueprint rendering failed");
	}
	if (!source.startsWith("flowchart ")) {
		throw new RepositoryReviewError(
			"BLUEPRINT_RENDER_FAILED",
			"Blueprint renderer returned an unsupported document",
		);
	}
	return {
		format: "mermaid",
		renderer: "@graphrefly/ts/render.blueprintToMermaid",
		source,
	};
}

async function validateDependencyContinuity(
	repository: string,
	revisions: readonly string[],
	installedVersion: string,
): Promise<void> {
	for (const revision of revisions) {
		let packageJson: Record<string, unknown>;
		try {
			packageJson = JSON.parse(gitObject(repository, revision, "package.json"));
		} catch {
			throw new RepositoryReviewError(
				"DEPENDENCY_MANIFEST_INVALID",
				`package.json is missing or invalid at ${revision.slice(0, 12)}`,
			);
		}
		const pins = graphReFlyPins(packageJson);
		if (pins.length === 0 || pins.some((pin) => !satisfies(installedVersion, pin))) {
			throw new RepositoryReviewError(
				"DEPENDENCY_UNSUPPORTED",
				`@graphrefly/ts must accept installed ${installedVersion} at ${revision.slice(0, 12)}`,
			);
		}
		const lockFiles = gitText(repository, [
			"ls-tree",
			"--name-only",
			revision,
			"--",
			...lockCandidates,
		])
			.split("\n")
			.filter(Boolean);
		if (lockFiles.length !== 1) {
			throw new RepositoryReviewError(
				"DEPENDENCY_LOCK_UNSUPPORTED",
				`Exactly one root pnpm, npm, or Yarn lockfile is required at ${revision.slice(0, 12)}`,
			);
		}
	}
}

export async function validateRepositoryReview(review: RepositoryReview): Promise<void> {
	const [configSchema, reviewSchema, semanticSchema] = await readSchemas();
	const ajv = createStrictAjv();
	ajv.addSchema(configSchema);
	ajv.addSchema(semanticSchema);
	const validate = ajv.compile(reviewSchema);
	if (!validate(review)) {
		throw new RepositoryReviewError(
			"REVIEW_SCHEMA_INVALID",
			`Repository review failed validation: ${JSON.stringify(validate.errors)}`,
		);
	}
}

function reviewHeadLabel(repository: string, requested: string, headOid: string): string {
	try {
		const symbolic = gitText(repository, ["rev-parse", "--symbolic-full-name", requested]);
		if (symbolic.startsWith("refs/heads/")) return symbolic.slice("refs/heads/".length);
	} catch {
		// A detached or object-id head has no symbolic branch label.
	}
	try {
		const branch = gitText(repository, [
			"for-each-ref",
			"--format=%(refname:short)",
			"--points-at",
			headOid,
			"refs/heads",
		])
			.split("\n")
			.find(Boolean);
		if (branch !== undefined) return branch;
	} catch {
		// Fall back to a stable short object identity.
	}
	return headOid.slice(0, 12);
}

export async function createRepositoryBlueprintSnapshot(options: {
	repository: string;
	revision: string;
	requireEntrypointAtRevision?: boolean;
}): Promise<{
	repository: string;
	commit: { algorithm: "sha1" | "sha256"; value: string };
	graphreflyVersion: string;
	blueprint: Record<string, unknown>;
	blueprintHash: { algorithm: "sha256"; value: string };
}> {
	let repository: string;
	try {
		const requested = await realpath(resolve(options.repository));
		repository = await realpath(gitText(requested, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new RepositoryReviewError(
			"REPOSITORY_INVALID",
			"Repository must be a local Git worktree",
		);
	}
	const config = await readRepositoryConfig(repository);
	const entrypointSource = await readConfiguredEntrypoint(repository, config.blueprint.entrypoint);
	const git = new SystemGitAdapter();
	let commit: { algorithm: "sha1" | "sha256"; value: string };
	try {
		commit = await git.resolveCommit(repository, options.revision);
	} catch {
		throw new RepositoryReviewError("REVISION_INVALID", "Revision must resolve to a commit");
	}
	if (options.requireEntrypointAtRevision === true) {
		try {
			gitObject(repository, commit.value, config.blueprint.entrypoint);
		} catch {
			throw new RepositoryReviewError(
				"ENTRYPOINT_MISSING",
				`Blueprint entrypoint is missing at ${commit.value.slice(0, 12)}`,
			);
		}
	}
	const runtime = await resolveTargetRuntime(repository);
	await validateDependencyContinuity(repository, [commit.value], runtime.version);
	const blueprint = await executeBlueprint(
		repository,
		commit.value,
		config.blueprint.entrypoint,
		entrypointSource,
		runtime,
	);
	const hash = blueprint.hash as { algorithm?: unknown; value?: unknown } | undefined;
	if (hash?.algorithm !== "sha256" || typeof hash.value !== "string") {
		throw new RepositoryReviewError(
			"BLUEPRINT_HASH_MISMATCH",
			`GraphBlueprint hash is unavailable at ${commit.value.slice(0, 12)}`,
		);
	}
	return {
		repository,
		commit,
		graphreflyVersion: runtime.version,
		blueprint,
		blueprintHash: { algorithm: "sha256", value: hash.value },
	};
}

export async function diffRepositoryBlueprintSnapshots(options: {
	repository: string;
	previous: Record<string, unknown>;
	next: Record<string, unknown>;
}): Promise<{
	delta: Record<string, unknown>;
	digest: { algorithm: "sha256"; value: string };
}> {
	let repository: string;
	try {
		const requested = await realpath(resolve(options.repository));
		repository = await realpath(gitText(requested, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new RepositoryReviewError(
			"REPOSITORY_INVALID",
			"Repository must be a local Git worktree",
		);
	}
	const runtime = await resolveTargetRuntime(repository);
	let delta: Record<string, unknown>;
	try {
		delta = runtime.diffGraphBlueprints(options.previous, options.next);
	} catch {
		throw new RepositoryReviewError("BLUEPRINT_DELTA_FAILED", "Blueprint delta failed");
	}
	return {
		delta,
		digest: { algorithm: "sha256", value: sha256Jcs(delta) },
	};
}

export async function createRepositoryReview(options: {
	repository: string;
	base: string;
	head: string;
}): Promise<RepositoryReview> {
	let repository: string;
	try {
		const requested = await realpath(resolve(options.repository));
		repository = await realpath(gitText(requested, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new RepositoryReviewError(
			"REPOSITORY_INVALID",
			"Repository must be a local Git worktree",
		);
	}
	const config = await readRepositoryConfig(repository);
	const entrypointSource = await readConfiguredEntrypoint(repository, config.blueprint.entrypoint);
	const git = new SystemGitAdapter();
	let baseOid: string;
	let headOid: string;
	try {
		baseOid = (await git.resolveCommit(repository, options.base)).value;
		headOid = (await git.resolveCommit(repository, options.head)).value;
	} catch {
		throw new RepositoryReviewError("REVISION_INVALID", "Base and head must resolve to commits");
	}
	if (baseOid === headOid || gitText(repository, ["merge-base", baseOid, headOid]) !== baseOid) {
		throw new RepositoryReviewError("NON_LINEAR_HISTORY", "Base must be a strict ancestor of head");
	}
	const revisions = gitText(repository, [
		"rev-list",
		"--reverse",
		"--first-parent",
		`${baseOid}..${headOid}`,
	])
		.split("\n")
		.filter(Boolean);
	const ancestry = gitText(repository, [
		"rev-list",
		"--reverse",
		"--ancestry-path",
		`${baseOid}..${headOid}`,
	])
		.split("\n")
		.filter(Boolean);
	if (revisions.length > maxReviewCommits) {
		throw new RepositoryReviewError(
			"REVIEW_RANGE_TOO_LARGE",
			`The first release reviews at most ${maxReviewCommits} commits per run`,
		);
	}
	if (revisions.length === 0 || revisions.join("\n") !== ancestry.join("\n")) {
		throw new RepositoryReviewError(
			"NON_LINEAR_HISTORY",
			"Reviewed history must be one merge-free first-parent chain",
		);
	}
	let expectedParent = baseOid;
	for (const revision of revisions) {
		const parts = gitText(repository, ["rev-list", "--parents", "-n", "1", revision]).split(" ");
		if (parts.length !== 2 || parts[1] !== expectedParent) {
			throw new RepositoryReviewError(
				"NON_LINEAR_HISTORY",
				"Reviewed history must be one merge-free first-parent chain",
			);
		}
		expectedParent = revision;
	}
	const allRevisions = [baseOid, ...revisions];
	const runtime = await resolveTargetRuntime(repository);
	await validateDependencyContinuity(repository, allRevisions, runtime.version);
	const evidence: RepositoryRevisionEvidence[] = [];
	for (const revision of allRevisions) {
		const blueprint = await executeBlueprint(
			repository,
			revision,
			config.blueprint.entrypoint,
			entrypointSource,
			runtime,
		);
		evidence.push({
			oid: revision,
			subject: gitText(repository, ["show", "-s", "--format=%s", revision]),
			blueprint,
			diagram: diagramFor(runtime, blueprint),
		});
	}
	const commits = await Promise.all(
		revisions.map(async (revision, index) => {
			const prior = evidence[index] as RepositoryRevisionEvidence;
			const current = evidence[index + 1] as RepositoryRevisionEvidence;
			let delta: Record<string, unknown>;
			try {
				delta = runtime.diffGraphBlueprints(prior.blueprint, current.blueprint);
			} catch {
				throw new RepositoryReviewError(
					"BLUEPRINT_DELTA_FAILED",
					`Blueprint delta failed at ${revision.slice(0, 12)}`,
				);
			}
			const oid = { algorithm: oidAlgorithm(revision), value: revision } as const;
			const patch = Buffer.from(await git.canonicalDiff(repository, oid)).toString("utf8");
			return {
				...current,
				parentOid: prior.oid,
				delta,
				diff: parseStructuredDiff(patch),
			};
		}),
	);
	const review: RepositoryReview = {
		schema: REPOSITORY_REVIEW_SCHEMA,
		source: "generic-repository",
		repository: {
			label: basename(repository),
			headLabel: reviewHeadLabel(repository, options.head, headOid),
			graphreflyVersion: runtime.version,
			entrypoint: config.blueprint.entrypoint,
			baseOid,
			headOid,
		},
		base: evidence[0] as RepositoryRevisionEvidence,
		commits,
		semanticStatus: "not-configured",
	};
	await validateRepositoryReview(review);
	return review;
}
