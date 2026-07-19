import mermaid from "mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

import fixtureSuite from "../../../fixtures/contracts/v1/golden-suite.json";
import { DagRepositoryReview, type DagReviewData } from "./DagRepositoryReview";
import { GenericRepositoryReview, type GenericReviewData } from "./GenericRepositoryReview";

interface GraphNode {
	id: string;
	name?: string;
	factory: string;
	deps: string[];
	meta?: Record<string, unknown>;
}

interface GraphEdge {
	from: string;
	to: string;
}

interface BlueprintSnapshot {
	commit: { value: string };
	semanticParent: { value: string } | null;
	topologyHash: { value: string };
	policyRevision: string;
	blueprint: {
		version: "graphrefly.blueprint.v1";
		topology: { name?: string; nodes: GraphNode[]; edges: GraphEdge[] };
		diagnostics?: { ok: boolean; issues: unknown[] };
		provenance?: Record<string, unknown>;
	};
}

interface BlueprintDelta {
	structural: {
		addedNodes: GraphNode[];
		removedNodeIds: string[];
		addedEdges: GraphEdge[];
		removedEdges: GraphEdge[];
	};
	claimImpacts: { workUnitId: string; claimId: string; impact: "none" | "affected" }[];
}

interface ReviewBlueprint {
	workUnitId: "BASE" | "U1" | "U2" | "U3";
	oid: string;
	parentOid: string | null;
	snapshot: BlueprintSnapshot;
	delta: BlueprintDelta | null;
	diagram: {
		format: "mermaid";
		source: string;
		renderer: "@graphrefly/ts/render.describeToMermaid";
	};
}

interface RawDiff {
	workUnitId: string;
	paths: string[];
	patch: string;
}

interface ReviewData {
	source: "contract-fallback" | "real-git-runtime" | "redacted-bundle";
	baseOid: string;
	commits: { workUnitId: string; oid: string }[];
	workUnits: typeof fixtureSuite.changePlan.workUnits;
	gateResult: (typeof fixtureSuite.cases)[number]["expectedGate"];
	reviewDecision: { decision: string };
	checks: typeof fixtureSuite.checks;
	rawDiffs: RawDiff[];
	blueprints: ReviewBlueprint[];
	bundleAvailable: boolean;
}

const staleCase = fixtureSuite.cases.find(
	(fixtureCase) => fixtureCase.caseId === "clean-rebase-semantic-stale",
);

if (staleCase === undefined) throw new Error("The semantic-stale contract case is missing");

const unitLabels: Record<string, string> = {
	U1: "Contracts",
	U2: "Graph runtime",
	U3: "HTTP adapter",
};

function short(value: string, size = 7): string {
	return value.slice(0, size);
}

function reasonCopy(reason: string): string {
	if (reason === "BLUEPRINT_WITNESS_STALE")
		return "This change was planned against an older GraphReFly Blueprint.";
	if (reason === "POLICY_SESSION_WRITE_REQUIRES_BROKER")
		return "The refresh persistence path bypasses the broker required by session-writes.v2.";
	if (reason === "DEPENDENCY_INVALID") return "Its required upstream runtime change is invalid.";
	return "A deterministic repository witness no longer matches this change.";
}

interface DiagramModel {
	aliases: Map<string, string>;
	edges: { fromAlias: string; toAlias: string; from: string; to: string }[];
}

function parseGraphReFlyMermaid(source: string): DiagramModel {
	const aliases = new Map<string, string>();
	const aliasedEdges: { fromAlias: string; toAlias: string }[] = [];
	for (const line of source.split("\n")) {
		const node = line.match(/^\s*([A-Za-z0-9_]+)\[("(?:\\.|[^"])*")\]\s*$/u);
		if (node?.[1] !== undefined && node[2] !== undefined) {
			aliases.set(node[1], JSON.parse(node[2]) as string);
		}
		const edge = line.match(/^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)\s*$/u);
		if (edge?.[1] !== undefined && edge[2] !== undefined) {
			aliasedEdges.push({ fromAlias: edge[1], toAlias: edge[2] });
		}
	}
	return {
		aliases,
		edges: aliasedEdges.flatMap((edge) => {
			const from = aliases.get(edge.fromAlias);
			const to = aliases.get(edge.toAlias);
			return from === undefined || to === undefined ? [] : [{ ...edge, from, to }];
		}),
	};
}

