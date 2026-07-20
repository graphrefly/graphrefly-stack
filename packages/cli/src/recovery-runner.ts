import { spawnSync } from "node:child_process";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	assertRecoveryAttemptChainIntegrity,
	assertRecoveryImpactIntegrity,
	assertRecoveryPlanIntegrity,
	assertRecoveryPortableBundleIntegrity,
	assertRecoveryResultIntegrity,
	canonicalize,
	createStrictAjv,
	RECOVERY_ARTIFACTS_SCHEMA,
	RECOVERY_ATTEMPT_SCHEMA,
	RECOVERY_AUTHORIZATION_SCHEMA,
	RECOVERY_PORTABLE_BUNDLE_SCHEMA,
	RECOVERY_RESULT_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import {
	computeRecoveryImpactV1,
	createRecoveryPlanV1,
	projectRecoveryTopologyV1,
} from "@graphrefly-stack/core";
import { discoverPlanQualifiedGitDag } from "./dag-discovery.js";
import { createDagGraphEvidenceForSemanticGate } from "./dag-evidence.js";
import {
	createDagSemanticGateForProjectedRecovery,
	readDagGateBundle,
} from "./dag-semantic-runner.js";
import { repositoryStateDirectory } from "./repository-review-state.js";
import { runtimeAssetPath } from "./runtime-paths.js";
import { gitText } from "./system-git.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export class RecoveryRunnerError extends Error {
	constructor(
		readonly code:
			| "RECOVERY_INPUT_INVALID"
			| "RECOVERY_EVIDENCE_INVALID"
			| "RECOVERY_PLAN_INVALID"
			| "RECOVERY_AUTHORIZATION_INVALID"
			| "RECOVERY_REF_CONFLICT"
			| "RECOVERY_APPLY_FAILED"
			| "RECOVERY_STATE_INVALID"
			| "RECOVERY_TERMINAL"
			| "RECOVERY_EXPORT_INVALID",
		message: string,
	) {
		super(message);
		this.name = "RecoveryRunnerError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RecoveryRunnerError("RECOVERY_EVIDENCE_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) {
		throw new RecoveryRunnerError("RECOVERY_EVIDENCE_INVALID", `${label} must be an array`);
	}
	return value.map((entry) => object(entry, label));
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function oid(value: string): { algorithm: "sha1" | "sha256"; value: string } {
	return { algorithm: value.length === 64 ? "sha256" : "sha1", value };
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function git(
	repository: string,
	args: string[],
	options: { input?: string; allowed?: number[]; rawStdout?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		input: options.input,
		maxBuffer: 32 * 1024 * 1024,
		shell: false,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "GraphReFly Stack",
			GIT_AUTHOR_EMAIL: "stack@graphrefly.invalid",
			GIT_COMMITTER_NAME: "GraphReFly Stack",
			GIT_COMMITTER_EMAIL: "stack@graphrefly.invalid",
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		},
	});
	const status = result.status ?? 1;
	if (!(options.allowed ?? [0]).includes(status)) {
		throw new RecoveryRunnerError(
			"RECOVERY_APPLY_FAILED",
			(result.stderr || result.stdout || `git ${args[0]} failed`).trim(),
		);
	}
	return {
		stdout: options.rawStdout ? (result.stdout ?? "") : (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
		status,
	};
}

async function validators() {
	const paths = [
		"contracts/semantic/v1/artifacts.schema.json",
		"contracts/dag/v2/artifacts.schema.json",
		"contracts/dag/v2/semantic.schema.json",
		"contracts/dag/v2/merge-group.schema.json",
		"contracts/recovery/v1/artifacts.schema.json",
	] as const;
	const schemas = await Promise.all(
		paths.map(async (path) => JSON.parse(await readFile(runtimeAssetPath(path), "utf8"))),
	);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	return (name: string) => {
		const validate = ajv.getSchema(`${RECOVERY_ARTIFACTS_SCHEMA}#/definitions/${name}`);
		if (validate === undefined) {
			throw new RecoveryRunnerError("RECOVERY_STATE_INVALID", `Missing recovery schema ${name}`);
		}
		return validate;
	};
}

