# Retained RefreshSession source-bound trial

From the Stack checkout root (Node 26.4+ and pinned pnpm):

```sh
corepack pnpm install --frozen-lockfile
pnpm setup:source-bound
pnpm --filter @graphrefly-stack/contracts build
pnpm --filter @graphrefly-stack/core build
npm --prefix examples/refresh-session-source-bound test
mkdir -p .pilot/evidence
node scripts/source-bound-report.mjs --setup > .pilot/evidence/source-bound-report.json
node scripts/source-bound-report.mjs > .pilot/evidence/source-bound-report-repeat.json
cmp .pilot/evidence/source-bound-report.json .pilot/evidence/source-bound-report-repeat.json
node scripts/source-bound-report.mjs --verify .pilot/evidence/source-bound-report.json
```

`--setup` explicitly retains source, tests and exact npm dependency lock in real local commits under `.private/source-bound-consumer`; it preserves existing Git objects. Normal reporting is read-only and rejects drift between retained Git source and executed example files. Keep that directory after the trial. The report's base is the source-retention commit; head is its child recording that base. It is source correspondence evidence, not a business-change consequence experiment.

The adapter reads committed UTF-8 files beneath `src/`, parses bounded top-level TypeScript declarations with exact TypeScript 5.9.3, and keeps immutable anchors separate from target resolutions. Literal content remains in structural fingerprints. Multiple matching symbols or copies stay ambiguous. Other language files and unsupported declaration forms make coverage incomplete. Full 40- or 64-character Git object identifiers are required. The runtime provides the node IDs, exported handles and canonical topology bytes using exact npm `@graphrefly/ts` 0.8.0; the generic Stack 0.3.x compatibility path is unchanged.

`--resolve request.json` accepts `{anchor,target,overlay?,witness?,originalOverlay?}`. A target contains `{repository,commit,overlayDigest}`. Overlay is a bounded map of repository-relative source paths to replacement text or null for deletion; its JCS/SHA-256 digest must match the coordinate. Witness null produces unknown freshness; a different witness produces stale. Resolving targets never executes their code. The CLI is internal and restricted to this retained repository.

The independent verifier checks HTTP outcomes, audit output, metrics and the password-reset negative control against separately authored business cases. Stack's binding verdict is not its oracle. Reports include exact verifier source and revision, runtime lock integrity and installed package byte digest. Offline reruns work after dependency installation.

This proves the source-bound subset of the trial. It does not prove consequence overlap, manifest linkage, adoption, observed runtime causality, Canvas integration, whole E22 or canonical phase completion. Stack QA owns the product verdict.
