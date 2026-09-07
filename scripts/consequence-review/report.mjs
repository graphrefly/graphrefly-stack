import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	canonicalTopologyBytes,
	diffGraphBlueprints,
} from "../../examples/refresh-session-source-bound/node_modules/@graphrefly/ts/dist/index.js";
import {
	assembleIntegrationCandidate,
	withIsolatedGitCandidate,
} from "../../packages/cli/dist/integration-candidate.js";
import { assembleIntegrationResult } from "../../packages/cli/dist/integration-semantics.js";
import { assertConsequenceProof } from "../../packages/contracts/dist/consequence-review.js";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import {
	compareConsequenceProjections,
	composeReviewAxes,
	deriveConsequenceProjection,
} from "../../packages/core/dist/consequence-review.js";
import { buildManifest, verifyManifest } from "../../packages/core/dist/evidence-manifest.js";
import { evaluateIntegrationEffects } from "../../packages/core/dist/integration-effects.js";
import { bindSource, verifyBinding } from "../../packages/core/dist/source-bound.js";
import { coordinate, git, hashBytes, retainedRoot, root } from "../source-bound/git.mjs";
import { verifyReport as verifySourceReport } from "../source-bound/report.mjs";
import { createAnchor, resolveAt } from "../source-bound/resolver.mjs";
import { verifyConsequenceFixture } from "./fixture.mjs";

const identity = {
	artifact_ref: "graphrefly-stack:consequence-review-proof",
	schema: "graphrefly-stack/consequence-review-proof/v1",
	revision: "stack-review-v1",
};
const exampleNodeModules = resolve(root, "examples/refresh-session-source-bound/node_modules");
const foundationProofPath = "evidence/runs/source-bound/evidence-bundle.json";
const expectedFoundationProofId =
	"8392c5e2a4822fb54153365704343b688a189a437f1ea4d93f8f79b2b7390ee9";
const sourceByChange = {
	A: [
		["src/session-store.ts", "SessionStore"],
		["src/session-store.ts", "ApplyBrokerPolicy"],
	],
	B: [
		["src/response-mapping.ts", "AdmitRefresh"],
		["src/response-mapping.ts", "MapFailureResponse"],
	],
};
const verificationByChange = {
	A: [
		"PersistSession",
		"ApplyBrokerPolicy",
		"EvaluateSessionPolicy",
		"AdmitRefresh",
		"BuildHttpRefreshOutcome",
		"EmitSecurityAudit",
	],
	B: [
		"AdmitRefresh",
		"MapFailureResponse",
		"BuildHttpRefreshOutcome",
		"EmitSecurityAudit",
		"UpdateSessionMetrics",
	],
};
const unchangedControls = ["ValidateTokenContract", "IndependentPasswordResetFlow"];

function runRevision(repository, commit) {
	const temporary = mkdtempSync(resolve(tmpdir(), "consequence-revision-"));
	const worktree = resolve(temporary, "worktree");
	try {
		git(repository, ["worktree", "add", "--detach", "--force", worktree, commit]);
		symlinkSync(exampleNodeModules, resolve(worktree, "node_modules"), "dir");
		const runtime = spawnSync(
			process.execPath,
			[resolve(root, "scripts/consequence-review/revision-runtime.mjs"), worktree],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 30000,
				maxBuffer: 4 * 1024 * 1024,
				env: { PATH: "/usr/bin:/bin" },
			},
		);
		if (runtime.error || runtime.signal || runtime.status !== 0)
			throw new Error(`CONSEQUENCE_RUNTIME: ${runtime.stderr}`);
		const test = spawnSync(
			process.execPath,
			["--test", "--test-reporter=dot", "tests/business.test.mjs"],
			{
				cwd: worktree,
				encoding: "utf8",
				timeout: 30000,
				maxBuffer: 1024 * 1024,
				env: { PATH: "/usr/bin:/bin", NO_COLOR: "1" },
			},
		);
		if (test.error || test.signal || test.status !== 0)
			throw new Error(`CONSEQUENCE_TEST: ${test.stderr}`);
		const output = JSON.parse(runtime.stdout);
		const expectedHash = hashBytes(canonicalTopologyBytes(output.blueprint.topology));
		if (
			output.blueprint.version !== "graphrefly.blueprint.v2" ||
			output.blueprint.hash?.value !== expectedHash
		)
			throw new Error("CONSEQUENCE_TOPOLOGY_HASH");
		return {
			...output,
			test: {
				schema: "node-test/process-result/v1",
				command: ["--test", "--test-reporter=dot", "tests/business.test.mjs"],
				nodeVersion: process.version,
				exitCode: test.status,
				stdout: test.stdout,
				stderr: test.stderr,
			},
		};
	} finally {
		try {
			git(repository, ["worktree", "remove", "--force", worktree]);
		} catch {}
		rmSync(temporary, { recursive: true, force: true });
	}
}

