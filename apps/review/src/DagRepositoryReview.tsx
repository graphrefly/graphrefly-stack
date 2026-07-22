import { useEffect, useMemo, useState } from "react";

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
type DiffLine = {
	kind: "context" | "delete" | "add";
	content: string;
	oldNo?: number;
	newNo?: number;
};

export interface DagReviewData {
	schema: "graphrefly.stack.dag-review-evidence.v2";
	domainBundle: {
		topology: {
			repository: { provider: string; owner: string; name: string };
			base: Oid;
			head: Oid;
			objects: Array<{
				oid: Oid;
				parents: Oid[];
				layer: number;
				kind: "implementation" | "transport" | "join";
				workUnitId: string | null;
			}>;
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
				invalidDependencies: string[];
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
		structuredDiff: {
			paths: string[];
			files: Array<{
				oldPath: string;
				newPath: string;
				additions: number;
				deletions: number;
				binary: boolean;
				hunks: Array<{ header: string; lines: DiffLine[] }>;
			}>;
		};
	}>;
	projection: {
		summary: { verdict: "pass" | "blocked" | "error"; minimalAffectedCut: string[] };
		gitLanes: Lane[];
		gitEdges: Array<{ from: Oid; to: Oid; parentIndex: number }>;
		semanticEdges: Array<{ fromWorkUnitId: string; toWorkUnitId: string }>;
		selectedEvidence: Selection;
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

function selectionKey(selection: Selection): string {
	if (selection.kind === "structural-unit") return `unit:${selection.workUnitId}`;
	if (selection.kind === "work-unit") return `oid:${key(selection.commit)}:0`;
	return `oid:${key(selection.join)}:${selection.parentIndex}`;
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
	const layers = useMemo(
		() =>
			[...new Set(review.projection.gitLanes.map((lane) => lane.layer))].sort(
				(left, right) => left - right,
			),
		[review],
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
		<div className="app-shell dag-review">
			<header className="product-header">
				<div className="brand">
					<span className="brand-glyph">G</span>
					<div>
						<strong>GraphReFly Stack</strong>
						<small>
							{topology.repository.owner}/{topology.repository.name} · bounded DAG review
						</small>
					</div>
				</div>
				<span className="context-badge">
					{review.plan.planId} · {topology.objects.length} objects
				</span>
			</header>

			<section className="selection-heading dag-decision-heading">
				<div>
					<p className="kicker">Decision first · whole-result binding</p>
					<h1>{review.plan.taskSummary}</h1>
					<p>
						Minimal affected cut: {gate.minimalAffectedCut.join(" → ") || "none"}. Selecting
						evidence below changes context, not the decision target.
					</p>
					<span className={`review-status ${currentDecision?.decision ?? "none"}`}>
						Human review · {decisionLabel(currentDecision)}
					</span>
				</div>
				<div className={`gate-summary ${gate.verdict === "pass" ? "is-valid" : "is-invalid"}`}>
					<span>Readiness · {gate.verdict}</span>
					<code>
						{gate.units.filter((entry) => entry.verdict !== "valid").length} units need attention
					</code>
				</div>
			</section>

			<section className="dag-map" aria-label="Git and semantic DAG">
				<div className="column-heading">
					<span>Git lanes</span>
					<small>solid parent edges · dashed semantic dependencies</small>
				</div>
				<div className="dag-layers">
					{layers.map((layer) => (
						<div className="dag-layer" key={layer}>
							<small>Layer {layer}</small>
							<div>
								{review.projection.gitLanes
									.filter((lane) => lane.layer === layer)
									.map((lane) => {
										const object = topology.objects.find(
											(entry) => key(entry.oid) === key(lane.oid),
										);
										const evidence = review.objects.find(
											(entry) => key(entry.oid) === key(lane.oid),
										);
										const laneSelection: Selection | undefined =
											lane.kind === "join"
												? {
														kind: "join",
														join: lane.oid,
														parent: object?.parents[0] as Oid,
														parentIndex: 0,
													}
												: lane.kind === "implementation"
													? {
															kind: "work-unit",
															workUnitId: object?.workUnitId ?? "",
															commit: lane.oid,
															parent: object?.parents[0] as Oid,
														}
													: undefined;
										return (
											<button
												key={key(lane.oid)}
												type="button"
												className={`dag-node is-${lane.verdict} ${laneSelection !== undefined && selectionKey(selected) === selectionKey(laneSelection) ? "is-selected" : ""}`}
												disabled={laneSelection === undefined}
												onClick={() => {
													if (laneSelection !== undefined) setSelected(laneSelection);
												}}
											>
												<span>{lane.kind}</span>
												<strong>{object?.workUnitId ?? short(lane.oid.value)}</strong>
												<small>{evidence?.subject ?? lane.verdict}</small>
											</button>
										);
									})}
							</div>
						</div>
					))}
				</div>
				<div className="edge-ledger">
					<span>Git · {review.projection.gitEdges.length} parent edges</span>
					{review.projection.semanticEdges.map((edge) => (
						<code key={`${edge.fromWorkUnitId}:${edge.toWorkUnitId}`}>
							{edge.fromWorkUnitId} ⇢ {edge.toWorkUnitId}
						</code>
					))}
				</div>
			</section>

			{selected.kind === "join" && selectedObject !== undefined ? (
				<div className="parent-switcher">
					<span>Compare join against parent</span>
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

			<section className="dag-evidence-grid">
				<article>
					<p className="kicker">Accepted intent</p>
					<h2>{unit?.title ?? selectedUnitId ?? objectEvidence?.subject ?? "Join evidence"}</h2>
					<p>
						{unit?.intent ??
							"This object carries topology or join evidence, not a WorkUnit intent."}
					</p>
					<div className="reason-list">
						{unitGate?.reasonCodes.map((reason) => (
							<code key={reason}>{reason}</code>
						))}
						{unitGate?.invalidDependencies.map((dependency) => (
							<code key={dependency}>invalid dependency · {dependency}</code>
						))}
					</div>
					{unit?.claims.map((claim) => (
						<details key={claim.id}>
							<summary>
								{claim.id} · {claim.rationale}
							</summary>
							<pre>{JSON.stringify(claim.predicate, null, 2)}</pre>
						</details>
					))}
				</article>
				<article>
					<p className="kicker">Graph + code evidence</p>
					<h2>{objectEvidence?.subject ?? "No commit is bound"}</h2>
					<p>
						Blueprint {short(objectEvidence?.blueprint.hash?.value ?? "unavailable", 16)} ·{" "}
						{comparison?.structuredDiff.paths.length ?? 0} paths
					</p>
					<div className="event-list">
						{(comparison?.blueprintDelta.events ?? []).map((event) => (
							<code key={JSON.stringify(event)}>{eventLabel(event)}</code>
						))}
					</div>
					{comparison?.structuredDiff.files.map((file) => (
						<details className="dag-file-diff" open key={`${file.oldPath}:${file.newPath}`}>
							<summary>
								{file.newPath} · +{file.additions} −{file.deletions}
							</summary>
							{file.binary ? (
								<p>Binary file changed.</p>
							) : (
								file.hunks.map((hunk) => (
									<pre key={hunk.header}>
										{[
											hunk.header,
											...hunk.lines.map(
												(line) =>
													`${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.content}`,
											),
										].join("\n")}
									</pre>
								))
							)}
						</details>
					))}
				</article>
			</section>

			<section className="dag-decision-panel">
				<div>
					<p className="kicker">Repository-local decision</p>
					<h2>Record review outcome</h2>
					<p>
						{decisionHistory.current.length} current · {decisionHistory.outdated.length} outdated.
						Every new decision binds this whole result.
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
					<span>
						Prior whole-result decisions remain visible below but no longer bind this result.
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
		</div>
	);
}
