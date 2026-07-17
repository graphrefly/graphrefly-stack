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

## Judge the usable product in 90 seconds — no credentials required

Requirements: macOS or Linux, Node.js 24, pnpm 11.7, Git, and
[mise](https://mise.jdx.dev/). Clean-room evidence covers macOS and a Linux Node 24 container. The
CLI and local web review shell use no hosted service or database.

```bash
mise install
mise run bootstrap
pnpm build
pnpm product:sample
REPO=.private/fixtures/generic-linear-v1
BASE=$(git -C "$REPO" rev-list --max-parents=0 HEAD)
pnpm cli review --repo "$REPO" --base "$BASE" --head HEAD
```

Open <http://127.0.0.1:4173>, then:

1. Select each discovered commit in the real four-commit Git repository.
2. See the Blueprint and parent delta produced by the sample repository's pinned
   `@graphrefly/ts@0.3.0` runtime: node/edge addition, mounted-subgraph addition, then metadata-only
   `node-changed`.
3. Verify that commit OID, Blueprint hash, upstream Mermaid diagram, delta events, and split code diff
   move together.
4. Expand repository evidence or commit lineage only when needed. No session, delivery, fixture, or
   fake semantic-gate state appears in the generic review.

`product:sample` creates the small repository and its commits for real under `.private/`; it does not
feed checked-in Blueprint or delta output to the review command. The CLI executes the configured
entrypoint at the base and every commit in permission-limited detached worktrees, then parses,
verifies, renders, and diffs only with the target runtime's public GraphReFly APIs.

## Generic repository contract

A supported repository is a local, merge-free linear Git range with:

- a strict `.graphrefly-stack.json` selecting one repository-relative Blueprint entrypoint;
- an exact `@graphrefly/ts` 0.3.0 pin and matching installed package;
- one root pnpm, npm, or Yarn lockfile; and
- unchanged `package.json` and lockfile across the reviewed range.

The entrypoint must emit one hashed GraphBlueprint v2 JSON value without credentials, writes,
network access, or child processes. To inspect the same product facts without starting the web UI:

```bash
pnpm cli review --repo "$REPO" --base "$BASE" --head HEAD --json
```

The generic payload is commit-centric. When a repository has not adopted semantic change records,
the UI says `Semantic gate not configured`; it never turns missing semantic evidence into a passing
`GateResult`.

## Historical semantic flagship and CLI cases

The earlier refresh-token flagship remains as compatibility evidence for selective semantic
invalidation and GPT-5.6 replanning:

```bash
pnpm cli fixture create --force --json
pnpm cli gate --case current-valid --json
pnpm cli gate --case clean-rebase-semantic-stale --json # expected exit 2
pnpm cli gate --case fresh-selective-replan --json
pnpm cli export --output .private/exports/judge-run --json
pnpm cli review --bundle evidence/runs/refresh-token-rotation-v1-live/evidence-bundle.json
```

The CLI emits one versioned JSON envelope on stdout. Exit `0` means success, exit `2` is an expected
deterministic blocked gate, and exit `1` is a usage, schema, or runtime error. Run the complete local
quality gate with `pnpm check`.

## What the historical flagship proves

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

- `packages/contracts` owns strict schemas, including the generic repository and review protocols,
  plus RFC 8785 canonical bytes.
- `packages/core` owns deterministic gate behavior and adapter ports.
- `packages/cli` is the only composition root for Git, GraphReFly, Codex, evidence export, and the
  loopback review server.
- `apps/review` is a read-only React projection of canonical artifacts.

For generic structural review, the repository's target GraphReFly runtime exclusively owns Blueprint
parsing, hash verification, readable diagram source, and structural delta. For the historical
semantic workflow, GPT-5.6 proposes plans, claim wording, and selective replans while deterministic
code owns scope, freshness, dependency, check, and verdict semantics.

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

GraphReFly itself is a pre-existing external dependency. The generic product pins the published
`@graphrefly/ts` 0.3.0 Blueprint v2 API; the historical flagship preserves its earlier v1 evidence. The
GraphReFly Stack product, contracts, real-Git flagship fixture, deterministic semantic gate, Codex
integration, evidence exporter, and review UI were created or materially implemented during the
Build Week submission period beginning July 13, 2026. The repository's dated Git history and
canonical milestones in `docs/evidence/milestones.jsonl` distinguish that work.

## Evidence, security, and limitations

- `evidence/runs/refresh-token-rotation-v1-live/evidence-bundle.json` embeds its manifest and every
  redacted logical artifact, each bound by SHA-256 over canonical JSON. Expanded copies are generated
  output and are not tracked.
- The portable bundle is not self-listed in its manifest because that would create a circular hash.
- Raw provider responses, generated repositories, and sensitive submission drafts stay under
  ignored `.private/` paths.
- The review server only binds to `127.0.0.1`, sends a restrictive CSP, accepts only GET/HEAD, and
  exposes no write endpoint.
- Generic Blueprint entrypoints run with an empty environment, a five-second timeout, a one-MiB
  stdout bound, read-only filesystem allowlists, and no network or child-process permission.
- Generic payloads omit Blueprint provenance and reject absolute paths in topology metadata before
  serving browser data.
- The first release supports a maximum of 64 commits in one merge-free linear range. DAG stacks,
  per-revision dependency installs, monorepo package selection, hosted review, planning, mutual
  exclusion, edit scopes, conflict avoidance, and revert remain roadmap work.

Canonical scope, decisions, contracts, sequence, and evidence requirements are indexed by
[`docs/sources.jsonl`](docs/sources.jsonl). Read [`docs/README.md`](docs/README.md) for the authority
map.

## Repository map

- `apps/review/` — synchronized local review UI
- `packages/` — contracts, deterministic core, and CLI composition root
- `contracts/` and `fixtures/` — strict schemas, compatibility artifacts, and conformance scenarios
- `evidence/` — curated redacted evidence bundles
- `docs/` — canonical JSONL project and submission records
- `.agents/skills/` — project workflows that operate on canonical records
- `.private/` — ignored raw responses, live runs, generated repositories, and drafts

## License

[MIT](LICENSE)