function currentDecisions(bindingRefs, subject) {
	const path = "docs/decisions/decisions.jsonl";
	const commit = git(root, ["log", "-1", "--format=%H", "--", path]).trim();
	const bytes = readFileSync(resolve(root, path), "utf8");
	if (bytes !== git(root, ["show", `${commit}:${path}`]))
		throw new Error("CONSEQUENCE_DECISION_DRIFT");
	const records = bytes.trim().split("\n").map(JSON.parse);
	return ["D57", "D58", "D59"].map((id) => {
		const matches = records.filter((record) => record.id === id);
		if (
			matches.length !== 1 ||
			matches[0].status !== "locked" ||
			Object.hasOwn(matches[0], "superseded_by") ||
			records.some((record) =>
				record.supersedes?.some((ref) => ref === id || ref === `graphrefly-stack:${id}`),
			)
		)
			throw new Error(`CONSEQUENCE_DECISION: ${id}`);
		const digest = sha256Jcs(matches[0]);
		const location = {
			repository: coordinate(root, commit).repository,
			commit,
			occurrence: null,
			path,
			selector: `id=${id}`,
		};
		return authority(
			`graphrefly-stack:${id}`,
			"decision",
			"graphrefly-stack",
			"graphrefly-stack/decision-jsonl-record",
			location,
			digest,
			bindingRefs,
			subject,
			"Exact current locked Stack decision selected by id and hashed as JCS",
			[location],
		);
	});
}
function authority(
	ref,
	kind,
	owner,
	schema,
	location,
	digest,
	bindingRefs,
	subject,
	scope,
	sources,
) {
	const reference = {
		ref,
		kind,
		owner,
		schema,
		location,
		digest,
		bindingRefs,
		provenance: { tool: "consequence-review-owner-resolver", version: "1", scope, sources },
		freshness: { status: "current", subject: structuredClone(subject), authorityDigest: digest },
	};
	return { reference, subjectWitness: structuredClone(subject), authorityWitness: digest };
}

