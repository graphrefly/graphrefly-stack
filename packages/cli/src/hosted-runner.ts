import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertCiBundleIntegrity,
	CI_ARTIFACTS_SCHEMA,
	CI_BUNDLE_SCHEMA,
	canonicalize,
	createStrictAjv,
	HOSTED_ARTIFACTS_SCHEMA,
	HOSTED_ENVELOPE_SCHEMA,
	HOSTED_GATE_SUMMARY_SCHEMA,
	HOSTED_MAX_ENVELOPE_BYTES,
	HOSTED_OIDC_AUDIENCE,
	HOSTED_OIDC_CLAIMS_SCHEMA,
	HOSTED_OIDC_ISSUER,
	HOSTED_REDACTION_EXCLUDES,
	HOSTED_SEMANTIC_REVIEW_SCHEMA,
	HOSTED_SYNC_WORKFLOW_NAME,
	HOSTED_SYNC_WORKFLOW_PATH,
	type HostedRedactionProfile,
	SEMANTIC_ARTIFACTS_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

import { runtimeAssetPath } from "./runtime-paths.js";
import { gitText } from "./system-git.js";

type JsonObject = Record<string, unknown>;

const maxOidcResponseBytes = 64 * 1024;
const maxUploadResponseBytes = 64 * 1024;
const hostedSchemaPath = runtimeAssetPath("contracts/hosted/v1/artifacts.schema.json");
const ciSchemaPath = runtimeAssetPath("contracts/ci/v1/artifacts.schema.json");
const semanticSchemaPath = runtimeAssetPath("contracts/semantic/v1/artifacts.schema.json");
const repositorySchemaPaths = [
	"contracts/repository/v1/repository-config.schema.json",
	"contracts/repository/v1/review.schema.json",
	"contracts/repository/v1/review-decision.schema.json",
	"contracts/repository/v1/review-bundle.schema.json",
].map(runtimeAssetPath);

export class HostedRunnerError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HostedRunnerError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HostedRunnerError("HOSTED_ARTIFACT_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new HostedRunnerError("HOSTED_IDENTITY_INVALID", `${label} must be a string`);
	}
	return value;
}

function decimalId(value: unknown, label: string): string {
	const normalized = string(value, label);
	if (!/^[1-9][0-9]*$/u.test(normalized)) {
		throw new HostedRunnerError("HOSTED_IDENTITY_INVALID", `${label} must be a positive ID`);
	}
	return normalized;
}

function positiveInteger(value: unknown, label: string): number {
	const normalized = typeof value === "string" ? Number(value) : value;
	if (typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 1) {
		throw new HostedRunnerError("HOSTED_IDENTITY_INVALID", `${label} must be a positive integer`);
	}
	return normalized;
}

function gitOid(value: unknown, label: string) {
	const normalized = string(value, label);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(normalized)) {
		throw new HostedRunnerError("HOSTED_IDENTITY_INVALID", `${label} must be a Git OID`);
	}
	return {
		algorithm: normalized.length === 40 ? ("sha1" as const) : ("sha256" as const),
		value: normalized,
	};
}

function hash(value: unknown) {
	return { algorithm: "sha256" as const, value: sha256Jcs(value) };
}

async function validators() {
	const [semanticSchema, ciSchema, hostedSchema, ...repositorySchemas] = await Promise.all(
		[semanticSchemaPath, ciSchemaPath, hostedSchemaPath, ...repositorySchemaPaths].map(
			async (path) => JSON.parse(await readFile(path, "utf8")),
		),
	);
	const ajv = createStrictAjv();
	ajv.addSchema(semanticSchema);
	ajv.addSchema(ciSchema);
	for (const schema of repositorySchemas) ajv.addSchema(schema);
	ajv.addSchema(hostedSchema);
	return {
		ciBundle: ajv.getSchema(`${CI_ARTIFACTS_SCHEMA}#/definitions/CIBundle`),
		oidc: ajv.getSchema(`${HOSTED_ARTIFACTS_SCHEMA}#/definitions/GitHubOidcClaims`),
		envelope: ajv.getSchema(`${HOSTED_ARTIFACTS_SCHEMA}#/definitions/HostedEnvelope`),
	};
}

