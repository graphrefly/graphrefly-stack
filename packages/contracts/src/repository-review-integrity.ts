import { sha256Jcs } from "./jcs.js";
import {
	REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA,
	REPOSITORY_REVIEW_DECISION_V2_SCHEMA,
	type RepositoryReviewBundleV2,
} from "./repository-review.js";

type JsonObject = Record<string, unknown>;

export class RepositoryReviewIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RepositoryReviewIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RepositoryReviewIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function sameDigest(left: JsonObject, right: JsonObject): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

export function assertRepositoryReviewBundleV2Integrity(bundle: RepositoryReviewBundleV2): void {
	const root = object(bundle, "repository review bundle");
	if (root.schema !== REPOSITORY_REVIEW_BUNDLE_V2_SCHEMA) {
		throw new RepositoryReviewIntegrityError("unsupported repository review bundle schema");
	}
	const repository = object(root.repository, "bundle repository");
	const reviewTargetDigest = object(root.reviewTargetDigest, "bundle review target digest");
	if (!Array.isArray(root.artifacts)) {
		throw new RepositoryReviewIntegrityError("bundle artifacts must be an array");
	}
	const paths = new Set<string>();
	const ids = new Set<string>();
	for (const value of root.artifacts) {
		const artifact = object(value, "review artifact");
		const record = object(artifact.record, "review record");
		const id = String(record.id ?? "");
		const path = String(artifact.path ?? "");
		if (record.schema !== REPOSITORY_REVIEW_DECISION_V2_SCHEMA) {
			throw new RepositoryReviewIntegrityError("portable v2 contains a non-v2 decision");
		}
		if (path !== `reviews/${id}.json`) {
			throw new RepositoryReviewIntegrityError("review artifact path does not match its record");
		}
		if (paths.has(path) || ids.has(id)) {
			throw new RepositoryReviewIntegrityError("portable review decision is duplicated");
		}
		paths.add(path);
		ids.add(id);
		const target = object(record.target, "review record target");
		if (target.baseOid !== repository.baseOid || target.headOid !== repository.headOid) {
			throw new RepositoryReviewIntegrityError("review record Git target does not match bundle");
		}
		if (
			!sameDigest(
				object(target.reviewTargetDigest, "record review target digest"),
				reviewTargetDigest,
			)
		) {
			throw new RepositoryReviewIntegrityError("review record target digest does not match bundle");
		}
		const hash = object(artifact.hash, "review artifact hash");
		if (hash.algorithm !== "sha256" || hash.value !== sha256Jcs(record)) {
			throw new RepositoryReviewIntegrityError("review artifact hash does not match its record");
		}
	}
}
