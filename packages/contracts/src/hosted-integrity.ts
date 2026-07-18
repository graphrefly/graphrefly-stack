import {
	HOSTED_GATE_SUMMARY_SCHEMA,
	HOSTED_LOCAL_REVIEW_SCHEMA,
	HOSTED_REDACTION_EXCLUDES,
	HOSTED_SEMANTIC_REVIEW_SCHEMA,
} from "./hosted.js";
import { canonicalize, sha256Jcs } from "./jcs.js";
import { SEMANTIC_REASON_ORDER } from "./semantic.js";

type JsonObject = Record<string, unknown>;

export class HostedIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostedIntegrityError";
	}
}

function object(value: unknown, label: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HostedIntegrityError(`${label} must be an object`);
	}
	return value as JsonObject;
}

function equal(left: unknown, right: unknown): boolean {
	return canonicalize(left) === canonicalize(right);
}

export function assertCiBundleIntegrity(value: unknown): void {
	const ciBundle = object(value, "CI bundle");
	const invocation = object(ciBundle.invocation, "CI invocation");
	const result = object(ciBundle.result, "CI result");
	const portableBundle = object(ciBundle.portableBundle, "portable bundle");
	const event = object(invocation.event, "CI event");
	const repository = object(invocation.repository, "CI repository");
	const workflow = object(invocation.workflow, "CI workflow");
	const run = object(invocation.run, "CI run");
	const provenance = object(result.provenance, "CI provenance");
	const gateResult = object(result.gateResult, "GateResult");
	const summary = object(result.summary, "CI summary");
	const redaction = object(result.redaction, "CI redaction");
	const invocationDigest = object(result.invocationDigest, "CI invocation digest");
	const gateInputDigest = object(result.gateInputDigest, "CI gate input digest");
	const portableBundleDigest = object(result.portableBundleDigest, "portable bundle digest");
	const manifest = object(portableBundle.manifest, "portable bundle manifest");
	const artifacts = object(portableBundle.artifacts, "portable bundle artifacts");
	const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
	const expectedArtifactPaths = [
		"policy.json",
		"plan.json",
		"bindings.json",
		"records.json",
		"checks.json",
		"gate-input.json",
		"gate-result.json",
	];
	const manifestHashesValid =
		manifestArtifacts.length === expectedArtifactPaths.length &&
		manifestArtifacts.every((entry, index) => {
			const descriptor = object(entry, "portable manifest descriptor");
			const path = expectedArtifactPaths[index] as string;
			const digest = object(descriptor.hash, "portable manifest digest");
			return descriptor.path === path && digest.value === sha256Jcs(artifacts[path]);
		});
	const units = Array.isArray(gateResult.units) ? (gateResult.units as JsonObject[]) : [];
	const affectedWorkUnitIds = units
		.filter((unit) => unit.verdict === "invalid")
		.map((unit) => unit.workUnitId);
	const presentReasons = new Set(
		units.flatMap((unit) => (Array.isArray(unit.reasonCodes) ? unit.reasonCodes : [])),
	);
	const reasonCodes = SEMANTIC_REASON_ORDER.filter((reason) => presentReasons.has(reason));

	if (
		invocationDigest.value !== sha256Jcs(invocation) ||
		portableBundleDigest.value !== sha256Jcs(portableBundle) ||
		!equal(gateInputDigest, gateResult.inputDigest) ||
		result.outcome !== gateResult.verdict ||
		summary.verdict !== result.outcome ||
		provenance.repositoryId !== repository.id ||
		provenance.runId !== run.id ||
		provenance.attempt !== run.attempt ||
		!equal(provenance.workflowSha, workflow.sha) ||
		event.name !== "pull_request" ||
		!equal(redaction.excludes, HOSTED_REDACTION_EXCLUDES) ||
		!manifestHashesValid ||
		!equal(manifest.redaction, redaction) ||
		!equal(manifest.head, event.head) ||
		!equal(manifest.inputDigest, gateInputDigest) ||
		!equal(artifacts["gate-result.json"], gateResult) ||
		!equal(summary.affectedWorkUnitIds, affectedWorkUnitIds) ||
		!equal(summary.reasonCodes, reasonCodes) ||
		result.artifactName !== `graphrefly-stack-ci-${portableBundleDigest.value as string}`
	) {
		throw new HostedIntegrityError("CI bundle cross-binding or redaction is invalid");
	}
}

