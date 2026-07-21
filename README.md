# GraphReFly Stack

**Review AI changes by intent, architectural reach, and deterministic readiness.**

GraphReFly Stack is an OpenAI Build Week developer tool built with Codex, GPT-5.6, Git, and
GraphReFly. It compresses a large agent-generated change into the three questions a human reviewer
actually needs: **Intent** (what should change and remain true), **Reach** (what code and graph
structure actually changed), and **Readiness** (whether deterministic evidence still supports
approval). Exact Plan, policy, predicate, binding, check, and witness records stay available under
Technical details without becoming vocabulary every developer must learn.

Git can report a clean rebase while an agent-generated change is no longer valid under the
architecture it was planned against. GraphReFly Stack makes that mismatch visible, calls out
unexpected reach before the raw diff, keeps unaffected work green, and asks GPT-5.6 to replan only
the stale work. GPT-5.6 proposes; deterministic code decides validity.

## Judge it in 90 seconds

```bash
pnpm add -D @graphrefly/stack@0.1.7
pnpm exec grfs init --graph-module src/application-graph.ts
pnpm exec grfs review --repo . --base <commit-before-the-change> --head HEAD
```

Open the printed loopback URL. The left column is the real Git stack, the Blueprint is executed and
verified at the selected Git object, and the change contract immediately shows Intent, expected
versus observed Reach, and Readiness. If exactly one accepted semantic Plan covers `HEAD`, Stack
finds it automatically—ordinary reviewers do not pass `--plan-id`. Select **Review changes** to
record Approve or Request changes against the exact commit and Blueprint; add new commits after a
request, rerun review, and the earlier decision becomes stale because its bound witnesses changed.

## Install and review a GraphReFly repository

Requirements: macOS or Linux, Node.js 24, pnpm 11.7, and Git. The CLI and local web review shell use
no hosted service, database, or credentials. Install it in the GraphReFly repository you want to
review:

```bash
pnpm add -D @graphrefly/stack@0.1.7
pnpm exec grfs init --graph-module src/application-graph.ts

BASE=<the commit immediately before your stack>
pnpm exec grfs review --repo . --base "$BASE" --head HEAD
```

