import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	canonicalTopologyBytes,
	withBlueprintHash,
} from "../../examples/refresh-session-source-bound/node_modules/@graphrefly/ts/dist/index.js";
import * as consumer from "../../examples/refresh-session-source-bound/src/refresh-session.ts";
import { verifyBusiness } from "../../examples/refresh-session-source-bound/tests/business-verifier.mjs";
import { sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { consumerRoot, hashBytes } from "./git.mjs";

const dependencyRoot = resolve(consumerRoot, "node_modules/@graphrefly/ts");
const manifest = JSON.parse(readFileSync(resolve(dependencyRoot, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(consumerRoot, "package-lock.json"), "utf8"));
if (
	manifest.version !== "0.8.0" ||
	lock.packages["node_modules/@graphrefly/ts"].version !== manifest.version
)
	throw new Error("SOURCE_RUNTIME_VERSION");
function filesAt(path, prefix = "") {
	return readdirSync(path, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name, "en"))
		.flatMap((entry) =>
			entry.isDirectory()
				? filesAt(resolve(path, entry.name), `${prefix}${entry.name}/`)
				: [
						{
							path: `${prefix}${entry.name}`,
							digest: hashBytes(readFileSync(resolve(path, entry.name))),
						},
					],
		);
}
const before = sha256Jcs(filesAt(dependencyRoot));
const blueprint = await withBlueprintHash(consumer.RefreshSession.blueprint(), {
	algorithm: "sha256",
	hash: hashBytes,
});
if (blueprint.hash.value !== hashBytes(canonicalTopologyBytes(blueprint.topology)))
	throw new Error("SOURCE_TOPOLOGY_HASH");
const exports = [];
for (const node of blueprint.topology.nodes) {
	const handle = consumer.RefreshSession.find(node.id);
	const names = Object.entries(consumer)
		.filter(([, value]) => value === handle)
		.map(([name]) => name);
	if (!handle || names.length !== 1) throw new Error("SOURCE_RUNTIME_EXPORT_IDENTITY");
	exports.push({ symbol: names[0], nodeId: node.id });
}
const business = verifyBusiness();
if (before !== sha256Jcs(filesAt(dependencyRoot))) throw new Error("SOURCE_RUNTIME_DRIFT");
process.stdout.write(
	JSON.stringify({
		blueprint,
		exports,
		business,
		runtime: {
			name: manifest.name,
			version: manifest.version,
			lockIntegrity: lock.packages["node_modules/@graphrefly/ts"].integrity,
			installedFilesDigest: before,
		},
	}),
);
