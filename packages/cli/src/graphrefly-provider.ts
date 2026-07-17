import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { graphreflyTopologyHash } from "@graphrefly-stack/core";

import { gitText } from "./system-git.js";

export interface DerivedFixtureBlueprint {
	policyRevision: string;
	blueprint: {
		version: "graphrefly.blueprint.v1";
		topology: Record<string, unknown>;
		diagnostics: { ok: boolean; issues: unknown[] };
		provenance: Record<string, unknown>;
		hash: { kind: "topology"; algorithm: string; input: string; value: string };
	};
	diagram: {
		format: "mermaid";
		source: string;
		renderer: "@graphrefly/ts/render.describeToMermaid";
	};
}

export interface FixtureCheckResult {
	schema: "urn:graphrefly-stack:schema:check-result:v1";
	checkId: string;
	command: string[];
	exitCode: number;
	stdoutDigest: { algorithm: "sha256"; value: string };
	stderrDigest: { algorithm: "sha256"; value: string };
}

function digest(value: string) {
	return { algorithm: "sha256" as const, value: createHash("sha256").update(value).digest("hex") };
}

const packageRequire = createRequire(import.meta.url);

function historicalGraphReFlyRequire(): NodeRequire {
	try {
		return createRequire(packageRequire.resolve("@graphrefly-stack/core"));
	} catch {
		return packageRequire;
	}
}

function graphreflyRuntime() {
	const graphreflyRequire = historicalGraphReFlyRequire();
	const graph = graphreflyRequire.resolve("@graphrefly/ts/graph");
	const operators = graphreflyRequire.resolve("@graphrefly/ts/operators");
	const render = graphreflyRequire.resolve("@graphrefly/ts/render");
	return {
		graph,
		operators,
		render,
		packageRoot: resolve(dirname(graph), "../.."),
	};
}

function scrubbedEnvironment(worktree: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		HOME: worktree,
		LANG: "C",
		LC_ALL: "C",
		PATH: process.env.PATH,
		TZ: "UTC",
		...extra,
	};
}

export function assertDiagramProjectsTopology(topology: Record<string, unknown>, source: string) {
	const nodes = Array.isArray(topology.nodes) ? topology.nodes : [];
	const edges = Array.isArray(topology.edges) ? topology.edges : [];
	const aliases = new Map<string, string>();
	const diagramEdges: [string, string][] = [];
	for (const line of source.split("\n").slice(1)) {
		const node = line.match(/^\s*([A-Za-z0-9_]+)\[("(?:\\.|[^"])*")\]\s*$/);
		if (node !== null) {
			aliases.set(node[1] as string, JSON.parse(node[2] as string) as string);
			continue;
		}
		const edge = line.match(/^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)\s*$/);
		if (edge !== null) diagramEdges.push([edge[1] as string, edge[2] as string]);
	}
	const topologyNodeIds = nodes.map((node) => {
		if (typeof node !== "object" || node === null || typeof node.id !== "string") {
			throw new Error("GraphReFly Blueprint contains an invalid node");
		}
		return node.id;
	});
	const topologyEdges = edges.map((edge) => {
		if (
			typeof edge !== "object" ||
			edge === null ||
			typeof edge.from !== "string" ||
			typeof edge.to !== "string"
		) {
			throw new Error("GraphReFly Blueprint contains an invalid edge");
		}
		return `${edge.from}\u0000${edge.to}`;
	});
	const projectedEdges = diagramEdges.map(([fromAlias, toAlias]) => {
		const from = aliases.get(fromAlias);
		const to = aliases.get(toAlias);
		if (from === undefined || to === undefined) {
			throw new Error("GraphReFly diagram references an unknown node alias");
		}
		return `${from}\u0000${to}`;
	});
	const sorted = (values: string[]) => [...values].sort().join("\n");
	if (
		sorted([...aliases.values()]) !== sorted(topologyNodeIds) ||
		sorted(projectedEdges) !== sorted(topologyEdges)
	) {
		throw new Error("GraphReFly diagram is not a projection of the runtime blueprint topology");
	}
}

