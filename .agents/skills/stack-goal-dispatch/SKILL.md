---
name: stack-goal-dispatch
description: Run or resume GraphReFly Stack product and delivery work as one long-lived Codex Goal across the current canonical design, implementation, QA, evidence, and explicitly activated submission phases. Use when the user wants Codex to keep advancing approved work across tasks without prompting for every phase, while preserving parked phases and pausing only for a genuinely new material decision, external blocker or authorization, or the current canonical product horizon.
---

# GraphReFly Stack Goal Dispatch

Treat the whole canonical sequencer as one completion contract. A phase, batch, commit, or passing test is a checkpoint—not Goal completion.

Orchestrate the existing project skills instead of duplicating them:

- `stack-decision-guard` owns scope and decision admission.
- `stack-design-review` owns scenario, contract, architecture, and UI locks.
- `stack-dev-dispatch` owns work selected from the canonical sequencer.
- `stack-qa` owns code, evidence, security, privacy, and demo verdicts.

Canonical JSONL remains the source of truth. This skill controls flow only.

## 1. Create or resume the Goal

1. Call `get_goal`.
2. If no Goal exists, call `create_goal` without a token budget. Set the objective to advance GraphReFly Stack through the current explicitly approved canonical product horizon, preserve truthful later submission readiness, and follow `docs/plan/phases.jsonl` and its gates. Do not hard-code `STACK-8` when canonical records park it.
3. If the active Goal matches this project, resume it. If a different unfinished Goal exists, stop and ask the user which objective owns the thread.
4. On every continuation, inspect `git status`, `docs/sources.jsonl`, `docs/decisions/decisions.jsonl`, `docs/plan/phases.jsonl`, and the concern authorities referenced by the next phase.
5. Prefer durable records and Git state over recollected chat prose. Record consequential progress before ending a task.

## 2. Select and advance work

1. Select only the single `ready` phase in `docs/plan/phases.jsonl`; require all dependencies to be `done`.
2. Apply `stack-decision-guard` before changing scope, product semantics, architecture, or delivery policy.
3. Define the current batch from the selected phase's gate and deliverables. Keep it as small as possible while still producing reviewable evidence.
4. Continue automatically into the next canonical phase after its gate passes and the sequencer advances. Never skip a gate to save time, and never select a blocked or parked submission phase merely because no implementation phase is ready.
5. Keep the Goal horizon at the current explicitly approved product horizon. Backlog entries are not authorized phases: when a roadmap-design phase must select among them, consolidate the material choices through `stack-decision-guard` and `stack-design-review`, record the approved phases, then continue.

## 3. Handle design gates

Use `stack-design-review` whenever the ready phase requires a product, scenario, contract, architecture, provider, privacy, or UI lock. Apply the project-adapted nine-question format for roadmap and product-tranche design.

- Consolidate foreseeable coupled questions into one decision packet instead of stopping repeatedly.
- Explain the recommendation, alternatives, trade-offs, and exact approval requested in Chinese unless the user asks otherwise.
- Stop only when a genuinely new material lock needs user approval. Do not reopen a locked decision without conflicting evidence.
- After approval, write the decision and owning concern records, advance the sequencer, and continue the same Goal without requiring a fresh prompt.
- Make reversible implementation choices autonomously when they remain inside locked contracts.

Do not implement behavior whose contract is still unresolved.

## 4. Implement and verify

Once the design gates are locked, use `stack-dev-dispatch` for the only ready implementation phase. Derive the batch from that phase's current gate and deliverables instead of replaying historical STACK phase assumptions. Submission work runs only when its phase is both canonically ready and explicitly reactivated.

Run focused checks during a batch and `stack-qa` at phase boundaries. Update milestone evidence with commands, outputs, artifacts, provenance, and limitations. Do not claim success from logs or UI appearance alone.

Stage or commit only when the invoking prompt explicitly authorizes it, and include only the verified batch. Never push, deploy, publish, merge, or submit without explicit authorization covering that action.

## 5. Continue, pause, or finish

Continue working automatically while the next action is authorized, reversible, and determined by locked records. Pause only for:

- a genuinely new material product, contract, architecture, UI, or delivery decision;
- missing external authorization, secret, account action, or user-owned input;
- unsafe overlap with unrelated user changes;
- a repeated blocker that meets the Goal system's blocked threshold.

When pausing for a decision, present one consolidated decision point and preserve enough canonical state for the next task to resume immediately.

Call `update_goal` with `complete` only when the current explicitly approved canonical product horizon is done, its evidence is truthful, and no required work inside that objective remains. A parked `STACK-8` neither completes nor blocks a productization Goal. Call the Goal `blocked` only after the same blocker has repeated for the required consecutive Goal turns. Otherwise leave the Goal active.
