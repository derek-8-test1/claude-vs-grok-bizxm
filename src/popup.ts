// c93cd200 (W1, Day 227): popup.bizxm.com -- a pop-up food events platform, SAME Worker and
// Supabase project as demo.bizxm.com, routed by host (see index.ts's top-level host check).
// Kept in its OWN FILE, not interleaved into index.ts's demo routes, precisely because Sterling
// is adding templates 2 and 3 alongside this one (Cloud's split, c93cd200) -- one file per
// product's routes is what lets two bodies build in the same repo without touching the same
// lines. Add TEMPLATE_2 / TEMPLATE_3 render functions here, register them in POPUP_TEMPLATES,
// never inside index.ts.
//
// Item 1 (this file, W1): host routing (index.ts), public landing, template 1 at /t/1, the
// operator waitlist form (POST, degrades honestly if item 3's `waitlist` table is not live yet
// -- never claims a submission succeeded when it did not reach a table).
// Item 5 (this file, W1): the public event page (/event/<id>) and the real carousel, reading
// Silver's popup_events (RLS-verified 8/8: anon read is published-only, so a status filter here
// is redundant for an anon caller -- kept anyway because this uses the SERVICE ROLE key, which
// bypasses RLS entirely, and a service-role query with no filter would leak drafts).
// NOT built here: user/admin back ends (items 4, 6), the seed event (item 7).

type Env = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  // c93cd200 item 3 (Silver): the admin back end reuses the EXISTING isDarren()/ADMIN_EMAILS
  // allowlist rather than inventing a second admin concept -- same binding index.ts reads.
  ADMIN_EMAILS: string;
};

// c93cd200 item 5 (W1, Day 227): the widened shape every template renders from -- Cloud's exact
// field list. Optional fields are genuinely optional in the schema (nullable columns), never
// guessed or defaulted to an empty string here; each render function decides how to handle null.
type PopupEvent = {
  id: string;
  title: string;
  food_or_format: string | null;
  city: string | null;
  venue_or_area: string | null;
  starts_at: string | null;
  cover_image_url: string | null;
};

function escp(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Content blocks every template shares (c93cd200 item 2's own list): hero, carousel of upcoming
// events, how it works for operators, locations and makers, register your pop-up, operator
// waitlist form. Each render function below decides ONLY the look; the copy lives here once so
// three very-different-looking pages never drift on what they actually say.
const COPY = {
  brand: "Pop-Up",
  hero_title: "Find your next pop-up. Or throw one.",
  hero_sub: "A home for street-food pop-ups, chef takeovers and maker markets — discover what's on, or get your own pop-up in front of people.",
  how_it_works: [
    ["Register your pop-up", "Tell us the food or format, the city, and roughly when — takes a couple of minutes."],
    ["We list it", "Your event goes live on the calendar and carousel once you publish it."],
    ["People show up", "Soft RSVPs, no payment through us — you run the event your way."],
  ],
  waitlist_intro: "Operators, locations and makers: join the waitlist and we'll reach out as spots open up.",
};

// c93cd200 item 8 (W1, Day 227): the site shell -- ONE header, footer and body wrapper around
// every popup.bizxm.com page, sourced from popup_pages (Silver's table, seeded row 'shell'), not
// hard-coded per template. Body shape is deliberately loose (jsonb) -- Silver's own ruling: "the
// body shape is YOURS to decide". Each template keeps its OWN visual theme (colour, type) for
// the shell markup -- item 2's "deliberately very different" requirement and item 8's "one
// shared header" are not in tension: what is SHARED is the DATA (brand, links, footer text),
// never the paint.
type PopupLink = { href: string; label: string };
type PopupShell = { title: string; nav: PopupLink[]; footer: string; footer_links: PopupLink[]; login_label: string };
const SHELL_FALLBACK: PopupShell = {
  title: COPY.brand,
  nav: [{ href: "/", label: "Home" }],
  footer: `${COPY.brand} — a MeridianXM product.`,
  footer_links: [],
  login_label: "Login",
};
async function getPopupPageRow(slug: string, env: Env): Promise<{ title: string | null; body: Record<string, unknown> } | null> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/popup_pages?slug=eq.${encodeURIComponent(slug)}&select=title,body`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) return null;
  const rows = (await r.json()) as Array<{ title: string | null; body: Record<string, unknown> }>;
  return rows[0] ?? null;
}
async function getPopupShell(env: Env): Promise<PopupShell> {
  const row = await getPopupPageRow("shell", env);
  if (!row) return SHELL_FALLBACK;
  const body = row.body || {};
  const nav = Array.isArray(body.nav) ? (body.nav as PopupLink[]) : SHELL_FALLBACK.nav;
  const footerLinks = Array.isArray(body.footer_links) ? (body.footer_links as PopupLink[]) : SHELL_FALLBACK.footer_links;
  return {
    title: row.title || SHELL_FALLBACK.title,
    nav: nav.length ? nav : SHELL_FALLBACK.nav,
    footer: typeof body.footer === "string" ? body.footer : SHELL_FALLBACK.footer,
    footer_links: footerLinks,
    login_label: typeof body.login_label === "string" ? body.login_label : SHELL_FALLBACK.login_label,
  };
}

// c93cd200 item 8, round 2 (Cloud's review, 7082bfbc, Darren named it twice): every section of
// "/" moves from the COPY constant into popup_pages so it is a database edit, not a code edit --
// slug 'home'. Sidebar blocks are new: stacked below content on narrow screens (CSS), rendered
// only when the row has blocks, never a fixed empty aside.
type PopupContentBlock = { heading: string; body: string };
type PopupHomeContent = {
  hero: { title: string; subtitle: string; cta_label: string; cta_href: string };
  how_it_works: PopupContentBlock[];
  waitlist_intro: string;
  sidebar: PopupContentBlock[];
};
const HOME_FALLBACK: PopupHomeContent = {
  hero: { title: COPY.hero_title, subtitle: COPY.hero_sub, cta_label: "Register your pop-up", cta_href: "#waitlist" },
  how_it_works: COPY.how_it_works.map(([heading, body]) => ({ heading, body })),
  waitlist_intro: COPY.waitlist_intro,
  sidebar: [],
};
async function getPopupHomeContent(env: Env): Promise<PopupHomeContent> {
  const row = await getPopupPageRow("home", env);
  if (!row) return HOME_FALLBACK;
  const body = row.body || {};
  const hero = (body.hero as Partial<PopupHomeContent["hero"]>) || {};
  const howItWorks = Array.isArray(body.how_it_works) ? (body.how_it_works as PopupContentBlock[]) : HOME_FALLBACK.how_it_works;
  const sidebar = Array.isArray(body.sidebar) ? (body.sidebar as PopupContentBlock[]) : HOME_FALLBACK.sidebar;
  return {
    hero: {
      title: hero.title || HOME_FALLBACK.hero.title,
      subtitle: hero.subtitle || HOME_FALLBACK.hero.subtitle,
      cta_label: hero.cta_label || HOME_FALLBACK.hero.cta_label,
      cta_href: hero.cta_href || HOME_FALLBACK.hero.cta_href,
    },
    how_it_works: howItWorks.length ? howItWorks : HOME_FALLBACK.how_it_works,
    waitlist_intro: typeof body.waitlist_intro === "string" ? body.waitlist_intro : HOME_FALLBACK.waitlist_intro,
    sidebar,
  };
}

// Item 9 (Silver): operator sign-up/login lands on the popup host. The Login link below points
// at it by convention (/login), live now.
// c93cd200 item 8 round 2, point 4 (Cloud's review): at 400px the nav wrapped onto two lines --
// collapse into a menu button below MENU_BREAKPOINT. Pure CSS checkbox toggle, no script needed.
function shellNavHtml(shell: PopupShell): string {
  const links = shell.nav.map((item) => `<a href="${escp(item.href)}">${escp(item.label)}</a>`).join("") + `<a href="/login">${escp(shell.login_label)}</a>`;
  return (
    `<input type="checkbox" id="pu-menu-toggle" class="pu-menu-toggle">` +
    `<label for="pu-menu-toggle" class="pu-menu-btn" aria-label="Menu">&#9776;</label>` +
    `<div class="menu">${links}</div>`
  );
}
function shellFooterHtml(shell: PopupShell, templateLabel: string): string {
  const links = shell.footer_links.length
    ? `<div class="pu-footer-links">${shell.footer_links.map((l) => `<a href="${escp(l.href)}">${escp(l.label)}</a>`).join(" &middot; ")}</div>`
    : "";
  return `<footer>${links}<p>${escp(shell.footer)} <span class="pu-template-tag">${escp(templateLabel)}</span></p></footer>`;
}

// c93cd200 item 5 (Silver, Day 227): WIDENED. The three original fields are untouched so every
// existing reader (templates 1, 2 and 3) keeps working -- additive, never reshaped.
export type PopupCard = {
  id: string;
  title: string;
  city: string;
  date: string;
  food_or_format: string;
  venue_or_area: string;
  cover_image_url: string;
  ends: string;
};

