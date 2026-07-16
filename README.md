# GraphReFly Stack

**Semantic stacked diffs that know when their architectural assumptions expire.**

GraphReFly Stack is an OpenAI Build Week developer tool built with Codex, GPT-5.6, Git, and
GraphReFly. It adds a semantic validity layer above Git: each indexed commit is associated with a
GraphBlueprint snapshot, a task-specific semantic change record, and a deterministic merge gate.

Git can report a clean rebase while a change is no longer valid under the architecture it was
planned against. GraphReFly Stack makes that mismatch visible, identifies only the affected work,
and asks GPT-5.6 to replan those work units instead of rebuilding the whole stack.

The repository is currently a validated project scaffold and design authority; the flagship runtime
slice has not been implemented yet. Canonical scope, decisions, contracts, sequence, and evidence
requirements are JSONL records indexed by [`docs/sources.jsonl`](docs/sources.jsonl).

## Flagship path

1. GPT-5.6 turns a coding task into a dependency-aware `ChangePlan` and semantic work units.
2. Real Git commits form the change stack; each indexed commit maps to a GraphBlueprint snapshot.
3. A concurrent architecture change rebases cleanly in Git but invalidates selected semantic claims.
4. The deterministic gate keeps unaffected work green, blocks stale work, and explains why.
5. GPT-5.6 replans only the invalidated work units against the current blueprint witness.
6. A reviewer approves the high-level architecture relationship, with raw code diffs available on
   demand.

The approved product and interaction contracts live in
[`docs/product/contracts.jsonl`](docs/product/contracts.jsonl). The canonical sequencer remains
[`docs/plan/phases.jsonl`](docs/plan/phases.jsonl).

## Trust model

- GPT-5.6 proposes plans, semantic claims, code changes, explanations, and selective replans.
- GraphReFly provides the architecture snapshot and reactive impact substrate.
- Deterministic code computes freshness, scope, dependency, check, and gate verdicts.
- Humans review intent and architecture at a compressed level and can drill into implementation.

A model claim is not evidence. Evidence is a read-only, reproducible artifact or check result. The
gate is a deterministic function over current repository state, witnesses, contracts, and evidence;
GitHub Actions may eventually run it, but does not define it.

## Setup

Requirements: [mise](https://mise.jdx.dev/) and Corepack.

```bash
mise install
mise run bootstrap
mise run check
```

The no-key fixture path will remain the judgeable baseline. The live path is configured through
environment variables documented in [`.env.example`](.env.example); never commit an API key.

## Repository map

- `docs/` — canonical structured records and their human-readable index
- `evidence/` — curated, redacted stack/gate bundles and small media artifacts
- `.agents/skills/` — project workflows that operate on the canonical records
- `.private/` — ignored local submission drafts and sensitive notes

Read [`docs/README.md`](docs/README.md) for the authority map and
[`docs/plan/phases.jsonl`](docs/plan/phases.jsonl) for what comes next.

## License

[MIT](LICENSE)
