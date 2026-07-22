# Changesets

Add one changeset for every user-visible package change:

```bash
pnpm changeset
```

Choose `@graphrefly/stack`, select the SemVer bump, and write the release-note summary. Changes to
documentation, tests, or release infrastructure that do not change the published package may omit a
changeset.

On `main`, the release workflow maintains a reviewable release PR. Merging that PR publishes the
version through npm Trusted Publishing; contributors and ordinary CI never receive npm credentials.
