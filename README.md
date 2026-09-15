# BizXM / popup.bizxm.com — a live-build snapshot

This is a **point-in-time snapshot** of a Cloudflare Worker application built by a fleet of
Claude Code instances during the *Claude vs Grok Bot* challenge, captured on the evening of
**2026-09-15**.

There is **no development history here on purpose** — no branches, no reflog, no working
repository. Each commit is a whole snapshot of the code as it stood at that moment, published so
the build can be read rather than taken on trust. The second commit adds the admin back end and
the sign-in fix that landed in the last half hour of the session; the first is kept so the
difference is visible.

**[PROMPTS.md](PROMPTS.md) is the other half of the story** — every prompt the human gave,
verbatim and timestamped, with the totals. The code in this repo is what came out of those
prompts.

## What is in it

A single Cloudflare Worker serving two products from one codebase, routed by hostname:

- **demo.bizxm.com** — a "business in a box" flow: a start screen, an idea validator, generated
  business and marketing plans, market research, legal-and-licences pages, a simple site builder
  with click-to-edit page sections, and an accounting schema.
- **popup.bizxm.com** — a pop-up food events platform, built from scratch in about ninety
  minutes on the evening of the snapshot: a landing page whose copy is database-driven, a public
  event page with a soft RSVP and share link, an operator back end (create, edit, publish,
  unpublish your own events, see who is coming), email magic-link sign-in, an operator waitlist,
  and an **admin back end** behind Google sign-in restricted to a single account.

```
src/index.ts                demo.bizxm.com routes, auth, sites, plans, validator
src/popup.ts                popup.bizxm.com — everything for that host
src/google-auth.ts          the Google sign-in exchange, shared by both hosts
src/blockedit.ts            click-to-edit page sections
src/validator-view.ts       the validator report page
src/readaloud.ts            read-aloud bar injection
src/homepage.ts             marketing home
src/strip-served-comments.ts  strips /* */ comments out of served CSS/JS at module load
schema.sql                  the whole Postgres schema, RLS included
migrations/                 the reasoning trail, one file per change (see below)
```

## Reading it

The comments are the interesting part. They are written for the next machine that has to change
the code, so they tend to record **why** a thing is the shape it is, what was measured, what was
*not* measured, and which decisions are still open. Several of them argue with themselves, and a
few correct an earlier comment by name.

Four things worth knowing while reading:

- **Everything on the Worker runs with the Supabase service role, where row-level security does
  not apply.** RLS protects the anonymous client path only. Every ownership check, every
  published-only filter and every default-deny on those routes is therefore re-asserted in the
  Worker by hand. `handlePopupApi` in `src/popup.ts` says so at the top, because forgetting one
  does not fail loudly — it returns somebody else's data with a 200.
- **Sign-in is invite-only**, enforced by a database trigger (`handle_new_user` in `schema.sql`),
  not by the application. The allowlisted addresses are placeholders here.
- **The admin surface is gated on one allowlisted Google account**, checked in the Worker on
  every admin route and every admin API call — not once at sign-in. A signed-in NON-admin gets a
  403, which is the case that was actually driven before this was published; a signed-out visitor
  gets a sign-in page carrying no data.
- Pages are server-rendered. There is almost no client-side JavaScript, deliberately.

## What has been removed

This snapshot is not the working repository. Removed before publishing: operational tooling,
local state, logs, internal documentation, test and verification harnesses, and every credential
file. Redacted: real email addresses, the Supabase project identifier, an infrastructure zone id
quoted in a comment, and an account row id.

No API keys, tokens or private keys were present in the published tree. That was checked with a
pattern scan whose own detection was verified first by planting a fake secret of each shape and
requiring the scan to find it — a scanner that cannot find a planted secret proves nothing when
it finds none. That control caught a real blind spot on its first run, which is the only reason
this sentence is worth anything.

## Configuration

**Stack:** Cloudflare Workers + TypeScript, Supabase Postgres with row-level security, Google
OAuth and email magic-link sign-in. No framework, no build step beyond `tsc`, no client-side
JavaScript to speak of.

- **[.dev.vars.example](.dev.vars.example)** lists every secret the Worker reads, names only.
  Copy it to `.dev.vars` for `wrangler dev`, or set each one with `wrangler secret put <NAME>`.
- **[wrangler.toml](wrangler.toml)** carries the non-secret `[vars]` — the two email allowlists,
  published here as placeholders — plus the routes for both hostnames.
- **`schema.sql` is the source of truth for the database.** Apply that to a fresh Supabase
  project; it is the whole schema including every RLS policy.
- **`migrations/` is the reasoning trail, not a migration runner.** The filenames are prefixed
  with the internal work-item id that prompted each change, so they do NOT sort chronologically
  and were never meant to be replayed in filename order. Read them for WHY a column or a policy
  is the shape it is; build from `schema.sql`.

## Status

A snapshot, not a maintained repository. There is no issue tracker, no CI and no release process
here, and it is not intended to be run by anyone else: it needs Cloudflare Worker secrets and a
Supabase project that are not in this tree. Read it, don't deploy it.
