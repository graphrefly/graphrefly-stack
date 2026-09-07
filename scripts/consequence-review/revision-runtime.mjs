import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = process.argv[2];
if (!repository) throw new Error("CONSEQUENCE_RUNTIME_REPOSITORY");
const modules = await Promise.all(
	[
		"src/graph-root.ts",
		"src/session-store.ts",
		"src/response-mapping.ts",
		"src/refresh-session.ts",
	].map((path) => import(pathToFileURL(resolve(repository, path)).href)),
);
const consumer = Object.assign({}, ...modules);
const verifier = await import(
	pathToFileURL(resolve(repository, "tests/business-verifier.mjs")).href
);
const { createHash } = await import("node:crypto");
const runtime = await import(
	pathToFileURL(resolve(repository, "node_modules/@graphrefly/ts/dist/index.js")).href
);
const blueprint = await runtime.withBlueprintHash(consumer.RefreshSession.blueprint(), {
	algorithm: "sha256",
	hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
});
const exports = [];
for (const node of blueprint.topology.nodes) {
	const handle = consumer.RefreshSession.find(node.id);
	const names = Object.entries(consumer)
		.filter(([, value]) => value === handle)
		.map(([name]) => name);
	if (!handle || names.length !== 1) throw new Error(`CONSEQUENCE_RUNTIME_EXPORT: ${node.id}`);
	exports.push({ symbol: names[0], nodeId: node.id });
}
process.stdout.write(JSON.stringify({ blueprint, exports, business: verifier.verifyBusiness() }));
