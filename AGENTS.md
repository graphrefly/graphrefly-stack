# GraphReFly Stack — agent index

> This file points; it does not host project truth. Canonical records are JSONL under `docs/`.

## Read first

1. `docs/sources.jsonl` — authority map: one canonical file per concern
2. `docs/decisions/decisions.jsonl` — locked decisions and rationale
3. `docs/plan/phases.jsonl` — the single canonical sequencer and current next phase
4. The concern-specific sources referenced by those records

Do not duplicate canonical facts in this file, skills, README prose, or implementation plans. Update
the owning JSONL record and keep references pointing to it.

## Workflow routing

- Decision or scope question: `.agents/skills/stack-decision-guard/SKILL.md`
- Scenario, contract, architecture, or UI review: `.agents/skills/stack-design-review/SKILL.md`
- Implementation from the canonical sequencer: `.agents/skills/stack-dev-dispatch/SKILL.md`
- Code, evidence, security, privacy, and demo review: `.agents/skills/stack-qa/SKILL.md` (`D13`)

## Commands

```bash
mise run bootstrap
pnpm check
pnpm docs:check
pnpm lint
pnpm format
```
