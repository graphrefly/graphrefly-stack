import { readFile } from "node:fs/promises";

import {
	assertHostedEnvelopeIntegrity,
	CI_ARTIFACTS_SCHEMA,
	canonicalize,
	createStrictAjv,
	HOSTED_ARTIFACTS_SCHEMA,
	HOSTED_MAX_ENVELOPE_BYTES,
	HOSTED_SYNC_WORKFLOW_PATH,
	SEMANTIC_ARTIFACTS_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

import type { VerifiedGitHubOidcToken } from "./oidc.js";
import { type GitHubOidcVerifier, HostedOidcError } from "./oidc.js";
import type {
	HostedIngestReceipt,
	HostedPersistence,
	HostedRepositoryContext,
} from "./persistence.js";

type JsonObject = Record<string, unknown>;

export interface HostedProviderAuthorizer {
	authorizeUpload(input: {
		identity: VerifiedGitHubOidcToken;
		repository: { provider: "github"; repositoryId: string; ownerId: string };
		source: {
			runId: string;
			runAttempt: number;
			head: { algorithm: "sha1" | "sha256"; value: string };
			sourceBundleDigest: { algorithm: "sha256"; value: string };
			ciInvocationDigest: { algorithm: "sha256"; value: string };
			gateInputDigest: { algorithm: "sha256"; value: string };
			portableBundleDigest: { algorithm: "sha256"; value: string };
		};
	}): Promise<HostedRepositoryContext | null>;
}

export class HostedControlPlaneError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HostedControlPlaneError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HostedControlPlaneError(400, "HOSTED_ENVELOPE_INVALID", `${label} must be an object`);
	}
	return value as JsonObject;
}

async function envelopeValidator() {
	const schemaRoot = new URL("../../contracts/dist/schemas/", import.meta.url);
	const paths = [
		new URL("semantic/v1/artifacts.schema.json", schemaRoot),
		new URL("ci/v1/artifacts.schema.json", schemaRoot),
		new URL("repository/v1/repository-config.schema.json", schemaRoot),
		new URL("repository/v1/review.schema.json", schemaRoot),
		new URL("repository/v1/review-decision.schema.json", schemaRoot),
		new URL("repository/v1/review-bundle.schema.json", schemaRoot),
		new URL("hosted/v1/artifacts.schema.json", schemaRoot),
	];
	const schemas = await Promise.all(
		paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
	);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	const validate = ajv.getSchema(`${HOSTED_ARTIFACTS_SCHEMA}#/definitions/HostedEnvelope`);
	if (validate === undefined) throw new Error("hosted envelope validator is unavailable");
	return validate;
}

let sharedValidator: Awaited<ReturnType<typeof envelopeValidator>> | undefined;

export class HostedControlPlane {
	readonly #oidc: GitHubOidcVerifier;
	readonly #authorizer: HostedProviderAuthorizer;
	readonly #persistence: HostedPersistence;
	readonly #now: () => Date;

	constructor(options: {
		oidc: GitHubOidcVerifier;
		authorizer: HostedProviderAuthorizer;
		persistence: HostedPersistence;
		now?: () => Date;
	}) {
		this.#oidc = options.oidc;
		this.#authorizer = options.authorizer;
		this.#persistence = options.persistence;
		this.#now = options.now ?? (() => new Date());
	}

