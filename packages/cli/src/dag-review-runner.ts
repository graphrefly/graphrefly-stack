import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	assertDagReviewEvidenceIntegrity,
	canonicalize,
	createStrictAjv,
	DAG_REVIEW_EVIDENCE_SCHEMA,
	DAG_SEMANTIC_ARTIFACTS_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";
import { createDagReviewProjection } from "@graphrefly-stack/core";

import { createDagGraphEvidenceForSemanticGate } from "./dag-evidence.js";
import {
	createDagSemanticGate,
	type DagSemanticGateBundle,
	type DagStructuralErrorBundle,
} from "./dag-semantic-runner.js";
import { repositoryStateDirectory } from "./repository-review-state.js";
import { runtimeAssetPath } from "./runtime-paths.js";
import { parseStructuredDiff } from "./structured-diff.js";
import { gitDiffBetween, gitText } from "./system-git.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export type DagReviewEvidenceBundle = {
	schema: typeof DAG_REVIEW_EVIDENCE_SCHEMA;
	domainBundleDigest: Hash;
	planDigest: Hash;
	policyDigest: Hash;
	domainBundle: DagSemanticGateBundle | DagStructuralErrorBundle;
	plan: JsonObject;
	policy: JsonObject;
	objects: JsonObject[];
	comparisons: JsonObject[];
	projection: JsonObject;
};

export type DagReviewEvidenceRun = DagReviewEvidenceBundle & {
	artifact: { path: string; digest: Hash };
};

export class DagReviewRunnerError extends Error {
	constructor(
		readonly code: "CONTRACT_INVALID" | "EVIDENCE_MISMATCH" | "LOCAL_STATE_INVALID",
		message: string,
	) {
		super(message);
		this.name = "DagReviewRunnerError";
	}
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagReviewRunnerError("EVIDENCE_MISMATCH", `${label} must be an object`);
	}
	return value as JsonObject;
}

function gitJson(repository: string, revision: string, path: string): JsonObject {
	try {
		return object(JSON.parse(gitText(repository, ["show", `${revision}:${path}`])), path);
	} catch {
		throw new DagReviewRunnerError(
			"EVIDENCE_MISMATCH",
			`Accepted artifact is unavailable at ${revision}:${path}`,
		);
	}
}

async function validateBundle(bundle: DagReviewEvidenceBundle): Promise<void> {
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
	const validate = ajv.getSchema(
		`${DAG_SEMANTIC_ARTIFACTS_SCHEMA}#/definitions/DagReviewEvidenceBundle`,
	);
	if (validate === undefined || !validate(bundle)) {
		throw new DagReviewRunnerError(
			"CONTRACT_INVALID",
			`DAG review evidence failed validation: ${JSON.stringify(validate?.errors)}`,
		);
	}
	try {
		assertDagReviewEvidenceIntegrity(bundle);
	} catch (error) {
		throw new DagReviewRunnerError(
			"CONTRACT_INVALID",
			error instanceof Error ? error.message : "DAG review evidence integrity failed",
		);
	}
}

async function persistBundle(
	repository: string,
	planId: string,
	bundle: DagReviewEvidenceBundle,
): Promise<{ path: string; digest: Hash }> {
	const directory = await repositoryStateDirectory(repository, "dag-reviews", planId);
	const digest = hash(bundle);
	const path = resolve(directory, `${digest.value}.json`);
	try {
		await writeFile(path, `${canonicalize(bundle)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const status = await lstat(path);
		if (!status.isFile() || status.isSymbolicLink()) {
			throw new DagReviewRunnerError("LOCAL_STATE_INVALID", "Existing DAG review path is unsafe");
		}
		let existing: unknown;
		try {
			existing = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new DagReviewRunnerError(
				"LOCAL_STATE_INVALID",
				"Existing DAG review evidence is malformed",
			);
		}
		if (sha256Jcs(existing) !== digest.value) {
			throw new DagReviewRunnerError(
				"LOCAL_STATE_INVALID",
				"Existing DAG review evidence violates its content address",
			);
		}
	}
	return { path, digest };
}

export async function createDagReviewEvidence(options: {
	repository: string;
	base: string;
	head: string;
	planId: string;
	repositoryIdentity: { provider: string; owner: string; name: string };
}): Promise<DagReviewEvidenceRun> {
	const gateRun = await createDagSemanticGate(options);
	const graphEvidence = await createDagGraphEvidenceForSemanticGate(options);
	const { artifact: _artifact, ...runWithoutArtifact } = gateRun;
	const { cache: _cache, ...normalDomain } = runWithoutArtifact as typeof runWithoutArtifact & {
		cache?: unknown;
	};
	const domainBundle = normalDomain as DagSemanticGateBundle | DagStructuralErrorBundle;
	if (sha256Jcs(domainBundle.topology) !== sha256Jcs(graphEvidence.topology)) {
		throw new DagReviewRunnerError(
			"EVIDENCE_MISMATCH",
			"DAG topology changed while review evidence was composed",
		);
	}
	const head = String(object(domainBundle.topology.head, "topology head").value);
	const plan =
		domainBundle.schema === "graphrefly.stack.dag-structural-error-bundle.v2"
			? domainBundle.plan
			: gitJson(options.repository, head, `.graphrefly-stack/plans/${options.planId}.json`);
	const policy =
		domainBundle.schema === "graphrefly.stack.dag-structural-error-bundle.v2"
			? domainBundle.policy
			: gitJson(options.repository, head, ".graphrefly-stack/policy.json");
	const objects = graphEvidence.blueprints.map((entry) => ({
		oid: entry.revision,
		subject: gitText(options.repository, ["show", "-s", "--format=%s", entry.revision.value]),
		blueprint: entry.blueprint,
		blueprintDigest: hash(entry.blueprint),
	}));
	const topologyObjects = (domainBundle.topology.objects as JsonObject[]) ?? [];
	const comparisons = graphEvidence.parentDeltas.map((entry) => {
		const topologyObject = topologyObjects.find(
			(candidate) => object(candidate.oid, "object OID").value === entry.to.value,
		);
		const parents = (topologyObject?.parents as JsonObject[]) ?? [];
		const parentIndex = parents.findIndex(
			(parent) => parent.algorithm === entry.from.algorithm && parent.value === entry.from.value,
		);
		if (parentIndex < 0) {
			throw new DagReviewRunnerError(
				"EVIDENCE_MISMATCH",
				"DAG parent delta does not match topology",
			);
		}
		const structuredDiff = parseStructuredDiff(
			Buffer.from(gitDiffBetween(options.repository, entry.from.value, entry.to.value)).toString(
				"utf8",
			),
		);
		return {
			from: entry.from,
			to: entry.to,
			parentIndex,
			blueprintDelta: entry.delta,
			deltaDigest: hash(entry.delta),
			structuredDiff,
			diffDigest: hash(structuredDiff),
		};
	});
	const bundle: DagReviewEvidenceBundle = {
		schema: DAG_REVIEW_EVIDENCE_SCHEMA,
		domainBundleDigest: hash(domainBundle),
		planDigest: hash(plan),
		policyDigest: hash(policy),
		domainBundle,
		plan,
		policy,
		objects,
		comparisons,
		projection: createDagReviewProjection({
			topology: domainBundle.topology,
			dependencyGraph: domainBundle.dependencyGraph,
			gateResult: domainBundle.gateResult,
		}),
	};
	await validateBundle(bundle);
	const artifact = await persistBundle(options.repository, options.planId, bundle);
	return { ...bundle, artifact };
}
