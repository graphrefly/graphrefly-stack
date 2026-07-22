import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
	assertRepositoryReviewBundleV2Integrity,
	createStrictAjv,
	REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA,
	REPOSITORY_REVIEW_DECISION_REQUEST_V2_SCHEMA,
	REPOSITORY_REVIEW_DECISION_SCHEMA,
	REPOSITORY_REVIEW_DECISION_V2_SCHEMA,
	REVIEW_DECISION_HISTORY_SCHEMA,
	type RepositoryReview,
	type RepositoryReviewBundleV2,
	type RepositoryReviewDecision,
	type RepositoryReviewDecisionHistory,
	type RepositoryReviewDecisionRequestV2,
	type RepositoryReviewDecisionV1,
	type RepositoryReviewDecisionV2,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

import { runtimeAssetPath } from "./runtime-paths.js";
import { gitText } from "./system-git.js";

const schemaPaths = [
	"contracts/repository/v1/repository-config.schema.json",
	"contracts/repository/v1/review.schema.json",
	"contracts/repository/v1/review-decision-request.schema.json",
	"contracts/repository/v1/review-decision.schema.json",
	"contracts/repository/v1/review-bundle.schema.json",
	"contracts/repository/v2/review-decision-request.schema.json",
	"contracts/repository/v2/review-decision.schema.json",
	"contracts/repository/v2/review-bundle.schema.json",
	"contracts/semantic/v1/artifacts.schema.json",
] as const;

export class RepositoryReviewStateError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RepositoryReviewStateError";
	}
}

async function validators() {
	const schemas = await Promise.all(
		schemaPaths.map(async (path) => JSON.parse(await readFile(runtimeAssetPath(path), "utf8"))),
	);
	const ajv = createStrictAjv();
	for (const schema of schemas) ajv.addSchema(schema);
	return {
		requestV2: ajv.getSchema("urn:graphrefly-stack:schema:repository-review-decision-request:v2"),
		decisionV1: ajv.getSchema("urn:graphrefly-stack:schema:repository-review-decision:v1"),
		decisionV2: ajv.getSchema("urn:graphrefly-stack:schema:repository-review-decision:v2"),
		bundleV2: ajv.getSchema("urn:graphrefly-stack:schema:repository-review-bundle:v2"),
	};
}

