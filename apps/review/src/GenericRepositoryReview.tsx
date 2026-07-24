import { useEffect, useRef, useState } from "react";

import {
	BlueprintDiagram,
	type BlueprintEvent,
	type FileDiff,
	StructuredCodeDiff,
} from "./ReviewPrimitives";

type Revision = {
	oid: string;
	subject: string;
	blueprint: {
		version: string;
		topology: Record<string, unknown>;
		diagnostics?: { ok?: boolean; issues?: unknown[] };
		hash?: { value?: string };
	};
	diagram: {
		format: "mermaid";
		renderer: string;
		source: string;
	};
};

type ReviewCommit = Revision & {
	parentOid: string;
	delta: {
		version?: string;
		events?: BlueprintEvent[];
	};
	diff: { paths: string[]; files: FileDiff[] };
};

export interface GenericReviewData {
	schema: "graphrefly.stack.review.v1";
	source: "generic-repository";
	repository: {
		label: string;
		headLabel: string;
		graphreflyVersion: string;
		entrypoint: string;
		baseOid: string;
		headOid: string;
	};
	base: Revision;
	commits: ReviewCommit[];
	semanticStatus: "not-configured" | "evaluated";
	semantic?: {
		plan: {
			planId: string;
			taskSummary: string;
			workUnits: Array<{
				id: string;
				title: string;
				intent: string;
				allowedSourceScopes: string[];
				allowedCapabilities?: string[];
				claims: Array<{ id: string; rationale: string; predicate: Record<string, unknown> }>;
				requiredChecks: string[];
			}>;
		};
		bindings: Array<{
			workUnitId: string;
			commit: { value: string };
			stablePatchId: string;
			changedPaths: string[];
		}>;
		records: Array<{
			workUnitId: string;
			recordId: string;
			rebindFrom: string | null;
			claimWitnesses: Array<{
				claimId: string;
				predicateDigest: { value: string };
			}>;
		}>;
		checks: Array<{ checkId: string; exitCode: number; commandDigest: { value: string } }>;
		gateResult: {
			verdict: "pass" | "blocked" | "error";
			inputDigest: { value: string };
			units: Array<{
				workUnitId: string;
				verdict: "valid" | "invalid";
				reasonCodes: string[];
				invalidDependencies: string[];
				recordId: string | null;
			}>;
		};
		invalidWorkUnitIds: string[];
	};
}

type RepositoryReviewDecisionV1 = {
	schema: "graphrefly.stack.repository-review-decision.v1";
	id: string;
	target: {
		baseOid: string;
		headOid: string;
		parentOid: string;
		commitOid: string;
		blueprintHash: string;
	};
	decision: "approve" | "request-changes";
	reviewerLabel: string;
	summary: string;
	recordedAt: string;
	identityVerified: false;
};

type RepositoryReviewDecisionV2 = {
	schema: "graphrefly.stack.repository-review-decision.v2";
	id: string;
	target: {
		baseOid: string;
		headOid: string;
		reviewTargetDigest: { algorithm: "sha256"; value: string };
	};
	contextCommitOid?: string;
	decision: "approve" | "request-changes";
	reviewerLabel: string;
	summary: string;
	recordedAt: string;
	identityVerified: false;
};

type RepositoryReviewDecision = RepositoryReviewDecisionV1 | RepositoryReviewDecisionV2;

type ReviewDecisionHistory = {
	schema: "graphrefly.stack.review-decision-history.v1";
	current: RepositoryReviewDecision[];
	outdated: RepositoryReviewDecision[];
};

function short(value: string, size = 8): string {
	return value.slice(0, size);
}

