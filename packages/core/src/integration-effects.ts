import {
	canonicalize,
	INTEGRATION_REASON_ORDER,
	type IntegrationReasonCode,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

export type IntegrationEffectWitness =
	| { kind: "node"; nodeId: string; field: string }
	| {
			kind: "metadata-field";
			ownerKind: "node";
			ownerId: string;
			field: string;
	  }
	| { kind: "edge"; source: string; target: string }
	| { kind: "subgraph"; mountId: string };

export interface IntegrationEffectConflict {
	reasonCode: IntegrationReasonCode;
	witness: IntegrationEffectWitness;
}

export interface IntegrationEffectEvaluation {
	reasonCodes: IntegrationReasonCode[];
	overlaps: IntegrationEffectWitness[];
	conflicts: IntegrationEffectConflict[];
}

function object(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function events(delta: Record<string, unknown>): JsonObject[] {
	return Array.isArray(delta.events)
		? delta.events.map((event) => object(event)).filter((event) => event !== null)
		: [];
}

function topologyPath(event: JsonObject): string[] {
	return Array.isArray(event.topologyPath)
		? event.topologyPath.filter((part): part is string => typeof part === "string")
		: [];
}

function nodeFor(event: JsonObject): JsonObject | null {
	return object(event.node) ?? object(event.after) ?? object(event.before);
}

function nodeKey(event: JsonObject): string | null {
	const node = nodeFor(event);
	return typeof node?.id === "string" ? `${topologyPath(event).join("/")}\u0000${node.id}` : null;
}

function edgeFor(event: JsonObject): JsonObject | null {
	return object(event.edge);
}

function edgeKey(event: JsonObject): string | null {
	const edge = edgeFor(event);
	return typeof edge?.from === "string" && typeof edge.to === "string"
		? `${topologyPath(event).join("/")}\u0000${edge.from}\u0000${edge.to}`
		: null;
}

function subgraphKey(event: JsonObject): string {
	return topologyPath(event).join("/");
}

function mapBy(
	values: JsonObject[],
	types: ReadonlySet<unknown>,
	key: (event: JsonObject) => string | null,
): Map<string, JsonObject> {
	const result = new Map<string, JsonObject>();
	for (const event of values) {
		if (!types.has(event.type)) continue;
		const identity = key(event);
		if (identity !== null) result.set(identity, event);
	}
	return result;
}

interface FieldChange {
	path: string;
	before: unknown;
	after: unknown;
}

function encoded(value: unknown): string {
	return canonicalize(value === undefined ? ["missing"] : ["value", value]);
}

function fieldChanges(before: unknown, after: unknown, prefix = ""): FieldChange[] {
	if (encoded(before) === encoded(after)) return [];
	const left = object(before);
	const right = object(after);
	if (left !== null && right !== null) {
		const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
		return keys.flatMap((key) =>
			fieldChanges(left[key] ?? null, right[key] ?? null, prefix === "" ? key : `${prefix}.${key}`),
		);
	}
	return [{ path: prefix || "*", before, after }];
}

function nodeChanges(event: JsonObject): FieldChange[] {
	if (event.type === "node-added") {
		return fieldChanges({}, event.node).filter((change) => change.path !== "id");
	}
	if (event.type !== "node-changed") return [{ path: "*", before: null, after: null }];
	return fieldChanges(event.before, event.after).filter((change) => change.path !== "id");
}

function valueAt(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		const record = object(current);
		if (record === null || !Object.hasOwn(record, part)) return undefined;
		current = record[part];
	}
	return current;
}

function nodeWitness(nodeId: string, field: string): IntegrationEffectWitness {
	if (field.startsWith("meta.")) {
		return {
			kind: "metadata-field",
			ownerKind: "node",
			ownerId: nodeId,
			field: field.slice("meta.".length),
		};
	}
	return { kind: "node", nodeId, field };
}

function addUnique<T>(values: T[], value: T): void {
	const bytes = canonicalize(value);
	if (!values.some((entry) => canonicalize(entry) === bytes)) values.push(value);
}

function compareNodeEvents(
	left: JsonObject,
	right: JsonObject,
	overlaps: IntegrationEffectWitness[],
	conflicts: IntegrationEffectConflict[],
): void {
	const node = nodeFor(left) ?? nodeFor(right);
	if (typeof node?.id !== "string") return;
	const leftChanges = nodeChanges(left);
	const rightChanges = nodeChanges(right);
	for (const change of [...leftChanges, ...rightChanges]) {
		addUnique(overlaps, nodeWitness(node.id, change.path));
	}
	if (left.type === "node-removed" || right.type === "node-removed") {
		if (left.type !== right.type) {
			addUnique(conflicts, {
				reasonCode: "NODE_DELETE_CHANGE",
				witness: { kind: "node", nodeId: node.id, field: "*" },
			});
		}
		return;
	}
	if (left.type === "node-added" || right.type === "node-added") {
		if (left.type !== right.type) {
			addUnique(conflicts, {
				reasonCode: "NODE_INCOMPATIBLE_CHANGE",
				witness: { kind: "node", nodeId: node.id, field: "*" },
			});
			return;
		}
		const rightByPath = new Map(rightChanges.map((change) => [change.path, change]));
		for (const change of leftChanges) {
			const other = rightByPath.get(change.path);
			if (other === undefined || encoded(change.after) === encoded(other.after)) continue;
			const witness = nodeWitness(node.id, change.path);
			addUnique(conflicts, {
				reasonCode:
					witness.kind === "metadata-field"
						? "METADATA_INCOMPATIBLE_CHANGE"
						: "NODE_INCOMPATIBLE_CHANGE",
				witness,
			});
		}
		return;
	}
	const rightByPath = new Map(rightChanges.map((change) => [change.path, change]));
	for (const change of leftChanges) {
		const other = rightByPath.get(change.path);
		if (other === undefined || encoded(change.after) === encoded(other.after)) continue;
		const witness = nodeWitness(node.id, change.path);
		addUnique(conflicts, {
			reasonCode:
				witness.kind === "metadata-field"
					? "METADATA_INCOMPATIBLE_CHANGE"
					: "NODE_INCOMPATIBLE_CHANGE",
			witness,
		});
	}
}

export function evaluateIntegrationEffects(options: {
	targetDelta: Record<string, unknown>;
	headDelta: Record<string, unknown>;
	candidateDelta: Record<string, unknown>;
}): IntegrationEffectEvaluation {
	const targetEvents = events(options.targetDelta);
	const headEvents = events(options.headDelta);
	const candidateEvents = events(options.candidateDelta);
	const overlaps: IntegrationEffectWitness[] = [];
	const conflicts: IntegrationEffectConflict[] = [];
	const nodeTypes = new Set(["node-added", "node-changed", "node-removed"]);
	const targetNodes = mapBy(targetEvents, nodeTypes, nodeKey);
	const headNodes = mapBy(headEvents, nodeTypes, nodeKey);
	const candidateNodes = mapBy(candidateEvents, nodeTypes, nodeKey);
	const removedNodeIds = new Set(
		[...targetNodes.values(), ...headNodes.values()]
			.filter((event) => event.type === "node-removed")
			.map((event) => nodeFor(event)?.id)
			.filter((id): id is string => typeof id === "string"),
	);
	for (const [identity, left] of targetNodes) {
		const right = headNodes.get(identity);
		if (right !== undefined) compareNodeEvents(left, right, overlaps, conflicts);
	}
	for (const branchNodes of [targetNodes, headNodes]) {
		for (const [identity, event] of branchNodes) {
			const candidateEvent = candidateNodes.get(identity);
			const node = nodeFor(event);
			if (typeof node?.id !== "string") continue;
			if (event.type === "node-removed") {
				if (candidateEvent?.type !== "node-removed") {
					addUnique(conflicts, {
						reasonCode: "NODE_DELETE_CHANGE",
						witness: { kind: "node", nodeId: node.id, field: "*" },
					});
				}
				continue;
			}
			const finalNode =
				candidateEvent?.type === "node-added"
					? candidateEvent.node
					: candidateEvent?.type === "node-changed"
						? candidateEvent.after
						: null;
			for (const change of nodeChanges(event)) {
				if (encoded(valueAt(finalNode, change.path)) === encoded(change.after)) continue;
				const witness = nodeWitness(node.id, change.path);
				addUnique(conflicts, {
					reasonCode:
						witness.kind === "metadata-field"
							? "METADATA_INCOMPATIBLE_CHANGE"
							: "NODE_INCOMPATIBLE_CHANGE",
					witness,
				});
			}
		}
	}

	const edgeTypes = new Set(["edge-added", "edge-removed"]);
	const targetEdges = mapBy(targetEvents, edgeTypes, edgeKey);
	const headEdges = mapBy(headEvents, edgeTypes, edgeKey);
	const candidateEdges = mapBy(candidateEvents, edgeTypes, edgeKey);
	for (const [identity, left] of targetEdges) {
		const right = headEdges.get(identity);
		if (right === undefined) continue;
		const edge = edgeFor(left) ?? edgeFor(right);
		if (typeof edge?.from !== "string" || typeof edge.to !== "string") continue;
		const witness = { kind: "edge", source: edge.from, target: edge.to } as const;
		addUnique(overlaps, witness);
		if (left.type !== right.type) {
			addUnique(conflicts, { reasonCode: "EDGE_INCOMPATIBLE_CHANGE", witness });
		}
	}
	for (const branchEdges of [targetEdges, headEdges]) {
		for (const [identity, event] of branchEdges) {
			if (candidateEdges.get(identity)?.type === event.type) continue;
			const edge = edgeFor(event);
			if (typeof edge?.from !== "string" || typeof edge.to !== "string") continue;
			if (removedNodeIds.has(edge.from) || removedNodeIds.has(edge.to)) continue;
			addUnique(conflicts, {
				reasonCode: "EDGE_INCOMPATIBLE_CHANGE",
				witness: { kind: "edge", source: edge.from, target: edge.to },
			});
		}
	}

	const subgraphTypes = new Set(["subgraph-added", "subgraph-removed"]);
	const targetSubgraphs = mapBy(targetEvents, subgraphTypes, (event) => subgraphKey(event));
	const headSubgraphs = mapBy(headEvents, subgraphTypes, (event) => subgraphKey(event));
	const candidateSubgraphs = mapBy(candidateEvents, subgraphTypes, (event) => subgraphKey(event));
	for (const [identity, left] of targetSubgraphs) {
		const right = headSubgraphs.get(identity);
		if (right === undefined) continue;
		const witness = { kind: "subgraph", mountId: identity } as const;
		addUnique(overlaps, witness);
		if (left.type !== right.type || canonicalize(left.topology) !== canonicalize(right.topology)) {
			addUnique(conflicts, { reasonCode: "SUBGRAPH_INCOMPATIBLE_CHANGE", witness });
		}
	}
	for (const branchSubgraphs of [targetSubgraphs, headSubgraphs]) {
		for (const [identity, event] of branchSubgraphs) {
			const candidateEvent = candidateSubgraphs.get(identity);
			const preserved =
				candidateEvent !== undefined &&
				candidateEvent.type === event.type &&
				(event.type === "subgraph-removed" ||
					canonicalize(candidateEvent.topology) === canonicalize(event.topology));
			if (preserved) {
				continue;
			}
			addUnique(conflicts, {
				reasonCode: "SUBGRAPH_INCOMPATIBLE_CHANGE",
				witness: { kind: "subgraph", mountId: identity },
			});
		}
	}

	for (const [removedNodes, otherEvents] of [
		[targetNodes, headEvents],
		[headNodes, targetEvents],
	] as const) {
		for (const event of removedNodes.values()) {
			if (event.type !== "node-removed") continue;
			const node = nodeFor(event);
			if (typeof node?.id !== "string") continue;
			for (const other of otherEvents) {
				const edge = edgeFor(other);
				if (edge?.from !== node.id && edge?.to !== node.id) continue;
				addUnique(conflicts, {
					reasonCode: "NODE_DELETE_CHANGE",
					witness: { kind: "node", nodeId: node.id, field: "*" },
				});
			}
		}
	}

	const compare = (left: unknown, right: unknown) => {
		const leftBytes = canonicalize(left);
		const rightBytes = canonicalize(right);
		return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
	};
	overlaps.sort(compare);
	conflicts.sort(compare);
	const present = new Set(conflicts.map((conflict) => conflict.reasonCode));
	return {
		reasonCodes: INTEGRATION_REASON_ORDER.filter((reason) => present.has(reason)),
		overlaps,
		conflicts,
	};
}
