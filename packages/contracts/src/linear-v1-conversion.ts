import { assertDagTopologyIntegrity } from "./dag-integrity.js";
import { canonicalize, sha256Jcs } from "./jcs.js";

type JsonObject = Record<string, unknown>;

export class LinearV1ConversionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LinearV1ConversionError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LinearV1ConversionError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
	if (!Array.isArray(value)) throw new LinearV1ConversionError(`${label} must be an array`);
	return value.map((entry) => object(entry, label));
}

function strings(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) throw new LinearV1ConversionError(`${label} must be an array`);
	return value.map((entry) => {
		if (typeof entry !== "string")
			throw new LinearV1ConversionError(`${label} must contain strings`);
		return entry;
	});
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string") throw new LinearV1ConversionError(`${label} must be a string`);
	return value;
}

function hash(value: unknown): { algorithm: "sha256"; value: string } {
	return { algorithm: "sha256", value: sha256Jcs(value) };
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

export function assertPlanQualifiedCommitIntegrity(value: unknown): void {
	const commit = object(value, "Plan-qualified commit");
	const planId = string(commit.planId, "Plan-qualified Plan ID");
	const workUnitId = string(commit.workUnitId, "Plan-qualified WorkUnit ID");
	object(commit.commit, "Plan-qualified Git commit");
	const ownership = object(commit.ownership, "Plan-qualified ownership");
	if (ownership.kind === "native") {
		const planTrailer = object(ownership.planTrailer, "Plan trailer");
		const workUnitTrailer = object(ownership.workUnitTrailer, "WorkUnit trailer");
		if (
			planTrailer.name !== "GraphReFly-Plan" ||
			planTrailer.value !== planId ||
			planTrailer.occurrences !== 1 ||
			workUnitTrailer.name !== "GraphReFly-Work-Unit" ||
			workUnitTrailer.value !== workUnitId ||
			workUnitTrailer.occurrences !== 1
		) {
			throw new LinearV1ConversionError("native Plan and WorkUnit trailers do not match identity");
		}
		return;
	}
	if (ownership.kind === "converted-v1") {
		object(ownership.sourceBindingDigest, "converted source binding digest");
		object(ownership.sourceGateInputDigest, "converted source GateInput digest");
		return;
	}
	throw new LinearV1ConversionError("Plan-qualified ownership kind is unsupported");
}

function indexUnique(values: JsonObject[], key: string, label: string): Map<string, JsonObject> {
	const result = new Map<string, JsonObject>();
	for (const value of values) {
		const id = string(value[key], `${label} ${key}`);
		if (result.has(id)) throw new LinearV1ConversionError(`${label} repeats ${id}`);
		result.set(id, value);
	}
	return result;
}

function canonicalWorkUnitOrder(units: JsonObject[]): string[] {
	const byId = indexUnique(units, "id", "Plan WorkUnits");
	const remaining = new Set(byId.keys());
	const order: string[] = [];
	while (remaining.size > 0) {
		const next = [...remaining]
			.filter((id) =>
				strings(byId.get(id)?.dependencies, `${id} dependencies`).every((dependency) => {
					if (!byId.has(dependency)) {
						throw new LinearV1ConversionError(`${id} depends on missing WorkUnit ${dependency}`);
					}
					return order.includes(dependency);
				}),
			)
			.sort()[0];
		if (next === undefined) throw new LinearV1ConversionError("Plan dependencies are cyclic");
		order.push(next);
		remaining.delete(next);
	}
	return order;
}

function assertSourcePass(
	input: JsonObject,
	result: JsonObject,
	sourceOrder: string[],
	checkIds: string[],
): void {
	if (!equal(result.inputDigest, hash(input))) {
		throw new LinearV1ConversionError("v1 GateResult does not bind the exact GateInput");
	}
	if (result.verdict !== "pass") {
		throw new LinearV1ConversionError("only a passing v1 GateResult may be converted");
	}
	const units = objects(result.units, "v1 GateResult units");
	if (
		units.length !== sourceOrder.length ||
		units.some(
			(unit, index) =>
				unit.workUnitId !== sourceOrder[index] ||
				unit.verdict !== "valid" ||
				strings(unit.reasonCodes, "v1 reason codes").length !== 0 ||
				strings(unit.invalidDependencies, "v1 invalid dependencies").length !== 0,
		)
	) {
		throw new LinearV1ConversionError("v1 GateResult units are not a canonical all-valid Plan");
	}
	if (!equal(result.checkIds, checkIds)) {
		throw new LinearV1ConversionError("v1 GateResult check IDs do not match GateInput");
	}
}

function deriveLinearV1Conversion(options: {
	topology: JsonObject;
	gateInput: JsonObject;
	gateResult: JsonObject;
}): JsonObject {
	assertDagTopologyIntegrity(options.topology);
	if (objects(options.topology.joins, "topology joins").length !== 0) {
		throw new LinearV1ConversionError("v1 conversion accepts only a merge-free topology");
	}
	const plan = object(options.gateInput.plan, "accepted Plan");
	const policy = object(options.gateInput.policy, "repository policy");
	const planId = string(plan.planId, "Plan ID");
	const units = objects(plan.workUnits, "Plan WorkUnits");
	const unitById = indexUnique(units, "id", "Plan WorkUnits");
	const order = canonicalWorkUnitOrder(units);

	const sourceBindings = objects(options.gateInput.bindings, "v1 bindings");
	const sourceRecords = objects(options.gateInput.records, "v1 records");
	const sourceChecks = objects(options.gateInput.checks, "v1 checks");
	assertSourcePass(
		options.gateInput,
		options.gateResult,
		units.map((unit) => string(unit.id, "source WorkUnit ID")),
		sourceChecks.map((check) => string(check.checkId, "source check ID")),
	);
	const bindingById = indexUnique(sourceBindings, "workUnitId", "v1 bindings");
	const recordById = indexUnique(sourceRecords, "workUnitId", "v1 records");
	const checkById = indexUnique(sourceChecks, "checkId", "v1 checks");
	if (bindingById.size !== order.length || recordById.size !== order.length) {
		throw new LinearV1ConversionError("v1 bindings and records must exactly cover the Plan");
	}

	const topologyObjects = objects(options.topology.objects, "topology objects");
	const implementationById = new Map<string, JsonObject>();
	for (const entry of topologyObjects) {
		if (entry.kind !== "implementation") continue;
		const id = string(entry.workUnitId, "topology WorkUnit ID");
		if (implementationById.has(id)) {
			throw new LinearV1ConversionError(`topology repeats WorkUnit ${id}`);
		}
		implementationById.set(id, entry);
	}
	if (
		implementationById.size !== order.length ||
		order.some((workUnitId) => !implementationById.has(workUnitId))
	) {
		throw new LinearV1ConversionError("topology implementations must exactly cover the v1 Plan");
	}

	const policyDigest = hash(policy);
	const planPolicy = object(plan.policy, "Plan policy binding");
	if (
		planPolicy.policyId !== policy.policyId ||
		planPolicy.revision !== policy.revision ||
		!equal(planPolicy.digest, policyDigest)
	) {
		throw new LinearV1ConversionError("accepted Plan does not bind the exact repository policy");
	}
	const gateInputDigest = hash(options.gateInput);
	const targetBindings: JsonObject[] = [];
	const qualifiedCommits: JsonObject[] = [];
	for (const workUnitId of order) {
		const source = bindingById.get(workUnitId) as JsonObject;
		const record = recordById.get(workUnitId) as JsonObject;
		const topology = implementationById.get(workUnitId) as JsonObject;
		const trailer = object(source.trailer, `${workUnitId} WorkUnit trailer`);
		const unit = unitById.get(workUnitId) as JsonObject;
		if (
			source.planId !== planId ||
			record.planId !== planId ||
			!equal(source.commit, topology.oid) ||
			!equal(source.parentCommit, objects(topology.parents, "implementation parents")[0]) ||
			!equal(record.bindingDigest, hash(source)) ||
			!equal(record.policyDigest, policyDigest) ||
			!equal(record.blueprintHash, topology.blueprintHash) ||
			trailer.name !== "GraphReFly-Work-Unit" ||
			trailer.value !== workUnitId ||
			trailer.occurrences !== 1 ||
			!equal(record.sourceScopeDigest, hash(unit.allowedSourceScopes)) ||
			!equal(record.requiredChecks, unit.requiredChecks)
		) {
			throw new LinearV1ConversionError(`${workUnitId} v1 evidence does not match topology`);
		}
		const sourceResult = objects(options.gateResult.units, "v1 GateResult units").find(
			(entry) => entry.workUnitId === workUnitId,
		);
		if (sourceResult?.recordId !== record.recordId) {
			throw new LinearV1ConversionError(`${workUnitId} v1 GateResult does not bind its record`);
		}
		const targetBinding: JsonObject = {
			schema: "graphrefly.stack.work-unit-binding.v2",
			planId,
			workUnitId,
			commit: source.commit,
			parentCommit: source.parentCommit,
			trailer: source.trailer,
			stablePatchId: source.stablePatchId,
			diffDigest: source.diffDigest,
			changedPaths: [...strings(source.changedPaths, `${workUnitId} changed paths`)].sort(),
			blueprintHash: record.blueprintHash,
			rebindFrom: null,
		};
		targetBindings.push(targetBinding);
		qualifiedCommits.push({
			schema: "graphrefly.stack.plan-qualified-commit.v1",
			planId,
			workUnitId,
			commit: source.commit,
			ownership: {
				kind: "converted-v1",
				sourceBindingDigest: hash(source),
				sourceGateInputDigest: gateInputDigest,
			},
		});
		assertPlanQualifiedCommitIntegrity(qualifiedCommits.at(-1));
	}

	const dependencyGraph: JsonObject = {
		schema: "graphrefly.stack.semantic-dependency-graph.v2",
		planId,
		topologyDigest: hash(options.topology),
		workUnits: order.map((workUnitId) => ({
			workUnitId,
			dependencies: [
				...strings(unitById.get(workUnitId)?.dependencies, `${workUnitId} dependencies`),
			].sort(),
		})),
	};
	const targetBindingById = new Map(
		targetBindings.map((binding) => [binding.workUnitId as string, binding] as const),
	);
	const targetRecords: JsonObject[] = [];
	const targetRecordById = new Map<string, JsonObject>();
	for (const workUnitId of order) {
		const unit = unitById.get(workUnitId) as JsonObject;
		const source = recordById.get(workUnitId) as JsonObject;
		const binding = targetBindingById.get(workUnitId) as JsonObject;
		const claims = objects(unit.claims, `${workUnitId} claims`);
		const sourceWitnessById = indexUnique(
			objects(source.claimWitnesses, `${workUnitId} claim witnesses`),
			"claimId",
			`${workUnitId} claim witnesses`,
		);
		const claimWitnesses = [...claims]
			.sort((left, right) =>
				string(left.id, "claim ID").localeCompare(string(right.id, "claim ID")),
			)
			.map((claim) => {
				const claimId = string(claim.id, "claim ID");
				const witness = sourceWitnessById.get(claimId);
				if (
					witness === undefined ||
					witness.status !== "satisfied" ||
					!equal(witness.predicateDigest, hash(claim.predicate))
				) {
					throw new LinearV1ConversionError(`${workUnitId} claim ${claimId} is not verified`);
				}
				return structuredClone(witness);
			});
		const requiredChecks = [
			...strings(unit.requiredChecks, `${workUnitId} required checks`),
		].sort();
		const checkDigests = requiredChecks.map((checkId) => {
			const check = checkById.get(checkId);
			if (check === undefined || check.exitCode !== 0) {
				throw new LinearV1ConversionError(`${workUnitId} check ${checkId} is not passing`);
			}
			return { workUnitId, checkId, digest: hash(check) };
		});
		const dependencies = strings(unit.dependencies, `${workUnitId} dependencies`);
		const recordBody: JsonObject = {
			schema: "graphrefly.stack.semantic-record.v2",
			planId,
			workUnitId,
			bindingDigest: hash(binding),
			directDependencyRecordIds: dependencies
				.map((dependency) =>
					string(targetRecordById.get(dependency)?.recordId, `${dependency} target record ID`),
				)
				.sort(),
			policyDigest,
			blueprintHash: source.blueprintHash,
			sourceScopeDigest: source.sourceScopeDigest,
			claimsDigest: hash(unit.claims),
			checksDigest: hash(checkDigests),
			claimWitnesses,
			requiredChecks,
			rebindFrom: string(source.recordId, `${workUnitId} source record ID`),
		};
		const target = {
			...recordBody,
			recordId: `record-${sha256Jcs(recordBody).slice(0, 24)}`,
		};
		targetRecords.push(target);
		targetRecordById.set(workUnitId, target);
	}

	const namedDigests = (values: JsonObject[]) =>
		values.map((value) => ({
			workUnitId: value.workUnitId,
			digest: hash(value),
		}));
	const conversion: JsonObject = {
		schema: "graphrefly.stack.linear-v1-conversion.v1",
		converter: { name: "graphrefly-stack", version: "v1" },
		source: {
			gateInputDigest,
			gateResultDigest: hash(options.gateResult),
			planDigest: hash(plan),
			policyDigest,
			bindingDigests: namedDigests(order.map((id) => bindingById.get(id) as JsonObject)),
			recordDigests: namedDigests(order.map((id) => recordById.get(id) as JsonObject)),
		},
		topologyDigest: hash(options.topology),
		target: {
			dependencyGraphDigest: hash(dependencyGraph),
			bindingDigests: namedDigests(targetBindings),
			recordDigests: namedDigests(targetRecords),
		},
	};
	return {
		schema: "graphrefly.stack.linear-v1-conversion-bundle.v1",
		sourceGateInput: structuredClone(options.gateInput),
		sourceGateResult: structuredClone(options.gateResult),
		topology: structuredClone(options.topology),
		dependencyGraph,
		bindings: targetBindings,
		records: targetRecords,
		qualifiedCommits,
		conversion,
	};
}

export function convertLinearV1ToV2(options: {
	topology: JsonObject;
	gateInput: JsonObject;
	gateResult: JsonObject;
}): JsonObject {
	return deriveLinearV1Conversion(options);
}

export function assertLinearV1ConversionIntegrity(value: unknown): void {
	const bundle = object(value, "linear v1 conversion bundle");
	const expected = deriveLinearV1Conversion({
		topology: object(bundle.topology, "conversion topology"),
		gateInput: object(bundle.sourceGateInput, "source GateInput"),
		gateResult: object(bundle.sourceGateResult, "source GateResult"),
	});
	if (!equal(bundle, expected)) {
		throw new LinearV1ConversionError("linear v1 conversion bundle is not independently derived");
	}
}
