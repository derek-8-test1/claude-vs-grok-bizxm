// bizbox-challenge — Piece 0 (Foundation). Brief 0c7abc2e, parent 23972c07.
// Home page, magic-link sign-in via Supabase Auth, user dashboard (six-step tiles), admin
// back end. Session = Supabase access/refresh tokens in HttpOnly cookies, verified against
// GoTrue on every gated request (no local JWT verification yet -- see README "not done").

import { HOME_PAGE_HTML } from "./homepage";
import { stripServedComments } from "./strip-served-comments";
import { renderValidatorRun, VALIDATOR_VIEW_CSS, esc, STATUS_LABEL } from "./validator-view";
import { readaloudBarHtml, READALOUD_CSS, READALOUD_SCRIPT } from "./readaloud";
import { editableSectionHtml, editRootOpenHtml, editAddButtonHtml, BLOCKEDIT_CSS, BLOCKEDIT_SCRIPT, type EditSection } from "./blockedit";
import { handlePopupRequest } from "./popup";
import { googleLoginUrl, exchangeGoogleCallback, GOOGLE_AUTH_FAILURE_MESSAGE } from "./google-auth";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ADMIN_EMAILS: string;
  // 0c7abc2e (W1, Day 227): invite-only for the challenge. Same allowlist convention as
  // ADMIN_EMAILS -- not sensitive, an allowlist not a credential, lives in wrangler.toml.
  // KEPT IN SYNC BY HAND with schema.sql's handle_new_user() trigger, which enforces the same
  // list at the DATABASE layer as defense-in-depth against any signup path that does not go
  // through this Worker (direct API call, a future admin invite tool, etc). Two enforcement
  // points checking the same two addresses is deliberate, not drift -- see schema.sql's comment.
  ALLOWED_EMAILS: string;
  // 0c7abc2e (W1, Day 227): Google sign-in. The Worker does its own code exchange and ID-token
  // verification (Google's tokeninfo endpoint, not a JWKS library -- see the callback route for
  // why), THEN calls Supabase's signInWithIdToken REST endpoint. This is deliberately NOT
  // Supabase's own Google OAuth provider (Authorize/Providers/Google in the dashboard) -- that
  // path needs the client secret entered directly into Supabase's UI, which is the exact
  // laptop-hop blocker the README recorded. signInWithIdToken only needs Supabase's Google
  // provider ENABLED with this client id in its allowed list, never the secret.
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // a2ea1529 item 5 (W1, Day 227): pepper for hashing visitor IPs before they reach
  // capture_lead's rate limiter. Not a shared secret with any meaning outside this Worker --
  // rotating it just resets the rate-limit bucket boundaries, never a credential to record in
  // runbook_credentials. Generated once via `openssl rand -hex 32` and set with `wrangler
  // secret put LEAD_IP_HASH_SECRET`, never committed.
  LEAD_IP_HASH_SECRET: string;
  // ⛔ Piece 6, Payments (brief 2fdd8d91). TEST MODE ONLY until Darren says live -- Cloud's
  // ruling. Not yet set: this box holds no Stripe credential (verified absent from .dc-creds).
  // STRIPE_SECRET_KEY: string;
  // STRIPE_WEBHOOK_SECRET: string;
  // STRIPE_PRICE_ID: string; -- one plan to start, per README
  // ⛔ Piece 1, Idea Validator (brief 36de4e90). Not yet set: ANTHROPIC_API_KEY is also
  // verified absent from this box's .dc-creds -- same laptop-hop shape as the two above.
  // ANTHROPIC_API_KEY: string;
}

const COOKIE = "bb_session";
const GOOGLE_LOGIN_PATH = "/auth/google/login";
const GOOGLE_CALLBACK_PATH = "/auth/google/callback";

// ── invite-only allowlist (0c7abc2e, W1, Day 227) ──────────────────────────────────────────
// Case-insensitive on the LOCAL comparison only -- email addresses are compared lower-cased on
// both sides, which is correct for the domains in this allowlist (Gmail and our own) and is not
// claimed as a general RFC 5321 case-folding rule.
function isAllowedEmail(email: string, env: Env): boolean {
  const allowed = (env.ALLOWED_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

// 2df0e973 (W1, Day 227): chrome (nav/footer) is OUR product's own, not a user's -- editable by
// Darren only, same allowlist shape and same source (ADMIN_EMAILS) as the /admin gate.
function isDarren(email: string, env: Env): boolean {
  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

// ── cookie helpers ──────────────────────────────────────────────────────────────────────────
function parseCookies(req: Request): Record<string, string> {
  const h = req.headers.get("Cookie") || "";
  const out: Record<string, string> = {};
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(access_token: string, refresh_token: string): string {
  const value = encodeURIComponent(JSON.stringify({ access_token, refresh_token }));
  // ⛔ 7 days, matching Supabase's default access-token-refresh window loosely -- session
  // renewal is NOT built yet (see README). A user who is idle a week signs in again, which is
  // safe-by-expiry rather than silently broken.
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ── auth: verify the session cookie against GoTrue, never trust it unchecked ───────────────
async function getUser(req: Request, env: Env): Promise<{ id: string; email: string; provider: string } | null> {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE];
  if (!raw) return null;
  let session: { access_token?: string };
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!session.access_token) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
  });
  if (!r.ok) return null;
  const u = (await r.json()) as { id: string; email: string; app_metadata?: { provider?: string } };
  // 0c7abc2e account area (W1, Day 227): "sign-in method" for the Account page -- GoTrue's own
  // app_metadata.provider ('email' for magic-link/password, 'google' for Google), never guessed.
  return { id: u.id, email: u.email, provider: u.app_metadata?.provider || "email" };
}

// ── workspace lookup: one workspace per user (schema constraint), never assume a row exists --
// the auth trigger creates it on signup, but a workspace-scoped write must still check, not
// assume the trigger always ran (e.g. a user created before this schema existed).
type Workspace = {
  id: string;
  // 2df0e973 click-to-edit (W1, Day 227): needed on the PUBLIC /site/<id> route to tell an
  // owner viewing their own live site (gets the editor) from any other visitor (read-only).
  owner_user_id: string;
  display_name: string | null;
  plan: string;
  plan_status: string;
  // a2ea1529 item 8 (W1, Day 227): company details -- all nullable, filled in on
  // /dashboard/company, never required at signup (workspaces are created empty by the auth
  // trigger, same "manual editing, filled in later" pattern as the plan pages).
  trading_name: string | null;
  contact_email: string | null;
  address: string | null;
  country: string | null;
  currency: string | null;
  tax_registration: string | null;
  business_type: string | null;
  // 696d3b4c item 1 (W1, Day 227): the start-screen answers. entry_point gates GET /dashboard
  // (redirect to /start while null -- see the route). `country` above is REUSED here (Cloud's
  // ruling, item 3 follow-up: one country column, not two -- /start and /dashboard/company now
  // read and write the same field, both through the same ISO 3166 alpha-2 select). location_region
  // has no pre-existing counterpart, so it stays its own column.
  entry_point: string | null;
  location_region: string | null;
  ai_tools_used: string[] | null;
  // 696d3b4c item 6 (W1, Day 227): the has-a-website flow's captured answers.
  website_platform: string | null;
  website_url: string | null;
};

const WORKSPACE_SELECT =
  "id,owner_user_id,display_name,plan,plan_status,trading_name,contact_email,address,country,currency,tax_registration,business_type,entry_point,location_region,ai_tools_used,website_platform,website_url";

async function getWorkspace(userId: string, env: Env): Promise<Workspace | null> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/workspaces?owner_user_id=eq.${userId}&select=${WORKSPACE_SELECT}`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as Workspace[];
  return rows[0] ?? null;
}

// 696d3b4c item 1 fix (Cloud's review, W1, Day 227): a workspace that already has a validator
// run or a plan pre-dates the start screen -- gating it would bounce an existing user (Darren's
// own account, live) to an unanswered question every time they open a dashboard link. Checked
// with a HEAD + Content-Range count, never a full select, since only "any row at all" matters.
async function hasExistingActivity(workspaceId: string, env: Env): Promise<boolean> {
  const authHeaders = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
  const tables = ["validator_runs", "business_plans", "marketing_plans"];
  const results = await Promise.all(
    tables.map((t) =>
      fetch(`${env.SUPABASE_URL}/rest/v1/${t}?workspace_id=eq.${workspaceId}&select=id&limit=1`, { headers: authHeaders })
    )
  );
  const rows = await Promise.all(results.map((r) => (r.ok ? (r.json() as Promise<unknown[]>) : Promise.resolve([]))));
  return rows.some((arr) => arr.length > 0);
}

// Writes entry_point ONCE for a pre-existing workspace (see hasExistingActivity above) so this
// runs at most once per workspace, not on every dashboard request.
async function backfillEntryPointIdea(workspaceId: string, env: Env): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/workspaces?id=eq.${workspaceId}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ entry_point: "idea" }),
  });
}

// a2ea1529 item 11 (W1, Day 227): a public site lookup, by ID rather than owner -- a visitor to
// /site/<id> is not the workspace owner and has no session; this is the ONLY workspace lookup in
// this file that is not scoped to an authenticated caller, because the thing it serves (a
// published site) is meant to be publicly reachable by design.
async function getWorkspaceById(workspaceId: string, env: Env): Promise<Workspace | null> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/workspaces?id=eq.${workspaceId}&select=${WORKSPACE_SELECT}`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as Workspace[];
  return rows[0] ?? null;
}

// ── f73d589b: live business plan + marketing plan (W1, Day 227) ────────────────────────────
// Cloud's ruling (03121d48, fbc4316f): items 1-3 do not need ANTHROPIC_API_KEY -- layout and
// manual editing only. Per 614ca396's rule that MANUAL editing is the must-have (the AI may be
// down or unpaid), these pages are created EMPTY and filled in by hand; the LLM-generated first
// draft is a later item, not a precondition for the page existing.
type BusinessPlan = {
  workspace_id: string;
  elevator_pitch: string;
  // plan_sections moved to page_sections (2df0e973, Cloud's ruling bead0b30) -- the DB column
  // still exists on business_plans (unused, left in place; dropping a column is a separate,
  // riskier change out of this migration's scope) but the Worker no longer reads or writes it.
  cost_estimate: Record<string, unknown>;
  break_even: {
    assumptions: Array<{ label: string; value: number; editable: true }>;
    monthly_revenue: number;
    monthly_costs: number;
    months_to_break_even: number | null;
  };
  // f73d589b item 6 (Silver's plan_jobs shape, Cloud's ruling 761a4cb5): the worker sets
  // user_edited=false after it (re)writes; every manual save on this side sets it true, so the
  // worker's own guard (never overwrite an edited plan without overwrite_confirmed) has
  // something real to check.
  source_run_id: string | null;
  user_edited: boolean;
  // 696d3b4c item 3 (W1, Day 227), Cloud's ruling: an existing business's "Money today" card --
  // its OWN current figures, editable, never sourced or forecast (that is what cost_estimate/
  // break_even above are for, and they answer a different question: cost to START).
  current_monthly_revenue: number | null;
  current_monthly_costs: number | null;
  revenue_target: number | null;
};
type MarketingPlan = {
  workspace_id: string;
  posting_goals: Record<string, { per: string; count: number }>;
  target_keywords: string[];
  seo_keywords: { title: string[]; description: string[]; headings: string[] };
  bid_keywords: string[];
  source_run_id: string | null;
  user_edited: boolean;
};

// item 16 (Cloud's correction, ff7bf67f): country is a SELECT, not a free text field -- a
// free string makes the legal step guess at the ISO code. Full ISO 3166-1 alpha-2, [code, name]
// -- c3787a75, Cloud: the first pass had 165, common-market shorthand; this is the complete
// ~249-entry set, including microstates and dependent territories, since the legal/build-plan
// steps this feeds should never have to fall back to "other" for a real answer.
const COUNTRIES: Array<[string, string]> = [
  ["AF", "Afghanistan"], ["AX", "Åland Islands"], ["AL", "Albania"], ["DZ", "Algeria"], ["AS", "American Samoa"],
  ["AD", "Andorra"], ["AO", "Angola"], ["AI", "Anguilla"], ["AQ", "Antarctica"], ["AG", "Antigua and Barbuda"],
  ["AR", "Argentina"], ["AM", "Armenia"], ["AW", "Aruba"], ["AU", "Australia"], ["AT", "Austria"],
  ["AZ", "Azerbaijan"], ["BS", "Bahamas"], ["BH", "Bahrain"], ["BD", "Bangladesh"], ["BB", "Barbados"],
  ["BY", "Belarus"], ["BE", "Belgium"], ["BZ", "Belize"], ["BJ", "Benin"], ["BM", "Bermuda"],
  ["BT", "Bhutan"], ["BO", "Bolivia"], ["BQ", "Bonaire, Sint Eustatius and Saba"], ["BA", "Bosnia and Herzegovina"], ["BW", "Botswana"],
  ["BV", "Bouvet Island"], ["BR", "Brazil"], ["IO", "British Indian Ocean Territory"], ["BN", "Brunei"], ["BG", "Bulgaria"],
  ["BF", "Burkina Faso"], ["BI", "Burundi"], ["CV", "Cabo Verde"], ["KH", "Cambodia"], ["CM", "Cameroon"],
  ["CA", "Canada"], ["KY", "Cayman Islands"], ["CF", "Central African Republic"], ["TD", "Chad"], ["CL", "Chile"],
  ["CN", "China"], ["CX", "Christmas Island"], ["CC", "Cocos (Keeling) Islands"], ["CO", "Colombia"], ["KM", "Comoros"],
  ["CG", "Congo"], ["CD", "Congo (DRC)"], ["CK", "Cook Islands"], ["CR", "Costa Rica"], ["CI", "Côte d'Ivoire"],
  ["HR", "Croatia"], ["CU", "Cuba"], ["CW", "Curaçao"], ["CY", "Cyprus"], ["CZ", "Czechia"],
  ["DK", "Denmark"], ["DJ", "Djibouti"], ["DM", "Dominica"], ["DO", "Dominican Republic"], ["EC", "Ecuador"],
  ["EG", "Egypt"], ["SV", "El Salvador"], ["GQ", "Equatorial Guinea"], ["ER", "Eritrea"], ["EE", "Estonia"],
  ["SZ", "Eswatini"], ["ET", "Ethiopia"], ["FK", "Falkland Islands"], ["FO", "Faroe Islands"], ["FJ", "Fiji"],
  ["FI", "Finland"], ["FR", "France"], ["GF", "French Guiana"], ["PF", "French Polynesia"], ["TF", "French Southern Territories"],
  ["GA", "Gabon"], ["GM", "Gambia"], ["GE", "Georgia"], ["DE", "Germany"], ["GH", "Ghana"],
  ["GI", "Gibraltar"], ["GR", "Greece"], ["GL", "Greenland"], ["GD", "Grenada"], ["GP", "Guadeloupe"],
  ["GU", "Guam"], ["GT", "Guatemala"], ["GG", "Guernsey"], ["GN", "Guinea"], ["GW", "Guinea-Bissau"],
  ["GY", "Guyana"], ["HT", "Haiti"], ["HM", "Heard Island and McDonald Islands"], ["VA", "Holy See"], ["HN", "Honduras"],
  ["HK", "Hong Kong"], ["HU", "Hungary"], ["IS", "Iceland"], ["IN", "India"], ["ID", "Indonesia"],
  ["IR", "Iran"], ["IQ", "Iraq"], ["IE", "Ireland"], ["IM", "Isle of Man"], ["IL", "Israel"],
  ["IT", "Italy"], ["JM", "Jamaica"], ["JP", "Japan"], ["JE", "Jersey"], ["JO", "Jordan"],
  ["KZ", "Kazakhstan"], ["KE", "Kenya"], ["KI", "Kiribati"], ["KP", "Korea (North)"], ["KR", "Korea (South)"],
  ["KW", "Kuwait"], ["KG", "Kyrgyzstan"], ["LA", "Laos"], ["LV", "Latvia"], ["LB", "Lebanon"],
  ["LS", "Lesotho"], ["LR", "Liberia"], ["LY", "Libya"], ["LI", "Liechtenstein"], ["LT", "Lithuania"],
  ["LU", "Luxembourg"], ["MO", "Macao"], ["MG", "Madagascar"], ["MW", "Malawi"], ["MY", "Malaysia"],
  ["MV", "Maldives"], ["ML", "Mali"], ["MT", "Malta"], ["MH", "Marshall Islands"], ["MQ", "Martinique"],
  ["MR", "Mauritania"], ["MU", "Mauritius"], ["YT", "Mayotte"], ["MX", "Mexico"], ["FM", "Micronesia"],
  ["MD", "Moldova"], ["MC", "Monaco"], ["MN", "Mongolia"], ["ME", "Montenegro"], ["MS", "Montserrat"],
  ["MA", "Morocco"], ["MZ", "Mozambique"], ["MM", "Myanmar"], ["NA", "Namibia"], ["NR", "Nauru"],
  ["NP", "Nepal"], ["NL", "Netherlands"], ["NC", "New Caledonia"], ["NZ", "New Zealand"], ["NI", "Nicaragua"],
  ["NE", "Niger"], ["NG", "Nigeria"], ["NU", "Niue"], ["NF", "Norfolk Island"], ["MK", "North Macedonia"],
  ["MP", "Northern Mariana Islands"], ["NO", "Norway"], ["OM", "Oman"], ["PK", "Pakistan"], ["PW", "Palau"],
  ["PS", "Palestine"], ["PA", "Panama"], ["PG", "Papua New Guinea"], ["PY", "Paraguay"], ["PE", "Peru"],
  ["PH", "Philippines"], ["PN", "Pitcairn"], ["PL", "Poland"], ["PT", "Portugal"], ["PR", "Puerto Rico"],
  ["QA", "Qatar"], ["RE", "Réunion"], ["RO", "Romania"], ["RU", "Russia"], ["RW", "Rwanda"],
  ["BL", "Saint Barthélemy"], ["SH", "Saint Helena"], ["KN", "Saint Kitts and Nevis"], ["LC", "Saint Lucia"], ["MF", "Saint Martin"],
  ["PM", "Saint Pierre and Miquelon"], ["VC", "Saint Vincent and the Grenadines"], ["WS", "Samoa"], ["SM", "San Marino"], ["ST", "Sao Tome and Principe"],
  ["SA", "Saudi Arabia"], ["SN", "Senegal"], ["RS", "Serbia"], ["SC", "Seychelles"], ["SL", "Sierra Leone"],
  ["SG", "Singapore"], ["SX", "Sint Maarten"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["SB", "Solomon Islands"],
  ["SO", "Somalia"], ["ZA", "South Africa"], ["GS", "South Georgia and South Sandwich Islands"], ["SS", "South Sudan"], ["ES", "Spain"],
  ["LK", "Sri Lanka"], ["SD", "Sudan"], ["SR", "Suriname"], ["SJ", "Svalbard and Jan Mayen"], ["SE", "Sweden"],
  ["CH", "Switzerland"], ["SY", "Syria"], ["TW", "Taiwan"], ["TJ", "Tajikistan"], ["TZ", "Tanzania"],
  ["TH", "Thailand"], ["TL", "Timor-Leste"], ["TG", "Togo"], ["TK", "Tokelau"], ["TO", "Tonga"],
  ["TT", "Trinidad and Tobago"], ["TN", "Tunisia"], ["TR", "Turkey"], ["TM", "Turkmenistan"], ["TC", "Turks and Caicos Islands"],
  ["TV", "Tuvalu"], ["UG", "Uganda"], ["UA", "Ukraine"], ["AE", "United Arab Emirates"], ["GB", "United Kingdom"],
  ["US", "United States"], ["UM", "United States Minor Outlying Islands"], ["UY", "Uruguay"], ["UZ", "Uzbekistan"], ["VU", "Vanuatu"],
  ["VE", "Venezuela"], ["VN", "Vietnam"], ["VG", "Virgin Islands (British)"], ["VI", "Virgin Islands (U.S.)"], ["WF", "Wallis and Futuna"],
  ["EH", "Western Sahara"], ["YE", "Yemen"], ["ZM", "Zambia"], ["ZW", "Zimbabwe"],
];

const PLAN_SECTION_SLOTS = ["Problem", "Solution", "Market", "Operations", "Team"];
// SINGLE SOURCE for the break-even assumption keys/labels -- the GET render (form field names +
// displayed values) and the POST handler (parsing) both read this list, never a re-typed string
// on either side. A mismatch here was caught in review before deploy: see the POST handler's
// comment.
const BUSINESS_PLAN_ASSUMPTIONS = [
  { key: "price_per_customer", label: "Price per customer ($/mo)" },
  { key: "customers_per_month", label: "New customers per month" },
  { key: "monthly_fixed_costs", label: "Fixed costs per month ($)" },
  { key: "startup_cost", label: "One-time startup cost ($)" },
] as const;
const notFoundFigure = { not_found: true };

// item 1: "cost estimate carried from the validator" -- structurally wired now (same shape as
// the `steps` table before the LLM call existed): read the newest validator_runs.costs for this
// workspace; validator_runs.costs is not populated yet (no ANTHROPIC_API_KEY), so this reads
// {not_found:true} today and needs no code change once the LLM half lands and starts writing it.
async function getLatestValidatorCosts(workspaceId: string, env: Env): Promise<Record<string, unknown>> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/validator_runs?workspace_id=eq.${workspaceId}&select=costs&order=created_at.desc&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!r.ok) return notFoundFigure;
  const rows = (await r.json()) as Array<{ costs: Record<string, unknown> | null }>;
  return rows[0]?.costs ?? notFoundFigure;
}

