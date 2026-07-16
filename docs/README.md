# Documentation authorities

Structured project truth lives in JSONL. [`sources.jsonl`](sources.jsonl) maps every concern to one
canonical file; [`plan/phases.jsonl`](plan/phases.jsonl) is the only sequencer.

Markdown may explain or render the records, but it must not become a competing authority. Skills and
`AGENTS.md` read these sources instead of copying their contents.

Run `pnpm docs:check` after editing any JSONL record.
