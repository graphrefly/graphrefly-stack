import { DAG_REASON_ORDER, type DagReasonCode } from "./dag.js";
import { assertDagTopologyIntegrity, DagIntegrityError } from "./dag-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";

type JsonObject = Record<string, unknown>;

const STRUCTURAL_REASONS = new Set<DagReasonCode>([
	"BINDING_MISSING",
	"BINDING_AMBIGUOUS",
	"COMMIT_BINDING_MISMATCH",
	"DEPENDENCY_MISSING",
	"DEPENDENCY_CYCLE",
	"DEPENDENCY_NOT_ANCESTOR",
]);

export class DagStructuralErrorIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagStructuralErrorIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagStructuralErrorIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value))
		throw new DagStructuralErrorIntegrityError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new DagStructuralErrorIntegrityError(`${label} must be a string array`);
	}
	return value;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string")
		throw new DagStructuralErrorIntegrityError(`${label} must be a string`);
	return value;
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function assertExactKeys(value: JsonObject, keys: readonly string[], label: string): void {
	const observed = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (!equal(observed, expected)) {
		throw new DagStructuralErrorIntegrityError(`${label} has unsupported fields`);
	}
}

function assertWorkUnitId(value: unknown, label: string): string {
	const result = string(value, label);
	if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(result)) {
		throw new DagStructuralErrorIntegrityError(`${label} is invalid`);
	}
	return result;
}

function assertHash(value: unknown, label: string): void {
	const entry = object(value, label);
	assertExactKeys(entry, ["algorithm", "value"], label);
	if (entry.algorithm !== "sha256" || !/^[0-9a-f]{64}$/u.test(string(entry.value, label))) {
		throw new DagStructuralErrorIntegrityError(`${label} is not SHA-256`);
	}
}

function assertOid(value: unknown, label: string): void {
	const entry = object(value, label);
	assertExactKeys(entry, ["algorithm", "value"], label);
	const algorithm = entry.algorithm;
	const digest = string(entry.value, label);
	if (
		(algorithm !== "sha1" && algorithm !== "sha256") ||
		!new RegExp(`^[0-9a-f]{${algorithm === "sha1" ? 40 : 64}}$`, "u").test(digest)
	) {
		throw new DagStructuralErrorIntegrityError(`${label} is not a Git OID`);
	}
}

function assertSortedUnique(values: readonly string[], label: string): void {
	for (let index = 0; index < values.length; index += 1) {
		if (index > 0 && (values[index - 1] as string) >= (values[index] as string)) {
			throw new DagStructuralErrorIntegrityError(`${label} is not strictly sorted and unique`);
		}
	}
}

function reason(value: unknown): DagReasonCode {
	const result = string(value, "structural reason") as DagReasonCode;
	if (!STRUCTURAL_REASONS.has(result)) {
		throw new DagStructuralErrorIntegrityError("unsupported structural reason");
	}
	return result;
}

function diagnosticKey(value: JsonObject): string {
	return `${assertWorkUnitId(value.workUnitId, "diagnostic WorkUnit ID")}\u0000${String(
		DAG_REASON_ORDER.indexOf(reason(value.reasonCode)),
	).padStart(2, "0")}\u0000${canonicalize(value)}`;
}

function structuralWitness(diagnostic: JsonObject): JsonObject {
	return {
		kind: "structural",
		workUnitId: diagnostic.workUnitId,
		reasonCode: diagnostic.reasonCode,
		relatedWorkUnitIds: diagnostic.relatedWorkUnitIds,
		relatedCommits: diagnostic.relatedCommits,
		edges: diagnostic.edges,
	};
}