// a2ea1529 item 10 (W1, Day 227): legal pages read the SAME legal-worker output the report page
// already renders (36de4e90 item 16) -- required_documents is what decides which EXTRA pages
// apply (cookie notice, Impressum), never guessed from the workspace alone. A local, minimal type
// rather than importing validator-view.ts's private RequiredDoc -- only `name` is read here.
type RequiredDocLite = { name?: string; why?: string; applies_because?: string };
async function getLatestValidatorLegal(workspaceId: string, env: Env): Promise<{ requiredDocs: RequiredDocLite[] }> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/validator_runs?workspace_id=eq.${workspaceId}&select=required_documents&order=created_at.desc&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!r.ok) return { requiredDocs: [] };
  const rows = (await r.json()) as Array<{ required_documents: RequiredDocLite[] | null }>;
  return { requiredDocs: rows[0]?.required_documents ?? [] };
}

// a2ea1529 item 10: privacy and terms apply to every site; cookie-notice and impressum are
// CONDITIONAL -- generating them unconditionally would be exactly the "fake it" this file's own
// convention forbids elsewhere. Impressum also gates on country=DE directly (Cloud's own naming,
// "a German Impressum"), not only on legal-worker having said so, since a DE workspace with no
// validator run yet (or one legal-worker has not reached) still needs one under German law.
const LEGAL_DOC_TYPES: Array<[string, string]> = [
  ["privacy", "Privacy Policy"],
  ["terms", "Terms of Service"],
  ["cookie-notice", "Cookie Notice"],
  ["impressum", "Impressum"],
];
function legalDocApplies(doc: string, workspace: Workspace, requiredDocs: RequiredDocLite[]): boolean {
  if (doc === "privacy" || doc === "terms") return true;
  const mentioned = (needle: string) => requiredDocs.some((d) => (d.name || "").toLowerCase().includes(needle));
  if (doc === "cookie-notice") return mentioned("cookie");
  if (doc === "impressum") return workspace.country === "DE" || mentioned("impressum");
  return false;
}

// Boilerplate, deliberately plain -- every render carries the "starting template, review before
// use, not legal advice" line ABOVE the generated text (item 10's own words), never inside it.
function generateLegalContent(doc: string, workspace: Workspace): { heading: string; body: string } {
  const name = workspace.trading_name || workspace.display_name || "This business";
  const contact = workspace.contact_email || "the contact address on this site";
  const address = workspace.address || "our registered address (not yet provided)";
  const countryName = COUNTRIES.find(([code]) => code === workspace.country)?.[1] || "the country this business operates in";
  if (doc === "privacy") {
    return {
      heading: "Privacy Policy",
      body:
        `${name} collects only the information you give us directly (for example, your name and email when you contact us or request a quote), plus standard technical data any website receives ` +
        `(such as IP address and browser type) needed to operate the site.\n\n` +
        `We use this information to respond to you, run our business, and meet our legal obligations under the laws of ${countryName}. We do not sell your personal information.\n\n` +
        `You can ask us what we hold about you, ask us to correct it, or ask us to delete it, by contacting ${contact}.`,
    };
  }
  if (doc === "terms") {
    return {
      heading: "Terms of Service",
      body:
        `By using this site or engaging ${name}, you agree to these terms. ${name} provides its services as described on this site; details, pricing and availability may change and will be ` +
        `confirmed with you directly before any work begins.\n\n` +
        `${name} is not liable for indirect or consequential loss arising from use of this site or our services, to the extent permitted under the laws of ${countryName}.\n\n` +
        `Questions about these terms: ${contact}.`,
    };
  }
  if (doc === "cookie-notice") {
    return {
      heading: "Cookie Notice",
      body:
        `This site may use cookies or similar technology for functionality beyond what is strictly necessary to run it. Where that is the case, we ask for your consent before setting them, ` +
        `and you can withdraw that consent at any time. Contact ${contact} with any questions about how we use cookies.`,
    };
  }
  // impressum
  return {
    heading: "Impressum",
    body:
      `Angaben gemäß § 5 TMG (information required under German law):\n\n` +
      `${name}\n${address}\n\n` +
      `Kontakt / Contact: ${contact}`,
  };
}

// 36de4e90 item 14 (W1, Day 227), moved to W1 from Silver's queue (3e5b42b8): "Your reports" --
// every run for the workspace, newest first, with idea, date, status, score and verdict_line,
// each linking to its report.
type ValidatorRunSummary = {
  id: string;
  idea_text: string | null;
  created_at: string;
  status: string;
  score: number | null;
  verdict_line: string | null;
};
async function getValidatorRuns(workspaceId: string, env: Env): Promise<ValidatorRunSummary[]> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/validator_runs?workspace_id=eq.${workspaceId}&select=id,idea_text,created_at,status,score,verdict_line&order=created_at.desc`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  return r.ok ? ((await r.json()) as ValidatorRunSummary[]) : [];
}

// Created lazily on first visit, never by a trigger -- schema.sql's own comment: an empty plan
// is a legitimate starting state the user edits INTO existence, not a signup side effect.
// The DB DEFAULT for break_even is '{}' (schema.sql), not the full
// {assumptions,monthly_revenue,monthly_costs,months_to_break_even} shape the TS type BusinessPlan
// claims -- a freshly-created row (and any row from before this column had real data) comes back
// with break_even={} and NO .assumptions array. Caught live: plan.break_even.assumptions.find()
// threw on every first visit, a 500 the typecheck could never catch because it only checks the
// TYPE ANNOTATION, never the actual shape Postgres returns for an unset jsonb default. Every read
// path normalizes through here so the render code can trust the full shape unconditionally.
function normalizeBusinessPlan(row: Partial<BusinessPlan> & { workspace_id: string }): BusinessPlan {
  return {
    workspace_id: row.workspace_id,
    elevator_pitch: row.elevator_pitch ?? "",
    cost_estimate: row.cost_estimate ?? {},
    break_even: {
      assumptions: row.break_even?.assumptions ?? [],
      monthly_revenue: row.break_even?.monthly_revenue ?? 0,
      monthly_costs: row.break_even?.monthly_costs ?? 0,
      months_to_break_even: row.break_even?.months_to_break_even ?? null,
    },
    source_run_id: row.source_run_id ?? null,
    user_edited: row.user_edited ?? false,
    current_monthly_revenue: row.current_monthly_revenue ?? null,
    current_monthly_costs: row.current_monthly_costs ?? null,
    revenue_target: row.revenue_target ?? null,
  };
}

async function getOrCreateBusinessPlan(workspaceId: string, env: Env): Promise<BusinessPlan> {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/business_plans?workspace_id=eq.${workspaceId}&select=*`, { headers });
  const rows = r.ok ? ((await r.json()) as BusinessPlan[]) : [];
  if (rows[0]) return normalizeBusinessPlan(rows[0]);
  const created = await fetch(`${env.SUPABASE_URL}/rest/v1/business_plans`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  const createdRows = created.ok ? ((await created.json()) as BusinessPlan[]) : [];
  return normalizeBusinessPlan(createdRows[0] ?? { workspace_id: workspaceId });
}

// Same class as normalizeBusinessPlan above: seo_keywords defaults to '{}' at the DB, not
// {title:[],description:[],headings:[]} -- a fresh row's seo_keywords.title would be undefined
// and .join() would throw. Normalized here rather than trusting the DB default to match the type.
function normalizeMarketingPlan(row: Partial<MarketingPlan> & { workspace_id: string }): MarketingPlan {
  return {
    workspace_id: row.workspace_id,
    posting_goals: row.posting_goals ?? {},
    target_keywords: row.target_keywords ?? [],
    seo_keywords: {
      title: row.seo_keywords?.title ?? [],
      description: row.seo_keywords?.description ?? [],
      headings: row.seo_keywords?.headings ?? [],
    },
    bid_keywords: row.bid_keywords ?? [],
    source_run_id: row.source_run_id ?? null,
    user_edited: row.user_edited ?? false,
  };
}

async function getOrCreateMarketingPlan(workspaceId: string, env: Env): Promise<MarketingPlan> {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/marketing_plans?workspace_id=eq.${workspaceId}&select=*`, { headers });
  const rows = r.ok ? ((await r.json()) as MarketingPlan[]) : [];
  if (rows[0]) return normalizeMarketingPlan(rows[0]);
  const created = await fetch(`${env.SUPABASE_URL}/rest/v1/marketing_plans`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=representation" },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  const createdRows = created.ok ? ((await created.json()) as MarketingPlan[]) : [];
  return normalizeMarketingPlan(createdRows[0] ?? { workspace_id: workspaceId });
}

// item 3: every save also appends a plan_versions row (service role only, append-only per
// schema.sql -- "a version history a user could rewrite is not a history").
async function savePlanVersion(workspaceId: string, planType: "business" | "marketing", content: unknown, env: Env): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/plan_versions`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ workspace_id: workspaceId, plan_type: planType, content }),
  });
}

async function getPlanVersions(workspaceId: string, planType: "business" | "marketing", env: Env): Promise<Array<{ id: string; created_at: string }>> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/plan_versions?workspace_id=eq.${workspaceId}&plan_type=eq.${planType}&select=id,created_at&order=created_at.desc&limit=10`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  return r.ok ? ((await r.json()) as Array<{ id: string; created_at: string }>) : [];
}

// f73d589b item 6 (W1, Day 227): the LATEST plan_jobs row for a workspace drives the
// Generating/failed banner on the plan pages -- never a single mutable row (Silver's shape,
// b8af096c: "a workspace can have many jobs over time, each regenerate is a new row").
// 696d3b4c item 3 (W1, Day 227): source_run_id is nullable and source_kind names which branch a
// job took, since a start_screen job has no run to read at all.
type PlanJob = { id: string; source_run_id: string | null; source_kind: string; status: string; error: string | null; created_at: string };
async function getLatestPlanJob(workspaceId: string, env: Env): Promise<PlanJob | null> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/plan_jobs?workspace_id=eq.${workspaceId}&select=id,source_run_id,source_kind,status,error,created_at&order=created_at.desc&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as PlanJob[];
  return rows[0] ?? null;
}

function planGeneratingBannerHtml(job: PlanJob): string {
  const fromWhat = job.source_kind === "start_screen" ? "your business details" : "your idea validation run";
  if (job.status === "queued" || job.status === "generating" || job.status === "queued_over_cap") {
    const msg =
      job.status === "queued_over_cap"
        ? "Queued -- today's generation quota is used, this will run automatically once it resets."
        : `Generating your plan from ${fromWhat}… this page will refresh automatically.`;
    return `<div class="card"><p><strong>${esc(msg)}</strong></p></div><meta http-equiv="refresh" content="5">`;
  }
  if (job.status === "failed") {
    return (
      `<div class="card"><p><strong>Generation failed.</strong> ${esc(job.error || "No reason recorded.")}</p>` +
      `<form method="post" action="/dashboard/plans/generate">` +
      (job.source_run_id ? `<input type="hidden" name="source_run_id" value="${esc(job.source_run_id)}">` : "") +
      `<button type="submit">Try again</button></form></div>`
    );
  }
  return "";
}

// ── 2df0e973: generic ordered page_sections (W1, Day 227) ──────────────────────────────────
// Cloud's ruling (bead0b30, option b): a generic ordered page_sections model, workspace-scoped
// per (workspace_id, page), replacing the bespoke business_plans.plan_sections column -- the
// heading+body card list is what moves; elevator_pitch and break_even stay typed columns (see
// migrations/2df0e973-page-sections.sql's own comment for why: break_even carries real computed
// structure a generic {type,content} row would only re-special-case).
type PageSection = { id?: string; position: number; type: string; content: Record<string, unknown> };

async function getPageSections(workspaceId: string, page: string, env: Env): Promise<PageSection[]> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/page_sections?workspace_id=eq.${workspaceId}&page=eq.${page}&select=id,position,type,content&order=position.asc`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  return r.ok ? ((await r.json()) as PageSection[]) : [];
}

// REPLACE-ALL semantics: delete every existing row for (workspace_id, page), insert the new
// ordered list, then append one page_section_versions snapshot -- simplest correct approach at
// this scale (a handful of sections per page), and it makes "save with no change round-trips
// byte-identical" (2df0e973 item 2) trivially true, since the snapshot IS what was just written,
// not a derived diff that could drift from it.
async function savePageSections(workspaceId: string, page: string, sections: PageSection[], env: Env): Promise<void> {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
  await fetch(`${env.SUPABASE_URL}/rest/v1/page_sections?workspace_id=eq.${workspaceId}&page=eq.${page}`, {
    method: "DELETE",
    headers,
  });
  if (sections.length) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/page_sections`, {
      method: "POST",
      headers,
      body: JSON.stringify(sections.map((s) => ({ workspace_id: workspaceId, page, position: s.position, type: s.type, content: s.content }))),
    });
  }
  await fetch(`${env.SUPABASE_URL}/rest/v1/page_section_versions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspace_id: workspaceId, page, content: sections }),
  });
}