	async ingest(input: {
		bearerToken: string;
		body: string | Uint8Array;
		claimedDigest: string;
	}): Promise<{ status: 201 | 409; receipt: HostedIngestReceipt }> {
		const bytes =
			typeof input.body === "string" ? Buffer.from(input.body, "utf8") : Buffer.from(input.body);
		if (bytes.byteLength === 0 || bytes.byteLength > HOSTED_MAX_ENVELOPE_BYTES) {
			throw new HostedControlPlaneError(
				413,
				"HOSTED_ENVELOPE_TOO_LARGE",
				"envelope size is outside the v1 bound",
			);
		}
		let envelope: unknown;
		try {
			envelope = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new HostedControlPlaneError(
				400,
				"HOSTED_ENVELOPE_INVALID",
				"envelope is not valid JSON",
			);
		}
		const canonicalBytes = canonicalize(envelope);
		if (!bytes.equals(Buffer.from(canonicalBytes, "utf8"))) {
			throw new HostedControlPlaneError(
				400,
				"HOSTED_CANONICAL_BYTES_REQUIRED",
				"envelope must use RFC 8785 canonical bytes",
			);
		}
		sharedValidator ??= await envelopeValidator();
		if (!sharedValidator(envelope)) {
			throw new HostedControlPlaneError(
				400,
				"HOSTED_ENVELOPE_SCHEMA_INVALID",
				JSON.stringify(sharedValidator.errors),
			);
		}
		try {
			assertHostedEnvelopeIntegrity(envelope);
		} catch {
			throw new HostedControlPlaneError(
				400,
				"HOSTED_ENVELOPE_INTEGRITY_INVALID",
				"envelope integrity is invalid",
			);
		}
		const digest = sha256Jcs(envelope);
		if (input.claimedDigest !== digest) {
			throw new HostedControlPlaneError(
				400,
				"HOSTED_DIGEST_MISMATCH",
				"claimed envelope digest does not match canonical bytes",
			);
		}

		let identity: VerifiedGitHubOidcToken;
		try {
			identity = await this.#oidc.verify(input.bearerToken);
		} catch (error) {
			if (error instanceof HostedOidcError) {
				throw new HostedControlPlaneError(401, error.code, error.message);
			}
			throw error;
		}
		const value = object(envelope, "hosted envelope");
		const repository = object(value.repository, "hosted repository") as {
			provider: "github";
			repositoryId: string;
			ownerId: string;
		};
		const source = object(value.source, "hosted source") as {
			runId: string;
			runAttempt: number;
			head: { algorithm: "sha1" | "sha256"; value: string };
			sourceBundleDigest: { algorithm: "sha256"; value: string };
			ciInvocationDigest: { algorithm: "sha256"; value: string };
			gateInputDigest: { algorithm: "sha256"; value: string };
			portableBundleDigest: { algorithm: "sha256"; value: string };
		};
		const workflowRefPattern = new RegExp(
			`^[^/\\s]+/[^/\\s]+/${HOSTED_SYNC_WORKFLOW_PATH.replaceAll(".", "\\.")}@refs/[^\\s]+$`,
			"u",
		);
		if (
			canonicalize(value.uploadIdentity) !== canonicalize(identity.claims) ||
			repository.repositoryId !== identity.claims.repositoryId ||
			repository.ownerId !== identity.claims.repositoryOwnerId ||
			!workflowRefPattern.test(identity.claims.workflowRef)
		) {
			throw new HostedControlPlaneError(
				401,
				"HOSTED_IDENTITY_BINDING_INVALID",
				"verified identity does not match the envelope",
			);
		}
		const authorized = await this.#authorizer.authorizeUpload({ identity, repository, source });
		if (
			authorized === null ||
			authorized.providerRepositoryId !== repository.repositoryId ||
			authorized.providerOwnerId !== repository.ownerId
		) {
			throw new HostedControlPlaneError(
				403,
				"HOSTED_REPOSITORY_UNAUTHORIZED",
				"repository authorization is unavailable or denied",
			);
		}
		if (
			value.profile === "local-review-decisions-v1" ||
			(value.profile === "semantic-review-v1" && !authorized.semanticReviewEnabled)
		) {
			throw new HostedControlPlaneError(
				403,
				"HOSTED_PROFILE_UNAUTHORIZED",
				"semantic review is not enabled for this repository",
			);
		}
		const payload = object(value.payload, "hosted payload");
		const gateResult =
			value.profile === "semantic-review-v1"
				? object(
						object(object(payload.bundle, "CI bundle").result, "CI result").gateResult,
						"GateResult",
					)
				: object(payload.gateResult, "GateResult");
		const result = await this.#persistence.ingest({
			repository: authorized,
			digest,
			canonicalBytes: bytes,
			profile: value.profile as string,
			gateVerdict: gateResult.verdict as string,
			sourceRunId: source.runId,
			sourceHead: source.head.value,
			receivedAt: this.#now(),
		});
		if (result.status === "rate-limit" || result.status === "storage-limit") {
			throw new HostedControlPlaneError(429, "HOSTED_QUOTA_EXCEEDED", "hosted quota is exceeded");
		}
		return { status: result.status === "duplicate" ? 409 : 201, receipt: result.receipt };
	}
}

export const HOSTED_CONTROL_PLANE_SCHEMA_IDS = {
	hosted: HOSTED_ARTIFACTS_SCHEMA,
	ci: CI_ARTIFACTS_SCHEMA,
	semantic: SEMANTIC_ARTIFACTS_SCHEMA,
} as const;