function styledGraphReFlyMermaid(blueprint: ReviewBlueprint, blockedReasons: string[]): string {
	const parsed = parseGraphReFlyMermaid(blueprint.diagram.source);
	const aliasByNode = new Map([...parsed.aliases].map(([alias, node]) => [node, alias]));
	const addedNodes =
		blueprint.delta?.structural.addedNodes
			.map((node) => aliasByNode.get(node.id))
			.filter((alias): alias is string => alias !== undefined) ?? [];
	const addedEdges = new Set(
		blueprint.delta?.structural.addedEdges.map((edge) => `${edge.from}\u0000${edge.to}`) ?? [],
	);
	const addedEdgeIndexes = parsed.edges.flatMap((edge, index) =>
		addedEdges.has(`${edge.from}\u0000${edge.to}`) ? [index] : [],
	);
	const blockedAlias = blockedReasons.includes("POLICY_SESSION_WRITE_REQUIRES_BROKER")
		? aliasByNode.get("session.persist.refresh")
		: undefined;
	const styles = [
		"classDef added fill:#dff2e8,stroke:#25845d,stroke-width:3px,color:#132f27;",
		"classDef blocked fill:#fff0ed,stroke:#c74332,stroke-width:4px,color:#4f1912;",
	];
	if (addedNodes.length > 0) styles.push(`class ${addedNodes.join(",")} added;`);
	if (blockedAlias !== undefined) styles.push(`class ${blockedAlias} blocked;`);
	if (addedEdgeIndexes.length > 0) {
		styles.push(`linkStyle ${addedEdgeIndexes.join(",")} stroke:#25845d,stroke-width:3px;`);
	}
	return `${blueprint.diagram.source}\n${styles.join("\n")}`;
}

mermaid.initialize({
	startOnLoad: false,
	securityLevel: "strict",
	theme: "base",
	fontFamily: '"SFMono-Regular", Consolas, monospace',
	themeVariables: {
		primaryColor: "#fbfcfd",
		primaryTextColor: "#18313f",
		primaryBorderColor: "#718b99",
		lineColor: "#8197a3",
	},
	flowchart: { curve: "basis", htmlLabels: false, useMaxWidth: true },
});

let diagramSequence = 0;

function nextDiagramId(): string {
	diagramSequence += 1;
	return `graphrefly-blueprint-${diagramSequence}`;
}

function mountMermaidSvg(target: HTMLDivElement, value: string): void {
	const parsed = new DOMParser().parseFromString(value, "image/svg+xml");
	const root = parsed.documentElement;
	if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") {
		throw new Error("Mermaid did not return an SVG document");
	}
	for (const unsafe of root.querySelectorAll("script, foreignObject")) unsafe.remove();
	for (const element of root.querySelectorAll("*")) {
		for (const attribute of [...element.attributes]) {
			if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
		}
	}
	target.replaceChildren(document.importNode(root, true));
}

function BlueprintDiagram({
	blueprint,
	blockedReasons,
}: {
	blueprint: ReviewBlueprint;
	blockedReasons: string[];
}) {
	const policyBlocked = blockedReasons.includes("POLICY_SESSION_WRITE_REQUIRES_BROKER");
	const [renderId] = useState(nextDiagramId);
	const output = useRef<HTMLDivElement>(null);
	const [rendering, setRendering] = useState(true);
	const [renderError, setRenderError] = useState(false);

	useEffect(() => {
		let current = true;
		setRendering(true);
		setRenderError(false);
		output.current?.replaceChildren();
		void mermaid
			.render(
				`${renderId}-${short(blueprint.oid)}`,
				styledGraphReFlyMermaid(blueprint, blockedReasons),
			)
			.then((result) => {
				if (current && output.current !== null) {
					mountMermaidSvg(output.current, result.svg);
					setRendering(false);
				}
			})
			.catch(() => {
				if (current) {
					setRendering(false);
					setRenderError(true);
				}
			});
		return () => {
			current = false;
		};
	}, [blockedReasons, blueprint, renderId]);

	return (
		<div className="diagram-stage">
			<div
				ref={output}
				className="blueprint-svg mermaid-output"
				role="img"
				aria-busy={rendering}
				aria-label={`GraphReFly Blueprint for ${blueprint.workUnitId}`}
			/>
			{rendering || renderError ? (
				<output className="diagram-status">
					{renderError
						? "GraphReFly diagram could not be rendered."
						: "Rendering GraphReFly diagram…"}
				</output>
			) : null}
			<div className="diagram-legend">
				<span>
					<i className="legend-swatch added" />
					Added in this commit
				</span>
				<span>
					<i className="legend-swatch current" />
					Existing GraphReFly node
				</span>
				{policyBlocked ? (
					<span>
						<i className="legend-swatch blocked" />
						Policy violation
					</span>
				) : null}
			</div>
			{(blueprint.delta?.structural.removedNodeIds.length ?? 0) > 0 ? (
				<p className="removed-note">
					Removed: {blueprint.delta?.structural.removedNodeIds.join(", ")}
				</p>
			) : null}
		</div>
	);
}

