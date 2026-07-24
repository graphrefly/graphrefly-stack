import mermaid from "mermaid";
import { useEffect, useMemo, useRef, useState } from "react";

export type DiffLine = {
	kind: "context" | "delete" | "add";
	content: string;
	oldNo?: number;
	newNo?: number;
};

export type FileDiff = {
	oldPath: string;
	newPath: string;
	additions: number;
	deletions: number;
	binary: boolean;
	hunks: { header: string; lines: DiffLine[] }[];
};

export type BlueprintEvent = {
	type?: string;
	topologyPath?: string[];
	node?: { id?: string };
	before?: { id?: string };
	after?: { id?: string };
	edge?: { from?: string; to?: string };
};

type BlueprintDiagramProps = {
	oid: string;
	source: string;
	events?: BlueprintEvent[];
};

function short(value: string, size = 8): string {
	return value.slice(0, size);
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

function styledDiagram(source: string, events: BlueprintEvent[]): string {
	const aliases = mermaidAliases(source);
	const added = new Set(
		events
			.filter((event) => event.type === "node-added")
			.map((event) => event.node?.id)
			.filter((id): id is string => id !== undefined),
	);
	const changed = new Set(
		events
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
	return `${source}\n${styles.join("\n")}`;
}

let diagramId = 0;

export function BlueprintDiagram({ oid, source, events = [] }: BlueprintDiagramProps) {
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
			.render(`${id}-${short(oid)}`, styledDiagram(source, events))
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
				for (const unsafe of root.querySelectorAll("script, iframe, object, embed")) {
					unsafe.remove();
				}
				for (const element of root.querySelectorAll("*")) {
					for (const attribute of [...element.attributes]) {
						if (attribute.name.toLowerCase().startsWith("on")) {
							element.removeAttribute(attribute.name);
						}
					}
				}
				output.current.replaceChildren(document.importNode(root, true));
				setStatus("ready");
			})
			.catch(() => current && setStatus("error"));
		return () => {
			current = false;
		};
	}, [events, id, oid, source]);

	return (
		<div className="diagram-stage">
			<div
				ref={output}
				className="blueprint-svg mermaid-output"
				role="img"
				aria-label={`GraphReFly Blueprint at ${short(oid)}`}
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

export function StructuredCodeDiff({ files }: { files: FileDiff[] }) {
	if (files.length === 0) {
		return <p className="empty-state">This comparison has no textual file diff.</p>;
	}
	return (
		<div className="file-diffs">
			{files.map((file) => (
				<details className="file-diff" open key={`${file.oldPath}:${file.newPath}`}>
					<summary>
						<span className="file-icon" aria-hidden="true">
							▱
						</span>
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