// Vanilla-JS autosave, matching this repo's "no build step yet" constraint (top of file):
// serialises the form on every change, debounced, POSTs as JSON to the same path, and shows a
// small inline status. A plain <button type=submit> stays as the no-JS fallback -- the same
// route accepts both a JSON body and a normal form POST.
const AUTOSAVE_SCRIPT = stripServedComments(`
<script>
(function(){
  var form = document.getElementById('plan-form');
  var status = document.getElementById('save-status');
  var timer = null;
  function save(){
    status.textContent = 'Saving…';
    var data = {};
    new FormData(form).forEach(function(v, k){ data[k] = v; });
    fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    }).then(function(r){ status.textContent = r.ok ? 'Saved' : 'Could not save'; })
      .catch(function(){ status.textContent = 'Could not save (offline?)'; });
  }
  form.addEventListener('input', function(){
    status.textContent = 'Editing…';
    clearTimeout(timer);
    timer = setTimeout(save, 900);
  });
  form.addEventListener('submit', function(e){ e.preventDefault(); clearTimeout(timer); save(); });
})();
</script>`);

// ── competitor basics, non-LLM: fetch the page, read <title> and meta description. Every
// figure follows the SAME sourced_figure shape the eventual LLM-scored fields use --
// {value, source, as_of} or {not_found: true} -- so this function's output and the step
// library's typed_outputs agree on one contract from day one.
async function fetchCompetitorBasics(competitorUrl: string): Promise<Record<string, unknown>> {
  const now = new Date().toISOString().slice(0, 10);
  const sourced = (value: unknown) => ({ value, source: competitorUrl, as_of: now });
  const notFound = { not_found: true };
  try {
    const r = await fetch(competitorUrl, { headers: { "user-agent": "bizbox-challenge/0 (+https://bizbox.meridianxm.com)" } });
    if (!r.ok) return { name: competitorUrl, page_title: notFound, page_description: notFound, http_status: sourced(r.status) };
    const html = await r.text();
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    return {
      name: titleMatch ? titleMatch[1].trim() : competitorUrl,
      page_title: titleMatch ? sourced(titleMatch[1].trim()) : notFound,
      page_description: descMatch ? sourced(descMatch[1].trim()) : notFound,
      http_status: sourced(r.status),
      // every other field the eventual LLM scoring step would fill -- market_cap, team_size,
      // funding, revenue, social_presence -- is EXPLICITLY not_found here, never omitted, so a
      // reader of this row sees "not yet assessed" rather than a field that silently never
      // existed (this file's own §6: a missing state must be visible, not absent).
      market_cap: notFound, team_size: notFound, age: notFound, funding: notFound, revenue: notFound,
      app_store_presence: notFound,
      social_presence: Object.fromEntries(["youtube", "tiktok", "instagram", "x", "facebook"].map((p) => [p, notFound])),
    };
  } catch (e) {
    return { name: competitorUrl, page_title: notFound, page_description: notFound, fetch_error: sourced(String(e)) };
  }
}

// ── a2ea1529 item 5: the Worker-side half of capture_lead's rate limit (W1, Day 227) ───────
// Silver's own bound on the migration (a2ea1529-leads.sql): "the per-IP limit is best-effort
// and forgeable [until] a Worker route supplies the hash from CF-Connecting-IP server-side".
// This IS that route. HMAC, not a bare SHA-256 of the IP -- an IPv4 address space is small
// enough that an unsalted hash is reversible by brute force, which would defeat "we do not
// store the address" in spirit even though not in the literal column.
async function hashIp(ip: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── pages (inline HTML -- no build step yet; a template engine is a stretch, not piece 0) ──
// ── login page, styled to match the home page (a2ea1529 style 3), not the generic page()
// helper below -- Cloud's follow-up, Day 227 12:0xZ. Deliberately its OWN function rather than
// re-theming page() globally: dashboard/admin/validator all use page() and were not asked for.
// ── shared theme (Darren, Day 227 12:2xZ): ONE stylesheet every route inherits through page(),
// not per-page CSS -- same palette as the home page (a2ea1529 style 3). page()'s callers do not
// need to change to get this; only the few pages that need a specific header link (Dashboard,
// Account, Sign out) pass a navRight override.
// ⛔ ‼ SECURITY, Cloud Day 227 14:2xZ: a `/* ... */` CSS comment written INSIDE this template
// literal is not an internal note -- it is SERVED, verbatim, in the <style> tag of every page()
// route, publicly, unauthenticated (bin/public-leak-check.py caught it live on /login). The same
// applies to any comment inside HOME_PAGE_HTML, readaloud.ts's script strings, or any other
// served string in src/: nothing that names a body, a day, a brief id or a commit goes inside a
// template literal that reaches a Response body. Every explanation about THIS block lives here,
// as an ordinary TypeScript comment outside the backticks, never inside them.
// (.bb-footer below: SITE_CSS never carried it before item 14 added the shared footer to every
// page() route; contained/centred/themed here since the footer is not inside .wrap.)
// .report-row/.report-meta/.report-verdict (item 14, "Your reports" list): a row per report,
// matching .tile's hover feel -- this note is OUTSIDE the string for exactly the reason above.
// .choice-card/.tool-check (696d3b4c item 1 fix, Cloud's review): the earlier /start markup
// relied on the plain `.card` class, whose `.card input{width:100%}` rule (below, for text
// fields) also stretched every radio/checkbox to full width -- that is what put the control
// centred above its own label instead of beside it. These two classes give the start-screen
// controls their own layout instead of overriding the shared one.
const SITE_CSS = stripServedComments(`
  :root{--bg:#FFF8EF;--panel:#FFFFFF;--ink:#22303A;--muted:#5C6B76;--accent:#FF7A45;--accent2:#2FB8A6;--accent3:#FFC94D;--rule:#F0E4D2;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Trebuchet MS",Verdana,sans-serif}
  a{color:var(--ink)}
  .wrap{max-width:720px;margin:0 auto;padding:24px}
  .topnav{background:var(--panel);border-bottom:1px solid var(--rule)}
  .topnav .inner{max-width:720px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  .topnav .brand{font-weight:800;font-size:18px;text-decoration:none;color:var(--ink)}
  .topnav .navright{display:flex;gap:16px;align-items:center;font-size:14px}
  .topnav .navright a{text-decoration:none;color:var(--muted);font-weight:700}
  .topnav .navright a:hover{color:var(--ink)}
  h1{font-size:26px;font-weight:800;margin:0 0 10px}
  p{color:var(--muted);line-height:1.5}
  input,textarea,select{width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--rule);border-radius:10px;
    margin-bottom:12px;box-sizing:border-box;font-family:inherit;background:#fff;color:var(--ink)}
  button,.btn{display:inline-block;padding:10px 22px;font-size:15px;font-weight:800;color:#fff;background:var(--accent);
    border:none;border-radius:999px;cursor:pointer;box-shadow:0 5px 0 0 #C85A2C;text-decoration:none}
  .btn-secondary{background:var(--panel);color:var(--ink);border:1px solid var(--rule);box-shadow:none}
  .tiles{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px}
  @media(max-width:520px){.tiles{grid-template-columns:1fr}}
  .tile{display:block;border-radius:16px;padding:18px;background:var(--panel);box-shadow:0 4px 0 0 var(--rule);text-decoration:none;color:var(--ink);cursor:pointer;transition:transform .08s,box-shadow .08s}
  .tile:hover{transform:translateY(2px);box-shadow:0 2px 0 0 var(--rule)}
  .tile strong::after{content:" →";color:var(--accent);font-weight:400}
  table{border-collapse:collapse;width:100%}
  table td,table th{border:1px solid var(--rule);padding:8px 10px;text-align:left;font-size:14px}
  .card{background:var(--panel);border-radius:20px;padding:24px;margin-bottom:18px;box-shadow:0 4px 0 0 var(--rule)}
  .muted{color:var(--muted);font-size:13px}
  .report-row{display:flex;flex-direction:column;gap:4px;text-decoration:none;color:var(--ink);transition:transform .08s,box-shadow .08s}
  .report-row:hover{transform:translateY(2px);box-shadow:0 2px 0 0 var(--rule)}
  .report-row strong{font-size:15px}
  .report-meta{font-size:13px;color:var(--muted)}
  .report-verdict{font-size:13.5px;color:var(--ink)}
  ${VALIDATOR_VIEW_CSS}
  ${READALOUD_CSS}
  ${BLOCKEDIT_CSS}
  .dropzone{border:2px dashed var(--rule);border-radius:16px;padding:28px 18px;text-align:center;margin-bottom:14px;transition:background .15s,border-color .15s}
  .dropzone.drag{background:var(--panel);border-color:var(--accent)}
  .dropzone .filelist{list-style:none;margin:14px 0 0;padding:0;text-align:left}
  .dropzone .filelist li{display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:var(--panel);border-radius:8px;margin-bottom:6px;font-size:13px}
  .dropzone .filelist button{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;padding:0 4px;line-height:1}
  .bb-footer{max-width:720px;margin:24px auto 0;padding:24px;text-align:center;color:var(--muted);font-size:13px}
  .bb-footer-links{display:flex;flex-wrap:wrap;gap:16px;justify-content:center;margin-bottom:10px}
  .bb-footer-links a{color:var(--muted);text-decoration:none}
  .bb-footer-links a:hover{color:var(--ink);text-decoration:underline}
  @media(max-width:480px){.bb-footer{padding:20px 16px}.bb-footer-links{gap:10px 14px}}
  .choice-card{display:flex;align-items:flex-start;gap:14px;cursor:pointer;border:2px solid var(--rule);border-radius:20px;padding:18px 20px;margin-bottom:12px;background:var(--panel);transition:border-color .08s,background .08s}
  .choice-card input[type=radio]{width:auto;flex-shrink:0;margin-top:5px}
  .choice-card:has(input:checked){border-color:var(--accent2);background:#F0FBF9}
  .tool-check{display:inline-flex;align-items:center;gap:6px;margin:0 16px 8px 0;cursor:pointer}
  .tool-check input[type=checkbox]{width:auto;margin:0}
`);

// ── site chrome as DATA (0c7abc2e item 14, W1, Day 227) ────────────────────────────────────
// Darren, bench 12:3xZ, locked: the product's pages render from one shared header and one
// footer, with menu/footer items stored as data -- no hand-written static nav/footer HTML.
// Fetched fresh on every request (no cache, no KV): the whole point of the proof this item asks
// for is that a row edit shows up on the next page load with NO redeploy, which a cached copy
// would defeat. Read via the anon key against `nav_items`/`footer_items`, both `select using
// (true)` (schema.sql), same RLS shape as `steps` -- readable by anyone, written only by the
// service role (nothing in this Worker writes to either table).
type ChromeItem = { label: string; href: string };
async function getSiteChrome(env: Env): Promise<{ nav: ChromeItem[]; footer: ChromeItem[] }> {
  const headers = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` };
  // Cloud's catch (82c0368d), on Silver's predeploy-check work: a bad HTTP status fails open
  // (below), but a NETWORK-LEVEL rejection -- Supabase unreachable, DNS failure, timeout -- makes
  // `fetch()` itself REJECT, and `.catch(() => null)` is what stops that reaching Promise.all as
  // an uncaught rejection. Without it, every page that renders the header/footer 500s instead of
  // falling back the moment Supabase is unreachable, which is exactly the condition this fallback
  // exists for.
  const safeFetch = (u: string) => fetch(u, { headers }).catch(() => null);
  const [navRes, footerRes] = await Promise.all([
    safeFetch(`${env.SUPABASE_URL}/rest/v1/nav_items?select=label,href&order=sort_order.asc`),
    safeFetch(`${env.SUPABASE_URL}/rest/v1/footer_items?select=label,href&order=sort_order.asc`),
  ]);
  // Fails OPEN to the pre-migration hardcoded values, never to an empty/broken chrome -- a
  // transient Supabase error must not blank out every page's nav and footer.
  const nav = navRes && navRes.ok ? ((await navRes.json()) as ChromeItem[]) : [{ label: "BizXM", href: "/" }];
  const footer = footerRes && footerRes.ok
    ? ((await footerRes.json()) as ChromeItem[])
    : [
        { label: "meridianxm.com", href: "https://meridianxm.com" },
        { label: "duoxm.com", href: "https://duoxm.com" },
        { label: "bizxm.com", href: "https://bizxm.com" },
        { label: "statefulxm.com", href: "https://statefulxm.com" },
        { label: "youtube.com/@meridianxm", href: "https://youtube.com/@meridianxm" },
        { label: "x.com/MeridianXM", href: "https://x.com/MeridianXM" },
        { label: "instagram.com/meridianxm", href: "https://instagram.com/meridianxm" },
      ];
  return { nav: nav.length ? nav : [{ label: "BizXM", href: "/" }], footer };
}

// First nav_items row renders as the brand link (top-left, same slot the hardcoded "BizXM" link
// held); any further rows render as plain links ahead of the auth-dependent navRight slot.
// navRight itself stays code, not data -- it depends on session state (Log in vs Dashboard),
// which is not a static "menu item" any row could express.
function renderNav(nav: ChromeItem[], navRight: string): string {
  const [brand, ...rest] = nav;
  const extra = rest.map((i) => `<a href="${i.href}">${i.label}</a>`).join("");
  return `<nav class="topnav"><div class="inner"><a class="brand" href="${brand.href}">${brand.label}</a><div class="navright">${extra}${navRight}</div></div></nav>`;
}

function renderFooter(footer: ChromeItem[]): string {
  const links = footer.map((i) => `<a href="${i.href}" style="color:#5C6B76">${i.label}</a>`).join("\n    ");
  return `<footer class="bb-footer">\n  <div class="bb-footer-links">\n    ${links}\n  </div>\n  <p class="bb-footer-copy">BizXM — a MeridianXM product.</p>\n</footer>`;
}

// Auth-area pages (login/callback errors) never assume signed-in state -- an empty navRight,
// never a stale "Log in" shown to someone who is (or might already be) signed in.
const NAV_NONE = "";
const NAV_DASHBOARD = `<a href="/dashboard">Dashboard</a>`;

async function loginPage(env: Env): Promise<Response> {
  const chrome = await getSiteChrome(env);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Log in — BizXM</title>` +
      `<style>${SITE_CSS}
        body{min-height:100vh}
        .center{min-height:calc(100vh - 60px);display:flex;align-items:center;justify-content:center;padding:24px}
        .authcard{background:var(--panel);border-radius:24px;padding:36px;max-width:380px;width:100%;
          box-shadow:0 6px 0 0 var(--rule)}
        .authcard h1{margin:0 0 6px;font-size:28px}
        .authcard p{font-size:14.5px;margin:0 0 20px}
        .authcard button{width:100%}
        .or{text-align:center;color:var(--muted);font-size:13px;margin:18px 0}
        .google{display:block;text-align:center;padding:10px;border:1px solid var(--rule);border-radius:999px;
          color:var(--ink);text-decoration:none;font-weight:700}
      </style></head><body>
      ${renderNav(chrome.nav, NAV_NONE)}
      <div class="center"><div class="authcard">
        <h1>BizXM</h1>
        <p>Idea to launched business, in one place.</p>
        <form method="post" action="/auth/login">
          <input type="email" name="email" placeholder="you@example.com" required>
          <button type="submit">Send me a sign-in link</button>
        </form>
        <div class="or">or</div>
        <a class="google" href="${GOOGLE_LOGIN_PATH}">Sign in with Google</a>
        <p class="muted" style="text-align:center;margin-top:16px"><a href="/login/password">Sign in with a password</a></p>
      </div></div>
      ${renderFooter(chrome.footer)}
      </body></html>`,
    { headers: { "content-type": "text/html;charset=utf-8" } }
  );
}

// Cloud, Day 227 12:3xZ: the fleet-only password route existed as an API endpoint
// (/auth/login/password, POST) with no reachable UI -- Darren asked for a BASIC email-and-
// password login for the fleet, which needs a form a body can actually load. Same allowlist as
// every other path; this is not a second door, it is a visible handle on the one that already
// existed.
async function passwordLoginPage(env: Env): Promise<Response> {
  const chrome = await getSiteChrome(env);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in with a password — BizXM</title>` +
      `<style>${SITE_CSS}
        body{min-height:100vh}
        .center{min-height:calc(100vh - 60px);display:flex;align-items:center;justify-content:center;padding:24px}
        .authcard{background:var(--panel);border-radius:24px;padding:36px;max-width:380px;width:100%;
          box-shadow:0 6px 0 0 var(--rule)}
        .authcard h1{margin:0 0 6px;font-size:28px}
        .authcard p{font-size:14.5px;margin:0 0 20px}
        .authcard button{width:100%}
      </style></head><body>
      ${renderNav(chrome.nav, NAV_NONE)}
      <div class="center"><div class="authcard">
        <h1>Sign in with a password</h1>
        <p>For the fleet test account only -- everyone else uses the sign-in link or Google.</p>
        <form method="post" action="/auth/login/password">
          <input type="email" name="email" placeholder="you@example.com" required>
          <input type="password" name="password" placeholder="Password" required>
          <button type="submit">Sign in</button>
        </form>
        <p class="muted" style="text-align:center;margin-top:16px"><a href="/login">&larr; Back</a></p>
      </div></div>
      ${renderFooter(chrome.footer)}
      </body></html>`,
    { headers: { "content-type": "text/html;charset=utf-8" } }
  );
}

async function page(env: Env, title: string, body: string, navRight?: string): Promise<Response> {
  const chrome = await getSiteChrome(env);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<style>${SITE_CSS}</style></head>` +
      `<body>${renderNav(chrome.nav, navRight ?? NAV_NONE)}<div class="wrap">${body}</div>${renderFooter(chrome.footer)}</body></html>`,
    { headers: { "content-type": "text/html;charset=utf-8" } }
  );
}

