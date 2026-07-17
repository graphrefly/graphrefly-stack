# Stack evidence bundles

This directory contains curated, redacted artifacts that make the demo's claims reproducible.

- `runs/` holds reviewed portable `evidence-bundle.json` files and compact summaries. The bundle
  embeds its manifest and logical Blueprint, delta, diff, semantic-change, check, gate, and
  provenance artifacts; their expanded forms are generated output and ignored by Git.
- `media/` holds small, repository-appropriate screenshots and diagrams.
- Raw provider payloads, expanded run artifacts, generated repositories, and worktrees stay under
  ignored paths.
- Large video captures belong on the submission host, not in this repository.

See [`docs/evidence/requirements.jsonl`](../docs/evidence/requirements.jsonl) before adding artifacts.