export function assertHostedEnvelopeIntegrity(value: unknown): void {
	const envelope = object(value, "hosted envelope");
	const source = object(envelope.source, "hosted source");
	const redaction = object(envelope.redaction, "hosted redaction");
	const payload = object(envelope.payload, "hosted payload");
	const includes = Array.isArray(redaction.includes) ? redaction.includes : [];
	const descriptor = includes.length === 1 ? object(includes[0], "included artifact") : null;
	const digest = descriptor === null ? null : object(descriptor.digest, "included artifact digest");
	const expectedPath =
		envelope.profile === "gate-summary-v1"
			? "ci/gate-summary.json"
			: envelope.profile === "semantic-review-v1"
				? "ci/semantic-review.json"
				: "review/decisions.json";
	if (
		descriptor?.path !== expectedPath ||
		digest?.value !== sha256Jcs(payload) ||
		!equal(redaction.excludes, HOSTED_REDACTION_EXCLUDES)
	) {
		throw new HostedIntegrityError("hosted redaction manifest is not bound to its payload");
	}

	if (envelope.profile === "gate-summary-v1") {
		const gateResult = object(payload.gateResult, "hosted GateResult");
		const summary = object(payload.summary, "hosted summary");
		const units = Array.isArray(gateResult.units) ? (gateResult.units as JsonObject[]) : [];
		const affectedWorkUnitIds = units
			.filter((unit) => unit.verdict === "invalid")
			.map((unit) => unit.workUnitId);
		const presentReasons = new Set(
			units.flatMap((unit) => (Array.isArray(unit.reasonCodes) ? unit.reasonCodes : [])),
		);
		const reasonCodes = SEMANTIC_REASON_ORDER.filter((reason) => presentReasons.has(reason));
		if (
			payload.schema !== HOSTED_GATE_SUMMARY_SCHEMA ||
			payload.outcome !== gateResult.verdict ||
			summary.verdict !== gateResult.verdict ||
			!equal(summary.affectedWorkUnitIds, affectedWorkUnitIds) ||
			!equal(summary.reasonCodes, reasonCodes) ||
			!equal(source.gateInputDigest, gateResult.inputDigest)
		) {
			throw new HostedIntegrityError("hosted gate summary is not bound to its source");
		}
		return;
	}

	const bundle = payload.bundle;
	if (envelope.profile === "semantic-review-v1") {
		if (payload.schema !== HOSTED_SEMANTIC_REVIEW_SCHEMA) {
			throw new HostedIntegrityError("hosted semantic profile has the wrong payload schema");
		}
		assertCiBundleIntegrity(bundle);
		const ciBundle = object(bundle, "CI bundle");
		const invocation = object(ciBundle.invocation, "CI invocation");
		const result = object(ciBundle.result, "CI result");
		const repository = object(invocation.repository, "CI repository");
		const event = object(invocation.event, "CI event");
		const run = object(invocation.run, "CI run");
		if (
			object(source.sourceBundleDigest, "source bundle digest").value !== sha256Jcs(bundle) ||
			!equal(source.ciInvocationDigest, result.invocationDigest) ||
			!equal(source.gateInputDigest, result.gateInputDigest) ||
			!equal(source.portableBundleDigest, result.portableBundleDigest) ||
			!equal(source.head, event.head) ||
			source.runId !== run.id ||
			source.runAttempt !== run.attempt ||
			object(envelope.repository, "hosted repository").repositoryId !== repository.id
		) {
			throw new HostedIntegrityError("hosted semantic payload is not bound to its CI source");
		}
		return;
	}

	if (
		payload.schema !== HOSTED_LOCAL_REVIEW_SCHEMA ||
		object(source.sourceBundleDigest, "source bundle digest").value !== sha256Jcs(bundle)
	) {
		throw new HostedIntegrityError("hosted local review is not bound to its source");
	}
}