export async function deriveFixtureBlueprint(
	repository: string,
	revision: string,
): Promise<DerivedFixtureBlueprint> {
	const worktreeRoot = resolve(
		dirname(repository),
		`.graphrefly-stack-worktrees-${basename(repository)}`,
	);
	const worktree = resolve(worktreeRoot, revision.replace(/[^a-zA-Z0-9_.-]/g, "_"));
	await mkdir(worktreeRoot, { recursive: true });
	await rm(worktree, { recursive: true, force: true });
	gitText(repository, ["worktree", "add", "--detach", "--force", worktree, revision]);
	try {
		const canonicalWorktree = await realpath(worktree);
		const entrypoint = resolve(canonicalWorktree, "graphrefly-fixture.mjs");
		const runtime = graphreflyRuntime();
		const packageRoot = await realpath(runtime.packageRoot);
		const result = spawnSync(
			process.execPath,
			[
				"--permission",
				`--allow-fs-read=${canonicalWorktree}`,
				`--allow-fs-read=${packageRoot}`,
				"--disable-warning=ExperimentalWarning",
				entrypoint,
			],
			{
				cwd: canonicalWorktree,
				encoding: "utf8",
				env: scrubbedEnvironment(canonicalWorktree, {
					GRAPHREFLY_GRAPH_MODULE_URL: pathToFileURL(runtime.graph).href,
					GRAPHREFLY_OPERATORS_MODULE_URL: pathToFileURL(runtime.operators).href,
					GRAPHREFLY_RENDER_MODULE_URL: pathToFileURL(runtime.render).href,
					GRAPHREFLY_STACK_REVISION: revision,
					GRAPHREFLY_STACK_ISOLATION: "detached-worktree-node-permission-read-only",
				}),
				maxBuffer: 1024 * 1024,
				shell: false,
				timeout: 5_000,
			},
		);
		if (result.error !== undefined) throw result.error;
		if (result.status !== 0) {
			throw new Error(
				result.stderr.trim() || `GraphReFly fixture provider exited ${result.status}`,
			);
		}
		const parsed = JSON.parse(result.stdout) as DerivedFixtureBlueprint;
		if (
			typeof parsed.policyRevision !== "string" ||
			parsed.blueprint?.version !== "graphrefly.blueprint.v1" ||
			typeof parsed.blueprint.topology !== "object" ||
			parsed.blueprint.topology === null ||
			parsed.blueprint.diagnostics?.ok !== true ||
			parsed.blueprint.hash?.input !== "strictCanonicalTopologyBytes" ||
			parsed.diagram?.format !== "mermaid" ||
			parsed.diagram.renderer !== "@graphrefly/ts/render.describeToMermaid" ||
			!parsed.diagram.source.startsWith("flowchart ")
		) {
			throw new Error("GraphReFly fixture provider returned an invalid payload");
		}
		if (parsed.blueprint.hash.value !== graphreflyTopologyHash(parsed.blueprint.topology)) {
			throw new Error("GraphReFly fixture provider returned a non-canonical topology hash");
		}
		assertDiagramProjectsTopology(parsed.blueprint.topology, parsed.diagram.source);
		return parsed;
	} finally {
		gitText(repository, ["worktree", "remove", "--force", worktree]);
		await rm(worktree, { recursive: true, force: true });
	}
}

export async function runFixtureChecks(
	repository: string,
	revision: string,
	checkIds: readonly string[],
): Promise<FixtureCheckResult[]> {
	const worktreeRoot = resolve(
		dirname(repository),
		`.graphrefly-stack-worktrees-${basename(repository)}`,
	);
	const worktree = resolve(worktreeRoot, `${revision.replace(/[^a-zA-Z0-9_.-]/g, "_")}-checks`);
	await mkdir(worktreeRoot, { recursive: true });
	await rm(worktree, { recursive: true, force: true });
	gitText(repository, ["worktree", "add", "--detach", "--force", worktree, revision]);
	try {
		const canonicalWorktree = await realpath(worktree);
		const entrypoint = resolve(canonicalWorktree, "fixture-check.mjs");
		const checks = checkIds.map((checkId): FixtureCheckResult => {
			const result = spawnSync(
				process.execPath,
				[
					"--permission",
					`--allow-fs-read=${canonicalWorktree}`,
					"--disable-warning=ExperimentalWarning",
					entrypoint,
					checkId,
				],
				{
					cwd: canonicalWorktree,
					encoding: "utf8",
					env: scrubbedEnvironment(canonicalWorktree),
					maxBuffer: 1024 * 1024,
					shell: false,
					timeout: 5_000,
				},
			);
			if (result.error !== undefined) throw result.error;
			return {
				schema: "urn:graphrefly-stack:schema:check-result:v1",
				checkId,
				command: ["node", "fixture-check.mjs", checkId],
				exitCode: result.status ?? 1,
				stdoutDigest: digest(result.stdout),
				stderrDigest: digest(result.stderr),
			};
		});
		const failed = checks.find((check) => check.exitCode !== 0);
		if (failed !== undefined) throw new Error(`Fixture check failed: ${failed.checkId}`);
		return checks;
	} finally {
		gitText(repository, ["worktree", "remove", "--force", worktree]);
		await rm(worktree, { recursive: true, force: true });
	}
}
