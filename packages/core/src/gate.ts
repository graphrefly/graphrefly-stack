import { sha256Jcs } from "@graphrefly-stack/contracts";

export const REASON_ORDER = [
	"SCHEMA_INVALID",
	"PROVIDER_CAPABILITY_UNSUPPORTED",
	"BLUEPRINT_DIAGNOSTICS_ERROR",
	"COMMIT_NOT_FOUND",
	"COMMIT_BINDING_MISMATCH",
	"PATCH_ID_AMBIGUOUS",
	"SOURCE_SCOPE_VIOLATION",
	"SEMANTIC_PARENT_STALE",
	"DEPENDENCY_INVALID",
	"BLUEPRINT_WITNESS_STALE",
	"POLICY_REVISION_STALE",
	"POLICY_SESSION_WRITE_REQUIRES_BROKER",
	"REQUIRED_CHECK_MISSING",
	"REQUIRED_CHECK_FAILED",
	"ARTIFACT_HASH_MISMATCH",
] as const;

export type ReasonCode = (typeof REASON_ORDER)[number];

export interface HashValue {
	algorithm: "sha256";
	value: string;
}

export interface OidValue {
	algorithm: "sha1" | "sha256";
	value: string;
}

export interface WorkUnitInput {
	id: string;
	dependencies: readonly string[];
	allowedSourceScopes: readonly string[];
	blueprintClaims: readonly { id: string; statement: string }[];
	requiredChecks: readonly string[];
}

export interface SemanticRecordInput {
	recordId: string;
	workUnitId: string;
	commit: OidValue;
	stablePatchId: string;
	diffDigest: HashValue;
	semanticParentRecordId: string | null;
	semanticParentCommit: OidValue | null;
	allowedSourceScopes: readonly string[];
	sourceScopeDigest: HashValue;
	blueprintClaims: readonly string[];
	dependencies: readonly string[];
	requiredChecks: readonly string[];
	blueprintHash: HashValue;
	policyRevision: string;
	providerId: string;
	providerVersion: string;
	contractVersion: string;
}

export interface GitFactInput {
	workUnitId: string;
	exists: boolean;
	commit: OidValue;
	parent: OidValue | null;
	stablePatchId: string;
	patchIdAmbiguous?: boolean;
	diffDigest: HashValue;
	changedPaths: readonly string[];
}

export interface CheckInput {
	checkId: string;
	exitCode: number;
}

export interface SnapshotInput {
	topologyHash: HashValue;
	policyRevision: string;
	provider: {
		providerId: string;
		providerVersion: string;
		capabilities: Record<string, boolean>;
	};
	blueprint: {
		diagnostics: { ok: boolean };
		topology: {
			nodes: readonly {
				id: string;
				factory: string;
				deps: readonly string[];
				meta?: Record<string, unknown>;
			}[];
		};
	};
}

export interface DeltaInput {
	claimImpacts: readonly {
		workUnitId: string;
		claimId: string;
		impact: "none" | "affected";
	}[];
}

export interface GateInput {
	contractVersion: "v1";
	schemaValid: boolean;
	workUnits: readonly WorkUnitInput[];
	records: readonly SemanticRecordInput[];
	gitFacts: readonly GitFactInput[];
	checks: readonly CheckInput[];
	snapshot: SnapshotInput;
	delta: DeltaInput;
	artifactIntegrity: boolean;
}

export interface GateUnitResult {
	workUnitId: string;
	verdict: "valid" | "invalid";
	reasonCodes: ReasonCode[];
	invalidDependencies: string[];
}

export interface GateResult {
	schema: "urn:graphrefly-stack:schema:gate-result:v1";
	gateVersion: "v1";
	inputDigest: HashValue;
	verdict: "pass" | "blocked" | "error";
	units: GateUnitResult[];
	checkIds: string[];
}

function sameOid(left: OidValue | null, right: OidValue | null): boolean {
	return left?.algorithm === right?.algorithm && left?.value === right?.value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasBrokerAncestor(snapshot: SnapshotInput, nodeId: string): boolean {
	const byId = new Map(snapshot.blueprint.topology.nodes.map((node) => [node.id, node]));
	const queue = [...(byId.get(nodeId)?.deps ?? [])];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const candidate = queue.shift();
		if (candidate === undefined || seen.has(candidate)) continue;
		seen.add(candidate);
		const node = byId.get(candidate);
		if (node?.factory === "sessionMutationBroker") return true;
		queue.push(...(node?.deps ?? []));
	}
	return false;
}

function violatesSessionWritePolicy(snapshot: SnapshotInput): boolean {
	return snapshot.blueprint.topology.nodes.some(
		(node) =>
			node.meta?.capability === "session-mutation" &&
			node.meta.mode === "online" &&
			!hasBrokerAncestor(snapshot, node.id),
	);
}

function sortReasons(reasons: Set<ReasonCode>): ReasonCode[] {
	return [...reasons].sort(
		(left, right) => REASON_ORDER.indexOf(left) - REASON_ORDER.indexOf(right),
	);
}

