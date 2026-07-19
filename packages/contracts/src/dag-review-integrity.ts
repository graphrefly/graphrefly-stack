import { assertDagReviewIntegrity, assertDagSemanticIntegrity } from "./dag-semantic-integrity.js";
import { assertDagStructuralErrorBundleIntegrity } from "./dag-structural-error-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

export class DagReviewIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagReviewIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagReviewIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new DagReviewIntegrityError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function oidKey(value: unknown): string {
	const oid = object(value, "Git OID");
	return `${String(oid.algorithm)}:${String(oid.value)}`;
}

function blueprintHash(value: unknown): string {
	const blueprint = object(value, "GraphBlueprint");
	const digest = object(blueprint.hash, "GraphBlueprint hash");
	if (digest.algorithm !== "sha256" || typeof digest.value !== "string") {
		throw new DagReviewIntegrityError("GraphBlueprint hash is invalid");
	}
	return digest.value;
}

function assertSelection(
	topology: JsonObject,
	gateResult: JsonObject,
	selectionValue: unknown,
): void {
	const selection = object(selectionValue, "selected evidence");
	const topologyObjects = objects(topology.objects, "topology object");
	if (selection.kind === "structural-unit") {
		const unit = objects(gateResult.units, "gate unit").find(
			(entry) => entry.workUnitId === selection.workUnitId,
		);
		const implementation = topologyObjects.find(
			(entry) => entry.kind === "implementation" && entry.workUnitId === selection.workUnitId,
		);
		if (unit === undefined || unit.verdict !== "invalid" || implementation !== undefined) {
			throw new DagReviewIntegrityError("structural selection is not an invalid WorkUnit");
		}
		return;
	}
	if (selection.kind === "work-unit") {
		const selected = topologyObjects.find(
			(entry) => entry.kind === "implementation" && entry.workUnitId === selection.workUnitId,
		);
		if (
			selected === undefined ||
			!equal(selected.oid, selection.commit) ||
			!equal((selected.parents as unknown[])[0], selection.parent)
		) {
			throw new DagReviewIntegrityError("WorkUnit selection does not match topology");
		}
		return;
	}
	if (selection.kind === "join") {
		const selected = topologyObjects.find(
			(entry) => entry.kind === "join" && equal(entry.oid, selection.join),
		);
		const parentIndex = selection.parentIndex as number;
		if (
			selected === undefined ||
			(parentIndex !== 0 && parentIndex !== 1) ||
			!equal((selected.parents as unknown[])[parentIndex], selection.parent)
		) {
			throw new DagReviewIntegrityError("join selection does not match topology");
		}
		return;
	}
	throw new DagReviewIntegrityError("selected evidence kind is unsupported");
}

