import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "../../examples/refresh-session-source-bound/node_modules/typescript/lib/typescript.js";

const root = resolve(import.meta.dirname, "../..");
function imports(path) {
	const text = readFileSync(resolve(root, path), "utf8");
	const ast = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true);
	const modules = [];
	function visit(node) {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
			modules.push(node.moduleSpecifier.text);
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
			modules.push(node.arguments[0]?.text ?? "unknown-dynamic-import");
		ts.forEachChild(node, visit);
	}
	visit(ast);
	return modules;
}
test("strict contracts and pure binding/gate/recovery logic have no adapter or UI dependency", () => {
	const core = readdirSync(resolve(root, "packages/core/src"))
		.filter((x) => x.endsWith(".ts"))
		.map((x) => `packages/core/src/${x}`);
	const contracts = readdirSync(resolve(root, "packages/contracts/src"))
		.filter((x) => x.endsWith(".ts"))
		.map((x) => `packages/contracts/src/${x}`);
	for (const path of [...core, ...contracts]) {
		for (const dependency of imports(path)) {
			assert.ok(
				dependency.startsWith("./") ||
					dependency.startsWith("../dist/schemas/") ||
					dependency.startsWith("@graphrefly-stack/contracts") ||
					dependency === "@graphrefly/ts" ||
					dependency === "@graphrefly/ts/graph" ||
					dependency === "node:crypto" ||
					dependency === "ajv",
				`${path}: forbidden dependency ${dependency}`,
			);
			assert.doesNotMatch(
				dependency,
				/(?:packages\/(?:cli|hosted)|provider|scripts|apps|node:fs|node:child_process)/,
			);
		}
	}
	assert.deepEqual(imports("packages/core/src/source-bound.ts").sort(), [
		"@graphrefly-stack/contracts/jcs",
		"@graphrefly-stack/contracts/source-bound",
	]);
});
test("private source linkage cannot enter generic public runner or public core exports", () => {
	for (const path of [
		"packages/core/src/index.ts",
		"packages/contracts/src/index.ts",
		"packages/cli/src/cli.ts",
		"scripts/build-package.mjs",
	])
		assert.doesNotMatch(
			readFileSync(resolve(root, path), "utf8"),
			/(?:source-bound|evidence-manifest)/,
		);
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	assert.equal(pkg.peerDependencies["@graphrefly/ts"], ">=0.3.0 <0.4.0");
	assert.equal(pkg.devDependencies["@graphrefly/ts"], "0.3.0");
});
test("source-bound report is an explicit composition root; review and verifier cannot rewrite gate or repository truth", () => {
	assert.ok(
		imports("scripts/source-bound/report.mjs").includes("../../packages/core/dist/source-bound.js"),
	);
	for (const path of [
		"packages/core/src/dag-review.ts",
		"packages/core/src/multi-plan-projection.ts",
	]) {
		for (const dependency of imports(path))
			assert.doesNotMatch(dependency, /(?:cli|hosted|provider|scripts|node:fs|node:child_process)/);
		assert.doesNotMatch(
			readFileSync(resolve(root, path), "utf8"),
			/(?:writeFile|execFile|spawnSync)/,
		);
	}
	for (const path of [
		"scripts/source-bound/report.mjs",
		"scripts/source-bound/resolver.mjs",
		"scripts/source-bound/runtime.mjs",
	])
		assert.doesNotMatch(
			readFileSync(resolve(root, path), "utf8"),
			/(?:codex-sdk|openai|fetch\(|https?:|writeFile|GateResult\s*=|ReviewDecision\s*=)/,
		);
});

test("fresh bootstrap, CI, release and clean-room smoke install the independent locked consumer", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
	assert.equal(
		pkg.scripts["setup:source-bound"],
		"npm --prefix examples/refresh-session-source-bound ci --ignore-scripts --no-audit --no-fund",
	);
	for (const path of [".mise.toml", ".github/workflows/ci.yml", ".github/workflows/release.yml"])
		assert.match(readFileSync(resolve(root, path), "utf8"), /pnpm setup:source-bound/);
	assert.match(
		readFileSync(resolve(root, "scripts/smoke-clean-room.mjs"), "utf8"),
		/\["pnpm", "setup:source-bound"\]/,
	);
	const readme = readFileSync(
		resolve(root, "examples/refresh-session-source-bound/README.md"),
		"utf8",
	);
	assert.ok(readme.indexOf("mkdir -p .pilot/evidence") < readme.indexOf("> .pilot/evidence"));
});

test("evidence manifest pure core has only private contracts and its adapter remains local", () => {
	assert.deepEqual(imports("packages/core/src/evidence-manifest.ts").sort(), [
		"@graphrefly-stack/contracts/evidence-manifest",
		"@graphrefly-stack/contracts/jcs",
		"@graphrefly-stack/contracts/source-bound",
	]);
	assert.ok(
		imports("scripts/evidence-manifest/report.mjs").includes(
			"../../packages/core/dist/evidence-manifest.js",
		),
	);
	for (const path of [
		"scripts/evidence-manifest/report.mjs",
		"scripts/evidence-manifest/owners.mjs",
	])
		assert.doesNotMatch(
			readFileSync(resolve(root, path), "utf8"),
			/(?:codex-sdk|openai|fetch\(|https?:|GateResult\s*=|ReviewDecision\s*=)/,
		);
});