function buildChange(changeId, base, head, runtime, integrationVerification) {
	const subject = { repository: coordinate(retainedRoot, head).repository, base, head };
	const rawChange = git(retainedRoot, [
		"diff-tree",
		"--no-commit-id",
		"--raw",
		"-r",
		"-z",
		"--no-renames",
		base,
		head,
	]);
	const changedPaths = git(retainedRoot, ["diff", "--name-only", "-z", "--no-renames", base, head])
		.split("\0")
		.filter(Boolean)
		.sort();
	const declaredPaths = [...new Set(sourceByChange[changeId].map(([path]) => path))].sort();
	if (
		declaredPaths.some((path) => !changedPaths.includes(path)) ||
		changedPaths.some(
			(path) => !declaredPaths.includes(path) && path !== "tests/business-verifier.mjs",
		)
	)
		throw new Error("CONSEQUENCE_CHANGE_SCOPE");
	const exactChangeId = sha256Jcs({
		schema: "graphrefly.stack.git-change-set.v1",
		subject,
		rawDiffDigest: hashBytes(rawChange),
	});
	const blueprint = {
		version: runtime.blueprint.version,
		topologyHash: runtime.blueprint.hash.value,
	};
	const runtimeFacts = {
		coordinate: coordinate(retainedRoot, head),
		blueprintVersion: runtime.blueprint.version,
		topologyHash: runtime.blueprint.hash.value,
		nodeIds: runtime.blueprint.topology.nodes.map((node) => node.id),
		exports: runtime.exports,
		provenance: { tool: "consequence-review-retained-runtime", version: "1/@graphrefly/ts-0.8.0" },
	};
	const anchors = [],
		resolutions = [],
		bindings = [],
		sources = [];
	for (const [path, symbol] of sourceByChange[changeId]) {
		const anchor = createAnchor(retainedRoot, coordinate(retainedRoot, head), path, symbol);
		const resolved = resolveAt(retainedRoot, anchor, coordinate(retainedRoot, head));
		const binding = bindSource(anchor, resolved.result, resolved.facts, runtimeFacts);
		verifyBinding(binding, anchor, resolved.result, resolved.facts, runtimeFacts);
		anchors.push(anchor);
		resolutions.push(resolved.result);
		bindings.push(binding);
		sources.push({ anchor, resolution: resolved.result });
	}
	const bindingRefs = bindings.map((value) => value.id).sort();
	const sourceArtifactBody = {
		schema: "graphrefly.stack.consequence-source-evidence.v1",
		changeId: exactChangeId,
		subject,
		blueprint,
		topology: runtime.blueprint.topology,
		anchors,
		resolutions,
		bindings,
	};
	const sourceArtifact = { ...sourceArtifactBody, id: sha256Jcs(sourceArtifactBody) };
	const policyPath = changeId === "A" ? "src/session-store.ts" : "src/response-mapping.ts";
	const policyDigest = hashBytes(git(retainedRoot, ["show", `${head}:${policyPath}`]));
	const verifierPath = "tests/business-verifier.mjs";
	const verifierSourceDigest = hashBytes(git(retainedRoot, ["show", `${head}:${verifierPath}`]));
	const testResult = { ...runtime.test, subject };
	const testDigest = sha256Jcs(testResult);
	const verifierResult = {
		schema: "refresh-session/business-verifier-observation/v1",
		subject,
		topologyHash: blueprint.topologyHash,
		sourceDigest: verifierSourceDigest,
		result: runtime.business,
		coverage: {
			required: [...verificationByChange[changeId]].sort(),
			unchangedControls: [...unchangedControls].sort(),
		},
	};
	const verifierResultDigest = sha256Jcs(verifierResult);
	const gitLocation = (path) => ({
		repository: subject.repository,
		commit: head,
		occurrence: null,
		path,
		selector: null,
	});
	const authorities = [
		...currentDecisions(bindingRefs, subject),
		authority(
			`refresh-session-fixture:${changeId}:policy-source`,
			"policy",
			subject.repository,
			"typescript/5.9.3-source",
			gitLocation(policyPath),
			policyDigest,
			bindingRefs,
			subject,
			"Retained fixture policy source; repository-owned and not approval authority",
			[gitLocation(policyPath)],
		),
		authority(
			`refresh-session-fixture:${changeId}:business-test`,
			"test",
			"node:test",
			runtime.test.schema,
			{
				repository: "graphrefly-stack:consequence-review-proof",
				commit: null,
				occurrence: testDigest,
				path: "evidence/runs/consequence-review/evidence-bundle.json",
				selector: `/sourceEvidence/${changeId === "A" ? 0 : 1}/testResult`,
			},
			testDigest,
			bindingRefs,
			subject,
			"Exact Node test process observation, not reinterpreted as owner admission",
			[gitLocation("tests/business.test.mjs"), gitLocation(verifierPath)],
		),
		authority(
			`refresh-session-fixture:${changeId}:business-verifier`,
			"verifier",
			subject.repository,
			"refresh-session/business-verifier-v2",
			{
				repository: "graphrefly-stack:consequence-review-proof",
				commit: null,
				occurrence: verifierResultDigest,
				path: "evidence/runs/consequence-review/evidence-bundle.json",
				selector: `/sourceEvidence/${changeId === "A" ? 0 : 1}/verifierResult`,
			},
			verifierResultDigest,
			bindingRefs,
			subject,
			"Independently authored retained business verifier source and fresh result",
			[gitLocation(verifierPath), gitLocation(policyPath)],
		),
		authority(
			integrationVerification.verifierRef,
			"verifier",
			"graphrefly-stack",
			integrationVerification.schema,
			{
				repository: "graphrefly-stack:consequence-review-proof",
				commit: null,
				occurrence: integrationVerification.id,
				path: "evidence/runs/consequence-review/evidence-bundle.json",
				selector: "/integration/verification",
			},
			integrationVerification.id,
			bindingRefs,
			subject,
			"Exact independently recomputed IntegrationResult binding for the isolated candidate",
			[gitLocation(policyPath)],
		),
		authority(
			`graphrefly-stack:consequence-source-evidence:${changeId}`,
			"artifact",
			"graphrefly-stack",
			sourceArtifact.schema,
			{
				repository: "graphrefly-stack:local-consequence-review",
				commit: null,
				occurrence: sourceArtifact.id,
				path: "evidence/runs/consequence-review/evidence-bundle.json",
				selector: `/sourceEvidence/${changeId === "A" ? 0 : 1}/sourceArtifact`,
			},
			sourceArtifact.id,
			bindingRefs,
			subject,
			"Fresh revision-specific source anchors, resolutions and bindings; does not own fixture policy or verifier truth",
			[gitLocation(policyPath)],
		),
	];
	const facts = { subject, blueprint, bindings, authorities };
	const manifest = buildManifest(facts);
	verifyManifest(manifest, facts);
	const verifierObservation = {
		authorityRef: `refresh-session-fixture:${changeId}:business-verifier`,
		authorityDigest: verifierResultDigest,
		resultDigest: verifierResultDigest,
		result: runtime.business.status,
		freshness: "current",
		subject,
		topologyHash: blueprint.topologyHash,
		coverage: [...new Set([...verificationByChange[changeId], ...unchangedControls])].sort(),
		attestation: structuredClone(verifierResult),
	};
	const projection = deriveConsequenceProjection({
		changeId: exactChangeId,
		subject,
		blueprint,
		manifest,
		sourceScope: sourceByChange[changeId].map(([, symbol]) => symbol),
		sources,
		bindings,
		topology: runtime.blueprint.topology,
		verificationRequired: verificationByChange[changeId],
		unchangedControls,
		verifierObservations: [verifierObservation],
	});
	return {
		sourceEvidence: {
			changeId: exactChangeId,
			manifest,
			sourceArtifact,
			testResult,
			verifierResult,
			verifierObservation,
		},
		projection,
		facts,
	};
}

