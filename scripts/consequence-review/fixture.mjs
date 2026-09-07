import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { git, retainedRoot } from "../source-bound/git.mjs";

export const consequenceRefs = {
	base: "refs/heads/consequence-review-base-v3",
	left: "refs/heads/consequence-review-a-v3",
	right: "refs/heads/consequence-review-b-v3",
};

const baseFiles = {
	".graphrefly-stack.json": `${JSON.stringify({ schema: "graphrefly.stack.repository.v1", blueprint: { entrypoint: "graphrefly-stack.blueprint.mjs" } })}\n`,
	"graphrefly-stack.blueprint.mjs": `import { createHash } from "node:crypto";
import { withBlueprintHash } from "@graphrefly/ts";
import { RefreshSession } from "./src/refresh-session.ts";
const blueprint = await withBlueprintHash(RefreshSession.blueprint(), {
  algorithm: "sha256",
  hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
});
process.stdout.write(JSON.stringify(blueprint));
`,
	"src/graph-root.ts": `import { graph } from "@graphrefly/ts";
export type Request = { token: string; tenant: string; active: boolean; age: number };
export const RefreshSession = graph({ name: "RefreshSession" });
export const RequestInput = RefreshSession.state<Request>({ token: "valid", tenant: "acme", active: true, age: 1 }, { name: "RequestInput" });
export const ParseRefreshRequest = RefreshSession.derived([RequestInput], (request) => ({ ...request, malformed: !request.token || !request.tenant }), { name: "ParseRefreshRequest" });
export const LoadTenantPolicy = RefreshSession.derived([ParseRefreshRequest], (request) => ({ enabled: request.tenant === "acme", maxAge: 30 }), { name: "LoadTenantPolicy" });
export const ValidateTokenContract = RefreshSession.derived([ParseRefreshRequest], (request) => !request.malformed && request.token === "valid", { name: "ValidateTokenContract" });
export const ResolveSession = RefreshSession.derived([ParseRefreshRequest, ValidateTokenContract], (request, valid) => ({ found: valid, active: request.active, age: request.age }), { name: "ResolveSession" });
export const PasswordResetInput = RefreshSession.state("reset@example.invalid", { name: "PasswordResetInput" });
export const IndependentPasswordResetFlow = RefreshSession.derived([PasswordResetInput], (email) => ({ queued: email.includes("@") }), { name: "IndependentPasswordResetFlow" });
`,
	"src/session-store.ts": `import { LoadTenantPolicy, RefreshSession, ResolveSession } from "./graph-root.ts";
export const SessionStore = RefreshSession.derived([ResolveSession], (session) => ({ ...session, policyVersion: "legacy" }), { name: "PersistSession" });
export const ApplyBrokerPolicy = RefreshSession.derived([SessionStore, LoadTenantPolicy], (session, policy) => ({ ...session, policy }), { name: "ApplyBrokerPolicy" });
export const EvaluateSessionPolicy = RefreshSession.derived([ApplyBrokerPolicy], (value) => value.found && value.active && value.policy.enabled && value.age <= value.policy.maxAge, { name: "EvaluateSessionPolicy" });
`,
	"src/response-mapping.ts": `import { ParseRefreshRequest, RefreshSession, ValidateTokenContract } from "./graph-root.ts";
import { EvaluateSessionPolicy } from "./session-store.ts";
export const AdmitRefresh = RefreshSession.derived([ValidateTokenContract, EvaluateSessionPolicy], (valid, allowed) => valid && allowed, { name: "AdmitRefresh" });
export const MapFailureResponse = RefreshSession.derived([ParseRefreshRequest, ValidateTokenContract, AdmitRefresh], (request, valid, admitted) => request.malformed ? 400 : !valid ? 401 : admitted ? 200 : 403, { name: "MapFailureResponse" });
`,
	"src/refresh-session.ts": `import * as root from "./graph-root.ts";
import * as policy from "./session-store.ts";
import * as response from "./response-mapping.ts";
export const RefreshSession = root.RefreshSession;
export const RequestInput = root.RequestInput;
export const ParseRefreshRequest = root.ParseRefreshRequest;
export const LoadTenantPolicy = root.LoadTenantPolicy;
export const ValidateTokenContract = root.ValidateTokenContract;
export const ResolveSession = root.ResolveSession;
export const PasswordResetInput = root.PasswordResetInput;
export const IndependentPasswordResetFlow = root.IndependentPasswordResetFlow;
export const EvaluateSessionPolicy = policy.EvaluateSessionPolicy;
export const BuildHttpRefreshOutcome = RefreshSession.derived([response.MapFailureResponse, response.AdmitRefresh], (status, admitted) => ({ status, rotated: admitted }), { name: "BuildHttpRefreshOutcome" });
export const EmitSecurityAudit = RefreshSession.derived([ValidateTokenContract, EvaluateSessionPolicy, BuildHttpRefreshOutcome], (valid, allowed, outcome) => ({ event: "refresh", valid, allowed, status: outcome.status }), { name: "EmitSecurityAudit" });
export const UpdateSessionMetrics = RefreshSession.derived([response.AdmitRefresh], (admitted) => ({ accepted: admitted ? 1 : 0, rejected: admitted ? 0 : 1 }), { name: "UpdateSessionMetrics" });
`,
	"tests/business-verifier.mjs": `import assert from "node:assert/strict";
import * as root from "../src/graph-root.ts";
import * as policy from "../src/session-store.ts";
import * as response from "../src/response-mapping.ts";
import * as outcomes from "../src/refresh-session.ts";
const consumer = { ...root, ...policy, ...response, ...outcomes };
export function verifyBusiness() {
  const cases = [
    { name: "valid refresh", input: { token: "valid", tenant: "acme", active: true, age: 1 }, status: 200 },
    { name: "missing token", input: { token: "", tenant: "acme", active: true, age: 1 }, status: 400 },
    { name: "invalid token", input: { token: "forged", tenant: "acme", active: true, age: 1 }, status: 401 },
    { name: "disabled tenant", input: { token: "valid", tenant: "other", active: true, age: 1 }, status: 403 },
    { name: "inactive session", input: { token: "valid", tenant: "acme", active: false, age: 1 }, status: 403 },
    { name: "age boundary", input: { token: "valid", tenant: "acme", active: true, age: 30 }, status: 200 },
    { name: "expired session", input: { token: "valid", tenant: "acme", active: true, age: 31 }, status: 403 },
  ];
  const releases = [consumer.BuildHttpRefreshOutcome, consumer.EmitSecurityAudit, consumer.UpdateSessionMetrics, consumer.IndependentPasswordResetFlow].map((node) => node.subscribe(() => {}));
  try {
    for (const c of cases) {
      consumer.RequestInput.set(c.input);
      assert.deepEqual(consumer.BuildHttpRefreshOutcome.cache, { status: c.status, rotated: c.status === 200 }, c.name);
      assert.equal(consumer.EmitSecurityAudit.cache.status, c.status, c.name);
      assert.deepEqual(consumer.UpdateSessionMetrics.cache, { accepted: c.status === 200 ? 1 : 0, rejected: c.status === 200 ? 0 : 1 }, c.name);
      assert.deepEqual(consumer.IndependentPasswordResetFlow.cache, { queued: true }, c.name);
      assert.equal(consumer.SessionStore.cache.policyVersion, "legacy", c.name);
    }
    return { status: "passed", cases: cases.map((c) => c.name), controls: ["ValidateTokenContract", "IndependentPasswordResetFlow"], oracle: "independent expected HTTP, audit, metrics, persisted policy version and password-reset business outputs" };
  } finally { for (const release of releases) release(); }
}
`,
};

