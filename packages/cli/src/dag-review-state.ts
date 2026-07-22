import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	assertDagReviewDecisionIntegrity,
	assertDagReviewEvidenceIntegrity,
	createStrictAjv,
	DAG_REVIEW_DECISION_REQUEST_SCHEMA,
	DAG_REVIEW_DECISION_SCHEMA,
	DAG_SEMANTIC_ARTIFACTS_SCHEMA,
	REVIEW_DECISION_HISTORY_SCHEMA,
} from "@graphrefly-stack/contracts";

import type { DagReviewEvidenceBundle } from "./dag-review-runner.js";
import { repositoryStateDirectory } from "./repository-review-state.js";
import { runtimeAssetPath } from "./runtime-paths.js";

type JsonObject = Record<string, unknown>;

export class DagReviewStateError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "DagReviewStateError";
	}
}

async function validators() {
	const paths = [
		"contracts/repository/v1/repository-config.schema.json",
		"contracts/repository/v1/review.schema.json",
		"contracts/semantic/v1/artifacts.schema.json",
		"contracts/dag/v2/artifacts.schema.json",
		"contracts/dag/v2/semantic.schema.json",
	] as const;
	const schemas = await Promise.all(
		paths.map(async (path) => JSON.parse(await readFile(runtimeAssetPath(path), "utf8"))),
	);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	return {
		request: ajv.getSchema(
			`${DAG_SEMANTIC_ARTIFACTS_SCHEMA}#/definitions/DagReviewDecisionRequest`,
		),
		decision: ajv.getSchema(`${DAG_SEMANTIC_ARTIFACTS_SCHEMA}#/definitions/DagReviewDecision`),
	};
}

function projection(bundle: DagReviewEvidenceBundle): JsonObject {
	if (
		typeof bundle.projection !== "object" ||
		bundle.projection === null ||
		Array.isArray(bundle.projection)
	) {
		throw new DagReviewStateError("REVIEW_STATE_INVALID", "DAG review projection is invalid");
	}
	return bundle.projection;
}

async function decisionsDirectory(
	repository: string,
	bundle: DagReviewEvidenceBundle,
): Promise<string> {
	const digest = projection(bundle).gateResultDigest as JsonObject;
	if (digest?.algorithm !== "sha256" || typeof digest.value !== "string") {
		throw new DagReviewStateError("REVIEW_STATE_INVALID", "DAG review target digest is invalid");
	}
	return repositoryStateDirectory(repository, "dag-review-decisions", digest.value);
}

function targetDigests(bundle: DagReviewEvidenceBundle): {
	gateResultDigest: JsonObject;
	topologyDigest: JsonObject;
	dependencyGraphDigest: JsonObject;
} {
	const target = projection(bundle);
	return {
		gateResultDigest: target.gateResultDigest as JsonObject,
		topologyDigest: target.topologyDigest as JsonObject,
		dependencyGraphDigest: target.dependencyGraphDigest as JsonObject,
	};
}

function sameDigest(left: unknown, right: unknown): boolean {
	const leftDigest = left as JsonObject | undefined;
	const rightDigest = right as JsonObject | undefined;
	return (
		leftDigest?.algorithm === rightDigest?.algorithm && leftDigest?.value === rightDigest?.value
	);
}

function matchesCurrentBundle(bundle: DagReviewEvidenceBundle, decision: JsonObject): boolean {
	const current = targetDigests(bundle);
	const target = decision.target as JsonObject | undefined;
	return (
		sameDigest(target?.gateResultDigest, current.gateResultDigest) &&
		sameDigest(target?.topologyDigest, current.topologyDigest) &&
		sameDigest(target?.dependencyGraphDigest, current.dependencyGraphDigest)
	);
}

