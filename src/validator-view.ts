import { stripServedComments } from "./strip-served-comments";

// Validator run detail page -- brief 36de4e90 item 11 (page half), Cloud's routing dadf4249.
//
// ⛔ OWN FILE, DELIBERATELY, NOT INLINED INTO index.ts. Cloud's own instruction: "own route/view
//    file so you do not collide with W1's page_sections branch". index.ts's /dashboard/validator/
//    route is a single call into renderValidatorRun() below -- a one-line diff there, so a merge
//    against page_sections work touching the SAME route block stays trivial. Nothing in this
//    file imports from or depends on page_sections; it only needs a run row and a step row, both
//    already fetched by the route handler.
//
// Shows exactly what Cloud asked for: the score, the competitor list WITH SOURCES, not_found
// figures marked as such (never blank, never a silently-dropped field), and the failure reason
// when a run failed or is queued over the daily cap. Every value that could contain arbitrary
// text (idea text, LLM-produced competitor names/figures) is escaped -- this is the first page
// in the product rendering LLM-authored strings, and nothing upstream of this file HTML-escapes
// them.

export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 36de4e90 item 17 (W1, Day 227): "speak 'link' plus the site name for source links, never the
// raw URL" -- copied from templates/living-page.html's sayHost() rather than re-derived, per
// this fleet's own rule that a second implementation of the same contract is how the two drift.
// Deliberately conservative (matches a scheme or www., nothing else): a bare domain in prose is
// NOT what this runs against here, since it only ever sees a real href, never free text.
function sayHost(h: string): string {
  let s = String(h)
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/^www\./i, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  const parts = s.split(".");
  if (parts.length > 1) parts.pop();
  return parts.join(" ").replace(/-/g, " ").trim();
}

type SourcedFigure = { value?: unknown; source?: string; as_of?: string; not_found?: true } | null | undefined;

// Renders one sourced_figure per the typed_outputs.sourced_figure shape (public.steps, id=
// 'validate'): EITHER {value, source, as_of} OR {not_found: true}. A figure that is neither
// shape (malformed, or absent from an older run written before this page existed) renders as
// "not recorded" -- distinct from "not found", because the AI EXPLICITLY not-finding something
// is a different fact from this page never having received a value for it at all.
function fig(f: SourcedFigure): string {
  if (!f) return `<span class="fig-missing">not recorded</span>`;
  if (f.not_found === true) return `<span class="fig-not-found">not found</span>`;
  if (f.value !== undefined && f.source) {
    const asOf = f.as_of ? ` <span class="fig-date">(as of ${esc(f.as_of)})</span>` : "";
    // data-rab-skip + data-rab-say: the read-aloud bar (36de4e90 item 17) must speak "link,
    // <hostname>" for this anchor, never the raw URL or the visible word "source" alone --
    // computed here, server-side, because the URL lives only in href, not in the link's text.
    const spoken = `link, ${sayHost(f.source)}`;
    return `${esc(f.value)}${asOf} <a class="fig-source" href="${esc(f.source)}" target="_blank" rel="noopener" data-rab-skip data-rab-say="${esc(spoken)}">source</a>`;
  }
  return `<span class="fig-missing">not recorded</span>`;
}

function linkTag(url: string, label: string): string {
  const spoken = `link, ${sayHost(url)}`;
  return ` <a class="fig-source" href="${esc(url)}" target="_blank" rel="noopener" data-rab-skip data-rab-say="${esc(spoken)}">${esc(label)}</a>`;
}

// item 18 (Silver, 9d3a1b4) + Cloud's correction (62a25a66): a social_presence entry branches
// on the PRESENCE of a `status` key, the one reliable signal between the new three-state shape
// and every row written before it -- confirmed by Silver against a real pre-item-18 run
// (917def14), never assumed. An old {not_found:true} must NOT reuse the word "not found": that
// wording meant "the count could not be read" under the old shape, which is exactly the false
// claim Darren objected to in the first place, so the fallback renders it as a dated disclosure
// instead ("not checked in this older report") rather than repeating the old lie under new code.
function figSocial(entry: unknown): string {
  if (!entry || typeof entry !== "object") return `<span class="fig-missing">not recorded</span>`;
  const e = entry as Record<string, unknown>;
  if ("status" in e) {
    const url = typeof e.url === "string" ? e.url : "";
    if (e.status === "no_account") return `<span class="fig-not-found">no account</span>`;
    if (e.status === "found_no_count") {
      return `<span class="fig-not-found">account found, count not readable</span>${url ? linkTag(url, "source") : ""}`;
    }
    if (e.status === "found_with_count") {
      // fig() already renders count.source as a "source" link -- appending the entry's own
      // `url` too would print two links (usually to the same address) for one figure.
      return fig(e.count as SourcedFigure);
    }
    return `<span class="fig-missing">not recorded</span>`;
  }
  // OLD SHAPE (no status key): {not_found:true} or a bare sourced_figure.
  if (e.not_found === true) return `<span class="fig-not-found">not checked in this older report</span>`;
  return fig(e as SourcedFigure);
}