function validateDiagnostic(diagnostic: JsonObject, workUnitIds: ReadonlySet<string>): void {
	assertExactKeys(
		diagnostic,
		["workUnitId", "reasonCode", "relatedWorkUnitIds", "relatedCommits", "edges"],
		"structural diagnostic",
	);
	const id = assertWorkUnitId(diagnostic.workUnitId, "diagnostic WorkUnit ID");
	if (!workUnitIds.has(id)) {
		throw new DagStructuralErrorIntegrityError(`${id} diagnostic is outside the accepted plan`);
	}
	const code = reason(diagnostic.reasonCode);
	const related = strings(diagnostic.relatedWorkUnitIds, `${id} related WorkUnits`);
	for (const relatedId of related) assertWorkUnitId(relatedId, `${id} related WorkUnit`);
	assertSortedUnique(related, `${id} related WorkUnits`);
	const commits = objects(diagnostic.relatedCommits, `${id} related commits`);
	for (const commit of commits) assertOid(commit, `${id} related commit`);
	const edges = objects(diagnostic.edges, `${id} structural edges`);
	for (const edge of edges) {
		assertExactKeys(edge, ["from", "to"], `${id} structural edge`);
		assertWorkUnitId(edge.from, `${id} edge source`);
		assertWorkUnitId(edge.to, `${id} edge target`);
	}
	assertSortedUnique(edges.map(canonicalize), `${id} structural edges`);
	if (
		code === "BINDING_MISSING" &&
		(related.length !== 0 || commits.length !== 0 || edges.length !== 0)
	) {
		throw new DagStructuralErrorIntegrityError(`${id} missing binding has extraneous witnesses`);
	}
	if (
		code === "BINDING_AMBIGUOUS" &&
		(related.length !== 0 || commits.length < 2 || edges.length !== 0)
	) {
		throw new DagStructuralErrorIntegrityError(`${id} ambiguous binding witnesses are incomplete`);
	}
	if (code === "BINDING_AMBIGUOUS") {
		assertSortedUnique(commits.map(canonicalize), `${id} ambiguous binding commits`);
	}
	if (
		code === "COMMIT_BINDING_MISMATCH" &&
		(related.length !== 0 || commits.length !== 2 || edges.length !== 0)
	) {
		throw new DagStructuralErrorIntegrityError(`${id} commit mismatch witnesses are incomplete`);
	}
	if (
		code === "DEPENDENCY_MISSING" &&
		(related.length < 1 || commits.length !== 0 || edges.length !== 0)
	) {
		throw new DagStructuralErrorIntegrityError(`${id} missing dependency witnesses are incomplete`);
	}
	if (
		code === "DEPENDENCY_NOT_ANCESTOR" &&
		(related.length !== 1 || commits.length !== 2 || edges.length !== 0)
	) {
		throw new DagStructuralErrorIntegrityError(`${id} ancestry witnesses are incomplete`);
	}
	if (code === "DEPENDENCY_CYCLE") {
		const component = new Set(related);
		if (!component.has(id) || edges.length === 0 || commits.length !== 0) {
			throw new DagStructuralErrorIntegrityError(`${id} cycle witnesses are incomplete`);
		}
		for (const edge of edges) {
			if (
				!component.has(string(edge.from, "cycle edge source")) ||
				!component.has(string(edge.to, "cycle edge target"))
			) {
				throw new DagStructuralErrorIntegrityError(`${id} cycle edge escapes its component`);
			}
		}
	}
}

