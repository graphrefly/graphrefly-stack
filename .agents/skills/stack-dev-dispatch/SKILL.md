---
name: stack-dev-dispatch
description: Implement one approved GraphReFly Stack slice from the canonical sequencer with premise checks, scoped edits, tests, evidence, and phase updates. Use when asked to implement, build, scaffold, dispatch, continue the next phase, or complete a specific STACK phase after its design decisions are locked.
---

# GraphReFly Stack dev dispatch

Apply the global `repository-ownership-practice` skill unless the user explicitly invokes
`--delivery-only`. In practice mode, pause for OWN/PREDICT before implementation and TEACH-BACK after one
batch. `--delivery-only` skips those waits but must still produce the ownership handoff and report
`delivered, not yet ownership-verified`.

## Code-intelligence routing

For implementation source in each indexed affected repo, call `codegraph_explore` before raw source Read/`rg`.
Query the phase journey endpoints for exact source, call paths, callers/dependents, relevant tests,
public/package/build boundaries, and blast radius. Treat returned source as already read and query again only
for uncovered paths. Read canonical JSONL, docs/configs, dependency manifests, git diff, untracked files, and
stale/unindexed files directly. If the index is absent or disabled, use direct inspection and never initialize
it autonomously. After edits, use the compiler, tests, lint, build, replay, browser, and phase gates as
correctness evidence.

1. Read `docs/sources.jsonl`, the locked decisions and concern records governing the current slice,
   antipatterns, and the canonical sequencer. Do not load unrelated decision history.
2. Select the requested phase or the single `ready` phase. Require all dependencies to be `done` and
   required design decisions to be locked.
3. Record the user's best-effort prediction, then verify named files, APIs, dependency versions, and one
   concrete input-to-output path before planning changes.
4. Translate the phase gate into one Given/When/Then vertical implementation and verification plan. Freeze
   intended seams, tests, non-goals, and stopping boundary. Do not pull deferred backlog into the slice.
5. Implement every applicable locked boundary and evidence requirement by record ID. Do not restate
   those product requirements in this workflow. Add or update tests and evidence with behavior.
6. Run focused checks while iterating and `pnpm check` before handoff. Run any phase-specific test,
   build, or replay commands once they exist.
7. Apply the `stack-qa` workflow to the resulting diff. Fix in-scope findings and rerun gates.
8. Mark a phase `done` only when its recorded gate is actually satisfied. Then promote the earliest
   dependency-satisfied blocked phase to `ready`, update the phase note, and run `pnpm docs:check`. In practice
   mode, stop for TEACH-BACK before implementing that next phase.

Record new architectural locks in decisions before code. Record deferred work in backlog and reusable
lessons in antipatterns; never store them in `AGENTS.md` or this skill.
