# Consequence Review evidence

This bundle is the deterministic, model-free proof for the private
`graphrefly-stack:consequence-review-proof` v1 contract. It binds retained Git revisions
`f8c4d1978f9af3334105f51bcc3acff2852452f8` (base),
`3f7735ee97c774d56f4e2e439e1b2718919840e0` (change A), and
`6e5ad729dd005c1c92656c1d20eef2a36ba1108e` (change B). The clean combined candidate is
constructed in isolated temporary storage and is deliberately not retained as a ref.

`evidence-bundle.json` contains fresh revision-specific anchors, bindings, manifests,
independently owned verifier/test references, two verified projections, the exact compatible
IntegrationResult, and overlap guidance. `summary.json` is only a compact index into those bytes.

Reproduce and verify after building contracts, core, and CLI:

```sh
OPENAI_API_KEY= CODEX_API_KEY= node scripts/consequence-review-report.mjs
node scripts/consequence-review-report.mjs --verify
git -C .private/source-bound-consumer fsck --full --no-dangling
```

The proof reports structural reachability, not runtime occurrence or causality. It grants no human
approval, owner admission, merge authority, deployment authority, or unconditional safety claim.
