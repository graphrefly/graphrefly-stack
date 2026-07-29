---
name: stack-goal-dispatch
description: Run or resume GraphReFly Stack product work as one long-lived Codex Goal across the current canonical design, implementation, QA, and evidence phases. Use when the user wants Codex to keep advancing approved work across tasks without prompting for every phase, while preserving deferred work and pausing only for a genuinely new material decision, external blocker or authorization, or the current canonical product horizon.
---

# GraphReFly Stack Goal Dispatch

Treat the whole canonical sequencer as one completion contract. A phase, batch, commit, or passing test is a checkpoint—not Goal completion.

Orchestrate the existing project skills instead of duplicating them:

- `stack-decision-guard` owns scope and decision admission.
- `stack-design-review` owns scenario, contract, architecture, and UI locks.
- `stack-dev-dispatch` owns work selected from the canonical sequencer.
- `stack-qa` owns code, evidence, security, privacy, and demo verdicts.

Canonical JSONL remains the source of truth. This skill controls flow only.

## Code-intelligence routing

When resolving the ready phase, its implementation reality, or batch completion, call `codegraph_explore` in
each indexed affected implementation repo before raw source Read/`rg`. Query the phase journey endpoints for
exact source, call paths, callers/dependents, tests, public/package/build boundaries, and blast radius. Treat
returned source as already read and query again only for uncovered paths. Read canonical JSONL, docs/configs,
dependency manifests, git diff, untracked files, and stale/unindexed files directly. If the index is absent or
disabled, use direct inspection and never initialize it autonomously. Delegated dev and QA skills still own
all executable correctness gates.

## 1. Create or resume the Goal

1. Call `get_goal`.
2. If no Goal exists, call `create_goal` without a token budget. Set the objective to advance GraphReFly Stack through the current explicitly approved canonical product horizon and follow `docs/plan/phases.jsonl` and its gates.
3. If the active Goal matches this project, resume it. If a different unfinished Goal exists, stop and ask the user which objective owns the thread.
4. On every continuation, inspect `git status`, `docs/sources.jsonl`, `docs/decisions/decisions.jsonl`, `docs/plan/phases.jsonl`, and the concern authorities referenced by the next phase.
5. Prefer durable records and Git state over recollected chat prose. Record consequential progress before ending a task.

## 1A. Ownership checkpoint and Goal-loop guard

Apply the global `repository-ownership-practice` skill for each implementation batch unless the user
explicitly invokes `--delivery-only`.

- Before implementation investigation, pause for the user's OWN and PREDICT cards.
- Advance at most one delivery batch before a user-visible ownership checkpoint.
- At the batch boundary, persist the canonical phase state and report prediction corrections plus
  diff/behavior/trace evidence.
- Wait for the user's TEACH-BACK before automatically selecting the next ready phase. Keep the Goal active;
  this wait is neither completion nor a blocker.
- In `--delivery-only` mode, continue under the canonical sequencer but label the result
  `delivered, not yet ownership-verified`.

Keep product horizon, Goal, phase, batch, proof, and user comprehension as separate states.

## 2. Select and advance work

1. Select only the single `ready` phase in `docs/plan/phases.jsonl`; require all dependencies to be `done`.
2. Apply `stack-decision-guard` before changing scope, product semantics, architecture, or delivery policy.
3. Define the current batch from the selected phase's gate and deliverables. Keep it as small as possible while still producing reviewable evidence.
4. After the current phase gate passes, advance the sequencer. In practice mode, stop at the ownership
   checkpoint before executing the next phase. In `--delivery-only` mode, continue automatically. Never skip a
   gate or select deferred work merely because no implementation phase is ready.
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

Once the design gates are locked, use `stack-dev-dispatch` for the only ready implementation phase. Derive the batch from that phase's current gate and deliverables instead of replaying historical phase assumptions.

Run focused checks during a batch and `stack-qa` at phase boundaries. Update milestone evidence with commands, outputs, artifacts, provenance, and limitations. Do not claim success from logs or UI appearance alone.

Stage or commit only when the invoking prompt explicitly authorizes it, and include only the verified batch. Never push, deploy, publish, merge, or submit without explicit authorization covering that action.

## 5. Continue, pause, or finish

Continue working automatically while the next action is authorized, reversible, and determined by locked records. Pause only for:

- a genuinely new material product, contract, architecture, UI, or delivery decision;
- missing external authorization, secret, account action, or user-owned input;
- unsafe overlap with unrelated user changes;
- a repeated blocker that meets the Goal system's blocked threshold.

When pausing for a decision, present one consolidated decision point and preserve enough canonical state for the next task to resume immediately.

Call `update_goal` with `complete` only when the current explicitly approved canonical product horizon is done, its evidence is truthful, and no required work inside that objective remains. Call the Goal `blocked` only after the same blocker has repeated for the required consecutive Goal turns. Otherwise leave the Goal active.