async function getPublishedEventsPreview(env: Env): Promise<PopupCard[]> {
  // c93cd200 item 3 (Silver, Day 227): the table landed, so this is a real query now -- W1's own
  // instruction in the placeholder it replaces. PUBLISHED only, and the filter is stated here
  // rather than left to RLS because this runs on the SERVICE ROLE, where RLS does not apply.
  // Still never faked: on any failure this returns [] and the page renders its honest
  // "nothing published yet" state rather than inventing cards.
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?status=eq.published&select=id,title,city,venue_or_area,food_or_format,cover_image_url,starts_at,ends_at&order=starts_at.asc&limit=12`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      id: string; title: string; city: string | null; venue_or_area: string | null;
      food_or_format: string | null; cover_image_url: string | null;
      starts_at: string | null; ends_at: string | null;
    }>;
    return rows.map((e) => ({
      id: e.id,
      title: e.title,
      city: e.city || "",
      // A date with no date in it is not a date: render the day, not a time of day, and fall
      // back to an empty string rather than the string "Invalid Date" or "null".
      date: e.starts_at ? new Date(e.starts_at).toISOString().slice(0, 10) : "",
      food_or_format: e.food_or_format || "",
      venue_or_area: e.venue_or_area || "",
      cover_image_url: e.cover_image_url || "",
      ends: e.ends_at ? new Date(e.ends_at).toISOString().slice(11, 16) : "",
    }));
  } catch {
    return [];
  }
}

function carouselHtml(events: Array<{ title: string; city: string; date: string; id?: string; food_or_format?: string }>): string {
  if (!events.length) {
    return `<p class="pu-empty">No pop-ups published yet — check back soon, or be the first to register one below.</p>`;
  }
  // c93cd200 item 5 (Silver): the card is now a LINK to the event page. `id` is optional on the
  // parameter type on purpose -- templates 1 and 2 are dead routes kept as a record and call
  // this with the old three-field objects. A card with no id renders exactly as it did before
  // rather than producing an href to "/e/undefined".
  return (
    `<div class="pu-carousel">` +
    events
      .map((e) => {
        const inner =
          `<strong>${escp(e.title)}</strong><br><span>${escp(e.city)} &middot; ${escp(e.date)}</span>` +
          (e.food_or_format ? `<br><span class="pu-card-fmt">${escp(e.food_or_format)}</span>` : "");
        return e.id
          ? `<a class="pu-card" href="/e/${escp(e.id)}">${inner}</a>`
          : `<div class="pu-card">${inner}</div>`;
      })
      .join("") +
    `</div>`
  );
}

// c93cd200 item 8 round 2: `intro` now comes from popup_pages (home.waitlist_intro), defaulting
// to the retired COPY constant only for templates 1/2, which are dead routes kept as a record
// and still call this with one argument.
function waitlistFormHtml(status: string | null, intro: string = COPY.waitlist_intro): string {
  const banner =
    status === "ok"
      ? `<p class="pu-ok">Thanks — you're on the list.</p>`
      : status === "pending"
      ? `<p class="pu-ok">Thanks — we're setting up the waitlist right now and will follow up once it's ready. Your details were not saved this time, please check back soon.</p>`
      : status === "error"
      ? `<p class="pu-error">That did not go through. Please try again.</p>`
      : "";
  // Field set matches Silver's popup_waitlist table exactly (c93cd200 item 3, migrations/
  // c93cd200-item3-popup-schema.sql): role, city, contact, note -- no separate name/email
  // columns, so "contact" is deliberately one free-text field (email, phone or handle).
  return (
    `<div class="pu-waitlist"><h3>Operator, location or maker waitlist</h3><p>${escp(intro)}</p>${banner}` +
    `<form method="post" action="/popup/waitlist">` +
    `<label>Role<select name="role"><option value="operator">Pop-up operator</option><option value="location">Location owner</option><option value="maker">Maker</option></select></label>` +
    `<label>City<input type="text" name="city"></label>` +
    `<label>Contact (email, phone or handle)<input type="text" name="contact" required></label>` +
    `<label>Note (optional)<textarea name="note" rows="2"></textarea></label>` +
    `<button type="submit">Join the waitlist</button>` +
    `</form></div>`
  );
}

