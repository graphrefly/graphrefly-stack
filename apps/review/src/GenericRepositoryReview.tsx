import mermaid from "mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

type DiffLine = {
	kind: "context" | "delete" | "add";
	content: string;
	oldNo?: number;
	newNo?: number;
};

type FileDiff = {
	oldPath: string;
	newPath: string;
	additions: number;
	deletions: number;
	binary: boolean;
	hunks: { header: string; lines: DiffLine[] }[];
};

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
		events?: Array<{
			type?: string;
			topologyPath?: string[];
			node?: { id?: string };
			before?: { id?: string };
			after?: { id?: string };
			edge?: { from?: string; to?: string };
		}>;
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

type RepositoryReviewDecision = {
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

function splitRows(lines: DiffLine[]) {
	const rows: { left?: DiffLine; right?: DiffLine }[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (line?.kind === "context") {
			rows.push({ left: line, right: line });
			index += 1;
			continue;
		}
		const changed: DiffLine[] = [];
		while (index < lines.length && lines[index]?.kind !== "context") {
			const current = lines[index];
			if (current !== undefined) changed.push(current);
			index += 1;
		}
		const deleted = changed.filter((entry) => entry.kind === "delete");
		const added = changed.filter((entry) => entry.kind === "add");
		for (let row = 0; row < Math.max(deleted.length, added.length); row += 1) {
			rows.push({ left: deleted[row], right: added[row] });
		}
	}
	return rows;
}

function StructuredCodeDiff({ files }: { files: FileDiff[] }) {
	if (files.length === 0)
		return <p className="empty-state">This commit has no textual file diff.</p>;
	return (
		<div className="file-diffs">
			{files.map((file) => (
				<details className="file-diff" open key={`${file.oldPath}:${file.newPath}`}>
					<summary>
						<span className="file-icon">▱</span>
						<strong>{file.newPath}</strong>
						<span className="diff-stat">
							<b>+{file.additions}</b>
							<i>−{file.deletions}</i>
						</span>
					</summary>
					{file.binary ? (
						<p className="empty-state">Binary file changed.</p>
					) : (
						<div className="diff-scroll">
							<table className="split-diff">
								<colgroup>
									<col className="number-column" />
									<col className="code-column" />
									<col className="number-column" />
									<col className="code-column" />
								</colgroup>
								<tbody>
									{file.hunks.flatMap((hunk) => [
										<tr className="hunk-row" key={`${file.newPath}-${hunk.header}`}>
											<td colSpan={4}>{hunk.header}</td>
										</tr>,
										...splitRows(hunk.lines).map((row) => (
											<tr
												key={`${hunk.header}-${row.left?.oldNo ?? "x"}-${row.right?.newNo ?? "x"}-${row.left?.kind ?? "x"}-${row.left?.content ?? ""}-${row.right?.kind ?? "x"}-${row.right?.content ?? ""}`}
											>
												<td
													className={`line-number ${row.left?.kind === "delete" ? "delete" : ""}`}
												>
													{row.left?.oldNo ?? ""}
												</td>
												<td
													className={`code-line ${row.left?.kind === "delete" ? "delete" : row.left ? "context" : "empty"}`}
												>
													<span>{row.left?.kind === "delete" ? "−" : " "}</span>
													{row.left?.content ?? ""}
												</td>
												<td className={`line-number ${row.right?.kind === "add" ? "add" : ""}`}>
													{row.right?.newNo ?? ""}
												</td>
												<td
													className={`code-line ${row.right?.kind === "add" ? "add" : row.right ? "context" : "empty"}`}
												>
													<span>{row.right?.kind === "add" ? "+" : " "}</span>
													{row.right?.content ?? ""}
												</td>
											</tr>
										)),
									])}
								</tbody>
							</table>
						</div>
					)}
				</details>
			))}
		</div>
	);
}

function decisionLabel(decision: RepositoryReviewDecision | undefined): string {
	if (decision?.decision === "approve") return "Approved";
	if (decision?.decision === "request-changes") return "Changes requested";
	return "Not reviewed";
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
							It records your local review of that exact commit and Blueprint in Git-scoped
							metadata. It does not change a semantic check, approve a GitHub pull request, or merge
							code. Export reviews only when you want to share them.
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
	current?: RepositoryReviewDecision;
	onClose: () => void;
	onSaved: (record: RepositoryReviewDecision) => void;
}) {
	const [reviewerLabel, setReviewerLabel] = useState(current?.reviewerLabel ?? "");
	const [summary, setSummary] = useState(current?.summary ?? "");
	const [saving, setSaving] = useState<RepositoryReviewDecision["decision"] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const save = async (decision: RepositoryReviewDecision["decision"]) => {
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
					schema: "graphrefly.stack.repository-review-decision-request.v1",
					commitOid: commit.oid,
					decision,
					reviewerLabel,
					summary,
				}),
			});
			if (!response.ok) {
				const message = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(message?.message ?? `Review could not be saved (${response.status})`);
			}
			onSaved((await response.json()) as RepositoryReviewDecision);
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
					<h3 id="review-panel-title">Review {short(commit.oid, 12)}</h3>
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

