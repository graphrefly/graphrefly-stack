import { canonicalize } from "./jcs.js";

type JsonObject = Record<string, unknown>;

export class DagIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function oid(value: unknown, label: string): string {
	const record = object(value, label);
	if (typeof record.value !== "string") throw new DagIntegrityError(`${label} is invalid`);
	return `${record.algorithm as string}:${record.value}`;
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

function orderedKey(layer: number, value: string): string {
	return `${String(layer).padStart(3, "0")}:${value}`;
}

export function assertDagTopologyIntegrity(value: unknown): void {
	const topology = object(value, "DAG topology");
	const base = oid(topology.base, "topology base");
	const head = oid(topology.head, "topology head");
	const objects = Array.isArray(topology.objects)
		? topology.objects.map((entry) => object(entry, "topology object"))
		: [];
	const joins = Array.isArray(topology.joins)
		? topology.joins.map((entry) => object(entry, "join binding"))
		: [];
	if (objects.length === 0 || objects.length > 64) {
		throw new DagIntegrityError("DAG topology object count is outside the v2 bound");
	}

	const byOid = new Map<string, JsonObject>();
	let previousOrder = "";
	for (const entry of objects) {
		const id = oid(entry.oid, "topology object OID");
		const layer = entry.layer as number;
		const order = orderedKey(layer, id);
		if (byOid.has(id) || (previousOrder !== "" && previousOrder >= order)) {
			throw new DagIntegrityError("DAG topology objects are duplicated or not canonically ordered");
		}
		previousOrder = order;
		byOid.set(id, entry);
	}
	if (!byOid.has(head)) throw new DagIntegrityError("DAG topology head is not selected");
	const ancestryMemo = new Map<string, boolean>();
	const isAncestor = (ancestor: string, descendant: string): boolean => {
		if (ancestor === descendant) return true;
		if (descendant === base) return ancestor === base;
		const key = `${ancestor}>${descendant}`;
		const memoized = ancestryMemo.get(key);
		if (memoized !== undefined) return memoized;
		const candidate = byOid.get(descendant);
		const result =
			candidate !== undefined &&
			(candidate.parents as unknown[]).some((parent) =>
				isAncestor(ancestor, oid(parent, "topology parent")),
			);
		ancestryMemo.set(key, result);
		return result;
	};

	const joinByOid = new Map(joins.map((entry) => [oid(entry.oid, "join OID"), entry]));
	if (joinByOid.size !== joins.length)
		throw new DagIntegrityError("DAG join bindings are duplicated");
	let previousJoinOrder = "";
	for (const join of joins) {
		const joinOrder = orderedKey(join.layer as number, oid(join.oid, "join OID"));
		if (previousJoinOrder !== "" && previousJoinOrder >= joinOrder) {
			throw new DagIntegrityError("join bindings are not canonically ordered");
		}
		previousJoinOrder = joinOrder;
	}
	for (const entry of objects) {
		const id = oid(entry.oid, "topology object OID");
		const parents = Array.isArray(entry.parents) ? entry.parents : [];
		const parentIds = parents.map((parent) => oid(parent, "topology parent"));
		if (new Set(parentIds).size !== parentIds.length) {
			throw new DagIntegrityError("DAG topology object repeats a parent");
		}
		let maximumParentLayer = 0;
		for (const parentId of parentIds) {
			if (parentId === base) continue;
			const parent = byOid.get(parentId);
			if (parent === undefined || (parent.layer as number) >= (entry.layer as number)) {
				throw new DagIntegrityError("DAG topology parent is missing or not earlier");
			}
			maximumParentLayer = Math.max(maximumParentLayer, parent.layer as number);
		}
		if ((entry.layer as number) !== maximumParentLayer + 1) {
			throw new DagIntegrityError("DAG topology layer is not derived from its parents");
		}
		if (entry.kind === "implementation") {
			if (parents.length !== 1 || typeof entry.workUnitId !== "string" || joinByOid.has(id)) {
				throw new DagIntegrityError("implementation object has invalid WorkUnit or join semantics");
			}
		} else if (entry.kind === "join") {
			if (parents.length !== 2 || entry.workUnitId !== null) {
				throw new DagIntegrityError("join object must be transport-only with two parents");
			}
			const join = joinByOid.get(id);
			if (
				join === undefined ||
				!equal(join.parents, entry.parents) ||
				join.layer !== entry.layer ||
				!equal(join.joinBlueprintHash, entry.blueprintHash)
			) {
				throw new DagIntegrityError("join binding does not match its topology object");
			}
			const merge = object(join.merge, "join merge");
			if (!equal(merge.candidateTree, merge.observedTree)) {
				throw new DagIntegrityError("join tree contains unattributed merge resolution");
			}
			const deltas = Array.isArray(join.parentDeltas) ? join.parentDeltas : [];
			if (
				deltas.length !== 2 ||
				deltas.some((delta, index) => {
					const record = object(delta, "join parent delta");
					return !equal(record.from, parents[index]) || !equal(record.to, entry.oid);
				})
			) {
				throw new DagIntegrityError("join parent deltas do not preserve Git parent order");
			}
			const mergeBase = oid(join.mergeBase, "join merge base");
			if (mergeBase !== base && !byOid.has(mergeBase)) {
				throw new DagIntegrityError("join merge base is outside the topology slice");
			}
			if (!parentIds.every((parentId) => isAncestor(mergeBase, parentId))) {
				throw new DagIntegrityError("join merge base is not an ancestor of both parents");
			}
			const commonAncestors = [base, ...byOid.keys()].filter((candidate) =>
				parentIds.every((parentId) => isAncestor(candidate, parentId)),
			);
			const maximalCommonAncestors = commonAncestors.filter(
				(candidate) =>
					!commonAncestors.some((other) => other !== candidate && isAncestor(candidate, other)),
			);
			if (maximalCommonAncestors.length !== 1 || maximalCommonAncestors[0] !== mergeBase) {
				throw new DagIntegrityError("join does not bind one exact merge base");
			}
		}
	}
	if (joinByOid.size !== objects.filter((entry) => entry.kind === "join").length) {
		throw new DagIntegrityError("DAG topology contains an unbound join");
	}
	const objectIds = [...byOid.keys()];
	const matchedRight = new Map<string, string>();
	const augment = (left: string, visited: Set<string>): boolean => {
		for (const right of objectIds) {
			if (left === right || !isAncestor(left, right) || visited.has(right)) continue;
			visited.add(right);
			const previous = matchedRight.get(right);
			if (previous === undefined || augment(previous, visited)) {
				matchedRight.set(right, left);
				return true;
			}
		}
		return false;
	};
	let matching = 0;
	for (const left of objectIds) {
		if (augment(left, new Set())) matching += 1;
	}
	if (objectIds.length - matching > 8) {
		throw new DagIntegrityError("DAG topology width exceeds the v2 bound");
	}

	const reachable = new Set<string>();
	const pending = [head];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		if (current === base || reachable.has(current)) continue;
		const entry = byOid.get(current);
		if (entry === undefined)
			throw new DagIntegrityError("DAG topology contains an unreachable parent");
		reachable.add(current);
		for (const parent of entry.parents as unknown[]) pending.push(oid(parent, "topology parent"));
	}
	if (reachable.size !== objects.length) {
		throw new DagIntegrityError("DAG topology contains objects outside the base-to-head slice");
	}
}
