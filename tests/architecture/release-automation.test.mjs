import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function readJson(path) {
	return JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
}

test("Changesets owns only the public root package release intent", () => {
	const packageJson = readJson("package.json");
	const config = readJson(".changeset/config.json");

	assert.equal(packageJson.name, "@graphrefly/stack");
	assert.equal(packageJson.private, false);
	assert.equal(packageJson.publishConfig.access, "public");
	assert.equal(packageJson.scripts.changeset, "changeset");
	assert.equal(packageJson.scripts["version-packages"], "changeset version");
	assert.equal(packageJson.scripts.release, "changeset publish");
	assert.equal(packageJson.scripts.prepack, "pnpm build:package");
	assert.equal(config.changelog, "@changesets/changelog-git");
	assert.equal(config.access, "public");
	assert.equal(config.baseBranch, "main");
	assert.deepEqual(config.ignore, []);
});

test("CI is read-only and release authority is isolated to non-cancelling main pushes", () => {
	const ci = readFileSync(join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
	const release = readFileSync(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");

	assert.match(ci, /pull_request:\n\s+branches: \[main\]/);
	assert.match(ci, /permissions:\n\s+contents: read/);
	assert.match(ci, /runs-on: ubuntu-22\.04/);
	assert.doesNotMatch(ci, /runs-on: ubuntu-(?:latest|24\.04)/);
	assert.match(ci, /pnpm install --frozen-lockfile/);
	assert.match(ci, /apt-get install --yes --no-install-recommends bubblewrap/);
	assert.match(ci, /test -x \/usr\/bin\/bwrap/);
	assert.match(ci, /run: pnpm check/);
	assert.doesNotMatch(ci, /id-token: write|contents: write|pull-requests: write/);
	assert.doesNotMatch(ci, /uses: [^\n]+@v[0-9]+/u);
	assert.equal([...ci.matchAll(/uses: [^@\n]+@([0-9a-f]{40})/gu)].length, 3);

	assert.match(release, /push:\n\s+branches: \[main\]/);
	assert.doesNotMatch(release, /pull_request:/);
	assert.match(release, /cancel-in-progress: false/);
	assert.match(release, /contents: write/);
	assert.match(release, /pull-requests: write/);
	assert.match(release, /id-token: write/);
	assert.match(release, /runs-on: ubuntu-22\.04/);
	assert.doesNotMatch(release, /runs-on: ubuntu-(?:latest|24\.04)/);
	assert.match(release, /actions\/create-github-app-token@[0-9a-f]{40} # v3\.2\.0/);
	assert.match(release, /fetch-depth: 0/);
	assert.match(release, /registry-url: "https:\/\/registry\.npmjs\.org"/);
	assert.match(release, /apt-get install --yes --no-install-recommends bubblewrap/);
	assert.match(release, /test -x \/usr\/bin\/bwrap/);
	assert.doesNotMatch(release, /\bNPM_TOKEN\b/);
	assert.doesNotMatch(release, /uses: [^\n]+@v[0-9]+/u);
	assert.equal([...release.matchAll(/uses: [^@\n]+@([0-9a-f]{40})/gu)].length, 5);
	assert.match(release, /uses: changesets\/action@[0-9a-f]{40} # v1\.9\.0/);
	assert.match(release, /publish: pnpm run release/);
	assert.match(release, /version: pnpm run version-packages/);
	assert.ok(
		release.indexOf("run: pnpm check") < release.indexOf("uses: changesets/action@"),
		"complete checks must precede the release action",
	);
});

test("a synthetic root changeset produces the next patch and changelog in isolation", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "graphrefly-stack-changeset-"));
	const skippedNames = new Set([".git", ".private", "dist", "node_modules", ".DS_Store"]);

	try {
		cpSync(repositoryRoot, temporaryRoot, {
			recursive: true,
			filter: (source) => !skippedNames.has(basename(source)),
		});

		const changesetDirectory = join(temporaryRoot, ".changeset");
		for (const file of readdirSync(changesetDirectory)) {
			if (file.endsWith(".md") && file !== "README.md") {
				unlinkSync(join(changesetDirectory, file));
			}
		}
		writeFileSync(
			join(changesetDirectory, "release-automation-test.md"),
			'---\n"@graphrefly/stack": patch\n---\n\nSynthetic release automation proof.\n',
		);

		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: temporaryRoot });
		execFileSync("git", ["config", "user.name", "GraphReFly Stack QA"], {
			cwd: temporaryRoot,
		});
		execFileSync("git", ["config", "user.email", "qa@example.invalid"], {
			cwd: temporaryRoot,
		});
		execFileSync("git", ["add", "."], { cwd: temporaryRoot });
		execFileSync("git", ["commit", "-qm", "test: release automation fixture"], {
			cwd: temporaryRoot,
		});

		const before = JSON.parse(readFileSync(join(temporaryRoot, "package.json"), "utf8"));
		const [major, minor, patch] = before.version.split(".").map(Number);
		execFileSync(join(repositoryRoot, "node_modules/.bin/changeset"), ["version"], {
			cwd: temporaryRoot,
			stdio: "pipe",
		});
		const after = JSON.parse(readFileSync(join(temporaryRoot, "package.json"), "utf8"));
		const changelog = readFileSync(join(temporaryRoot, "CHANGELOG.md"), "utf8");

		assert.equal(after.version, `${major}.${minor}.${patch + 1}`);
		assert.match(changelog, /Synthetic release automation proof/);
		assert.equal(existsSync(join(changesetDirectory, "release-automation-test.md")), false);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});
