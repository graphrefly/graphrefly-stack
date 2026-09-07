# Retained Evidence Manifest proof

This directory preserves the proof accepted by M81 in `docs/evidence/milestones.jsonl`. Product authority remains in the canonical JSONL records.

`evidence-bundle.json` uses the phase proof schema `graphrefly-stack/evidence-manifest-proof/v1`; its filename follows the existing evidence convention. It is not an embedded portable EvidenceBundle. `summary.json` records exact implementation, proof, run, check and integration provenance. Independent review and fix confirmation are retained in `.private/backend-loop/evidence-manifest/stack-qa-review.md` and `followup-stack-qa-review.md`.

With Node 26.4.0, compiled packages, the installed exact 0.8.0 consumer, and the preserved local source repository and test occurrence, verify with:

```bash
node scripts/evidence-manifest-report.mjs --verify evidence/runs/evidence-manifest/evidence-bundle.json
```

Verification resolves fixed owner locations and checks actual execution independently. It intentionally fails if `.private/evidence-manifest/node-test.json` is absent or altered. Explicit report generation (`node scripts/evidence-manifest-report.mjs`) can regenerate that occurrence for the same verified owner sources and environment; compare the resulting proof with the saved artifact before accepting it. A new Git lineage, source revision or Node runtime needs its own reviewed evidence.

The local `.private/backend-loop/evidence-manifest/` archive retains the pilot proof, full-check logs and receipts, test observation, delivery notes and loop result. The integration proof differs from the pilot proof only where source-proof and verifier owner records resolve to the formal branch commit; both identities are preserved in the summary. Historical Source Bound proof bytes and retained Git references were preserved.

Full checks apply to the exact implementation and integrated proof tree. Subsequent changes in this acceptance commit add evidence summaries and update canonical progress only; those metadata changes receive documentation, formatting and workspace-authority validation. This delivery is not yet ownership-verified with the user.

## Independent QA outcome

The initial independent Codex review found one currentness defect: a historical supersession chain or explicit outgoing supersession could leave an old locked decision accepted. The fix conservatively rejects both conditions, with bare and origin-qualified reference regressions. The original reviewer independently confirmed the fix; the final context-free Codex review reported no remaining acceptance gap in this phase.

Review independently verified exact owner reloads, saved proof, historical proof preservation and rehashed substitution rejection. Final focused tests passed 14/14, and full checks in both checkouts passed 125 product tests. The final BMAD squash is byte-identical to the reviewed implementation. The local archive preserves detailed review notes and immutable check receipts.
