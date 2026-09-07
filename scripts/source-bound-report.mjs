import { readFileSync } from "node:fs";
import { canonicalize } from "../packages/contracts/dist/jcs.js";
import { retainedRoot, setupRetained } from "./source-bound/git.mjs";
import { buildReport, verifyReport } from "./source-bound/report.mjs";
import { resolveAt } from "./source-bound/resolver.mjs";

try {
	const args = process.argv.slice(2);
	let output;
	if (args.length === 0) output = buildReport();
	else if (args.length === 1 && args[0] === "--setup") {
		setupRetained();
		output = buildReport();
	} else if (args.length === 2 && args[0] === "--verify")
		output = verifyReport(JSON.parse(readFileSync(args[1], "utf8")));
	else if (args.length === 2 && args[0] === "--resolve") {
		const request = JSON.parse(readFileSync(args[1], "utf8"));
		if (
			Object.keys(request).some(
				(key) => !["anchor", "target", "overlay", "witness", "originalOverlay"].includes(key),
			)
		)
			throw new Error("SOURCE_REQUEST_SCHEMA");
		output = resolveAt(
			retainedRoot,
			request.anchor,
			request.target,
			request.overlay ?? null,
			request.witness === undefined ? request.target : request.witness,
			request.originalOverlay ?? null,
		).result;
	} else throw new Error("SOURCE_ARGUMENTS");
	process.stdout.write(`${canonicalize(output)}\n`);
} catch (error) {
	process.stdout.write(
		`${canonicalize({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
	);
	process.exitCode = 1;
}
