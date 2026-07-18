import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "assets"), { recursive: true });

await build({
	entryPoints: [resolve(root, "packages/cli/dist/cli.js")],
	outfile: resolve(output, "grfs.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	external: ["@graphrefly/ts", "@graphrefly/ts/*", "@openai/codex-sdk"],
	logLevel: "warning",
});
await chmod(resolve(output, "grfs.js"), 0o755);

const copies = [
	["contracts/ci", "assets/contracts/ci"],
	["contracts/hosted", "assets/contracts/hosted"],
	["contracts/repository", "assets/contracts/repository"],
	["contracts/semantic", "assets/contracts/semantic"],
	["contracts/v1/schemas", "assets/contracts/v1/schemas"],
	["fixtures/contracts/v1/golden-suite.json", "assets/fixtures/contracts/v1/golden-suite.json"],
	["fixtures/contracts/semantic/v1", "assets/fixtures/contracts/semantic/v1"],
	["fixtures/contracts/ci/v1", "assets/fixtures/contracts/ci/v1"],
	["fixtures/contracts/hosted/v1", "assets/fixtures/contracts/hosted/v1"],
	[
		"fixtures/flagship/v1/repository-template.json",
		"assets/fixtures/flagship/v1/repository-template.json",
	],
	["apps/review/dist", "review"],
];

for (const [source, destination] of copies) {
	await mkdir(resolve(output, destination, ".."), { recursive: true });
	await cp(resolve(root, source), resolve(output, destination), { recursive: true });
}
