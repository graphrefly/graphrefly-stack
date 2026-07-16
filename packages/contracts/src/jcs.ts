import { createHash } from "node:crypto";

function assertUnicodeScalarString(value: string): void {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new TypeError("JCS rejects an unpaired high surrogate");
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			throw new TypeError("JCS rejects an unpaired low surrogate");
		}
	}
}

function serialize(value: unknown): string {
	if (value === null || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("JCS accepts only finite I-JSON numbers");
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		assertUnicodeScalarString(value);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(serialize).join(",")}]`;
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys
			.map((key) => {
				assertUnicodeScalarString(key);
				return `${JSON.stringify(key)}:${serialize(record[key])}`;
			})
			.join(",")}}`;
	}
	throw new TypeError(`JCS cannot serialize ${typeof value}`);
}

export function canonicalize(value: unknown): string {
	return serialize(value);
}

export function canonicalizeToBytes(value: unknown): Uint8Array {
	return Buffer.from(canonicalize(value), "utf8");
}

export function sha256Jcs(value: unknown): string {
	return createHash("sha256").update(canonicalizeToBytes(value)).digest("hex");
}
