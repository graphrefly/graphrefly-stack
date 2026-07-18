import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import type { RepositoryReview } from "@graphrefly-stack/contracts";

import {
	createRepositoryReviewBundle,
	RepositoryReviewStateError,
	readRepositoryReviewDecisions,
	writeRepositoryReviewDecision,
} from "./repository-review-state.js";
import { runtimeReviewDist } from "./runtime-paths.js";

export const defaultReviewDist = runtimeReviewDist();

const contentTypes: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

export interface ReviewServerOptions {
	host?: string;
	port?: number;
	distDir?: string;
	reviewData?: unknown;
	evidenceBundlePath?: string;
	repositoryReviewState?: {
		repository: string;
		review: RepositoryReview;
	};
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const maximumBytes = 32 * 1024;
	const declaredLength = Number(request.headers["content-length"] ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		throw new RepositoryReviewStateError(
			"REVIEW_DECISION_TOO_LARGE",
			"Review decision request exceeds 32 KiB",
		);
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > maximumBytes) {
			throw new RepositoryReviewStateError(
				"REVIEW_DECISION_TOO_LARGE",
				"Review decision request exceeds 32 KiB",
			);
		}
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RepositoryReviewStateError(
			"REVIEW_DECISION_INVALID",
			"Review decision request is not valid JSON",
		);
	}
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.writeHead(status).end(JSON.stringify(value));
}

export interface RunningReviewServer {
	server: Server;
	url: string;
}

function safeAssetPath(distDir: string, requestUrl: string): string | null {
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
	} catch {
		return null;
	}
	const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const candidate = resolve(distDir, relative);
	return candidate === distDir || candidate.startsWith(`${distDir}${sep}`) ? candidate : null;
}

export async function startReviewServer(
	options: ReviewServerOptions = {},
): Promise<RunningReviewServer> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 4173;
	const distDir = resolve(options.distDir ?? defaultReviewDist);
	const evidenceBundlePath =
		options.evidenceBundlePath === undefined ? undefined : resolve(options.evidenceBundlePath);

	const server = createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
		);
		response.setHeader("X-Content-Type-Options", "nosniff");
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

		if (pathname === "/api/review-decisions" && request.method === "POST") {
			const state = options.repositoryReviewState;
			if (state === undefined) {
				response.writeHead(404).end("Local review state unavailable");
				return;
			}
			const expectedOrigin =
				request.headers.host === undefined ? undefined : `http://${request.headers.host}`;
			if (
				request.headers.origin !== expectedOrigin ||
				request.headers["x-graphrefly-review"] !== "1"
			) {
				response.writeHead(403).end("Same-origin review action required");
				return;
			}
			if (!request.headers["content-type"]?.startsWith("application/json")) {
				response.writeHead(415).end("application/json required");
				return;
			}
			try {
				const input = await readJsonBody(request);
				const record = await writeRepositoryReviewDecision(state.repository, state.review, input);
				sendJson(response, 201, record);
			} catch (error) {
				if (error instanceof RepositoryReviewStateError) {
					sendJson(response, error.code === "REVIEW_TARGET_STALE" ? 409 : 400, {
						code: error.code,
						message: error.message,
					});
				} else {
					sendJson(response, 500, {
						code: "REVIEW_STATE_FAILED",
						message: "Local review state could not be updated",
					});
				}
			}
			return;
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405).end("Method not allowed");
			return;
		}
		if (pathname === "/api/review-data") {
			if (options.reviewData === undefined) {
				response.writeHead(404).end("Review data unavailable");
				return;
			}
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.writeHead(200);
			if (request.method === "HEAD") response.end();
			else response.end(JSON.stringify(options.reviewData));
			return;
		}
		if (pathname === "/api/review-decisions") {
			const state = options.repositoryReviewState;
			if (state === undefined) {
				response.writeHead(404).end("Local review state unavailable");
				return;
			}
			try {
				const records = await readRepositoryReviewDecisions(state.repository, state.review);
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.writeHead(200);
				if (request.method === "HEAD") response.end();
				else response.end(JSON.stringify(records));
			} catch {
				response.writeHead(500).end("Local review state unavailable");
			}
			return;
		}
		if (pathname === "/api/review-decisions/export") {
			const state = options.repositoryReviewState;
			if (state === undefined) {
				response.writeHead(404).end("Portable review bundle unavailable");
				return;
			}
			try {
				const bundle = await createRepositoryReviewBundle(state.repository, state.review);
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.setHeader(
					"Content-Disposition",
					'attachment; filename="graphrefly-stack-reviews.json"',
				);
				response.writeHead(200);
				if (request.method === "HEAD") response.end();
				else response.end(`${JSON.stringify(bundle, null, 2)}\n`);
			} catch {
				response.writeHead(500).end("Portable review bundle unavailable");
			}
			return;
		}
		if (pathname === "/api/evidence-bundle") {
			if (evidenceBundlePath === undefined) {
				response.writeHead(404).end("Portable evidence bundle unavailable");
				return;
			}
			try {
				const asset = await stat(evidenceBundlePath);
				if (!asset.isFile()) throw new Error("not a file");
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.setHeader(
					"Content-Disposition",
					'attachment; filename="graphrefly-stack-evidence.json"',
				);
				response.writeHead(200);
				if (request.method === "HEAD") response.end();
				else createReadStream(evidenceBundlePath).pipe(response);
			} catch {
				response.writeHead(404).end("Portable evidence bundle unavailable");
			}
			return;
		}

		const assetPath = safeAssetPath(distDir, request.url ?? "/");
		if (assetPath === null) {
			response.writeHead(400).end("Invalid path");
			return;
		}

		try {
			const asset = await stat(assetPath);
			if (!asset.isFile()) throw new Error("not a file");
			response.setHeader(
				"Content-Type",
				contentTypes[extname(assetPath)] ?? "application/octet-stream",
			);
			response.writeHead(200);
			if (request.method === "HEAD") response.end();
			else createReadStream(assetPath).pipe(response);
		} catch {
			response.writeHead(404).end("Not found");
		}
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});

	const address = server.address() as AddressInfo;
	return { server, url: `http://${host}:${address.port}` };
}
