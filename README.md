# GraphReFly Stack

**Semantic stacked diffs that know when their architectural assumptions expire.**

GraphReFly Stack is an OpenAI Build Week developer tool built with Codex, GPT-5.6, Git, and
GraphReFly. It adds a semantic validity layer above Git: every work-unit commit is bound to a
GraphBlueprint witness, an allowed source scope, dependency claims, required checks, and a
deterministic `GateResult`.

Git can report a clean rebase while an agent-generated change is no longer valid under the
architecture it was planned against. GraphReFly Stack makes that mismatch visible, keeps unaffected
work green, and asks GPT-5.6 to replan only the stale work. GPT-5.6 proposes; deterministic code
decides validity.

## Judge this in 90 seconds — no credentials required

Requirements: macOS or Linux, Node.js 24, pnpm 11.7, Git, and
[mise](https://mise.jdx.dev/). Clean-room evidence covers macOS and a Linux Node 24 container. The
CLI and local web review shell use no hosted service or database.

```bash
mise install
mise run bootstrap
pnpm build
pnpm cli review --bundle evidence/runs/refresh-token-rotation-v1-live
```

Open <http://127.0.0.1:4173>, then:

1. Select U1, U2, and U3 in the real Git stack.
2. See U1 remain valid while U2 is blocked by `BLUEPRINT_CHANGED` and `POLICY_CHANGED`, and U3 is
   blocked only by `DEPENDENCY_INVALID`.
3. Compare the focused GraphReFly structural delta with the Semantic Change Card and deterministic
   gate.
4. Open the real source patch on demand or download the portable redacted evidence bundle.
5. Click a local reviewer draft action and verify that it cannot edit evidence or `GateResult`.

The checked-in bundle includes validated GPT-5.6 provenance, but replaying it never needs an API key,
OpenAI login, test account, or network connection.

## CLI judging path

Create a byte-stable private fixture and exercise the deterministic cases:

```bash
pnpm cli fixture create --force --json
pnpm cli gate --case current-valid --json
pnpm cli gate --case clean-rebase-semantic-stale --json # expected exit 2
pnpm cli gate --case fresh-selective-replan --json
pnpm cli export --output .private/exports/judge-run --json
```

The CLI emits one versioned JSON envelope on stdout. Exit `0` means success, exit `2` is an expected
deterministic blocked gate, and exit `1` is a usage, schema, or runtime error. Run the complete local
quality gate with `pnpm check`.

## What the flagship proves

The fixed refresh-token-rotation stack contains U1 contracts, U2 GraphReFly runtime, and U3 HTTP
adapter work. A concurrent architecture commit introduces `sessionMutationBroker` and advances the
session-write policy. Git rebases the stack without a text conflict and ordinary checks stay green,
but the deterministic semantic gate detects that U2's architecture and policy witnesses expired.
Only U2 and its dependent U3 are invalidated. A validated GPT-5.6 selective replan preserves U1,
rebinds U2 and U3 to current witnesses, and restores the final gate without model self-grading.

The evidence bundle covers six locked cases: current-valid, clean-rebase-semantic-stale,
unrelated-change-still-valid, stale-parent, forged-or-wrong-scope, and fresh-selective-replan.

## Live GPT-5.6 path

Replay is the default. Live mode is explicit and performs exactly one server-side Codex SDK request
per command with a strict output schema, read-only sandbox, approval disabled, network disabled, and
a 120-second timeout:

```bash
pnpm cli fixture create --force --json
GRAPHREFLY_STACK_CODEX_PATH=/path/to/compatible/codex \
  pnpm cli plan --mode live --json
GRAPHREFLY_STACK_CODEX_PATH=/path/to/compatible/codex \
  pnpm cli replan --mode live --json
```

Authentication may come from an existing `CODEX_HOME`, `OPENAI_API_KEY`, or `CODEX_API_KEY`; never
commit or share credentials. `GRAPHREFLY_STACK_MODEL` defaults to `gpt-5.6-sol`, and
`GRAPHREFLY_STACK_REASONING_EFFORT` defaults to `high`. The validated Build Week run used Codex SDK
0.143.0 with a compatible `codex-cli 0.144.5` runtime override. Exact model, effort, runtime, thread,
token usage, prompt version, and response/output digests are preserved in the redacted bundle.

The validated plan used 14,030 input, 370 output, and 52 reasoning tokens; the corrected selective
replan used 14,351 input, 360 output, and 105 reasoning tokens. There are no autonomous retries or
unbounded model loops. A provider failure is an error unless the caller explicitly opts into the
provenance-labelled replay fallback.

## Architecture and trust boundary

- `packages/contracts` owns strict schemas and RFC 8785 canonical bytes.
- `packages/core` owns deterministic gate behavior and adapter ports.
- `packages/cli` is the only composition root for Git, GraphReFly, Codex, evidence export, and the
  loopback review server.
- `apps/review` is a read-only React projection of canonical artifacts.

GPT-5.6 proposes plans, claim wording, and selective replans. GraphReFly provides commit-indexed
architecture snapshots. Deterministic code owns scope, freshness, dependency, check, and verdict
semantics. A human review decision is separately attributed and cannot mutate the gate.

## How Codex built the project

The majority of GraphReFly Stack was built in one long-lived Codex task using a canonical JSONL
sequencer. Codex helped consolidate the scenario and contract decisions, scaffold the TypeScript
workspaces, implement real-Git fixtures and the deterministic gate, integrate the server-side Codex
SDK seam, adversarially test provenance and scope boundaries, and iterate on the synchronized review
UI. Human approvals locked the material product, contract, architecture, and UI decisions before
core behavior was implemented.

GPT-5.6 is also part of the finished product: its real structured ChangePlan and selective-replan
outputs are schema-validated, checked against locked anchors, bound to exact provenance, and then
passed to deterministic code. The model cannot widen scopes, change dependencies or checks, approve
work, or generate its own verdict.

## Build Week work and prior work

GraphReFly itself is a pre-existing external dependency, pinned as `@graphrefly/ts` 0.1.1. The
GraphReFly Stack product, contracts, real-Git flagship fixture, deterministic semantic gate, Codex
integration, evidence exporter, and review UI were created or materially implemented during the
Build Week submission period beginning July 13, 2026. The repository's dated Git history and
canonical milestones in `docs/evidence/milestones.jsonl` distinguish that work.

## Evidence, security, and limitations

- `evidence/runs/refresh-token-rotation-v1-live/manifest.json` binds 24 redacted artifacts by
  SHA-256 over canonical JSON.
- `evidence-bundle.json` is a portable projection of that exact manifest and its artifacts; it is not
  self-listed because that would create a circular hash.
- Raw provider responses, generated repositories, and sensitive submission drafts stay under
  ignored `.private/` paths.
- The review server binds to loopback by default, sends a restrictive CSP, accepts only GET/HEAD, and
  exposes no write endpoint.
- Reviewer drafts are local, unauthenticated, and non-persistent. Automatic approval and merge are
  intentionally outside the MVP.
- The GraphReFly provider is fixed to the flagship fixture; arbitrary-repository discovery and other
  graph providers are deferred.

Canonical scope, decisions, contracts, sequence, and evidence requirements are indexed by
[`docs/sources.jsonl`](docs/sources.jsonl). Read [`docs/README.md`](docs/README.md) for the authority
map.

## Repository map

- `apps/review/` — synchronized local review UI
- `packages/` — contracts, deterministic core, and CLI composition root
- `contracts/v1/` and `fixtures/` — strict schemas and deterministic fixture authorities
- `evidence/` — curated redacted evidence bundles
- `docs/` — canonical JSONL project and submission records
- `.agents/skills/` — project workflows that operate on canonical records
- `.private/` — ignored raw responses, live runs, generated repositories, and drafts

## License

[MIT](LICENSE)
