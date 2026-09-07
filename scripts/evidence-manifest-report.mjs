import { readFileSync } from "node:fs";
import { canonicalize } from "../packages/contracts/dist/jcs.js";
import { buildReport, verifyReport } from "./evidence-manifest/report.mjs";

try {
	const args = process.argv.slice(2);
	let output;
	if (args.length === 0) output = buildReport();
	else if (args.length === 2 && args[0] === "--verify")
		output = verifyReport(JSON.parse(readFileSync(args[1], "utf8")));
	else throw new Error("MANIFEST_ARGUMENTS");
	process.stdout.write(`${canonicalize(output)}\n`);
} catch (error) {
	process.stdout.write(
		`${canonicalize({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
	);
	process.exitCode = 1;
}
