---
name: stack-dev-dispatch
description: Implement one approved GraphReFly Stack slice from the canonical sequencer with premise checks, scoped edits, tests, evidence, and phase updates. Use when asked to implement, build, scaffold, dispatch, continue the next phase, or complete a specific STACK phase after its design decisions are locked.
---

# GraphReFly Stack dev dispatch

Use `~/.codex/skills/bmad-build/SKILL.md` inside the selected implementation slice, retaining this
workflow's authority, sequencer and gates. Use `~/.codex/skills/bmad-checkpoint-preview/SKILL.md` for
human review: build-handoff mode during ordinary delivery; interactive mode for explicit checkpoint
or `--practice` requests. No prediction or teach-back is required.

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
3. Verify named files, APIs, dependency versions, and one
   concrete input-to-output path before planning changes.
4. Translate the phase gate into one Given/When/Then vertical implementation and verification plan. Freeze
   intended seams, tests, non-goals, and stopping boundary. Do not pull deferred backlog into the slice.
5. Implement every applicable locked boundary and evidence requirement by record ID. Do not restate
   those product requirements in this workflow. Add or update tests and evidence with behavior.
6. Run focused checks while iterating and `pnpm check` before handoff. Run any phase-specific test,
   build, or replay commands once they exist.
7. Apply the `stack-qa` workflow to the resulting diff. Fix in-scope findings and rerun gates.
8. Mark a phase `done` only when its recorded gate is actually satisfied. Then promote the earliest
   dependency-satisfied blocked phase to `ready`, update the phase note, and run `pnpm docs:check`. For an explicitly requested interactive
   checkpoint, present the preview and wait for review navigation before that next phase.

Record new architectural locks in decisions before code. Record deferred work in backlog and reusable
lessons in antipatterns; never store them in `AGENTS.md` or this skill.
