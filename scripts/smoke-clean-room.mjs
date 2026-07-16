import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const cleanRoom = mkdtempSync(join(tmpdir(), "graphrefly-stack-smoke-"));

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: cleanRoom,
		encoding: "utf8",
		env: { ...process.env, CI: "1" },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
	}
}

try {
	const publicFiles = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: workspace },
	)
		.toString("utf8")
		.split("\0")
		.filter(Boolean);

	for (const relative of publicFiles) {
		const destination = join(cleanRoom, relative);
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(join(workspace, relative), destination);
	}

	run("corepack", ["pnpm", "install", "--frozen-lockfile"]);
	run("corepack", ["pnpm", "check"]);
	run("corepack", ["pnpm", "cli", "fixture", "create", "--force", "--json"]);
	run("corepack", ["pnpm", "cli", "gate", "--case", "current-valid", "--json"]);
	run("corepack", ["pnpm", "cli", "gate", "--case", "fresh-selective-replan", "--json"]);
	process.stdout.write(`Clean-room smoke passed with ${publicFiles.length} public files.\n`);
} finally {
	rmSync(cleanRoom, { recursive: true, force: true });
}
