import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize, sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { bindSource, verifyBinding } from "../../packages/core/dist/source-bound.js";
import {
	assertRetainedCurrent,
	coordinate,
	fullCommit,
	git,
	hashBytes,
	retainedRoot,
	root,
} from "./git.mjs";
import { createAnchor, resolveAt } from "./resolver.mjs";

const proofIdentity = {
	artifact_ref: "graphrefly-stack:source-binding-proof",
	schema: "graphrefly-stack/source-binding-proof/v1",
	revision: "stack-source-v1",
};
export function buildReport() {
	const head = assertRetainedCurrent();
	const base = git(retainedRoot, ["show", `${head}:proof-base.txt`]).trim();
	fullCommit(retainedRoot, base);
	if (git(retainedRoot, ["rev-parse", `${head}^`]).trim() !== base)
		throw new Error("SOURCE_BASE_LINEAGE");
	const target = coordinate(retainedRoot, head);
	const output = JSON.parse(
		execFileSync(process.execPath, [resolve(root, "scripts/source-bound/runtime.mjs")], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
			timeout: 30000,
			env: { PATH: "/usr/bin:/bin" },
		}),
	);
	if (assertRetainedCurrent() !== head) throw new Error("SOURCE_EXECUTION_DRIFT");
	const runtimeFacts = {
		coordinate: target,
		blueprintVersion: output.blueprint.version,
		topologyHash: output.blueprint.hash.value,
		nodeIds: output.blueprint.topology.nodes.map((node) => node.id),
		exports: output.exports,
		provenance: { tool: "retained-export-runtime-identity", version: "1/@graphrefly/ts-0.8.0" },
	};
	const anchors = [],
		resolutions = [],
		bindings = [];
	for (const exported of output.exports) {
		const anchor = createAnchor(retainedRoot, target, "src/refresh-session.ts", exported.symbol);
		const { facts, result } = resolveAt(retainedRoot, anchor, target);
		const binding = bindSource(anchor, result, facts, runtimeFacts);
		verifyBinding(binding, anchor, result, facts, runtimeFacts);
		anchors.push(anchor);
		resolutions.push(result);
		bindings.push(binding);
	}
	const verifierPath = "tests/business-verifier.mjs";
	const report = {
		...proofIdentity,
		repository: { base, head, coordinate: target },
		runtime: output.runtime,
		blueprint: output.blueprint,
		anchors,
		resolutions,
		bindings,
		verifier: {
			...output.business,
			path: verifierPath,
			sourceDigest: hashBytes(git(retainedRoot, ["show", `${head}:${verifierPath}`])),
			coordinate: target,
			freshness: "current",
		},
		adapter: {
			tool: "source-bound-report",
			version: "1",
			sourceDigest: sha256Jcs(
				[
					"scripts/source-bound-report.mjs",
					"scripts/source-bound/report.mjs",
					"scripts/source-bound/resolver.mjs",
					"scripts/source-bound/git.mjs",
					"scripts/source-bound/runtime.mjs",
					"packages/core/src/source-bound.ts",
					"packages/contracts/src/source-bound.ts",
					"packages/core/dist/source-bound.js",
					"packages/contracts/dist/source-bound.js",
					"packages/contracts/dist/jcs.js",
					"contracts/source-bound/v1/anchor.schema.json",
					"contracts/source-bound/v1/resolution.schema.json",
					"contracts/source-bound/v1/binding.schema.json",
					"examples/refresh-session-source-bound/node_modules/typescript/lib/typescript.js",
				].map((path) => ({ path, digest: hashBytes(readFileSync(resolve(root, path))) })),
			),
		},
		coverage: {
			boundNodes: bindings.length,
			totalNodes: output.blueprint.topology.nodes.length,
			scope:
				"Top-level TypeScript const/function declarations under src; exact exported node handles in retained RefreshSession only",
			limits: [
				"128 Git entries, 1 MiB source, 64 candidates and diagnostics",
				"No source edge bindings, generic resolver, runtime causality, consequence review or whole E22 completion",
				"Runtime execution is restricted to the retained trusted example; arbitrary target revisions resolve without execution",
				"Dependency install required before offline reruns; npm lock integrity and installed bytes are reported",
			],
		},
		llmRequired: false,
	};
	return { ...report, id: sha256Jcs(report) };
}
export function verifyReport(value) {
	if (Object.entries(proofIdentity).some(([key, expected]) => value?.[key] !== expected))
		throw new Error("SOURCE_REPORT_IDENTITY");
	if (canonicalize(value) !== canonicalize(buildReport()))
		throw new Error("SOURCE_REPORT_MISMATCH");
	return { verified: true, id: value.id };
}