// ── Template 1 (W1): bold street-food-poster look -- big type, high contrast, punchy blocks. ──
function renderTemplate1(events: Array<{ title: string; city: string; date: string }>, waitlistStatus: string | null): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escp(COPY.brand)} — pop-up events</title>` +
    `<style>
      :root{--bg:#1A1310;--panel:#241B16;--ink:#FFF6EC;--muted:#C9B8A8;--accent:#FF4B1F;--accent2:#FFC93C;}
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--ink);font-family:"Arial Black",Impact,"Trebuchet MS",sans-serif}
      .wrap{max-width:960px;margin:0 auto;padding:24px}
      .topnav{padding:20px 0;display:flex;justify-content:space-between;align-items:center}
      .topnav .brand{font-size:26px;letter-spacing:1px;color:var(--accent2);text-decoration:none;text-transform:uppercase}
      .hero{padding:48px 0 32px;border-bottom:4px solid var(--accent)}
      .hero h1{font-size:56px;line-height:1.02;margin:0 0 16px;text-transform:uppercase;color:var(--ink)}
      .hero p{font-family:Verdana,sans-serif;font-size:17px;color:var(--muted);max-width:520px;line-height:1.5}
      .cta{display:inline-block;margin-top:20px;padding:16px 32px;background:var(--accent);color:#fff;font-size:18px;text-decoration:none;text-transform:uppercase;border-radius:4px}
      h2{font-size:28px;text-transform:uppercase;color:var(--accent2);margin:40px 0 16px}
      .pu-carousel{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px}
      .pu-card{min-width:200px;background:var(--panel);border:2px solid var(--accent);border-radius:6px;padding:16px;font-family:Verdana,sans-serif;font-size:14px}
      .pu-empty{font-family:Verdana,sans-serif;color:var(--muted)}
      .how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
      @media(max-width:640px){.how-grid{grid-template-columns:1fr}.hero h1{font-size:38px}}
      .how-grid div{background:var(--panel);border-radius:6px;padding:18px;font-family:Verdana,sans-serif}
      .how-grid strong{color:var(--accent2);display:block;margin-bottom:6px;font-size:15px}
      .how-grid span{color:var(--muted);font-size:13.5px;line-height:1.5}
      .pu-waitlist{background:var(--panel);border-radius:8px;padding:24px;font-family:Verdana,sans-serif;margin-top:16px}
      .pu-waitlist h3{color:var(--accent2);text-transform:uppercase;margin:0 0 8px}
      .pu-waitlist label{display:block;margin-bottom:12px;font-size:13px;color:var(--muted)}
      .pu-waitlist input,.pu-waitlist select,.pu-waitlist textarea{width:100%;padding:10px;margin-top:4px;border-radius:4px;border:1px solid #4a382c;background:#0f0b09;color:var(--ink);font-family:inherit}
      .pu-waitlist button{margin-top:8px;padding:12px 24px;background:var(--accent);color:#fff;border:none;border-radius:4px;font-size:15px;text-transform:uppercase;cursor:pointer}
      .pu-ok{color:var(--accent2)}
      .pu-error{color:var(--accent)}
      footer{padding:32px 0;color:var(--muted);font-family:Verdana,sans-serif;font-size:12px}
    </style></head><body>` +
    `<div class="wrap">` +
    `<nav class="topnav"><a class="brand" href="/">${escp(COPY.brand)}</a></nav>` +
    `<div class="hero"><h1>${escp(COPY.hero_title)}</h1><p>${escp(COPY.hero_sub)}</p><a class="cta" href="#waitlist">Register your pop-up</a></div>` +
    `<h2>Upcoming pop-ups</h2>${carouselHtml(events)}` +
    `<h2>How it works</h2><div class="how-grid">${COPY.how_it_works.map(([t, d]) => `<div><strong>${escp(t)}</strong><span>${escp(d)}</span></div>`).join("")}</div>` +
    `<h2 id="waitlist">Register your pop-up</h2>${waitlistFormHtml(waitlistStatus)}` +
    `<footer>&copy; ${escp(COPY.brand)} — a MeridianXM product. Template 1.</footer>` +
    `</div></body></html>`
  );
}

// c93cd200 item 2 (Sterling, Day 227), staged as code_transfer fec70e24, sha256[:16]
// d8f75af935833d45 -- verified byte-identical before integration. Reuses escp, COPY,
// carouselHtml and waitlistFormHtml verbatim, no redefinition (Cloud + W1 both confirmed).
// Kept on the NARROW {title,city,date} event type for now per Cloud's ruling (f2ab85cf):
// widen all three template annotations TOGETHER when item 5 lands, not template-by-template.

// ── Template 2: calm, restaurateur-grade editorial. Warm off-white, a single deep-green accent,
//    generous whitespace, a serif display face for the hero -- reads like a nice food magazine or
//    a chef's own site, the opposite mood from template 1's loud poster. ──────────────────────
function renderTemplate2(events: Array<{ title: string; city: string; date: string }>, waitlistStatus: string | null): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escp(COPY.brand)} — pop-up events</title>` +
    `<style>
      :root{--bg:#FAF6EF;--panel:#FFFFFF;--ink:#2B2620;--muted:#7A7168;--line:#E4DACB;--accent:#2F5D3A;--accent-soft:#EDF2E8;}
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--ink);font-family:Georgia,"Times New Roman",serif}
      .wrap{max-width:880px;margin:0 auto;padding:0 28px}
      .topnav{padding:32px 0 24px;display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--line)}
      .topnav .brand{font-size:20px;letter-spacing:2px;text-transform:uppercase;color:var(--ink);text-decoration:none;font-family:Georgia,serif}
      .hero{padding:64px 0 40px;text-align:center}
      .hero h1{font-size:44px;line-height:1.2;margin:0 0 20px;font-weight:400;color:var(--ink)}
      .hero p{font-family:"Helvetica Neue",Arial,sans-serif;font-size:16px;color:var(--muted);max-width:480px;margin:0 auto;line-height:1.65}
      .cta{display:inline-block;margin-top:28px;padding:14px 30px;background:var(--accent);color:#fff;font-family:"Helvetica Neue",Arial,sans-serif;font-size:14px;letter-spacing:1px;text-transform:uppercase;text-decoration:none;border-radius:2px}
      h2{font-size:22px;font-weight:400;color:var(--ink);margin:56px 0 20px;text-align:center;font-style:italic}
      .pu-carousel{display:flex;gap:18px;overflow-x:auto;padding-bottom:12px}
      .pu-card{min-width:220px;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:20px;font-family:"Helvetica Neue",Arial,sans-serif;font-size:14px;line-height:1.5}
      .pu-card strong{font-family:Georgia,serif;font-size:16px;display:block;margin-bottom:4px}
      .pu-empty{font-family:"Helvetica Neue",Arial,sans-serif;color:var(--muted);text-align:center;font-size:14px}
      .how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
      @media(max-width:640px){.how-grid{grid-template-columns:1fr}.hero h1{font-size:30px}}
      .how-grid div{text-align:center;padding:0 8px}
      .how-grid strong{color:var(--accent);display:block;margin-bottom:8px;font-family:Georgia,serif;font-size:17px;font-weight:400}
      .how-grid span{color:var(--muted);font-family:"Helvetica Neue",Arial,sans-serif;font-size:13.5px;line-height:1.6}
      .pu-waitlist{background:var(--accent-soft);border-radius:6px;padding:32px;font-family:"Helvetica Neue",Arial,sans-serif;margin-top:8px}
      .pu-waitlist h3{color:var(--ink);font-family:Georgia,serif;font-weight:400;font-size:22px;margin:0 0 10px}
      .pu-waitlist p{color:var(--muted);font-size:14px;line-height:1.6}
      .pu-waitlist label{display:block;margin-bottom:14px;font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px}
      .pu-waitlist input,.pu-waitlist select,.pu-waitlist textarea{width:100%;padding:11px;margin-top:6px;border-radius:2px;border:1px solid var(--line);background:#fff;color:var(--ink);font-family:"Helvetica Neue",Arial,sans-serif;font-size:14px}
      .pu-waitlist button{margin-top:8px;padding:13px 28px;background:var(--accent);color:#fff;border:none;border-radius:2px;font-size:13px;letter-spacing:1px;text-transform:uppercase;cursor:pointer}
      .pu-ok{color:var(--accent)}
      .pu-error{color:#A5432C}
      footer{padding:48px 0;color:var(--muted);font-family:"Helvetica Neue",Arial,sans-serif;font-size:12px;text-align:center;border-top:1px solid var(--line);margin-top:24px}
    </style></head><body>` +
    `<div class="wrap">` +
    `<nav class="topnav"><a class="brand" href="/">${escp(COPY.brand)}</a></nav>` +
    `<div class="hero"><h1>${escp(COPY.hero_title)}</h1><p>${escp(COPY.hero_sub)}</p><a class="cta" href="#waitlist">Register your pop-up</a></div>` +
    `<h2>Upcoming pop-ups</h2>${carouselHtml(events)}` +
    `<h2>How it works</h2><div class="how-grid">${COPY.how_it_works.map(([t, d]) => `<div><strong>${escp(t)}</strong><span>${escp(d)}</span></div>`).join("")}</div>` +
    `<h2 id="waitlist">Register your pop-up</h2>${waitlistFormHtml(waitlistStatus)}` +
    `<footer>&copy; ${escp(COPY.brand)} — a MeridianXM product. Template 2.</footer>` +
    `</div></body></html>`
  );
}

// ── Template 3: playful, map-and-carousel. Bright pastel palette, rounded pill shapes, a location
//    "pin" motif throughout, friendly sans typography with a chunky display weight for the hero --
//    the loosest, most approachable of the three. ─────────────────────────────────────────────
function renderTemplate3(
  events: Array<{ title: string; city: string; date: string }>,
  waitlistStatus: string | null,
  shell: PopupShell,
  home: PopupHomeContent
): string {
  const sidebarHtml = home.sidebar.length
    ? `<aside class="pu-sidebar">${home.sidebar.map((b) => `<div class="pu-side-block"><strong>${escp(b.heading)}</strong><p>${escp(b.body)}</p></div>`).join("")}</aside>`
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escp(shell.title)} — pop-up events</title>` +
    `<style>
      :root{--bg:#FFF7F0;--panel:#FFFFFF;--ink:#2E2A44;--muted:#7A7594;--accent:#6C4FF6;--accent2:#FF8FA3;--accent3:#3FC1C9;--ring:#EFE7FF;}
      *{box-sizing:border-box}
      body{margin:0;background:var(--bg);color:var(--ink);font-family:"Trebuchet MS","Segoe UI",Verdana,sans-serif}
      .wrap{max-width:1040px;margin:0 auto;padding:0 24px}
      .topnav{padding:24px 0;display:flex;justify-content:space-between;align-items:center;position:relative}
      .topnav .brand{font-size:22px;font-weight:800;color:var(--accent);text-decoration:none}
      .topnav .brand::before{content:"\\1F4CD ";}
      .topnav .menu{display:flex;gap:18px;align-items:center}
      .topnav .menu a{color:var(--ink);text-decoration:none;font-size:14px;font-weight:700}
      .topnav .menu a:last-child{background:var(--accent);color:#fff;padding:8px 18px;border-radius:999px}
      .pu-menu-toggle{display:none}
      .pu-menu-btn{display:none;font-size:26px;cursor:pointer;color:var(--accent);line-height:1}
      footer{padding:36px 0;color:var(--muted);font-size:12px;text-align:center}
      footer .pu-footer-links{margin-bottom:10px;font-size:13px}
      footer .pu-footer-links a{color:var(--accent);text-decoration:none;font-weight:700}
      footer .pu-template-tag{opacity:0.6}
      .hero{padding:36px 0 32px;background:var(--ring);border-radius:28px;margin-top:8px;padding-left:32px;padding-right:32px;text-align:center}
      .hero h1{font-size:38px;line-height:1.15;margin:0 0 14px;font-weight:800;color:var(--ink)}
      .hero p{font-size:16px;color:var(--muted);max-width:460px;margin:0 auto;line-height:1.6}
      .cta{display:inline-block;margin-top:22px;padding:14px 30px;background:var(--accent);color:#fff;font-size:15px;font-weight:700;text-decoration:none;border-radius:999px;box-shadow:0 4px 0 #4A32C9}
      h2{font-size:22px;font-weight:800;color:var(--ink);margin:44px 0 18px}
      h2::before{content:"\\1F4CD  "}
      .pu-carousel{display:flex;gap:14px;overflow-x:auto;padding-bottom:10px}
      .pu-card{min-width:190px;background:var(--panel);border:3px solid var(--accent3);border-radius:20px;padding:16px;font-size:14px}
      .pu-card strong{display:block;margin-bottom:4px;color:var(--accent)}
      .pu-empty{color:var(--muted);font-size:14px;background:var(--panel);border-radius:16px;padding:20px;text-align:center}
      .how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
      .how-grid div{background:var(--panel);border-radius:20px;padding:20px;text-align:center;border:3px solid var(--accent2)}
      .how-grid strong{color:var(--accent);display:block;margin-bottom:8px;font-size:15.5px}
      .how-grid span{color:var(--muted);font-size:13.5px;line-height:1.55}
      .pu-layout{display:grid;grid-template-columns:1fr 260px;gap:24px;align-items:start}
      .pu-sidebar{display:flex;flex-direction:column;gap:14px}
      .pu-side-block{background:var(--panel);border:3px solid var(--accent);border-radius:18px;padding:16px}
      .pu-side-block strong{color:var(--accent);display:block;margin-bottom:6px;font-size:14.5px}
      .pu-side-block p{color:var(--muted);font-size:13px;line-height:1.5;margin:0}
      .pu-waitlist{background:var(--panel);border-radius:24px;padding:28px;margin-top:12px;border:3px dashed var(--accent2)}
      .pu-waitlist h3{color:var(--accent);font-size:20px;margin:0 0 8px;font-weight:800}
      .pu-waitlist p{color:var(--muted);font-size:14px;line-height:1.55}
      .pu-waitlist label{display:block;margin-bottom:12px;font-size:13px;color:var(--muted);font-weight:700}
      .pu-waitlist input,.pu-waitlist select,.pu-waitlist textarea{width:100%;padding:11px 14px;margin-top:5px;border-radius:14px;border:2px solid var(--ring);background:#FBFAFF;color:var(--ink);font-family:inherit;font-size:14px}
      .pu-waitlist button{margin-top:8px;padding:13px 26px;background:var(--accent3);color:#fff;border:none;border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 0 #2A8F95}
      .pu-ok{color:var(--accent3);font-weight:700}
      .pu-error{color:var(--accent2);font-weight:700}
      @media(max-width:800px){.pu-layout{grid-template-columns:1fr}}
      @media(max-width:640px){
        .how-grid{grid-template-columns:1fr}
        .hero h1{font-size:28px}
        .hero{padding-left:20px;padding-right:20px}
        .pu-menu-btn{display:block}
        .topnav .menu{display:none;position:absolute;top:100%;right:0;flex-direction:column;align-items:flex-start;background:var(--panel);border:3px solid var(--accent);border-radius:16px;padding:14px;gap:10px;z-index:1;min-width:200px}
        .pu-menu-toggle:checked ~ .menu{display:flex}
      }
    </style></head><body>` +
    `<div class="wrap">` +
    `<nav class="topnav"><a class="brand" href="/">${escp(shell.title)}</a>${shellNavHtml(shell)}</nav>` +
    `<div class="hero"><h1>${escp(home.hero.title)}</h1><p>${escp(home.hero.subtitle)}</p><a class="cta" href="${escp(home.hero.cta_href)}">${escp(home.hero.cta_label)}</a></div>` +
    `<h2>Upcoming pop-ups</h2>${carouselHtml(events)}` +
    `<div class="pu-layout">` +
    `<div>` +
    `<h2>How it works</h2><div class="how-grid">${home.how_it_works.map((b) => `<div><strong>${escp(b.heading)}</strong><span>${escp(b.body)}</span></div>`).join("")}</div>` +
    `<h2 id="waitlist">Register your pop-up</h2>${waitlistFormHtml(waitlistStatus, home.waitlist_intro)}` +
    `</div>` +
    sidebarHtml +
    `</div>` +
    shellFooterHtml(shell, "Template 3") +
    `</div></body></html>`
  );
}

// c93cd200 items 2/8: templates 1 and 2 (functions kept, not deleted -- Darren's pick was a
// review decision, not a verdict that this code is wrong) are RETIRED from routing the moment
// the shell ships on template 3, same deploy (Cloud's ruling, ebe0f1e1). /t/1, /t/2, /t/3 all
// 404 from here on; "/" is the one canonical URL.
// Kept only as a record of what existed during the review -- no route reads this any more
// (retired below). renderTemplate3 is not in it: its signature grew a `shell` parameter once it
// became the live template, so it no longer matches the other two's shape.
const RETIRED_POPUP_TEMPLATES: Record<string, (events: Array<{ title: string; city: string; date: string }>, waitlistStatus: string | null) => string> = {
  "1": renderTemplate1,
  "2": renderTemplate2,
};
void RETIRED_POPUP_TEMPLATES;

async function handleWaitlistPost(req: Request, env: Env): Promise<Response> {
  // c93cd200 items 2/8: "/" is now the only page (template 3, retired /t/N), so the referer
  // fallback matters less than it did, but is kept in case a future page adds its own form.
  const url = new URL(req.url);
  const referer = req.headers.get("referer");
  let returnPath = "/";
  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.hostname === url.hostname) returnPath = refUrl.pathname;
    } catch {
      /* malformed referer, keep the default */
    }
  }
  const redirectTo = (status: string) => Response.redirect(`${url.origin}${returnPath}?waitlist=${status}`, 302);
  const form = await req.formData();
  // Field set matches popup_waitlist exactly (role/city/contact/note) -- no name/email columns.
  const contact = String(form.get("contact") || "").trim();
  if (!contact) return redirectTo("error");
  const role = String(form.get("role") || "operator").trim();
  const city = String(form.get("city") || "").trim() || null;
  const note = String(form.get("note") || "").trim() || null;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/popup_waitlist`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ role, city, contact, note }),
  });
  // Defensive, not expected: a 404/undefined-table response would mean the table does not exist,
  // not that the submission is invalid -- degrade to an honest "pending" state rather than claim
  // success. Verified live: popup_waitlist already exists (Silver's migration), so this branch
  // should not fire, but the guard costs nothing to keep.
  if (r.status === 404 || r.status === 400) return redirectTo("pending");
  return redirectTo(r.ok ? "ok" : "error");
}

// ── c93cd200 item 3 (Silver, Day 227): popup API routes ─────────────────────────────────────
//
// ⛔ THE ONE PROPERTY EVERY ROUTE BELOW DEPENDS ON, STATED ONCE AT THE TOP BECAUSE GETTING IT
// WRONG IS SILENT: THE SERVICE ROLE KEY BYPASSES RLS ENTIRELY. The RLS on popup_events /
// popup_rsvps / popup_waitlist is driven and passing (8 anon arms, Day 227) and it protects the
// ANON key path only. On the service-role path there is NO owner filter, NO published filter and
// NO default-deny -- every one of those checks has to be re-asserted HERE, in the Worker, by
// hand. A route that forgets one does not fail: it returns another operator's data with a 200.
// ⇒ So each owner-scoped route below resolves the caller's OWN workspace id first and constrains
//   the query by it, rather than trusting an id from the request.
//
// Auth helpers are LOCAL to this file on purpose, and this is a deliberate, flagged duplication:
// index.ts already has getUser/parseCookies/isDarren, but index.ts IMPORTS this file, so
// importing back would be circular, and lifting them into a shared src/session.ts means editing
// index.ts while W1 is mid-flight on item 1 host routing. Unify into src/session.ts once item 1
// and item 2 have landed -- raised on fleet, not left as a silent copy.

function popupCookies(req: Request): Record<string, string> {
  const h = req.headers.get("Cookie") || "";
  const out: Record<string, string> = {};
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Same cookie name and the same "verify against GoTrue, never trust it unchecked" rule as
// index.ts's getUser. A decoded-but-unverified JWT is not a session.
async function popupUser(req: Request, env: Env): Promise<{ id: string; email: string } | null> {
  const raw = popupCookies(req)["bb_session"];
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
  const u = (await r.json()) as { id: string; email: string };
  return { id: u.id, email: u.email };
}

function popupIsDarren(email: string, env: Env): boolean {
  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

const SR = (env: Env) => ({
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  "content-type": "application/json",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The caller's OWN workspace, resolved from the verified session -- never from a request field.
async function popupOwnWorkspaceId(userId: string, env: Env): Promise<string | null> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/workspaces?owner_user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
    { headers: SR(env) },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as Array<{ id: string }>;
  return rows.length ? rows[0].id : null;
}

// Fields a client may set. Anything else in the body is IGNORED rather than merged, so a request
// cannot reach workspace_id, id or created_at by sending them.
const EVENT_WRITABLE = ["title", "food_or_format", "city", "venue_or_area", "starts_at", "ends_at", "capacity", "cover_image_url", "status"] as const;
const EVENT_SELECT = "id,workspace_id,title,food_or_format,city,venue_or_area,starts_at,ends_at,capacity,cover_image_url,status,created_at";

// Route shapes, declared ONCE. The unknown-path guard and the handlers below both match against
// these same objects -- a second copy of these patterns for the guard would be a second
// implementation of the dispatch, and it would drift the first time a route is added.
const R_EVENTS_COLLECTION = /^\/api\/popup\/events$/;
const R_EVENT_ONE = /^\/api\/popup\/events\/([0-9a-f-]{36})$/i;
const R_EVENT_RSVPS = /^\/api\/popup\/events\/([0-9a-f-]{36})\/rsvps$/i;
const R_EVENT_PUBLIC_ONE = /^\/api\/popup\/events\/([0-9a-f-]{36})\/public$/i;
const R_ADMIN = /^\/api\/popup\/admin\/(events|rsvps|waitlist)$/;
const R_PUBLIC_LIST = /^\/api\/popup\/events\/public$/;
const R_RSVP = /^\/api\/popup\/rsvp$/;
const POPUP_API_ROUTES = [
  R_PUBLIC_LIST,
  R_RSVP,
  R_EVENT_PUBLIC_ONE,
  R_EVENTS_COLLECTION,
  R_EVENT_ONE,
  R_EVENT_RSVPS,
  R_ADMIN,
];

function pickEventFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EVENT_WRITABLE) {
    if (k in body) out[k] = body[k];
  }
  return out;
}

// status is a CHECK constraint in the database; rejecting it here too gives the caller a 400 with
// a readable message instead of a 400 carrying a Postgres constraint string.
function badStatus(v: unknown): boolean {
  return v !== undefined && v !== "draft" && v !== "published";
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const b = await req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  // Templates post plain forms; accept both rather than making the page layer translate.
  const form = await req.formData();
  const out: Record<string, unknown> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : String(v);
  return out;
}

async function handlePopupApi(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;

  // ---- PUBLIC: the carousel and the public event page read this. Anon, no session. ---------
  // Filtered to published here as well as in RLS -- this runs on the SERVICE ROLE, where the
  // public-read policy does not apply, so the filter is the only thing keeping drafts private.
  if (R_PUBLIC_LIST.test(path) && method === "GET") {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?status=eq.published&select=${EVENT_SELECT}&order=starts_at.asc`,
      { headers: SR(env) },
    );
    if (!r.ok) return jsonResponse({ error: "could not load events" }, 502);
    return jsonResponse({ events: await r.json() });
  }

  const publicEventMatch = path.match(R_EVENT_PUBLIC_ONE);
  if (publicEventMatch && method === "GET") {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${publicEventMatch[1]}&status=eq.published&select=${EVENT_SELECT}`,
      { headers: SR(env) },
    );
    if (!r.ok) return jsonResponse({ error: "could not load event" }, 502);
    const rows = (await r.json()) as unknown[];
    // A draft and a non-existent event both 404 deliberately: a 403 on a draft would confirm to
    // a stranger that an unpublished event with that id exists.
    if (!rows.length) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse({ event: rows[0] });
  }

  // ---- PUBLIC: soft RSVP. No auth, no payment. Service-role insert after our own checks. ----
  if (R_RSVP.test(path) && method === "POST") {
    const body = await readBody(req);
    const eventId = String(body.event_id || "").trim();
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const partyRaw = body.party_size === undefined || body.party_size === "" ? 1 : Number(body.party_size);
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) return jsonResponse({ error: "event_id is required" }, 400);
    if (!name) return jsonResponse({ error: "name is required" }, 400);
    if (!email.includes("@")) return jsonResponse({ error: "a valid email is required" }, 400);
    if (!Number.isFinite(partyRaw) || partyRaw < 1) return jsonResponse({ error: "party_size must be 1 or more" }, 400);
    // An RSVP to a DRAFT event must not be possible from outside -- RLS cannot stop this one,
    // because we are on the service role, so the published check is here or it is nowhere.
    const ev = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${eventId}&status=eq.published&select=id`,
      { headers: SR(env) },
    );
    if (!ev.ok) return jsonResponse({ error: "could not check the event" }, 502);
    if (!((await ev.json()) as unknown[]).length) return jsonResponse({ error: "event not found" }, 404);
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/popup_rsvps`, {
      method: "POST",
      headers: { ...SR(env), Prefer: "return=minimal" },
      body: JSON.stringify({ event_id: eventId, name, email, party_size: Math.floor(partyRaw) }),
    });
    if (!r.ok) return jsonResponse({ error: "could not save the RSVP" }, 502);
    return jsonResponse({ ok: true }, 201);
  }

  // An unknown /api/popup/ path is a 404 BEFORE the auth gate. Without this it answers
  // "sign in required", and a body with a typo in a URL goes hunting through cookies and
  // sessions rather than reading their own path -- the expensive direction.
  if (!POPUP_API_ROUTES.some((re) => re.test(path))) {
    return jsonResponse({ error: "not found" }, 404);
  }

  // ---- OWNER ROUTES: everything below needs a verified session. ----------------------------
  const user = await popupUser(req, env);
  // adminKind is the SINGLE definition of which admin surfaces exist -- R_ADMIN's own
  // capture group, so the guard above and the handlers below cannot disagree.
  const adminMatch = path.match(R_ADMIN);
  const adminKind = adminMatch ? adminMatch[1] : null;
  const isAdminPath = path.startsWith("/api/popup/admin/");

  if (isAdminPath) {
    if (!user) return jsonResponse({ error: "sign in required" }, 401);
    if (!popupIsDarren(user.email, env)) return jsonResponse({ error: "not permitted" }, 403);
    // item 6: admin sees ALL events, ALL RSVPs and the whole waitlist.
    if (adminKind === "events" && method === "GET") {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/popup_events?select=${EVENT_SELECT}&order=created_at.desc`,
        { headers: SR(env) },
      );
      if (!r.ok) return jsonResponse({ error: "could not load events" }, 502);
      return jsonResponse({ events: await r.json() });
    }
    if (adminKind === "rsvps" && method === "GET") {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/popup_rsvps?select=id,event_id,name,email,party_size,created_at&order=created_at.desc`,
        { headers: SR(env) },
      );
      if (!r.ok) return jsonResponse({ error: "could not load RSVPs" }, 502);
      return jsonResponse({ rsvps: await r.json() });
    }
    if (adminKind === "waitlist" && method === "GET") {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/popup_waitlist?select=id,role,city,contact,note,created_at&order=created_at.desc`,
        { headers: SR(env) },
      );
      if (!r.ok) return jsonResponse({ error: "could not load the waitlist" }, 502);
      return jsonResponse({ waitlist: await r.json() });
    }
    return jsonResponse({ error: "not found" }, 404);
  }

  if (!user) return jsonResponse({ error: "sign in required" }, 401);
  const wsId = await popupOwnWorkspaceId(user.id, env);
  if (!wsId) return jsonResponse({ error: "no workspace for this account" }, 403);

  // GET /api/popup/events -- the caller's OWN events, drafts included.
  if (R_EVENTS_COLLECTION.test(path) && method === "GET") {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?workspace_id=eq.${wsId}&select=${EVENT_SELECT}&order=created_at.desc`,
      { headers: SR(env) },
    );
    if (!r.ok) return jsonResponse({ error: "could not load your events" }, 502);
    return jsonResponse({ events: await r.json() });
  }

  // POST /api/popup/events -- create. workspace_id comes from the SESSION, never the body.
  if (R_EVENTS_COLLECTION.test(path) && method === "POST") {
    const body = await readBody(req);
    const fields = pickEventFields(body);
    if (!String(fields.title || "").trim()) return jsonResponse({ error: "title is required" }, 400);
    if (badStatus(fields.status)) return jsonResponse({ error: "status must be draft or published" }, 400);
    if (fields.capacity !== undefined && fields.capacity !== null && fields.capacity !== "") {
      const c = Number(fields.capacity);
      if (!Number.isFinite(c) || c < 0) return jsonResponse({ error: "capacity must be a number" }, 400);
      fields.capacity = Math.floor(c);
    } else {
      delete fields.capacity;
    }
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/popup_events`, {
      method: "POST",
      headers: { ...SR(env), Prefer: "return=representation" },
      body: JSON.stringify({ ...fields, workspace_id: wsId }),
    });
    if (!r.ok) return jsonResponse({ error: "could not create the event" }, 502);
    const rows = (await r.json()) as unknown[];
    return jsonResponse({ event: rows[0] }, 201);
  }

  const eventMatch = path.match(R_EVENT_ONE);
  if (eventMatch) {
    const id = eventMatch[1];
    // PATCH -- edit, publish, unpublish. The workspace_id filter is what makes this the OWNER's
    // event: without it the service role would happily update anybody's row by id.
    if (method === "PATCH" || method === "PUT") {
      const body = await readBody(req);
      const fields = pickEventFields(body);
      if (badStatus(fields.status)) return jsonResponse({ error: "status must be draft or published" }, 400);
      if ("title" in fields && !String(fields.title || "").trim()) {
        return jsonResponse({ error: "title cannot be empty" }, 400);
      }
      if (!Object.keys(fields).length) return jsonResponse({ error: "nothing to update" }, 400);
      fields.updated_at = new Date().toISOString();
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}&select=${EVENT_SELECT}`,
        { method: "PATCH", headers: { ...SR(env), Prefer: "return=representation" }, body: JSON.stringify(fields) },
      );
      if (!r.ok) return jsonResponse({ error: "could not update the event" }, 502);
      const rows = (await r.json()) as unknown[];
      // ZERO rows means the id exists but is not this caller's, or does not exist at all. Both
      // are a 404 on purpose: a 403 would tell a caller that somebody else's event has this id.
      if (!rows.length) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ event: rows[0] });
    }
    if (method === "DELETE") {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}&select=id`,
        { method: "DELETE", headers: { ...SR(env), Prefer: "return=representation" } },
      );
      if (!r.ok) return jsonResponse({ error: "could not delete the event" }, 502);
      if (!((await r.json()) as unknown[]).length) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ ok: true });
    }
    if (method === "GET") {
      const r = await fetch(
        `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}&select=${EVENT_SELECT}`,
        { headers: SR(env) },
      );
      if (!r.ok) return jsonResponse({ error: "could not load the event" }, 502);
      const rows = (await r.json()) as unknown[];
      if (!rows.length) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ event: rows[0] });
    }
  }

  // GET /api/popup/events/<id>/rsvps -- the owner's own RSVP list plus a count (item 4).
  const rsvpMatch = path.match(R_EVENT_RSVPS);
  if (rsvpMatch && method === "GET") {
    const id = rsvpMatch[1];
    // Ownership is established against popup_events FIRST. popup_rsvps has no workspace_id of
    // its own, so there is nothing on that table to filter by -- the check has to happen here.
    const own = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}&select=id`,
      { headers: SR(env) },
    );
    if (!own.ok) return jsonResponse({ error: "could not check the event" }, 502);
    if (!((await own.json()) as unknown[]).length) return jsonResponse({ error: "not found" }, 404);
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_rsvps?event_id=eq.${id}&select=id,name,email,party_size,created_at&order=created_at.desc`,
      { headers: SR(env) },
    );
    if (!r.ok) return jsonResponse({ error: "could not load RSVPs" }, 502);
    const rsvps = (await r.json()) as Array<{ party_size: number }>;
    return jsonResponse({
      rsvps,
      count: rsvps.length,
      guests: rsvps.reduce((n, x) => n + (Number(x.party_size) || 0), 0),
    });
  }

  return jsonResponse({ error: "not found" }, 404);
}

// ── c93cd200 item 9 (Silver, Day 227): operator sign-up and login, magic link ────────────────
//
// ⛔ THE ONE DECISION IN HERE THAT IS NOT A DETAIL, STATED LOUDLY BECAUSE IT IS A DELIBERATE
// DIFFERENCE IN AUTH POSTURE BETWEEN TWO HOSTS ON ONE WORKER:
//   demo.bizxm.com  sign-in is INVITE-ONLY -- index.ts checks isAllowedEmail BEFORE calling
//                   Supabase at all, and that is untouched by this file.
//   popup.bizxm.com sign-up is OPEN to any email that can receive the link.
// Item 9 asks for "operator sign-up and login by email magic link". A sign-up an allowlist
// refuses is not a sign-up, so the popup host cannot inherit demo's allowlist and still be the
// product Darren described. The hosts are separated at index.ts's top-level host check, so this
// LOOSENS NOTHING on demo: an email that is refused there is still refused there.
// ⚠ WHAT IT DOES MEAN, said plainly rather than left for someone to discover: anyone with an
// email address can now create an account and a workspace on this Supabase project. They can
// only ever reach their OWN workspace's popup events (RLS plus the owner filters in
// handlePopupApi), but the account and the workspace are real. If that is not wanted, this is
// the fifteen lines to change and it should be changed BEFORE the link is given to the public.
//
// Verified email: the magic link IS the verification -- a session only exists for someone who
// received and opened the link at that address. No separate confirm step, and none is needed.
//
// ⛔ AND ONE THING DELIBERATELY NOT COPIED FROM index.ts's OWN LOGIN: it renders upstream error
// bodies into an HTML comment (`<!-- ${body.slice(0, 200)} -->`) on the failure paths.
// stripServedComments handles `/* */` only and says so in its own header, so an HTML comment
// reaches the browser verbatim. Raised on fleet rather than edited in another body's file
// mid-P0. Nothing below puts an upstream body in the response.

const POPUP_COOKIE = "bb_session";

function popupSetSessionCookie(access_token: string, refresh_token: string): string {
  const value = encodeURIComponent(JSON.stringify({ access_token, refresh_token }));
  // Host-only by omitting Domain: this cookie is for popup.bizxm.com and must not be presented
  // to demo.bizxm.com, which has a different auth posture (see the header above).
  return `${POPUP_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function popupClearSessionCookie(): string {
  return `${POPUP_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function popupShell(title: string, inner: string): string {
  // Minimal standalone chrome. ⚠ W1's item 8 shell (popup_pages) is the real header and footer;
  // this is deliberately plain so that when the shell lands it wraps these pages rather than
  // fighting a second set of styles. Do not grow this into a second shell.
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escp(title)}</title><style>` +
    `body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#faf7f2;color:#1b1b1b}` +
    `.wrap{max-width:34rem;margin:0 auto;padding:3rem 1.25rem}` +
    `h1{font-size:1.6rem;margin:0 0 .5rem}p{margin:.5rem 0 1rem}` +
    `label{display:block;font-weight:600;margin:0 0 .35rem}` +
    `input{width:100%;padding:.7rem .8rem;font-size:1rem;border:1px solid #cfc7ba;border-radius:.4rem;background:#fff;box-sizing:border-box}` +
    `button{margin-top:1rem;padding:.7rem 1.2rem;font-size:1rem;border:0;border-radius:.4rem;background:#c2410c;color:#fff;cursor:pointer}` +
    `.muted{color:#6b6357;font-size:.92rem}` +
    `.card{background:#fff;border:1px solid #e7e0d6;border-radius:.6rem;padding:1rem 1.1rem;margin:.6rem 0}` +
    `a{color:#c2410c}` +
    `</style></head><body><div class="wrap">${inner}</div></body></html>`
  );
}

