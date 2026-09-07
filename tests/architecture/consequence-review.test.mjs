import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("consequence review stays private and pure while public roots and frozen surfaces remain untouched", () => {
	const contractsPackage = JSON.parse(readFileSync("packages/contracts/package.json", "utf8"));
	const corePackage = JSON.parse(readFileSync("packages/core/package.json", "utf8"));
	assert.equal(contractsPackage.exports["./consequence-review"], "./dist/consequence-review.js");
	assert.equal(corePackage.exports["./consequence-review"], "./dist/consequence-review.js");
	assert(!readFileSync("packages/contracts/src/index.ts", "utf8").includes("consequence-review"));
	assert(!readFileSync("packages/core/src/index.ts", "utf8").includes("consequence-review"));
	const core = readFileSync("packages/core/src/consequence-review.ts", "utf8");
	assert(!/node:|packages\/cli|scripts\//u.test(core));
	assert(!/runtime causality|observed runtime occurrence/iu.test(core));
});
