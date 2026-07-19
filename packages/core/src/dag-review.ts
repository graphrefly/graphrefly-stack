import { DAG_REVIEW_SCHEMA, sha256Jcs } from "@graphrefly-stack/contracts";

type JsonObject = Record<string, unknown>;
type Hash = { algorithm: "sha256"; value: string };

function oidKey(value: unknown): string {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Git OID must be an object");
	}
	const oid = value as JsonObject;
	return `${String(oid.algorithm)}:${String(oid.value)}`;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value.map((entry) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${label} must contain objects`);
		}
		return entry as JsonObject;
	});
}

function hash(value: unknown): Hash {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

export function createDagReviewProjection(options: {
	topology: JsonObject;
	dependencyGraph: JsonObject;
	gateResult: JsonObject;
}): JsonObject {
	const topologyObjects = objects(options.topology.objects, "topology objects");
	const units = objects(options.gateResult.units, "gate units");
	const joins = objects(options.gateResult.joins, "gate joins");
	const unitById = new Map(units.map((entry) => [entry.workUnitId as string, entry] as const));
	const joinByOid = new Map(joins.map((entry) => [oidKey(entry.oid), entry] as const));
	const minimalAffectedCut = Array.isArray(options.gateResult.minimalAffectedCut)
		? options.gateResult.minimalAffectedCut
		: [];
	const firstCut = minimalAffectedCut[0] as string | undefined;
	const cutObject = topologyObjects.find(
		(entry) => entry.kind === "implementation" && entry.workUnitId === firstCut,
	);
	const lastJoin = [...topologyObjects].reverse().find((entry) => entry.kind === "join");
	const lastUnit = [...topologyObjects].reverse().find((entry) => entry.kind === "implementation");
	const selectedObject = cutObject ?? (firstCut === undefined ? (lastJoin ?? lastUnit) : undefined);
	if (selectedObject === undefined && firstCut === undefined) {
		throw new Error("DAG review has no selectable evidence");
	}
	const selectedEvidence =
		selectedObject === undefined
			? { kind: "structural-unit", workUnitId: firstCut }
			: selectedObject.kind === "join"
				? {
						kind: "join",
						join: selectedObject.oid,
						parent: (selectedObject.parents as unknown[])[0],
						parentIndex: 0,
					}
				: {
						kind: "work-unit",
						workUnitId: selectedObject.workUnitId,
						commit: selectedObject.oid,
						parent: (selectedObject.parents as unknown[])[0],
					};
	return {
		schema: DAG_REVIEW_SCHEMA,
		gateResultDigest: hash(options.gateResult),
		topologyDigest: hash(options.topology),
		dependencyGraphDigest: hash(options.dependencyGraph),
		summary: { verdict: options.gateResult.verdict, minimalAffectedCut },
		gitLanes: topologyObjects.map((entry) => ({
			oid: entry.oid,
			layer: entry.layer,
			kind: entry.kind,
			verdict:
				entry.kind === "implementation"
					? unitById.get(entry.workUnitId as string)?.verdict
					: entry.kind === "join"
						? joinByOid.get(oidKey(entry.oid))?.verdict
						: "not-applicable",
		})),
		gitEdges: topologyObjects.flatMap((entry) =>
			(entry.parents as unknown[]).map((parent, parentIndex) => ({
				from: parent,
				to: entry.oid,
				parentIndex,
			})),
		),
		semanticEdges: objects(options.dependencyGraph.workUnits, "dependency WorkUnits").flatMap(
			(entry) =>
				(entry.dependencies as string[]).map((dependency) => ({
					fromWorkUnitId: dependency,
					toWorkUnitId: entry.workUnitId,
				})),
		),
		selectedEvidence,
	};
}