The review command stays running and prints its loopback URL; it does not launch a browser
automatically. Open the printed URL (normally <http://127.0.0.1:4173>), then:

1. Read **Intent**: the accepted outcome and behavior that must remain true.
2. Read **Reach**: expected areas beside exact changed paths and GraphReFly effects; unexpected reach
   is called out before the raw diff.
3. Read **Readiness**: the unchanged deterministic verdict, failed checks or promises, and next
   action.
4. Select commits to synchronize the real OID, GraphBlueprint, parent delta, and split code diff.
5. Use **Review changes** to record Approve or Request changes for the exact commit and Blueprint.
6. Expand **Technical details** only when debugging Plan, WorkUnit, predicate, binding, record, or
   digest evidence.

Local review decisions and their summaries are strict immutable records under the repository's Git
common directory at `.git/grfs/reviews`; they never appear in `git status`, change source files, or
update Git refs. The Technical details disclosure offers an explicit portable review export after a
decision exists. That content-hashed bundle is the explicit sharing boundary for another reviewer or
CI. A future hosted GraphReFly Stack can wrap selected exported artifacts in its policy-redacted
upload envelope; this release neither treats the local export as upload-ready nor uploads review
state automatically.

`--graph-module` means the repository's root Graph construction module, not the only Graph module
allowed in the repository. That root module may import, compose, and mount any number of Graphs and
subgraphs. The first version reviews one configured root Blueprint target at a time; selecting among
multiple independent application roots in a monorepo is roadmap work.

`grfs init` does not guess how an arbitrary application assembles that root Graph. You point it at
the module and export that already construct it once during onboarding. The command generates the
strict `.graphrefly-stack.json` config and a small deterministic
`graphrefly-stack.blueprint.mjs` adapter; both are ordinary source files that should be committed.
Use `--graph-export <name>` when the module does not export `createApplicationGraph`. JSON is the v1
configuration format; optional YAML and TOML authoring formats are deferred roadmap work and must
normalize to the same strict configuration contract before execution.

Initialization may happen after the stack already exists. The review snapshots the configured
adapter and supplies those same bounded bytes only inside isolated detached revisions where that
entrypoint did not exist yet; it does not rewrite repository history. The referenced root Graph
module must exist at every reviewed revision. Commit the config and adapter after onboarding so
future reviews have a Git-owned configuration witness.

The CLI executes the adapter at the base and every commit in permission-limited detached worktrees.
Each invocation calls the real GraphReFly `graph.blueprint()` API; Stack then parses, verifies,
renders, and diffs only with the installed runtime's public GraphReFly APIs.

## Generic repository contract

A supported repository is a local, merge-free linear Git range with:

- a strict `.graphrefly-stack.json` selecting one repository-relative Blueprint entrypoint;
- an installed `@graphrefly/ts` version in `>=0.3.0 <0.4.0`;
- a dependency or devDependency range at every reviewed revision that accepts that installed exact
  version; and
- one recognized root pnpm, npm, or Yarn lockfile at every revision.

Normal package and lockfile changes are allowed inside the stack. This first version deliberately
uses one installed GraphReFly runtime for the whole review, so it fails closed if a historical
revision declares a range incompatible with that runtime. Installing and caching a different runtime
for every revision is roadmap work.

The entrypoint must emit one hashed GraphBlueprint v2 JSON value without credentials, writes,
network access, or child processes. To inspect the same product facts without starting the web UI:

```bash
pnpm exec grfs review --repo . --base "$BASE" --head HEAD --json
```

The generic payload is commit-centric. When a repository has not adopted semantic change records,
the payload records that internal absence but the primary UI does not advertise an unavailable
gate, and it never turns missing semantic evidence into a passing `GateResult`. A local human
decision remains separate from any future semantic gate and does not approve or merge a GitHub pull
request.

Before registry publication, the same install path is exercised from the packed tarball rather than
from workspace imports:

```bash
pnpm test:package
```

That test packs `@graphrefly/stack`, installs it with GraphReFly 0.3.x in a temporary independent Git
repository, runs `pnpm exec grfs init`, creates a real two-commit stack, verifies its Blueprint delta
and structured code diff, and fetches the embedded review UI plus its review-data endpoint.

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

GraphReFly itself is a pre-existing external dependency. The generic product targets the published
`@graphrefly/ts` 0.3.x Blueprint v2 API surface; the historical flagship preserves its earlier v1
evidence. The GraphReFly Stack product, contracts, real-Git flagship fixture, deterministic semantic
gate, Codex integration, evidence exporter, and review UI were created or materially implemented
during the Build Week submission period beginning July 13, 2026. The repository's dated Git history
and canonical milestones in `docs/evidence/milestones.jsonl` distinguish that work.

## Evidence, security, and limitations

- `evidence/runs/refresh-token-rotation-v1-live/evidence-bundle.json` embeds its manifest and every
  redacted logical artifact, each bound by SHA-256 over canonical JSON. Expanded copies are generated
  output and are not tracked.
- The portable bundle is not self-listed in its manifest because that would create a circular hash.
- Raw provider responses, generated repositories, and sensitive submission drafts stay under
  ignored `.private/` paths.
- The review server only binds to `127.0.0.1` and sends a restrictive CSP. Its sole write surface is
  a size-bounded, same-origin `application/json` endpoint that appends validated review decisions
  below `.git/grfs`; source files, Git objects and refs, repository config, and `GateResult` remain
  read-only.
- Generic Blueprint entrypoints run with an empty environment, a five-second timeout, a one-MiB
  stdout bound, read-only filesystem allowlists, and no network or child-process permission.
- Generic payloads omit Blueprint provenance and reject absolute paths in topology metadata before
  serving browser data.
- Local review supports bounded ranges of at most 64 Git objects. Merge-free changes use the linear
  semantic runner; accepted merge histories route to the bounded clean-binary DAG runner. Manual
  merge resolution, octopus merges, larger bounds, per-revision dependency installs, and monorepo
  package selection remain explicit limits.
- Repository planning, CI parity, optimistic pull-request integration, bounded DAG and merge-group
  evidence, hosted redacted review contracts, and evidence-backed recovery are implemented and
  independently tested. The public judging path intentionally stays on local repository review; it
  does not claim a deployed hosted service, queue management, automatic merge, or arbitrary
  filesystem prevention.

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