type Relationship = "direct" | "indirect" | "adjacent" | "not_competitor";

type Competitor = {
  name?: string;
  age?: SourcedFigure;
  funding?: SourcedFigure;
  revenue?: SourcedFigure;
  team_size?: SourcedFigure;
  market_cap?: SourcedFigure;
  app_store_presence?: SourcedFigure;
  // item 18 (Silver, Day 227): shape widened to {status: no_account|found_no_count|
  // found_with_count, url?, count?} so "account exists, count unreadable" is expressible --
  // the old shape (a bare SourcedFigure or {not_found:true}, no status key) could only say
  // not-found for both a real missing account AND an unreadable count, which is the false
  // claim Darren objected to. `unknown` here, not SourcedFigure, because a row written before
  // this landed has the old shape and figSocial() below branches on it.
  social_presence?: Record<string, unknown>;
  // item 20 (Day 227): Darren typed an AI tool as a competitor and it appeared unquestioned --
  // every competitor now carries WHY it belongs and WHERE it came from. Older rows written
  // before this landed will have none of these five fields; every reader below treats that as
  // "unclassified" (own badge), never as an implicit "direct", so an old run does not suddenly
  // look validated by a rendering assumption.
  relationship?: Relationship;
  relationship_reason?: string;
  source?: "user_supplied" | "found";
  is_closest?: boolean;
  closest_reason?: string | null;
};

// Order matters: this IS the report's grouping order (direct first), not just display labels.
const RELATIONSHIP_LABEL: Record<Relationship, string> = {
  direct: "Direct competitors",
  indirect: "Indirect / alternative",
  adjacent: "Adjacent, partial overlap",
  not_competitor: "Not actually a competitor",
};
const RELATIONSHIP_ORDER: Relationship[] = ["direct", "indirect", "adjacent", "not_competitor"];

function relationshipBadge(c: Competitor): string {
  if (!c.relationship) return `<span class="badge badge-unclassified">unclassified (older run)</span>`;
  const cls = `badge badge-${c.relationship.replace(/_/g, "-")}`;
  const label = c.relationship.replace(/_/g, " ");
  return `<span class="${cls}">${esc(label)}</span>`;
}

function sourceBadge(c: Competitor): string {
  if (!c.source) return "";
  return c.source === "user_supplied"
    ? `<span class="badge badge-source">you named this</span>`
    : `<span class="badge badge-source">found in research</span>`;
}

function competitorCard(c: Competitor): string {
  const social = c.social_presence || {};
  const socialRows = ["x", "tiktok", "youtube", "facebook", "instagram"]
    .filter((k) => social[k])
    .map((k) => `<tr><td>${esc(k)}</td><td>${figSocial(social[k])}</td></tr>`)
    .join("");
  return (
    `<div class="card competitor-card">` +
    `<h3>${esc(c.name) || "(unnamed)"} ${relationshipBadge(c)} ${sourceBadge(c)}</h3>` +
    (c.relationship_reason ? `<p class="relationship-reason">${esc(c.relationship_reason)}</p>` : "") +
    `<table class="fig-table">` +
    `<tr><td>Age</td><td>${fig(c.age)}</td></tr>` +
    `<tr><td>Funding</td><td>${fig(c.funding)}</td></tr>` +
    `<tr><td>Revenue</td><td>${fig(c.revenue)}</td></tr>` +
    `<tr><td>Team size</td><td>${fig(c.team_size)}</td></tr>` +
    `<tr><td>Market cap</td><td>${fig(c.market_cap)}</td></tr>` +
    `<tr><td>App store</td><td>${fig(c.app_store_presence)}</td></tr>` +
    socialRows +
    `</table></div>`
  );
}