type Validator = NonNullable<Awaited<ReturnType<typeof validators>>["ciBundle"]>;

function assertValid(validate: Validator | undefined, value: unknown, code: string): void {
	if (validate === undefined || !validate(value)) {
		throw new HostedRunnerError(
			code,
			validate === undefined ? "validator unavailable" : JSON.stringify(validate.errors),
		);
	}
}

export function normalizeGitHubOidcClaims(payload: unknown) {
	const claims = object(payload, "OIDC claims");
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (audience.length !== 1 || audience[0] !== HOSTED_OIDC_AUDIENCE) {
		throw new HostedRunnerError(
			"HOSTED_OIDC_AUDIENCE_INVALID",
			"OIDC audience must be GraphReFly Stack Hosted",
		);
	}
	return {
		schema: HOSTED_OIDC_CLAIMS_SCHEMA,
		issuer: string(claims.iss, "iss"),
		audience: HOSTED_OIDC_AUDIENCE,
		subject: string(claims.sub, "sub"),
		repositoryId: decimalId(claims.repository_id, "repository_id"),
		repositoryOwnerId: decimalId(claims.repository_owner_id, "repository_owner_id"),
		workflowRef: string(claims.workflow_ref, "workflow_ref"),
		workflowSha: gitOid(claims.workflow_sha, "workflow_sha"),
		runId: decimalId(claims.run_id, "run_id"),
		runAttempt: positiveInteger(claims.run_attempt, "run_attempt"),
		actorId: decimalId(claims.actor_id, "actor_id"),
		eventName: string(claims.event_name, "event_name"),
	};
}

export function decodeUnverifiedOidcPayload(token: string): JsonObject {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new HostedRunnerError("HOSTED_OIDC_TOKEN_INVALID", "OIDC token is not a JWT");
	}
	try {
		return object(JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")), "JWT");
	} catch (error) {
		if (error instanceof HostedRunnerError) throw error;
		throw new HostedRunnerError("HOSTED_OIDC_TOKEN_INVALID", "OIDC token payload is invalid");
	}
}

