import { readFile } from "node:fs/promises";
import {
	assertDagTopologyIntegrity,
	createStrictAjv,
	DAG_ARTIFACTS_SCHEMA,
	DAG_LIMITS,
	GIT_TOPOLOGY_SLICE_SCHEMA,
	JOIN_BINDING_SCHEMA,
	sha256Jcs,
} from "@graphrefly-stack/contracts";

import { type DiscoveredGitDag, discoverGitDag } from "./dag-discovery.js";
import {
	createRepositoryBlueprintSnapshot,
	diffRepositoryBlueprintSnapshots,
} from "./repository-review.js";
import { runtimeAssetPath } from "./runtime-paths.js";

type GitOid = { algorithm: "sha1" | "sha256"; value: string };
type Hash = { algorithm: "sha256"; value: string };
type Blueprint = Record<string, unknown>;

export type DagParentDeltaEvidence = {
	from: GitOid;
	to: GitOid;
	delta: Record<string, unknown>;
	deltaDigest: Hash;
};

export type DagGraphEvidence = {
	topology: Record<string, unknown>;
	blueprints: Array<{ revision: GitOid; blueprint: Blueprint; blueprintHash: Hash }>;
	parentDeltas: DagParentDeltaEvidence[];
};

export class DagEvidenceError extends Error {
	constructor(
		readonly code:
			| "BLUEPRINT_EVIDENCE_INVALID"
			| "BLUEPRINT_VERSION_DRIFT"
			| "DELTA_EVIDENCE_INVALID"
			| "CONTRACT_INVALID"
			| "REVISION_MOVED",
		message: string,
	) {
		super(message);
		this.name = "DagEvidenceError";
	}
}

const artifactsSchemaPath = runtimeAssetPath("contracts/dag/v2/artifacts.schema.json");

async function topologyValidator() {
	const schema = JSON.parse(await readFile(artifactsSchemaPath, "utf8"));
	const ajv = createStrictAjv();
	ajv.addSchema(schema);
	const validate = ajv.getSchema(`${DAG_ARTIFACTS_SCHEMA}#/definitions/GitTopologySlice`);
	if (validate === undefined) {
		throw new DagEvidenceError("CONTRACT_INVALID", "DAG topology schema is unavailable");
	}
	return validate;
}

function discoveryDigest(value: DiscoveredGitDag): string {
	return sha256Jcs({
		base: value.base,
		head: value.head,
		objects: value.objects,
		joins: value.joins,
	});
}