export function assertDagStructuralErrorIntegrity(value: {
	input: unknown;
	result: unknown;
}): void {
	const input = object(value.input, "DAG structural error input");
	const result = object(value.result, "DAG structural error result");
	assertExactKeys(
		input,
		[
			"schema",
			"topologyDigest",
			"dependencyGraphDigest",
			"policyDigest",
			"planDigest",
			"workUnitIds",
			"availableEvidenceDigests",
			"diagnostics",
		],
		"DAG structural error input",
	);
	if (input.schema !== "graphrefly.stack.dag-structural-error-input.v2") {
		throw new DagStructuralErrorIntegrityError("unsupported DAG structural error input schema");
	}
	for (const field of [
		"topologyDigest",
		"dependencyGraphDigest",
		"policyDigest",
		"planDigest",
	] as const) {
		assertHash(input[field], field);
	}
	const workUnitIds = strings(input.workUnitIds, "structural WorkUnit IDs");
	if (workUnitIds.length === 0 || workUnitIds.length > 64) {
		throw new DagStructuralErrorIntegrityError("structural WorkUnit IDs exceed their bounds");
	}
	for (const id of workUnitIds) assertWorkUnitId(id, "structural WorkUnit ID");
	assertSortedUnique(workUnitIds, "structural WorkUnit IDs");
	const workUnitSet = new Set(workUnitIds);
	const evidence = objects(input.availableEvidenceDigests, "available evidence digest");
	if (evidence.length > 192) {
		throw new DagStructuralErrorIntegrityError("available evidence digests exceed their bounds");
	}
	assertSortedUnique(evidence.map(canonicalize), "available evidence digests");
	for (const entry of evidence) {
		assertExactKeys(entry, ["kind", "workUnitId", "digest"], "available evidence digest");
		if (
			!new Set(["binding", "record", "unit-evaluation"]).has(string(entry.kind, "evidence kind"))
		) {
			throw new DagStructuralErrorIntegrityError("unsupported available evidence kind");
		}
		assertHash(entry.digest, "available evidence digest");
		if (!workUnitSet.has(assertWorkUnitId(entry.workUnitId, "evidence WorkUnit ID"))) {
			throw new DagStructuralErrorIntegrityError("available evidence is outside the accepted plan");
		}
	}
	const diagnostics = objects(input.diagnostics, "structural diagnostic");
	if (diagnostics.length === 0 || diagnostics.length > 64) {
		throw new DagStructuralErrorIntegrityError("structural diagnostics exceed their bounds");
	}
	for (const diagnostic of diagnostics) validateDiagnostic(diagnostic, workUnitSet);
	assertSortedUnique(diagnostics.map(diagnosticKey), "structural diagnostics");

	const diagnosticById = new Map<string, JsonObject[]>();
	for (const diagnostic of diagnostics) {
		const id = diagnostic.workUnitId as string;
		diagnosticById.set(id, [...(diagnosticById.get(id) ?? []), diagnostic]);
	}
	const units = workUnitIds.map((id) => {
		const unitDiagnostics = diagnosticById.get(id) ?? [];
		const reasons = [...new Set(unitDiagnostics.map((entry) => reason(entry.reasonCode)))].sort(
			(left, right) => DAG_REASON_ORDER.indexOf(left) - DAG_REASON_ORDER.indexOf(right),
		);
		const witnesses = unitDiagnostics.map(structuralWitness).sort((left, right) => {
			const leftKey = canonicalize(left);
			const rightKey = canonicalize(right);
			return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
		});
		return {
			workUnitId: id,
			verdict: unitDiagnostics.length === 0 ? "not-evaluated" : "invalid",
			reasonCodes: reasons,
			witnesses,
			recordId: null,
		};
	});
	const expected = {
		schema: "graphrefly.stack.dag-gate-result.v2",
		inputDigest: { algorithm: "sha256", value: sha256Jcs(input) },
		verdict: "error",
		minimalAffectedCut: workUnitIds.filter((id) => diagnosticById.has(id)),
		units,
		joins: [],
	};
	if (!equal(result, expected)) {
		throw new DagStructuralErrorIntegrityError(
			"structural GateResult is not derived from its input",
		);
	}
}