async function integrationEvidence(revisions, snapshots) {
	return withIsolatedGitCandidate(
		{ repository: retainedRoot, target: revisions.left, head: revisions.right },
		async (isolated) => {
			const candidateCommit = git(isolated.isolatedRepository, [
				"commit-tree",
				isolated.tree.value,
				"-p",
				revisions.left,
				"-p",
				revisions.right,
				"-m",
				"Ephemeral consequence review candidate",
			]).trim();
			const candidateSnapshot = runRevision(isolated.isolatedRepository, candidateCommit);
			const digest = (snapshot) => ({ algorithm: "sha256", value: snapshot.blueprint.hash.value });
			const graph = {
				graphreflyVersion: "0.8.0",
				base: { blueprint: snapshots.base.blueprint, blueprintHash: digest(snapshots.base) },
				target: { blueprint: snapshots.left.blueprint, blueprintHash: digest(snapshots.left) },
				head: { blueprint: snapshots.right.blueprint, blueprintHash: digest(snapshots.right) },
				candidate: {
					blueprint: candidateSnapshot.blueprint,
					blueprintHash: digest(candidateSnapshot),
				},
				targetDelta: {
					delta: diffGraphBlueprints(snapshots.base.blueprint, snapshots.left.blueprint),
					digest: null,
				},
				headDelta: {
					delta: diffGraphBlueprints(snapshots.base.blueprint, snapshots.right.blueprint),
					digest: null,
				},
				candidateDelta: {
					delta: diffGraphBlueprints(snapshots.base.blueprint, candidateSnapshot.blueprint),
					digest: null,
				},
			};
			for (const key of ["targetDelta", "headDelta", "candidateDelta"])
				graph[key].digest = { algorithm: "sha256", value: sha256Jcs(graph[key].delta) };
			const gate = {
				inputDigest: { algorithm: "sha256", value: sha256Jcs({ subject: revisions.right }) },
				resultDigest: {
					algorithm: "sha256",
					value: sha256Jcs({ verdict: "pass", subject: revisions.right }),
				},
				verdict: "pass",
			};
			const candidate = await assembleIntegrationCandidate({
				git: isolated,
				graph,
				repository: { provider: "local", owner: "retained-fixture", name: "refresh-session" },
				planDigest: { algorithm: "sha256", value: sha256Jcs({ plan: "SC12" }) },
				policyDigest: { algorithm: "sha256", value: sha256Jcs({ policy: "retained-fixture-v2" }) },
				headGate: gate,
			});
			const effects = evaluateIntegrationEffects({
				targetDelta: graph.targetDelta.delta,
				headDelta: graph.headDelta.delta,
				candidateDelta: graph.candidateDelta.delta,
			});
			const result = await assembleIntegrationResult({
				candidate,
				graph: effects,
				semantic: { reasonCodes: [], conflicts: [], headGate: gate },
			});
			const resultDigest = sha256Jcs(result);
			const inputs = {
				targetDelta: graph.targetDelta.delta,
				headDelta: graph.headDelta.delta,
				candidateDelta: graph.candidateDelta.delta,
			};
			const verificationBody = {
				schema: "graphrefly.stack.integration-result-verification.v1",
				verifierRef: "graphrefly-stack:retained-integration-result-verifier",
				candidateDigest: sha256Jcs(candidate),
				resultDigest,
				candidateTree: isolated.tree.value,
				inputs,
				candidateDeltaBinding: {
					from: candidate.revisions.mergeBase.value,
					to: candidate.merge.tree.value,
					digest: graph.candidateDelta.digest.value,
				},
				effectDigest: sha256Jcs(effects),
				status: "verified",
			};
			return {
				candidate,
				result,
				resultDigest,
				verification: { ...verificationBody, id: sha256Jcs(verificationBody) },
				candidateTree: isolated.tree.value,
			};
		},
	);
}