function popupHtml(title: string, inner: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(popupShell(title, inner), {
    status,
    headers: { "content-type": "text/html;charset=utf-8", ...extraHeaders },
  });
}

async function handlePopupAuth(req: Request, env: Env, path: string, url: URL): Promise<Response | null> {
  // GET /login -- the form, and the "check your email" state after a send.
  if (path === "/login" && req.method === "GET") {
    const sent = url.searchParams.get("sent");
    const err = url.searchParams.get("err");
    if (sent) {
      return popupHtml(
        "Check your email",
        `<h1>Check your email</h1><p>If that address can receive mail, a sign-in link is on its way. ` +
        `Open it on this device and you will be signed in.</p>` +
        `<p class="muted">The link expires after a while. <a href="/login">Send another</a>.</p>`,
      );
    }
    // The error text is OURS, never the upstream body -- see the header of this section.
    const errHtml = err
      ? `<p class="muted" style="color:#b91c1c">${escp(
          err === "email" ? "That does not look like an email address." : "Could not send the link just now. Try again in a moment.",
        )}</p>`
      : "";
    return popupHtml(
      "Sign in",
      `<h1>Run a pop-up?</h1>` +
      `<p>Sign in or create an account to list your events. We email you a link -- no password to remember.</p>` +
      errHtml +
      `<form method="post" action="/login">` +
      `<label for="email">Your email</label>` +
      `<input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">` +
      `<button type="submit">Email me a sign-in link</button>` +
      `</form>` +
      `<p class="muted">New here? The same link creates your account.</p>`,
    );
  }

  // POST /login -- send the magic link. OPEN sign-up on this host, by design (header above).
  if (path === "/login" && req.method === "POST") {
    const form = await req.formData();
    const email = String(form.get("email") || "").trim();
    if (!email.includes("@") || email.length < 5) {
      return Response.redirect(`${url.origin}/login?err=email`, 302);
    }
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
      // email_redirect_to is STATED, never left to the project's Site URL default -- that
      // default belongs to demo.bizxm.com, so an unstated redirect would land popup operators
      // on the wrong host's callback and silently fail for every one of them.
      body: JSON.stringify({
        email,
        create_user: true,
        options: { email_redirect_to: `${url.origin}/auth/callback` },
      }),
    });
    if (!r.ok) {
      // Read and DISCARD the upstream body deliberately: it must not reach the page.
      await r.text();
      return Response.redirect(`${url.origin}/login?err=send`, 302);
    }
    // Same answer whether or not the address exists: a different page for a known address turns
    // this form into an account-enumeration oracle.
    return Response.redirect(`${url.origin}/login?sent=1`, 302);
  }

  // GET /auth/callback -- exchange the link's token for a session on THIS host.
  if (path === "/auth/callback" && req.method === "GET") {
    const token_hash = url.searchParams.get("token_hash");
    const type = url.searchParams.get("type") || "magiclink";
    if (!token_hash) {
      return popupHtml(
        "Sign in",
        `<h1>That link is incomplete</h1><p>It may have been cut short by your email app. ` +
        `<a href="/login">Request a new one</a>.</p>`,
        400,
      );
    }
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ token_hash, type }),
    });
    if (!r.ok) {
      await r.text();
      return popupHtml(
        "Sign in",
        `<h1>That link did not work</h1><p>It may have expired or already been used. ` +
        `<a href="/login">Request a new one</a>.</p>`,
        400,
      );
    }
    const data = (await r.json()) as { access_token?: string; refresh_token?: string };
    if (!data.access_token || !data.refresh_token) {
      return popupHtml("Sign in", `<h1>That link did not work</h1><p><a href="/login">Request a new one</a>.</p>`, 400);
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/dashboard`,
        "Set-Cookie": popupSetSessionCookie(data.access_token, data.refresh_token),
      },
    });
  }

  if (path === "/logout") {
    return new Response(null, {
      status: 302,
      headers: { Location: `${url.origin}/`, "Set-Cookie": popupClearSessionCookie() },
    });
  }

  // GET /dashboard -- where a signed-in operator lands. Item 4 builds the real back end on this;
  // what is here now is the honest minimum: it proves the session reached this host, names the
  // account, and lists the operator's own events by calling the item-3 route's own query path.
  if (path === "/dashboard" && req.method === "GET") {
    const user = await popupUser(req, env);
    if (!user) return Response.redirect(`${url.origin}/login`, 302);
    const wsId = await popupOwnWorkspaceId(user.id, env);
    if (!wsId) {
      // The signup trigger creates a workspace; this branch exists because "the trigger always
      // ran" is an assumption, not a fact, and a missing workspace must say so rather than
      // render an empty dashboard that looks like "you have no events".
      return popupHtml(
        "Your pop-ups",
        `<h1>Signed in as ${escp(user.email)}</h1>` +
        `<p>Your account has no workspace yet, so there is nowhere to put events. ` +
        `This is not an empty list -- it is a setup step that has not completed. ` +
        `<a href="/logout">Sign out</a></p>`,
        200,
      );
    }
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?workspace_id=eq.${wsId}&select=id,title,city,starts_at,status&order=created_at.desc`,
      { headers: SR(env) },
    );
    const events = r.ok ? ((await r.json()) as Array<{ id: string; title: string; city: string | null; starts_at: string | null; status: string }>) : null;
    const list =
      events === null
        ? `<p class="muted">Could not load your events just now. Reload in a moment.</p>`
        : events.length === 0
          ? `<p class="muted">You have not created a pop-up yet.</p>`
          : events
              .map(
                (e) =>
                  `<div class="card"><strong><a href="/dashboard/events/${escp(e.id)}">${escp(e.title)}</a></strong> ` +
                  `<span class="muted">${escp(e.status)}</span><br>` +
                  `<span class="muted">${escp(e.city || "")}${e.starts_at ? " &middot; " + escp(String(e.starts_at).slice(0, 10)) : ""}</span></div>`,
              )
              .join("");
    return popupHtml(
      "Your pop-ups",
      `<h1>Your pop-ups</h1><p class="muted">Signed in as ${escp(user.email)} &middot; <a href="/logout">Sign out</a></p>` +
      `<p><a href="/dashboard/events/new"><button type="button">Add a pop-up</button></a></p>` +
      list,
    );
  }

  return null;
}

