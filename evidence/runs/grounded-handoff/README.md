# Grounded Handoff retained proof

This directory contains the fresh deterministic proof for
`graphrefly-stack:STACK-GROUNDED-HANDOFF`. The bundle consumes and independently verifies the exact
accepted Consequence Review proof, then classifies every bounded review claim against the two exact
current EvidenceManifests.

The retained owner result is not authored into the Stack proof. It is independently located at
`refs/heads/grounded-handoff-owner-result-v1` in `.private/source-bound-consumer`, verified as one
additive commit containing only `evidence/grounded-handoff-owner-result.json`, and correlated to the
exact proposal, owner, target, subject and evidence refs. Reprojection changes only the external
owner-admission axis. Evidence readiness and human review remain byte-identical.

Reproduce with model access disabled:

```bash
OPENAI_API_KEY='' CODEX_API_KEY='' node scripts/grounded-handoff-report.mjs
OPENAI_API_KEY='' CODEX_API_KEY='' node scripts/grounded-handoff-report.mjs
node scripts/grounded-handoff-report.mjs --verify evidence/runs/grounded-handoff/evidence-bundle.json
```

The proof makes no runtime-occurrence, causal, execution-authority, repository-mutation,
durable-workflow or universal review-time claim. Its handoff is proposal-only; the committed owner
record is independent retained-fixture evidence rather than Stack authority.