export async function createHostedEnvelope(options: {
	ciBundle: unknown;
	profile: Exclude<HostedRedactionProfile, "local-review-decisions-v1">;
	syncIdentity: unknown;
}) {
	const {
		ciBundle: validateCiBundle,
		oidc: validateOidc,
		envelope: validateEnvelope,
	} = await validators();
	assertValid(validateCiBundle, options.ciBundle, "HOSTED_SOURCE_SCHEMA_INVALID");
	const ciBundle = object(options.ciBundle, "CI bundle");
	try {
		assertCiBundleIntegrity(ciBundle);
	} catch {
		throw new HostedRunnerError(
			"HOSTED_SOURCE_BINDING_INVALID",
			"CI bundle cross-binding or redaction is invalid",
		);
	}
	const syncIdentity = normalizeGitHubOidcClaims(options.syncIdentity);
	assertValid(validateOidc, syncIdentity, "HOSTED_OIDC_CLAIMS_INVALID");
	const invocation = object(ciBundle.invocation, "CI invocation");
	const result = object(ciBundle.result, "CI result");
	const repository = object(invocation.repository, "CI repository");
	const event = object(invocation.event, "CI event");
	const run = object(invocation.run, "CI run");
	const head = object(event.head, "CI event head");
	if (
		syncIdentity.issuer !== HOSTED_OIDC_ISSUER ||
		syncIdentity.eventName !== "workflow_run" ||
		syncIdentity.repositoryId !== repository.id ||
		syncIdentity.repositoryOwnerId !== repository.ownerId ||
		!syncIdentity.workflowRef.includes(`/${HOSTED_SYNC_WORKFLOW_PATH}@`)
	) {
		throw new HostedRunnerError(
			"HOSTED_IDENTITY_BINDING_INVALID",
			"OIDC identity does not match the CI repository and hosted workflow",
		);
	}
	const payload =
		options.profile === "gate-summary-v1"
			? {
					schema: HOSTED_GATE_SUMMARY_SCHEMA,
					outcome: result.outcome,
					gateResult: result.gateResult,
					summary: result.summary,
				}
			: { schema: HOSTED_SEMANTIC_REVIEW_SCHEMA, bundle: ciBundle };
	const envelope = {
		schema: HOSTED_ENVELOPE_SCHEMA,
		profile: options.profile,
		policyRevision: "hosted-redaction.v1",
		repository: {
			provider: "github",
			repositoryId: repository.id,
			ownerId: repository.ownerId,
		},
		source: {
			kind: "ci-bundle",
			sourceBundleDigest: hash(ciBundle),
			ciInvocationDigest: result.invocationDigest,
			gateInputDigest: result.gateInputDigest,
			portableBundleDigest: result.portableBundleDigest,
			head,
			runId: run.id,
			runAttempt: run.attempt,
		},
		uploadIdentity: syncIdentity,
		redaction: {
			explicitOptIn: options.profile !== "gate-summary-v1",
			includes: [
				{
					path:
						options.profile === "gate-summary-v1"
							? "ci/gate-summary.json"
							: "ci/semantic-review.json",
					digest: hash(payload),
				},
			],
			excludes: [...HOSTED_REDACTION_EXCLUDES],
		},
		payload,
	};
	assertValid(validateEnvelope, envelope, "HOSTED_ENVELOPE_INVALID");
	const bytes = Buffer.byteLength(canonicalize(envelope), "utf8");
	if (bytes > HOSTED_MAX_ENVELOPE_BYTES) {
		throw new HostedRunnerError(
			"HOSTED_ENVELOPE_TOO_LARGE",
			`Hosted envelope exceeds ${HOSTED_MAX_ENVELOPE_BYTES} bytes`,
		);
	}
	return envelope;
}