// ── c93cd200 item 4 (Silver, Day 227): the signed-in operator's back end ─────────────────────
//
// Server-rendered forms, no client JS at all. Deliberate: this repo has NO client-JS checker
// (the fleet predeploy gate says so and calls itself UNMEASURED on that axis), so every line of
// browser JS added here is a line nothing checks. Forms post and redirect; it works with
// JavaScript off and there is nothing to leak.
//
// ⛔ These page routes do their own work rather than calling handlePopupApi and re-parsing its
// JSON, but they use THE SAME ownership rule and it is the same one line: every query is
// constrained by the caller's OWN workspace id, resolved from the verified session. The service
// role is underneath all of it and RLS is off there. If you add a page route here, that filter
// is yours to add too -- there is no layer below that will catch you.

function popupEventForm(action: string, ev: Partial<PopupEventRow> | null, submitLabel: string, err: string | null): string {
  const v = (k: keyof PopupEventRow) => escp(ev && ev[k] != null ? String(ev[k]) : "");
  // datetime-local wants `YYYY-MM-DDTHH:MM`; a stored timestamptz is longer and with the suffix
  // the browser silently renders an EMPTY field, which reads as "no date set" on an event that
  // has one -- and a form that quietly drops a value on every save is worse than one that errors.
  const dt = (k: keyof PopupEventRow) => (ev && ev[k] ? escp(String(ev[k]).slice(0, 16)) : "");
  return (
    (err ? `<p class="muted" style="color:#b91c1c">${escp(err)}</p>` : "") +
    `<form method="post" action="${escp(action)}">` +
    `<label for="title">Name of your pop-up</label>` +
    `<input id="title" name="title" required maxlength="140" value="${v("title")}">` +
    `<label for="food_or_format" style="margin-top:.8rem">Food or format</label>` +
    `<input id="food_or_format" name="food_or_format" placeholder="Neapolitan pizza, chef takeover, maker market" value="${v("food_or_format")}">` +
    `<label for="city" style="margin-top:.8rem">City</label>` +
    `<input id="city" name="city" value="${v("city")}">` +
    `<label for="venue_or_area" style="margin-top:.8rem">Venue or area</label>` +
    `<input id="venue_or_area" name="venue_or_area" value="${v("venue_or_area")}">` +
    `<label for="starts_at" style="margin-top:.8rem">Starts</label>` +
    `<input id="starts_at" name="starts_at" type="datetime-local" value="${dt("starts_at")}">` +
    `<label for="ends_at" style="margin-top:.8rem">Ends</label>` +
    `<input id="ends_at" name="ends_at" type="datetime-local" value="${dt("ends_at")}">` +
    `<label for="capacity" style="margin-top:.8rem">Capacity (optional)</label>` +
    `<input id="capacity" name="capacity" type="number" min="0" value="${v("capacity")}">` +
    `<label for="cover_image_url" style="margin-top:.8rem">Cover image URL (optional)</label>` +
    `<input id="cover_image_url" name="cover_image_url" type="url" value="${v("cover_image_url")}">` +
    `<button type="submit">${escp(submitLabel)}</button>` +
    `</form>`
  );
}

