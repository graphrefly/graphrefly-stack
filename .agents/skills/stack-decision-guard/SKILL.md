---
name: stack-decision-guard
description: Check a GraphReFly Stack proposal against canonical scope, locked decisions, contracts, the sequencer, backlog, and antipatterns. Use for "should we", A/B choices, scope checks, model or provider changes, CLI or UI expansion, dependencies, feature expansion, or requests to change a locked boundary.
---

# GraphReFly Stack decision guard

1. Read `docs/sources.jsonl`; treat its paths as the authority map.
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
6. If the user explicitly approves a new lock, append the next `D#`, update affected authorities, and
   run `pnpm docs:check`. Never put the decision text in `AGENTS.md` or this skill.

Return the alignment verdict, supporting IDs, conflicts or risks, and the smallest sequencer change
needed. Do not implement the proposal unless the user also requested implementation.
