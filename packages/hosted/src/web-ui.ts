type JsonObject = Record<string, unknown>;

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function object(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function list(items: string[], empty: string): string {
	return items.length === 0
		? `<p class="empty">${escapeHtml(empty)}</p>`
		: `<ul class="token-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function units(result: JsonObject): string {
	const values = Array.isArray(result.units) ? result.units.map(object) : [];
	return values
		.map((unit) => {
			const verdict = String(unit.verdict ?? "unknown");
			return `<article class="unit">
        <div><span class="mono">${escapeHtml(unit.workUnitId)}</span><strong class="unit-verdict ${escapeHtml(verdict)}">${escapeHtml(verdict)}</strong></div>
        ${list(strings(unit.reasonCodes), "No blocking reasons")}
      </article>`;
		})
		.join("");
}

function decisionHistory(value: unknown): string {
	const decisions = Array.isArray(value) ? value.map(object) : [];
	if (decisions.length === 0) {
		return '<p class="empty">No hosted decisions yet. GateResult remains the only machine verdict.</p>';
	}
	return decisions
		.map(
			(decision) => `<article class="decision">
        <div class="decision-head"><strong>${escapeHtml(decision.decision)}</strong><time>${escapeHtml(decision.receivedAt)}</time></div>
        <p>${escapeHtml(decision.summary)}</p>
        <div class="mono decision-id">${escapeHtml(decision.id)}</div>
      </article>`,
		)
		.join("");
}

export function renderHostedReviewPage(input: {
	projection: JsonObject;
	tenantId: string;
	repositoryId: string;
	digest: string;
	csrfToken: string;
	decisionAction: string;
	auditUrl: string;
}): string {
	const projection = input.projection;
	const state = String(projection.state ?? "unknown");
	const upload = object(projection.upload);
	if (state !== "available") {
		return document(
			`Evidence ${state}`,
			`<main class="unavailable"><div class="state-mark ${escapeHtml(state)}"></div><p class="eyebrow">GraphReFly Hosted</p><h1>Evidence is ${escapeHtml(state)}</h1><p>The repository gate is unchanged. Retry the same content digest from the retained CI artifact when it is available.</p><code>${escapeHtml(input.digest)}</code></main>`,
		);
	}
	const result = object(projection.gateResult);
	const summary = object(projection.summary);
	const source = object(projection.source);
	const redaction = object(projection.redaction);
	const access = object(projection.access);
	const sourceReview = object(projection.sourceReview);
	const verdict = String(result.verdict ?? "unknown");
	const role = String(access.role ?? "viewer");
	const canDecide = ["reviewer", "admin", "owner"].includes(role);
	const canAudit = ["admin", "owner"].includes(role);
	const includes = Array.isArray(redaction.includes) ? redaction.includes.map(object) : [];
	return document(
		`Gate ${verdict} · GraphReFly Hosted`,
		`<header class="masthead">
      <a class="wordmark" href="/">GraphReFly <span>Hosted</span></a>
      <div class="role">${escapeHtml(role)} access</div>
    </header>
    <main class="review-layout">
      <aside class="evidence-spine" aria-label="Upload and gate status">
        <div class="spine-line"></div>
        <section><span class="spine-dot synced"></span><p>Upload</p><strong>${escapeHtml(state)}</strong><small>${escapeHtml(upload.receivedAt)}</small></section>
        <section><span class="spine-dot ${escapeHtml(verdict)}"></span><p>GateResult</p><strong>${escapeHtml(verdict)}</strong><small>Immutable machine verdict</small></section>
        <code title="Envelope digest">${escapeHtml(input.digest)}</code>
      </aside>
      <div class="ledger">
        <section class="hero">
          <p class="eyebrow">Verified repository evidence</p>
          <h1><span class="verdict ${escapeHtml(verdict)}">${escapeHtml(verdict)}</span> at <span class="mono">${escapeHtml(object(source.head).value)}</span></h1>
          <p>${strings(summary.affectedWorkUnitIds).length === 0 ? "No WorkUnits are currently affected." : `${strings(summary.affectedWorkUnitIds).length} WorkUnits require attention.`}</p>
          <div class="hero-actions">
            <a href="${escapeHtml(sourceReview.url)}" rel="noopener noreferrer">Open repository source review ↗</a>
            ${canAudit ? `<a class="quiet" href="${escapeHtml(input.auditUrl)}">Export audit</a>` : ""}
          </div>
        </section>
        <section class="ledger-section" aria-labelledby="reasons-title">
          <div class="section-label"><span>01</span><h2 id="reasons-title">Affected work and ordered reasons</h2></div>
          ${list(strings(summary.reasonCodes), "No ordered reasons")}
          <div class="units">${units(result)}</div>
        </section>
        <section class="ledger-section" aria-labelledby="evidence-title">
          <div class="section-label"><span>02</span><h2 id="evidence-title">Redacted witnesses and provenance</h2></div>
          <dl class="facts">
            <div><dt>Profile</dt><dd>${escapeHtml(upload.profile)}</dd></div>
            <div><dt>Source run</dt><dd class="mono">${escapeHtml(source.runId)} · attempt ${escapeHtml(source.runAttempt)}</dd></div>
            <div><dt>Gate input</dt><dd class="mono">${escapeHtml(object(source.gateInputDigest).value)}</dd></div>
            <div><dt>Policy</dt><dd>hosted-redaction.v1</dd></div>
          </dl>
          <div class="included">${includes.map((item) => `<div><span>${escapeHtml(item.path)}</span><code>${escapeHtml(object(item.digest).value)}</code></div>`).join("")}</div>
          <details><summary>Excluded sensitive classes</summary>${list(strings(redaction.excludes), "No exclusions recorded")}</details>
        </section>
        <section class="ledger-section" id="decisions" aria-labelledby="decision-title">
          <div class="section-label"><span>03</span><h2 id="decision-title">Human decision history</h2></div>
          <div class="decision-list">${decisionHistory(projection.decisions)}</div>
          ${
						canDecide
							? `<form class="decision-form" method="post" action="${escapeHtml(input.decisionAction)}">
              <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
              <label>Decision<select name="decision"><option value="approve">Approve</option><option value="request-changes">Request changes</option><option value="defer">Defer</option></select></label>
              <label>Summary<textarea name="summary" maxlength="1000" required placeholder="State what the evidence supports."></textarea></label>
              <button type="submit">Append decision</button>
              <p>This appends human history. It cannot change GateResult or merge state.</p>
            </form>`
							: '<p class="viewer-note">Viewer access is read-only.</p>'
					}
        </section>
      </div>
    </main>`,
	);
}

function document(title: string, content: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/hosted-review.css"></head><body>${content}</body></html>`;
}

export const HOSTED_REVIEW_CSS = `
:root{--paper:#f3f6f5;--ink:#17221f;--muted:#63706c;--line:#cbd5d1;--blue:#277587;--green:#13795b;--amber:#b86516;--red:#b33445;--panel:#fbfdfc;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Avenir Next",Avenir,"Segoe UI",sans-serif;line-height:1.5}a{color:inherit;text-underline-offset:.2em}a:focus-visible,button:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--blue);outline-offset:3px}.mono,code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}.masthead{height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(20px,4vw,64px);border-bottom:1px solid var(--line);background:rgba(243,246,245,.94)}.wordmark{text-decoration:none;font-family:"Avenir Next Condensed","Arial Narrow",sans-serif;font-weight:800;letter-spacing:.02em;font-size:20px}.wordmark span{color:var(--blue);font-weight:500}.role,.eyebrow{font:700 11px/1.2 "SFMono-Regular",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}.review-layout{display:grid;grid-template-columns:minmax(220px,28vw) minmax(0,920px);gap:clamp(28px,6vw,88px);max-width:1280px;margin:0 auto;padding:clamp(38px,7vw,92px) clamp(20px,4vw,64px) 100px}.evidence-spine{position:sticky;top:40px;align-self:start;min-height:420px;padding-left:34px}.spine-line{position:absolute;left:7px;top:11px;height:150px;width:1px;background:var(--line)}.evidence-spine section{position:relative;margin:0 0 48px}.spine-dot{position:absolute;left:-34px;top:4px;width:15px;height:15px;border:3px solid var(--paper);box-shadow:0 0 0 1px currentColor;border-radius:50%;background:currentColor}.spine-dot.synced{color:var(--blue)}.pass,.valid{color:var(--green)}.blocked,.invalid,.stale{color:var(--amber)}.error{color:var(--red)}.evidence-spine p{margin:0;color:var(--muted);font-size:12px}.evidence-spine strong{display:block;font-family:"Avenir Next Condensed","Arial Narrow",sans-serif;font-size:28px;text-transform:capitalize}.evidence-spine small{color:var(--muted)}.evidence-spine>code{display:block;max-width:170px;overflow-wrap:anywhere;color:var(--muted);font-size:10px}.ledger{min-width:0}.hero{padding-bottom:58px;border-bottom:1px solid var(--ink)}.hero h1{max-width:760px;margin:12px 0 16px;font:650 clamp(34px,6vw,72px)/.98 "Avenir Next Condensed","Arial Narrow",sans-serif;letter-spacing:-.025em}.hero .verdict{text-transform:uppercase}.hero .mono{font-size:.42em;letter-spacing:-.04em;color:var(--muted);overflow-wrap:anywhere}.hero>p:not(.eyebrow){font-size:18px;color:var(--muted)}.hero-actions{display:flex;gap:24px;align-items:center;margin-top:28px}.hero-actions a:first-child,.decision-form button{background:var(--ink);color:#fff;text-decoration:none;padding:12px 18px;border:0;font-weight:700}.hero-actions .quiet{color:var(--muted)}.ledger-section{padding:44px 0;border-bottom:1px solid var(--line)}.section-label{display:grid;grid-template-columns:42px 1fr;align-items:baseline}.section-label span{font:700 11px "SFMono-Regular",monospace;color:var(--blue)}h2{margin:0 0 26px;font:650 clamp(24px,3vw,36px)/1.05 "Avenir Next Condensed","Arial Narrow",sans-serif}.token-list{display:flex;gap:8px;flex-wrap:wrap;list-style:none;padding:0;margin:0 0 22px}.token-list li{border:1px solid var(--line);padding:5px 9px;font:600 11px "SFMono-Regular",monospace;background:var(--panel)}.empty{color:var(--muted)}.units{display:grid;gap:1px;background:var(--line)}.unit{background:var(--panel);padding:16px}.unit>div{display:flex;justify-content:space-between;gap:16px}.unit-verdict{text-transform:uppercase;font-size:12px}.unit .token-list{margin:10px 0 0}.facts{display:grid;grid-template-columns:1fr 1fr;margin:0 0 26px;border-top:1px solid var(--line)}.facts div{padding:14px 0;border-bottom:1px solid var(--line)}.facts div:nth-child(odd){padding-right:20px}.facts dt{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.facts dd{margin:4px 0 0;overflow-wrap:anywhere}.included>div{display:grid;grid-template-columns:minmax(140px,.7fr) 1fr;gap:18px;padding:12px 0;border-bottom:1px solid var(--line)}.included code{font-size:10px;overflow-wrap:anywhere;color:var(--muted)}details{margin-top:24px}summary{cursor:pointer;font-weight:650}.decision-list{display:grid;gap:14px}.decision{background:var(--panel);border-left:3px solid var(--blue);padding:18px}.decision-head{display:flex;justify-content:space-between;gap:20px}.decision-head strong{text-transform:capitalize}.decision-head time,.decision-id{font-size:11px;color:var(--muted)}.decision p{margin:10px 0}.decision-form{margin-top:28px;padding:22px;border:1px solid var(--ink);display:grid;gap:16px}.decision-form label{display:grid;gap:6px;font-weight:650}.decision-form select,.decision-form textarea{width:100%;border:1px solid var(--line);background:#fff;color:var(--ink);font:inherit;padding:10px}.decision-form textarea{min-height:110px;resize:vertical}.decision-form button{justify-self:start;cursor:pointer}.decision-form>p,.viewer-note{margin:0;color:var(--muted);font-size:12px}.unavailable{max-width:720px;margin:16vh auto;padding:24px}.unavailable h1{font:650 clamp(40px,8vw,80px)/1 "Avenir Next Condensed","Arial Narrow",sans-serif;margin:10px 0}.unavailable>p:not(.eyebrow){font-size:19px;color:var(--muted)}.unavailable code{display:block;margin-top:30px;overflow-wrap:anywhere}.state-mark{width:56px;height:5px;background:var(--amber);margin-bottom:28px}.state-mark.deleted{background:var(--red)}
@media(max-width:760px){.review-layout{grid-template-columns:1fr;padding-top:30px}.evidence-spine{position:relative;top:auto;min-height:0;display:grid;grid-template-columns:1fr 1fr;padding:0 0 28px;border-bottom:1px solid var(--line)}.evidence-spine .spine-line{display:none}.evidence-spine section{margin:0;padding-left:25px}.evidence-spine .spine-dot{left:0}.evidence-spine>code{grid-column:1/-1;max-width:none;margin-top:18px}.hero h1{font-size:42px}.facts{grid-template-columns:1fr}.facts div:nth-child(odd){padding-right:0}.included>div{grid-template-columns:1fr}.hero-actions{align-items:flex-start;flex-direction:column}.section-label{grid-template-columns:32px 1fr}.decision-head{display:block}}
@media(prefers-reduced-motion:no-preference){.spine-dot{animation:arrive .45s ease-out both}.evidence-spine section:nth-of-type(2) .spine-dot{animation-delay:.12s}@keyframes arrive{from{transform:scale(.5);opacity:0}to{transform:scale(1);opacity:1}}}
`;