function pathWithinScope(path: string, scope: string): boolean {
	const normalized = scope.replace(/^\.\//u, "").replace(/\/+$/u, "");
	return (
		normalized === "." ||
		normalized === "" ||
		path === normalized ||
		path.startsWith(`${normalized}/`)
	);
}

function humanizeReason(reason: string): string {
	const known: Record<string, string> = {
		ARCHITECTURE_STALE: "Architecture changed after this intent was accepted.",
		BLUEPRINT_HASH_MISMATCH: "Observed architecture no longer matches the accepted evidence.",
		CHECK_FAILED: "A required repository check failed.",
		COMMIT_BINDING_MISMATCH: "The implementation no longer matches the reviewed change.",
		DEPENDENCY_INVALID: "A change this work depends on is not ready.",
		POLICY_MISMATCH: "The repository boundary changed after this intent was accepted.",
		SOURCE_SCOPE_VIOLATION: "The implementation reached outside its accepted boundary.",
	};
	return known[reason] ?? `${reason.toLowerCase().replaceAll("_", " ")}.`;
}

function nextAction(reasons: readonly string[], failedChecks: readonly string[]): string {
	if (failedChecks.length > 0) return `Fix ${failedChecks.join(", ")} and run review again.`;
	if (reasons.includes("SOURCE_SCOPE_VIOLATION")) {
		return "Narrow the implementation, or explicitly accept broader intent before reviewing again.";
	}
	if (
		reasons.includes("ARCHITECTURE_STALE") ||
		reasons.includes("BLUEPRINT_HASH_MISMATCH") ||
		reasons.includes("POLICY_MISMATCH")
	) {
		return "Replan the affected outcome against the current architecture, then add revised commits.";
	}
	if (reasons.includes("DEPENDENCY_INVALID"))
		return "Resolve the upstream change, then rerun review.";
	if (reasons.length > 0) return "Update the implementation and rerun review for fresh evidence.";
	return "Inspect the summarized reach, then review code where you need more detail.";
}

function decisionLabel(decision: RepositoryReviewDecisionV2 | undefined): string {
	if (decision?.decision === "approve") return "Approved";
	if (decision?.decision === "request-changes") return "Changes requested";
	return "Needs review";
}

function decisionActionLabel(decision: RepositoryReviewDecision): string {
	return decision.decision === "approve" ? "Approved" : "Changes requested";
}

function HelpPanel({ onClose }: { onClose: () => void }) {
	const closeButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		closeButton.current?.focus();
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [onClose]);

	return (
		<div className="help-backdrop">
			<section className="help-panel" role="dialog" aria-modal="true" aria-labelledby="help-title">
				<header>
					<div>
						<p className="kicker">How GraphReFly Stack works</p>
						<h2 id="help-title">Review one commit from three connected views</h2>
					</div>
					<button
						type="button"
						className="icon-button"
						onClick={onClose}
						aria-label="Close help"
						ref={closeButton}
					>
						×
					</button>
				</header>
				<section className="help-flow" aria-label="Git, Blueprint, and code relationship">
					<div>
						<b>Git stack</b>
						<span>Selects one commit and its exact parent.</span>
					</div>
					<i aria-hidden="true">→</i>
					<div>
						<b>Blueprint delta</b>
						<span>Compares the GraphReFly Blueprint at those two commits.</span>
					</div>
					<i aria-hidden="true">→</i>
					<div>
						<b>Code changes</b>
						<span>Shows the Git diff for the same parent-to-commit pair.</span>
					</div>
				</section>
				<div className="help-copy">
					<div>
						<h3>What changes when I select a commit?</h3>
						<p>
							The commit identity, highlighted graph changes, Blueprint hash, and split code diff
							move together. That keeps the architecture view and source review on the same Git
							boundary.
						</p>
					</div>
					<div>
						<h3>What does Approve mean here?</h3>
						<p>
							It records your review of the exact current base-to-head change in Git-scoped
							metadata. The selected commit is context only. It does not change Readiness, approve a
							GitHub pull request, or merge code.
						</p>
					</div>
				</div>
			</section>
		</div>
	);
}