async function readAllDagReviewDecisions(
	repository: string,
	bundle: DagReviewEvidenceBundle,
): Promise<JsonObject[]> {
	assertDagReviewEvidenceIntegrity(bundle);
	const root = await repositoryStateDirectory(repository, "dag-review-decisions");
	const { decision: validate } = await validators();
	if (validate === undefined) throw new Error("DAG review decision validator unavailable");
	const rootEntries = await readdir(root, { withFileTypes: true });
	for (const entry of rootEntries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new DagReviewStateError(
				"REVIEW_STATE_INVALID",
				`DAG review decision directory is unsafe: ${entry.name}`,
			);
		}
	}
	const digestDirectories = rootEntries.map((entry) => entry.name).sort();
	const decisions: JsonObject[] = [];
	for (const digestDirectory of digestDirectories) {
		if (!/^[0-9a-f]{64}$/u.test(digestDirectory)) {
			throw new DagReviewStateError(
				"REVIEW_STATE_INVALID",
				`DAG review decision directory is invalid: ${digestDirectory}`,
			);
		}
		const directory = await repositoryStateDirectory(
			repository,
			"dag-review-decisions",
			digestDirectory,
		);
		for (const entry of (await readdir(directory))
			.filter((name) => name.endsWith(".json"))
			.sort()) {
			const path = resolve(directory, entry);
			const status = await lstat(path);
			if (!status.isFile() || status.isSymbolicLink()) {
				throw new DagReviewStateError(
					"REVIEW_STATE_INVALID",
					`DAG review record path is unsafe: ${entry}`,
				);
			}
			let value: unknown;
			try {
				value = JSON.parse(await readFile(path, "utf8"));
			} catch {
				throw new DagReviewStateError(
					"REVIEW_STATE_INVALID",
					`DAG review record is malformed: ${entry}`,
				);
			}
			if (!validate(value)) {
				throw new DagReviewStateError(
					"REVIEW_STATE_INVALID",
					`DAG review record failed validation: ${entry}`,
				);
			}
			const record = value as JsonObject;
			const gateDigest = (record.target as JsonObject | undefined)?.gateResultDigest as
				| JsonObject
				| undefined;
			if (gateDigest?.value !== digestDirectory) {
				throw new DagReviewStateError(
					"REVIEW_STATE_INVALID",
					`DAG review record is stored under the wrong target: ${entry}`,
				);
			}
			if (matchesCurrentBundle(bundle, record)) {
				try {
					assertDagReviewDecisionIntegrity({ reviewEvidence: bundle, decision: record });
				} catch {
					throw new DagReviewStateError(
						"REVIEW_STATE_INVALID",
						`DAG review record target is invalid: ${entry}`,
					);
				}
			}
			decisions.push(record);
		}
	}
	return decisions.sort((left, right) =>
		String(left.recordedAt).localeCompare(String(right.recordedAt)),
	);
}

export async function readDagReviewDecisionHistory(
	repository: string,
	bundle: DagReviewEvidenceBundle,
): Promise<{
	schema: typeof REVIEW_DECISION_HISTORY_SCHEMA;
	current: JsonObject[];
	outdated: JsonObject[];
}> {
	const decisions = await readAllDagReviewDecisions(repository, bundle);
	return {
		schema: REVIEW_DECISION_HISTORY_SCHEMA,
		current: decisions.filter((decision) => matchesCurrentBundle(bundle, decision)),
		outdated: decisions.filter((decision) => !matchesCurrentBundle(bundle, decision)),
	};
}

export async function readDagReviewDecisions(
	repository: string,
	bundle: DagReviewEvidenceBundle,
): Promise<JsonObject[]> {
	return [...(await readDagReviewDecisionHistory(repository, bundle)).current];
}

export async function writeDagReviewDecision(
	repository: string,
	bundle: DagReviewEvidenceBundle,
	input: unknown,
): Promise<JsonObject> {
	assertDagReviewEvidenceIntegrity(bundle);
	const { request: validateRequest, decision: validateDecision } = await validators();
	if (validateRequest === undefined || validateDecision === undefined) {
		throw new Error("DAG review decision validators unavailable");
	}
	if (!validateRequest(input)) {
		throw new DagReviewStateError(
			"REVIEW_DECISION_INVALID",
			`DAG review decision request failed validation: ${JSON.stringify(validateRequest.errors)}`,
		);
	}
	const request = input as JsonObject;
	if (request.schema !== DAG_REVIEW_DECISION_REQUEST_SCHEMA) {
		throw new DagReviewStateError(
			"REVIEW_DECISION_INVALID",
			"DAG review decision request schema is unsupported",
		);
	}
	const reviewerLabel = String(request.reviewerLabel).trim();
	const summary = String(request.summary).trim();
	if (reviewerLabel.length === 0) {
		throw new DagReviewStateError("REVIEW_DECISION_INVALID", "Reviewer name cannot be blank");
	}
	const target = projection(bundle);
	const record: JsonObject = {
		schema: DAG_REVIEW_DECISION_SCHEMA,
		id: randomUUID(),
		target: {
			gateResultDigest: target.gateResultDigest,
			topologyDigest: target.topologyDigest,
			dependencyGraphDigest: target.dependencyGraphDigest,
		},
		decision: request.decision,
		reviewerLabel,
		summary,
		recordedAt: new Date().toISOString(),
		identityVerified: false,
		...(request.selectedEvidence === undefined
			? {}
			: { selectedEvidence: request.selectedEvidence }),
	};
	if (!validateDecision(record)) {
		throw new Error(
			`Generated DAG review decision failed validation: ${JSON.stringify(validateDecision.errors)}`,
		);
	}
	try {
		assertDagReviewDecisionIntegrity({ reviewEvidence: bundle, decision: record });
	} catch (error) {
		throw new DagReviewStateError(
			"REVIEW_TARGET_STALE",
			error instanceof Error ? error.message : "DAG review decision target is stale",
		);
	}
	const directory = await decisionsDirectory(repository, bundle);
	const destination = resolve(directory, `${record.id}.json`);
	const temporary = resolve(directory, `.${record.id}.tmp`);
	await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	await rename(temporary, destination);
	return record;
}