export function computeGate(input: GateInput): GateResult {
	const records = new Map(input.records.map((record) => [record.workUnitId, record]));
	const facts = new Map(input.gitFacts.map((fact) => [fact.workUnitId, fact]));
	const checks = new Map(input.checks.map((check) => [check.checkId, check]));
	const prior = new Map<string, GateUnitResult>();
	const providerSupported =
		input.snapshot.provider.providerId === "graphrefly" &&
		input.snapshot.provider.capabilities.commitSnapshot === true &&
		input.snapshot.provider.capabilities.canonicalTopologyBytes === true &&
		input.snapshot.provider.capabilities.diagnostics === true &&
		input.snapshot.provider.capabilities.structuralDelta === true;

	const units = input.workUnits.map((unit): GateUnitResult => {
		const reasons = new Set<ReasonCode>();
		const record = records.get(unit.id);
		const fact = facts.get(unit.id);
		if (!input.schemaValid || record === undefined || fact === undefined)
			reasons.add("SCHEMA_INVALID");
		if (!providerSupported) reasons.add("PROVIDER_CAPABILITY_UNSUPPORTED");
		if (!input.snapshot.blueprint.diagnostics.ok) reasons.add("BLUEPRINT_DIAGNOSTICS_ERROR");

		if (fact !== undefined && !fact.exists) reasons.add("COMMIT_NOT_FOUND");
		if (record !== undefined && fact !== undefined && fact.exists) {
			const claimIds = unit.blueprintClaims.map((claim) => claim.id);
			if (
				record.contractVersion !== input.contractVersion ||
				!sameStrings(record.dependencies, unit.dependencies) ||
				!sameStrings(record.requiredChecks, unit.requiredChecks) ||
				!sameStrings(record.blueprintClaims, claimIds)
			) {
				reasons.add("SCHEMA_INVALID");
			}
			if (
				record.providerId !== input.snapshot.provider.providerId ||
				record.providerVersion !== input.snapshot.provider.providerVersion
			) {
				reasons.add("PROVIDER_CAPABILITY_UNSUPPORTED");
			}
			if (
				!sameOid(record.commit, fact.commit) ||
				record.diffDigest.value !== fact.diffDigest.value ||
				record.stablePatchId !== fact.stablePatchId
			) {
				reasons.add("COMMIT_BINDING_MISMATCH");
			}
			if (fact.patchIdAmbiguous) reasons.add("PATCH_ID_AMBIGUOUS");
			if (!sameStrings(record.allowedSourceScopes, unit.allowedSourceScopes)) {
				reasons.add("SOURCE_SCOPE_VIOLATION");
			}
			if (fact.changedPaths.some((path) => !unit.allowedSourceScopes.includes(path))) {
				reasons.add("SOURCE_SCOPE_VIOLATION");
			}
			const expectedParentRecord = unit.dependencies.at(-1);
			const expectedParentId = expectedParentRecord
				? records.get(expectedParentRecord)?.recordId
				: null;
			if (
				!sameOid(record.semanticParentCommit, fact.parent) ||
				record.semanticParentRecordId !== (expectedParentId ?? null)
			) {
				reasons.add("SEMANTIC_PARENT_STALE");
			}
		}

		const invalidDependencies = unit.dependencies.filter(
			(dependency) => prior.get(dependency)?.verdict !== "valid",
		);
		if (invalidDependencies.length > 0) reasons.add("DEPENDENCY_INVALID");

		if (record !== undefined) {
			if (record.sourceScopeDigest.value !== sha256Jcs(record.allowedSourceScopes)) {
				reasons.add("ARTIFACT_HASH_MISMATCH");
			}
			const impacted = input.delta.claimImpacts.some(
				(impact) => impact.workUnitId === unit.id && impact.impact === "affected",
			);
			if (record.blueprintHash.value !== input.snapshot.topologyHash.value && impacted) {
				reasons.add("BLUEPRINT_WITNESS_STALE");
				if (
					unit.blueprintClaims.some((claim) => claim.id === "session-write-path") &&
					violatesSessionWritePolicy(input.snapshot)
				) {
					reasons.add("POLICY_SESSION_WRITE_REQUIRES_BROKER");
				}
			}
			if (
				record.policyRevision !== input.snapshot.policyRevision &&
				record.blueprintHash.value === input.snapshot.topologyHash.value &&
				impacted
			) {
				reasons.add("POLICY_REVISION_STALE");
			}
			for (const checkId of unit.requiredChecks) {
				const check = checks.get(checkId);
				if (check === undefined) reasons.add("REQUIRED_CHECK_MISSING");
				else if (check.exitCode !== 0) reasons.add("REQUIRED_CHECK_FAILED");
			}
		}
		if (!input.artifactIntegrity) reasons.add("ARTIFACT_HASH_MISMATCH");

		const result: GateUnitResult = {
			workUnitId: unit.id,
			verdict: reasons.size === 0 ? "valid" : "invalid",
			reasonCodes: sortReasons(reasons),
			invalidDependencies,
		};
		prior.set(unit.id, result);
		return result;
	});

	return {
		schema: "urn:graphrefly-stack:schema:gate-result:v1",
		gateVersion: "v1",
		inputDigest: { algorithm: "sha256", value: sha256Jcs(input) },
		verdict: units.some((unit) =>
			unit.reasonCodes.some((reason) =>
				[
					"SCHEMA_INVALID",
					"PROVIDER_CAPABILITY_UNSUPPORTED",
					"BLUEPRINT_DIAGNOSTICS_ERROR",
				].includes(reason),
			),
		)
			? "error"
			: units.some((unit) => unit.verdict === "invalid")
				? "blocked"
				: "pass",
		units,
		checkIds: input.checks.map((check) => check.checkId),
	};
}
