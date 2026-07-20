import {
	assertDagTopologyIntegrity,
	assertPlanQualifiedCommitIntegrity,
	canonicalize,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

export class MultiPlanProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MultiPlanProjectionError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MultiPlanProjectionError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new MultiPlanProjectionError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function oidKey(value: unknown): string {
	const oid = object(value, "Git OID");
	return canonicalize(oid);
}

export function projectMultiPlanTopologyV1(options: {
	topology: JsonObject;
	qualifiedCommits: JsonObject[];
	planId: string;
}): JsonObject {
	assertDagTopologyIntegrity(options.topology);
	const objectsByOid = new Map(
		objects(options.topology.objects, "topology objects").map((entry) => [
			oidKey(entry.oid),
			entry,
		]),
	);
	const qualifiedByOid = new Map<string, JsonObject>();
	for (const qualified of options.qualifiedCommits) {
		assertPlanQualifiedCommitIntegrity(qualified);
		const key = oidKey(qualified.commit);
		if (qualifiedByOid.has(key)) {
			throw new MultiPlanProjectionError("one Git commit has multiple Plan owners");
		}
		const entry = objectsByOid.get(key);
		if (
			entry === undefined ||
			entry.kind !== "implementation" ||
			entry.workUnitId !== qualified.workUnitId
		) {
			throw new MultiPlanProjectionError(
				"qualified commit does not match one implementation object",
			);
		}
		qualifiedByOid.set(key, qualified);
	}

	const projectionObjects = objects(options.topology.objects, "topology objects").map((entry) => {
		if (entry.kind !== "implementation") {
			if (qualifiedByOid.has(oidKey(entry.oid))) {
				throw new MultiPlanProjectionError("transport or join object has a Plan owner");
			}
			return structuredClone(entry);
		}
		const qualified = qualifiedByOid.get(oidKey(entry.oid));
		if (qualified === undefined) {
			throw new MultiPlanProjectionError("implementation object has no explicit Plan owner");
		}
		if (qualified.planId === options.planId) return structuredClone(entry);
		return {
			oid: structuredClone(entry.oid),
			parents: structuredClone(entry.parents),
			layer: entry.layer,
			kind: "transport",
			workUnitId: null,
			blueprintHash: structuredClone(entry.blueprintHash),
		};
	});
	if (!options.qualifiedCommits.some((entry) => entry.planId === options.planId)) {
		throw new MultiPlanProjectionError(`${options.planId} has no implementation in the topology`);
	}
	const projection = { ...structuredClone(options.topology), objects: projectionObjects };
	assertDagTopologyIntegrity(projection);
	return projection;
}
