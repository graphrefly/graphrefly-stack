---
name: observatory-decision-guard
description: Check an Observatory proposal against canonical scope, locked decisions, the sequencer, backlog, and antipatterns before answering scope or architecture choices. Use for "should we", A/B choices, scope checks, decision consistency, proposed dependencies, feature expansion, or requests to change a locked boundary.
---

# Observatory decision guard

1. Read `docs/sources.jsonl`; treat its paths as the authority map.
2. Read `docs/decisions/decisions.jsonl`, `docs/product/scope.jsonl`,
   `docs/plan/phases.jsonl`, and `docs/plan/antipatterns.jsonl` completely.
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
