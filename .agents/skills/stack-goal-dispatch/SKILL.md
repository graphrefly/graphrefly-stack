---
name: stack-goal-dispatch
description: Run or resume GraphReFly Stack's Build Week delivery as one long-lived Codex Goal across canonical STACK design, implementation, QA, evidence, and submission phases. Use when the user wants Codex to keep advancing approved work across tasks without prompting for every phase, pausing only for a genuinely new material decision, an external blocker or authorization, or actual submission-ready completion.
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
2. If no Goal exists, call `create_goal` without a token budget. Set the objective to deliver GraphReFly Stack through `STACK-8` and actual Build Week submission readiness, following `docs/plan/phases.jsonl` and the canonical gates.
3. If the active Goal matches this project, resume it. If a different unfinished Goal exists, stop and ask the user which objective owns the thread.
4. On every continuation, inspect `git status`, `docs/sources.jsonl`, `docs/decisions/decisions.jsonl`, `docs/plan/phases.jsonl`, and the concern authorities referenced by the next phase.
5. Prefer durable records and Git state over recollected chat prose. Record consequential progress before ending a task.

## 2. Select and advance work

1. Select only the single `ready` phase in `docs/plan/phases.jsonl`; require all dependencies to be `done`.
2. Apply `stack-decision-guard` before changing scope, product semantics, architecture, or delivery policy.
3. Define the current batch from the selected phase's gate and deliverables. Keep it as small as possible while still producing reviewable evidence.
4. Continue automatically into the next phase after its gate passes and the canonical records advance. Never skip a gate to save time.
5. Keep the completion horizon at `STACK-8`; do not confuse the current batch with the Goal objective.

## 3. Handle design gates

Use `stack-design-review` whenever the ready phase requires a scenario, contract, architecture, or UI lock. `STACK-2`, `STACK-3`, and `STACK-4` are expected design gates before core runtime implementation.

- Consolidate foreseeable coupled questions into one decision packet instead of stopping repeatedly.
- Explain the recommendation, alternatives, trade-offs, and exact approval requested in Chinese unless the user asks otherwise.
- Stop only when a genuinely new material lock needs user approval. Do not reopen a locked decision without conflicting evidence.
- After approval, write the decision and owning concern records, advance the sequencer, and continue the same Goal without requiring a fresh prompt.
- Make reversible implementation choices autonomously when they remain inside locked contracts.

Do not implement behavior whose contract is still unresolved.

## 4. Implement and verify

Once the design gates are locked, use `stack-dev-dispatch` for the only ready phase:

1. Build deterministic truth and fixture replay in `STACK-5`.
2. Add GPT-5.6/Codex behind the verified seam in `STACK-6`.
3. Build the synchronized Git/Blueprint review UI in `STACK-7`.
4. Harden, demonstrate, and prepare the real submission in `STACK-8`.

Run focused checks during a batch and `stack-qa` at phase boundaries. Update milestone evidence with commands, outputs, artifacts, provenance, and limitations. Do not claim success from logs or UI appearance alone.

Stage or commit only when the invoking prompt explicitly authorizes it, and include only the verified batch. Never push, deploy, publish, merge, or submit without explicit authorization covering that action.

## 5. Continue, pause, or finish

Continue working automatically while the next action is authorized, reversible, and determined by locked records. Pause only for:

- a genuinely new material product, contract, architecture, UI, or delivery decision;
- missing external authorization, secret, account action, or user-owned input;
- unsafe overlap with unrelated user changes;
- a repeated blocker that meets the Goal system's blocked threshold.

When pausing for a decision, present one consolidated decision point and preserve enough canonical state for the next task to resume immediately.

Call `update_goal` with `complete` only after `STACK-8` is `done`, all required evidence and submission records are truthful, and no required delivery work remains. Call it with `blocked` only after the same blocker has repeated for the required consecutive Goal turns. Otherwise leave the Goal active.
