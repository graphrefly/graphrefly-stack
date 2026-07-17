import { spawnSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = resolve(root, ".private/fixtures/generic-linear-v1");
const gitEnvironment = {
	...process.env,
	GIT_AUTHOR_NAME: "GraphReFly Stack",
	GIT_AUTHOR_EMAIL: "stack@example.invalid",
	GIT_COMMITTER_NAME: "GraphReFly Stack",
	GIT_COMMITTER_EMAIL: "stack@example.invalid",
	GIT_AUTHOR_DATE: "2026-07-16T12:00:00Z",
	GIT_COMMITTER_DATE: "2026-07-16T12:00:00Z",
};

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: repository,
		encoding: "utf8",
		env: gitEnvironment,
	});
	if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
	return result.stdout.trim();
}

async function put(path, value) {
	const target = resolve(repository, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, value);
}

function commit(subject) {
	run("git", ["add", "-A"]);
	run("git", ["commit", "-m", subject]);
	return run("git", ["rev-parse", "HEAD"]);
}

const packageJson = {
	name: "graphrefly-stack-generic-sample",
	private: true,
	type: "module",
	dependencies: { "@graphrefly/ts": "0.3.x" },
};
const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@graphrefly/ts':
        specifier: 0.3.x
        version: 0.3.0

packages:

  '@graphrefly/ts@0.3.0':
    resolution: {integrity: sha512-JlGQyBvrKU9EK/1x0wTalNAEP8J6rc/v00RznEhg5BeXivyYnrR1P4a7ByvJSQPllaX/QW7nPpQffkCAM2MQPw==}

snapshots:

  '@graphrefly/ts@0.3.0': {}
`;
const states = [
	{
		subject: "create source graph",
		source: `import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "generic-sample" });
  application.state(1, { name: "source" });
  return application;
}
`,
	},
	{
		subject: "derive projected value",
		source: `import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "generic-sample" });
  const source = application.state(1, { name: "source" });
  application.derived([source], (value) => value + 1, { name: "derived" });
  return application;
}
`,
	},
	{
		subject: "mount audit graph",
		source: `import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "generic-sample" });
  const source = application.state(1, { name: "source" });
  application.derived([source], (value) => value + 1, { name: "derived" });
  const audit = graph({ name: "audit" });
  audit.state("ready", { name: "status", meta: { role: "observer" } });
  application.mount(audit, { at: "audit" });
  return application;
}
`,
	},
	{
		subject: "mark audit metadata validated",
		source: `import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "generic-sample" });
  const source = application.state(1, { name: "source" });
  application.derived([source], (value) => value + 1, { name: "derived" });
  const audit = graph({ name: "audit" });
  audit.state("ready", { name: "status", meta: { role: "validated-observer" } });
  application.mount(audit, { at: "audit" });
  return application;
}
`,
	},
];

await rm(repository, { recursive: true, force: true });
await mkdir(repository, { recursive: true });
run("git", ["init", "-b", "main"]);
await Promise.all([
	put(".gitignore", "node_modules\n"),
	put("package.json", `${JSON.stringify(packageJson, null, 2)}\n`),
	put("pnpm-lock.yaml", lockfile),
]);
await put("graph.mjs", states[0].source);
await symlink(resolve(root, "node_modules"), resolve(repository, "node_modules"), "dir");
run(process.execPath, [
	resolve(root, "packages/cli/dist/cli.js"),
	"init",
	"--repo",
	repository,
	"--graph-module",
	"graph.mjs",
	"--json",
]);
const commits = [];
for (const state of states) {
	await put("graph.mjs", state.source);
	commits.push({ subject: state.subject, oid: commit(state.subject) });
}

const result = {
	repository,
	base: commits[0].oid,
	head: commits.at(-1).oid,
	commits,
	command: `node ${resolve(root, "dist/grfs.js")} review --repo ${repository} --base ${commits[0].oid} --head ${commits.at(-1).oid}`,
};
await writeFile(
	resolve(repository, ".graphrefly-stack-sample.json"),
	`${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