async function assertSchema(name: string, value: unknown): Promise<void> {
	const validate = (await validators())(name);
	if (!validate(value)) {
		throw new RecoveryRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			`${name}: ${JSON.stringify(validate.errors)}`,
		);
	}
}

async function repositoryRoot(repository: string): Promise<string> {
	try {
		return await realpath(gitText(repository, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new RecoveryRunnerError(
			"RECOVERY_INPUT_INVALID",
			"Recovery requires a local Git worktree",
		);
	}
}

function gitJson(repository: string, revision: string, path: string): JsonObject {
	try {
		return object(JSON.parse(gitText(repository, ["show", `${revision}:${path}`])), path);
	} catch {
		throw new RecoveryRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			`Accepted artifact ${revision}:${path} is missing or malformed`,
		);
	}
}

async function persistArtifact(
	repository: string,
	recoveryPlanId: string,
	kind: "impacts" | "plans" | "authorizations" | "attempts" | "results" | "exports",
	value: JsonObject,
	prefix = "",
): Promise<{ path: string; digest: Hash }> {
	const directory = await repositoryStateDirectory(repository, "recoveries", recoveryPlanId, kind);
	const digest = hash(value);
	const path = resolve(directory, `${prefix}${digest.value}.json`);
	try {
		await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let existing: unknown;
		try {
			const metadata = await lstat(path);
			if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe artifact path");
			existing = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new RecoveryRunnerError(
				"RECOVERY_STATE_INVALID",
				`${kind} artifact is unsafe or malformed`,
			);
		}
		if (sha256Jcs(existing) !== digest.value || !equal(existing, value)) {
			throw new RecoveryRunnerError(
				"RECOVERY_STATE_INVALID",
				`${kind} artifact violates its content address`,
			);
		}
	}
	return { path, digest };
}

async function readArtifact(
	repository: string,
	recoveryPlanId: string,
	kind: "impacts" | "plans" | "authorizations" | "results",
	digest: string,
): Promise<JsonObject> {
	if (!/^[0-9a-f]{64}$/u.test(digest)) {
		throw new RecoveryRunnerError("RECOVERY_INPUT_INVALID", `${kind} digest is invalid`);
	}
	const directory = await repositoryStateDirectory(repository, "recoveries", recoveryPlanId, kind);
	const path = resolve(directory, `${digest}.json`);
	let value: unknown;
	try {
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe artifact path");
		value = JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new RecoveryRunnerError(
			"RECOVERY_STATE_INVALID",
			`${kind} artifact is missing or unsafe`,
		);
	}
	if (sha256Jcs(value) !== digest) {
		throw new RecoveryRunnerError("RECOVERY_STATE_INVALID", `${kind} content address changed`);
	}
	return object(value, kind);
}

async function readAttempts(repository: string, recoveryPlanId: string): Promise<JsonObject[]> {
	const directory = await repositoryStateDirectory(
		repository,
		"recoveries",
		recoveryPlanId,
		"attempts",
	);
	const directoryEntries = await readdir(directory, { withFileTypes: true });
	for (const entry of directoryEntries) {
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			!/^\d{4}-[0-9a-f]{64}\.json$/u.test(entry.name)
		) {
			throw new RecoveryRunnerError(
				"RECOVERY_STATE_INVALID",
				`Unexpected recovery attempt entry: ${entry.name}`,
			);
		}
	}
	const entries = directoryEntries.map((entry) => entry.name).sort();
	const attempts: JsonObject[] = [];
	for (const entry of entries) {
		let value: unknown;
		try {
			const path = resolve(directory, entry);
			const metadata = await lstat(path);
			if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe attempt path");
			value = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new RecoveryRunnerError("RECOVERY_STATE_INVALID", `Attempt ${entry} is malformed`);
		}
		const attempt = object(value, "RecoveryAttempt");
		const [sequence, digest] = entry.slice(0, -5).split("-");
		if (Number(sequence) !== attempt.sequence || sha256Jcs(attempt) !== digest) {
			throw new RecoveryRunnerError("RECOVERY_STATE_INVALID", `Attempt ${entry} address changed`);
		}
		await assertSchema("RecoveryAttempt", attempt);
		attempts.push(attempt);
	}
	return attempts;
}

