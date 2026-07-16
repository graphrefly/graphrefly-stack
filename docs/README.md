# Documentation authorities

Structured project truth lives in JSONL. [`sources.jsonl`](sources.jsonl) maps every concern to one
canonical file; [`plan/phases.jsonl`](plan/phases.jsonl) is the only sequencer.

Markdown may explain or render the records, but it must not become a competing authority. Skills and
`AGENTS.md` read these sources instead of copying their contents.

Start with [`product/scope.jsonl`](product/scope.jsonl) for the active product boundary,
[`product/contracts.jsonl`](product/contracts.jsonl) for the approved commit/blueprint/gate model,
and [`plan/phases.jsonl`](plan/phases.jsonl) for the one canonical next phase.

Run `pnpm docs:check` after editing any JSONL record.
