# GraphReFly Stack — Devpost draft

This is a rendered submission draft. Canonical readiness state remains in `checklist.jsonl`; product
claims resolve to the JSONL authorities and the redacted evidence bundle.

## Category

Developer Tools

## Tagline

Semantic stacked diffs that know when their architectural assumptions expire.

## What it does

GraphReFly Stack adds a semantic validity layer above Git for agent-generated stacked changes. Git
can rebase a stack cleanly even when the architecture that shaped an earlier plan has changed.
GraphReFly Stack binds each work-unit commit to a commit-indexed GraphBlueprint, allowed source
scope, dependencies, policy witness, and required checks. A deterministic gate then tells a reviewer
which units remain valid, which assumptions expired, and which downstream work is affected.

The flagship refresh-token scenario contains three dependent work units. A concurrent architecture
change introduces a session-mutation broker and advances policy without touching the feature stack's
files. Git reports a conflict-free rebase and ordinary tests pass. GraphReFly Stack still keeps U1
green, invalidates U2 for exact Blueprint and policy reasons, and invalidates U3 only through its
dependency. GPT-5.6 selectively replans U2 and U3 against current witnesses; deterministic checks,
not model confidence, restore the gate.

The local React review shell synchronizes a real Git stack, focused structural and claim-impact
deltas, Semantic Change Cards, exact reason codes, checks, on-demand raw patches, and a portable
redacted evidence bundle. Judges can run the complete path without credentials or a hosted service.

## How we built it

Codex was the primary implementation environment across one long-lived task. It helped consolidate
the scenario and domain contracts, scaffold four TypeScript workspaces, implement byte-stable real
Git fixtures, build the deterministic semantic gate, integrate the server-side Codex SDK boundary,
adversarially test scope and provenance, and iterate on the synchronized review UI. Human approvals
locked material product, contract, architecture, and UI decisions before core behavior was built.

GPT-5.6 is part of the product rather than decoration. Real `gpt-5.6-sol` ChangePlan and selective
replan outputs run through strict structured-output schemas and postvalidation. The model may improve
intent and claim wording, but it cannot change work-unit IDs, dependencies, source scopes, claim IDs,
or checks. Exact model, reasoning effort, runtime, thread, token usage, prompt version, and digests are
captured in the redacted evidence bundle. Deterministic code alone computes validity.

The stack uses TypeScript, pnpm, React 19, Vite 8, system Git, `@graphrefly/ts`, strict JSON Schema,
RFC 8785 canonical JSON, SHA-256 manifests, and `@openai/codex-sdk`.

## Challenges

The hardest boundary was preserving semantic value without letting a model or reviewer self-grade.
We separated editable claims, immutable evidence, deterministic `GateResult`, and human
`ReviewDecision` into versioned artifacts. We also had to prove the central failure mode with real
Git objects: the concurrent architecture change is file-disjoint, the rebase has zero text
conflicts, and ordinary checks remain green.

Another challenge was truthful live-model provenance. The live path is explicit, uses one read-only
Codex request per command, validates locked anchors after generation, stores raw responses only in
ignored private paths, and exports only redacted provenance. Replay never silently impersonates a
live run.

## Accomplishments

- Six deterministic semantic-validity cases with exact reason ordering.
- Byte-stable real Git fixture lineages and canonical evidence hashes.
- Selective invalidation and recovery that preserves unaffected U1.
- Real GPT-5.6 plan and corrected selective-replan evidence.
- A responsive architecture-first review path with no gate write endpoint.
- Credential-free judging on macOS or Linux from a portable redacted bundle.

## What we learned

Textual mergeability and architectural validity are different facts. The useful unit of AI review is
not a confidence score; it is a claim bound to inspectable witnesses, exact scope, dependencies, and
checks. Keeping model proposals valuable but non-authoritative made both the CLI and the UI easier to
explain.

## What's next

The Build Week MVP intentionally stops before automatic approval or merge. Natural next steps are a
GitHub Actions adapter that invokes the same versioned gate, authenticated review decisions, and
additional BlueprintProvider implementations. None of those may redefine the deterministic core.

## Feedback session

Primary `/feedback` Codex Session ID: `019f6b26-93ee-76b1-862e-8a9751692da9`

## Submission fields still requiring external action

- Public repository URL after the validated implementation batch is committed and pushed.
- Public YouTube URL after the under-three-minute narrated demo is approved and uploaded.
- Final Devpost save/submit confirmation before July 21, 2026 at 5:00 PM Pacific.