async function appendAttempt(options: {
	repository: string;
	plan: JsonObject;
	authorization: JsonObject;
	attempts: JsonObject[];
	status: string;
	workUnitId?: string;
	expectedBefore: string;
	observedAfter: string;
	failure?: string;
}): Promise<JsonObject> {
	const previous = options.attempts[options.attempts.length - 1];
	const attempt: JsonObject = {
		schema: RECOVERY_ATTEMPT_SCHEMA,
		recoveryPlanId: options.plan.recoveryPlanId,
		planDigest: hash(options.plan),
		authorizationDigest: hash(options.authorization),
		sequence: options.attempts.length,
		previousAttemptDigest: previous === undefined ? null : hash(previous),
		status: options.status,
		workUnitId: options.workUnitId ?? null,
		expectedBefore: oid(options.expectedBefore),
		observedAfter: oid(options.observedAfter),
		failure: options.failure ?? null,
	};
	await assertSchema("RecoveryAttempt", attempt);
	const prefix = `${String(attempt.sequence).padStart(4, "0")}-`;
	await persistArtifact(
		options.repository,
		String(options.plan.recoveryPlanId),
		"attempts",
		attempt,
		prefix,
	);
	options.attempts.push(attempt);
	return attempt;
}

function assertAttemptState(options: {
	plan: JsonObject;
	authorization: JsonObject;
	attempts: JsonObject[];
}): void {
	try {
		assertRecoveryAttemptChainIntegrity(options);
	} catch (error) {
		throw new RecoveryRunnerError(
			"RECOVERY_STATE_INVALID",
			error instanceof Error ? error.message : "Recovery attempt chain integrity failed",
		);
	}
}

function resolvedCommit(repository: string, revision: string): string {
	return git(repository, ["rev-parse", "--verify", `${revision}^{commit}`]).stdout;
}

