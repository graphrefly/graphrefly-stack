---
name: stack-dev-dispatch
description: Implement one approved GraphReFly Stack slice from the canonical sequencer with premise checks, scoped edits, tests, evidence, and phase updates. Use when asked to implement, build, scaffold, dispatch, continue the next phase, or complete a specific STACK phase after its design decisions are locked.
---

# GraphReFly Stack dev dispatch

1. Read `docs/sources.jsonl`, all locked decisions, product scope and contracts, antipatterns, and the
   complete canonical sequencer.
2. Select the requested phase or the single `ready` phase. Require all dependencies to be `done` and
   required design decisions to be locked.
3. Verify named files, APIs, dependency versions, and existing behavior before planning changes.
4. Translate the phase gate into the smallest vertical implementation and verification plan. Do not
   pull deferred backlog into the slice.
5. Implement every applicable locked boundary and evidence requirement by record ID. Do not restate
   those product requirements in this workflow. Add or update tests and evidence with behavior.
6. Run focused checks while iterating and `pnpm check` before handoff. Run any phase-specific test,
   build, or replay commands once they exist.
7. Apply the `stack-qa` workflow to the resulting diff. Fix in-scope findings and rerun gates.
8. Mark a phase `done` only when its recorded gate is actually satisfied. Then promote the earliest
   dependency-satisfied blocked phase to `ready`, update the phase note, and run `pnpm docs:check`.

Record new architectural locks in decisions before code. Record deferred work in backlog and reusable
lessons in antipatterns; never store them in `AGENTS.md` or this skill.