// ⛔ STATUS VOCABULARY, MIRRORED FROM schema.sql's own comment on validator_runs.status --
//    keep in sync by hand; this is the ONE place outside the DB comment that names all of them,
//    and it is a rendering concern (what a HUMAN sees), not a query, so it does not belong in a
//    shared constants module for a one-file Worker. Exported for item 14's reports list (W1,
//    Day 227), which needs the SAME labels the report page itself uses, never a re-typed set.
export const STATUS_LABEL: Record<string, string> = {
  uploaded: "Queued",
  extracting: "Reading your files…",
  researching: "Ready for scoring…",
  scoring: "Researching competitors and scoring… (this can take a few minutes)",
  queued_over_cap: "Queued — today's judgement quota is used, this will run automatically once it resets",
  done: "Done",
  failed: "Failed",
};

// item 21 (W1, Day 227), field names locked by Cloud (142d6229), worker half by Silver (62b25d6).
type CustomerTargeting = { who?: string; where?: string[]; question?: string } | null;

// item 16 (Silver's legal-worker.py shape, confirmed against a real driven run aa1880f8): a
// distinct step and its own claude -p call, same doctrine as item 6/21 -- these fields are
// nullable until country is set AND the legal worker has run.
type Licence = { name?: string; issuing_authority?: string; source?: SourcedFigure } | { not_found: true };
type RequiredDoc = { name?: string; why?: string; applies_because?: string; source?: SourcedFigure };
const LEGAL_STATUS_LABEL: Record<string, string> = {
  clearly_legal: "Clearly legal",
  licence_required: "Licence required",
  restricted: "Restricted",
  likely_not_legal: "Likely not legal",
  unknown: "Unknown",
};
const LEGAL_DANGER_STATUSES = ["restricted", "likely_not_legal"];

// items 22/23 (36de4e90), Silver, Day 227. Loose shapes on purpose -- these fields are NOT
// enforced to a fixed per-item schema at the worker's structural-validation layer (only the
// discriminator fields are: business_type, task_breakdown[].mode, the type_specific keys), so
// this renderer is defensive about which of a few reasonable sub-shapes the model actually used,
// rather than assuming one and crashing or silently dropping content on another.
function estimateText(v: unknown): string {
  if (v === null || v === undefined) return `<span class="fig-missing">not recorded</span>`;
  if (typeof v === "object" && (v as { not_found?: true }).not_found === true) {
    return `<span class="fig-not-found">not found</span>`;
  }
  if (typeof v === "string" || typeof v === "number") return esc(v);
  return esc(JSON.stringify(v));
}

function costLine(item: unknown): string {
  const o = (item as { item?: string; label?: string; basis?: string; estimate?: unknown }) || {};
  const label = o.item || o.label || "";
  return `<li><strong>${esc(label)}:</strong> ${estimateText(o.estimate)}` +
    (o.basis ? ` <span class="muted">(${esc(o.basis)})</span>` : "") + `</li>`;
}

