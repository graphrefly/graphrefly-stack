import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256Jcs } from "@graphrefly-stack/contracts";

import { repositoryStateDirectory } from "./repository-review-state.js";

const schema = "graphrefly.stack.dag-execution-cache.v1";

type CacheEnvelope = {
	schema: typeof schema;
	kind: string;
	key: string;
	input: unknown;
	valueDigest: string;
	value: unknown;
};

export class DagExecutionCacheError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagExecutionCacheError";
	}
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new DagExecutionCacheError("DAG execution cache entry must be an object");
	}
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new DagExecutionCacheError("DAG execution cache entry has unexpected fields");
	}
}

async function cachePath(repository: string, kind: string, key: string): Promise<string> {
	const directory = await repositoryStateDirectory(repository, "dag-execution", kind);
	return resolve(directory, `${key}.json`);
}

function parseEnvelope(raw: string, kind: string, key: string, input: unknown): CacheEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new DagExecutionCacheError("DAG execution cache entry is malformed JSON");
	}
	const envelope = object(parsed);
	exactKeys(envelope, ["schema", "kind", "key", "input", "valueDigest", "value"]);
	if (
		envelope.schema !== schema ||
		envelope.kind !== kind ||
		envelope.key !== key ||
		sha256Jcs(envelope.input) !== key ||
		sha256Jcs(envelope.input) !== sha256Jcs(input) ||
		envelope.valueDigest !== sha256Jcs(envelope.value)
	) {
		throw new DagExecutionCacheError("DAG execution cache entry violates its content address");
	}
	return envelope as CacheEnvelope;
}

export async function readDagExecutionCache(
	repository: string,
	kind: string,
	input: unknown,
): Promise<{ hit: false; key: string } | { hit: true; key: string; value: unknown }> {
	const key = sha256Jcs(input);
	const path = await cachePath(repository, kind, key);
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new DagExecutionCacheError("DAG execution cache path is not a regular file");
		}
		const envelope = parseEnvelope(await readFile(path, "utf8"), kind, key, input);
		return { hit: true, key, value: envelope.value };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hit: false, key };
		throw error;
	}
}

export async function writeDagExecutionCache(
	repository: string,
	kind: string,
	input: unknown,
	value: unknown,
): Promise<void> {
	const key = sha256Jcs(input);
	const path = await cachePath(repository, kind, key);
	const envelope: CacheEnvelope = {
		schema,
		kind,
		key,
		input,
		valueDigest: sha256Jcs(value),
		value,
	};
	try {
		await writeFile(path, `${JSON.stringify(envelope)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = await readDagExecutionCache(repository, kind, input);
		if (!existing.hit || sha256Jcs(existing.value) !== sha256Jcs(value)) {
			throw new DagExecutionCacheError("Concurrent DAG execution cache value disagrees");
		}
	}
}
