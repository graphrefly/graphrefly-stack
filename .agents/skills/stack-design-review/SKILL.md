---
name: stack-design-review
description: Review a GraphReFly Stack product, workflow, scenario, contract, architecture, Blueprint or provider boundary, semantic change, evidence and gate shape, runner, or synchronized Git and Blueprint UI before implementation. Use for product-definition work, Q1-Q9 design walks, choosing among alternatives, defining schemas or APIs, reviewing selective invalidation and replan, or deciding whether a design is ready for the canonical sequencer.
---

# GraphReFly Stack design review

Use the complete nine-question format. A design review produces a decision-ready report; it does not
implement the product or silently lock material choices.

## Phase 0: Resolve scope and authority

1. Read `docs/sources.jsonl`, then the complete decisions, product scope, product contracts,
   sequencer, and evidence authorities it indexes.
2. Resolve the target: whole product, workflow, contract family, provider, runner, UI surface, or one
   proposed symbol/file/diff. For multiple targets, review each and then synthesize cross-cutting
   conflicts.
3. Identify the single `ready` phase. If the target belongs after or outside it, report the phase
   mismatch and propose the required phase/backlog shape instead of expanding scope silently.
4. Derive constraints from every applicable locked scope, boundary, success, non-goal, evidence,
   and antipattern record. Cite record IDs; do not duplicate them as a second authority.
5. Inspect the closest real implementation and at least one credible precedent when the design
   depends on current behavior. For GraphReFly runtime capabilities, inspect the pinned/recommended
   `@graphrefly/ts` release and distinguish upstream-library responsibilities from Stack policy.

## Phase 1: Nine-question review

Answer every question. Use `not applicable` only with a concrete reason.

### Q1 — What is it: purpose, user, and proposed shape?

- Name the primary user, their triggering situation, current workaround, and desired outcome.
- State the product promise in one sentence and the end-to-end happy path.
- Define the proposed artifact/API/surface and what is explicitly outside it.
- Identify the observable acceptance event, not an implementation milestone.

> **User / Problem / Promise / Proposed shape / Acceptance event:** …

### Q2 — Is it semantically correct?

- Walk one normal case, one architecture-changing case, one unaffected case, and one failure or
  adversarial case.
- Check that terms such as stack, parent, Blueprint, claim, accepted semantic change, evidence,
  GateResult, review decision, and runner have one meaning throughout.
- Identify false positives, false negatives, ambiguity, and recovery behavior.
- Verify that the proposed result answers the user's decision, rather than merely exposing data.

> **Scenarios / Semantics / Failure behavior / Recovery / Gaps:** …

### Q3 — Which invariants and trust boundaries can it violate?

- Keep model or human claim, accepted SemanticChangeRecord, evidence, GateResult, ReviewDecision,
  and runner distinct.
- Test Git object integrity, Blueprint reproducibility, policy/version freshness, source scope,
  dependency lineage, deterministic reason ordering, provenance, privacy, and credential boundaries.
- Separate intrinsic GraphReFly runtime facts from Stack-owned Git mapping, semantic policy, and
  gate decisions. Flag capabilities that belong upstream in `@graphrefly/ts`.
- List each hidden invariant as `INVARIANT: …`; cite the governing record IDs.

> **Trust boundaries / Hidden invariants / Violations / Upstream-library needs:** …

### Q4 — What remains open or conflicts with the roadmap?

- Compare the proposal with the ready phase, backlog triggers, non-goals, evidence requirements,
  and known limitations.
- Classify each open item as blocking decision, sequenced follow-up, trigger-gated backlog, or
  rejected scope.
- Name migrations or compatibility work caused by current fixtures, schemas, CLI commands, bundle
  versions, or UI assumptions.
- Do not treat hackathon submission work as proof of production readiness.

> **Phase fit / Blocking questions / Follow-ups / Rejected scope / Migration:** …

### Q5 — Is this the right abstraction? Could it be more generic?