function mermaidAliases(source: string): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const line of source.split("\n")) {
		const node = line.match(/^\s*([A-Za-z0-9_]+)\[("(?:\\.|[^"])*")\]\s*$/u);
		if (node?.[1] !== undefined && node[2] !== undefined) {
			aliases.set(JSON.parse(node[2]) as string, node[1]);
		}
	}
	return aliases;
}

function styledDiagram(commit: ReviewCommit): string {
	const aliases = mermaidAliases(commit.diagram.source);
	const added = new Set(
		(commit.delta.events ?? [])
			.filter((event) => event.type === "node-added")
			.map((event) => event.node?.id)
			.filter((id): id is string => id !== undefined),
	);
	const changed = new Set(
		(commit.delta.events ?? [])
			.filter((event) => event.type === "node-changed")
			.map((event) => event.after?.id ?? event.before?.id)
			.filter((id): id is string => id !== undefined),
	);
	const addedAliases = [...added].flatMap((id) =>
		aliases.has(id) ? [aliases.get(id) as string] : [],
	);
	const changedAliases = [...changed].flatMap((id) =>
		aliases.has(id) ? [aliases.get(id) as string] : [],
	);
	const styles = [
		"classDef added fill:#daf1e4,stroke:#247358,stroke-width:3px,color:#162a38;",
		"classDef changed fill:#fff1cf,stroke:#9a6916,stroke-width:3px,color:#392b12;",
	];
	if (addedAliases.length > 0) styles.push(`class ${addedAliases.join(",")} added;`);
	if (changedAliases.length > 0) styles.push(`class ${changedAliases.join(",")} changed;`);
	return `${commit.diagram.source}\n${styles.join("\n")}`;
}

let diagramId = 0;