function filesAt(directory, prefix = "") {
	return readdirSync(directory, { withFileTypes: true })
		.sort((left, right) => left.name.localeCompare(right.name, "en"))
		.flatMap((entry) =>
			entry.isDirectory()
				? filesAt(resolve(directory, entry.name), `${prefix}${entry.name}/`)
				: [
						{
							path: `${prefix}${entry.name}`,
							digest: hashBytes(readFileSync(resolve(directory, entry.name))),
						},
					],
		);
}

function exactRuntime() {
	const graphRoot = resolve(exampleNodeModules, "@graphrefly/ts");
	const typescriptRoot = resolve(exampleNodeModules, "typescript");
	const graphManifest = JSON.parse(readFileSync(resolve(graphRoot, "package.json"), "utf8"));
	const typescriptManifest = JSON.parse(
		readFileSync(resolve(typescriptRoot, "package.json"), "utf8"),
	);
	const lock = JSON.parse(
		readFileSync(resolve(root, "examples/refresh-session-source-bound/package-lock.json"), "utf8"),
	);
	const foundation = JSON.parse(readFileSync(resolve(root, foundationProofPath), "utf8"));
	const installedFilesDigest = sha256Jcs(filesAt(graphRoot));
	const typescriptInstalledFilesDigest = sha256Jcs(filesAt(typescriptRoot));
	const lockIntegrity = lock.packages["node_modules/@graphrefly/ts"]?.integrity;
	const typescriptLockIntegrity = lock.packages["node_modules/typescript"]?.integrity;
	verifySourceReport(foundation);
	if (
		graphManifest.name !== "@graphrefly/ts" ||
		graphManifest.version !== "0.8.0" ||
		typescriptManifest.version !== "5.9.3" ||
		lock.packages["node_modules/@graphrefly/ts"]?.version !== graphManifest.version ||
		lock.packages["node_modules/typescript"]?.version !== typescriptManifest.version ||
		foundation.runtime.version !== graphManifest.version ||
		foundation.runtime.lockIntegrity !== lockIntegrity ||
		foundation.runtime.installedFilesDigest !== installedFilesDigest ||
		foundation.id !== expectedFoundationProofId ||
		typeof typescriptLockIntegrity !== "string"
	)
		throw new Error("CONSEQUENCE_RUNTIME_IDENTITY");
	return {
		name: graphManifest.name,
		version: graphManifest.version,
		typescriptVersion: typescriptManifest.version,
		lockIntegrity,
		installedFilesDigest,
		typescriptLockIntegrity,
		typescriptInstalledFilesDigest,
		foundationProofId: foundation.id,
	};
}

function adapterDigest() {
	const explicit = [
		"scripts/consequence-review-report.mjs",
		"scripts/consequence-review/fixture.mjs",
		"scripts/consequence-review/report.mjs",
		"scripts/consequence-review/revision-runtime.mjs",
		"scripts/source-bound/git.mjs",
		"scripts/source-bound/resolver.mjs",
		"contracts/consequence-review/v1/projection.schema.json",
		"contracts/consequence-review/v1/guidance.schema.json",
		"contracts/consequence-review/v1/proof.schema.json",
	];
	const executed = ["packages/contracts/dist", "packages/core/dist", "packages/cli/dist"].flatMap(
		(path) => filesAt(resolve(root, path), `${path}/`),
	);
	return sha256Jcs([
		...explicit.map((path) => ({ path, digest: hashBytes(readFileSync(resolve(root, path))) })),
		...executed,
	]);
}

