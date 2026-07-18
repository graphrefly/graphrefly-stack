import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
	createStrictAjv,
	REPOSITORY_REVIEW_BUNDLE_SCHEMA,
	REPOSITORY_REVIEW_DECISION_SCHEMA,
	type RepositoryReview,
	type RepositoryReviewBundle,
	type RepositoryReviewDecision,
	type RepositoryReviewDecisionRequest,
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
		request: ajv.getSchema("urn:graphrefly-stack:schema:repository-review-decision-request:v1"),
		decision: ajv.getSchema("urn:graphrefly-stack:schema:repository-review-decision:v1"),
		bundle: ajv.getSchema("urn:graphrefly-stack:schema:repository-review-bundle:v1"),
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

function matchesCurrentReview(review: RepositoryReview, record: RepositoryReviewDecision): boolean {
	const commit = review.commits.find((candidate) => candidate.oid === record.target.commitOid);
	return (
		commit !== undefined &&
		record.target.baseOid === review.repository.baseOid &&
		record.target.headOid === review.repository.headOid &&
		record.target.parentOid === commit.parentOid &&
		record.target.blueprintHash === blueprintHashFor(review, commit.oid)
	);
}

export async function readRepositoryReviewDecisions(
	repository: string,
	review: RepositoryReview,
): Promise<RepositoryReviewDecision[]> {
	const directory = await decisionsDirectory(repository);
	const { decision: validate } = await validators();
	if (validate === undefined) throw new Error("Repository review decision validator unavailable");
	const entries = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort();
	const records: RepositoryReviewDecision[] = [];
	for (const entry of entries) {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(resolve(directory, entry), "utf8"));
		} catch {
			throw new RepositoryReviewStateError(
				"REVIEW_STATE_INVALID",
				`Local review record is not valid JSON: ${entry}`,
			);
		}
		if (!validate(value)) {
			throw new RepositoryReviewStateError(
				"REVIEW_STATE_INVALID",
				`Local review record failed validation: ${entry}`,
			);
		}
		const record = value as RepositoryReviewDecision;
		if (matchesCurrentReview(review, record)) records.push(record);
	}
	return records.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

export async function writeRepositoryReviewDecision(
	repository: string,
	review: RepositoryReview,
	input: unknown,
): Promise<RepositoryReviewDecision> {
	const { request: validateRequest, decision: validateDecision } = await validators();
	if (validateRequest === undefined || validateDecision === undefined) {
		throw new Error("Repository review decision validators unavailable");
	}
	if (!validateRequest(input)) {
		throw new RepositoryReviewStateError(
			"REVIEW_DECISION_INVALID",
			`Review decision request failed validation: ${JSON.stringify(validateRequest.errors)}`,
		);
	}
	const request = input as RepositoryReviewDecisionRequest;
	const reviewerLabel = request.reviewerLabel.trim();
	const summary = request.summary.trim();
	if (reviewerLabel.length === 0) {
		throw new RepositoryReviewStateError(
			"REVIEW_DECISION_INVALID",
			"Reviewer name cannot be blank",
		);
	}
	const commit = review.commits.find((candidate) => candidate.oid === request.commitOid);
	const blueprintHash = blueprintHashFor(review, request.commitOid);
	if (commit === undefined || blueprintHash === undefined) {
		throw new RepositoryReviewStateError(
			"REVIEW_TARGET_STALE",
			"The selected commit is not part of the current review range",
		);
	}
	const record: RepositoryReviewDecision = {
		schema: REPOSITORY_REVIEW_DECISION_SCHEMA,
		id: randomUUID(),
		target: {
			baseOid: review.repository.baseOid,
			headOid: review.repository.headOid,
			parentOid: commit.parentOid,
			commitOid: commit.oid,
			blueprintHash,
		},
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
): Promise<RepositoryReviewBundle> {
	const records = await readRepositoryReviewDecisions(repository, review);
	const bundle: RepositoryReviewBundle = {
		schema: REPOSITORY_REVIEW_BUNDLE_SCHEMA,
		repository: {
			label: review.repository.label,
			baseOid: review.repository.baseOid,
			headOid: review.repository.headOid,
		},
		artifacts: records.map((record) => ({
			path: `reviews/${record.id}.json`,
			hash: { algorithm: "sha256", value: sha256Jcs(record) },
			record,
		})),
	};
	const { bundle: validate } = await validators();
	if (validate === undefined || !validate(bundle)) {
		throw new Error(
			`Generated review bundle failed validation: ${JSON.stringify(validate?.errors)}`,
		);
	}
	return bundle;
}
