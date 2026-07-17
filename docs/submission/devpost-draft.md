# GraphReFly Stack — Devpost draft

This is a rendered submission draft. Canonical readiness state remains in `checklist.jsonl`; product
claims resolve to the JSONL authorities and the redacted evidence bundle.

## Category

Developer Tools

## Tagline

Review every stacked commit as Git identity, GraphReFly graph delta, and exact code diff.

## What it does

GraphReFly Stack turns a compatible local GraphReFly repository and a real linear Git range into a
commit-by-commit review surface. Select a discovered commit and its immutable OID, target-generated
GraphBlueprint, parent structural delta, and GitHub-style split code diff move together. The diagram
is not reconstructed by Stack: the target repository emits GraphBlueprint v2 and the installed
`@graphrefly/ts` runtime parses, verifies, renders, and diffs that evidence through public upstream
APIs.

The first usable release is intentionally narrow and explicit. A repository supplies one strict
`.graphrefly-stack.json` entrypoint, exactly pins `@graphrefly/ts` 0.3.0, preserves its root manifest
and lock across the reviewed range, and provides a merge-free linear range of at most 64 commits.
Each revision runs in a detached, read-only, network-denied worktree with an empty environment, a
five-second timeout, and a one-mebibyte output bound. Configuration, ancestry, dependency,
execution, Blueprint, diagnostic, hash, renderer, or delta failure stops the review. There is no
fixture fallback.

The local React UI makes the core user path concrete: real stack at left, GraphReFly-generated
Blueprint and graph events in the center, and exact parent code changes below. Provenance and Git
lineage are collapsed until requested. If no semantic records exist, the UI says "Semantic gate not
configured" instead of inventing work-unit identities or a passing verdict.

## How we built it

Codex was the primary implementation environment across one long-lived task. It helped recover and
lock the nine-question product design, strengthen the upstream GraphReFly Blueprint APIs, build the
generic repository runner, define versioned schemas, create real Git conformance repositories,
adversarially test every fail-closed boundary, and browser-test synchronized desktop and mobile UI.
Human approvals locked material product, contract, architecture, and sequencing decisions.

The deterministic generic review path does not require a model call. It relies on TypeScript, pnpm,
React 19, Vite 8, system Git, exact `@graphrefly/ts` 0.3.0 packages, strict JSON Schema, SHA-256
Blueprint witnesses, and server-parsed Git diffs. The same public command is tested against flat and
mounted repositories, including node, edge, subgraph, metadata, source-only, and spaced-path cases.

GPT-5.6 is a separate, already-proven planning layer rather than a fabricated part of the generic
verdict. Real `gpt-5.6-sol` ChangePlan and selective-replan outputs pass strict structured-output
schemas and locked-anchor postvalidation. The model may improve intent and claim wording, but cannot
change work-unit IDs, dependencies, source scopes, claim IDs, checks, or compute validity.
Deterministic code alone computes the historical semantic gate.

## Challenges

The central challenge was proving the product on repository code we did not pre-render. Executable
graphs are runtime-composed, so source parsing would be both incomplete and unsafe. We introduced an
explicit target-owned Blueprint entrypoint, exact dependency continuity, and a constrained detached
runner. Stack consumes only upstream GraphReFly artifacts and helpers; it does not become a second
graph implementation.

The second challenge was keeping selection truthful across three evidence domains. Commit identity,
Blueprint hash, structural events, diagram source, and split diff must all describe the same parent
edge. Schema validation, canonical OIDs, server-side diff parsing, and synchronized browser state
make that relationship inspectable.

## Accomplishments

- One public command reviews materially different compatible repositories with no fixture branch.
- Every discovered commit has a verified GraphBlueprint v2, upstream-only diagram and delta, and
  structured parent code diff.
- Real samples prove node-added, edge-added, subgraph-added, node-changed, and source-only changes.
- Nine specified repository failures stop closed; environment, path, package, time, size, and commit
  bounds are enforced.
- Desktop and mobile UI keep commit, diagram, delta, and code diff synchronized with secondary
  evidence collapsed.
- Historical GPT-5.6 planning evidence remains available without pretending the model self-grades.

## What we learned

The useful unit of GraphReFly review is not a screenshot or an AI summary. It is one Git parent edge
bound to a target-generated Blueprint witness and the exact code diff that produced it. Narrow
compatibility rules make the first product more trustworthy because unsupported repositories fail
explicitly instead of quietly falling back to demo data.

## What's next

The long-term product includes DAG stacks, a fully hosted SaaS, in-product planning, mutual
exclusion, proactive conflict avoidance, AI and human edit-scope enforcement, and safe revert. The
current milestone stays linear-first so it can already be used and judged end to end. Per-revision
dependency installation, immutable package caching, and monorepo package selection are the nearest
compatibility expansions.

## Feedback session

Primary `/feedback` Codex Session ID: `019f6b26-93ee-76b1-862e-8a9751692da9`

## Submission fields still requiring external action

- Public repository URL after the validated implementation batch is committed and pushed.
- Public YouTube URL after the refreshed under-three-minute narrated demo is approved and uploaded.
- Final Devpost save/submit confirmation before July 21, 2026 at 5:00 PM Pacific.
