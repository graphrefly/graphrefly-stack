import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "../packages/contracts/dist/jcs.js";
import { buildReport, verifyReport } from "./grounded-handoff/report.mjs";
import { root } from "./source-bound/git.mjs";

function render(value) {
	return `${JSON.stringify(JSON.parse(canonicalize(value)), null, "\t")}\n`;
}

try {
	const args = process.argv.slice(2);
	let output;
	if (args.length === 0) output = await buildReport();
	else if (args.length === 1 && args[0] === "--write") {
		output = await buildReport();
		const directory = resolve(root, "evidence/runs/grounded-handoff");
		mkdirSync(directory, { recursive: true });
		writeFileSync(resolve(directory, "evidence-bundle.json"), render(output));
		writeFileSync(
			resolve(directory, "summary.json"),
			render({
				artifact_ref: output.artifact_ref,
				schema: output.schema,
				revision: output.revision,
				id: output.id,
				attemptId: output.attempt.id,
				consequenceProofId: output.consequenceReview.id,
				explanationIds: output.explanations.map((value) => value.id),
				proposalId: output.proposal.id,
				ownerResultId: output.ownerEvidence.result.id,
				ownerEvidenceCommit: output.ownerEvidence.coordinate.commit,
				ownerAxisBefore: output.reviewProjections[0].ownerEvidence,
				ownerAxisAfter: output.reviewProjections[1].ownerEvidence,
				ownerResultControls: output.ownerResultControls.map((control) => ({
					case: control.case,
					reason: control.projection.ownerEvidence.reason,
				})),
				compression: output.compression,
				llmRequired: output.llmRequired,
			}),
		);
		execFileSync("pnpm", ["exec", "biome", "format", "--write", directory], {
			cwd: root,
			stdio: "ignore",
		});
	} else if (args.length === 1 && args[0] === "--verify") {
		output = await verifyReport(
			JSON.parse(readFileSync("evidence/runs/grounded-handoff/evidence-bundle.json", "utf8")),
		);
	} else if (args.length === 2 && args[0] === "--verify") {
		output = await verifyReport(JSON.parse(readFileSync(args[1], "utf8")));
	} else throw new Error("GROUNDED_HANDOFF_ARGUMENTS");
	process.stdout.write(render(output));
} catch (error) {
	process.stdout.write(
		render({ ok: false, error: error instanceof Error ? error.message : String(error) }),
	);
	process.exitCode = 1;
}
