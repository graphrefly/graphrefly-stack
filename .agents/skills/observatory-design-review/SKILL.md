---
name: observatory-design-review
description: Review an Observatory flagship scenario, domain contract, architecture, model boundary, evidence shape, or replay UI before implementation. Use when choosing a scenario or framework, defining schemas and APIs, sketching the cold/warm flow, reviewing a proposed design, or deciding whether a design is ready for the canonical sequencer.
---

# Observatory design review

1. Read `docs/sources.jsonl`, then the complete decisions, product scope, sequencer, and evidence
   authorities it indexes.
2. Identify the single `ready` phase and the proposed design artifact. Surface a phase mismatch rather
   than expanding scope silently.
3. Derive the review lenses from every applicable locked scope, boundary, success, non-goal, and
   evidence record. Cite their IDs instead of paraphrasing them into a new checklist.
4. Also assess whether the user proof is understandable quickly and whether the proposal is the
   smallest shape that can satisfy the active gate.
5. Compare at least one credible alternative when a material architecture choice exists.
6. Return: recommendation, rejected alternatives, unresolved questions, record IDs, and the exact gate
   artifact needed next.
7. Do not implement during design review. After user approval, append any new `D#`, update the owning
   authority and sequencer, then run `pnpm docs:check`.
