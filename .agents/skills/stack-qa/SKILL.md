---
name: stack-qa
description: Perform the single GraphReFly Stack quality gate combining adversarial code review, correctness fixes, tests, deterministic semantic evidence and GateResult validation, security/privacy review, UX blockers, and product readiness. Use after implementation, before marking a product phase done, and for review or QA requests.
---

# GraphReFly Stack QA

Apply `D13`; do not create a second completion verdict from another review workflow.

1. Read `docs/sources.jsonl`, the changed phase and its gate, locked decisions, product scope and
   contracts, antipatterns, and evidence requirements relevant to the milestone.
2. Inspect the diff and execution path. Rank findings by user impact and demo risk:
   - correctness, determinism, Git object integrity, snapshot reproducibility, and data integrity;
   - violations of locked product and trust boundaries;
   - secrets, privacy, prompt injection, untrusted output, abuse, and cost exposure;
   - irreproducible dependencies, missing offline replay, and environment assumptions;
   - confusing UX, accessibility, responsive failures, and demo blockers;
   - missing tests, provenance, evidence, or product documentation.
3. Run available focused tests plus `pnpm check`; run build, replay, browser smoke, and hosted checks when
   the current phase defines them.
4. Evaluate every applicable product success criterion, contract, and evidence requirement from its
   canonical authority. Verify that model or human claims cannot edit GateResult and that local and
   adapter runners preserve identical gate semantics. Cite exact record IDs instead of copying them
   into a separate QA checklist.
5. For a QA-and-fix request, fix all safe in-scope findings and rerun affected gates. For a review-only
   request, report findings without edits.
6. Add an antipattern only for a reusable lesson. Update milestone evidence only with real artifact
   paths. Mark a phase done only when its recorded gate passes.

Return ranked remaining findings, fixes applied, commands and results, evidence gaps, and whether the
phase gate is satisfied from canonical records and executable evidence.
