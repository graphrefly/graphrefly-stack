# GraphReFly Agent Observatory

An evidence-first OpenAI Build Week project about deterministic agent-memory reruns, built with
GPT-5.6 and GraphReFly.

This README is a public entry point, not the project authority. Current scope, decisions, sequence,
event requirements, and evidence contracts live in the canonical JSONL records indexed by
[`docs/sources.jsonl`](docs/sources.jsonl).

## Setup

Requirements: [mise](https://mise.jdx.dev/) and Corepack.

```bash
mise install
mise run bootstrap
mise run check
```

## Repository map

- `docs/` — canonical structured records and their human-readable index
- `evidence/` — curated, redacted run bundles and small media artifacts
- `.agents/skills/` — project workflows that operate on the canonical records
- `.private/` — ignored local submission drafts and sensitive notes

Read [`docs/README.md`](docs/README.md) for the authority map and
[`docs/plan/phases.jsonl`](docs/plan/phases.jsonl) for what comes next.

## License

[MIT](LICENSE)
