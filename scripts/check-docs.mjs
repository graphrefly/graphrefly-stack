import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const docsRoot = resolve(root, "docs");
const failures = [];

function jsonlFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) return jsonlFiles(path);
		return entry.name.endsWith(".jsonl") ? [path] : [];
	});
}

function readJsonl(path) {
	const rows = [];
	for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				failures.push(`${relative(root, path)}:${index + 1}: row must be an object`);
				continue;
			}
			if (typeof row.id !== "string" || row.id.length === 0) {
				failures.push(`${relative(root, path)}:${index + 1}: row needs a non-empty string id`);
			}
			rows.push(row);
		} catch (error) {
			failures.push(`${relative(root, path)}:${index + 1}: ${error.message}`);
		}
	}
	return rows;
}

const files = jsonlFiles(docsRoot);
const recordsByFile = new Map(files.map((path) => [relative(root, path), readJsonl(path)]));
const seenIds = new Map();

for (const [path, rows] of recordsByFile) {
	for (const row of rows) {
		if (seenIds.has(row.id))
			failures.push(`duplicate id ${row.id}: ${seenIds.get(row.id)} and ${path}`);
		seenIds.set(row.id, path);
	}
}

for (const [path, rows] of recordsByFile) {
	for (const row of rows) {
		if (!Array.isArray(row.refs)) continue;
		for (const ref of row.refs) {
			if (!seenIds.has(ref)) failures.push(`${path}:${row.id}: unknown ref ${ref}`);
		}
	}
}

const sourceRows = recordsByFile.get("docs/sources.jsonl") ?? [];
const registeredPaths = new Set();
const registeredConcerns = new Set();
for (const row of sourceRows) {
	if (row.authority !== "canonical") failures.push(`${row.id}: authority must be canonical`);
	if (typeof row.path !== "string" || typeof row.concern !== "string") {
		failures.push(`${row.id}: source row needs string path and concern fields`);
		continue;
	}
	if (registeredPaths.has(row.path))
		failures.push(`${row.id}: duplicate authority path ${row.path}`);
	if (registeredConcerns.has(row.concern))
		failures.push(`${row.id}: duplicate authority concern ${row.concern}`);
	registeredPaths.add(row.path);
	registeredConcerns.add(row.concern);
	if (!existsSync(resolve(root, row.path)))
		failures.push(`${row.id}: missing authority ${row.path}`);
}
for (const path of recordsByFile.keys()) {
	if (!registeredPaths.has(path))
		failures.push(`${path}: JSONL authority is not registered in docs/sources.jsonl`);
}

const phases = recordsByFile.get("docs/plan/phases.jsonl") ?? [];
const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
const allowedPhaseStates = new Set(["done", "ready", "blocked", "deferred"]);
const priorities = new Set();
for (const [index, phase] of phases.entries()) {
	if (!allowedPhaseStates.has(phase.status))
		failures.push(`${phase.id}: invalid phase status ${phase.status}`);
	if (!Number.isInteger(phase.priority)) failures.push(`${phase.id}: priority must be an integer`);
	if (priorities.has(phase.priority))
		failures.push(`${phase.id}: duplicate priority ${phase.priority}`);
	priorities.add(phase.priority);
	if (index > 0 && phase.priority <= phases[index - 1].priority) {
		failures.push(`${phase.id}: phases must be stored in increasing priority order`);
	}
	if (!Array.isArray(phase.deps)) failures.push(`${phase.id}: deps must be an array`);
	for (const dependency of phase.deps ?? []) {
		const dependencyPhase = phaseById.get(dependency);
		if (!dependencyPhase) {
			failures.push(`${phase.id}: unknown dependency ${dependency}`);
			continue;
		}
		if (dependencyPhase.priority >= phase.priority) {
			failures.push(`${phase.id}: dependency ${dependency} must have a lower priority`);
		}
		if (["done", "ready"].includes(phase.status) && dependencyPhase.status !== "done") {
			failures.push(`${phase.id}: ${phase.status} phase has incomplete dependency ${dependency}`);
		}
	}
}

const visiting = new Set();
const visited = new Set();
function visitPhase(phase) {
	if (visiting.has(phase.id)) {
		failures.push(`${phase.id}: dependency cycle detected`);
		return;
	}
	if (visited.has(phase.id)) return;
	visiting.add(phase.id);
	for (const dependency of phase.deps ?? []) {
		const dependencyPhase = phaseById.get(dependency);
		if (dependencyPhase) visitPhase(dependencyPhase);
	}
	visiting.delete(phase.id);
	visited.add(phase.id);
}
for (const phase of phases) visitPhase(phase);

const ready = phases.filter((phase) => phase.status === "ready");
const incomplete = phases.filter((phase) => !["done", "deferred"].includes(phase.status));
if (incomplete.length > 0 && ready.length !== 1) {
	failures.push(`canonical sequencer requires exactly one ready phase; found ${ready.length}`);
}
if (ready.length === 1) {
	const earliestIncomplete = incomplete.reduce((earliest, phase) =>
		phase.priority < earliest.priority ? phase : earliest,
	);
	if (ready[0].id !== earliestIncomplete.id) {
		failures.push(`${ready[0].id}: ready phase is not the earliest incomplete phase`);
	}
}

if (failures.length > 0) {
	console.error(failures.map((failure) => `- ${failure}`).join("\n"));
	process.exitCode = 1;
} else {
	console.log(
		`JSONL authorities valid: ${files.length} files, ${seenIds.size} records, next=${ready[0]?.id ?? "none"}`,
	);
}