export function assertDagReviewEvidenceIntegrity(value: unknown): void {
	const bundle = object(value, "DAG review evidence bundle");
	if (bundle.schema !== "graphrefly.stack.dag-review-evidence.v2") {
		throw new DagReviewIntegrityError("unsupported DAG review evidence schema");
	}
	const domain = object(bundle.domainBundle, "DAG domain bundle");
	const plan = object(bundle.plan, "accepted plan");
	const policy = object(bundle.policy, "repository policy");
	const topology = object(domain.topology, "topology");
	const dependencyGraph = object(domain.dependencyGraph, "dependency graph");
	const gateResult = object(domain.gateResult, "gate result");
	if (domain.schema === "graphrefly.stack.dag-gate-bundle.v2") {
		assertDagSemanticIntegrity({
			topology,
			dependencyGraph,
			bindings: domain.bindings,
			records: domain.records,
			unitEvaluations: domain.unitEvaluations,
			joinEvaluations: domain.joinEvaluations,
			gateInput: domain.gateInput,
			gateResult,
		});
		const input = object(domain.gateInput, "gate input");
		if (
			!equal(input.planDigest, hash(plan)) ||
			!equal(input.policyDigest, hash(policy)) ||
			dependencyGraph.planId !== plan.planId
		) {
			throw new DagReviewIntegrityError("normal review plan or policy does not match gate input");
		}
	} else if (domain.schema === "graphrefly.stack.dag-structural-error-bundle.v2") {
		assertDagStructuralErrorBundleIntegrity(domain);
		if (!equal(domain.plan, plan) || !equal(domain.policy, policy)) {
			throw new DagReviewIntegrityError("structural review plan or policy does not match domain");
		}
	} else {
		throw new DagReviewIntegrityError("DAG review domain bundle kind is unsupported");
	}
	if (
		!equal(bundle.domainBundleDigest, hash(domain)) ||
		!equal(bundle.planDigest, hash(plan)) ||
		!equal(bundle.policyDigest, hash(policy))
	) {
		throw new DagReviewIntegrityError("DAG review source digests do not match");
	}

	const topologyObjects = objects(topology.objects, "topology object");
	const expectedOids = [topology.base, ...topologyObjects.map((entry) => entry.oid)];
	const reviewObjects = objects(bundle.objects, "review object");
	if (
		reviewObjects.length !== expectedOids.length ||
		reviewObjects.some((entry, index) => !equal(entry.oid, expectedOids[index]))
	) {
		throw new DagReviewIntegrityError("review objects do not match canonical topology order");
	}
	const expectedBlueprintHashes = [
		object(topology.baseBlueprintHash, "base Blueprint hash").value,
		...topologyObjects.map((entry) => object(entry.blueprintHash, "Blueprint hash").value),
	];
	const objectByOid = new Map<string, JsonObject>();
	for (let index = 0; index < reviewObjects.length; index += 1) {
		const entry = reviewObjects[index] as JsonObject;
		if (
			!equal(entry.blueprintDigest, hash(entry.blueprint)) ||
			blueprintHash(entry.blueprint) !== expectedBlueprintHashes[index]
		) {
			throw new DagReviewIntegrityError("review Blueprint does not match topology");
		}
		objectByOid.set(oidKey(entry.oid), entry);
	}

	const expectedEdges = topologyObjects.flatMap((entry) =>
		(entry.parents as unknown[]).map((parent, parentIndex) => ({
			from: parent,
			to: entry.oid,
			parentIndex,
		})),
	);
	const comparisons = objects(bundle.comparisons, "parent comparison");
	if (comparisons.length !== expectedEdges.length) {
		throw new DagReviewIntegrityError("review comparison count does not match topology edges");
	}
	for (let index = 0; index < comparisons.length; index += 1) {
		const comparison = comparisons[index] as JsonObject;
		const edge = expectedEdges[index] as JsonObject;
		if (
			!equal(comparison.from, edge.from) ||
			!equal(comparison.to, edge.to) ||
			comparison.parentIndex !== edge.parentIndex ||
			!equal(comparison.deltaDigest, hash(comparison.blueprintDelta)) ||
			!equal(comparison.diffDigest, hash(comparison.structuredDiff))
		) {
			throw new DagReviewIntegrityError("review comparison is not canonically edge-bound");
		}
		const from = objectByOid.get(oidKey(comparison.from));
		const to = objectByOid.get(oidKey(comparison.to));
		if (from === undefined || to === undefined) {
			throw new DagReviewIntegrityError("review comparison references missing Blueprint evidence");
		}
		const delta = object(comparison.blueprintDelta, "Blueprint delta");
		if (
			blueprintHash(from.blueprint) !== object(delta.fromHash, "delta from hash").value ||
			blueprintHash(to.blueprint) !== object(delta.toHash, "delta to hash").value
		) {
			throw new DagReviewIntegrityError("review comparison Blueprint endpoints do not match");
		}
		const diff = object(comparison.structuredDiff, "structured diff");
		const paths = Array.isArray(diff.paths) ? diff.paths.map(String) : [];
		if (
			paths.some((path, pathIndex) => pathIndex > 0 && (paths[pathIndex - 1] as string) >= path)
		) {
			throw new DagReviewIntegrityError("structured diff paths are not canonical");
		}
	}
	assertDagReviewIntegrity({
		topology,
		dependencyGraph,
		gateResult,
		review: bundle.projection,
	});
}

export function assertDagReviewDecisionIntegrity(value: {
	reviewEvidence: unknown;
	decision: unknown;
}): void {
	assertDagReviewEvidenceIntegrity(value.reviewEvidence);
	const evidence = object(value.reviewEvidence, "DAG review evidence");
	const projection = object(evidence.projection, "DAG review projection");
	const domain = object(evidence.domainBundle, "DAG domain bundle");
	const decision = object(value.decision, "DAG review decision");
	if (decision.schema !== "graphrefly.stack.dag-review-decision.v2") {
		throw new DagReviewIntegrityError("unsupported DAG review decision schema");
	}
	const target = object(decision.target, "DAG review decision target");
	if (
		!equal(target.gateResultDigest, projection.gateResultDigest) ||
		!equal(target.topologyDigest, projection.topologyDigest) ||
		!equal(target.dependencyGraphDigest, projection.dependencyGraphDigest)
	) {
		throw new DagReviewIntegrityError("DAG review decision target is stale");
	}
	if (decision.selectedEvidence !== undefined) {
		assertSelection(
			object(domain.topology, "topology"),
			object(domain.gateResult, "gate result"),
			decision.selectedEvidence,
		);
	}
}
