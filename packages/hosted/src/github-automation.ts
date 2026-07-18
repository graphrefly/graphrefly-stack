import { createPrivateKey, sign } from "node:crypto";

import type { HostedProviderAuthorizer } from "./control-plane.js";
import { extractGitHubCiBundle, GITHUB_CI_ARTIFACT_LIMITS } from "./github-artifact.js";
import type { HostedRepositoryContext } from "./persistence.js";

type JsonObject = Record<string, unknown>;
type GitHubFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HostedInstallationDirectory {
	resolveSelectedRepository(input: {
		provider: "github";
		installationId: string;
		providerAccountId: string;
		providerRepositoryId: string;
		providerOwnerId: string;
		visibility: "public" | "private";
	}): Promise<HostedRepositoryContext | null>;
}

function object(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function decimal(value: unknown): string | null {
	const normalized = typeof value === "number" || typeof value === "string" ? String(value) : "";
	return /^\d+$/u.test(normalized) ? normalized : null;
}

function base64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function repositoryName(workflowRef: string): { owner: string; repository: string } | null {
	const match = workflowRef.match(
		/^([^/\s]+)\/([^/\s]+)\/\.github\/workflows\/graphrefly-stack-hosted\.yml@refs\/[A-Za-z0-9._/-]+$/u,
	);
	return match === null ? null : { owner: match[1] as string, repository: match[2] as string };
}

export class GitHubAppUploadAuthorizer implements HostedProviderAuthorizer {
	readonly #appId: string;
	readonly #privateKey: ReturnType<typeof createPrivateKey>;
	readonly #directory: HostedInstallationDirectory;
	readonly #fetch: GitHubFetch;
	readonly #apiUrl: string;
	readonly #now: () => Date;

	constructor(options: {
		appId: string;
		privateKey: string | Buffer;
		directory: HostedInstallationDirectory;
		fetch?: GitHubFetch;
		apiUrl?: string;
		now?: () => Date;
	}) {
		if (!/^\d+$/u.test(options.appId)) throw new Error("GitHub App ID must be decimal");
		this.#appId = options.appId;
		this.#privateKey = createPrivateKey(options.privateKey);
		if (this.#privateKey.asymmetricKeyType !== "rsa") {
			throw new Error("GitHub App private key must be RSA");
		}
		this.#directory = options.directory;
		this.#fetch = options.fetch ?? fetch;
		this.#apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/u, "");
		this.#now = options.now ?? (() => new Date());
	}

	async authorizeUpload(
		input: Parameters<HostedProviderAuthorizer["authorizeUpload"]>[0],
	): Promise<{ repository: HostedRepositoryContext; sourceBundle: unknown } | null> {
		try {
			const name = repositoryName(input.identity.claims.workflowRef);
			if (name === null) return null;
			const appJwt = this.#appJwt();
			const installationResponse = await this.#api(
				`/repos/${encodeURIComponent(name.owner)}/${encodeURIComponent(name.repository)}/installation`,
				appJwt,
			);
			if (!installationResponse.ok) return null;
			const installation = object(await installationResponse.json());
			const account = object(installation?.account);
			const installationId = decimal(installation?.id);
			const accountId = decimal(account?.id);
			if (
				installation === null ||
				installationId === null ||
				accountId === null ||
				decimal(installation.app_id) !== this.#appId ||
				installation.suspended_at !== null ||
				accountId !== input.repository.ownerId
			) {
				return null;
			}

			const repositoryNumber = Number(input.repository.repositoryId);
			const installationNumber = Number(installationId);
			if (!Number.isSafeInteger(repositoryNumber) || !Number.isSafeInteger(installationNumber)) {
				return null;
			}
			const tokenResponse = await this.#fetch(
				`${this.#apiUrl}/app/installations/${installationId}/access_tokens`,
				{
					method: "POST",
					headers: this.#headers(appJwt, true),
					body: JSON.stringify({
						repository_ids: [repositoryNumber],
						permissions: { actions: "read", metadata: "read" },
					}),
					signal: AbortSignal.timeout(10_000),
				},
			);
			if (!tokenResponse.ok) return null;
			const tokenValue = object(await tokenResponse.json());
			const token = typeof tokenValue?.token === "string" ? tokenValue.token : "";
			const expiresAt =
				typeof tokenValue?.expires_at === "string" ? Date.parse(tokenValue.expires_at) : 0;
			const tokenRepositories = Array.isArray(tokenValue?.repositories)
				? tokenValue.repositories.map(object)
				: [];
			if (
				token.length === 0 ||
				expiresAt <= this.#now().getTime() ||
				expiresAt > this.#now().getTime() + 65 * 60_000 ||
				tokenRepositories.length !== 1 ||
				decimal(tokenRepositories[0]?.id) !== input.repository.repositoryId
			) {
				return null;
			}

			const repositoryResponse = await this.#api(
				`/repositories/${input.repository.repositoryId}`,
				token,
			);
			if (!repositoryResponse.ok) return null;
			const repository = object(await repositoryResponse.json());
			const owner = object(repository?.owner);
			if (
				repository === null ||
				decimal(repository.id) !== input.repository.repositoryId ||
				decimal(owner?.id) !== input.repository.ownerId ||
				typeof repository.private !== "boolean"
			) {
				return null;
			}

			const runResponse = await this.#api(
				`/repos/${encodeURIComponent(name.owner)}/${encodeURIComponent(name.repository)}/actions/runs/${input.source.runId}`,
				token,
			);
			if (!runResponse.ok) return null;
			const run = object(await runResponse.json());
			const runRepository = object(run?.repository);
			const runOwner = object(runRepository?.owner);
			if (
				run === null ||
				decimal(run.id) !== input.source.runId ||
				run.run_attempt !== input.source.runAttempt ||
				run.head_sha !== input.source.head.value ||
				run.event !== "pull_request" ||
				run.status !== "completed" ||
				!(["success", "failure"] as unknown[]).includes(run.conclusion) ||
				decimal(runRepository?.id) !== input.repository.repositoryId ||
				decimal(runOwner?.id) !== input.repository.ownerId ||
				typeof run.path !== "string" ||
				!/^\.github\/workflows\/graphrefly-stack\.yml@refs\//u.test(run.path)
			) {
				return null;
			}

			const artifactsResponse = await this.#api(
				`/repos/${encodeURIComponent(name.owner)}/${encodeURIComponent(name.repository)}/actions/runs/${input.source.runId}/artifacts?per_page=100`,
				token,
			);
			if (!artifactsResponse.ok) return null;
			const artifactList = object(await artifactsResponse.json());
			const artifacts = Array.isArray(artifactList?.artifacts)
				? artifactList.artifacts.map(object)
				: [];
			const expectedName = `graphrefly-stack-ci-${input.source.portableBundleDigest.value}`;
			const matching = artifacts.filter((artifact) => {
				const artifactRun = object(artifact?.workflow_run);
				return (
					artifact?.name === expectedName &&
					artifact?.expired === false &&
					decimal(artifactRun?.id) === input.source.runId &&
					decimal(artifactRun?.head_repository_id) === input.repository.repositoryId &&
					artifactRun?.head_sha === input.source.head.value
				);
			});
			const artifactId = decimal(matching[0]?.id);
			if (matching.length !== 1 || artifactId === null) return null;

			const selected = await this.#directory.resolveSelectedRepository({
				provider: "github",
				installationId,
				providerAccountId: accountId,
				providerRepositoryId: input.repository.repositoryId,
				providerOwnerId: input.repository.ownerId,
				visibility: repository.private ? "private" : "public",
			});
			if (selected === null) return null;
			const archiveResponse = await this.#fetch(
				`${this.#apiUrl}/repos/${encodeURIComponent(name.owner)}/${encodeURIComponent(name.repository)}/actions/artifacts/${artifactId}/zip`,
				{
					headers: this.#headers(token),
					redirect: "follow",
					signal: AbortSignal.timeout(15_000),
				},
			);
			if (!archiveResponse.ok) return null;
			const declaredLength = Number(archiveResponse.headers.get("content-length"));
			if (
				archiveResponse.headers.has("content-length") &&
				(!Number.isSafeInteger(declaredLength) ||
					declaredLength < 1 ||
					declaredLength > GITHUB_CI_ARTIFACT_LIMITS.archiveBytes)
			) {
				return null;
			}
			const archive = new Uint8Array(await archiveResponse.arrayBuffer());
			const sourceBundle = extractGitHubCiBundle(archive);
			return { repository: selected, sourceBundle };
		} catch {
			return null;
		}
	}

	#appJwt(): string {
		const now = Math.floor(this.#now().getTime() / 1000);
		const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
		const payload = base64url(
			JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: this.#appId }),
		);
		const signingInput = `${header}.${payload}`;
		return `${signingInput}.${sign("RSA-SHA256", Buffer.from(signingInput), this.#privateKey).toString("base64url")}`;
	}

	#api(path: string, token: string): Promise<Response> {
		return this.#fetch(`${this.#apiUrl}${path}`, {
			headers: this.#headers(token),
			signal: AbortSignal.timeout(10_000),
		});
	}

	#headers(token: string, json = false): Record<string, string> {
		return {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "graphrefly-stack-hosted",
			"X-GitHub-Api-Version": "2022-11-28",
			...(json ? { "Content-Type": "application/json" } : {}),
		};
	}
}