function BlueprintDiagram({ commit }: { commit: ReviewCommit }) {
	const output = useRef<HTMLDivElement>(null);
	const [status, setStatus] = useState<"rendering" | "ready" | "error">("rendering");
	const id = useMemo(() => {
		diagramId += 1;
		return `repository-blueprint-${diagramId}`;
	}, []);

	useEffect(() => {
		let current = true;
		setStatus("rendering");
		output.current?.replaceChildren();
		void mermaid
			.render(`${id}-${short(commit.oid)}`, styledDiagram(commit))
			.then(({ svg }) => {
				if (!current || output.current === null) return;
				const document = new DOMParser().parseFromString(svg, "image/svg+xml");
				const root = document.documentElement;
				if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") {
					throw new Error("Renderer did not return SVG");
				}
				for (const label of root.querySelectorAll("foreignObject")) {
					const width = Number(label.getAttribute("width") ?? "0");
					const height = Number(label.getAttribute("height") ?? "0");
					const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
					text.setAttribute("x", String(width / 2));
					text.setAttribute("y", String(height / 2));
					text.setAttribute("text-anchor", "middle");
					text.setAttribute("dominant-baseline", "central");
					text.setAttribute("fill", "#162a38");
					text.textContent = label.textContent?.trim() ?? "";
					label.replaceWith(text);
				}
				for (const unsafe of root.querySelectorAll("script, iframe, object, embed"))
					unsafe.remove();
				for (const element of root.querySelectorAll("*")) {
					for (const attribute of [...element.attributes]) {
						if (attribute.name.toLowerCase().startsWith("on"))
							element.removeAttribute(attribute.name);
					}
				}
				output.current.replaceChildren(document.importNode(root, true));
				setStatus("ready");
			})
			.catch(() => current && setStatus("error"));
		return () => {
			current = false;
		};
	}, [commit, id]);

	return (
		<div className="diagram-stage">
			<div
				ref={output}
				className="blueprint-svg mermaid-output"
				role="img"
				aria-label={`GraphReFly Blueprint at ${short(commit.oid)}`}
			/>
			{status !== "ready" ? (
				<output className="diagram-status">
					{status === "error"
						? "Blueprint diagram could not be rendered."
						: "Rendering GraphReFly Blueprint…"}
				</output>
			) : null}
			<div className="diagram-legend">
				<span>
					<i className="legend-swatch added" />
					Added node
				</span>
				<span>
					<i className="legend-swatch changed" />
					Changed node
				</span>
				<span>
					<i className="legend-swatch current" />
					Existing node
				</span>
			</div>
		</div>
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
	const [decisions, setDecisions] = useState<RepositoryReviewDecision[]>([]);
	const [reviewStateError, setReviewStateError] = useState<string | null>(null);
	const selected = review.commits.find((commit) => commit.oid === selectedOid) ?? review.commits[0];
	if (selected === undefined) throw new Error("Repository review contains no commits");
	const events = selected.delta.events ?? [];
	const hash = selected.blueprint.hash?.value ?? "unavailable";
	const diagnosticCount = selected.blueprint.diagnostics?.issues?.length ?? 0;
	const latestDecision = (commitOid: string) =>
		[...decisions].reverse().find((decision) => decision.target.commitOid === commitOid);
	const currentDecision = latestDecision(selected.oid);
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
				return response.json() as Promise<RepositoryReviewDecision[]>;
			})
			.then(setDecisions)
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
						<span>Structure available</span>
						<code>Readiness needs an accepted intent</code>
					</div>
				) : (
					<div
						className={`gate-summary ${review.semantic.gateResult.verdict === "pass" ? "is-valid" : "is-invalid"}`}
					>
						<span>
							{review.semantic.gateResult.verdict === "pass"
								? "Ready to review"
								: "Needs attention"}
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
							const commitDecision = latestDecision(commit.oid);
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
									<span
										className={`commit-dot ${commitDecision?.decision === "approve" ? "is-valid" : commitDecision?.decision === "request-changes" ? "is-invalid" : "is-evidence"}`}
									/>
									<span className="commit-main">
										<strong>{commit.subject}</strong>
										<small>
											{short(commit.oid)} · {commit.diff.paths.length} files
										</small>
									</span>
									<span className="commit-meta">
										<b>{commit.delta.events?.length ?? 0} graph Δ</b>
										<small>{decisionLabel(commitDecision)}</small>
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
					<BlueprintDiagram commit={selected} />
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
							{decisionLabel(currentDecision)}
						</span>
						<span className="compare-label">
							{short(selected.parentOid)} ↔ {short(selected.oid)}
						</span>
						<button
							className="review-button"
							type="button"
							onClick={() => setReviewOpen((open) => !open)}
						>
							{currentDecision === undefined ? "Review changes" : "Update review"}
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
							setDecisions((current) => [...current, record]);
							setReviewStateError(null);
						}}
					/>
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
						{decisions.length > 0 ? (
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
