import type { IncomingMessage, ServerResponse } from "node:http";

import { HOSTED_MAX_ENVELOPE_BYTES } from "@graphrefly-stack/contracts";

import { type HostedControlPlane, HostedControlPlaneError } from "./control-plane.js";

function send(response: ServerResponse, status: number, body: unknown): void {
	const bytes = Buffer.from(JSON.stringify(body), "utf8");
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(bytes.byteLength),
	});
	response.end(bytes);
}

async function readBounded(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > HOSTED_MAX_ENVELOPE_BYTES) {
			throw new HostedControlPlaneError(
				413,
				"HOSTED_ENVELOPE_TOO_LARGE",
				"request body exceeds the v1 bound",
			);
		}
		chunks.push(bytes);
	}
	return Buffer.concat(chunks, size);
}

export function createHostedIngestHandler(controlPlane: HostedControlPlane) {
	return (request: IncomingMessage, response: ServerResponse): void => {
		void (async () => {
			try {
				if (request.method !== "POST" || request.url !== "/v1/envelopes") {
					send(response, 404, { error: { code: "NOT_FOUND", message: "not found" } });
					return;
				}
				if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
					throw new HostedControlPlaneError(
						415,
						"HOSTED_CONTENT_TYPE_INVALID",
						"application/json is required",
					);
				}
				const authorization = request.headers.authorization;
				const match = authorization?.match(/^Bearer ([^\s]+)$/u);
				if (match === undefined || match === null) {
					throw new HostedControlPlaneError(
						401,
						"HOSTED_BEARER_REQUIRED",
						"one bearer token is required",
					);
				}
				const claimedDigest = request.headers["x-graphrefly-envelope-digest"];
				if (typeof claimedDigest !== "string" || !/^[0-9a-f]{64}$/u.test(claimedDigest)) {
					throw new HostedControlPlaneError(
						400,
						"HOSTED_DIGEST_REQUIRED",
						"one SHA-256 digest is required",
					);
				}
				const declaredLength = Number(request.headers["content-length"]);
				if (
					request.headers["content-length"] !== undefined &&
					(!Number.isSafeInteger(declaredLength) ||
						declaredLength < 1 ||
						declaredLength > HOSTED_MAX_ENVELOPE_BYTES)
				) {
					throw new HostedControlPlaneError(
						413,
						"HOSTED_ENVELOPE_TOO_LARGE",
						"Content-Length is outside the v1 bound",
					);
				}
				const result = await controlPlane.ingest({
					bearerToken: match[1] as string,
					body: await readBounded(request),
					claimedDigest,
				});
				send(response, result.status, result.receipt);
			} catch (error) {
				if (error instanceof HostedControlPlaneError) {
					send(response, error.status, { error: { code: error.code, message: error.message } });
					return;
				}
				send(response, 500, {
					error: { code: "HOSTED_INTERNAL_ERROR", message: "hosted control plane failed closed" },
				});
			}
		})();
	};
}
