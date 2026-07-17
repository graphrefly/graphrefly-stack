import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";

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

		if (request.method !== "GET" && request.method !== "HEAD") {
			response.writeHead(405).end("Method not allowed");
			return;
		}
		if (new URL(request.url ?? "/", "http://localhost").pathname === "/api/review-data") {
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
		if (new URL(request.url ?? "/", "http://localhost").pathname === "/api/evidence-bundle") {
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
