import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
	assertDagTopologyIntegrity,
	createStrictAjv,
	DAG_ARTIFACTS_SCHEMA,
	DAG_GOLDEN_SUITE_SCHEMA,
	DAG_LIMITS,
	DagIntegrityError,
	GIT_TOPOLOGY_SLICE_SCHEMA,
	JOIN_BINDING_SCHEMA,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const root = new URL("../../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const clone = (value) => structuredClone(value);

const [artifactsSchema, goldenSchema, suite, digests] = await Promise.all([
	readJson("contracts/dag/v2/artifacts.schema.json"),
	readJson("contracts/dag/v2/golden-suite.schema.json"),
	readJson("fixtures/contracts/dag/v2/golden-suite.json"),
	readJson("fixtures/contracts/dag/v2/golden-digests.json"),
]);

const ajv = createStrictAjv();
ajv.addSchema(artifactsSchema);
const validateSuite = ajv.compile(goldenSchema);
const definition = (name) => ajv.getSchema(`${DAG_ARTIFACTS_SCHEMA}#/definitions/${name}`);

test("DAG v2 compiles and locks byte-stable linear and clean binary join cases", () => {
	assert.equal(artifactsSchema.$id, DAG_ARTIFACTS_SCHEMA);
	assert.equal(goldenSchema.$id, DAG_GOLDEN_SUITE_SCHEMA);
	assert.equal(validateSuite(suite), true, JSON.stringify(validateSuite.errors, null, 2));
	assert.equal(sha256Jcs(suite), digests.suite);
	for (const entry of suite.cases) {
		assert.equal(definition("GitTopologySlice")(entry.topology), true);
		assert.equal(sha256Jcs(entry.topology), digests.cases[entry.caseId]);
		assertDagTopologyIntegrity(entry.topology);
	}
});

test("DAG v2 exports additive topology and join identities with exact bounds", () => {
	assert.equal(GIT_TOPOLOGY_SLICE_SCHEMA, "graphrefly.stack.git-topology-slice.v2");
	assert.equal(JOIN_BINDING_SCHEMA, "graphrefly.stack.join-binding.v2");
	assert.deepEqual(DAG_LIMITS, { maxObjects: 64, maxWidth: 8, maxParents: 2 });
});

test("DAG v2 schema rejects authority widening and unsupported topology", () => {
	const topology = suite.cases[1].topology;
	const join = topology.joins[0];
	assert.equal(definition("GitTopologySlice")({ ...topology, mergeAuthority: true }), false);
	assert.equal(definition("GitTopologySlice")({ ...topology, queueManagement: true }), false);
	assert.equal(
		definition("GitTopologySlice")({
			...topology,
			limits: { ...topology.limits, maxObjects: 65 },
		}),
		false,
	);
	assert.equal(
		definition("TopologyObject")({
			...topology.objects[2],
			parents: [...topology.objects[2].parents, topology.base],
		}),
		false,
	);
	assert.equal(
		definition("TopologyObject")({ ...topology.objects[2], workUnitId: "MERGE" }),
		false,
	);
	assert.equal(definition("TopologyObject")({ ...topology.objects[0], workUnitId: null }), false);
	assert.equal(
		definition("TopologyObject")({
			...topology.objects[0],
			kind: "transport",
			workUnitId: null,
		}),
		true,
	);
	assert.equal(definition("JoinBinding")({ ...join, workUnitId: "MERGE" }), false);
});

test("DAG integrity rejects manual resolution, false parents, ordering, and unbound joins", () => {
	const topology = suite.cases[1].topology;
	const manualResolution = clone(topology);
	manualResolution.joins[0].merge.observedTree.value = "6".repeat(40);
	assert.throws(() => assertDagTopologyIntegrity(manualResolution), DagIntegrityError);

	const wrongDeltaOrder = clone(topology);
	wrongDeltaOrder.joins[0].parentDeltas.reverse();
	assert.throws(() => assertDagTopologyIntegrity(wrongDeltaOrder), DagIntegrityError);

	const unordered = clone(topology);
	[unordered.objects[0], unordered.objects[1]] = [unordered.objects[1], unordered.objects[0]];
	assert.throws(() => assertDagTopologyIntegrity(unordered), DagIntegrityError);

	const unbound = clone(topology);
	unbound.joins = [];
	assert.throws(() => assertDagTopologyIntegrity(unbound), DagIntegrityError);

	const falseMergeBase = clone(topology);
	falseMergeBase.joins[0].mergeBase = falseMergeBase.objects[0].oid;
	assert.throws(() => assertDagTopologyIntegrity(falseMergeBase), DagIntegrityError);

	const nonMaximalMergeBase = clone(topology);
	const leftChild = clone(nonMaximalMergeBase.objects[0]);
	leftChild.oid = { algorithm: "sha1", value: "3a".repeat(20) };
	leftChild.parents = [nonMaximalMergeBase.objects[0].oid];
	leftChild.layer = 2;
	leftChild.workUnitId = "LEFT_CHILD";
	leftChild.blueprintHash = { algorithm: "sha256", value: "3a".repeat(32) };
	nonMaximalMergeBase.objects[1].parents = [nonMaximalMergeBase.objects[0].oid];
	nonMaximalMergeBase.objects[1].layer = 2;
	nonMaximalMergeBase.objects[2].parents[0] = leftChild.oid;
	nonMaximalMergeBase.objects[2].layer = 3;
	nonMaximalMergeBase.objects.splice(2, 0, leftChild);
	nonMaximalMergeBase.joins[0].parents[0] = leftChild.oid;
	nonMaximalMergeBase.joins[0].parents[1] = nonMaximalMergeBase.objects[1].oid;
	nonMaximalMergeBase.joins[0].layer = 3;
	nonMaximalMergeBase.joins[0].parentDeltas[0].from = leftChild.oid;
	nonMaximalMergeBase.joins[0].parentDeltas[1].from = nonMaximalMergeBase.objects[1].oid;
	assert.throws(() => assertDagTopologyIntegrity(nonMaximalMergeBase), DagIntegrityError);
});

test("DAG integrity rejects disconnected objects and width above eight", () => {
	const linear = suite.cases[0].topology;
	const disconnected = clone(linear);
	disconnected.objects.push({
		...clone(disconnected.objects[0]),
		oid: { algorithm: "sha1", value: "3".repeat(40) },
		workUnitId: "U2",
		blueprintHash: { algorithm: "sha256", value: "3".repeat(64) },
	});
	assert.throws(() => assertDagTopologyIntegrity(disconnected), DagIntegrityError);

	const gitOid = (value) => ({ algorithm: "sha1", value: value.toString(16).padStart(40, "0") });
	const hash = (value) => ({ algorithm: "sha256", value: value.toString(16).padStart(64, "0") });
	const tooWide = clone(linear);
	const chains = [];
	const branches = [];
	for (let index = 0; index < 9; index += 1) {
		const parent = index === 0 ? tooWide.base : chains[index - 1].oid;
		chains.push({
			oid: gitOid(10 + index),
			parents: [parent],
			layer: index + 1,
			kind: "implementation",
			workUnitId: `CHAIN${index + 1}`,
			blueprintHash: hash(10 + index),
		});
		branches.push({
			oid: gitOid(30 + index),
			parents: [parent],
			layer: index + 1,
			kind: "implementation",
			workUnitId: `BRANCH${index + 1}`,
			blueprintHash: hash(30 + index),
		});
	}
	const joins = [];
	const joinObjects = [];
	let current = chains.at(-1);
	for (let index = 8; index >= 0; index -= 1) {
		const branch = branches[index];
		const joinOid = gitOid(50 + (8 - index));
		const layer = current.layer + 1;
		const joinBlueprintHash = hash(50 + (8 - index));
		joinObjects.push({
			oid: joinOid,
			parents: [current.oid, branch.oid],
			layer,
			kind: "join",
			workUnitId: null,
			blueprintHash: joinBlueprintHash,
		});
		joins.push({
			schema: "graphrefly.stack.join-binding.v2",
			oid: joinOid,
			parents: [current.oid, branch.oid],
			layer,
			mergeBase: index === 0 ? tooWide.base : chains[index - 1].oid,
			merge: {
				algorithm: "git-ort-three-way",
				revision: "v1",
				candidateTree: gitOid(100 + index),
				observedTree: gitOid(100 + index),
			},
			parentDeltas: [
				{ from: current.oid, to: joinOid, deltaDigest: hash(100 + index) },
				{ from: branch.oid, to: joinOid, deltaDigest: hash(120 + index) },
			],
			joinBlueprintHash,
		});
		current = joinObjects.at(-1);
	}
	tooWide.objects = [...chains, ...branches, ...joinObjects].sort(
		(left, right) => left.layer - right.layer || left.oid.value.localeCompare(right.oid.value),
	);
	tooWide.joins = joins;
	tooWide.head = current.oid;
	assert.equal(
		Math.max(
			...Object.values(Object.groupBy(tooWide.objects, (entry) => entry.layer)).map(
				(entries) => entries.length,
			),
		),
		2,
		"the adversarial DAG must hide its nine-wide antichain across declared layers",
	);
	assert.throws(() => assertDagTopologyIntegrity(tooWide), DagIntegrityError);
});
