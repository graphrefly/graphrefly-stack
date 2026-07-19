import {
	assertDagStructuralErrorIntegrity,
	canonicalize,
	DAG_REASON_ORDER,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

export interface DagStructuralErrorComputation {
	readonly errorInput: JsonObject;
	readonly gateResult: JsonObject;
}

export interface DagDependencyNodeV2 {
	readonly workUnitId: string;
	readonly dependencies: readonly string[];
}

export function diagnoseDagDependenciesV2(nodes: readonly DagDependencyNodeV2[]): {
	workUnitIds: string[];
	diagnostics: JsonObject[];
} {
	const byId = new Map<string, string[]>();
	for (const node of nodes) {
		if (byId.has(node.workUnitId))
			throw new TypeError(`dependency graph repeats ${node.workUnitId}`);
		const dependencies = [...node.dependencies].sort();
		if (new Set(dependencies).size !== dependencies.length) {
			throw new TypeError(`${node.workUnitId} repeats a dependency`);
		}
		byId.set(node.workUnitId, dependencies);
	}
	const workUnitIds = [...byId.keys()].sort();
	const diagnostics: JsonObject[] = [];
	for (const workUnitId of workUnitIds) {
		const missing = (byId.get(workUnitId) ?? []).filter((dependency) => !byId.has(dependency));
		if (missing.length > 0) {
			diagnostics.push({
				workUnitId,
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
	for (const id of workUnitIds) if (!indexes.has(id)) visit(id);
	components.sort((left, right) => {
		const leftKey = canonicalize(left);
		const rightKey = canonicalize(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
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
	diagnostics.sort((left, right) => {
		const leftId = left.workUnitId as string;
		const rightId = right.workUnitId as string;
		if (leftId !== rightId) return leftId < rightId ? -1 : 1;
		return (
			DAG_REASON_ORDER.indexOf(left.reasonCode as (typeof DAG_REASON_ORDER)[number]) -
			DAG_REASON_ORDER.indexOf(right.reasonCode as (typeof DAG_REASON_ORDER)[number])
		);
	});
	return { workUnitIds, diagnostics };
}

export function computeDagStructuralErrorV2(errorInput: JsonObject): DagStructuralErrorComputation {
	const diagnostics = errorInput.diagnostics as JsonObject[];
	const byId = new Map<string, JsonObject[]>();
	for (const diagnostic of diagnostics) {
		const id = diagnostic.workUnitId as string;
		byId.set(id, [...(byId.get(id) ?? []), diagnostic]);
	}
	const workUnitIds = errorInput.workUnitIds as string[];
	const gateResult: JsonObject = {
		schema: "graphrefly.stack.dag-gate-result.v2",
		inputDigest: { algorithm: "sha256", value: sha256Jcs(errorInput) },
		verdict: "error",
		minimalAffectedCut: workUnitIds.filter((id) => byId.has(id)),
		units: workUnitIds.map((workUnitId) => {
			const unitDiagnostics = byId.get(workUnitId) ?? [];
			const reasonCodes = [
				...new Set(unitDiagnostics.map((entry) => entry.reasonCode as string)),
			].sort(
				(left, right) =>
					DAG_REASON_ORDER.indexOf(left as (typeof DAG_REASON_ORDER)[number]) -
					DAG_REASON_ORDER.indexOf(right as (typeof DAG_REASON_ORDER)[number]),
			);
			const witnesses = unitDiagnostics
				.map((entry) => ({
					kind: "structural",
					workUnitId,
					reasonCode: entry.reasonCode,
					relatedWorkUnitIds: entry.relatedWorkUnitIds,
					relatedCommits: entry.relatedCommits,
					edges: entry.edges,
				}))
				.sort((left, right) => {
					const leftKey = canonicalize(left);
					const rightKey = canonicalize(right);
					return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
				});
			return {
				workUnitId,
				verdict: unitDiagnostics.length === 0 ? "not-evaluated" : "invalid",
				reasonCodes,
				witnesses,
				recordId: null,
			};
		}),
		joins: [],
	};
	assertDagStructuralErrorIntegrity({ input: errorInput, result: gateResult });
	return { errorInput, gateResult };
}
