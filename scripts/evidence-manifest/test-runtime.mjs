import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { consumerRoot, hashBytes } from "../source-bound/git.mjs";

// Resolve from the actual test module, using the same ESM package export as the consumer source.
const entry = fileURLToPath(
	import.meta.resolve(
		"@graphrefly/ts",
		pathToFileURL(resolve(consumerRoot, "tests/business.test.mjs")).href,
	),
);
const expected = resolve(consumerRoot, "node_modules/@graphrefly/ts/dist/index.js");
const manifest = JSON.parse(
	readFileSync(resolve(consumerRoot, "node_modules/@graphrefly/ts/package.json")),
);
if (realpathSync(entry) !== realpathSync(expected) || manifest.version !== "0.8.0")
	throw new Error("MANIFEST_TEST_RUNTIME");
const runtime = await import(pathToFileURL(entry).href);
if (typeof runtime.graph !== "function") throw new Error("MANIFEST_TEST_RUNTIME_EXPORT");
process.stdout.write(
	JSON.stringify({
		name: manifest.name,
		version: manifest.version,
		entry: "node_modules/@graphrefly/ts/dist/index.js",
		entryDigest: hashBytes(readFileSync(entry)),
		resolutionBase: "tests/business.test.mjs",
	}),
);
