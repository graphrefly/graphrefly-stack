# Stack evidence bundles

This directory contains curated, redacted artifacts that make product claims reproducible.

- `runs/` holds reviewed portable `evidence-bundle.json` files and compact summaries. The bundle
  embeds its manifest and logical Blueprint, delta, diff, semantic-change, check, gate, and
  provenance artifacts; their expanded forms are generated output and ignored by Git.
- Raw provider payloads, expanded run artifacts, generated repositories, and worktrees stay under
  ignored paths.

See [`docs/evidence/requirements.jsonl`](../docs/evidence/requirements.jsonl) before adding artifacts.
