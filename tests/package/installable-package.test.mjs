import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../", import.meta.url));
const packageVersion = JSON.parse(
	await readFile(resolve(workspace, "package.json"), "utf8"),
).version;
const gitEnvironment = {
	...process.env,
	GIT_AUTHOR_NAME: "GraphReFly Stack package test",
	GIT_AUTHOR_EMAIL: "stack-package@example.invalid",
	GIT_COMMITTER_NAME: "GraphReFly Stack package test",
	GIT_COMMITTER_EMAIL: "stack-package@example.invalid",
};

function run(cwd, command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: gitEnvironment,
		maxBuffer: 32 * 1024 * 1024,
		...options,
	});
	assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

async function put(root, path, value) {
	const target = resolve(root, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, value, "utf8");
}

function commit(repository, subject) {
	run(repository, "git", ["add", "-A"]);
	run(repository, "git", ["commit", "-m", subject]);
	return run(repository, "git", ["rev-parse", "HEAD"]);
}

async function waitForServer(child) {
	return new Promise((resolveReady, rejectReady) => {
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			rejectReady(new Error(`Timed out waiting for review UI: ${stderr}`));
		}, 20_000);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			const match = stderr.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/u);
			if (match !== null) {
				clearTimeout(timeout);
				resolveReady(match[1]);
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			rejectReady(new Error(`Review UI exited ${code}: ${stderr}`));
		});
	});
}

test("the npm tarball installs and reviews an independent GraphReFly 0.3.x repository", async (context) => {
	const temporary = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-package-"));
	context.after(() => rm(temporary, { recursive: true, force: true }));
	const tarballs = resolve(temporary, "tarballs");
	const repository = resolve(temporary, "consumer-repository");
	await Promise.all([mkdir(tarballs), mkdir(repository)]);

	run(workspace, "pnpm", ["pack", "--pack-destination", tarballs, "--silent"]);
	const tarballFiles = (await readdir(tarballs)).filter((path) => path.endsWith(".tgz"));
	assert.deepEqual(tarballFiles, [`graphrefly-stack-${packageVersion}.tgz`]);
	const tarball = resolve(tarballs, tarballFiles[0]);
	const packedPaths = run(workspace, "tar", ["-tf", tarball]).split("\n");
	assert.equal(packedPaths.includes("package/dist/grfs.js"), true);
	assert.equal(packedPaths.includes("package/dist/review/index.html"), true);
	assert.equal(
		packedPaths.includes(
			"package/dist/assets/contracts/repository/v1/repository-config.schema.json",
		),
		true,
	);
	assert.equal(
		packedPaths.some((path) => path.startsWith("package/packages/")),
		false,
	);

	await Promise.all([
		put(repository, ".gitignore", "node_modules\n"),
		put(
			repository,
			"package.json",
			`${JSON.stringify(
				{
					name: "independent-graphrefly-consumer",
					private: true,
					type: "module",
					dependencies: { "@graphrefly/ts": "0.3.x" },
				},
				null,
				2,
			)}\n`,
		),
		put(
			repository,
			"src/application-graph.mjs",
			`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "installed-package-proof" });
  application.state(1, { name: "source" });
  return application;
}
`,
		),
	]);
	run(repository, "pnpm", ["install", "--ignore-scripts"]);
	run(repository, "git", ["init", "-b", "main"]);
	const base = commit(repository, "create existing GraphReFly repository");

	await put(
		repository,
		"src/application-graph.mjs",
		`import { graph } from "@graphrefly/ts/graph";
export function createApplicationGraph() {
  const application = graph({ name: "installed-package-proof" });
  const source = application.state(1, { name: "source" });
  application.derived([source], (value) => value + 1, { name: "projection" });
  return application;
}
`,
	);
	const head = commit(repository, "derive projection before Stack onboarding");

	const consumerPackage = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
	consumerPackage.devDependencies = { "@graphrefly/stack": `file:${tarball}` };
	await put(repository, "package.json", `${JSON.stringify(consumerPackage, null, 2)}\n`);
	run(repository, "pnpm", ["install", "--ignore-scripts"]);
	const packedCli = await realpath(
		resolve(repository, "node_modules/@graphrefly/stack/dist/grfs.js"),
	);
	const registryLayoutCli = resolve(repository, "registry-layout-grfs.js");
	await symlink(packedCli, registryLayoutCli);
	assert.match(run(repository, process.execPath, [registryLayoutCli, "--help"]), /Usage:/u);

	const initialized = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"init",
			"--graph-module",
			"src/application-graph.mjs",
			"--json",
		]),
	);
	assert.equal(initialized.ok, true);
	assert.equal(initialized.command, "init");
	assert.equal(initialized.data.entrypoint, "graphrefly-stack.blueprint.mjs");
	assert.equal(
		JSON.parse(await readFile(resolve(repository, ".graphrefly-stack.json"), "utf8")).blueprint
			.entrypoint,
		"graphrefly-stack.blueprint.mjs",
	);

	const reviewed = JSON.parse(
		run(repository, "pnpm", [
			"exec",
			"grfs",
			"review",
			"--repo",
			".",
			"--base",
			base,
			"--head",
			head,
			"--json",
		]),
	);
	assert.equal(reviewed.ok, true);
	assert.match(reviewed.data.repository.graphreflyVersion, /^0\.3\.\d+$/u);
	assert.deepEqual(
		reviewed.data.commits[0].delta.events.map((event) => event.type),
		["node-added", "edge-added"],
	);
	assert.deepEqual(reviewed.data.commits[0].diff.paths, ["src/application-graph.mjs"]);

	const server = spawn(
		"pnpm",
		["exec", "grfs", "review", "--repo", ".", "--base", base, "--head", head, "--port", "0"],
		{ cwd: repository, env: gitEnvironment, stdio: ["ignore", "pipe", "pipe"] },
	);
	context.after(() => server.kill("SIGTERM"));
	const url = await waitForServer(server);
	const [shellResponse, dataResponse] = await Promise.all([
		fetch(url),
		fetch(`${url}/api/review-data`),
	]);
	assert.equal(shellResponse.status, 200);
	assert.match(await shellResponse.text(), /<div id="root"><\/div>/u);
	assert.equal(dataResponse.status, 200);
	assert.equal((await dataResponse.json()).commits[0].oid, head);
	server.kill("SIGTERM");
});