function refHead(repository: string, ref: string): string | undefined {
	const result = spawnSync("git", ["-C", repository, "rev-parse", "--verify", `${ref}^{commit}`], {
		encoding: "utf8",
		shell: false,
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function updateRef(repository: string, ref: string, next: string, prior?: string): void {
	const args = ["update-ref", "-m", "GraphReFly Stack recovery", ref, next];
	if (prior !== undefined) args.push(prior);
	const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", shell: false });
	if (result.status !== 0) {
		throw new RecoveryRunnerError(
			"RECOVERY_REF_CONFLICT",
			(result.stderr || "Recovery ref compare-and-swap failed").trim(),
		);
	}
}

async function loadPlanState(options: {
	repository: string;
	recoveryPlanId: string;
	planDigest: string;
}): Promise<{ repository: string; impact: JsonObject; plan: JsonObject }> {
	const repository = await repositoryRoot(options.repository);
	const plan = await readArtifact(repository, options.recoveryPlanId, "plans", options.planDigest);
	await assertSchema("RecoveryPlan", plan);
	const impactDigest = String(object(plan.impactDigest, "impact digest").value);
	const impact = await readArtifact(repository, options.recoveryPlanId, "impacts", impactDigest);
	await assertSchema("RecoveryImpact", impact);
	try {
		assertRecoveryPlanIntegrity(impact, plan);
	} catch (error) {
		throw new RecoveryRunnerError(
			"RECOVERY_PLAN_INVALID",
			error instanceof Error ? error.message : "RecoveryPlan integrity failed",
		);
	}
	return { repository, impact, plan };
}

export async function createRecoveryPlan(options: {
	repository: string;
	base: string;
	head: string;
	sourcePlanId: string;
	sourceBundleDigest: string;
	proposalPath: string;
	acceptedBy: string;
	repositoryIdentity: { provider: string; owner: string; name: string };
}) {
	const repository = await repositoryRoot(options.repository);
	const sourceBundle = (await readDagGateBundle(
		repository,
		options.sourcePlanId,
		options.sourceBundleDigest,
	)) as unknown as JsonObject;
	const expectedHead = String(
		object(object(sourceBundle.topology, "source topology").head, "head").value,
	);
	if (resolvedCommit(repository, options.head) !== expectedHead) {
		throw new RecoveryRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Requested head does not match the source DAG bundle",
		);
	}
	const sourceBase = String(
		object(object(sourceBundle.topology, "source topology").base, "base").value,
	);
	if (resolvedCommit(repository, options.base) !== sourceBase) {
		throw new RecoveryRunnerError(
			"RECOVERY_EVIDENCE_INVALID",
			"Requested base does not match the source DAG bundle",
		);
	}
	const sourcePlan = gitJson(
		repository,
		expectedHead,
		`.graphrefly-stack/plans/${options.sourcePlanId}.json`,
	);
	const policy = gitJson(repository, expectedHead, ".graphrefly-stack/policy.json");
	let proposal: JsonObject;
	try {
		proposal = object(
			JSON.parse(await readFile(resolve(options.proposalPath), "utf8")),
			"proposal",
		);
	} catch {
		throw new RecoveryRunnerError("RECOVERY_INPUT_INVALID", "Recovery proposal is malformed");
	}
	await assertSchema("RecoveryPlanProposal", proposal);
	if (String(proposal.recoveryPlanId) === String(proposal.postRecoveryPlanId)) {
		throw new RecoveryRunnerError(
			"RECOVERY_PLAN_INVALID",
			"Recovery evidence ID and post-recovery Plan ID must differ",
		);
	}
	const postPlanPath = `.graphrefly-stack/plans/${String(proposal.postRecoveryPlanId)}.json`;
	const existingPostPlan = git(repository, ["cat-file", "-e", `${expectedHead}:${postPlanPath}`], {
		allowed: [0, 128],
	});
	if (existingPostPlan.status === 0) {
		throw new RecoveryRunnerError(
			"RECOVERY_PLAN_INVALID",
			"Post-recovery Plan identity already exists at the authorized head",
		);
	}
	let impact: JsonObject;
	let plan: JsonObject;
	try {
		impact = computeRecoveryImpactV1({
			repository: options.repositoryIdentity,
			sourceBundle,
			sourcePlan,
			policy,
			selection: proposal.selection as "work-units" | "plan",
			targetWorkUnitIds: proposal.targetWorkUnitIds as string[],
		});
		plan = createRecoveryPlanV1({ impact, proposal, acceptedBy: options.acceptedBy });
		assertRecoveryImpactIntegrity(impact);
		assertRecoveryPlanIntegrity(impact, plan);
	} catch (error) {
		if (error instanceof RecoveryRunnerError) throw error;
		throw new RecoveryRunnerError(
			"RECOVERY_PLAN_INVALID",
			error instanceof Error ? error.message : "Recovery planning failed",
		);
	}
	await assertSchema("RecoveryImpact", impact);
	await assertSchema("RecoveryPlan", plan);
	const impactArtifact = await persistArtifact(
		repository,
		String(plan.recoveryPlanId),
		"impacts",
		impact,
	);
	const planArtifact = await persistArtifact(
		repository,
		String(plan.recoveryPlanId),
		"plans",
		plan,
	);
	return { repository, impact, plan, impactArtifact, planArtifact };
}

async function materialize(options: {
	repository: string;
	impact: JsonObject;
	plan: JsonObject;
	authorization: JsonObject;
	maxSteps?: number;
	resume: boolean;
}) {
	const recoveryPlanId = String(options.plan.recoveryPlanId);
	const recoveryRef = String(options.authorization.recoveryRef);
	const expectedHead = String(object(options.plan.expectedHead, "expected head").value);
	if (resolvedCommit(options.repository, "HEAD") !== expectedHead) {
		throw new RecoveryRunnerError(
			"RECOVERY_REF_CONFLICT",
			"Caller HEAD moved after recovery planning; recompute before execution",
		);
	}
	const attempts = await readAttempts(options.repository, recoveryPlanId);
	if (attempts.some((attempt) => ["completed", "aborted"].includes(String(attempt.status)))) {
		throw new RecoveryRunnerError("RECOVERY_TERMINAL", "Recovery attempt is already terminal");
	}
	if (options.resume) {
		if (attempts.length === 0) {
			throw new RecoveryRunnerError("RECOVERY_STATE_INVALID", "Recovery has no attempt to resume");
		}
		assertAttemptState({
			plan: options.plan,
			authorization: options.authorization,
			attempts,
		});
	} else {
		if (attempts.length > 0 || refHead(options.repository, recoveryRef) !== undefined) {
			throw new RecoveryRunnerError(
				"RECOVERY_REF_CONFLICT",
				"Recovery ref or attempt history already exists; use rollback resume",
			);
		}
		const zero = "0".repeat(expectedHead.length);
		updateRef(options.repository, recoveryRef, expectedHead, zero);
		await appendAttempt({
			repository: options.repository,
			plan: options.plan,
			authorization: options.authorization,
			attempts,
			status: "branch-created",
			expectedBefore: expectedHead,
			observedAfter: expectedHead,
		});
	}
	const currentRef = refHead(options.repository, recoveryRef);
	const last = attempts[attempts.length - 1] as JsonObject;
	if (
		currentRef === undefined ||
		currentRef !== String(object(last.observedAfter, "last head").value)
	) {
		throw new RecoveryRunnerError(
			"RECOVERY_STATE_INVALID",
			"Recovery ref no longer matches the append-only attempt chain",
		);
	}
	const temporaryRoot = await mkdtemp(resolve(tmpdir(), "graphrefly-recovery-"));
	const worktree = resolve(temporaryRoot, "checkout");
	let added = false;
	try {
		git(options.repository, ["worktree", "add", "--detach", worktree, currentRef]);
		added = true;
		if (!attempts.some((attempt) => attempt.status === "plan-accepted")) {
			const planId = String(object(options.plan.postRecoveryPlan, "post-recovery Plan").planId);
			const planPath = resolve(worktree, ".graphrefly-stack", "plans", `${planId}.json`);
			await mkdir(dirname(planPath), { recursive: true });
			await writeFile(planPath, `${JSON.stringify(options.plan.postRecoveryPlan, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
			});
			git(worktree, ["add", `.graphrefly-stack/plans/${planId}.json`]);
			const before = resolvedCommit(worktree, "HEAD");
			git(worktree, ["commit", "-m", `Accept recovery Plan ${planId}`]);
			const after = resolvedCommit(worktree, "HEAD");
			updateRef(options.repository, recoveryRef, after, before);
			await appendAttempt({
				repository: options.repository,
				plan: options.plan,
				authorization: options.authorization,
				attempts,
				status: "plan-accepted",
				expectedBefore: before,
				observedAfter: after,
			});
		}
		const alreadyApplied = new Set(
			attempts
				.filter((attempt) => attempt.status === "step-applied")
				.map((attempt) => String(attempt.workUnitId)),
		);
		const alreadyRetained = new Set(
			attempts
				.filter((attempt) => attempt.status === "step-retained")
				.map((attempt) => String(attempt.workUnitId)),
		);
		const stepById = new Map(
			objects(options.plan.steps, "recovery steps").map(
				(step) => [String(step.workUnitId), step] as const,
			),
		);
		for (const step of objects(options.plan.steps, "recovery steps")) {
			const id = String(step.workUnitId);
			if (step.disposition !== "retain" || alreadyRetained.has(id)) continue;
			const head = resolvedCommit(worktree, "HEAD");
			await appendAttempt({
				repository: options.repository,
				plan: options.plan,
				authorization: options.authorization,
				attempts,
				status: "step-retained",
				workUnitId: id,
				expectedBefore: head,
				observedAfter: head,
			});
		}
		let appliedThisRun = 0;
		for (const id of options.plan.executionOrder as string[]) {
			if (alreadyApplied.has(id)) continue;
			if (options.maxSteps !== undefined && appliedThisRun >= options.maxSteps) {
				const head = resolvedCommit(worktree, "HEAD");
				await appendAttempt({
					repository: options.repository,
					plan: options.plan,
					authorization: options.authorization,
					attempts,
					status: "partial",
					expectedBefore: head,
					observedAfter: head,
				});
				return { status: "partial" as const, recoveryRef, head, attempts };
			}
			const step = stepById.get(id) as JsonObject;
			const operation = object(step.operation, `${id} operation`);
			const before = resolvedCommit(worktree, "HEAD");
			try {
				if (operation.kind === "inverse") {
					const source = String(object(operation.sourceCommit, "inverse source").value);
					const patch = git(
						options.repository,
						["show", "--format=", "--binary", "--full-index", source],
						{ rawStdout: true },
					).stdout;
					git(worktree, ["apply", "--reverse", "--index", "--whitespace=nowarn", "-"], {
						input: patch,
					});
				} else {
					git(worktree, ["apply", "--index", "--whitespace=nowarn", "-"], {
						input: String(operation.patch),
					});
				}
				const changed = git(worktree, ["diff", "--cached", "--name-only", "-z"])
					.stdout.split("\0")
					.filter(Boolean);
				const scopes = step.postRecoveryWorkUnit
					? (object(step.postRecoveryWorkUnit, `${id} WorkUnit`).allowedSourceScopes as string[])
					: [];
				if (
					changed.length === 0 ||
					changed.some(
						(path) => !scopes.some((scope) => path === scope || path.startsWith(`${scope}/`)),
					)
				) {
					throw new RecoveryRunnerError(
						"RECOVERY_APPLY_FAILED",
						`${id} recovery patch is empty or exceeds its accepted source scope`,
					);
				}
				const postPlanId = String(object(options.plan.postRecoveryPlan, "post Plan").planId);
				git(worktree, [
					"commit",
					"-m",
					`Recover ${id} (${String(step.disposition)})`,
					"-m",
					`GraphReFly-Plan: ${postPlanId}\nGraphReFly-Work-Unit: ${id}`,
				]);
				const after = resolvedCommit(worktree, "HEAD");
				updateRef(options.repository, recoveryRef, after, before);
				await appendAttempt({
					repository: options.repository,
					plan: options.plan,
					authorization: options.authorization,
					attempts,
					status: "step-applied",
					workUnitId: id,
					expectedBefore: before,
					observedAfter: after,
				});
				appliedThisRun += 1;
			} catch (error) {
				const failure =
					error instanceof Error ? error.message.slice(0, 2048) : "Recovery step failed";
				await appendAttempt({
					repository: options.repository,
					plan: options.plan,
					authorization: options.authorization,
					attempts,
					status: "step-failed",
					workUnitId: id,
					expectedBefore: before,
					observedAfter: before,
					failure,
				});
				return { status: "partial" as const, recoveryRef, head: before, attempts, failure };
			}
		}
		const finalHead = resolvedCommit(worktree, "HEAD");
		const sourceTopology = object(
			object(options.impact.sourceBundle, "source bundle").topology,
			"source topology",
		);
		const base = String(object(sourceTopology.base, "source base").value);
		const graphEvidence = await createDagGraphEvidenceForSemanticGate({
			repository: options.repository,
			base,
			head: finalHead,
			repositoryIdentity: options.impact.repository as {
				provider: string;
				owner: string;
				name: string;
			},
		});
		const qualified = await discoverPlanQualifiedGitDag({
			repository: options.repository,
			base,
			head: finalHead,
		});
		const changedUnits = options.plan.executionOrder as string[];
		const retainedUnits = objects(
			object(options.plan.postRecoveryPlan, "post Plan").workUnits,
			"post WorkUnits",
		)
			.map((unit) => String(unit.id))
			.filter((id) => !changedUnits.includes(id));
		const effectiveTopology = projectRecoveryTopologyV1({
			topology: graphEvidence.topology,
			qualifiedCommits: qualified.qualifiedCommits,
			sourcePlanId: String(options.plan.sourcePlanId),
			recoveryPlanId: String(object(options.plan.postRecoveryPlan, "post Plan").planId),
			retainedUnits,
			changedUnits,
		});
		const postRecoveryBundle = (await createDagSemanticGateForProjectedRecovery({
			repository: options.repository,
			base,
			head: finalHead,
			planId: String(object(options.plan.postRecoveryPlan, "post Plan").planId),
			repositoryIdentity: options.impact.repository as {
				provider: string;
				owner: string;
				name: string;
			},
			graphEvidence: { ...graphEvidence, topology: effectiveTopology },
			projectedRecovery: {
				sourcePlanId: String(options.plan.sourcePlanId),
				sourceHead: expectedHead,
				preservedUnits: retainedUnits,
				qualifiedCommits: qualified.qualifiedCommits,
			},
		})) as unknown as JsonObject;
		await appendAttempt({
			repository: options.repository,
			plan: options.plan,
			authorization: options.authorization,
			attempts,
			status: "completed",
			expectedBefore: finalHead,
			observedAfter: finalHead,
		});
		const externalEffectsResolved = objects(options.plan.steps, "steps").every((step) =>
			objects(step.externalEffects, `${String(step.workUnitId)} effects`).every(
				(effect) => effect.status !== "unresolved",
			),
		);
		const verdict = String(
			object(postRecoveryBundle.gateResult, "post-recovery GateResult").verdict,
		);
		const outcome =
			verdict === "error"
				? "error"
				: verdict === "pass" && externalEffectsResolved
					? "recovered"
					: "blocked";
		const result: JsonObject = {
			schema: RECOVERY_RESULT_SCHEMA,
			impact: options.impact,
			plan: options.plan,
			authorization: options.authorization,
			attempts,
			sharedTopology: graphEvidence.topology,
			qualifiedCommits: qualified.qualifiedCommits,
			effectiveTopology,
			postRecoveryBundle,
			outcome,
			externalEffectsResolved,
		};
		await assertSchema("RecoveryResult", result);
		try {
			assertRecoveryResultIntegrity(result);
		} catch (error) {
			throw new RecoveryRunnerError(
				"RECOVERY_EVIDENCE_INVALID",
				error instanceof Error ? error.message : "RecoveryResult integrity failed",
			);
		}
		if (refHead(options.repository, recoveryRef) !== finalHead) {
			throw new RecoveryRunnerError(
				"RECOVERY_REF_CONFLICT",
				"Recovery ref moved before result persistence",
			);
		}
		const artifact = await persistArtifact(options.repository, recoveryPlanId, "results", result);
		return { status: "complete" as const, recoveryRef, head: finalHead, result, artifact };
	} finally {
		if (added) {
			spawnSync("git", ["-C", options.repository, "worktree", "remove", "--force", worktree], {
				encoding: "utf8",
				shell: false,
			});
		}
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

export async function applyRecovery(options: {
	repository: string;
	recoveryPlanId: string;
	planDigest: string;
	authorizedBy: string;
	maxSteps?: number;
}) {
	if (options.authorizedBy.trim() === "") {
		throw new RecoveryRunnerError("RECOVERY_AUTHORIZATION_INVALID", "--authorize-by is required");
	}
	if (
		options.maxSteps !== undefined &&
		(!Number.isInteger(options.maxSteps) || options.maxSteps < 1)
	) {
		throw new RecoveryRunnerError(
			"RECOVERY_INPUT_INVALID",
			"--max-steps must be a positive integer",
		);
	}
	const { repository, impact, plan } = await loadPlanState(options);
	const authorization: JsonObject = {
		schema: RECOVERY_AUTHORIZATION_SCHEMA,
		recoveryPlanId: plan.recoveryPlanId,
		planDigest: hash(plan),
		impactDigest: plan.impactDigest,
		policyDigest: plan.policyDigest,
		expectedHead: plan.expectedHead,
		recoveryRef: `refs/heads/grfs/recovery/${String(plan.recoveryPlanId)}`,
		action: "materialize-recovery-branch",
		authorizedBy: { label: options.authorizedBy.trim(), identityVerified: false },
	};
	await assertSchema("RecoveryAuthorization", authorization);
	const authorizationArtifact = await persistArtifact(
		repository,
		options.recoveryPlanId,
		"authorizations",
		authorization,
	);
	return {
		authorization,
		authorizationArtifact,
		...(await materialize({
			repository,
			impact,
			plan,
			authorization,
			maxSteps: options.maxSteps,
			resume: false,
		})),
	};
}

export async function resumeRecovery(options: {
	repository: string;
	recoveryPlanId: string;
	planDigest: string;
	authorizationDigest: string;
	maxSteps?: number;
}) {
	if (
		options.maxSteps !== undefined &&
		(!Number.isInteger(options.maxSteps) || options.maxSteps < 1)
	) {
		throw new RecoveryRunnerError(
			"RECOVERY_INPUT_INVALID",
			"--max-steps must be a positive integer",
		);
	}
	const { repository, impact, plan } = await loadPlanState(options);
	const authorization = await readArtifact(
		repository,
		options.recoveryPlanId,
		"authorizations",
		options.authorizationDigest,
	);
	await assertSchema("RecoveryAuthorization", authorization);
	return materialize({
		repository,
		impact,
		plan,
		authorization,
		maxSteps: options.maxSteps,
		resume: true,
	});
}

export async function abortRecovery(options: {
	repository: string;
	recoveryPlanId: string;
	planDigest: string;
	authorizationDigest: string;
}) {
	const { repository, plan } = await loadPlanState(options);
	const authorization = await readArtifact(
		repository,
		options.recoveryPlanId,
		"authorizations",
		options.authorizationDigest,
	);
	await assertSchema("RecoveryAuthorization", authorization);
	const attempts = await readAttempts(repository, options.recoveryPlanId);
	assertAttemptState({ plan, authorization, attempts });
	if (attempts.some((attempt) => ["completed", "aborted"].includes(String(attempt.status)))) {
		throw new RecoveryRunnerError("RECOVERY_TERMINAL", "Recovery attempt is already terminal");
	}
	const last = attempts[attempts.length - 1] as JsonObject;
	const head = String(object(last.observedAfter, "last recovery head").value);
	if (refHead(repository, String(authorization.recoveryRef)) !== head) {
		throw new RecoveryRunnerError("RECOVERY_STATE_INVALID", "Recovery ref moved before abort");
	}
	await appendAttempt({
		repository,
		plan,
		authorization,
		attempts,
		status: "aborted",
		expectedBefore: head,
		observedAfter: head,
	});
	return { recoveryRef: authorization.recoveryRef, head, attempts, branchPreserved: true };
}

export async function recoveryStatus(options: {
	repository: string;
	recoveryPlanId: string;
	planDigest: string;
}) {
	const { repository, impact, plan } = await loadPlanState(options);
	const attempts = await readAttempts(repository, options.recoveryPlanId);
	if (attempts.length > 0) {
		const authorizationDigest = String(
			object(attempts[0]?.authorizationDigest, "attempt authorization digest").value,
		);
		const authorization = await readArtifact(
			repository,
			options.recoveryPlanId,
			"authorizations",
			authorizationDigest,
		);
		await assertSchema("RecoveryAuthorization", authorization);
		assertAttemptState({ plan, authorization, attempts });
	}
	const recoveryRef = `refs/heads/grfs/recovery/${options.recoveryPlanId}`;
	return {
		repository,
		impactDigest: hash(impact),
		plan,
		recoveryRef,
		head: refHead(repository, recoveryRef) ?? null,
		attempts,
		terminal: attempts.at(-1)?.status ?? null,
	};
}

export async function exportRecovery(options: {
	repository: string;
	recoveryPlanId: string;
	resultDigest: string;
	output: string;
}) {
	const repository = await repositoryRoot(options.repository);
	const result = await readArtifact(
		repository,
		options.recoveryPlanId,
		"results",
		options.resultDigest,
	);
	await assertSchema("RecoveryResult", result);
	try {
		assertRecoveryResultIntegrity(result);
	} catch (error) {
		throw new RecoveryRunnerError(
			"RECOVERY_EXPORT_INVALID",
			error instanceof Error ? error.message : "RecoveryResult integrity failed",
		);
	}
	const bundle: JsonObject = {
		schema: RECOVERY_PORTABLE_BUNDLE_SCHEMA,
		resultDigest: hash(result),
		result,
	};
	await assertSchema("RecoveryPortableBundle", bundle);
	assertRecoveryPortableBundleIntegrity(bundle);
	const output = resolve(options.output);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	const artifact = await persistArtifact(repository, options.recoveryPlanId, "exports", bundle);
	return { output, digest: hash(bundle), artifact };
}

export async function verifyRecoveryExport(path: string) {
	let bundle: JsonObject;
	try {
		bundle = object(JSON.parse(await readFile(resolve(path), "utf8")), "portable bundle");
	} catch {
		throw new RecoveryRunnerError("RECOVERY_EXPORT_INVALID", "Recovery export is malformed");
	}
	await assertSchema("RecoveryPortableBundle", bundle);
	try {
		assertRecoveryPortableBundleIntegrity(bundle);
	} catch (error) {
		throw new RecoveryRunnerError(
			"RECOVERY_EXPORT_INVALID",
			error instanceof Error ? error.message : "Recovery export integrity failed",
		);
	}
	return { path: resolve(path), digest: hash(bundle), resultDigest: bundle.resultDigest };
}