- Check layer placement: upstream GraphReFly library, Stack domain/core, provider/runner adapter,
  CLI composition root, hosted control plane, or review UI.
- Ask whether two smaller composable primitives are clearer than one product-shaped abstraction.
- Generalize only across demonstrated use cases; avoid premature multi-provider breadth.
- Check names, ownership, identity, versioning, and extension seams.

> **Layer / Decomposition / Generalization / Naming / Ownership:** …

### Q6 — Is it the right long-term solution?

- Apply a 6- and 18-month lens: repository scale, monorepos, merge commits, rebases, CI concurrency,
  caching, upgrades, policy evolution, schema migration, audit retention, and team collaboration.
- Identify operational burden, security/cost exposure, performance budgets, support burden, and
  environment assumptions.
- List constraint locks that would make the next product step require a rewrite.
- Require a compatibility story for supported `@graphrefly/ts` versions and Blueprint versions.

> **Longevity / Operations / Security and cost / Constraint locks / Compatibility:** …

### Q7 — Can it be simpler, composable, and quickly explainable?

- Draw the minimum user workflow from repository onboarding to a review decision and recovery.
- Check whether CLI, local UI, CI, and future hosted surfaces invoke one domain operation rather than
  reimplementing verdict semantics.
- Verify progressive disclosure: decision first, exact witnesses next, code/provenance on demand.
- Apply a first-use test: setup, first useful result, and recovery must each have an obvious next step.
- Remove concepts, states, and controls that do not change a user decision.

> **Workflow / Composition / Explainability / Simplifications / Time to value:** …

### Q8 — What credible alternatives exist?

Compare at least two named alternatives; use three for a whole-product decision. For each provide:

- **Shape:** concise architecture or pseudo-interface.
- **Pros:** user value, correctness, adoption, and operational advantages.
- **Cons:** risks, cost, lock-in, and missing capabilities.
- **Precedent:** comparable developer tools or existing project/upstream shapes.
- **Fit:** which Q1-Q7 concerns it satisfies or fails.

Do not choose the winner until Q9.

### Q9 — What is the recommendation, and does it cover every concern?

- Pick one alternative and give a Q1-Q8 coverage matrix: `yes`, `partial`, or `no`, with a reason.
- For every partial/no item, accept the residual risk explicitly, create a follow-up/backlog proposal,
  or choose a different alternative.
- State rejected alternatives and why they should not be combined into an accidental hybrid.
- End with exact unresolved user decisions, governing record IDs, and the next gate artifact.

> **Recommendation / Coverage / Residual risks / Rejected alternatives / Decisions needed / Next gate:** …

## Phase 2: Cross-cutting synthesis

For a whole product or multiple targets, add:

- one end-to-end domain flow and ownership map;
- naming and versioning consistency across CLI, wire artifacts, provider, runner, and UI;
- repeated patterns that should become a shared primitive;
- dependencies between decisions, ordered so the user can approve them without circularity.

Use a compact table or Mermaid diagram only when it makes these relationships easier to verify.

## Phase 3: Decision handling

- Clear architectural lock: draft the next `D#` for user approval; do not append it yet.
- Approved lock: append the `D#`, update the owning scope/contract/phase records, then run
  `pnpm docs:check`.
- Deferred answer: draft a backlog record with a concrete trigger.
- Reusable failure lesson: route it to `docs/plan/antipatterns.jsonl` through `stack-qa`.
- Upstream GraphReFly capability: produce a separate library proposal with required API semantics,
  compatibility impact, and acceptance tests; do not hide a Stack workaround as the final design.

## Output discipline

- Lead with the recommendation and phase mismatch.
- Use Q1 through Q9 as explicit headings; never collapse them into a generic pros/cons summary.
- Cite exact record IDs and real `file:line` references where implementation behavior matters.
- Include at least one credible rejected alternative and every unresolved material question.
- Do not implement product code during design review. Skill maintenance explicitly requested by the
  user is allowed, but product decisions still require approval before canonical locking.
