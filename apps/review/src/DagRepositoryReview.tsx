import { useEffect, useMemo, useState } from "react";

import { GitDagGraph, type GitDagObject } from "./GitDagGraph";
import {
	BlueprintDiagram,
	type BlueprintEvent,
	type FileDiff,
	StructuredCodeDiff,
} from "./ReviewPrimitives";

type Oid = { algorithm: "sha1" | "sha256"; value: string };
type Selection =
	| { kind: "structural-unit"; workUnitId: string }
	| { kind: "work-unit"; workUnitId: string; commit: Oid; parent: Oid }
	| { kind: "join"; join: Oid; parent: Oid; parentIndex: number };
type Lane = {
	oid: Oid;
	layer: number;
	kind: "implementation" | "transport" | "join";
	verdict: "valid" | "invalid" | "not-evaluated" | "not-applicable";
};

export interface DagReviewData {
	schema: "graphrefly.stack.dag-review-evidence.v2";
	domainBundle: {
		topology: {
			repository: { provider: string; owner: string; name: string };
			base: Oid;
			head: Oid;
			objects: GitDagObject[];
		};
		dependencyGraph: {
			planId: string;
			workUnits: Array<{ workUnitId: string; dependencies: string[] }>;
		};
		gateResult: {
			verdict: "pass" | "blocked" | "error";
			minimalAffectedCut: string[];
			units: Array<{
				workUnitId: string;
				verdict: "valid" | "invalid" | "not-evaluated";
				reasonCodes: string[];
				invalidDependencies?: string[];
			}>;
			joins: Array<{ oid: Oid; verdict: "valid" | "invalid"; reasonCodes: string[] }>;
		};
	};
	plan: {
		planId: string;
		taskSummary: string;
		workUnits: Array<{
			id: string;
			title: string;
			intent: string;
			claims: Array<{ id: string; rationale: string; predicate: Record<string, unknown> }>;
			requiredChecks: string[];
		}>;
	};
	objects: Array<{
		oid: Oid;
		subject: string;
		blueprint: {
			hash?: { value?: string };
			topology?: Record<string, unknown>;
			diagnostics?: { ok?: boolean; issues?: unknown[] };
		};
	}>;
	comparisons: Array<{
		from: Oid;
		to: Oid;
		parentIndex: number;
		blueprintDelta: { events?: Array<Record<string, unknown>> };
		structuredDiff: { paths: string[]; files: FileDiff[] };
	}>;
	projection: {
		summary: { verdict: "pass" | "blocked" | "error"; minimalAffectedCut: string[] };
		gitLanes: Lane[];
		gitEdges: Array<{ from: Oid; to: Oid; parentIndex: number }>;
		semanticEdges: Array<{ fromWorkUnitId: string; toWorkUnitId: string }>;
		selectedEvidence: Selection;
	};
	presentation?: {
		schema: "graphrefly.stack.dag-review-presentation.v1";
		diagrams: Array<{
			oid: Oid;
			diagram?: { format: "mermaid"; renderer: string; source: string };
		}>;
	};
}

type Decision = {
	id: string;
	decision: "approve" | "request-changes";
	reviewerLabel: string;
	summary: string;
	recordedAt: string;
	selectedEvidence?: Selection;
};

type DecisionHistory = {
	schema: "graphrefly.stack.review-decision-history.v1";
	current: Decision[];
	outdated: Decision[];
};

function key(oid: Oid): string {
	return `${oid.algorithm}:${oid.value}`;
}

function short(value: string, size = 9): string {
	return value.slice(0, size);
}

function decisionLabel(decision: Decision | undefined): string {
	if (decision?.decision === "approve") return "Approved";
	if (decision?.decision === "request-changes") return "Changes requested";
	return "Needs review";
}

function eventLabel(event: Record<string, unknown>): string {
	const topologyPath = Array.isArray(event.topologyPath)
		? event.topologyPath.map(String).join(" / ")
		: undefined;
	const target =
		(event.node as { id?: string } | undefined)?.id ??
		(event.after as { id?: string } | undefined)?.id ??
		(event.before as { id?: string } | undefined)?.id ??
		topologyPath;
	return `${String(event.type ?? "change")}${target ? ` · ${target}` : ""}`;
}