const leftFiles = {
	"src/session-store.ts": baseFiles["src/session-store.ts"].replace(
		'policyVersion: "legacy"',
		'policyVersion: "v2"',
	),
	"tests/business-verifier.mjs": baseFiles["tests/business-verifier.mjs"].replace(
		'policyVersion, "legacy"',
		'policyVersion, "v2"',
	),
};
const rightFiles = {
	"src/response-mapping.ts": baseFiles["src/response-mapping.ts"]
		.replace(
			"(valid, allowed) => valid && allowed",
			"(valid, allowed) => Boolean(valid && allowed)",
		)
		.replace(
			"request.malformed ? 400 : !valid ? 401 : admitted ? 200 : 403",
			"request.malformed ? 400 : admitted ? 200 : valid ? 403 : 401",
		),
};

function run(repository, args) {
	return execFileSync("/usr/bin/git", args, {
		cwd: repository,
		encoding: "utf8",
		env: {
			PATH: "/usr/bin:/bin",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "Consequence Review Trial",
			GIT_AUTHOR_EMAIL: "consequence-review@example.invalid",
			GIT_COMMITTER_NAME: "Consequence Review Trial",
			GIT_COMMITTER_EMAIL: "consequence-review@example.invalid",
			GIT_AUTHOR_DATE: "2026-09-06T01:00:00Z",
			GIT_COMMITTER_DATE: "2026-09-06T01:00:00Z",
		},
	}).trim();
}
function write(repository, files) {
	for (const [path, bytes] of Object.entries(files)) {
		mkdirSync(resolve(repository, path, ".."), { recursive: true });
		writeFileSync(resolve(repository, path), bytes);
	}
}
function commit(repository, files, message) {
	write(repository, files);
	run(repository, ["add", "--", ...Object.keys(files).sort()]);
	run(repository, ["commit", "--no-gpg-sign", "-m", message]);
	return run(repository, ["rev-parse", "HEAD"]);
}
function expectedRevisions() {
	const temporary = mkdtempSync(resolve(tmpdir(), "consequence-fixture-"));
	try {
		run(temporary, ["clone", "--quiet", retainedRoot, "repository"]);
		const repository = resolve(temporary, "repository");
		run(repository, ["checkout", "--detach", "main"]);
		const base = commit(repository, baseFiles, "Establish retained consequence review base");
		const left = commit(repository, leftFiles, "Migrate retained session policy to v2");
		run(repository, ["checkout", "--detach", base]);
		const right = commit(repository, rightFiles, "Refine retained refresh response mapping");
		return { temporary, repository, revisions: { base, left, right } };
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}

export function setupConsequenceFixture() {
	const built = expectedRevisions();
	try {
		for (const [name, ref] of Object.entries(consequenceRefs)) {
			const expected = built.revisions[name];
			let actual = null;
			try {
				actual = git(retainedRoot, ["rev-parse", "--verify", ref]).trim();
			} catch {}
			if (actual !== null && actual !== expected)
				throw new Error(`CONSEQUENCE_FIXTURE_REF_MISMATCH: ${ref}`);
			if (actual === null)
				run(retainedRoot, ["fetch", "--quiet", built.repository, `${expected}:${ref}`]);
		}
		return verifyConsequenceFixture();
	} finally {
		rmSync(built.temporary, { recursive: true, force: true });
	}
}

export function verifyConsequenceFixture() {
	const base = git(retainedRoot, ["rev-parse", "--verify", consequenceRefs.base]).trim();
	const left = git(retainedRoot, ["rev-parse", "--verify", consequenceRefs.left]).trim();
	const right = git(retainedRoot, ["rev-parse", "--verify", consequenceRefs.right]).trim();
	const main = git(retainedRoot, ["rev-parse", "main"]).trim();
	if (git(retainedRoot, ["rev-parse", `${base}^`]).trim() !== main)
		throw new Error("CONSEQUENCE_FIXTURE_BASE");
	if (
		git(retainedRoot, ["rev-parse", `${left}^`]).trim() !== base ||
		git(retainedRoot, ["rev-parse", `${right}^`]).trim() !== base
	)
		throw new Error("CONSEQUENCE_FIXTURE_LINEAGE");
	for (const [path, bytes] of Object.entries(baseFiles))
		if (git(retainedRoot, ["show", `${base}:${path}`]) !== bytes)
			throw new Error(`CONSEQUENCE_FIXTURE_BYTES: ${path}`);
	for (const [path, bytes] of Object.entries(leftFiles))
		if (git(retainedRoot, ["show", `${left}:${path}`]) !== bytes)
			throw new Error(`CONSEQUENCE_FIXTURE_BYTES: ${path}`);
	for (const [path, bytes] of Object.entries(rightFiles))
		if (git(retainedRoot, ["show", `${right}:${path}`]) !== bytes)
			throw new Error(`CONSEQUENCE_FIXTURE_BYTES: ${path}`);
	if (
		git(retainedRoot, ["diff", "--name-only", base, left]).trim().split("\n").sort().join("\n") !==
		Object.keys(leftFiles).sort().join("\n")
	)
		throw new Error("CONSEQUENCE_FIXTURE_LEFT_SCOPE");
	if (
		git(retainedRoot, ["diff", "--name-only", base, right]).trim().split("\n").sort().join("\n") !==
		Object.keys(rightFiles).sort().join("\n")
	)
		throw new Error("CONSEQUENCE_FIXTURE_RIGHT_SCOPE");
	return { base, left, right };
}
