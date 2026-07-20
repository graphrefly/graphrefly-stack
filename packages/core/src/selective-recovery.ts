import {
	assertDagTopologyIntegrity,
	assertPlanQualifiedCommitIntegrity,
	canonicalize,
} from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;

export class SelectiveRecoveryProjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SelectiveRecoveryProjectionError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SelectiveRecoveryProjectionError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value))
		throw new SelectiveRecoveryProjectionError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function oidKey(value: unknown): string {
	return canonicalize(object(value, "Git OID"));
}

function transport(entry: JsonObject): JsonObject {
	return {
		oid: structuredClone(entry.oid),
		parents: structuredClone(entry.parents),
		layer: entry.layer,
		kind: "transport",
		workUnitId: null,
		blueprintHash: structuredClone(entry.blueprintHash),
	};
}

export function projectSelectiveRecoveryTopologyV1(options: {
	topology: JsonObject;
	qualifiedCommits: JsonObject[];
	sourcePlanId: string;
	replacementPlanId: string;
	preservedUnits: string[];
	invalidUnits: string[];
}): JsonObject {
	assertDagTopologyIntegrity(options.topology);
	const preserved = new Set(options.preservedUnits);
	const invalid = new Set(options.invalidUnits);
	if (
		options.sourcePlanId === options.replacementPlanId ||
		new Set(options.preservedUnits).size !== options.preservedUnits.length ||
		new Set(options.invalidUnits).size !== options.invalidUnits.length ||
		options.invalidUnits.length === 0 ||
		options.preservedUnits.some((id) => invalid.has(id))
	) {
		throw new SelectiveRecoveryProjectionError("selective recovery partition is invalid");
	}

	const entries = objects(options.topology.objects, "topology objects");
	const entriesByOid = new Map(entries.map((entry) => [oidKey(entry.oid), entry] as const));
	const owners = new Map<string, JsonObject>();
	for (const qualified of options.qualifiedCommits) {
		assertPlanQualifiedCommitIntegrity(qualified);
		const key = oidKey(qualified.commit);
		if (owners.has(key)) {
			throw new SelectiveRecoveryProjectionError("one Git commit has multiple Plan owners");
		}
		const entry = entriesByOid.get(key);
		if (
			entry === undefined ||
			entry.kind !== "implementation" ||
			entry.workUnitId !== qualified.workUnitId
		) {
			throw new SelectiveRecoveryProjectionError("qualified commit does not match topology");
		}
		owners.set(key, qualified);
	}
	if (owners.size !== entries.filter((entry) => entry.kind === "implementation").length) {
		throw new SelectiveRecoveryProjectionError(
			"qualified commits do not exactly cover implementations",
		);
	}

	const selected = new Set<string>();
	const projectionObjects = entries.map((entry) => {
		if (entry.kind !== "implementation") {
			if (owners.has(oidKey(entry.oid))) {
				throw new SelectiveRecoveryProjectionError("non-implementation object has a Plan owner");
			}
			return structuredClone(entry);
		}
		const owner = owners.get(oidKey(entry.oid));
		if (owner === undefined) {
			throw new SelectiveRecoveryProjectionError("implementation object has no Plan owner");
		}
		const workUnitId = String(owner.workUnitId);
		const keep =
			(owner.planId === options.sourcePlanId && preserved.has(workUnitId)) ||
			(owner.planId === options.replacementPlanId && invalid.has(workUnitId));
		if (!keep) return transport(entry);
		if (selected.has(workUnitId)) {
			throw new SelectiveRecoveryProjectionError(
				`multiple selected implementations for ${workUnitId}`,
			);
		}
		selected.add(workUnitId);
		return structuredClone(entry);
	});
	const expected = new Set([...options.preservedUnits, ...options.invalidUnits]);
	if (selected.size !== expected.size || [...expected].some((id) => !selected.has(id))) {
		throw new SelectiveRecoveryProjectionError(
			"recovery implementations do not match the partition",
		);
	}
	const projection = { ...structuredClone(options.topology), objects: projectionObjects };
	assertDagTopologyIntegrity(projection);
	return projection;
}