export function DagRepositoryReview({ review }: { review: DagReviewData }) {
	const topology = review.domainBundle.topology;
	const gate = review.domainBundle.gateResult;
	const [selected, setSelected] = useState<Selection>(review.projection.selectedEvidence);
	const [decisionHistory, setDecisionHistory] = useState<DecisionHistory>({
		schema: "graphrefly.stack.review-decision-history.v1",
		current: [],
		outdated: [],
	});
	const [reviewerLabel, setReviewerLabel] = useState("");
	const [summary, setSummary] = useState("");
	const [stateMessage, setStateMessage] = useState<string | null>(null);
	const currentDecision = decisionHistory.current.at(-1);
	const selectedOid =
		selected.kind === "work-unit"
			? selected.commit
			: selected.kind === "join"
				? selected.join
				: undefined;
	const selectedObject = topology.objects.find(
		(entry) => selectedOid !== undefined && key(entry.oid) === key(selectedOid),
	);
	const selectedUnitId =
		selected.kind === "structural-unit" ? selected.workUnitId : selectedObject?.workUnitId;
	const unit = review.plan.workUnits.find((entry) => entry.id === selectedUnitId);
	const unitGate = gate.units.find((entry) => entry.workUnitId === selectedUnitId);
	const objectEvidence = review.objects.find(
		(entry) => selectedOid !== undefined && key(entry.oid) === key(selectedOid),
	);
	const comparison = review.comparisons.find(
		(entry) =>
			selectedOid !== undefined &&
			key(entry.to) === key(selectedOid) &&
			entry.parentIndex === (selected.kind === "join" ? selected.parentIndex : 0),
	);
	const diagram = review.presentation?.diagrams.find(
		(entry) => selectedOid !== undefined && key(entry.oid) === key(selectedOid),
	)?.diagram;
	const blueprintEvents = (comparison?.blueprintDelta.events ?? []) as BlueprintEvent[];
	const joinGate =
		selected.kind === "join"
			? gate.joins.find((entry) => key(entry.oid) === key(selected.join))
			: undefined;
	const reasonCodes =
		selected.kind === "join" ? (joinGate?.reasonCodes ?? []) : (unitGate?.reasonCodes ?? []);
	const invalidDependencies = unitGate?.invalidDependencies ?? [];
	const selectedVerdict = selected.kind === "join" ? joinGate?.verdict : unitGate?.verdict;
	const attentionCount =
		gate.units.filter((entry) => entry.verdict !== "valid").length +
		gate.joins.filter((entry) => entry.verdict !== "valid").length;
	const subjects = useMemo(
		() => new Map(review.objects.map((entry) => [key(entry.oid), entry.subject] as const)),
		[review.objects],
	);

	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/review-decisions", { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`Local decisions unavailable (${response.status})`);
				return response.json() as Promise<DecisionHistory>;
			})
			.then(setDecisionHistory)
			.catch((error: unknown) => {
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					setStateMessage(error instanceof Error ? error.message : "Local decisions unavailable");
				}
			});
		return () => controller.abort();
	}, []);

	const selectObject = (object: GitDagObject) => {
		const parent = object.parents[0];
		if (parent === undefined) return;
		if (object.kind === "join") {
			setSelected({ kind: "join", join: object.oid, parent, parentIndex: 0 });
		} else if (object.kind === "implementation") {
			setSelected({
				kind: "work-unit",
				workUnitId: object.workUnitId ?? "",
				commit: object.oid,
				parent,
			});
		}
	};

	const submit = async (decision: Decision["decision"]) => {
		setStateMessage(null);
		try {
			const response = await fetch("/api/review-decisions", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-GraphReFly-Review": "1" },
				body: JSON.stringify({
					schema: "graphrefly.stack.dag-review-decision-request.v2",
					decision,
					reviewerLabel,
					summary,
					selectedEvidence: selected,
				}),
			});
			const body = (await response.json()) as Decision | { message?: string };
			if (!response.ok) throw new Error("message" in body ? body.message : "Decision was rejected");
			setDecisionHistory((history) => ({
				...history,
				current: [...history.current, body as Decision],
			}));
			setSummary("");
			setStateMessage("Decision recorded in repository-local state.");
		} catch (error) {
			setStateMessage(error instanceof Error ? error.message : "Decision could not be recorded");
		}
	};

	return (
		<div className="app-shell dag-review generic-review">
			<header className="product-header">
				<div className="brand">
					<span className="brand-glyph" aria-hidden="true">
						G
					</span>
					<div>
						<strong>GraphReFly Stack</strong>
						<small>
							{topology.repository.owner}/{topology.repository.name} · local Git repository
						</small>
					</div>
				</div>
				<span className="context-badge">
					{review.plan.planId} · {topology.objects.length} objects
				</span>
			</header>

			<section className="selection-heading dag-decision-heading">
				<div>
					<p className="kicker">Decision first · whole-change review</p>
					<h1>{review.plan.taskSummary}</h1>
					<p>
						Select a commit to synchronize its Git ancestry, GraphReFly Blueprint, graph delta, and
						code comparison. The review decision still targets the whole result.
					</p>
					<span className={`review-status ${currentDecision?.decision ?? "none"}`}>
						Human review · {decisionLabel(currentDecision)}
					</span>
				</div>
				<div className={`gate-summary ${gate.verdict === "pass" ? "is-valid" : "is-invalid"}`}>
					<span>Readiness · {gate.verdict}</span>
					<code>{attentionCount} outcomes need attention</code>
				</div>
			</section>

			<main className="review-workbench dag-workbench">
				<aside className="stack-column" aria-label="Git DAG">
					<div className="column-heading">
						<span>Git graph</span>
						<small>
							{review.projection.gitEdges.length} parent edges ·{" "}
							{review.projection.semanticEdges.length} semantic
						</small>
					</div>
					<GitDagGraph
						base={topology.base}
						head={topology.head}
						objects={topology.objects}
						gitEdges={review.projection.gitEdges}
						semanticEdges={review.projection.semanticEdges}
						subjects={subjects}
						selectedOid={selectedOid}
						onSelect={selectObject}
					/>
					<div className="git-dag-legend">
						<span>
							<i className="git-line-sample" /> Git parent
						</span>
						<span>
							<i className="semantic-line-sample" /> semantic dependency
						</span>
					</div>
				</aside>

				<section className="blueprint-column" aria-labelledby="dag-blueprint-title">
					<div className="column-heading blueprint-heading">
						<div>
							<span>GraphReFly Blueprint</span>
							<small id="dag-blueprint-title">
								{selectedOid === undefined
									? "Select a Git object"
									: `Generated and verified at ${short(selectedOid.value, 12)}`}
							</small>
						</div>
						{selected.kind === "join" && selectedObject !== undefined ? (
							<div className="parent-switcher compact">
								<span>Compare parent</span>
								{selectedObject.parents.map((parent, parentIndex) => (
									<button
										key={key(parent)}
										type="button"
										aria-pressed={selected.parentIndex === parentIndex}
										onClick={() =>
											setSelected({ kind: "join", join: selected.join, parent, parentIndex })
										}
									>
										P{parentIndex + 1} · {short(parent.value)}
									</button>
								))}
							</div>
						) : null}
					</div>
					{diagram !== undefined && selectedOid !== undefined ? (
						<BlueprintDiagram
							oid={selectedOid.value}
							source={diagram.source}
							events={blueprintEvents}
						/>
					) : (
						<div className="diagram-stage diagram-unavailable">
							<strong>GraphReFly Blueprint diagram unavailable</strong>
							<span>
								This imported evidence has topology, but no target-runtime presentation. Run the
								review from the repository to render it.
							</span>
						</div>
					)}
					<div className="delta-bar">
						<div>
							<span>Parent delta</span>
							<strong>
								{blueprintEvents.length === 0
									? "No structural change"
									: `${blueprintEvents.length} graph events`}
							</strong>
						</div>
						<div>
							<span>Blueprint hash</span>
							<strong>{short(objectEvidence?.blueprint.hash?.value ?? "unavailable", 16)}</strong>
						</div>
						<div>
							<span>Diagnostics</span>
							<strong>
								{objectEvidence?.blueprint.diagnostics?.ok
									? `Valid · ${objectEvidence.blueprint.diagnostics.issues?.length ?? 0} notices`
									: "Unavailable"}
							</strong>
						</div>
					</div>
					{blueprintEvents.length > 0 ? (
						<div className="event-list">
							{blueprintEvents.map((event) => (
								<code key={JSON.stringify(event)}>{eventLabel(event)}</code>
							))}
						</div>
					) : null}
				</section>
			</main>

			<section className="semantic-review" aria-labelledby="dag-contract-title">
				<div className="section-heading">
					<div>
						<p className="kicker">Change contract</p>
						<h2 id="dag-contract-title">
							{unit?.title ?? selectedUnitId ?? objectEvidence?.subject ?? "Join evidence"}
						</h2>
						<p>
							{unit?.intent ??
								"This object joins already reviewed branches and carries no separate WorkUnit intent."}
						</p>
					</div>
					<div
						className={`gate-summary ${selectedVerdict === "valid" ? "is-valid" : "is-invalid"}`}
					>
						<span>{selectedVerdict === "valid" ? "Ready" : "Needs attention"}</span>
						<code>{reasonCodes[0] ?? "Accepted promises still hold"}</code>
					</div>
				</div>
				<div className="change-contract-grid">
					<article className="contract-card">
						<span className="contract-label">1 · Intent</span>
						<h3>What this branch should accomplish</h3>
						<p>{unit?.intent ?? "Transport-only join of the two parent results."}</p>
						{unit?.claims.map((claim) => (
							<p className="dag-promise" key={claim.id}>
								{claim.rationale}
							</p>
						))}
					</article>
					<article className="contract-card">
						<span className="contract-label">2 · Reach</span>
						<h3>What actually changed here</h3>
						<p className="reach-summary">
							<strong>{comparison?.structuredDiff.paths.length ?? 0}</strong> changed paths ·{" "}
							<strong>{blueprintEvents.length}</strong> graph effects
						</p>
						<ul className="compact-paths">
							{comparison?.structuredDiff.paths.map((path) => (
								<li key={path}>{path}</li>
							))}
						</ul>
					</article>
					<article
						className={`contract-card ${selectedVerdict === "valid" ? "is-ready" : "needs-action"}`}
					>
						<span className="contract-label">3 · Readiness</span>
						<h3>{selectedVerdict === "valid" ? "Ready for a human decision" : "Revise first"}</h3>
						<div className="reason-list">
							{reasonCodes.map((reason) => (
								<code key={reason}>{reason}</code>
							))}
							{invalidDependencies.map((dependency) => (
								<code key={dependency}>invalid dependency · {dependency}</code>
							))}
						</div>
						<p>
							Whole result: {gate.verdict}. Minimal affected cut:{" "}
							{gate.minimalAffectedCut.join(" → ") || "none"}.
						</p>
					</article>
				</div>
			</section>

			<section className="code-review" aria-labelledby="dag-code-title">
				<div className="section-heading">
					<div>
						<p className="kicker">Code changes</p>
						<h2 id="dag-code-title">
							{comparison?.structuredDiff.paths.length ?? 0}{" "}
							{comparison?.structuredDiff.paths.length === 1 ? "file" : "files"} changed
						</h2>
					</div>
					<span className="compare-label">
						{short(comparison?.from.value ?? "parent")} ↔ {short(comparison?.to.value ?? "commit")}
					</span>
				</div>
				<StructuredCodeDiff files={comparison?.structuredDiff.files ?? []} />
			</section>

			<section className="dag-decision-panel">
				<div>
					<p className="kicker">Repository-local decision</p>
					<h2>Review the whole change</h2>
					<p>
						{decisionHistory.current.length} current · {decisionHistory.outdated.length} outdated.
						Commit selection is context only.
					</p>
				</div>
				<label>
					Reviewer
					<input
						value={reviewerLabel}
						maxLength={120}
						onChange={(event) => setReviewerLabel(event.target.value)}
					/>
				</label>
				<label>
					Summary
					<textarea
						value={summary}
						maxLength={10000}
						onChange={(event) => setSummary(event.target.value)}
					/>
				</label>
				<div className="decision-actions">
					<button type="button" onClick={() => void submit("request-changes")}>
						Request changes
					</button>
					<button type="button" className="approve" onClick={() => void submit("approve")}>
						Approve result
					</button>
				</div>
				{stateMessage ? <p className="state-message">{stateMessage}</p> : null}
			</section>
			{currentDecision?.decision === "request-changes" ? (
				<div className="correction-guidance">
					<strong>Correct on the same feature branch.</strong>
					<span>
						Append corrective commits, push them, then use your Git provider's native Re-request
						review action. Stack will bind the next decision only to fresh DAG evidence.
					</span>
				</div>
			) : currentDecision === undefined && decisionHistory.outdated.length > 0 ? (
				<div className="correction-guidance is-fresh">
					<strong>Fresh DAG evidence · Needs review.</strong>
					<span>Prior whole-result decisions remain visible but no longer bind this result.</span>
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
							...decisionHistory.outdated.map((decision) => ({
								decision,
								status: "Outdated",
							})),
						].map(({ decision, status }) => (
							<article key={decision.id} className={status === "Outdated" ? "is-outdated" : ""}>
								<span>{status}</span>
								<strong>{decisionLabel(decision)}</strong>
								<small>
									{decision.reviewerLabel} · {new Date(decision.recordedAt).toLocaleString()}
								</small>
								<p>{decision.summary || "No summary provided."}</p>
							</article>
						))}
					</div>
				</details>
			) : null}

			<section className="secondary-details generic-details">
				<details>
					<summary>
						<span>Technical details</span>
						<small>Immutable DAG and Blueprint identities</small>
					</summary>
					<div className="detail-grid">
						<div>
							<span>Plan / WorkUnit</span>
							<strong>
								{review.plan.planId} / {selectedUnitId ?? "transport"}
							</strong>
						</div>
						<div>
							<span>Selected object</span>
							<strong>{selectedOid?.value ?? "none"}</strong>
						</div>
						<div>
							<span>Blueprint</span>
							<strong>{objectEvidence?.blueprint.hash?.value ?? "unavailable"}</strong>
						</div>
						<div>
							<span>Renderer</span>
							<strong>{diagram?.renderer ?? "not included in imported evidence"}</strong>
						</div>
					</div>
				</details>
			</section>
		</div>
	);
}
