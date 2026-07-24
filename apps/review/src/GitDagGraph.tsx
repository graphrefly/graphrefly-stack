type Oid = { algorithm: "sha1" | "sha256"; value: string };

export type GitDagObject = {
	oid: Oid;
	parents: Oid[];
	layer: number;
	kind: "implementation" | "transport" | "join";
	workUnitId: string | null;
};

type GitDagEdge = { from: Oid; to: Oid; parentIndex: number };
type SemanticEdge = { fromWorkUnitId: string; toWorkUnitId: string };

export type GitGraphRow = {
	oid: Oid;
	parents: Oid[];
	lane: number;
	kind: GitDagObject["kind"] | "base";
	workUnitId: string | null;
};

export type GitGraphLayout = {
	rows: GitGraphRow[];
	laneCount: number;
};

function oidKey(oid: Oid): string {
	return `${oid.algorithm}:${oid.value}`;
}

export function buildGitGraphLayout(options: {
	base: Oid;
	head: Oid;
	objects: GitDagObject[];
}): GitGraphLayout {
	const originalOrder = new Map(
		options.objects.map((object, index) => [oidKey(object.oid), index] as const),
	);
	const ordered = [...options.objects].sort(
		(left, right) =>
			right.layer - left.layer ||
			(originalOrder.get(oidKey(right.oid)) ?? 0) - (originalOrder.get(oidKey(left.oid)) ?? 0),
	);
	const active = [oidKey(options.head)];
	const rows: GitGraphRow[] = [];
	let laneCount = 1;

	for (const object of ordered) {
		const currentKey = oidKey(object.oid);
		let lane = active.indexOf(currentKey);
		if (lane < 0) {
			lane = active.length;
			active.push(currentKey);
		}
		rows.push({ ...object, lane });
		const parentKeys = object.parents.map(oidKey);
		const currentActive = [...active];
		for (const parentKey of parentKeys) {
			const existing = currentActive.indexOf(parentKey);
			if (existing >= 0 && existing !== lane) currentActive.splice(existing, 1);
		}
		if (parentKeys.length === 0) {
			currentActive.splice(lane, 1);
		} else {
			currentActive[lane] = parentKeys[0] as string;
			for (let parentIndex = 1; parentIndex < parentKeys.length; parentIndex += 1) {
				const parentKey = parentKeys[parentIndex] as string;
				if (!currentActive.includes(parentKey)) {
					currentActive.splice(lane + parentIndex, 0, parentKey);
				}
			}
		}
		active.splice(0, active.length, ...currentActive);
		laneCount = Math.max(laneCount, lane + 1, active.length);
	}

	const baseKey = oidKey(options.base);
	const baseLane = Math.max(0, active.indexOf(baseKey));
	rows.push({
		oid: options.base,
		parents: [],
		lane: baseLane,
		kind: "base",
		workUnitId: null,
	});
	laneCount = Math.max(laneCount, baseLane + 1);
	return { rows, laneCount };
}

function short(value: string, size = 8): string {
	return value.slice(0, size);
}

export function GitDagGraph({
	base,
	head,
	objects,
	gitEdges,
	semanticEdges,
	subjects,
	selectedOid,
	onSelect,
}: {
	base: Oid;
	head: Oid;
	objects: GitDagObject[];
	gitEdges: GitDagEdge[];
	semanticEdges: SemanticEdge[];
	subjects: Map<string, string>;
	selectedOid?: Oid;
	onSelect: (object: GitDagObject) => void;
}) {
	const layout = buildGitGraphLayout({ base, head, objects });
	const rowByOid = new Map(layout.rows.map((row, index) => [oidKey(row.oid), { row, index }]));
	const objectByOid = new Map(objects.map((object) => [oidKey(object.oid), object]));
	const objectByWorkUnit = new Map(
		objects.flatMap((object) =>
			object.workUnitId === null ? [] : [[object.workUnitId, object] as const],
		),
	);
	const rowHeight = 76;
	const laneWidth = 18;
	const graphInset = 18;
	const graphWidth = graphInset * 2 + layout.laneCount * laneWidth;
	const graphHeight = layout.rows.length * rowHeight;
	const coordinate = (oid: Oid) => {
		const entry = rowByOid.get(oidKey(oid));
		return entry === undefined
			? undefined
			: {
					x: graphInset + entry.row.lane * laneWidth,
					y: entry.index * rowHeight + rowHeight / 2,
				};
	};
	const path = (from: Oid, to: Oid) => {
		const start = coordinate(from);
		const end = coordinate(to);
		if (start === undefined || end === undefined) return undefined;
		const middle = (start.y + end.y) / 2;
		return `M ${start.x} ${start.y} C ${start.x} ${middle}, ${end.x} ${middle}, ${end.x} ${end.y}`;
	};

	return (
		<div className="git-dag-scroll">
			<div
				className="git-dag-graph"
				style={{ minHeight: graphHeight, paddingLeft: graphWidth + 8 }}
			>
				<svg
					className="git-dag-lines"
					width={graphWidth}
					height={graphHeight}
					viewBox={`0 0 ${graphWidth} ${graphHeight}`}
					aria-hidden="true"
				>
					{gitEdges.map((edge) => {
						const d = path(edge.from, edge.to);
						return d === undefined ? null : (
							<path
								className={`git-parent-edge parent-${edge.parentIndex + 1}`}
								d={d}
								key={`${oidKey(edge.from)}:${oidKey(edge.to)}:${edge.parentIndex}`}
							/>
						);
					})}
					{semanticEdges.map((edge) => {
						const from = objectByWorkUnit.get(edge.fromWorkUnitId);
						const to = objectByWorkUnit.get(edge.toWorkUnitId);
						const d = from === undefined || to === undefined ? undefined : path(from.oid, to.oid);
						return d === undefined ? null : (
							<path
								className="semantic-dependency-edge"
								d={d}
								key={`${edge.fromWorkUnitId}:${edge.toWorkUnitId}`}
							/>
						);
					})}
					{layout.rows.map((row, index) => (
						<g
							className={`git-dag-marker is-${row.kind}`}
							key={oidKey(row.oid)}
							transform={`translate(${graphInset + row.lane * laneWidth} ${index * rowHeight + rowHeight / 2})`}
						>
							{row.kind === "base" ? (
								<rect x="-5" y="-5" width="10" height="10" />
							) : (
								<circle r="6" />
							)}
						</g>
					))}
				</svg>
				{layout.rows.map((row) => {
					const object = objectByOid.get(oidKey(row.oid));
					const selected = selectedOid !== undefined && oidKey(selectedOid) === oidKey(row.oid);
					const content = (
						<>
							<span className="git-dag-kind">{row.kind}</span>
							<strong>{row.workUnitId ?? short(row.oid.value)}</strong>
							<small>
								{subjects.get(oidKey(row.oid)) ?? (row.kind === "base" ? "Range base" : "")}
							</small>
						</>
					);
					return object === undefined || object.kind === "transport" ? (
						<div className="git-dag-row is-passive" key={oidKey(row.oid)}>
							{content}
						</div>
					) : (
						<button
							className={`git-dag-row ${selected ? "is-selected" : ""}`}
							type="button"
							aria-pressed={selected}
							onClick={() => onSelect(object)}
							key={oidKey(row.oid)}
						>
							{content}
						</button>
					);
				})}
			</div>
		</div>
	);
}