function ReviewPanel({
	commit,
	current,
	onClose,
	onSaved,
}: {
	commit: ReviewCommit;
	current?: RepositoryReviewDecisionV2;
	onClose: () => void;
	onSaved: (record: RepositoryReviewDecisionV2) => void;
}) {
	const [reviewerLabel, setReviewerLabel] = useState(current?.reviewerLabel ?? "");
	const [summary, setSummary] = useState(current?.summary ?? "");
	const [saving, setSaving] = useState<RepositoryReviewDecisionV2["decision"] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const save = async (decision: RepositoryReviewDecisionV2["decision"]) => {
		if (reviewerLabel.trim() === "") {
			setError("Enter a reviewer name before saving.");
			return;
		}
		setSaving(decision);
		setError(null);
		try {
			const response = await fetch("/api/review-decisions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GraphReFly-Review": "1",
				},
				body: JSON.stringify({
					schema: "graphrefly.stack.repository-review-decision-request.v2",
					decision,
					reviewerLabel,
					summary,
					contextCommitOid: commit.oid,
				}),
			});
			if (!response.ok) {
				const message = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(message?.message ?? `Review could not be saved (${response.status})`);
			}
			onSaved((await response.json()) as RepositoryReviewDecisionV2);
			onClose();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Review could not be saved");
		} finally {
			setSaving(null);
		}
	};

	return (
		<section className="review-panel" aria-labelledby="review-panel-title">
			<header>
				<div>
					<p className="kicker">Local review</p>
					<h3 id="review-panel-title">Review the whole current change</h3>
					<p>
						Selected context: {short(commit.oid, 12)}. Your decision binds the full base-to-head
						review.
					</p>
				</div>
				<button className="icon-button" type="button" onClick={onClose} aria-label="Close review">
					×
				</button>
			</header>
			<div className="review-form">
				<label>
					<span>Reviewer</span>
					<input
						value={reviewerLabel}
						onChange={(event) => setReviewerLabel(event.target.value)}
						maxLength={120}
						placeholder="Your name"
					/>
				</label>
				<label>
					<span>Summary</span>
					<textarea
						value={summary}
						onChange={(event) => setSummary(event.target.value)}
						maxLength={10000}
						placeholder="What should the author know?"
					/>
				</label>
			</div>
			{error === null ? null : <p className="review-error">{error}</p>}
			<footer>
				<p>Saved under this repository's Git metadata. No source files or refs are changed.</p>
				<div>
					<button
						className="review-action request"
						type="button"
						disabled={saving !== null}
						onClick={() => void save("request-changes")}
					>
						{saving === "request-changes" ? "Saving…" : "Request changes"}
					</button>
					<button
						className="review-action approve"
						type="button"
						disabled={saving !== null}
						onClick={() => void save("approve")}
					>
						{saving === "approve" ? "Saving…" : "Approve"}
					</button>
				</div>
			</footer>
		</section>
	);
}

function eventLabel(event: NonNullable<ReviewCommit["delta"]["events"]>[number]): string {
	const target =
		event.node?.id ??
		event.after?.id ??
		event.before?.id ??
		(event.edge?.from !== undefined
			? `${event.edge.from} → ${event.edge.to ?? "?"}`
			: event.topologyPath?.join(" / "));
	return target ? `${event.type ?? "change"}: ${target}` : (event.type ?? "change");
}

