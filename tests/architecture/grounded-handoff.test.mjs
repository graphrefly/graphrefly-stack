import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("grounded handoff stays on private subpaths with pure core and explicit adapters", () => {
	const contractsPackage = JSON.parse(readFileSync("packages/contracts/package.json", "utf8"));
	const corePackage = JSON.parse(readFileSync("packages/core/package.json", "utf8"));
	assert.equal(contractsPackage.exports["./grounded-handoff"], "./src/grounded-handoff.ts");
	assert.equal(corePackage.exports["./grounded-handoff"], "./src/grounded-handoff.ts");
	assert(!readFileSync("packages/contracts/src/index.ts", "utf8").includes("grounded-handoff"));
	assert(!readFileSync("packages/core/src/index.ts", "utf8").includes("grounded-handoff"));
	const core = readFileSync("packages/core/src/grounded-handoff.ts", "utf8");
	assert.doesNotMatch(core, /node:|packages\/cli|scripts\//u);
	for (const path of [
		"scripts/grounded-handoff/owner-evidence.mjs",
		"scripts/grounded-handoff/report.mjs",
	]) {
		const source = readFileSync(path, "utf8");
		assert.doesNotMatch(
			source,
			/codex-sdk|openai|fetch\(|https?:|GateResult\s*=|ReviewDecision\s*=/u,
		);
	}
});

test("frozen public roots, review UI, verification helper and historical bundles are not implementation dependencies", () => {
	for (const path of ["packages/contracts/src/index.ts", "packages/core/src/index.ts"])
		assert.doesNotMatch(readFileSync(path, "utf8"), /grounded-handoff/u);
	const report = readFileSync("scripts/grounded-handoff/report.mjs", "utf8");
	assert.doesNotMatch(report, /apps\/review|\.pilot\/check/u);
	assert.match(report, /verifyConsequenceReport/u);
	assert.match(report, /locateOwnerResult/u);
	assert.doesNotMatch(report, /writeFileSync\(|update-ref|checkout|switch/u);
});
