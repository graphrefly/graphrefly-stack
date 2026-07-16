import { useEffect, useMemo, useState } from "react";

import fixtureSuite from "../../../fixtures/contracts/v1/golden-suite.json";

function required<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

const contractCase = required(
	fixtureSuite.cases.find((fixtureCase) => fixtureCase.caseId === "clean-rebase-semantic-stale"),
	"The semantic-stale golden case is missing",
);

const contractDelta = required(
	fixtureSuite.deltas[contractCase.deltaIndex],
	"The semantic-stale Blueprint delta is missing",
);

interface ReviewData {
	source: "contract-fallback" | "real-git-runtime" | "redacted-bundle";
	caseId: string;
	baseOid: string;
	commits: { workUnitId: string; oid: string }[];
	workUnits: typeof fixtureSuite.changePlan.workUnits;
	gateResult: typeof contractCase.expectedGate;
	delta: typeof contractDelta;
	reviewDecision: { decision: string; reviewerLabel?: string; identityVerified?: boolean };
	checks: typeof fixtureSuite.checks;
	rawDiffs: {
		schema: "urn:graphrefly-stack:schema:raw-diff:v1";
		workUnitId: string;
		commit: { algorithm: string; value: string };
		paths: string[];
		patch: string;
	}[];
	manifest: null | {
		runId: string;
		model: { source: string; id: string; reasoningEffort: string };
		promptVersion: string;
		artifactCount: number;
	};
	bundleAvailable: boolean;
}

const contractReviewData: ReviewData = {
	source: "contract-fallback",
	caseId: contractCase.caseId,
	baseOid: "contract-only",
	commits: fixtureSuite.changePlan.workUnits.map((unit, index) => ({
		workUnitId: unit.id,
		oid: required(fixtureSuite.stack.commits[index + 1], "Contract commit is missing").oid.value,
	})),
	workUnits: fixtureSuite.changePlan.workUnits,
	gateResult: contractCase.expectedGate,
	delta: contractDelta,
	reviewDecision: contractCase.reviewDecision,
	checks: fixtureSuite.checks,
	rawDiffs: [],
	manifest: null,
	bundleAvailable: false,
};

const unitLabels: Record<string, string> = {
	U1: "Contracts",
	U2: "Runtime",
	U3: "HTTP adapter",
};

function shortOid(value: string): string {
	return value.slice(0, 7);
}

function statusLabel(verdict: string): string {
	return verdict === "valid" ? "Valid" : "Needs replan";
}

function reasonExplanation(reason: string): string {
	if (reason === "DEPENDENCY_INVALID") return "Its required upstream work unit is invalid.";
	if (reason === "BLUEPRINT_WITNESS_STALE")
		return "The accepted architecture witness predates the current GraphBlueprint.";
	if (reason === "POLICY_SESSION_WRITE_REQUIRES_BROKER")
		return "session-writes.v2 requires the mutation to pass through sessionMutationBroker.";
	return "The accepted record no longer matches a deterministic repository witness.";
}

