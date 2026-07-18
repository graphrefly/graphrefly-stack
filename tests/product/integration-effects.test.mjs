import assert from "node:assert/strict";
import test from "node:test";

import { evaluateIntegrationEffects } from "../../packages/core/dist/index.js";

const delta = (events) => ({
	version: "graphrefly.blueprint-delta.v1",
	fromBlueprintVersion: "graphrefly.blueprint.v2",
	toBlueprintVersion: "graphrefly.blueprint.v2",
	events,
});
const changed = (before, after) => ({
	type: "node-changed",
	topologyPath: [],
	before,
	after,
});

test("shared node with independent field effects is overlap, not conflict", () => {
	const before = { id: "session", kind: "state", name: "old", meta: { owner: "platform" } };
	const result = evaluateIntegrationEffects({
		targetDelta: delta([changed(before, { ...before, name: "target-name" })]),
		headDelta: delta([changed(before, { ...before, meta: { ...before.meta, owner: "security" } })]),
	});
	assert.deepEqual(result.reasonCodes, []);
	assert.deepEqual(result.conflicts, []);
	assert.deepEqual(result.overlaps, [
		{ kind: "node", nodeId: "session", field: "name" },
		{ kind: "metadata-field", ownerKind: "node", ownerId: "session", field: "owner" },
	]);
});

test("same node field with different final values is an exact conflict", () => {
	const before = { id: "session", kind: "state", name: "old" };
	const result = evaluateIntegrationEffects({
		targetDelta: delta([changed(before, { ...before, name: "target" })]),
		headDelta: delta([changed(before, { ...before, name: "head" })]),
	});
	assert.deepEqual(result.reasonCodes, ["NODE_INCOMPATIBLE_CHANGE"]);
	assert.deepEqual(result.conflicts, [
		{
			reasonCode: "NODE_INCOMPATIBLE_CHANGE",
			witness: { kind: "node", nodeId: "session", field: "name" },
		},
	]);
});

test("metadata conflict has a metadata-field witness and stable reason", () => {
	const before = { id: "session", kind: "state", meta: { owner: "platform" } };
	const result = evaluateIntegrationEffects({
		targetDelta: delta([changed(before, { ...before, meta: { ...before.meta, owner: "target" } })]),
		headDelta: delta([changed(before, { ...before, meta: { ...before.meta, owner: "head" } })]),
	});
	assert.deepEqual(result.reasonCodes, ["METADATA_INCOMPATIBLE_CHANGE"]);
	assert.deepEqual(result.conflicts[0], {
		reasonCode: "METADATA_INCOMPATIBLE_CHANGE",
		witness: {
			kind: "metadata-field",
			ownerKind: "node",
			ownerId: "session",
			field: "owner",
		},
	});
});

test("node deletion conflicts with another branch edge use", () => {
	const node = { id: "session", kind: "state" };
	const result = evaluateIntegrationEffects({
		targetDelta: delta([{ type: "node-removed", topologyPath: [], node }]),
		headDelta: delta([
			{
				type: "edge-added",
				topologyPath: [],
				edge: { from: "session", to: "audit" },
			},
		]),
	});
	assert.deepEqual(result.reasonCodes, ["NODE_DELETE_CHANGE"]);
	assert.deepEqual(result.conflicts, [
		{
			reasonCode: "NODE_DELETE_CHANGE",
			witness: { kind: "node", nodeId: "session", field: "*" },
		},
	]);
});

test("edge and subgraph opposite effects produce distinct ordered witnesses", () => {
	const edge = { from: "source", to: "sink" };
	const topology = { nodes: [], edges: [], subgraphs: [] };
	const result = evaluateIntegrationEffects({
		targetDelta: delta([
			{ type: "subgraph-added", topologyPath: ["audit"], topology },
			{ type: "edge-added", topologyPath: [], edge },
		]),
		headDelta: delta([
			{ type: "subgraph-removed", topologyPath: ["audit"], topology },
			{ type: "edge-removed", topologyPath: [], edge },
		]),
	});
	assert.deepEqual(result.reasonCodes, [
		"EDGE_INCOMPATIBLE_CHANGE",
		"SUBGRAPH_INCOMPATIBLE_CHANGE",
	]);
	assert.equal(result.overlaps.length, 2);
	assert.equal(result.conflicts.length, 2);
});
