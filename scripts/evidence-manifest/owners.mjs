import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import {
	assertRetainedCurrent,
	consumerRoot,
	coordinate,
	fullCommit,
	git,
	hashBytes,
	retainedRoot,
	root,
} from "../source-bound/git.mjs";
import { verifyReport as verifySourceReport } from "../source-bound/report.mjs";

export const sourceProofPath = "evidence/runs/source-bound/evidence-bundle.json";
export const testResultPath = ".private/evidence-manifest/node-test.json";
const expectedSourceId = "8392c5e2a4822fb54153365704343b688a189a437f1ea4d93f8f79b2b7390ee9";

export function currentDecision(records, id) {
	const matches = records.filter((record) => record.id === id);
	if (
		matches.length !== 1 ||
		matches[0].status !== "locked" ||
		Object.hasOwn(matches[0], "superseded_by") ||
		records.some((record) =>
			record.supersedes?.some((ref) => ref === id || ref === `graphrefly-stack:${id}`),
		)
	)
		throw new Error("MANIFEST_DECISION_AUTHORITY");
	return matches[0];
}

function locatedGit(repository, commit, path, selector = null) {
	return {
		repository: coordinate(repository, commit).repository,
		commit,
		occurrence: null,
		path,
		selector,
	};
}
function committedStackFile(path) {
	const commit = git(root, ["log", "-1", "--format=%H", "--", path]).trim();
	fullCommit(root, commit);
	const bytes = readFileSync(resolve(root, path));
	if (!bytes.equals(Buffer.from(git(root, ["show", `${commit}:${path}`]))))
		throw new Error("MANIFEST_OWNER_SOURCE_DRIFT");
	return { bytes, location: locatedGit(root, commit, path) };
}

