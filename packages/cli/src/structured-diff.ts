import type {
	StructuredFileDiff,
	StructuredGitDiff,
	StructuredGitDiff as StructuredGitDiffContract,
} from "@graphrefly-stack/contracts";

function readGitPathToken(
	source: string,
	start: number,
): { value: string; next: number } | undefined {
	let index = start;
	while (source[index] === " ") index += 1;
	if (source[index] !== '"') {
		const end = source.indexOf(" ", index);
		return {
			value: source.slice(index, end === -1 ? source.length : end),
			next: end === -1 ? source.length : end,
		};
	}
	index += 1;
	const bytes: number[] = [];
	const namedEscapes: Record<string, number> = {
		a: 7,
		b: 8,
		t: 9,
		n: 10,
		v: 11,
		f: 12,
		r: 13,
	};
	while (index < source.length && source[index] !== '"') {
		const character = source[index] as string;
		if (character !== "\\") {
			bytes.push(...Buffer.from(character));
			index += 1;
			continue;
		}
		index += 1;
		const escaped = source[index];
		if (escaped === undefined) return undefined;
		const octal = source.slice(index).match(/^[0-7]{1,3}/u)?.[0];
		if (octal !== undefined) {
			bytes.push(Number.parseInt(octal, 8));
			index += octal.length;
			continue;
		}
		bytes.push(namedEscapes[escaped] ?? escaped.charCodeAt(0));
		index += 1;
	}
	if (source[index] !== '"') return undefined;
	return { value: Buffer.from(bytes).toString("utf8"), next: index + 1 };
}

function parseHeader(line: string): { oldPath: string; newPath: string } | undefined {
	if (!line.startsWith("diff --git ")) return undefined;
	const source = line.slice("diff --git ".length);
	if (source.startsWith("a/")) {
		const split = source.lastIndexOf(" b/");
		if (split === -1) return undefined;
		return {
			oldPath: source.slice(2, split),
			newPath: source.slice(split + " b/".length),
		};
	}
	const oldToken = readGitPathToken(source, 0);
	if (oldToken === undefined) return undefined;
	const newToken = readGitPathToken(source, oldToken.next);
	if (
		newToken === undefined ||
		!oldToken.value.startsWith("a/") ||
		!newToken.value.startsWith("b/")
	) {
		return undefined;
	}
	return {
		oldPath: oldToken.value.slice(2),
		newPath: newToken.value.slice(2),
	};
}

export function parseStructuredDiff(patch: string): StructuredGitDiffContract {
	const files: StructuredFileDiff[] = [];
	let file:
		| {
				oldPath: string;
				newPath: string;
				additions: number;
				deletions: number;
				binary: boolean;
				hunks: {
					header: string;
					lines: StructuredGitDiff["files"][number]["hunks"][number]["lines"];
				}[];
		  }
		| undefined;
	let hunk:
		| {
				header: string;
				lines: Array<{
					kind: "context" | "delete" | "add";
					content: string;
					oldNo?: number;
					newNo?: number;
				}>;
		  }
		| undefined;
	let oldNo = 0;
	let newNo = 0;

	for (const line of patch.split("\n")) {
		const header = parseHeader(line);
		if (header !== undefined) {
			file = { ...header, additions: 0, deletions: 0, binary: false, hunks: [] };
			files.push(file);
			hunk = undefined;
			continue;
		}
		if (file === undefined) continue;
		if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			file.binary = true;
			continue;
		}
		const hunkHeader = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
		if (hunkHeader?.[1] !== undefined && hunkHeader[2] !== undefined) {
			oldNo = Number(hunkHeader[1]);
			newNo = Number(hunkHeader[2]);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (hunk === undefined || line.startsWith("\\ No newline")) continue;
		if (line.startsWith("-")) {
			hunk.lines.push({ kind: "delete", content: line.slice(1), oldNo });
			oldNo += 1;
			file.deletions += 1;
		} else if (line.startsWith("+")) {
			hunk.lines.push({ kind: "add", content: line.slice(1), newNo });
			newNo += 1;
			file.additions += 1;
		} else if (line.startsWith(" ")) {
			hunk.lines.push({ kind: "context", content: line.slice(1), oldNo, newNo });
			oldNo += 1;
			newNo += 1;
		}
	}

	return {
		paths: [...new Set(files.map((entry) => entry.newPath))].sort(),
		files,
	};
}