function endpointUrl(value: string): URL {
	if (/\r|\n|\$\{\{/u.test(value)) {
		throw new HostedRunnerError(
			"HOSTED_ENDPOINT_INVALID",
			"Hosted endpoint cannot contain line breaks or workflow expressions",
		);
	}
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw new HostedRunnerError("HOSTED_ENDPOINT_INVALID", "Hosted endpoint must be a URL");
	}
	const loopback =
		endpoint.protocol === "http:" &&
		["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname);
	if (endpoint.protocol !== "https:" && !loopback) {
		throw new HostedRunnerError(
			"HOSTED_ENDPOINT_INVALID",
			"Hosted endpoint must use HTTPS outside loopback tests",
		);
	}
	if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
		throw new HostedRunnerError(
			"HOSTED_ENDPOINT_INVALID",
			"Hosted endpoint cannot contain credentials, query, or fragment",
		);
	}
	endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/v1/envelopes`;
	return endpoint;
}

async function repositoryRoot(requested: string): Promise<string> {
	try {
		const canonical = await realpath(resolve(requested));
		return await realpath(gitText(canonical, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new HostedRunnerError(
			"HOSTED_REPOSITORY_INVALID",
			"Hosted init requires a local Git worktree",
		);
	}
}

async function stackVersion(): Promise<string> {
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDirectory, "../../../package.json"),
		resolve(moduleDirectory, "../package.json"),
	];
	for (const candidate of candidates) {
		try {
			const manifest = object(JSON.parse(await readFile(candidate, "utf8")), "package.json");
			if (manifest.name === "@graphrefly/stack" && typeof manifest.version === "string") {
				return manifest.version;
			}
		} catch {
			// Try the installed-package layout next.
		}
	}
	throw new HostedRunnerError("HOSTED_RUNTIME_INVALID", "Stack package version is unavailable");
}

function workflowSource(options: {
	endpoint: string;
	profile: Exclude<HostedRedactionProfile, "local-review-decisions-v1">;
	version: string;
}): string {
	return `name: ${HOSTED_SYNC_WORKFLOW_NAME}

on:
  workflow_run:
    workflows: ["GraphReFly Stack"]
    types: [completed]

permissions: {}

jobs:
  hosted-sync:
    name: GraphReFly Stack / Hosted Sync
    if: \${{ github.event.workflow_run.event == 'pull_request' }}
    runs-on: ubuntu-22.04
    permissions:
      actions: read
      id-token: write
    steps:
      - name: Download redacted semantic-gate artifact
        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        with:
          run-id: \${{ github.event.workflow_run.id }}
          pattern: graphrefly-stack-ci-*
          path: \${{ runner.temp }}/graphrefly-stack-ci
          github-token: \${{ github.token }}
      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24.18.0
      - name: Enable pnpm
        run: corepack enable
      - name: Sync policy-selected redacted evidence
        shell: bash
        env:
          GRAPHREFLY_STACK_HOSTED_ENDPOINT: ${JSON.stringify(options.endpoint)}
          npm_config_ignore_scripts: "true"
        run: |
          mapfile -t artifacts < <(find "$RUNNER_TEMP/graphrefly-stack-ci" -type f -name 'graphrefly-stack-ci.json' -print)
          test "\${#artifacts[@]}" -eq 1
          pnpm dlx --package=@graphrefly/stack@${options.version} grfs hosted sync \\
            --artifact "\${artifacts[0]}" \\
            --endpoint "$GRAPHREFLY_STACK_HOSTED_ENDPOINT" \\
            --profile ${options.profile} \\
            --json
`;
}

export async function initializeHostedWorkflow(options: {
	repository: string;
	endpoint: string;
	profile: Exclude<HostedRedactionProfile, "local-review-decisions-v1">;
	force: boolean;
}) {
	const endpoint = endpointUrl(options.endpoint);
	endpoint.pathname = endpoint.pathname.replace(/\/v1\/envelopes$/u, "");
	const repository = await repositoryRoot(options.repository);
	const path = resolve(repository, HOSTED_SYNC_WORKFLOW_PATH);
	try {
		await access(path);
		if (!options.force) {
			throw new HostedRunnerError(
				"HOSTED_WORKFLOW_EXISTS",
				`${HOSTED_SYNC_WORKFLOW_PATH} already exists; pass --force to replace it`,
			);
		}
	} catch (error) {
		if (error instanceof HostedRunnerError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const version = await stackVersion();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		workflowSource({
			endpoint: endpoint.toString().replace(/\/$/u, ""),
			profile: options.profile,
			version,
		}),
		{ encoding: "utf8", mode: 0o644 },
	);
	return {
		repository,
		workflow: HOSTED_SYNC_WORKFLOW_PATH,
		trigger: "workflow_run",
		profile: options.profile,
		endpoint: endpoint.toString().replace(/\/$/u, ""),
		stackVersion: version,
		permissions: { actions: "read", idToken: "write" },
	};
}

async function requestOidcToken(
	environment: NodeJS.ProcessEnv,
	fetchImpl: typeof fetch,
): Promise<string> {
	const requestUrl = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
	const requestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!requestUrl || !requestToken) {
		throw new HostedRunnerError(
			"HOSTED_OIDC_UNAVAILABLE",
			"GitHub Actions OIDC request environment is required",
		);
	}
	const url = new URL(requestUrl);
	if (
		url.protocol !== "https:" ||
		(url.hostname !== "actions.githubusercontent.com" &&
			!url.hostname.endsWith(".actions.githubusercontent.com"))
	) {
		throw new HostedRunnerError(
			"HOSTED_OIDC_UNAVAILABLE",
			"OIDC request URL must be a GitHub Actions HTTPS endpoint",
		);
	}
	url.searchParams.set("audience", HOSTED_OIDC_AUDIENCE);
	const response = await fetchImpl(url, {
		headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	const bytes = Buffer.from(await response.arrayBuffer());
	if (!response.ok || bytes.byteLength === 0 || bytes.byteLength > maxOidcResponseBytes) {
		throw new HostedRunnerError(
			"HOSTED_OIDC_FAILED",
			`OIDC request failed with ${response.status}`,
		);
	}
	try {
		return string(JSON.parse(bytes.toString("utf8")).value, "OIDC token");
	} catch (error) {
		if (error instanceof HostedRunnerError) throw error;
		throw new HostedRunnerError("HOSTED_OIDC_FAILED", "OIDC response is invalid");
	}
}

export async function syncHostedEvidence(options: {
	artifact: string;
	endpoint: string;
	profile: Exclude<HostedRedactionProfile, "local-review-decisions-v1">;
	environment?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	oidcToken?: string;
}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	let bytes: Buffer;
	try {
		bytes = await readFile(resolve(options.artifact));
	} catch {
		throw new HostedRunnerError("HOSTED_ARTIFACT_INVALID", "CI artifact could not be read");
	}
	if (bytes.byteLength === 0 || bytes.byteLength > HOSTED_MAX_ENVELOPE_BYTES) {
		throw new HostedRunnerError(
			"HOSTED_ARTIFACT_INVALID",
			"CI artifact size is outside the hosted v1 bound",
		);
	}
	let ciBundle: unknown;
	try {
		ciBundle = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new HostedRunnerError("HOSTED_ARTIFACT_INVALID", "CI artifact is not valid JSON");
	}
	const token =
		options.oidcToken ?? (await requestOidcToken(options.environment ?? process.env, fetchImpl));
	const claims = decodeUnverifiedOidcPayload(token);
	const envelope = await createHostedEnvelope({
		ciBundle,
		profile: options.profile,
		syncIdentity: claims,
	});
	const canonicalBytes = canonicalize(envelope);
	const response = await fetchImpl(endpointUrl(options.endpoint), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"Content-Length": String(Buffer.byteLength(canonicalBytes, "utf8")),
			"X-GraphReFly-Envelope-Digest": sha256Jcs(envelope),
		},
		body: canonicalBytes,
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	});
	const responseBytes = Buffer.from(await response.arrayBuffer());
	if (responseBytes.byteLength > maxUploadResponseBytes) {
		throw new HostedRunnerError("HOSTED_UPLOAD_FAILED", "Hosted response exceeds the size bound");
	}
	if (![200, 201, 409].includes(response.status)) {
		throw new HostedRunnerError(
			response.status === 413
				? "HOSTED_ENVELOPE_TOO_LARGE"
				: response.status === 429
					? "HOSTED_QUOTA_EXCEEDED"
					: "HOSTED_UPLOAD_FAILED",
			`Hosted upload failed with ${response.status}`,
		);
	}
	let receipt: unknown = null;
	if (responseBytes.byteLength > 0) {
		try {
			receipt = JSON.parse(responseBytes.toString("utf8"));
		} catch {
			throw new HostedRunnerError("HOSTED_UPLOAD_FAILED", "Hosted receipt is not valid JSON");
		}
	}
	return {
		status: response.status === 409 ? "already-synced" : "synced",
		envelopeDigest: hash(envelope),
		profile: options.profile,
		receipt,
	};
}

export const HOSTED_CONTRACT_IDS = {
	hosted: HOSTED_ARTIFACTS_SCHEMA,
	ci: CI_ARTIFACTS_SCHEMA,
	semantic: SEMANTIC_ARTIFACTS_SCHEMA,
	ciBundle: CI_BUNDLE_SCHEMA,
} as const;