// Resolve only these fixed owner locations. Candidate locations never direct filesystem reads or execution.
export function resolveOwnerFacts({ writeEvidence = false } = {}) {
	const head = assertRetainedCurrent();
	const sourceFile = committedStackFile(sourceProofPath);
	const source = JSON.parse(sourceFile.bytes);
	verifySourceReport(source);
	if (source.id !== expectedSourceId) throw new Error("MANIFEST_SOURCE_PROOF_IDENTITY");
	const subject = {
		repository: source.repository.coordinate.repository,
		base: source.repository.base,
		head,
	};
	const bindingRefs = source.bindings.map((binding) => binding.id).sort();
	const authorities = [];
	function add(ref, kind, owner, schema, location, bytes, scope, sources = [location]) {
		const digest = hashBytes(bytes);
		authorities.push({
			reference: {
				ref,
				kind,
				owner,
				schema,
				location,
				digest,
				bindingRefs,
				provenance: { tool: "retained-evidence-owner-resolver", version: "1", scope, sources },
				freshness: {
					status: "current",
					subject: structuredClone(subject),
					authorityDigest: digest,
				},
			},
			subjectWitness: structuredClone(subject),
			authorityWitness: digest,
		});
	}
	const decisions = committedStackFile("docs/decisions/decisions.jsonl");
	const records = decisions.bytes
		.toString("utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (const id of ["D54", "D56", "D59"]) {
		const decision = currentDecision(records, id);
		add(
			`graphrefly-stack:${id}`,
			"decision",
			"graphrefly-stack",
			"graphrefly-stack/decision-jsonl-record",
			{ ...decisions.location, selector: `id=${id}` },
			canonicalize(decision),
			"Current locked Stack linkage and retained flagship decisions; JSONL record selected by exact id, digest over JCS record",
		);
	}
	const sourceLocation = locatedGit(retainedRoot, head, "src/refresh-session.ts");
	const verifierLocation = locatedGit(retainedRoot, head, "tests/business-verifier.mjs");
	const testLocation = locatedGit(retainedRoot, head, "tests/business.test.mjs");
	add(
		"refresh-session-fixture:policy-source",
		"policy",
		subject.repository,
		"typescript/5.9.3-source",
		sourceLocation,
		git(retainedRoot, ["show", `${head}:${sourceLocation.path}`]),
		"Test-fixture policy only: LoadTenantPolicy, EvaluateSessionPolicy and HTTP mapping in retained source; no production policy or approval",
	);
	add(
		"refresh-session-fixture:business-verifier",
		"verifier",
		subject.repository,
		"refresh-session/business-verifier-result",
		{ ...sourceFile.location, selector: "/verifier" },
		canonicalize(source.verifier),
		"Unmodified independently authored verifier result selected from verified retained source proof; digest over JCS result",
		[verifierLocation, sourceLocation, sourceFile.location],
	);
	add(
		"graphrefly-stack:source-binding-proof",
		"artifact",
		"graphrefly-stack",
		source.schema,
		sourceFile.location,
		sourceFile.bytes,
		"Exact prior source-bound proof bytes, independently verified against current execution",
	);

	const probe = spawnSync(
		process.execPath,
		[
			"--experimental-import-meta-resolve",
			resolve(root, "scripts/evidence-manifest/test-runtime.mjs"),
		],
		{
			cwd: consumerRoot,
			encoding: "utf8",
			timeout: 30000,
			maxBuffer: 1024 * 1024,
			env: { PATH: "/usr/bin:/bin" },
		},
	);
	if (probe.error || probe.signal || probe.status !== 0)
		throw new Error("MANIFEST_TEST_RUNTIME_FAILED");
	const runtime = JSON.parse(probe.stdout);
	if (runtime.version !== "0.8.0" || runtime.name !== source.runtime.name)
		throw new Error("MANIFEST_TEST_RUNTIME_MISMATCH");
	const command = ["--test", "--test-reporter=dot", "tests/business.test.mjs"];
	const execution = spawnSync(process.execPath, command, {
		cwd: consumerRoot,
		encoding: "utf8",
		timeout: 30000,
		maxBuffer: 1024 * 1024,
		env: {
			PATH: "/usr/bin:/bin",
			NO_COLOR: "1",
		},
	});
	if (execution.error || execution.signal || execution.status !== 0)
		throw new Error("MANIFEST_TEST_EXECUTION_FAILED");
	const result = {
		schema: "node-test/process-result/v1",
		command,
		workingDirectory: "examples/refresh-session-source-bound",
		runtime: {
			...runtime,
			installedFilesDigest: source.runtime.installedFilesDigest,
			lockIntegrity: source.runtime.lockIntegrity,
		},
		nodeVersion: process.version,
		subject,
		sourceDigest: hashBytes(git(retainedRoot, ["show", `${head}:${testLocation.path}`])),
		verifierDigest: source.verifier.sourceDigest,
		exitCode: execution.status,
		stdout: execution.stdout,
		stderr: execution.stderr,
	};
	const bytes = `${canonicalize(result)}\n`;
	const resultLocation = {
		repository: "graphrefly-stack:local-node-test",
		commit: null,
		occurrence: sha256Jcs(result),
		path: testResultPath,
		selector: null,
	};
	if (writeEvidence) {
		mkdirSync(resolve(root, ".private/evidence-manifest"), { recursive: true });
		writeFileSync(resolve(root, testResultPath), bytes);
	}
	if (readFileSync(resolve(root, testResultPath), "utf8") !== bytes)
		throw new Error("MANIFEST_TEST_RESULT_MISMATCH");
	add(
		"refresh-session-fixture:business-test",
		"test",
		"node:test",
		result.schema,
		resultLocation,
		bytes,
		"Node test process observation; exit code and dot reporter bytes remain at this occurrence, without Stack readiness translation",
		[testLocation, verifierLocation, sourceLocation],
	);
	if (assertRetainedCurrent() !== head) throw new Error("MANIFEST_EXECUTION_DRIFT");
	return {
		subject,
		blueprint: { version: source.blueprint.version, topologyHash: source.blueprint.hash.value },
		bindings: source.bindings,
		authorities,
	};
}