type PopupEventRow = {
  id: string;
  workspace_id: string;
  title: string;
  food_or_format: string | null;
  city: string | null;
  venue_or_area: string | null;
  starts_at: string | null;
  ends_at: string | null;
  capacity: number | null;
  cover_image_url: string | null;
  status: string;
  created_at: string;
};

// A datetime-local value is "YYYY-MM-DDTHH:MM" with NO zone. Postgres timestamptz would read it
// in the server's zone; we send it explicitly as UTC-naive rather than guessing the operator's
// zone, and say so on the form.
// ⚠ KNOWN AND DECLARED, not a silent choice: an operator in Berlin typing 19:00 gets 19:00 UTC.
// Per-operator timezones are not in item 4's spec and inventing one silently would be worse than
// the honest limitation. Flagged to Cloud.
function popupFormFields(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (k: string) => {
    const v = String(form.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  out.title = str("title");
  out.food_or_format = str("food_or_format");
  out.city = str("city");
  out.venue_or_area = str("venue_or_area");
  out.cover_image_url = str("cover_image_url");
  for (const k of ["starts_at", "ends_at"]) {
    const v = str(k);
    out[k] = v ? `${v}:00+00` : null;
  }
  const cap = str("capacity");
  out.capacity = cap === null ? null : Number.isFinite(Number(cap)) ? Math.floor(Number(cap)) : null;
  return out;
}

async function popupOwnEvent(id: string, wsId: string, env: Env): Promise<PopupEventRow | null> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}&select=${EVENT_SELECT}`,
    { headers: SR(env) },
  );
  if (!r.ok) return null;
  const rows = (await r.json()) as PopupEventRow[];
  return rows.length ? rows[0] : null;
}

async function handlePopupOperator(req: Request, env: Env, path: string, url: URL): Promise<Response | null> {
  if (!path.startsWith("/dashboard/")) return null;

  const user = await popupUser(req, env);
  if (!user) return Response.redirect(`${url.origin}/login`, 302);
  const wsId = await popupOwnWorkspaceId(user.id, env);
  if (!wsId) {
    return popupHtml("Your pop-ups", `<h1>No workspace on this account</h1><p>There is nowhere to put events yet. <a href="/dashboard">Back</a></p>`, 200);
  }

  // ---- new -----------------------------------------------------------------------------------
  if (path === "/dashboard/events/new") {
    if (req.method === "GET") {
      return popupHtml(
        "New pop-up",
        `<h1>New pop-up</h1><p class="muted">Times are UTC. <a href="/dashboard">Back to your pop-ups</a></p>` +
        popupEventForm("/dashboard/events/new", null, "Create as draft", url.searchParams.get("err")),
      );
    }
    if (req.method === "POST") {
      const fields = popupFormFields(await req.formData());
      if (!fields.title) return Response.redirect(`${url.origin}/dashboard/events/new?err=${encodeURIComponent("Give your pop-up a name.")}`, 302);
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/popup_events`, {
        method: "POST",
        headers: { ...SR(env), Prefer: "return=representation" },
        // workspace_id from the SESSION. status is forced to draft: publishing is its own
        // deliberate action on the next screen, never a side effect of creating.
        body: JSON.stringify({ ...fields, workspace_id: wsId, status: "draft" }),
      });
      if (!r.ok) {
        await r.text();
        return Response.redirect(`${url.origin}/dashboard/events/new?err=${encodeURIComponent("Could not save that. Try again.")}`, 302);
      }
      const rows = (await r.json()) as PopupEventRow[];
      return Response.redirect(`${url.origin}/dashboard/events/${rows[0].id}`, 302);
    }
  }

  const m = path.match(/^\/dashboard\/events\/([0-9a-f-]{36})(\/publish|\/unpublish|\/delete)?$/i);
  if (!m) return null;
  const id = m[1];
  const action = m[2] || "";

  // Ownership is resolved ONCE, here, for every branch below. A branch that skipped it would be
  // operating on another operator's event with full service-role rights.
  const ev = await popupOwnEvent(id, wsId, env);
  if (!ev) return popupHtml("Not found", `<h1>Not found</h1><p>That pop-up is not one of yours. <a href="/dashboard">Back</a></p>`, 404);

  if (action && req.method === "POST") {
    if (action === "/delete") {
      await fetch(`${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}`, { method: "DELETE", headers: SR(env) });
      return Response.redirect(`${url.origin}/dashboard`, 302);
    }
    const status = action === "/publish" ? "published" : "draft";
    await fetch(`${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}`, {
      method: "PATCH",
      headers: { ...SR(env), Prefer: "return=minimal" },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
    return Response.redirect(`${url.origin}/dashboard/events/${id}`, 302);
  }

  if (action) return popupHtml("Not found", `<h1>Not found</h1><a href="/dashboard">Back</a>`, 404);

  if (req.method === "POST") {
    const fields = popupFormFields(await req.formData());
    if (!fields.title) return Response.redirect(`${url.origin}/dashboard/events/${id}?err=${encodeURIComponent("Give your pop-up a name.")}`, 302);
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&workspace_id=eq.${wsId}`, {
      method: "PATCH",
      headers: { ...SR(env), Prefer: "return=minimal" },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) {
      await r.text();
      return Response.redirect(`${url.origin}/dashboard/events/${id}?err=${encodeURIComponent("Could not save that. Try again.")}`, 302);
    }
    return Response.redirect(`${url.origin}/dashboard/events/${id}?saved=1`, 302);
  }

  // ---- the event's own page: edit form, publish control, RSVP list ---------------------------
  const rs = await fetch(
    `${env.SUPABASE_URL}/rest/v1/popup_rsvps?event_id=eq.${id}&select=id,name,email,party_size,created_at&order=created_at.desc`,
    { headers: SR(env) },
  );
  const rsvps = rs.ok ? ((await rs.json()) as Array<{ id: string; name: string; email: string; party_size: number; created_at: string }>) : null;
  const guests = rsvps ? rsvps.reduce((n, x) => n + (Number(x.party_size) || 0), 0) : 0;

  const published = ev.status === "published";
  const publishBlock = published
    ? `<div class="card"><strong>Published.</strong> <span class="muted">It appears on the site and people can RSVP.</span>` +
      `<form method="post" action="/dashboard/events/${escp(id)}/unpublish"><button type="submit">Unpublish</button></form></div>`
    : `<div class="card"><strong>Draft.</strong> <span class="muted">Nobody can see it yet.</span>` +
      `<form method="post" action="/dashboard/events/${escp(id)}/publish"><button type="submit">Publish</button></form></div>`;

  // ⛔ The RSVP block distinguishes "could not load" from "none yet". They are different facts and
  // rendering a load failure as "no RSVPs" tells an operator nobody is coming when people are.
  const rsvpBlock =
    rsvps === null
      ? `<p class="muted">Could not load RSVPs just now — this is not the same as having none. Reload in a moment.</p>`
      : rsvps.length === 0
        ? `<p class="muted">No RSVPs yet.</p>`
        : `<p><strong>${rsvps.length}</strong> RSVP${rsvps.length === 1 ? "" : "s"}, <strong>${guests}</strong> guest${guests === 1 ? "" : "s"} expected.</p>` +
          rsvps
            .map(
              (r) =>
                `<div class="card"><strong>${escp(r.name)}</strong> &middot; ${escp(String(r.party_size))} ` +
                `<span class="muted">${escp(r.email)} &middot; ${escp(String(r.created_at).slice(0, 10))}</span></div>`,
            )
            .join("");

  const saved = url.searchParams.get("saved") ? `<p class="muted" style="color:#166534">Saved.</p>` : "";
  return popupHtml(
    ev.title,
    `<h1>${escp(ev.title)}</h1><p class="muted"><a href="/dashboard">Back to your pop-ups</a></p>` +
      saved +
      publishBlock +
      `<h2 style="font-size:1.1rem;margin-top:1.6rem">Details</h2>` +
      `<p class="muted">Times are UTC.</p>` +
      popupEventForm(`/dashboard/events/${escp(id)}`, ev, "Save changes", url.searchParams.get("err")) +
      `<h2 style="font-size:1.1rem;margin-top:1.6rem">Who is coming</h2>` +
      rsvpBlock +
      `<form method="post" action="/dashboard/events/${escp(id)}/delete" style="margin-top:2rem">` +
      `<button type="submit" style="background:#7f1d1d">Delete this pop-up</button>` +
      `<span class="muted"> This cannot be undone and removes its RSVPs.</span></form>`,
  );
}

// ── c93cd200 item 5 (Silver, Day 227): the public event page ─────────────────────────────────
//
// PUBLIC. No session, no sign-in, and it must stay that way: this is the page an operator shares
// and a visitor RSVPs on. It is dispatched BEFORE the operator and auth handlers so nothing can
// bounce a visitor to /login.
//
// ⛔ THE PUBLISHED FILTER IS IN THE QUERY, not in RLS. Service role, RLS off. A draft and a
// non-existent id both 404 -- deliberately the same answer, because a 403 on a draft would
// confirm to a stranger that an unpublished event with that id exists.
//
// The RSVP form posts to /e/<id>/rsvp rather than the JSON API, so it works with no client JS
// and lands the visitor back on the page with a result. The JSON route stays for Sterling's
// renders and anything scripted.

function popupFmtWhen(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt) return "";
  // Rendered from the ISO string rather than via toLocaleString: a Worker has no reliable
  // locale/timezone, and a date that silently shifts by an hour on the server is worse than a
  // plain one. Stated on the page as UTC so nobody has to guess which it is.
  const d = startsAt.slice(0, 10);
  const t = startsAt.slice(11, 16);
  const te = endsAt ? endsAt.slice(11, 16) : "";
  return te ? `${d}, ${t}–${te} UTC` : `${d}, ${t} UTC`;
}

async function handlePopupPublicEvent(req: Request, env: Env, path: string, url: URL): Promise<Response | null> {
  const m = path.match(/^\/e\/([0-9a-f-]{36})(\/rsvp)?$/i);
  if (!m) return null;
  const id = m[1];
  const isRsvpPost = m[2] === "/rsvp";

  // ---- the soft RSVP -------------------------------------------------------------------------
  if (isRsvpPost) {
    if (req.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    const form = await req.formData();
    const name = String(form.get("name") || "").trim();
    const email = String(form.get("email") || "").trim();
    const partyRaw = String(form.get("party_size") || "1").trim();
    const party = Number(partyRaw || 1);
    const back = (r: string) => Response.redirect(`${url.origin}/e/${id}?rsvp=${r}`, 302);
    if (!name) return back("name");
    if (!email.includes("@")) return back("email");
    if (!Number.isFinite(party) || party < 1) return back("party");
    // The event must exist AND be published. This check is the only thing standing between a
    // stranger and an RSVP on somebody's unpublished draft -- RLS cannot do it on this path.
    const ev = await fetch(
      `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&status=eq.published&select=id`,
      { headers: SR(env) },
    );
    if (!ev.ok) return back("error");
    if (!((await ev.json()) as unknown[]).length) return back("gone");
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/popup_rsvps`, {
      method: "POST",
      headers: { ...SR(env), Prefer: "return=minimal" },
      body: JSON.stringify({ event_id: id, name, email, party_size: Math.floor(party) }),
    });
    if (!r.ok) {
      await r.text(); // consume and DISCARD -- never render an upstream body
      return back("error");
    }
    return back("ok");
  }

  if (req.method !== "GET") return new Response("Method not allowed.", { status: 405 });

  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/popup_events?id=eq.${id}&status=eq.published&select=${EVENT_SELECT}`,
    { headers: SR(env) },
  );
  if (!r.ok) {
    return popupHtml("Pop-up", `<h1>Could not load this pop-up</h1><p>Try again in a moment. <a href="/">Back to the site</a></p>`, 502);
  }
  const rows = (await r.json()) as Array<{
    id: string; title: string; food_or_format: string | null; city: string | null;
    venue_or_area: string | null; starts_at: string | null; ends_at: string | null;
    capacity: number | null; cover_image_url: string | null; status: string;
  }>;
  if (!rows.length) {
    return popupHtml(
      "Not found",
      `<h1>This pop-up is not available</h1><p>It may have been unpublished or removed. ` +
      `<a href="/">See what else is on</a></p>`,
      404,
    );
  }
  const e = rows[0];

  const status = url.searchParams.get("rsvp");
  const banner =
    status === "ok"
      ? `<div class="card" style="border-color:#166534"><strong>You are on the list.</strong> <span class="muted">No payment, nothing to print — just turn up. The operator can see your name.</span></div>`
      : status === "gone"
        ? `<div class="card" style="border-color:#b91c1c"><strong>That pop-up is no longer published</strong>, so the RSVP was not saved.</div>`
        : status === "error"
          ? `<div class="card" style="border-color:#b91c1c"><strong>Could not save that RSVP.</strong> Try again in a moment.</div>`
          : status
            ? `<div class="card" style="border-color:#b91c1c"><strong>Check the form:</strong> ${escp(
                status === "name" ? "we need a name." : status === "email" ? "that email does not look right." : "party size must be 1 or more.",
              )}</div>`
            : "";

  const cover = e.cover_image_url
    ? `<p><img src="${escp(e.cover_image_url)}" alt="" style="width:100%;border-radius:.6rem"></p>`
    : "";

  const facts = [
    ["What", e.food_or_format],
    ["Where", [e.venue_or_area, e.city].filter(Boolean).join(", ")],
    ["When", popupFmtWhen(e.starts_at, e.ends_at)],
    ["Capacity", e.capacity != null ? String(e.capacity) : ""],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="card"><span class="muted">${escp(String(k))}</span><br><strong>${escp(String(v))}</strong></div>`)
    .join("");

  // The share link is the canonical absolute URL of this page. Rendered as text as well as a
  // link so it can be copied on a phone without a long-press, and with no client JS -- a
  // copy-to-clipboard button would be the only script on the site and nothing here checks
  // client JS.
  const shareUrl = `${url.origin}/e/${e.id}`;

  return popupHtml(
    e.title,
    `<p class="muted"><a href="/">&larr; All pop-ups</a></p>` +
      `<h1>${escp(e.title)}</h1>` +
      cover +
      banner +
      facts +
      `<h2 style="font-size:1.1rem;margin-top:1.6rem">Coming along?</h2>` +
      `<p class="muted">A soft RSVP — it tells the operator to expect you. No payment, and nothing is charged here.</p>` +
      `<form method="post" action="/e/${escp(e.id)}/rsvp">` +
      `<label for="name">Your name</label><input id="name" name="name" required autocomplete="name">` +
      `<label for="email" style="margin-top:.8rem">Email</label><input id="email" name="email" type="email" required autocomplete="email">` +
      `<label for="party_size" style="margin-top:.8rem">How many of you?</label><input id="party_size" name="party_size" type="number" min="1" value="1">` +
      `<button type="submit">Count me in</button>` +
      `</form>` +
      `<h2 style="font-size:1.1rem;margin-top:1.6rem">Share it</h2>` +
      `<p><a href="${escp(shareUrl)}">${escp(shareUrl)}</a></p>`,
  );
}