// Cloud, Day 227 12:4xZ (964be469), low priority after item 14: the old 6th tile read
// "Sign up / You are here" while ALREADY on the dashboard -- signing up is what got the visitor
// here, never a next step from here, so it read as a dead loop rather than an action. Replaced
// with the one destination the dashboard did not yet surface as a tile (Account, already a real
// page). Every tile now either goes to a built step (validator, account) or is explicitly
// labelled "(coming soon)" -- Cloud's own wording, never left ambiguous by an unmarked stub.
// a2ea1529 item 11 (W1, Day 227), FIRST SLICE per Cloud's (b): only the picked style (style 3,
// BizXM) gets a real render function now; the other three styles are follow-ons, not blockers.
// Same structure model as item 14's chrome and 2df0e973's page_sections: a site is page_sections
// rows (page='site-home') rendered by ONE template, so switching style later never rewrites
// content -- only which function reads the same rows changes.
// a2ea1529 item 9 (W1, Day 227): flavour section by business_type. product/digital name a real
// unbuilt piece (the store is a separate child, 2cd822dd; pricing plans do not exist yet) and
// say so plainly rather than fake a working feature -- coding-discipline's own rule (a missing
// state must be visible, not absent). service gets something REAL: a quote-request form that
// posts to the /leads proxy already built and driven (a2ea1529 item 5), so "service gets booking
// or quote requests" is not a placeholder for this flavour, it is a working feature reusing
// infrastructure that already exists.
function renderFlavourSection(workspace: Workspace, leadStatus: string | null): string {
  if (workspace.business_type === "service") {
    const banner =
      leadStatus === "ok"
        ? `<p class="lead-ok">Thanks -- your request has been sent.</p>`
        : leadStatus === "error"
        ? `<p class="lead-error">That did not go through. Please try again.</p>`
        : "";
    return (
      `<div class="card"><h2>Request a quote</h2>${banner}` +
      `<form method="post" action="/leads">` +
      `<input type="hidden" name="workspace_id" value="${workspace.id}">` +
      `<input type="hidden" name="source_path" value="/site/${workspace.id}">` +
      `<input type="hidden" name="redirect_to" value="/site/${workspace.id}">` +
      `<input type="text" name="name" placeholder="Your name">` +
      `<input type="email" name="email" placeholder="you@example.com" required>` +
      `<textarea name="message" rows="3" placeholder="What do you need?"></textarea>` +
      `<button type="submit">Send</button>` +
      `</form></div>`
    );
  }
  if (workspace.business_type === "product") {
    return `<div class="card"><h2>Shop</h2><p>Online ordering for this business is coming soon.</p></div>`;
  }
  if (workspace.business_type === "digital") {
    return `<div class="card"><h2>Pricing</h2><p>Pricing plans for this business are coming soon.</p></div>`;
  }
  return "";
}

