---
name: stack-decision-guard
description: Check a GraphReFly Stack proposal against canonical scope, locked decisions, contracts, the sequencer, backlog, and antipatterns. Use for "should we", A/B choices, scope checks, model or provider changes, CLI or UI expansion, dependencies, feature expansion, or requests to change a locked boundary.
---

# GraphReFly Stack decision guard

Load and apply the personal `$project-governance` skill at
`~/.codex/skills/project-governance/SKILL.md` before classifying or appending any decision, work,
execution authorization, attempt, incident, receipt or evidence record. It supplies only the
cross-project classification and manual-authorization floor; Stack retains its independent product
authority, IDs, ledgers and gates.

## Code-intelligence routing

When a proposal depends on current implementation, call `codegraph_explore` before raw source Read/`rg`.
Ask for the exact symbols or journey endpoints, call paths, callers/dependents, tests, public/package
boundaries, and blast radius. Treat returned source as already read and query again only for uncovered paths.
Read canonical JSONL, docs/configs, dependency manifests, git diff, untracked files, and stale/unindexed files
directly. If the index is absent or disabled, use direct inspection and never initialize it autonomously.
Codegraph verifies the premise; canonical decisions and contracts determine the verdict.

1. Read `docs/sources.jsonl`; treat its paths as the authority map.
   If the concern is language-neutral protocol or a cross-project boundary, resolve the qualified upstream
   record through `~/src/graphrefly/authority/ledgers.jsonl` instead of copying it into Stack.
2. Read `docs/decisions/decisions.jsonl`, `docs/product/scope.jsonl`,
   `docs/product/contracts.jsonl`, `docs/plan/phases.jsonl`, and
   `docs/plan/antipatterns.jsonl` completely.
3. Verify any code or dependency premise directly when the proposal relies on current implementation
   state.
4. Classify the proposal as:
   - aligned with a locked decision;
   - conflicting with a locked decision;
   - a new decision not yet recorded; or
   - deferred/outside the current phase.
5. Cite exact record IDs. Do not silently choose across a conflict or create a new architectural lock.
6. If the user explicitly approves a new Stack-local lock, append the next `graphrefly-stack:<D#>`, update
   affected local authorities, and run `pnpm docs:check` plus the workspace federation gate. A protocol or
   cross-project lock must go to its upstream owner ledger. Never copy decision text into this skill.

Return the alignment verdict, supporting IDs, conflicts or risks, and the smallest sequencer change
needed. Do not implement the proposal unless the user also requested implementation.

Admission reminder: every post-D60 Stack record must satisfy
~/src/graphrefly/authority/README.md before append.