type DiffLine = {
	kind: "context" | "delete" | "add";
	content: string;
	oldNo?: number;
	newNo?: number;
};
type DiffHunk = { header: string; lines: DiffLine[] };
type FileDiff = {
	oldPath: string;
	newPath: string;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
};

function parsePatch(patch: string): FileDiff[] {
	const files: FileDiff[] = [];
	let file: FileDiff | undefined;
	let hunk: DiffHunk | undefined;
	let oldNo = 0;
	let newNo = 0;
	for (const line of patch.split("\n")) {
		const fileHeader = line.match(/^diff --git a\/(.+) b\/(.+)$/u);
		if (fileHeader?.[1] !== undefined && fileHeader[2] !== undefined) {
			file = {
				oldPath: fileHeader[1],
				newPath: fileHeader[2],
				hunks: [],
				additions: 0,
				deletions: 0,
			};
			files.push(file);
			hunk = undefined;
			continue;
		}
		if (file === undefined) continue;
		const hunkHeader = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
		if (hunkHeader?.[1] !== undefined && hunkHeader[2] !== undefined) {
			oldNo = Number(hunkHeader[1]);
			newNo = Number(hunkHeader[2]);
			hunk = { header: line, lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (hunk === undefined || line.startsWith("\\ No newline")) continue;
		if (line.startsWith("-")) {
			hunk.lines.push({ kind: "delete", content: line.slice(1), oldNo });
			oldNo += 1;
			file.deletions += 1;
		} else if (line.startsWith("+")) {
			hunk.lines.push({ kind: "add", content: line.slice(1), newNo });
			newNo += 1;
			file.additions += 1;
		} else if (line.startsWith(" ")) {
			hunk.lines.push({ kind: "context", content: line.slice(1), oldNo, newNo });
			oldNo += 1;
			newNo += 1;
		}
	}
	return files;
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
		const group: DiffLine[] = [];
		while (index < lines.length && lines[index]?.kind !== "context") {
			const current = lines[index];
			if (current !== undefined) group.push(current);
			index += 1;
		}
		const deleted = group.filter((entry) => entry.kind === "delete");
		const added = group.filter((entry) => entry.kind === "add");
		for (let row = 0; row < Math.max(deleted.length, added.length); row += 1) {
			rows.push({ left: deleted[row], right: added[row] });
		}
	}
	return rows;
}

function CodeDiff({ diff }: { diff: RawDiff | undefined }) {
	const files = useMemo(() => parsePatch(diff?.patch ?? ""), [diff]);
	if (diff === undefined)
		return <p className="empty-state">No real Git diff is available for this commit.</p>;
	return (
		<div className="file-diffs">
			{files.map((file) => (
				<details className="file-diff" open key={file.newPath}>
					<summary>
						<span className="file-icon">▱</span>
						<strong>{file.newPath}</strong>
						<span className="diff-stat">
							<b>+{file.additions}</b>
							<i>−{file.deletions}</i>
						</span>
					</summary>
					<div className="diff-scroll">
						<table className="split-diff">
							<tbody>
								{file.hunks.flatMap((hunk) => [
									<tr className="hunk-row" key={`${file.newPath}-${hunk.header}`}>
										<td colSpan={4}>{hunk.header}</td>
									</tr>,
									...splitRows(hunk.lines).map((row) => (
										<tr
											key={`${file.newPath}-${hunk.header}-${row.left?.oldNo ?? "x"}-${row.right?.newNo ?? "x"}-${row.left?.content ?? ""}-${row.right?.content ?? ""}`}
										>
											<td className={`line-number ${row.left?.kind === "delete" ? "delete" : ""}`}>
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
				</details>
			))}
		</div>
	);
}

function LegacyReview({ reviewData }: { reviewData: ReviewData }) {
	const [selectedUnitId, setSelectedUnitId] = useState("U2");

	const selectedUnit =
		reviewData.workUnits.find((unit) => unit.id === selectedUnitId) ?? reviewData.workUnits[0];
	const selectedGate = reviewData.gateResult.units.find(
		(unit) => unit.workUnitId === selectedUnit?.id,
	);
	const selectedCommit = reviewData.commits.find(
		(commit) => commit.workUnitId === selectedUnit?.id,
	);
	const selectedBlueprint = reviewData.blueprints.find(
		(blueprint) => blueprint.workUnitId === selectedUnit?.id,
	);
	const selectedDiff = reviewData.rawDiffs.find((diff) => diff.workUnitId === selectedUnit?.id);
	const selectedChecks = reviewData.checks.filter((check) =>
		selectedUnit?.requiredChecks.includes(check.checkId),
	);

	if (selectedUnit === undefined || selectedGate === undefined || selectedCommit === undefined) {
		throw new Error("The selected work unit is incomplete");
	}

	const structural = selectedBlueprint?.delta?.structural;
	return (
		<div className="app-shell">
			<header className="product-header">
				<div className="brand">
					<span className="brand-glyph" aria-hidden="true">
						G
					</span>
					<div>
						<strong>GraphReFly Stack</strong>
						<small>refresh-token-rotation / local repository</small>
					</div>
				</div>
				<span className="runtime-badge">
					<i />
					Real Git · GraphReFly runtime
				</span>
			</header>

			<section className="selection-heading">
				<div>
					<p className="kicker">
						{selectedUnit.id} · {unitLabels[selectedUnit.id]}
					</p>
					<h1>{selectedUnit.title}</h1>
					<p>{selectedUnit.intent}</p>
				</div>
				<div className={`gate-summary is-${selectedGate.verdict}`}>
					<span>{selectedGate.verdict === "valid" ? "Valid" : "Needs replan"}</span>
					<code>{short(selectedCommit.oid, 12)}</code>
				</div>
			</section>

			<main className="review-workbench">
				<aside className="stack-column" aria-label="Git stack">
					<div className="column-heading">
						<span>Git stack</span>
						<small>0 text conflicts</small>
					</div>
					<div className="commit-stack">
						{[...reviewData.workUnits].reverse().map((unit) => {
							const gate = reviewData.gateResult.units.find(
								(entry) => entry.workUnitId === unit.id,
							);
							const commit = reviewData.commits.find((entry) => entry.workUnitId === unit.id);
							const blueprint = reviewData.blueprints.find((entry) => entry.workUnitId === unit.id);
							if (gate === undefined || commit === undefined) return null;
							return (
								<button
									className={`commit-card ${unit.id === selectedUnit.id ? "is-selected" : ""}`}
									type="button"
									onClick={() => setSelectedUnitId(unit.id)}
									key={unit.id}
								>
									<span className={`commit-dot is-${gate.verdict}`} />
									<span className="commit-main">
										<strong>
											{unit.id} · {unitLabels[unit.id]}
										</strong>
										<small>
											{short(commit.oid)} · {unit.title}
										</small>
									</span>
									<span className="commit-meta">
										<b>{gate.verdict === "valid" ? "Valid" : "Blocked"}</b>
										<small>
											BP {blueprint ? short(blueprint.snapshot.topologyHash.value) : "—"}
										</small>
									</span>
								</button>
							);
						})}
						<div className="base-commit">
							<span className="base-square" />
							<div>
								<strong>{short(reviewData.baseOid)} · A1</strong>
								<small>Session broker architecture</small>
							</div>
						</div>
					</div>
				</aside>

				<section className="blueprint-column" aria-labelledby="blueprint-title">
					<div className="column-heading blueprint-heading">
						<div>
							<span>GraphReFly Blueprint</span>
							<small id="blueprint-title">
								{selectedBlueprint
									? `Generated at ${short(selectedBlueprint.oid)}`
									: "Runtime data required"}
							</small>
						</div>
						{selectedBlueprint ? (
							<code>
								{selectedBlueprint.diagram.renderer.replace("@graphrefly/ts/render.", "")}
							</code>
						) : null}
					</div>
					{selectedBlueprint ? (
						<BlueprintDiagram
							blueprint={selectedBlueprint}
							blockedReasons={selectedGate.reasonCodes}
						/>
					) : (
						<p className="empty-state">
							Start the review command with a real fixture to generate the Blueprint diagram.
						</p>
					)}
					<div className="delta-bar">
						<div>
							<span>Parent delta</span>
							<strong>
								{structural
									? `${structural.addedNodes.length} nodes added · ${structural.addedEdges.length} edges added`
									: "Architecture base"}
							</strong>
						</div>
						<div>
							<span>Policy</span>
							<strong>{selectedBlueprint?.snapshot.policyRevision ?? "—"}</strong>
						</div>
						<div>
							<span>Gate</span>
							<strong>
								{selectedGate.reasonCodes.length === 0
									? "No blocking reasons"
									: `${selectedGate.reasonCodes.length} blocking reasons`}
							</strong>
						</div>
					</div>
					{selectedGate.reasonCodes.length > 0 ? (
						<div className="reason-list">
							{selectedGate.reasonCodes.map((reason) => (
								<div key={reason}>
									<strong>{reason}</strong>
									<span>{reasonCopy(reason)}</span>
								</div>
							))}
						</div>
					) : null}
				</section>
			</main>

			<section className="code-review" aria-labelledby="code-title">
				<div className="section-heading">
					<div>
						<p className="kicker">Code changes</p>
						<h2 id="code-title">{selectedDiff?.paths.length ?? 0} files changed</h2>
					</div>
					<span className="compare-label">Split diff · parent ↔ {selectedUnit.id}</span>
				</div>
				<CodeDiff diff={selectedDiff} />
			</section>

			<section className="secondary-details">
				<details>
					<summary>
						<span>Change contract</span>
						<small>Scope, dependency, and claim</small>
					</summary>
					<div className="detail-grid">
						<div>
							<span>Depends on</span>
							<strong>{selectedUnit.dependencies.join(", ") || "Nothing"}</strong>
						</div>
						<div>
							<span>Allowed files</span>
							<strong>{selectedUnit.allowedSourceScopes.join(" · ")}</strong>
						</div>
						<div>
							<span>Blueprint claim</span>
							<strong>
								{selectedUnit.blueprintClaims.map((claim) => claim.id).join(", ") ||
									"No structural claim"}
							</strong>
						</div>
					</div>
				</details>
				<details>
					<summary>
						<span>Checks and review state</span>
						<small>Deterministic evidence</small>
					</summary>
					<div className="check-grid">
						{selectedChecks.map((check) => (
							<div key={check.checkId}>
								<i />
								<strong>{check.checkId}</strong>
								<code>
									exit {check.exitCode} · {short(check.stdoutDigest.value)}
								</code>
							</div>
						))}
						<div>
							<i className="neutral" />
							<strong>Human review</strong>
							<code>{reviewData.reviewDecision.decision}</code>
						</div>
					</div>
				</details>
				{reviewData.bundleAvailable ? (
					<a className="bundle-link" href="/api/evidence-bundle" download>
						Download evidence bundle
					</a>
				) : null}
			</section>
		</div>
	);
}

type RuntimeReview = ReviewData | GenericReviewData | DagReviewData;

export function App() {
	const [reviewData, setReviewData] = useState<RuntimeReview | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/review-data", { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`Review data unavailable (${response.status})`);
				return response.json() as Promise<RuntimeReview>;
			})
			.then(setReviewData)
			.catch((reason: unknown) => {
				if (!(reason instanceof DOMException && reason.name === "AbortError")) {
					setError(reason instanceof Error ? reason.message : "Review data unavailable");
				}
			});
		return () => controller.abort();
	}, []);

	if (error !== null) {
		return <main className="load-state is-error">{error}</main>;
	}
	if (reviewData === null) {
		return <main className="load-state">Loading repository review…</main>;
	}
	if ("schema" in reviewData && reviewData.schema === "graphrefly.stack.review.v1") {
		return <GenericRepositoryReview review={reviewData} />;
	}
	if ("schema" in reviewData && reviewData.schema === "graphrefly.stack.dag-review-evidence.v2") {
		return <DagRepositoryReview review={reviewData} />;
	}
	return <LegacyReview reviewData={reviewData as ReviewData} />;
}
