import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
	diffGraphBlueprints,
	GRAPH_BLUEPRINT_VERSION,
	GRAPH_BLUEPRINT_VERSION_V1,
	graph,
	parseGraphBlueprint,
	verifyBlueprintHash,
	withBlueprintHash,
} from "@graphrefly/ts/graph";
import { blueprintToMermaid } from "@graphrefly/ts/render";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function runtimeBlueprint({
	includeDerived = false,
	includeExtra = false,
	sourceRole = "input",
} = {}) {
	const root = graph({ name: "stack-compatibility" });
	const worker = graph({ name: "worker graph" });
	const source = worker.state(1, { name: "source", meta: { role: sourceRole } });
	if (includeDerived) worker.derived([source], (value) => value + 1, { name: "derived" });
	root.mount(worker, { at: "worker" });
	if (includeExtra) {
		const audit = graph({ name: "audit graph" });
		audit.state("ready", { name: "status" });
		root.mount(audit, { at: "audit" });
	}
	return root.blueprint({
		diagnostics: true,
		provenance: { source: "graphrefly-stack PRODUCT-0 compatibility fixture" },
	});
}

test("published GraphReFly Blueprint v2 surface preserves identity, evidence, rendering, and delta", () => {
	assert.equal(GRAPH_BLUEPRINT_VERSION, "graphrefly.blueprint.v2");
	assert.equal(GRAPH_BLUEPRINT_VERSION_V1, "graphrefly.blueprint.v1");

	const before = withBlueprintHash(runtimeBlueprint(), {
		algorithm: "sha256",
		hash: sha256,
	});
	const after = withBlueprintHash(
		runtimeBlueprint({ includeDerived: true, includeExtra: true, sourceRole: "validated-input" }),
		{
			algorithm: "sha256",
			hash: sha256,
		},
	);
	const parsed = parseGraphBlueprint(JSON.parse(JSON.stringify(after)));

	assert.equal(parsed.version, "graphrefly.blueprint.v2");
	assert.equal(
		parsed.topology.subgraphs?.find((subgraph) => subgraph.mountId === "worker")?.mountId,
		"worker",
	);
	assert.equal(parsed.diagnostics?.ok, true);
	assert.equal(Object.isFrozen(parsed), true);
	assert.equal(Object.isFrozen(parsed.topology), true);
	assert.equal(verifyBlueprintHash(parsed, { algorithm: "sha256", hash: sha256 }), true);

	const diagram = blueprintToMermaid(parsed, { direction: "LR" });
	assert.match(diagram, /^flowchart LR/m);
	assert.match(diagram, /subgraph .+\["worker graph"\]/);
	assert.match(diagram, /\["worker::source"\]/);
	assert.match(diagram, /\["worker::derived"\]/);

	const delta = diffGraphBlueprints(before, parsed);
	assert.equal(delta.version, "graphrefly.blueprint-delta.v1");
	assert.deepEqual(
		delta.events.map((event) => ({
			type: event.type,
			path: event.topologyPath,
			id: event.node?.id,
			from: event.edge?.from,
			to: event.edge?.to,
		})),
		[
			{
				type: "subgraph-added",
				path: ["audit"],
				id: undefined,
				from: undefined,
				to: undefined,
			},
			{
				type: "node-added",
				path: ["audit"],
				id: "audit::status",
				from: undefined,
				to: undefined,
			},
			{
				type: "node-added",
				path: ["worker"],
				id: "worker::derived",
				from: undefined,
				to: undefined,
			},
			{
				type: "node-changed",
				path: ["worker"],
				id: undefined,
				from: undefined,
				to: undefined,
			},
			{
				type: "edge-added",
				path: ["worker"],
				id: undefined,
				from: "worker::source",
				to: "worker::derived",
			},
		],
	);
});

test("published helpers fail closed on malformed identity, ambiguous evidence, and version transitions", () => {
	const current = runtimeBlueprint();
	const child = current.topology.subgraphs?.[0];
	assert.ok(child);

	assert.throws(
		() =>
			parseGraphBlueprint({
				...current,
				topology: { ...current.topology, subgraphs: [{ ...child, mountId: undefined }] },
			}),
		/mountId|JSON-encodable/,
	);
	assert.throws(
		() =>
			parseGraphBlueprint({
				...current,
				topology: { ...current.topology, subgraphs: [child, { ...child }] },
			}),
		/duplicate mountId/,
	);

	const legacyAmbiguous = parseGraphBlueprint({
		version: GRAPH_BLUEPRINT_VERSION_V1,
		topology: {
			nodes: [{ id: "root", factory: "state", deps: [] }],
			edges: [],
			subgraphs: [{ nodes: [{ id: "legacy", factory: "state", deps: [] }], edges: [] }],
		},
	});
	assert.throws(
		() => diffGraphBlueprints(legacyAmbiguous, legacyAmbiguous),
		/v1 subgraphs require non-empty unique names/,
	);
	assert.throws(() => diffGraphBlueprints(legacyAmbiguous, current), /versions must match/);

	const hashed = withBlueprintHash(current, { algorithm: "sha256", hash: sha256 });
	const tampered = parseGraphBlueprint({
		version: hashed.version,
		topology: {
			...hashed.topology,
			nodes: [{ id: "tampered", factory: "state", deps: [] }],
			edges: [],
		},
		provenance: hashed.provenance,
		hash: hashed.hash,
	});
	assert.equal(verifyBlueprintHash(tampered, { algorithm: "sha256", hash: sha256 }), false);

	const duplicateNodes = parseGraphBlueprint({
		version: GRAPH_BLUEPRINT_VERSION,
		topology: {
			nodes: [
				{ id: "same", factory: "state", deps: [] },
				{ id: "same", factory: "effect", deps: [] },
			],
			edges: [],
		},
	});
	assert.throws(() => blueprintToMermaid(duplicateNodes), /error diagnostics/);
	assert.throws(() => diffGraphBlueprints(duplicateNodes, duplicateNodes), /error diagnostics/);
});