function deriveDependencyDiagnostics(nodes: readonly JsonObject[]): JsonObject[] {
	const byId = new Map(
		nodes.map(
			(node) =>
				[
					assertWorkUnitId(node.workUnitId, "dependency WorkUnit ID"),
					strings(node.dependencies, "dependencies"),
				] as const,
		),
	);
	const ids = [...byId.keys()].sort();
	const diagnostics: JsonObject[] = [];
	for (const id of ids) {
		const missing = (byId.get(id) ?? []).filter((dependency) => !byId.has(dependency)).sort();
		if (missing.length > 0) {
			diagnostics.push({
				workUnitId: id,
				reasonCode: "DEPENDENCY_MISSING",
				relatedWorkUnitIds: missing,
				relatedCommits: [],
				edges: [],
			});
		}
	}
	let nextIndex = 0;
	const indexes = new Map<string, number>();
	const lowLinks = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const components: string[][] = [];
	const visit = (id: string): void => {
		indexes.set(id, nextIndex);
		lowLinks.set(id, nextIndex);
		nextIndex += 1;
		stack.push(id);
		onStack.add(id);
		for (const dependency of byId.get(id) ?? []) {
			if (!byId.has(dependency)) continue;
			if (!indexes.has(dependency)) {
				visit(dependency);
				lowLinks.set(id, Math.min(lowLinks.get(id) as number, lowLinks.get(dependency) as number));
			} else if (onStack.has(dependency)) {
				lowLinks.set(id, Math.min(lowLinks.get(id) as number, indexes.get(dependency) as number));
			}
		}
		if (lowLinks.get(id) !== indexes.get(id)) return;
		const component: string[] = [];
		while (stack.length > 0) {
			const member = stack.pop() as string;
			onStack.delete(member);
			component.push(member);
			if (member === id) break;
		}
		component.sort();
		components.push(component);
	};
	for (const id of ids) if (!indexes.has(id)) visit(id);
	for (const component of components) {
		const members = new Set(component);
		const edges = component
			.flatMap((from) =>
				(byId.get(from) ?? []).filter((to) => members.has(to)).map((to) => ({ from, to })),
			)
			.sort((left, right) => {
				const leftKey = canonicalize(left);
				const rightKey = canonicalize(right);
				return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
			});
		if (component.length === 1 && !edges.some((edge) => edge.from === edge.to)) continue;
		for (const workUnitId of component) {
			diagnostics.push({
				workUnitId,
				reasonCode: "DEPENDENCY_CYCLE",
				relatedWorkUnitIds: component,
				relatedCommits: [],
				edges,
			});
		}
	}
	return diagnostics.sort((left, right) => {
		const leftKey = diagnosticKey(left);
		const rightKey = diagnosticKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function oidKey(value: unknown): string {
	return canonicalize(object(value, "Git OID"));
}

export function assertDagStructuralErrorBundleIntegrity(value: unknown): void {
	const bundle = object(value, "DAG structural error bundle");
	assertExactKeys(
		bundle,
		[
			"schema",
			"topology",
			"dependencyGraph",
			"plan",
			"policy",
			"bindings",
			"errorInput",
			"gateResult",
		],
		"DAG structural error bundle",
	);
	if (bundle.schema !== "graphrefly.stack.dag-structural-error-bundle.v2") {
		throw new DagStructuralErrorIntegrityError("unsupported DAG structural error bundle schema");
	}
	const topology = object(bundle.topology, "topology");
	try {
		assertDagTopologyIntegrity(topology);
	} catch (error) {
		throw new DagStructuralErrorIntegrityError(
			error instanceof DagIntegrityError ? error.message : "DAG topology integrity failed",
		);
	}
	const graph = object(bundle.dependencyGraph, "dependency graph");
	const plan = object(bundle.plan, "accepted plan");
	const policy = object(bundle.policy, "repository policy");
	const bindings = objects(bundle.bindings, "available binding");
	const input = object(bundle.errorInput, "structural error input");
	const units = objects(plan.workUnits, "accepted WorkUnit");
	const unitIds = units.map((unit) => assertWorkUnitId(unit.id, "accepted WorkUnit ID")).sort();
	assertSortedUnique(unitIds, "accepted WorkUnit IDs");
	if (
		!equal(input.topologyDigest, { algorithm: "sha256", value: sha256Jcs(topology) }) ||
		!equal(input.dependencyGraphDigest, { algorithm: "sha256", value: sha256Jcs(graph) }) ||
		!equal(input.planDigest, { algorithm: "sha256", value: sha256Jcs(plan) }) ||
		!equal(input.policyDigest, { algorithm: "sha256", value: sha256Jcs(policy) }) ||
		!equal(input.workUnitIds, unitIds)
	) {
		throw new DagStructuralErrorIntegrityError(
			"structural input does not bind its source artifacts",
		);
	}
	if (graph.planId !== plan.planId || !equal(graph.topologyDigest, input.topologyDigest)) {
		throw new DagStructuralErrorIntegrityError(
			"dependency graph identity does not match its sources",
		);
	}
	const graphNodes = objects(graph.workUnits, "dependency node");
	const graphById = new Map(
		graphNodes.map(
			(node) => [assertWorkUnitId(node.workUnitId, "dependency WorkUnit ID"), node] as const,
		),
	);
	if (graphById.size !== unitIds.length) {
		throw new DagStructuralErrorIntegrityError("dependency graph WorkUnits do not match the plan");
	}
	for (const unit of units) {
		const id = unit.id as string;
		const node = graphById.get(id);
		if (
			node === undefined ||
			!equal(node.dependencies, [...strings(unit.dependencies, `${id} dependencies`)].sort())
		) {
			throw new DagStructuralErrorIntegrityError(
				`${id} dependencies do not match the accepted plan`,
			);
		}
	}

	const expectedDiagnostics = deriveDependencyDiagnostics(graphNodes);
	const topologyObjects = objects(topology.objects, "topology object");
	const candidatesById = new Map<string, JsonObject[]>();
	for (const entry of topologyObjects.filter((candidate) => candidate.kind === "implementation")) {
		const id = assertWorkUnitId(entry.workUnitId, "implementation WorkUnit ID");
		if (!unitIds.includes(id)) {
			throw new DagStructuralErrorIntegrityError("implementation is outside the accepted plan");
		}
		candidatesById.set(id, [...(candidatesById.get(id) ?? []), entry]);
	}
	if (expectedDiagnostics.length === 0) {
		for (const id of unitIds) {
			const candidates = candidatesById.get(id) ?? [];
			if (candidates.length === 0) {
				expectedDiagnostics.push({
					workUnitId: id,
					reasonCode: "BINDING_MISSING",
					relatedWorkUnitIds: [],
					relatedCommits: [],
					edges: [],
				});
			} else if (candidates.length > 1) {
				expectedDiagnostics.push({
					workUnitId: id,
					reasonCode: "BINDING_AMBIGUOUS",
					relatedWorkUnitIds: [],
					relatedCommits: candidates
						.map((entry) => entry.oid)
						.sort((left, right) => (oidKey(left) < oidKey(right) ? -1 : 1)),
					edges: [],
				});
			}
		}
	}
	if (expectedDiagnostics.length === 0) {
		const bindingById = new Map(
			bindings.map(
				(binding) =>
					[assertWorkUnitId(binding.workUnitId, "binding WorkUnit ID"), binding] as const,
			),
		);
		if (
			bindingById.size !== unitIds.length ||
			bindings.some((binding) => !unitIds.includes(binding.workUnitId as string))
		) {
			throw new DagStructuralErrorIntegrityError("available bindings are incomplete");
		}
		for (const id of unitIds) {
			const candidate = (candidatesById.get(id) as JsonObject[])[0] as JsonObject;
			const binding = bindingById.get(id) as JsonObject;
			if (!equal(binding.commit, candidate.oid)) {
				expectedDiagnostics.push({
					workUnitId: id,
					reasonCode: "COMMIT_BINDING_MISMATCH",
					relatedWorkUnitIds: [],
					relatedCommits: [candidate.oid, binding.commit],
					edges: [],
				});
			}
		}
		if (expectedDiagnostics.length === 0) {
			const base = oidKey(topology.base);
			const objectByOid = new Map(
				topologyObjects.map((entry) => [oidKey(entry.oid), entry] as const),
			);
			const memo = new Map<string, boolean>();
			const isAncestor = (ancestor: string, descendant: string): boolean => {
				if (ancestor === descendant) return true;
				if (descendant === base) return ancestor === base;
				const key = `${ancestor}>${descendant}`;
				const cached = memo.get(key);
				if (cached !== undefined) return cached;
				const result =
					Array.isArray(objectByOid.get(descendant)?.parents) &&
					(objectByOid.get(descendant)?.parents as unknown[]).some((parent) =>
						isAncestor(ancestor, oidKey(parent)),
					);
				memo.set(key, result === true);
				return result === true;
			};
			for (const id of unitIds) {
				const dependent = bindingById.get(id) as JsonObject;
				for (const dependencyId of strings(graphById.get(id)?.dependencies, `${id} dependencies`)) {
					const dependency = bindingById.get(dependencyId) as JsonObject;
					if (!isAncestor(oidKey(dependency.commit), oidKey(dependent.commit))) {
						expectedDiagnostics.push({
							workUnitId: id,
							reasonCode: "DEPENDENCY_NOT_ANCESTOR",
							relatedWorkUnitIds: [dependencyId],
							relatedCommits: [dependency.commit, dependent.commit],
							edges: [],
						});
					}
				}
			}
		}
	}
	expectedDiagnostics.sort((left, right) => {
		const leftKey = diagnosticKey(left);
		const rightKey = diagnosticKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
	if (!equal(input.diagnostics, expectedDiagnostics)) {
		throw new DagStructuralErrorIntegrityError(
			"structural diagnostics are not derived from source artifacts",
		);
	}
	const expectedEvidence = bindings
		.map((binding) => ({
			kind: "binding",
			workUnitId: binding.workUnitId,
			digest: { algorithm: "sha256", value: sha256Jcs(binding) },
		}))
		.sort((left, right) => (canonicalize(left) < canonicalize(right) ? -1 : 1));
	if (!equal(input.availableEvidenceDigests, expectedEvidence)) {
		throw new DagStructuralErrorIntegrityError("available evidence digests do not match bindings");
	}
	assertDagStructuralErrorIntegrity({ input, result: bundle.gateResult });
}
