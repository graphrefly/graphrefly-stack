import ts from "../../examples/refresh-session-source-bound/node_modules/typescript/lib/typescript.js";
import { sha256Jcs } from "../../packages/contracts/dist/jcs.js";
import { assertSourceRecord, seal } from "../../packages/contracts/dist/source-bound.js";
import { resolveSource } from "../../packages/core/dist/source-bound.js";
import { hashBytes, readSources } from "./git.mjs";
export const resolver = { tool: "retained-typescript-declarations", version: "1/ts-5.9.3" };
if (ts.version !== "5.9.3") throw new Error("SOURCE_RESOLVER_VERSION");
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
export function inspectSources(files) {
	const candidates = [];
	const diagnostics = [];
	let supported = true;
	let complete = true;
	for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en"))) {
		if (!path.endsWith(".ts") || path.endsWith(".d.ts")) {
			supported = false;
			diagnostics.push(`unsupported language: ${path}`);
			continue;
		}
		const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
		if (source.parseDiagnostics.length) {
			complete = false;
			diagnostics.push(`parse failure: ${path}`);
			continue;
		}
		for (const statement of source.statements) {
			let name, kind;
			if (
				ts.isVariableStatement(statement) &&
				statement.declarationList.flags & ts.NodeFlags.Const &&
				statement.declarationList.declarations.length === 1 &&
				ts.isIdentifier(statement.declarationList.declarations[0].name)
			) {
				name = statement.declarationList.declarations[0].name.text;
				kind = "const";
			} else if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
				name = statement.name.text;
				kind = "function";
			} else if (
				ts.isImportDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement)
			)
				continue;
			else {
				supported = false;
				complete = false;
				diagnostics.push(`unsupported declaration syntax: ${path}`);
				continue;
			}
			candidates.push({
				path,
				symbol: { name, kind },
				fingerprint: {
					algorithm: "typescript-5.9.3-printer-v1",
					digest: sha256Jcs(printer.printNode(ts.EmitHint.Unspecified, statement, source)),
				},
				sourceDigest: hashBytes(text),
				start: statement.getStart(source),
				end: statement.end,
				authoritative: true,
			});
		}
	}
	if (candidates.length > 64 || diagnostics.length > 64) throw new Error("SOURCE_RESOLVER_LIMIT");
	return { candidates, diagnostics, supported, complete };
}
export function createAnchor(repository, target, path, symbol, overlay = null) {
	const scanned = inspectSources(readSources(repository, target, overlay));
	const candidates = scanned.candidates.filter((c) => c.path === path && c.symbol.name === symbol);
	if (!scanned.supported || !scanned.complete || candidates.length !== 1)
		throw new Error("SOURCE_ANCHOR_UNVERIFIABLE");
	return seal({
		schema: "graphrefly.stack.source-anchor.v1",
		coordinate: target,
		language: "typescript",
		candidate: candidates[0],
		provenance: resolver,
	});
}
export function resolveAt(
	repository,
	anchor,
	target,
	overlay = null,
	witness = target,
	originalOverlay = null,
) {
	assertSourceRecord(anchor);
	const original = createAnchor(
		repository,
		anchor.coordinate,
		anchor.candidate.path,
		anchor.candidate.symbol.name,
		originalOverlay,
	);
	if (original.id !== anchor.id) throw new Error("SOURCE_ORIGINAL_MISMATCH");
	const files = readSources(repository, target, overlay);
	const scanned = inspectSources(files);
	const facts = {
		target,
		candidates: scanned.candidates.filter(
			(c) =>
				c.symbol.name === anchor.candidate.symbol.name ||
				c.fingerprint.digest === anchor.candidate.fingerprint.digest,
		),
		originalFileExists: Object.hasOwn(files, anchor.candidate.path),
		supported: scanned.supported,
		complete: scanned.complete,
		witness,
		diagnostics: scanned.diagnostics,
		resolver,
	};
	return { facts, result: resolveSource(anchor, facts) };
}
