import { inflateRawSync } from "node:zlib";

import { assertCiBundleIntegrity, canonicalize } from "@graphrefly-stack/contracts";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const CI_BUNDLE_NAME = "graphrefly-stack-ci.json";

function requireRange(bytes: Buffer, offset: number, length: number): void {
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		length < 0 ||
		offset + length > bytes.byteLength
	) {
		throw new Error("GitHub artifact ZIP is truncated");
	}
}

function endOfCentralDirectory(bytes: Buffer): number {
	const minimum = Math.max(0, bytes.byteLength - 65_557);
	for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
		if (bytes.readUInt32LE(offset) === 0x0605_4b50) return offset;
	}
	throw new Error("GitHub artifact ZIP has no central directory");
}

export function extractGitHubCiBundle(archive: Uint8Array): unknown {
	if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
		throw new Error("GitHub artifact ZIP exceeds the bounded size");
	}
	const bytes = Buffer.from(archive);
	const end = endOfCentralDirectory(bytes);
	requireRange(bytes, end, 22);
	const disk = bytes.readUInt16LE(end + 4);
	const centralDisk = bytes.readUInt16LE(end + 6);
	const diskEntries = bytes.readUInt16LE(end + 8);
	const entries = bytes.readUInt16LE(end + 10);
	const centralSize = bytes.readUInt32LE(end + 12);
	const centralOffset = bytes.readUInt32LE(end + 16);
	const archiveCommentLength = bytes.readUInt16LE(end + 20);
	if (
		disk !== 0 ||
		centralDisk !== 0 ||
		diskEntries !== entries ||
		entries !== 1 ||
		centralSize === 0xffff_ffff ||
		centralOffset === 0xffff_ffff ||
		end + 22 + archiveCommentLength !== bytes.byteLength ||
		centralOffset + centralSize !== end
	) {
		throw new Error("GitHub artifact ZIP must contain one non-ZIP64 file");
	}
	requireRange(bytes, centralOffset, centralSize);
	if (bytes.readUInt32LE(centralOffset) !== 0x0201_4b50) {
		throw new Error("GitHub artifact ZIP central entry is invalid");
	}
	const flags = bytes.readUInt16LE(centralOffset + 8);
	const method = bytes.readUInt16LE(centralOffset + 10);
	const compressedSize = bytes.readUInt32LE(centralOffset + 20);
	const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
	const nameLength = bytes.readUInt16LE(centralOffset + 28);
	const extraLength = bytes.readUInt16LE(centralOffset + 30);
	const commentLength = bytes.readUInt16LE(centralOffset + 32);
	const localOffset = bytes.readUInt32LE(centralOffset + 42);
	requireRange(bytes, centralOffset + 46, nameLength + extraLength + commentLength);
	const name = bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString("utf8");
	if (
		name !== CI_BUNDLE_NAME ||
		(flags & 1) !== 0 ||
		![0, 8].includes(method) ||
		compressedSize > MAX_ARCHIVE_BYTES ||
		uncompressedSize === 0 ||
		uncompressedSize > MAX_BUNDLE_BYTES ||
		localOffset === 0xffff_ffff
	) {
		throw new Error("GitHub artifact ZIP entry is unsupported");
	}
	requireRange(bytes, localOffset, 30);
	if (bytes.readUInt32LE(localOffset) !== 0x0403_4b50) {
		throw new Error("GitHub artifact ZIP local entry is invalid");
	}
	const localNameLength = bytes.readUInt16LE(localOffset + 26);
	const localExtraLength = bytes.readUInt16LE(localOffset + 28);
	const localFlags = bytes.readUInt16LE(localOffset + 6);
	const localMethod = bytes.readUInt16LE(localOffset + 8);
	const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
	const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
	requireRange(bytes, localOffset + 30, localNameLength + localExtraLength);
	const localName = bytes
		.subarray(localOffset + 30, localOffset + 30 + localNameLength)
		.toString("utf8");
	if (
		localOffset !== 0 ||
		localName !== name ||
		localFlags !== flags ||
		localMethod !== method ||
		localCompressedSize !== compressedSize ||
		localUncompressedSize !== uncompressedSize
	) {
		throw new Error("GitHub artifact ZIP local entry does not match its central entry");
	}
	const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
	requireRange(bytes, dataOffset, compressedSize);
	if (dataOffset + compressedSize !== centralOffset) {
		throw new Error("GitHub artifact ZIP contains unindexed entry data");
	}
	const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
	const output =
		method === 0
			? Buffer.from(compressed)
			: inflateRawSync(compressed, { maxOutputLength: MAX_BUNDLE_BYTES });
	if (output.byteLength !== uncompressedSize) {
		throw new Error("GitHub artifact ZIP entry length is invalid");
	}
	let bundle: unknown;
	try {
		bundle = JSON.parse(output.toString("utf8"));
	} catch {
		throw new Error("GitHub artifact CI bundle is not JSON");
	}
	if (!output.equals(Buffer.from(canonicalize(bundle), "utf8"))) {
		throw new Error("GitHub artifact CI bundle is not canonical");
	}
	assertCiBundleIntegrity(bundle);
	return bundle;
}

export const GITHUB_CI_ARTIFACT_LIMITS = {
	archiveBytes: MAX_ARCHIVE_BYTES,
	bundleBytes: MAX_BUNDLE_BYTES,
	fileName: CI_BUNDLE_NAME,
} as const;