export async function buildReport() {
	const revisions = verifyConsequenceFixture();
	const runtime = exactRuntime();
	const before = {
		head: git(retainedRoot, ["rev-parse", "HEAD"]).trim(),
		status: git(retainedRoot, ["status", "--porcelain=v1", "--untracked-files=no"]).trim(),
		refs: git(retainedRoot, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim(),
	};
	const snapshots = {
		base: runRevision(retainedRoot, revisions.base),
		left: runRevision(retainedRoot, revisions.left),
		right: runRevision(retainedRoot, revisions.right),
	};
	const integration = await integrationEvidence(revisions, snapshots);
	const left = buildChange(
		"A",
		revisions.base,
		revisions.left,
		snapshots.left,
		integration.verification,
	);
	const right = buildChange(
		"B",
		revisions.base,
		revisions.right,
		snapshots.right,
		integration.verification,
	);
	const integrationPair = {
		candidate: integration.candidate,
		result: integration.result,
		resultDigest: integration.resultDigest,
		verification: integration.verification,
	};
	const guidance = compareConsequenceProjections({
		left: left.projection,
		right: right.projection,
		integration: integrationPair,
	});
	if (guidance.status !== "overlap-observed" || integration.result.outcome !== "compatible")
		throw new Error("CONSEQUENCE_EXPECTED_COMPATIBLE_OVERLAP");
	const axes = [left.projection, right.projection].map((projection) =>
		composeReviewAxes({
			projection,
			human: {
				status: "needs-review",
				targetDigest: projection.id,
				currentTargetDigest: projection.id,
			},
			ownerAdmission: null,
		}),
	);
	const technical = [left, right].flatMap((value) => [
		...value.sourceEvidence.sourceArtifact.anchors,
		...value.sourceEvidence.sourceArtifact.resolutions,
		...value.sourceEvidence.sourceArtifact.bindings,
		...value.sourceEvidence.manifest.authorities,
	]);
	const reviewed = new Set(
		[left.projection, right.projection].flatMap((projection) => [
			...projection.direct.map((entry) => entry.nodeId),
			...projection.reachable.map((entry) => entry.to),
			...projection.verificationRequired,
			...projection.verifiedUnchanged.map((entry) => entry.scope),
			...projection.unknowns.map((entry) => `${entry.code}:${entry.subject}`),
		]),
	).size;
	const body = {
		...identity,
		repository: {
			identity: left.projection.subject.repository,
			base: revisions.base,
			left: revisions.left,
			right: revisions.right,
			candidateTree: integration.candidateTree,
		},
		runtime,
		sourceEvidence: [left.sourceEvidence, right.sourceEvidence],
		projections: [left.projection, right.projection],
		guidance,
		axes,
		integration: integrationPair,
		compression: {
			reviewed,
			available: technical.length + snapshots.base.blueprint.topology.nodes.length,
			unit: "distinct decision-surface entries / bound technical records",
		},
		adapter: { tool: "consequence-review-report", version: "1", sourceDigest: adapterDigest() },
		llmRequired: false,
		limitations: [
			"Structural reachability is not observed runtime occurrence or causality",
			"Human review and external owner admission remain independent and are not granted by this proof",
			"No-overlap-observed is scoped to declared coverage and is not an unconditional safety claim",
			"The combined candidate exists only in isolated temporary storage and is not retained as a Git ref",
		],
	};
	const proof = { ...body, id: sha256Jcs(body) };
	assertConsequenceProof(proof);
	const after = {
		head: git(retainedRoot, ["rev-parse", "HEAD"]).trim(),
		status: git(retainedRoot, ["status", "--porcelain=v1", "--untracked-files=no"]).trim(),
		refs: git(retainedRoot, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim(),
	};
	if (canonicalize(before) !== canonicalize(after))
		throw new Error("CONSEQUENCE_RETAINED_MUTATION");
	return proof;
}

export async function verifyReport(value) {
	assertConsequenceProof(value);
	const expected = await buildReport();
	if (canonicalize(value) !== canonicalize(expected))
		throw new Error("CONSEQUENCE_REPORT_MISMATCH");
	return { verified: true, id: value.id, integrationResultDigest: value.integration.resultDigest };
}