export async function handlePopupRequest(req: Request, env: Env, path: string): Promise<Response> {
  const url = new URL(req.url);
  if (path === "/popup/waitlist" && req.method === "POST") {
    return handleWaitlistPost(req, env);
  }
  // c93cd200 item 3 (Silver): the events/RSVP/admin API.
  if (path.startsWith("/api/popup/")) {
    return handlePopupApi(req, env, path);
  }
  // c93cd200 item 9 (Silver): operator sign-up, login, callback, logout and the signed-in
  // landing page. Returns null for any path it does not own, so the routes below are untouched
  // -- a handler that swallowed unknown paths would shadow "/" or the retired /t/N check.
  // c93cd200 item 4 (Silver): the operator back end. BEFORE handlePopupAuth, which owns the
  // bare /dashboard -- this one owns /dashboard/... and returns null for anything else.
  // c93cd200 item 5 (Silver): the PUBLIC event page and its soft RSVP post. Before the operator
  // and auth handlers, and it owns /e/... only -- returns null for everything else.
  const evRes = await handlePopupPublicEvent(req, env, path, url);
  if (evRes) return evRes;
  const opRes = await handlePopupOperator(req, env, path, url);
  if (opRes) return opRes;
  const authRes = await handlePopupAuth(req, env, path, url);
  if (authRes) return authRes;
  // c93cd200 items 2/8 (Cloud's ruling, ebe0f1e1, Darren's pick): template 3 won the review.
  // /t/1, /t/2, /t/3 are RETIRED -- "/" is the one canonical URL, carrying the item-8 shell.
  if (/^\/t\/[0-9]+$/.test(path)) {
    return new Response("This page has moved. See the site at /.", { status: 404 });
  }
  const waitlistStatus = url.searchParams.get("waitlist");
  if (path === "/" || path === "") {
    const [events, shell, home] = await Promise.all([getPublishedEventsPreview(env), getPopupShell(env), getPopupHomeContent(env)]);
    return new Response(renderTemplate3(events, waitlistStatus, shell, home), { headers: { "content-type": "text/html;charset=utf-8" } });
  }
  return new Response("Not found.", { status: 404 });
}