export async function createDagGraphEvidence(options: {
	repository: string;
	base: string;
	head: string;
	repositoryIdentity: { provider: string; owner: string; name: string };
}): Promise<DagGraphEvidence> {
	const discovered = await discoverGitDag(options);
	const revisions = [discovered.base, ...discovered.objects.map((entry) => entry.oid)];
	const blueprints: DagGraphEvidence["blueprints"] = [];
	let graphreflyVersion: string | undefined;
	for (const revision of revisions) {
		let snapshot: Awaited<ReturnType<typeof createRepositoryBlueprintSnapshot>>;
		try {
			snapshot = await createRepositoryBlueprintSnapshot({
				repository: discovered.repository,
				revision: revision.value,
				requireEntrypointAtRevision: true,
			});
		} catch (error) {
			throw new DagEvidenceError(
				"BLUEPRINT_EVIDENCE_INVALID",
				error instanceof Error ? error.message : `Blueprint evidence failed for ${revision.value}`,
			);
		}
		if (graphreflyVersion !== undefined && snapshot.graphreflyVersion !== graphreflyVersion) {
			throw new DagEvidenceError(
				"BLUEPRINT_VERSION_DRIFT",
				`GraphReFly runtime changed at ${revision.value}`,
			);
		}
		graphreflyVersion = snapshot.graphreflyVersion;
		blueprints.push({
			revision,
			blueprint: snapshot.blueprint,
			blueprintHash: snapshot.blueprintHash,
		});
	}
	if (graphreflyVersion === undefined) {
		throw new DagEvidenceError("BLUEPRINT_EVIDENCE_INVALID", "DAG Blueprint evidence is empty");
	}
	const blueprintByRevision = new Map(
		blueprints.map((entry) => [entry.revision.value, entry] as const),
	);
	const parentDeltas: DagParentDeltaEvidence[] = [];
	for (const object of discovered.objects) {
		const next = blueprintByRevision.get(object.oid.value);
		if (next === undefined) {
			throw new DagEvidenceError("BLUEPRINT_EVIDENCE_INVALID", object.oid.value);
		}
		for (const parent of object.parents) {
			const previous = blueprintByRevision.get(parent.value);
			if (previous === undefined) {
				throw new DagEvidenceError("BLUEPRINT_EVIDENCE_INVALID", parent.value);
			}
			try {
				const evidence = await diffRepositoryBlueprintSnapshots({
					repository: discovered.repository,
					previous: previous.blueprint,
					next: next.blueprint,
				});
				parentDeltas.push({
					from: parent,
					to: object.oid,
					delta: evidence.delta,
					deltaDigest: evidence.digest,
				});
			} catch (error) {
				throw new DagEvidenceError(
					"DELTA_EVIDENCE_INVALID",
					error instanceof Error ? error.message : `${parent.value}>${object.oid.value}`,
				);
			}
		}
	}
	const objects = discovered.objects.map((entry) => {
		const blueprint = blueprintByRevision.get(entry.oid.value);
		if (blueprint === undefined) {
			throw new DagEvidenceError("BLUEPRINT_EVIDENCE_INVALID", entry.oid.value);
		}
		return { ...entry, blueprintHash: blueprint.blueprintHash };
	});
	const joins = discovered.joins.map((entry) => {
		const blueprint = blueprintByRevision.get(entry.oid.value);
		if (blueprint === undefined) {
			throw new DagEvidenceError("BLUEPRINT_EVIDENCE_INVALID", entry.oid.value);
		}
		return {
			schema: JOIN_BINDING_SCHEMA,
			...entry,
			parentDeltas: entry.parents.map((parent) => {
				const evidence = parentDeltas.find(
					(delta) => delta.from.value === parent.value && delta.to.value === entry.oid.value,
				);
				if (evidence === undefined) {
					throw new DagEvidenceError("DELTA_EVIDENCE_INVALID", entry.oid.value);
				}
				return { from: parent, to: entry.oid, deltaDigest: evidence.deltaDigest };
			}),
			joinBlueprintHash: blueprint.blueprintHash,
		};
	});
	const baseBlueprint = blueprintByRevision.get(discovered.base.value);
	if (baseBlueprint === undefined) {
		throw new DagEvidenceError("BLUEPRINT_EVIDENCE_INVALID", discovered.base.value);
	}
	const topology = {
		schema: GIT_TOPOLOGY_SLICE_SCHEMA,
		repository: options.repositoryIdentity,
		provider: {
			kind: "graphrefly",
			runtimeVersion: graphreflyVersion,
			blueprintVersion: "v2",
		},
		base: discovered.base,
		head: discovered.head,
		baseBlueprintHash: baseBlueprint.blueprintHash,
		limits: DAG_LIMITS,
		objects,
		joins,
	};
	const validate = await topologyValidator();
	if (!validate(topology)) {
		throw new DagEvidenceError(
			"CONTRACT_INVALID",
			`DAG topology failed validation: ${JSON.stringify(validate.errors)}`,
		);
	}
	try {
		assertDagTopologyIntegrity(topology);
	} catch (error) {
		throw new DagEvidenceError(
			"CONTRACT_INVALID",
			error instanceof Error ? error.message : "DAG topology integrity failed",
		);
	}
	let observed: DiscoveredGitDag;
	try {
		observed = await discoverGitDag(options);
	} catch {
		throw new DagEvidenceError("REVISION_MOVED", "Base or head changed during DAG evidence");
	}
	if (discoveryDigest(observed) !== discoveryDigest(discovered)) {
		throw new DagEvidenceError("REVISION_MOVED", "Base or head changed during DAG evidence");
	}
	return { topology, blueprints, parentDeltas };
}