// 2df0e973 click-to-edit (W1, Day 227): `isOwner` is decided ONCE, server-side, before any of
// this renders -- a non-owner (including an anonymous visitor) gets exactly the read-only
// markup this function already produced, never the editor markup or its script.
function renderSiteStyle3(
  workspace: Workspace,
  sections: PageSection[],
  leadStatus: string | null = null,
  isOwner: boolean = false,
  applicableLegalDocs: Array<[string, string]> = []
): string {
  const brand = workspace.trading_name || workspace.display_name || "This business";
  const editSections: EditSection[] = sections.map((s) => ({
    heading: String(s.content.heading ?? ""),
    body: String(s.content.body ?? ""),
  }));
  const body =
    (isOwner
      ? editRootOpenHtml("site-home") +
        (editSections.length ? "" : `<p class="eb-empty">This site has nothing published yet -- add your first section below.</p>`) +
        editSections.map((s, i) => `<div class="card">${editableSectionHtml(s, i, editSections.length)}</div>`).join("") +
        editAddButtonHtml() +
        `</div>` +
        BLOCKEDIT_SCRIPT
      : sections.length
      ? sections
          .map(
            (s) =>
              `<div class="card"><h2>${String(s.content.heading ?? "").replace(/</g, "&lt;")}</h2>` +
              `<p>${String(s.content.body ?? "").replace(/</g, "&lt;")}</p></div>`
          )
          .join("")
      : `<div class="card"><p>This site has nothing published yet.</p></div>`) + renderFlavourSection(workspace, leadStatus);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${brand.replace(/</g, "&lt;")}</title>` +
    `<style>
      :root{--bg:#FFF8EF;--panel:#FFFFFF;--ink:#22303A;--muted:#5C6B76;--accent:#FF7A45;--accent2:#2FB8A6;--rule:#F0E4D2;}
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--ink);font-family:"Trebuchet MS",Verdana,sans-serif}
      .wrap{max-width:900px;margin:0 auto;padding:24px}
      .topnav{padding:20px 0}
      .topnav .brand{font-weight:800;font-size:20px;color:var(--ink);text-decoration:none}
      h1{font-size:38px;margin:10px 0 20px}
      .card{background:var(--panel);border-radius:20px;padding:24px;margin-bottom:18px;box-shadow:0 4px 0 0 var(--rule)}
      .card h2{margin:0 0 10px;color:var(--accent2)}
      .card p{color:var(--muted);line-height:1.55;margin:0}
      .card input,.card textarea{width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--rule);border-radius:10px;margin-bottom:10px;box-sizing:border-box;font-family:inherit;background:#fff;color:var(--ink)}
      .card button{display:inline-block;padding:10px 22px;font-size:15px;font-weight:800;color:#fff;background:var(--accent);border:none;border-radius:999px;cursor:pointer}
      .lead-ok{color:var(--accent2);font-weight:700}
      .lead-error{color:var(--accent);font-weight:700}
      ${BLOCKEDIT_CSS}
    </style></head><body>` +
    `<nav class="topnav"><div class="wrap"><a class="brand" href="/site/${workspace.id}">${brand.replace(/</g, "&lt;")}</a>${isOwner ? `<span style="float:right;font-size:13px;color:var(--muted)">Editing your site -- hover a section</span>` : ""}</div></nav>` +
    `<div class="wrap"><h1>${brand.replace(/</g, "&lt;")}</h1>${body}</div>` +
    // a2ea1529 item 10 (W1, Day 227): legal pages are only DISCOVERABLE from here when they
    // apply (legalDocApplies, computed by the caller) -- never a dead link to a 404.
    (applicableLegalDocs.length
      ? `<div class="wrap" style="padding-top:0"><p class="muted">` +
        applicableLegalDocs.map(([val, label]) => `<a href="/site/${workspace.id}/legal/${val}" style="color:var(--muted)">${label}</a>`).join(" &middot; ") +
        `</p></div>`
      : "") +
    `</body></html>`
  );
}

const SIX_STEPS = [
  ["Validate the idea", "/dashboard/validator", "Score and report on your idea"],
  ["Build the site", "/dashboard/site", "Edit your site's sections"],
  ["Market it", "/dashboard/marketing", "Connect X, draft and schedule posts (coming soon)"],
  ["Track the money", "/dashboard/accounting", "Receipts, invoices, a simple ledger (coming soon)"],
  ["Make content", "/dashboard/content", "Short videos for your business (coming soon)"],
  ["Your account", "/account", "Profile, sign-in method, subscription"],
];

// 696d3b4c item 7 (W1, Day 227): existing businesses (entry_point no_website/has_website) never
// see idea-validation wording. "Market research" (item 2) routes through the ordinary
// /dashboard/* catch-all's "Coming soon" page until Silver's worker lands -- not faked as built,
// per this file's own "gated, never a 404" convention two screens down. "Plans" reuses the same
// business/marketing plan pages the idea path's "Your plans" card already links to (f73d589b) --
// one pair of pages, reached two ways depending on entry point. "Website" differs by entry point:
// no_website goes to OUR site builder, has_website goes to item 6's platform-check flow instead
// (pushing an existing-site owner into building a NEW site here would be wrong).
function existingBusinessSteps(entryPoint: string | null): Array<[string, string, string]> {
  return [
    ["Market research", "/dashboard/market-research", "Where you stand and how to win"],
    ["Plans", "/dashboard/business-plan", "Business and marketing plans"],
    entryPoint === "has_website"
      ? ["Website", "/dashboard/website-check", "Your site's health, SEO and next steps"]
      : ["Website", "/dashboard/site", "Edit your site's sections"],
    ["Marketing", "/dashboard/marketing", "Connect X, draft and schedule posts (coming soon)"],
    ["Money", "/dashboard/accounting", "Receipts, invoices, a simple ledger (coming soon)"],
    ["Your account", "/account", "Profile, sign-in method, subscription"],
  ];
}

// Hoisted out of /dashboard/company (Day 227) so 696d3b4c item 1's start screen asks the SAME
// question with the SAME vocabulary -- one business_type column, one set of values, never two.
const BUSINESS_TYPE_OPTIONS: Array<[string, string]> = [
  ["", "Choose one"],
  ["product", "Product (physical goods)"],
  ["digital", "Digital (software, downloads, courses)"],
  ["service", "Service (consultants, trades, local businesses)"],
  ["mix", "A mix of the above"],
];
function businessTypeOptionsHtml(selected: string | null): string {
  return BUSINESS_TYPE_OPTIONS.map(
    ([val, label]) => `<option value="${val}"${selected === val ? " selected" : ""}>${label}</option>`
  ).join("");
}

// 696d3b4c item 3 (W1, Day 227): Cloud's sequencing rule -- ship the migration and trigger route
// first, keep the button that REACHES it hidden until Silver's plan-worker start_screen branch is
// live and one real job has gone to `done`. FLIPPED TRUE Day 227 17:2xZ: Silver confirmed live
// (63ee8b9), one real job driven end to end and verified by SELECT (source_run_id null,
// business_type correctly mapped, elevator_pitch reflecting the declared facts), Cloud accepted.
const EXISTING_BUSINESS_PLANS_TRIGGER_LIVE = true;

// 696d3b4c item 1: entry_point values and their post-answer destination. "no_website" lands on
// the existing site builder (a2ea1529 item 11), which already carries the item-5 quote-request
// section for service businesses. "has_website" lands on item 6's platform-check flow.
const ENTRY_POINTS: Array<[string, string, string]> = [
  ["idea", "I have an idea", "Validate it before you build anything."],
  ["no_website", "I already run a business, no website yet", "Get a site up and start taking bookings or quotes."],
  ["has_website", "I already run a business and have a website", "See where you stand and what to do next."],
];
const AI_TOOLS_OPTIONS: Array<[string, string]> = [
  ["none", "None"],
  ["chatgpt", "ChatGPT"],
  ["claude", "Claude"],
  ["grok", "Grok"],
  ["grok_bot", "Grok Bot"],
  ["other", "Other"],
];
function entryPointDestination(entryPoint: string): string {
  if (entryPoint === "idea") return "/dashboard/validator";
  if (entryPoint === "no_website") return "/dashboard/site";
  return "/dashboard/website-check";
}

// 696d3b4c item 6 (W1, Day 227): platform/host names shown on the has-a-website flow. The
// brief's own list, "custom" and "do not know" included -- never guessed from the URL.
const WEBSITE_PLATFORM_OPTIONS: Array<[string, string]> = [
  ["", "Choose one"],
  ["wordpress", "WordPress"],
  ["wix", "Wix"],
  ["squarespace", "Squarespace"],
  ["shopify", "Shopify"],
  ["custom", "Custom-built"],
  ["dont_know", "I don't know"],
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return new Response(JSON.stringify({ ok: true, piece: "0-foundation", stage: "app-shell" }), {
        headers: { "content-type": "application/json" },
      });
    }

    // ── c93cd200 item 1 (W1, Day 227): popup.bizxm.com, routed by host ─────────────────────────
    // SAME Worker and Supabase project as demo.bizxm.com (Cloud's explicit spec) -- checked by
    // hostname before any demo-specific route below, and delegated entirely to popup.ts (its own
    // file, on purpose: Sterling adds templates 2/3 there without touching this file's routes).
    if (url.hostname === "popup.bizxm.com") {
      return handlePopupRequest(req, env, path);
    }

    // ── a2ea1529 item 10 (W1, Day 227): legal pages on every user site ──────────────────────
    // PUBLIC, same as the site itself -- a visitor reading a privacy policy has no session.
    // Matched BEFORE the generic /site/<id> route below (its own naive slice would otherwise
    // treat "<id>/legal/<doc>" as one malformed workspace id and 404 it).
    {
      const legalMatch = path.match(/^\/site\/([^/]+)\/legal\/([a-z-]+)$/);
      if (legalMatch && req.method === "GET") {
        const [, workspaceId, doc] = legalMatch;
        const site = await getWorkspaceById(workspaceId, env);
        if (!site) return new Response("Site not found.", { status: 404 });
        if (!LEGAL_DOC_TYPES.some(([val]) => val === doc)) return new Response("Not found.", { status: 404 });
        const { requiredDocs } = await getLatestValidatorLegal(workspaceId, env);
        if (!legalDocApplies(doc, site, requiredDocs)) {
          return new Response("This page does not apply to this site.", { status: 404 });
        }
        const pageKey = `legal-${doc}`;
        let sections = await getPageSections(workspaceId, pageKey, env);
        if (!sections.length) {
          const generated = generateLegalContent(doc, site);
          sections = [{ position: 0, type: "heading_body", content: generated }];
          await savePageSections(workspaceId, pageKey, sections, env);
        }
        const editSections: EditSection[] = sections.map((s) => ({ heading: String(s.content.heading ?? ""), body: String(s.content.body ?? "") }));
        const viewer = await getUser(req, env);
        const isOwner = !!viewer && viewer.id === site.owner_user_id;
        const brand = site.trading_name || site.display_name || "This business";
        const docLabel = LEGAL_DOC_TYPES.find(([val]) => val === doc)?.[1] ?? doc;
        const body =
          `<p class="muted"><strong>Starting template -- review before use, this is not legal advice.</strong></p>` +
          (isOwner
            ? editRootOpenHtml(pageKey) +
              editSections.map((s, i) => `<div class="card">${editableSectionHtml(s, i, editSections.length)}</div>`).join("") +
              editAddButtonHtml() +
              `</div>` +
              BLOCKEDIT_SCRIPT
            : editSections
                .map(
                  (s) =>
                    `<div class="card"><h2>${esc(s.heading)}</h2><p style="white-space:pre-line">${esc(s.body)}</p></div>`
                )
                .join(""));
        return new Response(
          `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(docLabel)} — ${esc(brand)}</title>` +
            `<style>
              :root{--bg:#FFF8EF;--panel:#FFFFFF;--ink:#22303A;--muted:#5C6B76;--accent:#FF7A45;--accent2:#2FB8A6;--rule:#F0E4D2;}
              *{box-sizing:border-box}
              body{margin:0;background:var(--bg);color:var(--ink);font-family:"Trebuchet MS",Verdana,sans-serif}
              .wrap{max-width:720px;margin:0 auto;padding:24px}
              .topnav{padding:20px 0}
              .topnav .brand{font-weight:800;font-size:18px;color:var(--ink);text-decoration:none}
              h1{font-size:26px;margin:10px 0 20px}
              .card{background:var(--panel);border-radius:20px;padding:24px;margin-bottom:18px;box-shadow:0 4px 0 0 var(--rule)}
              .card h2{margin:0 0 10px;color:var(--accent2)}
              .card p{color:var(--muted);line-height:1.55;margin:0}
              .card textarea,.card input{width:100%;padding:10px 12px;font-size:15px;border:1px solid var(--rule);border-radius:10px;margin-bottom:10px;box-sizing:border-box;font-family:inherit;background:#fff;color:var(--ink)}
              .muted{color:var(--muted);font-size:13px}
              ${BLOCKEDIT_CSS}
            </style></head><body>` +
            `<nav class="topnav"><div class="wrap"><a class="brand" href="/site/${esc(site.id)}">${esc(brand)}</a></div></nav>` +
            `<div class="wrap"><h1>${esc(docLabel)}</h1>${body}</div>` +
            `</body></html>`,
          { headers: { "content-type": "text/html;charset=utf-8" } }
        );
      }
    }

    // ── a2ea1529 item 11: PUBLIC user site (W1, Day 227) ────────────────────────────────────
    // No auth -- a published site is meant to be publicly reachable. /site/<id> today, a
    // subdomain is item 6 (stretch, not this piece). Only style 3 is wired (Cloud's (b): the
    // picked style first, the other three are follow-ons).
    if (path.startsWith("/site/") && req.method === "GET") {
      const workspaceId = path.slice("/site/".length);
      const site = await getWorkspaceById(workspaceId, env);
      if (!site) return new Response("Site not found.", { status: 404 });
      const sections = await getPageSections(workspaceId, "site-home", env);
      const leadStatus = url.searchParams.get("lead");
      // 2df0e973 click-to-edit (W1, Day 227): a session cookie is optional on this route (most
      // visitors have none) -- getUser() returns null fast when there is no cookie, so this
      // costs an extra GoTrue round trip only for a signed-in viewer, never for the public.
      const viewer = await getUser(req, env);
      const isOwner = !!viewer && viewer.id === site.owner_user_id;
      // a2ea1529 item 10 (W1, Day 227): which legal pages apply, for the footer links.
      const { requiredDocs } = await getLatestValidatorLegal(workspaceId, env);
      const applicableLegalDocs = LEGAL_DOC_TYPES.filter(([val]) => legalDocApplies(val, site, requiredDocs));
      return new Response(renderSiteStyle3(site, sections, leadStatus, isOwner, applicableLegalDocs), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    // ── 2df0e973 click-to-edit save (W1, Day 227) ───────────────────────────────────────────
    // ONE generic endpoint for every block-editor action (finish editing, add, remove, move) --
    // page_sections is REPLACE-ALL (savePageSections), so there is no per-row PATCH; the client
    // always sends the FULL current ordered list and this re-derives position from array order,
    // never trusting a client-supplied position number.
    // Auth is IDOR-proof by construction: the workspace is looked up from the SESSION, never
    // taken from the request body, so a caller cannot ever name someone else's workspace_id.
    if (path === "/api/edit/sections" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return new Response(JSON.stringify({ error: "Not signed in" }), { status: 401, headers: { "content-type": "application/json" } });
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response(JSON.stringify({ error: "No workspace found for this user." }), { status: 404, headers: { "content-type": "application/json" } });
      // a2ea1529 item 10 (W1, Day 227): the four legal pages, one page key per LEGAL_DOC_TYPES
      // entry -- listed by literal value here rather than derived, so this allowlist stays an
      // explicit, auditable list (this file's own convention) even though it duplicates
      // LEGAL_DOC_TYPES' values.
      const EDITABLE_PAGES = ["site-home", "business-plan", "legal-privacy", "legal-terms", "legal-cookie-notice", "legal-impressum"];
      let payload: { page?: string; sections?: Array<{ heading?: string; body?: string }> };
      try {
        payload = (await req.json()) as typeof payload;
      } catch {
        return new Response(JSON.stringify({ error: "Bad request body." }), { status: 400, headers: { "content-type": "application/json" } });
      }
      if (!payload.page || !EDITABLE_PAGES.includes(payload.page)) {
        return new Response(JSON.stringify({ error: "Unknown or unsupported page." }), { status: 400, headers: { "content-type": "application/json" } });
      }
      // Same empty-block-drops-out rule the old form-based saves used (business-plan/site
      // POST handlers below): a section with no heading and no body is not persisted, so an
      // "Add section" a user clicked away from without typing anything just disappears.
      const sections: PageSection[] = (payload.sections || [])
        .map((s) => ({ heading: String(s.heading ?? "").trim(), body: String(s.body ?? "").trim() }))
        .filter((s) => s.heading || s.body)
        // position assigned AFTER filtering, or a dropped empty section in the middle would
        // leave a gap (0,1,3,4) instead of a dense 0..n-1 list.
        .map((s, i) => ({ position: i, type: "heading_body", content: { heading: s.heading, body: s.body } }));
      await savePageSections(workspace.id, payload.page, sections, env);
      // f73d589b item 6 (W1, Day 227): a manual section edit on the business plan marks it
      // edited too, same reasoning as the plan-form PATCH below -- site-home has no user_edited
      // column (no plans worker writes it), so this only fires for "business-plan".
      if (payload.page === "business-plan") {
        await fetch(`${env.SUPABASE_URL}/rest/v1/business_plans?workspace_id=eq.${workspace.id}`, {
          method: "PATCH",
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ user_edited: true }),
        });
      }
      return new Response(JSON.stringify({ ok: true, count: sections.length }), { headers: { "content-type": "application/json" } });
    }

    // ── a2ea1529 item 5: PUBLIC lead capture, the Worker half (W1, Day 227) ────────────────
    // No auth -- a visitor on a USER's site submits this, not a signed-in BizXM user. Calls
    // capture_lead with the SERVICE ROLE (never the anon key, which is revoked in the same
    // migration this route ships with -- a2ea1529-item5-leads-worker-proxy.sql) and a
    // server-computed CF-Connecting-IP hash, so the per-IP rate limit is real instead of
    // caller-suppliable. Every 4xx/5xx from Supabase is relayed as a generic failure -- a
    // public endpoint must not leak DB error text to an anonymous caller.
    if (path === "/leads" && req.method === "POST") {
      const isJson = (req.headers.get("content-type") || "").includes("application/json");
      const body: Record<string, string> = isJson
        ? ((await req.json().catch(() => ({}))) as Record<string, string>)
        : (Object.fromEntries((await req.formData()).entries()) as Record<string, string>);
      const workspace_id = String(body.workspace_id || "").trim();
      const email = String(body.email || "").trim();
      // a2ea1529 item 9 (W1, Day 227): a plain <form> submission (the service-flavour quote
      // request on a public site) cannot render raw JSON back at a visitor -- redirect_to, when
      // present, sends them back to that page with ?lead=ok|error instead. JSON callers (any
      // future fetch()-based embed) are unaffected; they never send this field.
      const redirectTo = String(body.redirect_to || "").trim();
      const respond = (ok: boolean, status: number, error?: string) => {
        if (redirectTo && redirectTo.startsWith("/")) {
          return Response.redirect(`${url.origin}${redirectTo}?lead=${ok ? "ok" : "error"}`, 302);
        }
        return new Response(JSON.stringify({ ok, ...(error ? { error } : {}) }), { status, headers: { "content-type": "application/json" } });
      };
      if (!workspace_id || !email) {
        return respond(false, 400, "workspace_id and email are required");
      }
      const ip = req.headers.get("CF-Connecting-IP") || "";
      const ip_hash = ip ? await hashIp(ip, env.LEAD_IP_HASH_SECRET) : null;
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/capture_lead`, {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_workspace: workspace_id,
          p_email: email,
          p_name: body.name || null,
          p_message: body.message || null,
          p_source_path: body.source_path || null,
          p_ip_hash: ip_hash,
          p_user_agent: req.headers.get("User-Agent") || null,
        }),
      });
      if (!r.ok) {
        return respond(false, 502, "could_not_submit");
      }
      const result = (await r.json()) as { ok: boolean; error?: string };
      const status = result.ok ? 200 : result.error === "rate_limited" ? 429 : result.error === "unknown_workspace" ? 404 : 400;
      return respond(result.ok, status, result.error);
    }

    // ── home ──────────────────────────────────────────────────────────────────────────────
    // a2ea1529 / 0c7abc2e (W1, Day 227): the marketing home page Darren picked live on stream
    // (style 3, rebranded BizXM), NOT the old inline placeholder. Source: content.code_transfer
    // d465b4f5; see src/homepage.ts for the exact bytes and what was added on top of it.
    if (path === "/" || path === "") {
      // Darren, Day 227 12:2xZ: "/" ALWAYS renders the home page, never redirects a signed-in
      // visitor -- the top-right button reads Dashboard when signed in, Log in when not.
      const user = await getUser(req, env);
      // 0c7abc2e item 14 (W1, Day 227): nav brand and footer are DATA, same source every other
      // page reads through getSiteChrome()/renderNav()/renderFooter() -- the home page used to
      // hardcode its own copy of both; now it fills the same two placeholder tokens the rest of
      // this file's template strings use for anything request-scoped (see __NAV_RIGHT_HREF__
      // below, same pattern, pre-existing).
      const chrome = await getSiteChrome(env);
      const [brand] = chrome.nav;
      const html = HOME_PAGE_HTML
        .replaceAll("__NAV_BRAND_HREF__", brand.href)
        .replaceAll("__NAV_BRAND_LABEL__", brand.label)
        .replaceAll("__NAV_RIGHT_HREF__", user ? "/dashboard" : "/login")
        .replaceAll("__NAV_RIGHT_LABEL__", user ? "Dashboard" : "Log in")
        .replaceAll("__CTA_HREF__", user ? "/dashboard" : "/login")
        .replace("__FOOTER_HTML__", renderFooter(chrome.footer));
      return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    // ── login: the old home page's simple magic-link form, now its own page so the marketing
    // home page's "Log in" link and CTA have somewhere to point without a placeholder swap.
    if (path === "/login" && req.method === "GET") {
      const user = await getUser(req, env);
      if (user) return Response.redirect(`${url.origin}/dashboard`, 302);
      return await loginPage(env);
    }

    if (path === "/login/password" && req.method === "GET") {
      const user = await getUser(req, env);
      if (user) return Response.redirect(`${url.origin}/dashboard`, 302);
      return await passwordLoginPage(env);
    }

    // ── auth: send magic link ───────────────────────────────────────────────────────────────
    if (path === "/auth/login" && req.method === "POST") {
      const form = await req.formData();
      const email = String(form.get("email") || "").trim();
      if (!email || !email.includes("@")) {
        return await page(env, "Business in a Box", `<p>That doesn't look like an email address. <a href="/">Back</a></p>`);
      }
      // ⛔ INVITE-ONLY (0c7abc2e): checked BEFORE calling Supabase at all, never after --
      // a refused email must never receive an OTP send attempt or any other signal that the
      // system tried to do something with it. Same allowlist the Google callback checks below.
      if (!isAllowedEmail(email, env)) {
        return await page(env, "Business in a Box", `<p>This challenge build is invite-only right now. <a href="/">Back</a></p>`);
      }
      // ⛔ Same P0 as popup.ts: redirect_to is a QUERY PARAMETER on the raw endpoint, and
      // options.email_redirect_to in the body is supabase-js's name for it, which GoTrue does
      // not read. Demo happened to work because site_url IS demo -- it was right by accident.
      const otpUrl = `${env.SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(`${url.origin}/auth/callback`)}`;
      const r = await fetch(otpUrl, {
        method: "POST",
        headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
        // email_redirect_to STATED EXPLICITLY, never left to the project's dashboard Site URL
        // default -- that default is "http://localhost:3000" on a fresh project and a magic
        // link built against it would 404 for every real user until someone noticed.
        body: JSON.stringify({ email, create_user: true, options: { email_redirect_to: `${url.origin}/auth/callback` } }),
      });
      if (!r.ok) {
        // Read to consume, LOG server-side, never render: an upstream body in a served HTML
        // comment is public. stripServedComments handles /* */ at module load and cannot see a
        // comment built per request (obs a179970f).
        console.warn("auth/login otp send failed", r.status, (await r.text()).slice(0, 300));
        return await page(env, "Business in a Box", `<p>Could not send the link. <a href="/">Try again</a></p>`);
      }
      return await page(env, "Business in a Box", `<h1>Check your email</h1><p>We sent a sign-in link to ${email}.</p>`);
    }

    // ── auth: callback -- exchange the magic-link token for a session ──────────────────────
    if (path === "/auth/callback") {
      const token_hash = url.searchParams.get("token_hash");
      const type = url.searchParams.get("type") || "magiclink";
      if (!token_hash) return await page(env, "Business in a Box", `<p>Missing sign-in token. <a href="/">Back</a></p>`);
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
        method: "POST",
        headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ token_hash, type }),
      });
      if (!r.ok) {
        console.warn("auth/callback verify failed", r.status, (await r.text()).slice(0, 300));
        return await page(env, "Business in a Box", `<p>That link did not work -- it may have expired. <a href="/">Request a new one</a></p>`);
      }
      const data = (await r.json()) as { access_token: string; refresh_token: string };
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/dashboard`, "Set-Cookie": setSessionCookie(data.access_token, data.refresh_token) },
      });
    }

    // ── auth: password sign-in, for the fleet test account only (0c7abc2e) ─────────────────
    // The magic-link and Google paths are the real product flows. A fleet body has no email
    // inbox to click a link in and no Google account under the allowlist, so the ONE fleet test
    // account is also given a password at creation time (see runbook_credentials) and can sign
    // in here. Gated by the SAME allowlist check as the other two paths -- this route grants
    // nothing an unlisted address could not already be refused by GoTrue's own password check.
    if (path === "/auth/login/password" && req.method === "POST") {
      const form = await req.formData();
      const email = String(form.get("email") || "").trim();
      const password = String(form.get("password") || "");
      if (!email || !password) {
        return await page(env, "Log in — BizXM", `<p>Email and password are both required. <a href="/login/password">Back</a></p>`);
      }
      if (!isAllowedEmail(email, env)) {
        return await page(env, "Log in — BizXM", `<p>This challenge build is invite-only right now. <a href="/">Back</a></p>`);
      }
      const r = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) {
        return await page(env, "Log in — BizXM", `<p>That email/password did not work. <a href="/login/password">Try again</a></p>`);
      }
      const data = (await r.json()) as { access_token: string; refresh_token: string };
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/dashboard`, "Set-Cookie": setSessionCookie(data.access_token, data.refresh_token) },
      });
    }

    // ── auth: Google sign-in (0c7abc2e, W1, Day 227) ────────────────────────────────────────
    // c93cd200 item 10 (W1): the exchange/verify/mint core moved to src/google-auth.ts so
    // popup.ts's admin sign-in reuses it rather than a second copy. This route keeps the
    // BizXM-specific parts: the allowlist (isAllowedEmail), the page styling, and the
    // /dashboard destination. Also fixes a leak flagged in Silver's census (06d29161): the
    // upstream error body used to be written into served HTML as `<!-- ${body} -->` on both
    // failure paths below -- google-auth.ts now logs it (console.error) and never returns it.
    if (path === GOOGLE_LOGIN_PATH) {
      return Response.redirect(googleLoginUrl(url.origin, GOOGLE_CALLBACK_PATH, env), 302);
    }

    if (path === GOOGLE_CALLBACK_PATH) {
      const result = await exchangeGoogleCallback(url, GOOGLE_CALLBACK_PATH, env);
      if (!result.ok) {
        return await page(env, "Log in — BizXM", `<p>${esc(GOOGLE_AUTH_FAILURE_MESSAGE[result.reason])} <a href="/login">Try again</a></p>`);
      }
      // Allowlist check, BEFORE any session is created -- same rule as the magic-link path, same
      // gate, so there is exactly one place that decides who may use this challenge build.
      if (!isAllowedEmail(result.email, env)) {
        return await page(env, "Log in — BizXM", `<p>This challenge build is invite-only right now (${esc(result.email)} is not on the list). <a href="/">Back</a></p>`);
      }
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/dashboard`, "Set-Cookie": setSessionCookie(result.access_token, result.refresh_token) },
      });
    }

    if (path === "/auth/logout" && req.method === "POST") {
      return new Response(null, { status: 302, headers: { Location: `${url.origin}/`, "Set-Cookie": clearSessionCookie() } });
    }

    // ── 696d3b4c item 1 (W1, Day 227): the three-ways-in start screen ──────────────────────────
    // Captures where a user is (idea / no website / has a website), business type, location and
    // which AI tools they already use, then routes them (entryPointDestination). This is ONLY
    // the entry screen and its data capture -- item 2 (market research report), item 3 (plans),
    // item 4 (solo-operator playbook), item 5 (booking/quote section) and item 6 (has-a-website
    // path) are separate, later items and are NOT built here; item 7 (dashboard adapting its
    // wording/tiles to entry_point) is also separate. GET /dashboard redirects here while
    // entry_point is null (see the gate above the dashboard block); revisitable any time from
    // /dashboard/company's "Redo your start-screen answers" link to change the answers.
    if (path === "/start" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const entryHtml = ENTRY_POINTS.map(
        ([val, label, desc]) =>
          `<label class="choice-card">` +
          `<input type="radio" name="entry_point" value="${val}"${workspace.entry_point === val ? " checked" : ""} required>` +
          `<span><strong>${esc(label)}</strong><br><small class="muted">${esc(desc)}</small></span></label>`
      ).join("");
      const aiToolsSelected = new Set(workspace.ai_tools_used ?? []);
      const aiToolsHtml = AI_TOOLS_OPTIONS.map(
        ([val, label]) =>
          `<label class="tool-check">` +
          `<input type="checkbox" name="ai_tools_used" value="${val}"${aiToolsSelected.has(val) ? " checked" : ""}> ${esc(label)}</label>`
      ).join("");
      return await page(
        env,
        "Get started — BizXM",
        `<h1>Where are you right now?</h1>` +
          `<form method="post" action="/start">` +
          entryHtml +
          `<div class="card">` +
          `<label>Business type<select name="business_type">${businessTypeOptionsHtml(workspace.business_type)}</select></label>` +
          `<label>Country (optional)<select name="country"><option value="">Prefer not to say</option>` +
          COUNTRIES.map(([code, name]) => `<option value="${code}"${workspace.country === code ? " selected" : ""}>${esc(name)}</option>`).join("") +
          `</select></label>` +
          `<label>Region or city (optional)<input type="text" name="location_region" value="${esc(workspace.location_region ?? "")}"></label>` +
          `<p>Which tools and AI assistants do you already use?</p>` +
          `<p>${aiToolsHtml}</p>` +
          `<button type="submit">Continue</button>` +
          `</div></form>`,
        NAV_DASHBOARD
      );
    }

    if (path === "/start" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const form = await req.formData();
      const entry_point = String(form.get("entry_point") || "").trim();
      if (!ENTRY_POINTS.some(([val]) => val === entry_point)) {
        return await page(env, "Get started — BizXM", `<p>Please choose one of the three options. <a href="/start">Back</a></p>`, NAV_DASHBOARD);
      }
      const business_type = String(form.get("business_type") || "").trim() || null;
      const country = String(form.get("country") || "").trim() || null;
      const location_region = String(form.get("location_region") || "").trim() || null;
      const ai_tools_used = form.getAll("ai_tools_used").map((v) => String(v));
      const headers = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      };
      await fetch(`${env.SUPABASE_URL}/rest/v1/workspaces?id=eq.${workspace.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          entry_point,
          business_type,
          country,
          location_region,
          ai_tools_used: ai_tools_used.length ? ai_tools_used : null,
        }),
      });
      return Response.redirect(`${url.origin}${entryPointDestination(entry_point)}`, 302);
    }

    // ── dashboard: gated ─────────────────────────────────────────────────────────────────────
    if (path === "/dashboard" || path.startsWith("/dashboard/")) {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      // 696d3b4c item 1 (W1, Day 227): the start screen gates the dashboard area for BRAND-NEW
      // workspaces only -- a workspace with an existing validator run or plan pre-dates the start
      // screen and gets entry_point backfilled to "idea" once (Cloud's review, Day 227 16:4xZ:
      // gating it bounced Darren's own account, which has runs/plans and no saved choice, to an
      // unanswered question on every dashboard link). Only a workspace with NEITHER an
      // entry_point NOR any prior activity is genuinely new and sees /start. /start itself sits
      // outside this block and stays reachable any time to change the answer.
      let gateWorkspace = await getWorkspace(user.id, env);
      if (gateWorkspace && !gateWorkspace.entry_point) {
        if (await hasExistingActivity(gateWorkspace.id, env)) {
          await backfillEntryPointIdea(gateWorkspace.id, env);
          gateWorkspace = { ...gateWorkspace, entry_point: "idea" };
        } else {
          return Response.redirect(`${url.origin}/start`, 302);
        }
      }
      if (path === "/dashboard") {
        const workspace = gateWorkspace;
        // Darren, Day 227 12:2xZ: greeting uses the display name, "Welcome, Darren", falling
        // back to the email if unset -- never the other way round, so an unset name never shows
        // a blank greeting.
        const greetName = workspace?.display_name || user.email;
        // 696d3b4c item 7: an existing business (no_website/has_website) never sees idea-
        // validation wording; "idea" (or an unanswered entry_point, e.g. Darren's account before
        // the item-1-fix backfill ran) keeps the original tile set unchanged.
        const steps = workspace?.entry_point && workspace.entry_point !== "idea" ? existingBusinessSteps(workspace.entry_point) : SIX_STEPS;
        const tiles = steps.map(
          ([label, href, desc]) => `<a class="tile" href="${href}"><strong>${label}</strong><br><small>${desc}</small></a>`
        ).join("");
        return await page(env,
          "Dashboard",
          `<h1>Welcome, ${greetName}</h1><div class="tiles">${tiles}</div>` +
            // f73d589b (W1, Day 227): the plans are reached from the idea-validation funnel
            // (accept an idea -> write the plans), but manual editing is the must-have (Darren,
            // 614ca396), so both are ALSO directly reachable here with no run required.
            `<div class="card"><h3>Your plans</h3>` +
            `<p><a href="/dashboard/business-plan">Business plan</a> &middot; <a href="/dashboard/marketing-plan">Marketing plan</a> &middot; <a href="/dashboard/company">Company details</a></p></div>`,
          `<a href="/account">Account</a>`
        );
      }
      // ── Idea Validator (brief 36de4e90) ────────────────────────────────────────────────
      if (path === "/dashboard/validator" && req.method === "GET") {
        // item 14 (W1, Day 227): "Your reports" -- every run for the workspace, newest first.
        const workspace = await getWorkspace(user.id, env);
        const runs = workspace ? await getValidatorRuns(workspace.id, env) : [];
        // item 14 tidy-up (c3787a75, Cloud): a row/card per report, not a plain bulleted list.
        const reportsHtml = runs.length
          ? `<h3>Your reports</h3>` +
            runs
              .map((r) => {
                const label = STATUS_LABEL[r.status] || r.status;
                const scorePart = r.score !== null && r.score !== undefined ? ` &middot; Score ${esc(r.score)}/100` : "";
                const idea = String(r.idea_text || "").slice(0, 80);
                const date = esc(new Date(r.created_at).toISOString().slice(0, 10));
                return (
                  `<a class="card report-row" href="/dashboard/validator/${esc(r.id)}">` +
                  `<strong>${esc(idea)}</strong>` +
                  `<span class="report-meta">${date} &middot; ${esc(label)}${scorePart}</span>` +
                  (r.verdict_line ? `<span class="report-verdict">${esc(r.verdict_line)}</span>` : "") +
                  `</a>`
                );
              })
              .join("")
          : "";
        return await page(env,
          "Validate your idea",
          `<h1>Validate your idea</h1>` +
            `<p>Every figure in your report carries its source and date, or says "not found" -- never a guess dressed as a fact.</p>` +
            `<form method="post" action="/dashboard/validator" enctype="multipart/form-data">` +
            `<p><label>Your idea<br><textarea name="idea_text" rows="6" required style="width:100%"></textarea></label></p>` +
            `<p><label>LinkedIn URL (optional)<br><input type="url" name="linkedin_url"></label></p>` +
            `<p><label>Competitor URLs, one per line (optional)<br><textarea name="competitor_urls" rows="3" style="width:100%"></textarea></label></p>` +
            // item 16/22/23 (Silver/Cloud, Day 227 -- shape ruled 795ef778/cbf6cde1): feeds the
            // legal step (eligibility = country not null) and the build-plan/business-type
            // branching. Nullable and optional on this form -- an idea can still be validated
            // without answering these, those downstream steps just stay ineligible until it does.
            `<p><label>Country (optional -- where this business will run)<br><select name="country"><option value="">Prefer not to say</option>` +
            COUNTRIES.map(([code, name]) => `<option value="${code}">${esc(name)}</option>`).join("") +
            `</select></label></p>` +
            `<p><label>Region or city (optional)<br><input type="text" name="region"></label></p>` +
            `<p><label>Your comfort with tech and AI tools (optional)<br><select name="tech_comfort">` +
            `<option value="">Prefer not to say</option>` +
            `<option value="never_used">Never used them</option>` +
            `<option value="basic">Basic -- I can use everyday apps</option>` +
            `<option value="confident">Confident -- I use AI tools regularly</option>` +
            `<option value="builds_software">I build software</option>` +
            `</select></label></p>` +
            `<p><label>Hours per week you can put into this (optional)<br><input type="number" name="hours_per_week" min="0" max="100"></label></p>` +
            // 36de4e90 item 12 (W1, Day 227): drag-and-drop zone replacing the bare file input.
            // The real <input type=file name=uploads multiple> stays and still does the actual
            // upload on submit -- unchanged backend -- it is just visually hidden and driven
            // programmatically via a rebuilt DataTransfer so files can be removed individually,
            // which a bare <input> cannot do across browsers.
            `<p>Upload images, logos, a business plan, resume/CV (optional, multiple)</p>` +
            `<div id="dropzone" class="dropzone">` +
            `<input type="file" name="uploads" id="uploads-input" multiple style="display:none">` +
            `<p class="muted">Drag files here, or</p>` +
            `<button type="button" class="btn btn-secondary" id="choose-files">Choose files</button>` +
            `<ul class="filelist" id="filelist"></ul>` +
            `</div>` +
            `<button type="submit">Start validation</button></form>` +
            `<script>
(function(){
  var zone = document.getElementById('dropzone');
  var input = document.getElementById('uploads-input');
  var chooseBtn = document.getElementById('choose-files');
  var list = document.getElementById('filelist');
  var files = [];
  function render(){
    list.innerHTML = '';
    files.forEach(function(f, i){
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)';
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '\\u00d7';
      rm.setAttribute('aria-label', 'Remove ' + f.name);
      rm.addEventListener('click', function(){ files.splice(i, 1); sync(); });
      li.appendChild(name); li.appendChild(rm);
      list.appendChild(li);
    });
  }
  function sync(){
    var dt = new DataTransfer();
    files.forEach(function(f){ dt.items.add(f); });
    input.files = dt.files;
    render();
  }
  function addFiles(fileList){
    for (var i = 0; i < fileList.length; i++) files.push(fileList[i]);
    sync();
  }
  chooseBtn.addEventListener('click', function(){ input.click(); });
  // Programmatically assigning input.files (in sync(), below) does NOT fire a native 'change'
  // event -- only a genuine user pick through the OS dialog does. So this always fires with
  // exactly the files the user just chose, never our own synthetic ones, and addFiles() APPENDS
  // them to the running list rather than replacing it -- clicking "Choose files" a second time
  // to add more must not drop the files already added.
  input.addEventListener('change', function(){ if (input.files.length) addFiles(input.files); });
  ['dragenter', 'dragover'].forEach(function(evt){
    zone.addEventListener(evt, function(e){ e.preventDefault(); zone.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function(evt){
    zone.addEventListener(evt, function(e){ e.preventDefault(); zone.classList.remove('drag'); });
  });
  zone.addEventListener('drop', function(e){
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
})();
</script>` +
            reportsHtml,
          NAV_DASHBOARD
        );
      }

      if (path === "/dashboard/validator" && req.method === "POST") {
        const workspace = await getWorkspace(user.id, env);
        if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
        const form = await req.formData();
        const idea_text = String(form.get("idea_text") || "").trim();
        if (!idea_text) return await page(env, "Validate your idea", `<p>An idea is required. <a href="/dashboard/validator">Back</a></p>`);
        const linkedin_url = String(form.get("linkedin_url") || "").trim() || null;
        const competitor_urls = String(form.get("competitor_urls") || "")
          .split("\n").map((s) => s.trim()).filter(Boolean);
        // item 16/22/23 (Silver/Cloud, Day 227): all four optional -- an idea validates fine
        // without them, those downstream steps just stay ineligible (country IS NULL) until a
        // later edit fills them in. country is normalized to uppercase 2-letter or omitted
        // entirely (never an empty string into a column downstream code treats as "answered").
        const countryRaw = String(form.get("country") || "").trim().toUpperCase();
        const country = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : null;
        const region = String(form.get("region") || "").trim() || null;
        const techComfortRaw = String(form.get("tech_comfort") || "").trim();
        const tech_comfort = ["never_used", "basic", "confident", "builds_software"].includes(techComfortRaw) ? techComfortRaw : null;
        const hoursRaw = form.get("hours_per_week");
        const hoursNum = hoursRaw ? Number(hoursRaw) : NaN;
        const hours_per_week = Number.isFinite(hoursNum) && hoursNum >= 0 && hoursNum <= 100 ? Math.round(hoursNum) : null;

        // ── create the run row FIRST, so uploads land under a real run id ────────────────────
        const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/validator_runs`, {
          method: "POST",
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "content-type": "application/json",
            prefer: "return=representation",
          },
          body: JSON.stringify({
            workspace_id: workspace.id, idea_text, linkedin_url, competitor_urls, status: "uploaded",
            country, region, tech_comfort, hours_per_week,
          }),
        });
        if (!insertRes.ok) {
          console.warn("validator run start failed", insertRes.status, (await insertRes.text()).slice(0, 300));
          return await page(env, "Validate your idea", `<p>Could not start the run. <a href="/dashboard/validator">Try again</a></p>`);
        }
        const [run] = (await insertRes.json()) as Array<{ id: string }>;

        // ── store each upload under uploads/<workspace_id>/validator/<run_id>/<filename> ────
        const files = form.getAll("uploads").filter((f): f is File => f instanceof File && f.size > 0);
        const uploadPaths: string[] = [];
        for (const file of files) {
          const safeName = file.name.replace(/[^A-Za-z0-9_.\-]/g, "_");
          const objectPath = `${workspace.id}/validator/${run.id}/${safeName}`;
          const putRes = await fetch(
            `${env.SUPABASE_URL}/storage/v1/object/uploads/${objectPath}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                "content-type": file.type || "application/octet-stream",
              },
              body: await file.arrayBuffer(),
            }
          );
          if (putRes.ok) uploadPaths.push(objectPath);
          // ⛔ a failed individual upload does NOT fail the whole run -- the idea text alone is
          // enough to start. It DOES need to be visible on the run, not silently dropped: see
          // the TODO below, which is exactly this file's own §6 pattern (a partial result must
          // say what it could not do, never read as complete).
        }
        if (uploadPaths.length) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/validator_runs?id=eq.${run.id}`, {
            method: "PATCH",
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ upload_paths: uploadPaths }),
          });
        }

        // ── competitor search, NON-LLM half (Cloud, Day 227 11:0xZ): fetch each named URL
        // directly. THE SOURCING RULE APPLIES HERE TOO -- every figure is {value, source, as_of}
        // or {not_found: true}, never a bare string, so this shape is identical to what the
        // eventual LLM-scored competitors will carry. This is real, sourced, dated data -- a
        // page title and description with the URL as source and NOW as the date -- not an LLM's
        // assessment of it (that half is still blocked on ANTHROPIC_API_KEY).
        if (competitor_urls.length) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/validator_runs?id=eq.${run.id}`, {
            method: "PATCH",
            headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
            body: JSON.stringify({ status: "researching" }),
          });
          const competitors = await Promise.all(competitor_urls.map((u) => fetchCompetitorBasics(u)));
          await fetch(`${env.SUPABASE_URL}/rest/v1/validator_runs?id=eq.${run.id}`, {
            method: "PATCH",
            headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
            body: JSON.stringify({ competitors, status: "uploaded" }),
            // status stays "uploaded", not "done" -- competitor BASICS are fetched, but scoring
            // and every figure beyond name/title/description is still {not_found: true} until
            // the LLM half runs. "done" must mean the WHOLE step ran, not half of it.
          });
        }

        return Response.redirect(`${url.origin}/dashboard/validator/${run.id}`, 302);
      }

      if (path.startsWith("/dashboard/validator/")) {
        const runId = path.split("/")[3];
        const workspace = await getWorkspace(user.id, env);
        if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
        const r = await fetch(
          `${env.SUPABASE_URL}/rest/v1/validator_runs?id=eq.${runId}&workspace_id=eq.${workspace.id}&select=*`,
          { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        const rows = r.ok ? ((await r.json()) as Array<Record<string, unknown>>) : [];
        if (!rows.length) return new Response("Run not found.", { status: 404 });
        const run = rows[0];
        // ⛔ Brief 614ca396 (One Engine Three Doors): the prompt is not hard-coded here -- it
        // is read from the `steps` table (id='validate') so all three doors (this web app, the
        // prompt playbooks, the MCP connector) run the SAME definition. Reading it now, before
        // ANTHROPIC_API_KEY exists, proves the LOOKUP is correct independent of the still-
        // blocked LLM call -- driven, not assumed, exactly like everything else in this repo.
        const stepRes = await fetch(`${env.SUPABASE_URL}/rest/v1/steps?id=eq.validate&select=*`, {
          headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
        });
        const stepRows = stepRes.ok ? ((await stepRes.json()) as Array<{ id: string; instructions: string }>) : [];
        const step = stepRows[0];
        // items 22/23 (36de4e90): the build plan section on THIS run's report -- only when
        // THIS run is what generated the current plan (source_run_id=eq match), never an older
        // run's page showing a plan a LATER run actually produced for the same workspace.
        const bpRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/business_plans?workspace_id=eq.${workspace.id}&source_run_id=eq.${runId}`
          + `&select=mvp_scope,cost_table,weeks_to_mvp,task_breakdown,skills_gap,funding_and_grants,top_risks,type_specific`,
          { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
        );
        const bpRows = bpRes.ok ? ((await bpRes.json()) as Array<Record<string, unknown>>) : [];
        const buildPlan = bpRows[0];
        // Item 11 landed (brief 36de4e90, judge-worker.py): a run now actually resolves to a
        // score and sourced competitors, off-Worker via this box's Claude Code CLI. Rendering
        // moved to validator-view.ts -- see that file for why it is separate. The "Accept this
        // idea" business/marketing-plan links (f73d589b, W1) moved into renderValidatorRun()
        // itself, on the done path only -- resolved here in the rebase onto Silver's item 11.
        // 36de4e90 item 17 (W1, Day 227): the read-aloud bar wraps the report body in #rab-doc,
        // its own contract-scoped selector (h1/h2/h3/p/li/td/[data-rab-say]) so it never reads
        // the page's shared nav/footer or the "Accept this idea" buttons.
        return await page(
          env,
          "Your validation run",
          readaloudBarHtml() + `<div id="rab-doc">${renderValidatorRun(run, step, buildPlan)}</div>` + READALOUD_SCRIPT,
          NAV_DASHBOARD
        );
      }

    // ── f73d589b item 6 (W1, Day 227): insert a plans job -- Silver's plan_jobs shape ──────
    // The confirm-before-overwrite step lives HERE, server-side, not on the report page's
    // button or a client-side confirm() -- so both the report page's first "Generate" click
    // AND a "Regenerate" click from an existing plan page go through the identical check with
    // no duplicated logic. If either plan has been hand-edited and the request does not already
    // carry confirmed=1, this returns an intermediate confirmation page instead of queuing the
    // job; confirming resubmits the same form with confirmed=1 set.
    if (path === "/dashboard/plans/generate" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const form = Object.fromEntries((await req.formData()).entries()) as Record<string, string>;
      const sourceRunId = String(form.source_run_id || "").trim();
      const confirmed = form.confirmed === "1";
      // 696d3b4c item 3 (W1, Day 227), Cloud's split with Silver: an existing business
      // (entry_point no_website/has_website) has no validator run to source from -- this button
      // posts with NO source_run_id, and is only ever REACHED once EXISTING_BUSINESS_PLANS_TRIGGER_LIVE
      // is flipped on (see the page rendering below), never guessable from outside that gate.
      const isExistingBusiness = !sourceRunId;
      if (isExistingBusiness && workspace.entry_point !== "no_website" && workspace.entry_point !== "has_website") {
        return new Response("Missing source_run_id.", { status: 400 });
      }

      const [bizPlan, mktPlan] = await Promise.all([getOrCreateBusinessPlan(workspace.id, env), getOrCreateMarketingPlan(workspace.id, env)]);
      const hasEdits = bizPlan.user_edited || mktPlan.user_edited;
      if (hasEdits && !confirmed) {
        const overwriteWarning = isExistingBusiness
          ? "Regenerating will overwrite those edits with a fresh version from your business details."
          : "Regenerating will overwrite those edits with a fresh version from your idea validation run.";
        return await page(
          env,
          "Regenerate your plans? — BizXM",
          `<h1>Regenerate your plans?</h1>` +
            `<div class="card"><p>You have edited your business or marketing plan by hand. ${overwriteWarning}</p>` +
            `<form method="post" action="/dashboard/plans/generate">` +
            (sourceRunId ? `<input type="hidden" name="source_run_id" value="${esc(sourceRunId)}">` : "") +
            `<input type="hidden" name="confirmed" value="1">` +
            `<button type="submit">Overwrite and regenerate</button> <a class="btn btn-secondary" href="/dashboard/business-plan">Cancel</a>` +
            `</form></div>`,
          NAV_DASHBOARD
        );
      }

      await fetch(`${env.SUPABASE_URL}/rest/v1/plan_jobs`, {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          isExistingBusiness
            ? { workspace_id: workspace.id, source_kind: "start_screen", status: "queued", overwrite_confirmed: confirmed }
            : { workspace_id: workspace.id, source_run_id: sourceRunId, source_kind: "validator_run", status: "queued", overwrite_confirmed: confirmed }
        ),
      });
      return Response.redirect(`${url.origin}/dashboard/business-plan`, 302);
    }

    // ── f73d589b: live business plan (W1, Day 227) ──────────────────────────────────────────
    if (path === "/dashboard/business-plan" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const plan = await getOrCreateBusinessPlan(workspace.id, env);
      // 696d3b4c item 3 (W1, Day 227): an existing business never sees idea-launch wording --
      // Cloud's ruling. No validator run to carry a cost estimate FROM, so that fetch is skipped
      // entirely rather than pulling an unrelated run's costs onto an existing-business plan.
      const isExistingBusiness = workspace.entry_point === "no_website" || workspace.entry_point === "has_website";
      // item 1: carry the cost estimate from the validator ONLY while the plan has never set its
      // own -- once a user (or later, the AI) has written a real cost_estimate, that is the one
      // shown, never silently replaced by a fresher validator run.
      const costEstimate = isExistingBusiness
        ? plan.cost_estimate
        : Object.keys(plan.cost_estimate || {}).length > 0 ? plan.cost_estimate : await getLatestValidatorCosts(workspace.id, env);
      // 2df0e973: plan_sections read from the generic page_sections table now, keyed by
      // position -- not from a bespoke business_plans column.
      // click-to-edit (W1, Day 227): PLAN_SECTION_SLOTS now seeds the FIRST-EVER view only (a
      // brand-new plan with zero saved rows gets the five suggested headings as a starting
      // point). Once anything has been saved, the saved rows ARE the section list -- free-form
      // from then on (add/remove is meaningless against a fixed 5-slot model).
      const rawSections = await getPageSections(workspace.id, "business-plan", env);
      const sections: EditSection[] = rawSections.length
        ? rawSections.map((s) => ({ heading: String(s.content.heading ?? ""), body: String(s.content.body ?? "") }))
        : PLAN_SECTION_SLOTS.map((heading) => ({ heading, body: "" }));
      const assumptionValue = (label: string) => plan.break_even.assumptions.find((a) => a.label === label)?.value ?? 0;
      // item 5: every figure carries its source, or is labelled an assumption the user can
      // change. Handles the REAL shape validator_runs.costs uses (the validate step's own
      // typed_outputs.costs: {development, business_setup, running_subscriptions}, three plain
      // strings) rather than the single sourced_figure {value,source,as_of} shape this render
      // first assumed -- caught in review: that mismatch would have shown "not found" forever,
      // even once a real run had scored real costs, because the two shapes never intersect.
      const cost = costEstimate as Record<string, unknown>;
      const costHtml =
        "value" in cost
          ? `<p><strong>$${(cost as { value: unknown }).value}</strong> <span class="muted">source: ${(cost as { source?: string }).source ?? "?"}, as of ${(cost as { as_of?: string }).as_of ?? "?"}</span></p>`
          : cost.development || cost.business_setup || cost.running_subscriptions
          ? `<ul>` +
            (cost.development ? `<li>Development: ${cost.development}</li>` : "") +
            (cost.business_setup ? `<li>Business setup: ${cost.business_setup}</li>` : "") +
            (cost.running_subscriptions ? `<li>Running subscriptions: ${cost.running_subscriptions}</li>` : "") +
            `</ul><p class="muted">Carried from your idea validation run.</p>`
          : `<p class="muted">Not found yet -- carried from your idea validation run once it scores costs.</p>`;
      // 696d3b4c item 3 (W1, Day 227), Cloud's ruling: an existing business gets "Money today" --
      // its OWN current figures, editable, labelled as such, never sourced/forecast and never
      // break-even-to-launch wording.
      const moneyCardHtml =
        `<div class="card"><h3>Money today</h3>` +
        `<label>Current monthly revenue<input type="number" step="0.01" name="current_monthly_revenue" value="${plan.current_monthly_revenue ?? ""}"></label>` +
        `<label>Current monthly costs<input type="number" step="0.01" name="current_monthly_costs" value="${plan.current_monthly_costs ?? ""}"></label>` +
        `<label>Revenue target<input type="number" step="0.01" name="revenue_target" value="${plan.revenue_target ?? ""}"></label>` +
        `<p class="muted">These are your own figures -- editable any time, not sourced or forecast.</p></div>`;
      const versions = await getPlanVersions(workspace.id, "business", env);
      // f73d589b item 6 (W1, Day 227): the latest job drives a Generating/failed banner; a
      // Regenerate button reuses whichever run last generated this plan (falling back to the
      // job's run if the plan itself has none yet, e.g. mid-generation on the first-ever run).
      // 696d3b4c item 3: an existing business has no run to fall back to -- EXISTING_BUSINESS_
      // PLANS_TRIGGER_LIVE gates whether it can trigger a (re)generation at all yet.
      const latestJob = await getLatestPlanJob(workspace.id, env);
      const banner = latestJob ? planGeneratingBannerHtml(latestJob) : "";
      const regenRunId = plan.source_run_id || latestJob?.source_run_id || "";
      const generateForm = (label: string, extraHidden: string) =>
        `<form method="post" action="/dashboard/plans/generate" style="display:inline">${extraHidden}<button type="submit" class="btn-secondary">${esc(label)}</button></form>`;
      const regenButton = isExistingBusiness
        ? EXISTING_BUSINESS_PLANS_TRIGGER_LIVE
          ? generateForm(latestJob ? "Regenerate from your business details" : "Generate my business and marketing plans", "")
          : ""
        : regenRunId
        ? generateForm("Regenerate from your validation run", `<input type="hidden" name="source_run_id" value="${esc(regenRunId)}">`)
        : "";
      // 36de4e90 item 17 (W1, Day 227): same read-aloud bar as the validator report, scoped to
      // #rab-doc so it reads headings/paragraphs only -- never the form's input/textarea values.
      return await page(
        env,
        "Business plan — BizXM",
        readaloudBarHtml() +
        `<div id="rab-doc">` +
        `<h1>Business plan</h1>` +
          banner +
          (regenButton ? `<p>${regenButton}</p>` : "") +
          `<form id="plan-form" method="post" action="/dashboard/business-plan">` +
          `<div class="card"><h3>Elevator pitch</h3>` +
          `<textarea name="elevator_pitch" rows="3">${(plan.elevator_pitch || "").replace(/</g, "&lt;")}</textarea></div>` +
          (isExistingBusiness
            ? moneyCardHtml
            : `<div class="card"><h3>Cost estimate</h3>${costHtml}<p class="muted">Sourced automatically once your idea validation has scored costs. Not user-editable here.</p></div>` +
              `<div class="card"><h3>Break-even forecast</h3>` +
              `<p class="muted">Every figure below is an assumption you can change (labelled, not sourced) -- this is a forecast, not a measured fact.</p>` +
              BUSINESS_PLAN_ASSUMPTIONS
                .map(
                  (a) =>
                    `<label>${a.label} <span class="muted">(assumption, editable)</span><input type="number" step="0.01" name="assump_${a.key}" value="${assumptionValue(a.label)}"></label>`
                )
                .join("") +
              `<p><strong>Break-even:</strong> ${
                plan.break_even.months_to_break_even != null
                  ? `${plan.break_even.months_to_break_even} month(s) at current assumptions`
                  : "Not achievable at current assumptions (monthly costs meet or exceed revenue) -- adjust and save."
              }</p>` +
              `</div>`) +
          `<button type="submit">Save now</button> <span id="save-status" class="muted"></span>` +
          `</form>` +
          // 2df0e973 click-to-edit (W1, Day 227): sections moved OUT of plan-form -- they now
          // save through /api/edit/sections (savePageSections' REPLACE-ALL, same as the site
          // page), never the whole-form autosave, which is why this sits AFTER </form> rather
          // than between elevator pitch and cost estimate (its old position when sections were
          // plain form fields): splitting plan-form in two would have orphaned the second half
          // from AUTOSAVE_SCRIPT, which hardcodes ONE form id.
          `<h3>Sections</h3>` +
          editRootOpenHtml("business-plan") +
          sections.map((s, i) => `<div class="card">${editableSectionHtml(s, i, sections.length)}</div>`).join("") +
          editAddButtonHtml() +
          `</div>` +
          BLOCKEDIT_SCRIPT +
          `<div class="card"><h3>Version history</h3>` +
          (versions.length
            ? `<ul>${versions.map((v) => `<li>${v.created_at}</li>`).join("")}</ul>`
            : `<p class="muted">No saved versions yet -- the first save creates one.</p>`) +
          `</div>` +
        `</div>` +
          AUTOSAVE_SCRIPT +
          READALOUD_SCRIPT,
        NAV_DASHBOARD
      );
    }

    if (path === "/dashboard/business-plan" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      // Accepts BOTH a JSON body (the autosave script) and a normal form POST (the no-JS
      // fallback) -- same shape either way, since FormData and the fetch() payload use the same
      // field names.
      const isJson = (req.headers.get("content-type") || "").includes("application/json");
      const form: Record<string, string> = isJson ? ((await req.json()) as Record<string, string>) : Object.fromEntries((await req.formData()).entries()) as Record<string, string>;

      // 2df0e973 click-to-edit (W1, Day 227): sections are NO LONGER part of this form or this
      // handler -- they save through /api/edit/sections now. This handler must not touch
      // page_sections at all any more: it used to derive a section list from
      // section_${i}_heading/body form fields that no longer exist in the form, which would
      // have read as all-empty on every autosave and WIPED every section via
      // savePageSections' REPLACE-ALL, on every elevator-pitch or assumption keystroke.

      // Field names MUST match the GET side's `name="assump_${a.key}"` exactly -- the earlier
      // draft of this handler looked the values up BY LABEL ("assump_Price per customer
      // ($/mo)"), which the form never sent under that name, so every save silently zeroed the
      // whole forecast. Caught in review before this ever deployed; fixed by keying both sides
      // off the same BUSINESS_PLAN_ASSUMPTIONS list, never a re-typed string on either side.
      const num = (k: string) => Number(form[`assump_${k}`] ?? 0) || 0;
      const price = num("price_per_customer");
      const customers = num("customers_per_month");
      const fixedCosts = num("monthly_fixed_costs");
      const startup = num("startup_cost");
      const monthly_revenue = price * customers;
      const monthly_costs = fixedCosts;
      const months_to_break_even =
        startup > 0 && monthly_revenue > monthly_costs ? Math.ceil(startup / (monthly_revenue - monthly_costs)) : null;

      const break_even = {
        assumptions: BUSINESS_PLAN_ASSUMPTIONS.map((a) => ({
          label: a.label,
          value: { price_per_customer: price, customers_per_month: customers, monthly_fixed_costs: fixedCosts, startup_cost: startup }[a.key],
          editable: true as const,
        })),
        monthly_revenue,
        monthly_costs,
        months_to_break_even,
      };

      // 696d3b4c item 3 (W1, Day 227): the "Money today" card's own fields -- present only on an
      // existing-business plan's form, so absent here means "leave unset", never "clear to zero"
      // (contrast num() above, which intentionally defaults break_even's assumption fields to 0).
      const moneyField = (k: string) => {
        const v = form[k];
        if (v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      // f73d589b item 6 (W1, Day 227): a manual save marks the plan edited, so the generate
      // worker's own clobber guard (761a4cb5 item 2) has something real to refuse against.
      const patch = {
        elevator_pitch: String(form.elevator_pitch ?? "").trim(),
        break_even,
        user_edited: true,
        current_monthly_revenue: moneyField("current_monthly_revenue"),
        current_monthly_costs: moneyField("current_monthly_costs"),
        revenue_target: moneyField("revenue_target"),
      };
      await fetch(`${env.SUPABASE_URL}/rest/v1/business_plans?workspace_id=eq.${workspace.id}`, {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      // plan_versions keeps versioning the WHOLE page (pitch + break_even + a READ, never a
      // write, of whatever sections /api/edit/sections currently has saved) so the visible
      // "Version history" list stays ONE coherent history, not fragmented across two tables.
      // click-to-edit (W1, Day 227): this used to WRITE sections here too (savePageSections),
      // which is gone -- sections now save exclusively through /api/edit/sections, and this
      // handler only reads the current rows to fold into the snapshot.
      const currentSections = await getPageSections(workspace.id, "business-plan", env);
      await savePlanVersion(workspace.id, "business", { ...patch, sections: currentSections }, env);

      if (isJson) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      return Response.redirect(`${url.origin}/dashboard/business-plan`, 302);
    }

    // ── f73d589b: live marketing plan (W1, Day 227) ─────────────────────────────────────────
    if (path === "/dashboard/marketing-plan" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const plan = await getOrCreateMarketingPlan(workspace.id, env);
      const xGoal = plan.posting_goals.x ?? { per: "week", count: 3 };
      const versions = await getPlanVersions(workspace.id, "marketing", env);
      // f73d589b item 6 (W1, Day 227): same Generating/failed banner + Regenerate as business-plan.
      // 696d3b4c item 3: same existing-business branch too -- no run, gated on the same flag.
      const isExistingBusiness = workspace.entry_point === "no_website" || workspace.entry_point === "has_website";
      const latestJob = await getLatestPlanJob(workspace.id, env);
      const banner = latestJob ? planGeneratingBannerHtml(latestJob) : "";
      const regenRunId = plan.source_run_id || latestJob?.source_run_id || "";
      const regenButton = isExistingBusiness
        ? EXISTING_BUSINESS_PLANS_TRIGGER_LIVE
          ? `<form method="post" action="/dashboard/plans/generate" style="display:inline"><button type="submit" class="btn-secondary">${latestJob ? "Regenerate from your business details" : "Generate my business and marketing plans"}</button></form>`
          : ""
        : regenRunId
        ? `<form method="post" action="/dashboard/plans/generate" style="display:inline"><input type="hidden" name="source_run_id" value="${esc(regenRunId)}"><button type="submit" class="btn-secondary">Regenerate from your validation run</button></form>`
        : "";
      // 36de4e90 item 17 (W1, Day 227): same read-aloud bar as business plan / validator report.
      return await page(
        env,
        "Marketing plan — BizXM",
        readaloudBarHtml() +
        `<div id="rab-doc">` +
        `<h1>Marketing plan</h1>` +
          banner +
          (regenButton ? `<p>${regenButton}</p>` : "") +
          `<form id="plan-form" method="post" action="/dashboard/marketing-plan">` +
          `<div class="card"><h3>Posting goal — X</h3>` +
          `<label>Post every <select name="x_per"><option value="day"${xGoal.per === "day" ? " selected" : ""}>day</option>` +
          `<option value="week"${xGoal.per === "week" ? " selected" : ""}>week</option></select></label>` +
          `<label>Posts per period<input type="number" name="x_count" value="${xGoal.count}"></label>` +
          `<p class="muted">More channels land as they are connected. X is the only one built today.</p></div>` +
          `<div class="card"><h3>Target keywords</h3><p class="muted">One per line.</p>` +
          `<textarea name="target_keywords" rows="4">${plan.target_keywords.join("\n")}</textarea></div>` +
          `<div class="card"><h3>SEO keywords</h3><p class="muted">Feeds the site builder's page titles, descriptions and headings. One per line, each field.</p>` +
          `<label>Title keywords<textarea name="seo_title" rows="3">${plan.seo_keywords.title.join("\n")}</textarea></label>` +
          `<label>Description keywords<textarea name="seo_description" rows="3">${plan.seo_keywords.description.join("\n")}</textarea></label>` +
          `<label>Heading keywords<textarea name="seo_headings" rows="3">${plan.seo_keywords.headings.join("\n")}</textarea></label></div>` +
          `<div class="card"><h3>Bid-worthy keywords</h3><p class="muted">Worth bidding on -- no prices shown, this product does not estimate ad spend.</p>` +
          `<textarea name="bid_keywords" rows="4">${plan.bid_keywords.join("\n")}</textarea></div>` +
          `<button type="submit">Save now</button> <span id="save-status" class="muted"></span>` +
          `</form>` +
          `<div class="card"><h3>Version history</h3>` +
          (versions.length
            ? `<ul>${versions.map((v) => `<li>${v.created_at}</li>`).join("")}</ul>`
            : `<p class="muted">No saved versions yet -- the first save creates one.</p>`) +
          `</div>` +
        `</div>` +
          AUTOSAVE_SCRIPT +
          READALOUD_SCRIPT,
        NAV_DASHBOARD
      );
    }

    if (path === "/dashboard/marketing-plan" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const isJson = (req.headers.get("content-type") || "").includes("application/json");
      const form: Record<string, string> = isJson ? ((await req.json()) as Record<string, string>) : Object.fromEntries((await req.formData()).entries()) as Record<string, string>;
      const lines = (s: string | undefined) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

      const patch = {
        posting_goals: { x: { per: String(form.x_per ?? "week"), count: Number(form.x_count ?? 0) || 0 } },
        target_keywords: lines(form.target_keywords),
        seo_keywords: { title: lines(form.seo_title), description: lines(form.seo_description), headings: lines(form.seo_headings) },
        bid_keywords: lines(form.bid_keywords),
        // f73d589b item 6 (W1, Day 227): same reasoning as business-plan's patch.
        user_edited: true,
      };
      await fetch(`${env.SUPABASE_URL}/rest/v1/marketing_plans?workspace_id=eq.${workspace.id}`, {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      await savePlanVersion(workspace.id, "marketing", patch, env);

      if (isJson) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      return Response.redirect(`${url.origin}/dashboard/marketing-plan`, 302);
    }

    // ── a2ea1529 item 8: company details (W1, Day 227) ─────────────────────────────────────
    // Darren bench 11:2xZ: after picking a style, the user enters company details; saving them
    // is what creates the accounting profile (seeds a default chart of accounts into Silver's
    // 9c0ee591 ledger_accounts, idempotent -- see seed_default_chart_of_accounts()'s own comment
    // for why it never duplicates a chart someone has already started customising).
    if (path === "/dashboard/company" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const v = (s: string | null) => (s ?? "").replace(/"/g, "&quot;");
      return await page(
        env,
        "Company details — BizXM",
        `<h1>Company details</h1>` +
          `<p class="muted">Saving these sets up your accounting profile with a starting chart of accounts.</p>` +
          `<form method="post" action="/dashboard/company">` +
          `<div class="card">` +
          `<label>Trading name<input type="text" name="trading_name" value="${v(workspace.trading_name)}"></label>` +
          `<label>Contact email<input type="email" name="contact_email" value="${v(workspace.contact_email)}"></label>` +
          `<label>Address<textarea name="address" rows="3">${v(workspace.address)}</textarea></label>` +
          // Cloud's ruling (item 3 follow-up, Day 227): the SAME select as /start, writing the
          // SAME `country` column -- one format (ISO 3166 alpha-2), never a free-text field here
          // and a coded one there.
          `<label>Country<select name="country"><option value="">Prefer not to say</option>` +
          COUNTRIES.map(([code, name]) => `<option value="${code}"${workspace.country === code ? " selected" : ""}>${esc(name)}</option>`).join("") +
          `</select></label>` +
          `<label>Currency<input type="text" name="currency" value="${v(workspace.currency)}" placeholder="e.g. GBP" maxlength="3" style="text-transform:uppercase"></label>` +
          `<label>Tax registration (optional)<input type="text" name="tax_registration" value="${v(workspace.tax_registration)}"></label>` +
          `<label>Business type<select name="business_type">${businessTypeOptionsHtml(workspace.business_type)}</select></label>` +
          `<button type="submit">Save</button>` +
          `</div></form>` +
          `<p class="muted"><a href="/start">Redo your start-screen answers (idea/business/website, business type, location, AI tools)</a></p>`,
        NAV_DASHBOARD
      );
    }

    if (path === "/dashboard/company" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const form = await req.formData();
      const currency = String(form.get("currency") || "").trim().toUpperCase() || null;
      const business_type = String(form.get("business_type") || "").trim() || null;
      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        return await page(env, "Company details — BizXM", `<p>Currency must be a 3-letter code, e.g. GBP or USD. <a href="/dashboard/company">Back</a></p>`, NAV_DASHBOARD);
      }
      const headers = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      };
      await fetch(`${env.SUPABASE_URL}/rest/v1/workspaces?id=eq.${workspace.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          trading_name: String(form.get("trading_name") || "").trim() || null,
          contact_email: String(form.get("contact_email") || "").trim() || null,
          address: String(form.get("address") || "").trim() || null,
          country: String(form.get("country") || "").trim() || null,
          currency,
          tax_registration: String(form.get("tax_registration") || "").trim() || null,
          business_type,
        }),
      });
      // Seed the chart of accounts AFTER the workspace patch succeeds, service-role RPC, same
      // pattern as every other server-only write in this file. Idempotent -- see the function.
      await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/seed_default_chart_of_accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_workspace: workspace.id }),
      });
      return Response.redirect(`${url.origin}/dashboard/company`, 302);
    }

    // ── a2ea1529 item 11: edit the owner's site (W1, Day 227) ───────────────────────────────
    // Same shape as the business plan's section editor -- fixed slots, autosave, no-JS fallback
    // -- NOT the click-to-edit WYSIWYG UI (that is 2df0e973, still to come, per Cloud's ruling
    // driven on demo.bizxm.com pages the owner edits, not lab pages). This is the honest
    // structural piece: real ordered sections, really persisted, really rendered publicly.
    // 2df0e973 click-to-edit (W1, Day 227): RETIRES this route's old form-based editor,
    // resolving the collision the previous handoff flagged rather than leaving it open --
    // editing now happens in place on the live page itself (renderSiteStyle3's owner mode),
    // so a second, divergent editor over the same page_sections rows served no purpose.
    // The dashboard tile ("Build the site") still points here; it just lands the owner where
    // the real editor now lives instead of a separate form.
    if (path === "/dashboard/site" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      return Response.redirect(`${url.origin}/site/${workspace.id}`, 302);
    }

    // ── 696d3b4c item 6 (W1, Day 227): the has-a-website flow ───────────────────────────────
    // Asks platform/host and the site URL ONCE (never a password -- the brief's own rule), then
    // shows what we can do for that platform. Health/SEO check and posting help are NOT built --
    // shown as coming soon rather than faked, same convention as the catch-all this route used to
    // fall through to. Recommendations reference the AI tools captured on /start (ai_tools_used)
    // per the brief's "take the AI tools they already use into account", as a text note -- no
    // actual AI-management connection exists yet to wire up.
    if (path === "/dashboard/website-check" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      if (!workspace.website_platform) {
        return await page(
          env,
          "Your website — BizXM",
          `<h1>Tell us about your website</h1>` +
            `<form method="post" action="/dashboard/website-check">` +
            `<div class="card">` +
            `<label>Platform or host<select name="website_platform" required>${WEBSITE_PLATFORM_OPTIONS.map(
              ([val, label]) => `<option value="${val}">${esc(label)}</option>`
            ).join("")}</select></label>` +
            `<label>Your website URL (optional)<input type="url" name="website_url" placeholder="https://example.com"></label>` +
            `<button type="submit">Continue</button>` +
            `</div></form>`,
          NAV_DASHBOARD
        );
      }
      const platformLabel = WEBSITE_PLATFORM_OPTIONS.find(([val]) => val === workspace.website_platform)?.[1] ?? workspace.website_platform;
      const tools = (workspace.ai_tools_used ?? []).filter((t) => t !== "none");
      const toolsNote = tools.length
        ? `<p class="muted">You told us you already use ${esc(tools.map((t) => AI_TOOLS_OPTIONS.find(([v]) => v === t)?.[1] ?? t).join(", "))} -- we'll take that into account as these land.</p>`
        : "";
      return await page(
        env,
        "Your website — BizXM",
        `<h1>What we can do for your ${esc(platformLabel)} site</h1>` +
          (workspace.website_url ? `<p class="muted">${esc(workspace.website_url)}</p>` : "") +
          `<div class="card"><h3>Health and SEO check</h3><p>A full check of your live site's speed, mobile-friendliness and search visibility is coming soon.</p></div>` +
          `<div class="card"><h3>Content and posting help</h3><p>Drafting posts and content for your existing site is coming soon.</p></div>` +
          `<div class="card"><h3>AI management or moving to us</h3><p>Connecting AI management where your platform allows it, or moving your site to BizXM, is coming soon.</p>${toolsNote}</div>` +
          `<p class="muted"><a href="/dashboard/website-check/edit">Change platform or URL</a></p>`,
        NAV_DASHBOARD
      );
    }

    if (path === "/dashboard/website-check/edit" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      return await page(
        env,
        "Your website — BizXM",
        `<h1>Tell us about your website</h1>` +
          `<form method="post" action="/dashboard/website-check">` +
          `<div class="card">` +
          `<label>Platform or host<select name="website_platform" required>${WEBSITE_PLATFORM_OPTIONS.map(
            ([val, label]) => `<option value="${val}"${workspace.website_platform === val ? " selected" : ""}>${esc(label)}</option>`
          ).join("")}</select></label>` +
          `<label>Your website URL (optional)<input type="url" name="website_url" value="${esc(workspace.website_url ?? "")}" placeholder="https://example.com"></label>` +
          `<button type="submit">Save</button>` +
          `</div></form>`,
        NAV_DASHBOARD
      );
    }

    if (path === "/dashboard/website-check" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const form = await req.formData();
      const website_platform = String(form.get("website_platform") || "").trim();
      if (!WEBSITE_PLATFORM_OPTIONS.some(([val]) => val === website_platform)) {
        return await page(env, "Your website — BizXM", `<p>Please choose a platform. <a href="/dashboard/website-check/edit">Back</a></p>`, NAV_DASHBOARD);
      }
      const website_url = String(form.get("website_url") || "").trim() || null;
      await fetch(`${env.SUPABASE_URL}/rest/v1/workspaces?id=eq.${workspace.id}`, {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ website_platform, website_url }),
      });
      return Response.redirect(`${url.origin}/dashboard/website-check`, 302);
    }

      // other sub-tiles are stretch/other pieces -- placeholder so the routes exist and are
      // gated, never a 404 that reads as "not built" vs "not authorised".
      return await page(env, "Coming soon", `<p>This step is being built.</p>`, NAV_DASHBOARD);
    }

    // ── account: profile / account / subscription (Darren bench 12:2xZ, W1, Day 227) ───────
    if (path === "/account" && req.method === "GET") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      const displayName = workspace?.display_name || "";
      const planLabel = workspace?.plan === "free" || !workspace?.plan
        ? "Free, test mode"
        : `${workspace.plan} (${workspace.plan_status})`;
      return await page(env, 
        "Account — BizXM",
        `<h1>Account</h1>` +
          `<div class="card"><h3>Profile</h3>` +
          `<form method="post" action="/account">` +
          `<label>Display name<input type="text" name="display_name" value="${displayName.replace(/"/g, "&quot;")}" placeholder="e.g. Darren"></label>` +
          `<button type="submit">Save</button></form></div>` +
          `<div class="card"><h3>Account</h3>` +
          `<p><strong>Email:</strong> ${user.email}<br>` +
          `<strong>Sign-in method:</strong> ${user.provider}</p>` +
          `<form method="post" action="/auth/logout"><button type="submit" class="btn-secondary">Sign out</button></form></div>` +
          `<div class="card"><h3>Subscription</h3>` +
          // ⛔ Piece 6, Payments (brief 2fdd8d91). "Free, test mode" is a literal placeholder
          // until Stripe lands, per Cloud's instruction -- not a guess at a real plan name.
          `<p>${planLabel}</p></div>` +
          `<div class="card"><h3>Company details</h3>` +
          `<p class="muted">Trading name, address, currency and tax registration -- also sets up your accounting profile.</p>` +
          `<p><a href="/dashboard/company">Edit company details</a></p></div>`,
        NAV_DASHBOARD
      );
    }

    if (path === "/account" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      const workspace = await getWorkspace(user.id, env);
      if (!workspace) return new Response("No workspace found for this user.", { status: 500 });
      const form = await req.formData();
      const display_name = String(form.get("display_name") || "").trim() || null;
      await fetch(`${env.SUPABASE_URL}/rest/v1/workspaces?id=eq.${workspace.id}`, {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ display_name }),
      });
      return Response.redirect(`${url.origin}/account`, 302);
    }

    // ── admin: gated, AND scoped to a workspace-owner allowlist, not "any authed user" ──────
    if (path === "/admin") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      // ⛔ NO ADMIN ROLE COLUMN YET. Temporary: gate on an explicit email allowlist read from
      // an env var, never "every signed-in user". README names this as owed, not silently
      // shipped as if it were the real admin model.
      const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim()).filter(Boolean);
      if (!admins.includes(user.email)) {
        return new Response("Not authorised.", { status: 403 });
      }
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/workspaces?select=id,owner_user_id,name,created_at&order=created_at.desc`,
        { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const workspaces = r.ok ? ((await r.json()) as Array<{ id: string; name: string; created_at: string }>) : [];
      const rows = workspaces
        .map((w) => `<tr><td>${w.name}</td><td>${w.created_at}</td><td><code>${w.id}</code></td></tr>`)
        .join("");
      return await page(env, 
        "Admin",
        `<h1>Admin — all workspaces (${workspaces.length})</h1><table><tr><th>Name</th><th>Created</th><th>Workspace id</th></tr>${rows}</table>`,
        NAV_DASHBOARD
      );
    }

    // ── payments: Stripe Checkout, webhook, Customer Portal (brief 2fdd8d91) ──────────────
    // ⛔ STUBBED, NOT WIRED: no Stripe credential exists on this box yet (Google-secret-shaped
    // blocker, reported separately). Routes exist and are gated so the shape is reviewable and
    // Sterling can read the flow before a single real key touches it. Every TODO names exactly
    // what the missing env var would let it do -- nothing here is a guess at Stripe's API shape,
    // it is written against Stripe's documented Checkout Session + webhook contract, just not
    // executed yet.
    if (path === "/dashboard/billing/checkout" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      return new Response(
        "Stripe checkout not yet wired -- STRIPE_SECRET_KEY and STRIPE_PRICE_ID are not set on " +
          "this Worker. See README.md, brief 2fdd8d91.",
        { status: 501 }
      );
      // TODO once the key lands: POST https://api.stripe.com/v1/checkout/sessions
      //   mode=subscription, line_items[0][price]=env.STRIPE_PRICE_ID, line_items[0][quantity]=1,
      //   customer=<workspace.stripe_customer_id if set, else omit and let Stripe create one>,
      //   client_reference_id=<workspace.id> (so the webhook can find the workspace without a
      //   round trip), success_url=`${url.origin}/dashboard?checkout=success`,
      //   cancel_url=`${url.origin}/dashboard?checkout=cancelled` -- then 303 to session.url.
    }

    if (path === "/dashboard/billing/portal" && req.method === "POST") {
      const user = await getUser(req, env);
      if (!user) return Response.redirect(`${url.origin}/`, 302);
      return new Response(
        "Stripe Customer Portal not yet wired -- STRIPE_SECRET_KEY is not set on this Worker.",
        { status: 501 }
      );
      // TODO: POST https://api.stripe.com/v1/billing_portal/sessions with the workspace's
      // stripe_customer_id, return_url=`${url.origin}/dashboard` -- 303 to session.url. Refuse
      // (403) if the workspace has no stripe_customer_id yet -- a portal session needs a real
      // Stripe customer, and offering the button before checkout has ever run is a dead end.
    }

    if (path === "/webhooks/stripe" && req.method === "POST") {
      // ⛔ NO AUTH CHECK HERE ON PURPOSE -- Stripe calls this, not a signed-in user. The
      // signature header IS the auth. Verification not yet possible: no STRIPE_WEBHOOK_SECRET.
      return new Response("Webhook receiver not yet wired -- STRIPE_WEBHOOK_SECRET is not set.", {
        status: 501,
      });
      // TODO once the secret lands: read the `Stripe-Signature` header, verify it against the
      // RAW request body (never JSON.parse first -- Stripe's HMAC is over the exact bytes sent;
      // parsing and re-serialising WILL break the signature) using Web Crypto HMAC-SHA256, the
      // documented Stripe webhook algorithm. On checkout.session.completed and
      // customer.subscription.updated/deleted: write plan + plan_status onto the workspace row
      // keyed by client_reference_id (checkout) or by matching stripe_customer_id (subscription
      // events), via the SERVICE ROLE key -- this is the ONLY write path for those two columns,
      // matching the schema.sql comment. Reject (400) on a bad signature, never process the body
      // -- a webhook that trusts an unverified signature accepts a forged payment confirmation.
    }

    return new Response("Not found.", { status: 404 });
  },
};
