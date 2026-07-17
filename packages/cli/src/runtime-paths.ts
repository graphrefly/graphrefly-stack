import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packagedAssets = resolve(moduleDirectory, "assets");
const workspaceRoot = resolve(moduleDirectory, "../../..");

export function runtimeAssetPath(relative: string): string {
	return existsSync(packagedAssets)
		? resolve(packagedAssets, relative)
		: resolve(workspaceRoot, relative);
}

export function runtimeReviewDist(): string {
	const packagedReview = resolve(moduleDirectory, "review");
	return existsSync(resolve(packagedReview, "index.html"))
		? packagedReview
		: resolve(workspaceRoot, "apps/review/dist");
}

export function runtimeStateRoot(): string {
	return resolve(process.cwd());
}