function pathCard(pathLabel: string, p: unknown): string {
  const o = (p as { weeks?: number; milestones?: string[]; estimate?: unknown; basis?: string;
    price_range?: string; timeline?: string; where_to_find?: string }) || {};
  let out = `<div class="card"><h4>${esc(pathLabel)}</h4>`;
  if (o.weeks !== undefined) out += `<p><strong>${esc(o.weeks)} week(s)</strong></p>`;
  if (o.estimate !== undefined) out += `<p>${estimateText(o.estimate)}</p>`;
  if (o.price_range) out += `<p>${esc(o.price_range)}</p>`;
  if (o.timeline) out += `<p class="muted">${esc(o.timeline)}</p>`;
  if (o.where_to_find) out += `<p class="muted">Where to find: ${esc(o.where_to_find)}</p>`;
  if (o.basis) out += `<p class="muted">${esc(o.basis)}</p>`;
  if ((o.milestones || []).length) {
    out += `<ul>${(o.milestones || []).map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
  }
  out += `</div>`;
  return out;
}

const TASK_MODE_LABEL: Record<string, string> = {
  ai_does: "AI does this",
  ai_helps: "AI helps",
  needs_a_person: "Needs a person",
};

function renderBuildPlan(bp: Record<string, unknown> | undefined): string {
  if (!bp) return "";
  const mvpScope = (bp.mvp_scope as string) || "";
  const costTable = (bp.cost_table as { startup?: unknown[]; monthly_running?: unknown[];
    mvp_diy_vs_hire?: Record<string, unknown> } | null) || null;
  const weeksToMvp = (bp.weeks_to_mvp as Record<string, unknown> | null) || null;
  const taskBreakdown = (bp.task_breakdown as Array<{ task?: string; mode?: string; reason?: string; note?: string }> | null) || [];
  const skillsGap = (bp.skills_gap as string[] | null) || [];
  const fundingAndGrants = (bp.funding_and_grants as Array<{ name?: string; amount_or_type?: string;
    description?: string; eligibility_note?: string; source?: SourcedFigure }> | null) || [];
  const topRisks = (bp.top_risks as Array<{ risk?: string; mitigation?: string }> | null) || [];
  const typeSpecific = (bp.type_specific as Record<string, unknown> | null) || null;

  let out = `<h2>Build plan</h2>`;
  if (mvpScope) out += `<div class="card"><h3>MVP scope</h3><p>${esc(mvpScope)}</p></div>`;

  if (costTable) {
    out += `<div class="card"><h3>Costs</h3>`;
    if ((costTable.startup || []).length) {
      out += `<p class="muted">Startup (one-off)</p><ul>${(costTable.startup || []).map(costLine).join("")}</ul>`;
    }
    if (costTable.mvp_diy_vs_hire) {
      const dh = costTable.mvp_diy_vs_hire as { diy_with_ai?: unknown; hire?: unknown };
      out += `<p class="muted">MVP: do it yourself with AI vs. hire it out</p><div class="cards-2col">` +
        pathCard("Do it yourself with AI", dh.diy_with_ai) + pathCard("Hire it out", dh.hire) + `</div>`;
    }
    if ((costTable.monthly_running || []).length) {
      out += `<p class="muted">Monthly running</p><ul>${(costTable.monthly_running || []).map(costLine).join("")}</ul>`;
    }
    out += `</div>`;
  }

  if (weeksToMvp && (weeksToMvp.diy_with_ai || weeksToMvp.hire)) {
    out += `<div class="card"><h3>Weeks to MVP</h3><div class="cards-2col">` +
      pathCard("Do it yourself with AI", weeksToMvp.diy_with_ai) +
      pathCard("Hire it out", weeksToMvp.hire) + `</div></div>`;
  }

  if (taskBreakdown.length) {
    out += `<div class="card"><h3>Who does what</h3><ul class="task-list">` +
      taskBreakdown.map((t) =>
        `<li><span class="badge task-mode-${esc(t.mode || "")}">${esc(TASK_MODE_LABEL[t.mode || ""] || t.mode || "")}</span> ` +
        `${esc(t.task || "")}${(t.reason || t.note) ? ` <span class="muted">${esc(t.reason || t.note)}</span>` : ""}</li>`
      ).join("") + `</ul></div>`;
  }

  if (skillsGap.length) {
    out += `<div class="card"><h3>Skills gap</h3><ul>${skillsGap.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`;
  }

  if (fundingAndGrants.length) {
    out += `<div class="card"><h3>Funding and grants</h3><ul>` +
      fundingAndGrants.map((g) =>
        `<li><strong>${esc(g.name || "")}</strong>` +
        (g.amount_or_type ? ` -- ${esc(g.amount_or_type)}` : "") +
        (g.source ? ` (${fig(g.source)})` : "") +
        (g.description ? `<br><span class="muted">${esc(g.description)}</span>` : "") +
        (g.eligibility_note ? `<br><span class="muted">${esc(g.eligibility_note)}</span>` : "") +
        `</li>`
      ).join("") + `</ul></div>`;
  }

  if (topRisks.length) {
    out += `<div class="card"><h3>Top risks</h3><ul>` +
      topRisks.map((r) => `<li><strong>${esc(r.risk || "")}</strong><br><span class="muted">Mitigation: ${esc(r.mitigation || "")}</span></li>`).join("") +
      `</ul></div>`;
  }

  if (typeSpecific) {
    const branch = ["product", "custom_software_or_digital", "service"].find((k) => typeSpecific[k] != null);
    if (branch) {
      const b = typeSpecific[branch] as Record<string, unknown>;
      out += `<div class="card"><h3>${branch === "product" ? "Product details" : branch === "service" ? "Service details" : "Build path comparison"}</h3>`;
      if (branch === "product") {
        if (b.store_route) out += `<p><strong>Store route:</strong> ${esc(String(b.store_route))}</p>`;
        if (b.unit_cost !== undefined) out += `<p><strong>Unit cost:</strong> ${estimateText(b.unit_cost)}</p>`;
        if (b.margin !== undefined) out += `<p><strong>Margin:</strong> ${estimateText(b.margin)}</p>`;
        if (b.marketing_and_competitor_notes) out += `<p class="muted">${esc(String(b.marketing_and_competitor_notes))}</p>`;
      } else if (branch === "service") {
        if (b.licence_or_certification) out += `<p><strong>Licence/certification:</strong> ${esc(String(b.licence_or_certification))}</p>`;
        if (b.average_income !== undefined) out += `<p><strong>Average income:</strong> ${estimateText(b.average_income)}</p>`;
        if (b.pricing_benchmarks) out += `<p><strong>Pricing benchmarks:</strong> ${esc(String(b.pricing_benchmarks))}</p>`;
        if (b.local_competition) out += `<p><strong>Local competition:</strong> ${esc(String(b.local_competition))}</p>`;
        if (b.capacity_limit) out += `<p><strong>Capacity limit:</strong> ${esc(String(b.capacity_limit))}</p>`;
      } else {
        out += `<div class="cards-2col">` +
          pathCard("DIY with AI", b.diy_with_ai) + pathCard("No-code / WordPress", b.no_code_or_wordpress) +
          pathCard("Freelancer marketplace", b.freelancer_marketplace) + pathCard("Boutique studio", b.boutique_studio) +
          `</div>`;
      }
      out += `</div>`;
    }
  }

  return out;
}

export function renderValidatorRun(run: Record<string, unknown>, step: { id: string; instructions: string } | undefined, buildPlan?: Record<string, unknown>): string {
  const status = String(run.status || "");
  const statusLabel = STATUS_LABEL[status] || status;
  const inProgress = ["uploaded", "extracting", "researching", "scoring", "queued_over_cap"].includes(status);
  const score = run.score as number | null;
  const competitors = (run.competitors as Competitor[] | null) || [];
  const marketGaps = (run.market_gaps as string[] | null) || [];
  const costs = (run.costs as Record<string, string> | null) || {};
  const founder = run.founder_assessment as { summary?: string; basis?: SourcedFigure } | null;
  const scoreReasons = String(run.score_reasons || "");
  // item 21: every one of these is nullable on an OLDER run written before this widening
  // landed -- each renders only when present, per Cloud's own instruction ("falling back to
  // score_reasons as one paragraph and hiding any section whose column is null, so the page
  // ships before the worker does and fills in as runs land").
  const verdictLine = (run.verdict_line as string | null) || "";
  const reasonBullets = (run.score_reasons_bullets as string[] | null) || [];
  const safetyFlag = run.safety_flag === true;
  const safetyReason = (run.safety_reason as string | null) || "";
  const customerTargeting = (run.customer_targeting as CustomerTargeting) || null;
  const nextStep = (run.next_step as string | null) || "";
  // item 16: legal_verdict is the gate -- non-null means the legal step has actually run for
  // this idea's country, same "hides the section when the column is null" convention as item 21.
  const legalVerdict = (run.legal_verdict as string | null) || "";
  const legalStatus = (run.legal_status as string | null) || "";
  const licences = (run.licences as Licence[] | null) || [];
  const lawAreas = (run.law_areas as string[] | null) || [];
  const requiredDocs = (run.required_documents as RequiredDoc[] | null) || [];

  let body = `<h1>Your validation run</h1>`;
  body += `<div class="card"><p><strong>Idea:</strong> ${esc(run.idea_text)}</p>`;
  body += `<p><strong>Status:</strong> ${esc(statusLabel)}</p></div>`;

  if (status === "failed") {
    // ⛔ THE FAILURE REASON IS SHOWN VERBATIM, NEVER SWALLOWED INTO A GENERIC "something went
    //    wrong" -- judge-worker.py writes a specific, actionable reason into score_reasons on
    //    every failure path, and hiding it here would throw that diagnostic work away.
    body += `<div class="card"><h3>This run failed</h3><p>${esc(scoreReasons)}</p></div>`;
    return body;
  }

  if (inProgress) {
    // A run in progress has none of the fields below populated yet -- showing an empty
    // "Competitors found: 0" table here would read as a completed, empty result, not as
    // "still working". Stop here rather than render sections with nothing in them.
    body += `<div class="card"><p>This page updates automatically — refresh to check progress.</p></div>`;
    return body;
  }

  // status === 'done' from here down.
  // item 21 (51e70254, Cloud's correction -- was rendering below the score, moved above so a
  // reader sees the warning BEFORE the number): safety banner first, capped-score rule lives in
  // the worker (Silver, 62b25d6), this only ever DISPLAYS the flag, never recomputes it.
  if (safetyFlag) {
    body += `<div class="card safety-banner"><h3>Safety concern</h3><p>${esc(safetyReason || "This idea was flagged for a safety concern.")}</p></div>`;
  }

  // item 16 (ff7bf67f): same slot as the safety banner, above the score, only for the two
  // danger statuses -- clearly_legal/licence_required/unknown show no banner here at all (the
  // full legal_verdict is still available below, in the collapsed research section).
  if (legalVerdict && LEGAL_DANGER_STATUSES.includes(legalStatus)) {
    body += `<div class="card safety-banner"><h3>Legal concern -- ${esc(LEGAL_STATUS_LABEL[legalStatus] || legalStatus)}</h3><p>${esc(legalVerdict)}</p></div>`;
  }

  // item 21: score + a ONE-LINE verdict -- verdictLine when the worker has written one, else
  // the old bare-score-plus-paragraph shape (an older run, or before this ran once).
  if (score !== null && score !== undefined) {
    body += verdictLine
      ? `<div class="card"><h2>Score: ${esc(score)}/100</h2><p><strong>${esc(verdictLine)}</strong></p></div>`
      : `<div class="card"><h2>Score: ${esc(score)}/100</h2><p>${esc(scoreReasons)}</p></div>`;
  }

  // item 20 amendment (Darren, 27c958b7): the report ALWAYS leads with the three closest
  // competitors -- nearest direct, or nearest indirect/adjacent if fewer than three direct
  // exist -- each with why it is close, before the full grouped list. `is_closest` is the
  // model's own judgement of "closest", not recomputed here; this section just pulls out what
  // it flagged and shows the reason it gave, so a reader sees the "so what" before the table.
  const closest = competitors.filter((c) => c.is_closest);
  if (closest.length) {
    body += `<h3>Closest competitors</h3>`;
    body += closest
      .map(
        (c) =>
          `<div class="card competitor-card closest-card">` +
          `<h3>${esc(c.name) || "(unnamed)"} ${relationshipBadge(c)} ${sourceBadge(c)}</h3>` +
          `<p class="closest-reason">${esc(c.closest_reason || "")}</p>` +
          `</div>`
      )
      .join("");
  }

  // item 21: customer targeting -- who to sell to, where to reach them, one validating question.
  if (customerTargeting && (customerTargeting.who || (customerTargeting.where || []).length || customerTargeting.question)) {
    body += `<div class="card"><h3>Who to target</h3>`;
    if (customerTargeting.who) body += `<p>${esc(customerTargeting.who)}</p>`;
    if ((customerTargeting.where || []).length) {
      body += `<p class="muted">Where to find them:</p><ul>${(customerTargeting.where || []).map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`;
    }
    if (customerTargeting.question) body += `<p><strong>Ask them:</strong> ${esc(customerTargeting.question)}</p>`;
    body += `</div>`;
  }

  // item 21: one next step -- deliberately singular, never a list, per Cloud's spec.
  if (nextStep) {
    body += `<div class="card next-step-card"><h3>Your next step</h3><p>${esc(nextStep)}</p></div>`;
  }

  // items 22/23: build plan, its OWN section, below next step and above "Show full research"
  // per Cloud's spec (82c0368d) -- only when THIS run is what generated the current plan (the
  // route handler already scopes the query to source_run_id=eq.this run, so a present buildPlan
  // here always belongs to this run, never an older or newer one for the same workspace).
  body += renderBuildPlan(buildPlan);

  // item 21: everything else collapsed behind "Show full research" -- the detailed score
  // reasoning, market gaps, founder assessment, costs, and the full competitor list, all of
  // which a reader can already act on without reading (verdict, safety, closest competitors,
  // targeting and next step are all above, uncollapsed).
  body += `<details class="full-research"><summary>Show full research</summary>`;

  if (reasonBullets.length) {
    body += `<div class="card"><h3>Why this score</h3><ul>${reasonBullets.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`;
  } else if (scoreReasons && verdictLine) {
    // scoreReasons is already shown as the fallback paragraph above WHEN there is no
    // verdictLine (an older run) -- only duplicate it down here when a verdictLine exists but
    // bullets do not (a run written after the verdict field landed but before the bullets did).
    body += `<div class="card"><h3>Why this score</h3><p>${esc(scoreReasons)}</p></div>`;
  }

  if (marketGaps.length) {
    body += `<div class="card"><h3>Market gaps and niche options</h3><ul>${marketGaps
      .map((g) => `<li>${esc(g)}</li>`)
      .join("")}</ul></div>`;
  }

  if (founder) {
    body += `<div class="card"><h3>Founder assessment</h3><p>${esc(founder.summary)}</p>`;
    if (founder.basis) body += `<p><strong>Basis:</strong> ${fig(founder.basis)}</p>`;
    body += `</div>`;
  }

  if (costs.development || costs.business_setup || costs.running_subscriptions) {
    body += `<div class="card"><h3>Estimated costs</h3><table class="fig-table">` +
      (costs.development ? `<tr><td>Development</td><td>${esc(costs.development)}</td></tr>` : "") +
      (costs.business_setup ? `<tr><td>Business setup</td><td>${esc(costs.business_setup)}</td></tr>` : "") +
      (costs.running_subscriptions ? `<tr><td>Running subscriptions</td><td>${esc(costs.running_subscriptions)}</td></tr>` : "") +
      `</table></div>`;
  }

  // item 16: shown only when legal_verdict is set (Silver's convention, same as item 21's
  // per-field nulls) -- the danger-status banner above is a SEPARATE, unmissable render of the
  // same underlying data; this is the detail a reader opens "Show full research" to get.
  if (legalVerdict) {
    body += `<div class="card"><h3>Legal and licences${legalStatus ? ` -- ${esc(LEGAL_STATUS_LABEL[legalStatus] || legalStatus)}` : ""}</h3>` +
      `<p>${esc(legalVerdict)}</p>`;
    if (lawAreas.length) {
      body += `<p class="muted">Areas of law that apply:</p><ul>${lawAreas.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
    }
    if (licences.length) {
      body += `<p class="muted">Licences and registrations:</p><ul>` +
        licences
          .map((l) =>
            "not_found" in l
              ? `<li><span class="fig-not-found">None found</span></li>`
              : `<li>${esc(l.name)}${l.issuing_authority ? ` -- ${esc(l.issuing_authority)}` : ""}${l.source ? ` (${fig(l.source)})` : ""}</li>`
          )
          .join("") +
        `</ul>`;
    }
    if (requiredDocs.length) {
      body += `<p class="muted">Documents you will likely need:</p><ul>` +
        requiredDocs
          .map((d) => `<li><strong>${esc(d.name)}</strong>${d.applies_because ? ` -- ${esc(d.applies_because)}` : ""}${d.source ? ` (${fig(d.source)})` : ""}</li>`)
          .join("") +
        `</ul>`;
    }
    body += `<p class="muted">This is not legal advice -- confirm with a local professional before acting.</p></div>`;
  }

  body += `<h3>All competitors (${competitors.length})</h3>`;
  if (!competitors.length) {
    body += `<div class="card"><p>No competitors were returned for this run.</p></div>`;
  } else {
    // Grouped by relationship, direct first -- this ordering IS the point of item 20, not a
    // display nicety: an unquestioned "Grok" sitting next to a real direct rival is exactly
    // the failure that triggered this feature, and grouping makes the difference visible at a
    // glance rather than requiring a reader to check each badge individually.
    const grouped: Record<string, Competitor[]> = {};
    const unclassified: Competitor[] = [];
    for (const c of competitors) {
      if (!c.relationship) {
        unclassified.push(c);
      } else {
        (grouped[c.relationship] ||= []).push(c);
      }
    }
    for (const rel of RELATIONSHIP_ORDER) {
      const group = grouped[rel];
      if (group && group.length) {
        body += `<h4>${esc(RELATIONSHIP_LABEL[rel])} (${group.length})</h4>`;
        body += group.map(competitorCard).join("");
      }
    }
    if (unclassified.length) {
      body += `<h4>Unclassified (${unclassified.length}) -- from before this run's relationship check existed</h4>`;
      body += unclassified.map(competitorCard).join("");
    }
  }

  body += `</details>`;

  // f73d589b (W1, Day 227): accept the idea -> write it up by hand. Manual editing is the
  // must-have (614ca396), not a fallback for a run that has not scored yet -- this stays on the
  // "done" path only, once there is something real to accept.
  // item 19 (Cloud, 797dc1da): left button restarts the funnel, right button moves it forward --
  // at the box's left and right edges, stacked on a phone (.accept-actions in VALIDATOR_VIEW_CSS).
  // f73d589b item 6 (W1, Day 227): the right button now POSTs to insert a plan_jobs row (the
  // confirm-before-overwrite check lives server-side in that route, not here) rather than
  // linking straight to an empty plan page that never generated anything.
  body += `<div class="card"><h3>Accept this idea</h3><p>Write it up by hand -- manual editing is the must-have, not a fallback.</p>` +
    `<div class="accept-actions">` +
    `<a class="btn btn-secondary" href="/dashboard/validator">Try a new idea</a>` +
    `<form method="post" action="/dashboard/plans/generate" style="margin:0">` +
    `<input type="hidden" name="source_run_id" value="${esc(run.id)}">` +
    `<button type="submit" class="btn">Generate my business and marketing plans</button>` +
    `</form>` +
    `</div></div>`;

  return body;
}

// Minimal CSS for the figure rendering above -- appended into the page's existing <style> block
// by the caller (index.ts), not a new stylesheet, so it inherits the shared theme and gets
// restyled automatically whenever W1's page_sections/theme work reaches this route.
// item 21 (W1, Day 227): safety banner, next-step callout, collapsed full-research section --
// this note is OUTSIDE the template literal below on purpose (d4f48795/7df70723 class of leak:
// a comment INSIDE a string that reaches a Response body is served, publicly, verbatim).
export const VALIDATOR_VIEW_CSS = stripServedComments(`
.fig-table{width:100%;border-collapse:collapse}
.fig-table td{padding:4px 8px;vertical-align:top;border-bottom:1px solid var(--rule,#e5e5e5)}
.fig-table td:first-child{font-weight:600;white-space:nowrap;width:1%}
.fig-not-found{opacity:.6;font-style:italic}
.fig-missing{opacity:.4;font-style:italic}
.fig-date{opacity:.6;font-size:.85em}
.fig-source{font-size:.85em;margin-left:6px}
.competitor-card h3{margin-top:0}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;
  margin-left:6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.02em}
.badge-direct{background:#e6f4ea;color:#1e7a34}
.badge-indirect{background:#fff4e0;color:#8a5a00}
.badge-adjacent{background:#eef0f5;color:#4a5266}
.badge-not-competitor{background:#fbe7e7;color:#a02525}
.badge-unclassified{background:#f0f0f0;color:#777}
.badge-source{background:none;color:var(--muted,#5C6B76);text-transform:none;font-weight:600;
  border:1px solid var(--rule,#e5e5e5)}
.relationship-reason{margin:2px 0 10px;font-size:13.5px;color:var(--muted,#5C6B76)}
.closest-card{border:2px solid var(--accent,#FF7A45)}
.closest-reason{margin:0;font-size:14px}
.accept-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
@media(max-width:480px){.accept-actions{flex-direction:column;align-items:stretch}.accept-actions .btn,.accept-actions .btn-secondary{text-align:center}}
.safety-banner{background:#fbe7e7;border:2px solid #a02525}
.safety-banner h3{color:#a02525;margin-top:0}
.next-step-card{border:2px solid var(--accent2,#2FB8A6)}
.full-research{margin-top:8px}
.full-research summary{cursor:pointer;font-weight:700;padding:12px 4px;color:var(--accent2,#2FB8A6)}
.full-research summary:hover{text-decoration:underline}
.full-research[open] summary{margin-bottom:4px}
.cards-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px}
@media(max-width:600px){.cards-2col{grid-template-columns:1fr}}
.cards-2col .card h4{margin:0 0 6px}
.task-list{list-style:none;padding:0;margin:0}
.task-list li{margin-bottom:8px}
.task-mode-ai_does{background:#e6f4ea;color:#1e7a34}
.task-mode-ai_helps{background:#fff4e0;color:#8a5a00}
.task-mode-needs_a_person{background:#fbe7e7;color:#a02525}
`);
