import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	createHostedEnvelope,
	decodeUnverifiedOidcPayload,
	HostedRunnerError,
	syncHostedEvidence,
} from "../../packages/cli/dist/hosted-runner.js";
import {
	HOSTED_OIDC_AUDIENCE,
	HOSTED_OIDC_ISSUER,
	HOSTED_REDACTION_EXCLUDES,
	sha256Jcs,
} from "../../packages/contracts/dist/index.js";

const cli = fileURLToPath(new URL("../../packages/cli/dist/cli.js", import.meta.url));
const ciArtifactPath = new URL(
	"../../fixtures/contracts/hosted/v1/ci-bundle.json",
	import.meta.url,
);
const ciBundle = JSON.parse(await readFile(ciArtifactPath, "utf8"));
const stackVersion = JSON.parse(
	await readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;

const claims = {
	iss: HOSTED_OIDC_ISSUER,
	aud: HOSTED_OIDC_AUDIENCE,
	sub: "repo:clfhhc/test-graphrefly:ref:refs/heads/main",
	repository_id: ciBundle.invocation.repository.id,
	repository_owner_id: ciBundle.invocation.repository.ownerId,
	workflow_ref:
		"clfhhc/test-graphrefly/.github/workflows/graphrefly-stack-hosted.yml@refs/heads/main",
	workflow_sha: "4".repeat(40),
	run_id: "29654453077",
	run_attempt: "1",
	actor_id: ciBundle.invocation.run.actorId,
	event_name: "workflow_run",
};

const jwt = (payload) =>
	[
		Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
		Buffer.from(JSON.stringify(payload)).toString("base64url"),
		"test-signature",
	].join(".");

function invoke(repository, args) {
	return spawnSync(process.execPath, [cli, ...args], {
		cwd: repository,
		encoding: "utf8",
	});
}

test("hosted init writes a separate no-checkout least-privilege OIDC workflow", async (context) => {
	const repository = await mkdtemp(resolve(tmpdir(), "graphrefly-stack-hosted-init-"));
	context.after(() => rm(repository, { recursive: true, force: true }));
	assert.equal(spawnSync("git", ["-C", repository, "init", "-q"]).status, 0);

	const initialized = invoke(repository, [
		"hosted",
		"init",
		"--endpoint",
		"https://stack.example.test",
		"--json",
	]);
	assert.equal(initialized.status, 0, initialized.stderr);
	const result = JSON.parse(initialized.stdout);
	assert.equal(result.command, "hosted-init");
	assert.equal(result.data.workflow, ".github/workflows/graphrefly-stack-hosted.yml");
	assert.equal(result.data.profile, "gate-summary-v1");
	assert.equal(result.data.stackVersion, stackVersion);
	const workflow = await readFile(resolve(repository, result.data.workflow), "utf8");
	assert.match(workflow, /^name: GraphReFly Stack Hosted Sync$/mu);
	assert.match(workflow, /^ {2}workflow_run:$/mu);
	assert.match(workflow, /^permissions: \{\}$/mu);
	assert.match(workflow, /^ {6}actions: read$/mu);
	assert.match(workflow, /^ {6}id-token: write$/mu);
	assert.match(workflow, /github\.event\.workflow_run\.id/u);
	assert.ok(workflow.includes(`@graphrefly/stack@${stackVersion}`));
	assert.match(workflow, /--profile gate-summary-v1/u);
	assert.match(workflow, /npm_config_ignore_scripts: "true"/u);
	assert.match(workflow, /--endpoint "\$GRAPHREFLY_STACK_HOSTED_ENDPOINT"/u);
	assert.doesNotMatch(workflow, /actions\/checkout|contents:|secrets\.|pull-requests: write/u);
	assert.doesNotMatch(workflow, /uses: [^\n]+@v[0-9]+/u);
	assert.equal([...workflow.matchAll(/uses: [^@\n]+@([0-9a-f]{40})/gu)].length, 2);

	const repeated = invoke(repository, [
		"hosted",
		"init",
		"--endpoint",
		"https://stack.example.test",
		"--json",
	]);
	assert.equal(repeated.status, 1);
	assert.equal(JSON.parse(repeated.stdout).error.code, "HOSTED_WORKFLOW_EXISTS");
	const insecure = invoke(repository, [
		"hosted",
		"init",
		"--endpoint",
		"http://stack.example.test",
		"--force",
		"--json",
	]);
	assert.equal(insecure.status, 1);
	assert.equal(JSON.parse(insecure.stdout).error.code, "HOSTED_ENDPOINT_INVALID");
	const expressionInjection = invoke(repository, [
		"hosted",
		"init",
		"--endpoint",
		["https://stack.example.test/", "$", "{{ secrets.TOKEN }}"].join(""),
		"--force",
		"--json",
	]);
	assert.equal(expressionInjection.status, 1);
	assert.equal(JSON.parse(expressionInjection.stdout).error.code, "HOSTED_ENDPOINT_INVALID");
});

test("hosted runner derives the default summary without transmitting the portable bundle", async () => {
	const envelope = await createHostedEnvelope({
		ciBundle,
		profile: "gate-summary-v1",
		syncIdentity: claims,
	});
	assert.equal(envelope.profile, "gate-summary-v1");
	assert.equal(envelope.redaction.explicitOptIn, false);
	assert.deepEqual(envelope.redaction.excludes, HOSTED_REDACTION_EXCLUDES);
	assert.equal(envelope.payload.schema, "graphrefly.stack.hosted-gate-summary.v1");
	assert.equal("bundle" in envelope.payload, false);
	assert.equal(envelope.payload.gateResult.verdict, ciBundle.result.gateResult.verdict);
	assert.equal(
		envelope.source.sourceBundleDigest.value,
		sha256Jcs(ciBundle),
		"the compact summary still cross-binds the complete CI source bundle",
	);
	assert.equal(envelope.redaction.includes[0].digest.value, sha256Jcs(envelope.payload));
	assert.equal(envelope.source.head.value, ciBundle.invocation.event.head.value);
});

test("semantic review requires explicit profile selection and preserves every verified nested byte", async () => {
	const envelope = await createHostedEnvelope({
		ciBundle,
		profile: "semantic-review-v1",
		syncIdentity: claims,
	});
	assert.equal(envelope.redaction.explicitOptIn, true);
	assert.deepEqual(envelope.payload.bundle, ciBundle);
	assert.equal(
		envelope.payload.bundle.result.portableBundleDigest.value,
		sha256Jcs(ciBundle.portableBundle),
	);
	assert.equal(envelope.redaction.includes[0].digest.value, sha256Jcs(envelope.payload));
});

test("hosted envelope construction fails closed on tamper and cross-repository identity", async () => {
	const tampered = structuredClone(ciBundle);
	tampered.invocation.run.attempt += 1;
	await assert.rejects(
		createHostedEnvelope({ ciBundle: tampered, profile: "gate-summary-v1", syncIdentity: claims }),
		(error) => error instanceof HostedRunnerError && error.code === "HOSTED_SOURCE_BINDING_INVALID",
	);
	const nestedTamper = structuredClone(ciBundle);
	nestedTamper.portableBundle.artifacts["records.json"][0].recordId = "tampered-record";
	nestedTamper.result.portableBundleDigest.value = sha256Jcs(nestedTamper.portableBundle);
	nestedTamper.result.artifactName = `graphrefly-stack-ci-${nestedTamper.result.portableBundleDigest.value}`;
	await assert.rejects(
		createHostedEnvelope({
			ciBundle: nestedTamper,
			profile: "gate-summary-v1",
			syncIdentity: claims,
		}),
		(error) => error instanceof HostedRunnerError && error.code === "HOSTED_SOURCE_BINDING_INVALID",
	);
	await assert.rejects(
		createHostedEnvelope({
			ciBundle,
			profile: "gate-summary-v1",
			syncIdentity: { ...claims, repository_id: "999999" },
		}),
		(error) =>
			error instanceof HostedRunnerError && error.code === "HOSTED_IDENTITY_BINDING_INVALID",
	);
	await assert.rejects(
		createHostedEnvelope({
			ciBundle,
			profile: "gate-summary-v1",
			syncIdentity: { ...claims, aud: "attacker" },
		}),
		(error) => error instanceof HostedRunnerError && error.code === "HOSTED_OIDC_AUDIENCE_INVALID",
	);
});

test("hosted sync sends canonical envelope bytes with a bearer OIDC token and supports idempotency", async () => {
	const token = jwt(claims);
	assert.deepEqual(decodeUnverifiedOidcPayload(token), claims);
	let captured;
	const fetchImpl = async (url, init) => {
		captured = { url: String(url), init };
		return new Response(JSON.stringify({ id: "envelope-1" }), {
			status: 201,
			headers: { "Content-Type": "application/json" },
		});
	};
	const synced = await syncHostedEvidence({
		artifact: ciArtifactPath.pathname,
		endpoint: "http://127.0.0.1:4174",
		profile: "gate-summary-v1",
		fetchImpl,
		oidcToken: token,
	});
	assert.equal(synced.status, "synced");
	assert.equal(captured.url, "http://127.0.0.1:4174/v1/envelopes");
	assert.equal(captured.init.headers.Authorization, `Bearer ${token}`);
	assert.equal(captured.init.redirect, "error");
	assert.equal(captured.init.headers["X-GraphReFly-Envelope-Digest"], synced.envelopeDigest.value);
	const body = JSON.parse(captured.init.body);
	assert.equal(body.profile, "gate-summary-v1");
	assert.equal("bundle" in body.payload, false);

	const duplicate = await syncHostedEvidence({
		artifact: ciArtifactPath.pathname,
		endpoint: "http://127.0.0.1:4174",
		profile: "gate-summary-v1",
		fetchImpl: async () => new Response(JSON.stringify({ id: "envelope-1" }), { status: 409 }),
		oidcToken: token,
	});
	assert.equal(duplicate.status, "already-synced");
});

test("hosted sync requests only the fixed audience from a GitHub Actions HTTPS endpoint", async () => {
	const token = jwt(claims);
	const requests = [];
	const fetchImpl = async (url, init) => {
		requests.push({ url: String(url), init });
		if (requests.length === 1) {
			return new Response(JSON.stringify({ value: token }), { status: 200 });
		}
		return new Response(JSON.stringify({ id: "envelope-oidc" }), { status: 201 });
	};
	const synced = await syncHostedEvidence({
		artifact: ciArtifactPath.pathname,
		endpoint: "http://127.0.0.1:4174",
		profile: "gate-summary-v1",
		fetchImpl,
		environment: {
			ACTIONS_ID_TOKEN_REQUEST_URL:
				"https://pipelines.actions.githubusercontent.com/token?api-version=2.0",
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
		},
	});
	assert.equal(synced.status, "synced");
	assert.match(requests[0].url, /audience=graphrefly-stack-hosted/u);
	assert.equal(requests[0].init.headers.Authorization, "Bearer runner-request-token");
	assert.equal(requests[0].init.redirect, "error");
	assert.equal(requests[1].init.headers.Authorization, `Bearer ${token}`);

	let called = false;
	await assert.rejects(
		syncHostedEvidence({
			artifact: ciArtifactPath.pathname,
			endpoint: "http://127.0.0.1:4174",
			profile: "gate-summary-v1",
			fetchImpl: async () => {
				called = true;
				return new Response(null, { status: 500 });
			},
			environment: {
				ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.example/token",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
			},
		}),
		(error) => error instanceof HostedRunnerError && error.code === "HOSTED_OIDC_UNAVAILABLE",
	);
	assert.equal(called, false);
});

test("hosted sync maps quota and size responses without changing gate semantics", async () => {
	const token = jwt(claims);
	for (const [status, code] of [
		[413, "HOSTED_ENVELOPE_TOO_LARGE"],
		[429, "HOSTED_QUOTA_EXCEEDED"],
	]) {
		await assert.rejects(
			syncHostedEvidence({
				artifact: ciArtifactPath.pathname,
				endpoint: "http://127.0.0.1:4174",
				profile: "gate-summary-v1",
				fetchImpl: async () => new Response(null, { status }),
				oidcToken: token,
			}),
			(error) => error instanceof HostedRunnerError && error.code === code,
		);
	}
	assert.equal(ciBundle.result.gateResult.verdict, "pass");
});
