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
		graphreflyVersion: string;
		entrypoint: string;
		baseOid: string;
		headOid: string;
	};
	base: Revision;
	commits: ReviewCommit[];
	semanticStatus: "not-configured";
}

function short(value: string, size = 8): string {
	return value.slice(0, size);
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
	const selected = review.commits.find((commit) => commit.oid === selectedOid) ?? review.commits[0];
	if (selected === undefined) throw new Error("Repository review contains no commits");
	const events = selected.delta.events ?? [];
	const hash = selected.blueprint.hash?.value ?? "unavailable";
	const diagnosticCount = selected.blueprint.diagnostics?.issues?.length ?? 0;

	return (
		<div className="app-shell generic-review">
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
				<span className="runtime-badge">
					<i />
					Real Git · @graphrefly/ts {review.repository.graphreflyVersion}
				</span>
			</header>

			<section className="selection-heading">
				<div>
					<p className="kicker">
						Commit {short(selected.oid, 12)} · Blueprint {short(hash, 12)}
					</p>
					<h1>{selected.subject}</h1>
					<p>
						One Git commit, its GraphReFly-generated Blueprint delta, and its exact parent diff.
					</p>
				</div>
				<div className="gate-summary is-neutral">
					<span>Semantic gate not configured</span>
					<code>evidence only</code>
				</div>
			</section>

			<main className="review-workbench">
				<aside className="stack-column" aria-label="Git stack">
					<div className="column-heading">
						<span>Git stack</span>
						<small>{review.commits.length} linear commits</small>
					</div>
					<div className="commit-stack">
						{[...review.commits].reverse().map((commit) => (
							<button
								className={`commit-card ${commit.oid === selected.oid ? "is-selected" : ""}`}
								type="button"
								aria-pressed={commit.oid === selected.oid}
								onClick={() => setSelectedOid(commit.oid)}
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
									<small>BP {short(commit.blueprint.hash?.value ?? "—")}</small>
								</span>
							</button>
						))}
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
						<code>blueprintToMermaid</code>
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

			<section className="code-review" aria-labelledby="code-title">
				<div className="section-heading">
					<div>
						<p className="kicker">Code changes</p>
						<h2 id="code-title">{selected.diff.paths.length} files changed</h2>
					</div>
					<span className="compare-label">
						Split diff · {short(selected.parentOid)} ↔ {short(selected.oid)}
					</span>
				</div>
				<StructuredCodeDiff files={selected.diff.files} />
			</section>

			<section className="secondary-details generic-details">
				<details>
					<summary>
						<span>Repository evidence</span>
						<small>Expandable provenance</small>
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
					</div>
				</details>
				<details>
					<summary>
						<span>Commit lineage</span>
						<small>Expandable Git identity</small>
					</summary>
					<div className="detail-grid">
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
					</div>
				</details>
			</section>
		</div>
	);
}
