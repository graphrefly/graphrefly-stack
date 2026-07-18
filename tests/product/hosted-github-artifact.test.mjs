import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { canonicalize } from "../../packages/contracts/dist/index.js";
import {
	extractGitHubCiBundle,
	GITHUB_CI_ARTIFACT_LIMITS,
} from "../../packages/hosted/dist/index.js";

const bundle = JSON.parse(
	await readFile(
		new URL("../../fixtures/contracts/hosted/v1/ci-bundle.json", import.meta.url),
		"utf8",
	),
);

function zip(name, content, method = 0) {
	const fileName = Buffer.from(name, "utf8");
	const output = Buffer.from(content);
	const data = method === 8 ? deflateRawSync(output) : output;
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(method, 8);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(output.length, 22);
	local.writeUInt16LE(fileName.length, 26);
	const centralOffset = local.length + fileName.length + data.length;
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(method, 10);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(output.length, 24);
	central.writeUInt16LE(fileName.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + fileName.length, 12);
	end.writeUInt32LE(centralOffset, 16);
	return Buffer.concat([local, fileName, data, central, fileName, end]);
}

test("bounded stored and deflated GitHub artifacts yield the exact canonical CI bundle", () => {
	for (const method of [0, 8]) {
		const archive = zip(GITHUB_CI_ARTIFACT_LIMITS.fileName, canonicalize(bundle), method);
		assert.deepEqual(extractGitHubCiBundle(archive), bundle);
	}
});

test("artifact extraction rejects path changes, noncanonical bytes and nested CI tamper", () => {
	assert.throws(
		() => extractGitHubCiBundle(zip("nested/graphrefly-stack-ci.json", canonicalize(bundle))),
		/must contain one|unsupported/u,
	);
	assert.throws(
		() =>
			extractGitHubCiBundle(
				zip(GITHUB_CI_ARTIFACT_LIMITS.fileName, JSON.stringify(bundle, null, 2)),
			),
		/not canonical/u,
	);
	const tampered = structuredClone(bundle);
	tampered.result.summary.verdict = "blocked";
	assert.throws(
		() => extractGitHubCiBundle(zip(GITHUB_CI_ARTIFACT_LIMITS.fileName, canonicalize(tampered))),
		/cross-binding|integrity/u,
	);
});

test("artifact extraction rejects multi-entry, ZIP64, oversized and truncated archive metadata", () => {
	const archive = zip(GITHUB_CI_ARTIFACT_LIMITS.fileName, canonicalize(bundle));
	const multiple = Buffer.from(archive);
	multiple.writeUInt16LE(2, multiple.length - 14);
	multiple.writeUInt16LE(2, multiple.length - 12);
	assert.throws(() => extractGitHubCiBundle(multiple), /one non-ZIP64 file/u);

	const oversized = Buffer.from(archive);
	const centralOffset = oversized.readUInt32LE(oversized.length - 6);
	oversized.writeUInt32LE(GITHUB_CI_ARTIFACT_LIMITS.bundleBytes + 1, centralOffset + 24);
	assert.throws(() => extractGitHubCiBundle(oversized), /unsupported/u);

	assert.throws(() => extractGitHubCiBundle(archive.subarray(0, 40)), /central directory/u);
	assert.throws(
		() => extractGitHubCiBundle(Buffer.alloc(GITHUB_CI_ARTIFACT_LIMITS.archiveBytes + 1)),
		/exceeds the bounded size/u,
	);

	const mismatchedLocal = Buffer.from(archive);
	mismatchedLocal.writeUInt16LE(8, 8);
	assert.throws(() => extractGitHubCiBundle(mismatchedLocal), /local entry does not match/u);
});
