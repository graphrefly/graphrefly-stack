import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStrictAjv, sha256Jcs } from "@graphrefly-stack/contracts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface ManifestArtifact {
	path: string;
	hash: { algorithm: "sha256"; value: string };
}

export interface PortableEvidenceBundle {
	schema: "urn:graphrefly-stack:schema:portable-bundle:v1";
	manifest: Record<string, unknown> & { artifacts: ManifestArtifact[] };
	artifacts: Record<string, unknown>;
}

export interface LoadedPortableEvidenceBundle extends PortableEvidenceBundle {
	path: string;
}

export async function portableEvidenceBundlePath(input: string): Promise<string> {
	const candidate = resolve(input);
	const candidateStat = await stat(candidate);
	return candidateStat.isDirectory() ? resolve(candidate, "evidence-bundle.json") : candidate;
}

export async function readPortableEvidenceBundle(
	input: string,
): Promise<LoadedPortableEvidenceBundle> {
	const path = await portableEvidenceBundlePath(input);
	const value = JSON.parse(await readFile(path, "utf8")) as unknown;
	const schema = JSON.parse(
		await readFile(resolve(workspaceRoot, "contracts/v1/schemas/artifacts.schema.json"), "utf8"),
	) as object;
	const ajv = createStrictAjv();
	ajv.addSchema(schema);
	const validate = ajv.getSchema(
		"urn:graphrefly-stack:schema:artifacts:v1#/definitions/PortableBundle",
	);
	if (validate === undefined || !validate(value)) {
		throw new Error(`Portable evidence bundle is invalid: ${JSON.stringify(validate?.errors)}`);
	}

	const bundle = value as PortableEvidenceBundle;
	const manifestPaths = bundle.manifest.artifacts.map((artifact) => artifact.path);
	if (new Set(manifestPaths).size !== manifestPaths.length) {
		throw new Error("Portable evidence manifest contains duplicate artifact paths");
	}
	const embeddedPaths = Object.keys(bundle.artifacts);
	if (
		embeddedPaths.length !== manifestPaths.length ||
		embeddedPaths.some((artifactPath) => !manifestPaths.includes(artifactPath))
	) {
		throw new Error("Portable evidence artifacts do not exactly match the manifest");
	}
	for (const artifact of bundle.manifest.artifacts) {
		if (!Object.hasOwn(bundle.artifacts, artifact.path)) {
			throw new Error(`Portable evidence artifact is missing: ${artifact.path}`);
		}
		if (sha256Jcs(bundle.artifacts[artifact.path]) !== artifact.hash.value) {
			throw new Error(`Portable evidence artifact hash mismatch: ${artifact.path}`);
		}
	}
	return { ...bundle, path };
}