async function safeDirectory(path: string, parent: string): Promise<string> {
	try {
		const current = await lstat(path);
		if (!current.isDirectory() || current.isSymbolicLink()) {
			throw new RepositoryReviewStateError(
				"REVIEW_STATE_PATH_UNSAFE",
				"Local review state path must be a real directory",
			);
		}
	} catch (error) {
		if (error instanceof RepositoryReviewStateError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(path, { recursive: false, mode: 0o700 });
	}
	const canonical = await realpath(path);
	if (!canonical.startsWith(`${parent}${sep}`)) {
		throw new RepositoryReviewStateError(
			"REVIEW_STATE_PATH_UNSAFE",
			"Local review state escaped the Git common directory",
		);
	}
	return canonical;
}

export async function repositoryReviewStateRoot(repository: string): Promise<string> {
	const commonDirectory = await realpath(
		gitText(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
	);
	return safeDirectory(resolve(commonDirectory, "grfs"), commonDirectory);
}

export async function repositoryStateDirectory(
	repository: string,
	...segments: readonly string[]
): Promise<string> {
	let parent = await repositoryReviewStateRoot(repository);
	for (const segment of segments) {
		if (
			segment === "." ||
			segment === ".." ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(segment)
		) {
			throw new RepositoryReviewStateError(
				"REVIEW_STATE_PATH_UNSAFE",
				"Local state directory segment is invalid",
			);
		}
		parent = await safeDirectory(resolve(parent, segment), parent);
	}
	return parent;
}

async function decisionsDirectory(repository: string): Promise<string> {
	const root = await repositoryReviewStateRoot(repository);
	return safeDirectory(resolve(root, "reviews"), root);
}

function blueprintHashFor(review: RepositoryReview, commitOid: string): string | undefined {
	const commit = review.commits.find((candidate) => candidate.oid === commitOid);
	const hash = commit?.blueprint.hash;
	if (typeof hash !== "object" || hash === null) return undefined;
	return typeof (hash as Record<string, unknown>).value === "string"
		? ((hash as Record<string, unknown>).value as string)
		: undefined;
}

export function repositoryReviewTargetDigest(review: RepositoryReview): {
	algorithm: "sha256";
	value: string;
} {
	return { algorithm: "sha256", value: sha256Jcs(review) };
}

function matchesCurrentV1Review(
	review: RepositoryReview,
	record: RepositoryReviewDecisionV1,
): boolean {
	const commit = review.commits.find((candidate) => candidate.oid === record.target.commitOid);
	return (
		commit !== undefined &&
		record.target.baseOid === review.repository.baseOid &&
		record.target.headOid === review.repository.headOid &&
		record.target.parentOid === commit.parentOid &&
		record.target.blueprintHash === blueprintHashFor(review, commit.oid)
	);
}

function matchesCurrentReview(review: RepositoryReview, record: RepositoryReviewDecision): boolean {
	if (record.schema === REPOSITORY_REVIEW_DECISION_SCHEMA) {
		return matchesCurrentV1Review(review, record);
	}
	const target = repositoryReviewTargetDigest(review);
	return (
		record.target.baseOid === review.repository.baseOid &&
		record.target.headOid === review.repository.headOid &&
		record.target.reviewTargetDigest.algorithm === target.algorithm &&
		record.target.reviewTargetDigest.value === target.value
	);
}

async function readAllRepositoryReviewDecisions(
	repository: string,
): Promise<RepositoryReviewDecision[]> {
	const directory = await decisionsDirectory(repository);
	const { decisionV1, decisionV2 } = await validators();
	if (decisionV1 === undefined || decisionV2 === undefined) {
		throw new Error("Repository review decision validators unavailable");
	}
	const entries = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.name.endsWith(".json"))
		.sort((left, right) => left.name.localeCompare(right.name));
	const records: RepositoryReviewDecision[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new RepositoryReviewStateError(
				"REVIEW_STATE_INVALID",
				`Local review record path is unsafe: ${entry.name}`,
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(await readFile(resolve(directory, entry.name), "utf8"));
		} catch {
			throw new RepositoryReviewStateError(
				"REVIEW_STATE_INVALID",
				`Local review record is not valid JSON: ${entry.name}`,
			);
		}
		const schema = (value as { schema?: unknown } | null)?.schema;
		const valid =
			schema === REPOSITORY_REVIEW_DECISION_SCHEMA
				? decisionV1(value)
				: schema === REPOSITORY_REVIEW_DECISION_V2_SCHEMA
					? decisionV2(value)
					: false;
		if (!valid) {
			const errors =
				schema === REPOSITORY_REVIEW_DECISION_SCHEMA ? decisionV1.errors : decisionV2.errors;
			throw new RepositoryReviewStateError(
				"REVIEW_STATE_INVALID",
				`Local review record failed validation: ${entry.name} (${JSON.stringify(errors)})`,
			);
		}
		records.push(value as RepositoryReviewDecision);
	}
	return records.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

export async function readRepositoryReviewDecisionHistory(
	repository: string,
	review: RepositoryReview,
): Promise<RepositoryReviewDecisionHistory> {
	const records = await readAllRepositoryReviewDecisions(repository);
	return {
		schema: REVIEW_DECISION_HISTORY_SCHEMA,
		current: records.filter((record) => matchesCurrentReview(review, record)),
		outdated: records.filter((record) => !matchesCurrentReview(review, record)),
	};
}

export async function readRepositoryReviewDecisions(
	repository: string,
	review: RepositoryReview,
): Promise<RepositoryReviewDecision[]> {
	return [...(await readRepositoryReviewDecisionHistory(repository, review)).current];
}

export async function writeRepositoryReviewDecision(
	repository: string,
	review: RepositoryReview,
	input: unknown,
): Promise<RepositoryReviewDecision> {
	const { requestV2: validateRequest, decisionV2: validateDecision } = await validators();
	if (validateRequest === undefined || validateDecision === undefined) {
		throw new Error("Repository review decision validators unavailable");
	}
	if (!validateRequest(input)) {
		throw new RepositoryReviewStateError(
			"REVIEW_DECISION_INVALID",
			`Review decision request failed validation: ${JSON.stringify(validateRequest.errors)}`,
		);
	}
	const request = input as RepositoryReviewDecisionRequestV2;
	if (request.schema !== REPOSITORY_REVIEW_DECISION_REQUEST_V2_SCHEMA) {
		throw new RepositoryReviewStateError(
			"REVIEW_DECISION_INVALID",
			"Whole-change review decision request schema is unsupported",
		);
	}
	const reviewerLabel = request.reviewerLabel.trim();
	const summary = request.summary.trim();
	if (reviewerLabel.length === 0) {
		throw new RepositoryReviewStateError(
			"REVIEW_DECISION_INVALID",
			"Reviewer name cannot be blank",
		);
	}
	if (
		request.contextCommitOid !== undefined &&
		!review.commits.some((candidate) => candidate.oid === request.contextCommitOid)
	) {
		throw new RepositoryReviewStateError(
			"REVIEW_TARGET_STALE",
			"The selected context commit is not part of the current review range",
		);
	}
	const record: RepositoryReviewDecisionV2 = {
		schema: REPOSITORY_REVIEW_DECISION_V2_SCHEMA,
		id: randomUUID(),
		target: {
			baseOid: review.repository.baseOid,
			headOid: review.repository.headOid,
			reviewTargetDigest: repositoryReviewTargetDigest(review),
		},
		...(request.contextCommitOid === undefined
			? {}
			: { contextCommitOid: request.contextCommitOid }),
		decision: request.decision,
		reviewerLabel,
		summary,
		recordedAt: new Date().toISOString(),
		identityVerified: false,
	};
	if (!validateDecision(record)) {
		throw new Error(
			`Generated review decision failed validation: ${JSON.stringify(validateDecision.errors)}`,
		);
	}
	const directory = await decisionsDirectory(repository);
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

export async function createRepositoryReviewBundle(
	repository: string,
	review: RepositoryReview,
): Promise<RepositoryReviewBundleV2> {
	const records = (await readRepositoryReviewDecisions(repository, review)).filter(
		(record): record is RepositoryReviewDecisionV2 =>
			record.schema === REPOSITORY_REVIEW_DECISION_V2_SCHEMA,
	);
	const bundle: RepositoryReviewBundleV2 = {
		schema: REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA,
		repository: {
			label: review.repository.label,
			baseOid: review.repository.baseOid,
			headOid: review.repository.headOid,
		},
		reviewTargetDigest: repositoryReviewTargetDigest(review),
		artifacts: records.map((record) => ({
			path: `reviews/${record.id}.json`,
			hash: { algorithm: "sha256", value: sha256Jcs(record) },
			record,
		})),
	};
	const { bundleV2: validate } = await validators();
	if (validate === undefined || !validate(bundle)) {
		throw new Error(
			`Generated review bundle failed validation: ${JSON.stringify(validate?.errors)}`,
		);
	}
	assertRepositoryReviewBundleV2Integrity(bundle);
	return bundle;
}
