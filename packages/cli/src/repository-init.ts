import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { REPOSITORY_CONFIG_SCHEMA } from "@graphrefly-stack/contracts";

import { gitText } from "./system-git.js";

const configName = ".graphrefly-stack.json";
const adapterName = "graphrefly-stack.blueprint.mjs";

export class RepositoryInitError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RepositoryInitError";
	}
}

function repositoryPath(value: string, label: string): string {
	if (isAbsolute(value) || value.includes("\\")) {
		throw new RepositoryInitError("INIT_PATH_INVALID", `${label} must be repository-relative`);
	}
	const normalized = value.replace(/^\.\//u, "");
	if (
		normalized.length === 0 ||
		normalized.split("/").includes("..") ||
		!/^[A-Za-z0-9._/-]+$/u.test(normalized)
	) {
		throw new RepositoryInitError("INIT_PATH_INVALID", `${label} is not a safe repository path`);
	}
	return normalized;
}

async function assertWritableTarget(path: string, force: boolean): Promise<void> {
	try {
		await access(path);
		if (!force) {
			throw new RepositoryInitError(
				"INIT_ALREADY_EXISTS",
				`${relative(process.cwd(), path)} already exists; pass --force to replace it`,
			);
		}
	} catch (error) {
		if (error instanceof RepositoryInitError) throw error;
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function initializeRepository(options: {
	repository: string;
	graphModule: string;
	graphExport: string;
	force: boolean;
}) {
	let repository: string;
	try {
		const requested = await realpath(resolve(options.repository));
		repository = await realpath(gitText(requested, ["rev-parse", "--show-toplevel"]));
	} catch {
		throw new RepositoryInitError("REPOSITORY_INVALID", "Repository must be a local Git worktree");
	}
	const graphModule = repositoryPath(options.graphModule, "--graph-module");
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(options.graphExport)) {
		throw new RepositoryInitError(
			"INIT_EXPORT_INVALID",
			"--graph-export must be a JavaScript export name",
		);
	}
	const moduleTarget = resolve(repository, graphModule);
	if (moduleTarget !== repository && !moduleTarget.startsWith(`${repository}${sep}`)) {
		throw new RepositoryInitError("INIT_PATH_INVALID", "--graph-module escapes the repository");
	}
	try {
		await access(moduleTarget);
	} catch {
		throw new RepositoryInitError(
			"INIT_GRAPH_MODULE_MISSING",
			`Graph module was not found: ${graphModule}`,
		);
	}

	const configPath = resolve(repository, configName);
	const adapterPath = resolve(repository, adapterName);
	await Promise.all([
		assertWritableTarget(configPath, options.force),
		assertWritableTarget(adapterPath, options.force),
	]);
	const config = {
		schema: REPOSITORY_CONFIG_SCHEMA,
		blueprint: { entrypoint: adapterName },
	};
	const moduleSpecifier = `./${graphModule}`;
	const adapter = `import { createHash } from "node:crypto";
import { withBlueprintHash } from "@graphrefly/ts/graph";
import * as graphModule from ${JSON.stringify(moduleSpecifier)};

const exportedGraph = graphModule[${JSON.stringify(options.graphExport)}];
if (exportedGraph === undefined) {
  throw new Error(${JSON.stringify(`Graph module does not export ${options.graphExport}`)});
}
const applicationGraph = typeof exportedGraph === "function" ? await exportedGraph() : exportedGraph;
if (applicationGraph === null || typeof applicationGraph?.blueprint !== "function") {
  throw new Error("Configured export must be a Graph or a function returning a Graph");
}
const blueprint = withBlueprintHash(
  applicationGraph.blueprint({ diagnostics: true }),
  { algorithm: "sha256", hash: (bytes) => createHash("sha256").update(bytes).digest("hex") },
);
process.stdout.write(JSON.stringify(blueprint));
`;
	await Promise.all([
		writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8"),
		writeFile(adapterPath, adapter, "utf8"),
	]);
	const writtenConfig = JSON.parse(await readFile(configPath, "utf8")) as typeof config;
	return {
		repository,
		config: configName,
		entrypoint: writtenConfig.blueprint.entrypoint,
		graphModule,
		graphExport: options.graphExport,
	};
}