export function App() {
	const [reviewData, setReviewData] = useState<ReviewData>(contractReviewData);
	const [selectedUnitId, setSelectedUnitId] = useState("U2");
	const [reviewDraft, setReviewDraft] = useState<"defer" | "request-replan">("defer");
	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/review-data", { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`Review data unavailable: ${response.status}`);
				return response.json() as Promise<ReviewData>;
			})
			.then(setReviewData)
			.catch((error: unknown) => {
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					console.info("Using the checked-in contract fallback; run review with runtime evidence.");
				}
			});
		return () => controller.abort();
	}, []);
	const selectedUnit = useMemo(
		() =>
			reviewData.workUnits.find((unit) => unit.id === selectedUnitId) ?? reviewData.workUnits[0],
		[reviewData, selectedUnitId],
	);
	const selectedGate = reviewData.gateResult.units.find(
		(unit) => unit.workUnitId === selectedUnit?.id,
	);
	const selectedImpact = reviewData.delta.claimImpacts.find(
		(impact) => impact.workUnitId === selectedUnit?.id,
	);
	const selectedDiff = reviewData.rawDiffs.find(
		(rawDiff) => rawDiff.workUnitId === selectedUnit?.id,
	);
	const selectedChecks = reviewData.checks.filter((check) =>
		selectedUnit?.requiredChecks.includes(check.checkId),
	);
	const addedNode = reviewData.delta.structural.addedNodes[0];
	const incomingEdge = reviewData.delta.structural.addedEdges.find(
		(edge) => edge.to === addedNode?.id,
	);
	const outgoingEdge = reviewData.delta.structural.addedEdges.find(
		(edge) => edge.from === addedNode?.id,
	);

	if (selectedUnit === undefined || selectedGate === undefined) {
		throw new Error("The selected fixture work unit is incomplete");
	}

	return (
		<div className="app-shell">
			<header className="masthead">
				<div className="brand-lockup">
					<div className="brand-mark" aria-hidden="true">
						<span />
						<span />
					</div>
					<div>
						<p className="eyebrow">GraphReFly Stack / local review</p>
						<p className="brand-name">Semantic validity above Git</p>
					</div>
				</div>
				<div className="mode-chip">
					<span className="mode-dot" />
					{reviewData.manifest?.model.source === "codex"
						? `${reviewData.manifest.model.id} · ${reviewData.manifest.model.reasoningEffort}`
						: "Deterministic replay"}
				</div>
			</header>

			<section className="thesis" aria-labelledby="page-title">
				<div>
					<p className="section-code">CASE 02 · CLEAN REBASE / STALE WITNESS</p>
					<h1 id="page-title">Git is clean. The plan is not.</h1>
				</div>
				<p className="thesis-copy">
					The stack rebased without a text conflict, but the session-write architecture changed
					under U2. Select a work unit to inspect the exact deterministic reason.
				</p>
			</section>

			<div className="proof-strip" role="note">
				<span>STACK-7 synchronized review</span>
				<span>Source: {reviewData.source}</span>
				<span>
					{reviewData.source === "contract-fallback"
						? "Contract OIDs only"
						: "Real Git objects · computed GateResult"}
				</span>
			</div>

			<nav className="review-path" aria-label="90-second review path">
				<span>90-second path</span>
				<a href="#stack-title">1 · Select commit</a>
				<a href="#blueprint-title">2 · Read impact</a>
				<a href="#gate-title">3 · Verify gate</a>
				<a href="#evidence-title">4 · Inspect evidence</a>
			</nav>

			<main className="workbench">
				<section className="panel stack-panel" aria-labelledby="stack-title">
					<div className="panel-heading">
						<div>
							<p className="section-code">GIT STACK</p>
							<h2 id="stack-title">Rebased lineage</h2>
						</div>
						<span className="quiet-label">0 conflicts</span>
					</div>

					<div className="commit-list">
						{reviewData.workUnits.map((unit, index) => {
							const gate = reviewData.gateResult.units[index];
							const commit = reviewData.commits[index];
							if (gate === undefined || commit === undefined) return null;
							const selected = unit.id === selectedUnit.id;
							return (
								<button
									className={`commit-row ${selected ? "is-selected" : ""}`}
									type="button"
									onClick={() => setSelectedUnitId(unit.id)}
									aria-pressed={selected}
									key={unit.id}
								>
									<span className={`commit-node status-${gate.verdict}`} aria-hidden="true" />
									<span className="commit-copy">
										<strong>
											{unit.id} · {unitLabels[unit.id]}
										</strong>
										<small>
											{shortOid(commit.oid)} · {unit.title}
										</small>
									</span>
									<span className={`verdict-pill status-${gate.verdict}`}>
										{statusLabel(gate.verdict)}
									</span>
								</button>
							);
						})}
						<div className="base-row">
							<span className="base-node" />
							<span>
								<strong>{shortOid(reviewData.baseOid)} · session broker policy</strong>
								<small>Concurrent architecture change</small>
							</span>
						</div>
					</div>
				</section>

				<section className="panel blueprint-panel" aria-labelledby="blueprint-title">
					<div className="panel-heading">
						<div>
							<p className="section-code">BLUEPRINT DELTA</p>
							<h2 id="blueprint-title">The architecture moved</h2>
						</div>
						<span className="hash-label">{shortOid(reviewData.delta.to.value)}</span>
					</div>

					<div className="blueprint-rail" role="img" aria-label="Blueprint structural delta">
						<div className="blueprint-node source-node">
							{incomingEdge?.from ?? "architecture source"}
						</div>
						<div className="blueprint-arrow" aria-hidden="true">
							→
						</div>
						<div className="blueprint-node added-node">
							<span>+ added</span>
							{addedNode?.factory ?? "no added node"}
							<small>{addedNode?.id}</small>
						</div>
						<div className="blueprint-arrow" aria-hidden="true">
							→
						</div>
						<div className="blueprint-node target-node">
							{outgoingEdge?.to ?? "architecture target"}
						</div>
					</div>

					<div className="delta-facts">
						<div>
							<span>Policy</span>
							<strong>session-writes.v1 → v2</strong>
						</div>
						<div>
							<span>Selected claim</span>
							<strong>
								{selectedImpact?.impact === "affected" ? "Affected" : "No structural impact"}
							</strong>
						</div>
						<div>
							<span>GraphReFly delta</span>
							<strong>
								{reviewData.delta.structural.addedNodes.length} node ·{" "}
								{reviewData.delta.structural.addedEdges.length} edges
							</strong>
						</div>
					</div>
				</section>

				<section className="panel gate-panel" aria-labelledby="gate-title">
					<div className="panel-heading">
						<div>
							<p className="section-code">DETERMINISTIC GATE</p>
							<h2 id="gate-title">
								{selectedUnit.id} / {statusLabel(selectedGate.verdict)}
							</h2>
						</div>
						<span className={`large-status status-${selectedGate.verdict}`}>
							{selectedGate.verdict === "valid" ? "✓" : "!"}
						</span>
					</div>

					<div className="reason-stack" aria-live="polite">
						{selectedGate.reasonCodes.length === 0 ? (
							<div className="reason-card valid-reason">
								<strong>No blocking reasons</strong>
								<p>The accepted record remains bound to current deterministic witnesses.</p>
							</div>
						) : (
							selectedGate.reasonCodes.map((reason) => (
								<div className="reason-card" key={reason}>
									<strong>{reason}</strong>
									<p>{reasonExplanation(reason)}</p>
								</div>
							))
						)}
					</div>

					<div className="trust-separator">
						<span>GateResult · read only</span>
						<span>Human decision · {reviewData.reviewDecision.decision}</span>
					</div>
				</section>
			</main>

			<section className="detail-grid">
				<article className="detail-card">
					<p className="section-code">SEMANTIC CHANGE CARD</p>
					<h2>{selectedUnit.title}</h2>
					<p className="intent-copy">{selectedUnit.intent}</p>
					<dl>
						<div>
							<dt>Dependencies</dt>
							<dd>{selectedUnit.dependencies.join(" · ") || "None"}</dd>
						</div>
						<div>
							<dt>Claim impact</dt>
							<dd>
								{selectedImpact?.claimId ?? "No claim"} · {selectedImpact?.impact ?? "none"}
							</dd>
						</div>
						<div>
							<dt>Allowed scope</dt>
							<dd>{selectedUnit.allowedSourceScopes.join(" · ")}</dd>
						</div>
						<div>
							<dt>Required checks</dt>
							<dd>{selectedUnit.requiredChecks.join(" · ")}</dd>
						</div>
					</dl>
				</article>

				<article className="detail-card evidence-card" id="evidence-title">
					<p className="section-code">TRUST BOUNDARY</p>
					<h2>Claim ≠ evidence ≠ verdict</h2>
					<div className="trust-flow">
						<span>Model or human claim</span>
						<b>→</b>
						<span>Validated evidence</span>
						<b>→</b>
						<span>GateResult</span>
					</div>
					<p className="fixture-note">
						{reviewData.source === "contract-fallback"
							? "Checked-in contract fallback only; start review with runtime evidence for real Git proof."
							: "Real Git evidence is projected read-only. The browser cannot edit the gate, approve a merge, or claim live model provenance."}
					</p>
					{reviewData.manifest ? (
						<p className="manifest-line">
							{reviewData.manifest.runId} · {reviewData.manifest.artifactCount} hashed artifacts ·{" "}
							{reviewData.manifest.promptVersion}
						</p>
					) : null}
				</article>

				<article className="detail-card diff-card">
					<p className="section-code">RAW DIFF · ON DEMAND</p>
					<h2>{selectedUnit.id} source patch</h2>
					<p className="intent-copy">
						Architecture review stays primary. Open the exact real-Git patch only when needed.
					</p>
					<details>
						<summary>
							Inspect {selectedDiff?.paths.length ?? 0} changed path
							{selectedDiff?.paths.length === 1 ? "" : "s"}
						</summary>
						{selectedDiff ? (
							<>
								<p className="diff-paths">{selectedDiff.paths.join(" · ")}</p>
								<pre>{selectedDiff.patch}</pre>
							</>
						) : (
							<p className="fixture-note">
								Raw diff is unavailable in contract-only fallback mode.
							</p>
						)}
					</details>
				</article>

				<article className="detail-card review-card">
					<p className="section-code">CHECKS & REVIEW ACTION</p>
					<h2>Evidence can inform; it cannot self-approve</h2>
					<ul className="check-list" aria-label={`${selectedUnit.id} required checks`}>
						{selectedChecks.map((check) => (
							<li key={check.checkId}>
								<span className="check-dot" aria-hidden="true" />
								<strong>{check.checkId}</strong>
								<small>
									exit {check.exitCode} · stdout {shortOid(check.stdoutDigest.value)}
								</small>
							</li>
						))}
					</ul>
					<fieldset className="review-actions" aria-label="Local review draft">
						<button
							type="button"
							aria-pressed={reviewDraft === "defer"}
							onClick={() => setReviewDraft("defer")}
						>
							Keep deferred
						</button>
						<button
							type="button"
							aria-pressed={reviewDraft === "request-replan"}
							onClick={() => setReviewDraft("request-replan")}
						>
							Request replan
						</button>
					</fieldset>
					<p className="fixture-note">
						Local draft: {reviewDraft}. No action edits GateResult, writes evidence, approves, or
						merges.
					</p>
					{reviewData.bundleAvailable ? (
						<a className="export-link" href="/api/evidence-bundle" download>
							Download redacted evidence bundle
						</a>
					) : (
						<span className="export-link is-disabled">
							Export available with bundle-backed review
						</span>
					)}
				</article>
			</section>
		</div>
	);
}