export function GenericRepositoryReview({ review }: { review: GenericReviewData }) {
	const [selectedOid, setSelectedOid] = useState(review.commits.at(-1)?.oid ?? "");
	const commitStack = useRef<HTMLDivElement | null>(null);
	const selectedCommit = useRef<HTMLButtonElement | null>(null);
	const [helpOpen, setHelpOpen] = useState(false);
	const [reviewOpen, setReviewOpen] = useState(false);
	const [decisionHistory, setDecisionHistory] = useState<ReviewDecisionHistory>({
		schema: "graphrefly.stack.review-decision-history.v1",
		current: [],
		outdated: [],
	});
	const [reviewStateError, setReviewStateError] = useState<string | null>(null);
	const selected = review.commits.find((commit) => commit.oid === selectedOid) ?? review.commits[0];
	if (selected === undefined) throw new Error("Repository review contains no commits");
	const events = selected.delta.events ?? [];
	const hash = selected.blueprint.hash?.value ?? "unavailable";
	const diagnosticCount = selected.blueprint.diagnostics?.issues?.length ?? 0;
	const currentDecision = [...decisionHistory.current]
		.reverse()
		.find(
			(decision): decision is RepositoryReviewDecisionV2 =>
				decision.schema === "graphrefly.stack.repository-review-decision.v2",
		);
	const humanState = decisionLabel(currentDecision);
	const semanticBinding = review.semantic?.bindings.find(
		(binding) => binding.commit.value === selected.oid,
	);
	const semanticUnit = review.semantic?.plan.workUnits.find(
		(unit) => unit.id === semanticBinding?.workUnitId,
	);
	const semanticGate = review.semantic?.gateResult.units.find(
		(unit) => unit.workUnitId === semanticBinding?.workUnitId,
	);
	const semanticRecord = review.semantic?.records.find(
		(record) => record.workUnitId === semanticBinding?.workUnitId,
	);
	const semanticUnits =
		semanticUnit === undefined ? (review.semantic?.plan.workUnits ?? []) : [semanticUnit];
	const semanticBindings =
		semanticBinding === undefined ? (review.semantic?.bindings ?? []) : [semanticBinding];
	const expectedScopes = [
		...new Set(semanticUnits.flatMap((unit) => unit.allowedSourceScopes)),
	].sort();
	const observedPaths = [
		...new Set(semanticBindings.flatMap((binding) => binding.changedPaths)),
	].sort();
	const unexpectedPaths = observedPaths.filter(
		(path) => !expectedScopes.some((scope) => pathWithinScope(path, scope)),
	);
	const observedGraphEffects = (
		semanticBinding === undefined
			? review.commits
					.filter((commit) =>
						review.semantic?.bindings.some((binding) => binding.commit.value === commit.oid),
					)
					.flatMap((commit) => commit.delta.events ?? [])
			: events
	).map(eventLabel);
	const reasonCodes = [
		...new Set(
			semanticGate?.reasonCodes ??
				review.semantic?.gateResult.units.flatMap((unit) => unit.reasonCodes) ??
				[],
		),
	];
	const requiredChecks = [...new Set(semanticUnits.flatMap((unit) => unit.requiredChecks))];
	const checkResults =
		review.semantic?.checks.filter((check) => requiredChecks.includes(check.checkId)) ?? [];
	const failedChecks = checkResults
		.filter((check) => check.exitCode !== 0)
		.map((check) => check.checkId);
	const readinessVerdict = semanticGate?.verdict ?? review.semantic?.gateResult.verdict;
	const isReady = readinessVerdict === "valid" || readinessVerdict === "pass";
	const broadReach = expectedScopes.includes(".") || expectedScopes.length >= 4;

	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/review-decisions", { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`Local reviews unavailable (${response.status})`);
				return response.json() as Promise<ReviewDecisionHistory>;
			})
			.then(setDecisionHistory)
			.catch((reason: unknown) => {
				if (!(reason instanceof DOMException && reason.name === "AbortError")) {
					setReviewStateError(
						reason instanceof Error ? reason.message : "Local reviews unavailable",
					);
				}
			});
		return () => controller.abort();
	}, []);

	useEffect(() => {
		const container = commitStack.current;
		const selectedItem = selectedCommit.current;
		if (selectedOid === "" || container === null || selectedItem === null) return;
		const itemTop = selectedItem.offsetTop;
		const itemBottom = itemTop + selectedItem.offsetHeight;
		if (itemTop < container.scrollTop) container.scrollTop = itemTop;
		if (itemBottom > container.scrollTop + container.clientHeight) {
			container.scrollTop = itemBottom - container.clientHeight;
		}
	}, [selectedOid]);

	return (
		<div className="app-shell generic-review">
			{helpOpen ? <HelpPanel onClose={() => setHelpOpen(false)} /> : null}
			<header className="product-header">
				<div className="brand">
					<span className="brand-glyph" aria-hidden="true">
						G
					</span>
					<div>
						<strong>GraphReFly Stack</strong>
						<small>{review.repository.label} / local Git repository</small>
					</div>
				</div>
				<div className="header-actions">
					<span className="context-badge">
						{review.repository.headLabel} · {review.commits.length} commits
					</span>
					<button className="help-button" type="button" onClick={() => setHelpOpen(true)}>
						<span aria-hidden="true">?</span> Help
					</button>
				</div>
			</header>

			<section className="selection-heading">
				<div>
					<p className="kicker">
						Commit {short(selected.oid, 12)} · Blueprint {short(hash, 12)}
					</p>
					<h1>{selected.subject}</h1>
				</div>
				{review.semantic === undefined ? (
					<div className="gate-summary is-neutral">
						<span>Readiness · Structure available</span>
						<code>Readiness needs an accepted intent</code>
					</div>
				) : (
					<div
						className={`gate-summary ${review.semantic.gateResult.verdict === "pass" ? "is-valid" : "is-invalid"}`}
					>
						<span>
							{review.semantic.gateResult.verdict === "pass"
								? "Readiness · Ready"
								: "Readiness · Needs attention"}
						</span>
						<code>
							{review.semantic.invalidWorkUnitIds.length === 0
								? "Intent and observed reach still agree"
								: `${review.semantic.invalidWorkUnitIds.length} outcome${review.semantic.invalidWorkUnitIds.length === 1 ? "" : "s"} need revision`}
						</code>
					</div>
				)}
			</section>

			<main className="review-workbench">
				<aside className="stack-column" aria-label="Git stack">
					<div className="column-heading">
						<span>Git stack</span>
						<small>{review.commits.length} linear commits</small>
					</div>
					<div className="commit-stack" ref={commitStack}>
						{[...review.commits].reverse().map((commit) => {
							return (
								<button
									ref={commit.oid === selected.oid ? selectedCommit : undefined}
									className={`commit-card ${commit.oid === selected.oid ? "is-selected" : ""}`}
									type="button"
									aria-pressed={commit.oid === selected.oid}
									onClick={() => {
										setSelectedOid(commit.oid);
										setReviewOpen(false);
									}}
									key={commit.oid}
								>
									<span className="commit-dot is-evidence" />
									<span className="commit-main">
										<strong>{commit.subject}</strong>
										<small>
											{short(commit.oid)} · {commit.diff.paths.length} files
										</small>
									</span>
									<span className="commit-meta">
										<b>{commit.delta.events?.length ?? 0} graph Δ</b>
										<small>Review context</small>
									</span>
								</button>
							);
						})}
						<div className="base-commit">
							<span className="base-square" />
							<div>
								<strong>{short(review.base.oid)} · base</strong>
								<small>{review.base.subject}</small>
							</div>
						</div>
					</div>
				</aside>

				<section className="blueprint-column" aria-labelledby="blueprint-title">
					<div className="column-heading blueprint-heading">
						<div>
							<span>GraphReFly Blueprint</span>
							<small id="blueprint-title">
								Generated and verified at {short(selected.oid, 12)}
							</small>
						</div>
					</div>
					<BlueprintDiagram
						oid={selected.oid}
						source={selected.diagram.source}
						events={selected.delta.events}
					/>
					<div className="delta-bar">
						<div>
							<span>Parent delta</span>
							<strong>
								{events.length === 0 ? "No structural change" : `${events.length} graph events`}
							</strong>
						</div>
						<div>
							<span>Blueprint hash</span>
							<strong>{short(hash, 16)}</strong>
						</div>
						<div>
							<span>Diagnostics</span>
							<strong>
								{selected.blueprint.diagnostics?.ok
									? `Valid · ${diagnosticCount} notices`
									: "Invalid"}
							</strong>
						</div>
					</div>
					{events.length > 0 ? (
						<div className="event-list">
							{events.map((event) => (
								<code key={JSON.stringify(event)}>{eventLabel(event)}</code>
							))}
						</div>
					) : null}
				</section>
			</main>

			{review.semantic !== undefined ? (
				<section className="semantic-review" aria-labelledby="semantic-title">
					<div className="section-heading">
						<div>
							<p className="kicker">Change contract</p>
							<h2 id="semantic-title">{semanticUnit?.title ?? review.semantic.plan.taskSummary}</h2>
							<p>
								{semanticUnit?.intent ??
									`${review.semantic.plan.workUnits.length} accepted outcomes are evaluated together.`}
							</p>
						</div>
						<div className={`gate-summary ${isReady ? "is-valid" : "is-invalid"}`}>
							<span>{isReady ? "Ready" : "Needs attention"}</span>
							<code>
								{reasonCodes.length === 0
									? "Accepted promises still hold"
									: humanizeReason(reasonCodes[0] as string)}
							</code>
						</div>
					</div>
					<div className="change-contract-grid">
						<article className="contract-card">
							<span className="contract-label">1 · Intent</span>
							<h3>What should change—and remain true</h3>
							<ul className="contract-list">
								{semanticUnits.map((unit) => (
									<li key={unit.id}>
										<strong>{unit.title}</strong>
										<small>{unit.intent}</small>
									</li>
								))}
							</ul>
							<div className="promise-list">
								<span>Must remain true</span>
								{semanticUnits
									.flatMap((unit) => unit.claims)
									.map((claim) => (
										<p key={claim.id}>{claim.rationale}</p>
									))}
							</div>
						</article>

						<article
							className={`contract-card ${unexpectedPaths.length > 0 ? "has-exception" : ""}`}
						>
							<span className="contract-label">2 · Reach</span>
							<h3>
								{unexpectedPaths.length > 0
									? "Reached farther than accepted"
									: broadReach
										? "Broad reach was accepted"
										: "Observed reach stays within intent"}
							</h3>
							<p className="reach-summary">
								<strong>{observedPaths.length}</strong> changed paths ·{" "}
								<strong>{observedGraphEffects.length}</strong> graph effects
							</p>
							<div className="reach-group">
								<span>Expected</span>
								<div className="scope-chips">
									{expectedScopes.map((scope) => (
										<code key={scope}>{scope}</code>
									))}
								</div>
							</div>
							<div className="reach-group">
								<span>Observed</span>
								<ul className="compact-paths">
									{observedPaths.map((path) => (
										<li
											className={unexpectedPaths.includes(path) ? "is-unexpected" : ""}
											key={path}
										>
											{path}
											{unexpectedPaths.includes(path) ? " · unexpected" : ""}
										</li>
									))}
								</ul>
							</div>
						</article>

						<article className={`contract-card ${isReady ? "is-ready" : "needs-action"}`}>
							<span className="contract-label">3 · Readiness</span>
							<h3>{isReady ? "Ready for a human decision" : "Revise before approval"}</h3>
							{reasonCodes.length === 0 ? (
								<p>The accepted intent, observed reach and repository checks still agree.</p>
							) : (
								<ul className="readiness-reasons">
									{reasonCodes.map((reason) => (
										<li key={reason}>{humanizeReason(reason)}</li>
									))}
								</ul>
							)}
							<div className="check-list">
								{checkResults.map((check) => (
									<span className={check.exitCode === 0 ? "passed" : "failed"} key={check.checkId}>
										{check.exitCode === 0 ? "✓" : "!"} {check.checkId}
									</span>
								))}
							</div>
							<div className="next-action">
								<span>Next</span>
								<strong>{nextAction(reasonCodes, failedChecks)}</strong>
							</div>
						</article>
					</div>
				</section>
			) : null}

			<section className="code-review" aria-labelledby="code-title">
				<div className="section-heading">
					<div>
						<p className="kicker">Code changes</p>
						<h2 id="code-title">
							{selected.diff.paths.length} {selected.diff.paths.length === 1 ? "file" : "files"}{" "}
							changed
						</h2>
					</div>
					<div className="section-heading-actions">
						<span className={`review-status ${currentDecision?.decision ?? "none"}`}>
							{humanState}
						</span>
						<span className="compare-label">
							{short(selected.parentOid)} ↔ {short(selected.oid)}
						</span>
						<button
							className="review-button"
							type="button"
							onClick={() => setReviewOpen((open) => !open)}
						>
							{currentDecision === undefined ? "Review whole change" : "Record new decision"}
						</button>
					</div>
				</div>
				{reviewOpen ? (
					<ReviewPanel
						key={selected.oid}
						commit={selected}
						current={currentDecision}
						onClose={() => setReviewOpen(false)}
						onSaved={(record) => {
							setDecisionHistory((history) => ({
								...history,
								current: [...history.current, record],
							}));
							setReviewStateError(null);
						}}
					/>
				) : null}
				{currentDecision?.decision === "request-changes" ? (
					<div className="correction-guidance">
						<strong>Correct on this same feature branch.</strong>
						<span>
							Append corrective commits, push them, then use your Git provider's native Re-request
							review action. Fresh evidence will return this human state to Needs review.
						</span>
					</div>
				) : currentDecision === undefined && decisionHistory.outdated.length > 0 ? (
					<div className="correction-guidance is-fresh">
						<strong>Fresh revision · Needs review.</strong>
						<span>
							Earlier decisions are outdated for this exact change. Push the branch and use your Git
							provider's native Re-request review action when the correction is ready.
						</span>
					</div>
				) : null}
				{decisionHistory.current.length > 0 || decisionHistory.outdated.length > 0 ? (
					<details className="review-history" open={decisionHistory.outdated.length > 0}>
						<summary>
							Review history · {decisionHistory.current.length} current ·{" "}
							{decisionHistory.outdated.length} outdated
						</summary>
						<div>
							{[
								...decisionHistory.current.map((decision) => ({ decision, status: "Current" })),
								...decisionHistory.outdated.map((decision) => ({ decision, status: "Outdated" })),
							].map(({ decision, status }) => (
								<article key={decision.id} className={status === "Outdated" ? "is-outdated" : ""}>
									<span>{status}</span>
									<strong>{decisionActionLabel(decision)}</strong>
									<small>
										{decision.reviewerLabel} · {new Date(decision.recordedAt).toLocaleString()}
										{decision.schema === "graphrefly.stack.repository-review-decision.v1"
											? " · legacy commit decision"
											: ""}
									</small>
									<p>{decision.summary || "No summary provided."}</p>
								</article>
							))}
						</div>
					</details>
				) : null}
				{reviewStateError === null ? null : (
					<p className="review-state-warning">{reviewStateError}</p>
				)}
				<StructuredCodeDiff files={selected.diff.files} />
			</section>

			<section className="secondary-details generic-details">
				<details>
					<summary>
						<span>Technical details</span>
						<small>Runtime and immutable identities</small>
					</summary>
					<div className="detail-grid">
						<div>
							<span>Blueprint entrypoint</span>
							<strong>{review.repository.entrypoint}</strong>
						</div>
						<div>
							<span>Runtime</span>
							<strong>@graphrefly/ts {review.repository.graphreflyVersion}</strong>
						</div>
						<div>
							<span>Renderer</span>
							<strong>{selected.diagram.renderer}</strong>
						</div>
						<div>
							<span>Parent</span>
							<strong>{selected.parentOid}</strong>
						</div>
						<div>
							<span>Commit</span>
							<strong>{selected.oid}</strong>
						</div>
						<div>
							<span>Blueprint</span>
							<strong>{hash}</strong>
						</div>
						{review.semantic === undefined ? null : (
							<>
								<div>
									<span>Plan / WorkUnit</span>
									<strong>
										{review.semantic.plan.planId} / {semanticUnit?.id ?? "whole change"}
									</strong>
								</div>
								<div>
									<span>Accepted source scopes</span>
									<strong>{expectedScopes.join(" · ") || "none"}</strong>
								</div>
								<div>
									<span>Binding / record</span>
									<strong>
										{semanticBinding?.stablePatchId ?? "aggregate"} /{" "}
										{semanticRecord?.recordId ?? "aggregate"}
									</strong>
								</div>
								<div>
									<span>Gate input</span>
									<strong>{review.semantic.gateResult.inputDigest.value}</strong>
								</div>
								<div>
									<span>Typed predicates</span>
									<code>
										{JSON.stringify(
											semanticUnits.flatMap((unit) =>
												unit.claims.map((claim) => ({ id: claim.id, predicate: claim.predicate })),
											),
										)}
									</code>
								</div>
								<div>
									<span>Check command digests</span>
									<code>
										{checkResults
											.map((check) => `${check.checkId}:${check.commandDigest.value}`)
											.join(" · ") || "none"}
									</code>
								</div>
							</>
						)}
						{decisionHistory.current.some(
							(decision) => decision.schema === "graphrefly.stack.repository-review-decision.v2",
						) ? (
							<div>
								<span>Share reviews</span>
								<a className="text-link" href="/api/review-decisions/export" download>
									Export portable review bundle
								</a>
							</div>
						) : null}
					</div>
				</details>
			</section>
		</div>
	);
}
