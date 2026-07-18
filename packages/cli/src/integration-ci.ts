import { appendFile, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { canonicalize, sha256Jcs } from "@graphrefly-stack/contracts";

import { selectPlan } from "./ci-runner.js";
import { runIntegration } from "./integration-runner.js";
import { gitText } from "./system-git.js";

type JsonObject = Record<string, unknown>;
const maxEventBytes = 2 * 1024 * 1024;

export class IntegrationCiError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "IntegrationCiError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new IntegrationCiError("INTEGRATION_CI_EVENT_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function oid(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
		throw new IntegrationCiError("INTEGRATION_CI_EVENT_INVALID", `${label} must be a Git OID`);
	}
	return value;
}

function identity(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) {
		throw new IntegrationCiError("INTEGRATION_CI_EVENT_INVALID", `${label} is invalid`);
	}
	return value;
}

async function repositoryRoot(requested: string): Promise<string> {
	try {
		const canonical = await realpath(resolve(requested));
		return await realpath(gitText(canonical, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new IntegrationCiError(
			"INTEGRATION_CI_REPOSITORY_INVALID",
			"Integration CI requires a local Git worktree",
		);
	}
}

async function outsideRepositoryPath(repository: string, requested: string, label: string) {
	if (/[\r\n]/u.test(requested)) {
		throw new IntegrationCiError("INTEGRATION_CI_OUTPUT_INVALID", `${label} contains a line break`);
	}
	let path: string;
	try {
		path = resolve(await realpath(dirname(resolve(requested))), basename(requested));
	} catch {
		throw new IntegrationCiError(
			"INTEGRATION_CI_OUTPUT_INVALID",
			`${label} parent must already exist`,
		);
	}
	if (path === repository || path.startsWith(`${repository}${sep}`)) {
		throw new IntegrationCiError(
			"INTEGRATION_CI_OUTPUT_INVALID",
			`${label} must remain outside the repository`,
		);
	}
	return path;
}

async function readEvent(path: string): Promise<JsonObject> {
	let bytes: Buffer;
	try {
		bytes = await readFile(resolve(path));
	} catch {
		throw new IntegrationCiError(
			"INTEGRATION_CI_EVENT_INVALID",
			"GitHub event file could not be read",
		);
	}
	if (bytes.byteLength === 0 || bytes.byteLength > maxEventBytes) {
		throw new IntegrationCiError(
			"INTEGRATION_CI_EVENT_INVALID",
			"GitHub event file size is outside the v1 bound",
		);
	}
	try {
		return object(JSON.parse(bytes.toString("utf8")), "event");
	} catch (error) {
		if (error instanceof IntegrationCiError) throw error;
		throw new IntegrationCiError(
			"INTEGRATION_CI_EVENT_INVALID",
			"GitHub event file is not valid JSON",
		);
	}
}

export async function runIntegrationCi(options: {
	repository: string;
	eventPath: string;
	output: string;
	planId?: string;
	environment?: NodeJS.ProcessEnv;
}) {
	const environment = options.environment ?? process.env;
	if (environment.GITHUB_EVENT_NAME !== "pull_request") {
		throw new IntegrationCiError(
			"INTEGRATION_CI_EVENT_UNSUPPORTED",
			"Only pull_request is supported",
		);
	}
	const repository = await repositoryRoot(options.repository);
	const output = await outsideRepositoryPath(repository, options.output, "integration output");
	const event = await readEvent(options.eventPath);
	const eventRepository = object(event.repository, "repository");
	const owner = object(eventRepository.owner, "repository.owner");
	const pullRequest = object(event.pull_request, "pull_request");
	const base = object(pullRequest.base, "pull_request.base");
	const head = object(pullRequest.head, "pull_request.head");
	const target = oid(base.sha, "pull_request.base.sha");
	const contributorHead = oid(head.sha, "pull_request.head.sha");
	const checkedOutHead = gitText(repository, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (checkedOutHead !== contributorHead) {
		throw new IntegrationCiError(
			"INTEGRATION_CI_HEAD_MISMATCH",
			"Checked-out HEAD does not match the pull-request head",
		);
	}
	const planId = await selectPlan(repository, contributorHead, options.planId);
	const integration = await runIntegration({
		repository,
		target,
		head: contributorHead,
		planId,
		repositoryIdentity: {
			provider: "github",
			owner: identity(owner.login, "repository.owner.login"),
			name: identity(eventRepository.name, "repository.name"),
		},
	});
	const bytes = canonicalize(integration);
	try {
		await writeFile(output, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new IntegrationCiError("INTEGRATION_CI_OUTPUT_EXISTS", output);
		}
		throw error;
	}
	if ((await readFile(output, "utf8")) !== bytes) {
		throw new IntegrationCiError(
			"INTEGRATION_CI_ARTIFACT_INVALID",
			"Persisted integration bytes changed",
		);
	}
	const digest = sha256Jcs(integration);
	const artifactName = `graphrefly-stack-integration-${digest}`;
	if (environment.GITHUB_OUTPUT !== undefined) {
		const githubOutput = await outsideRepositoryPath(
			repository,
			environment.GITHUB_OUTPUT,
			"GITHUB_OUTPUT",
		);
		await appendFile(
			githubOutput,
			`artifact-name=${artifactName}\nartifact-path=${output}\n`,
			"utf8",
		);
	}
	if (environment.GITHUB_STEP_SUMMARY !== undefined) {
		const summary = await outsideRepositoryPath(
			repository,
			environment.GITHUB_STEP_SUMMARY,
			"GITHUB_STEP_SUMMARY",
		);
		await appendFile(
			summary,
			`## GraphReFly Stack semantic integration\n\n- Outcome: ${integration.result.outcome}\n- Reasons: ${integration.result.reasonCodes.join(", ") || "none"}\n`,
			"utf8",
		);
	}
	return { repository, output, artifactName, digest, planId, ...integration };
}
