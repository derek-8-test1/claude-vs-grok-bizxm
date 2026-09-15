-- bizbox-challenge, Piece 0 (Foundation). Workspace-per-user schema draft.
-- ⛔ NOT APPLIED ANYWHERE. Ready to run the moment the Supabase project is created (see README's
-- BLOCKER note). Modelled on this fleet's existing per-tenant RLS pattern (ProjectXM: RLS
-- default-deny per tenant, decision 0530f4d4), scaled down to one user = one workspace rather
-- than one org = one tenant, since this product's "workspace" is the individual solo operator.

create extension if not exists "pgcrypto";

-- ⛔ ‼ THE DEFAULT-PRIVILEGES GUARD, FIRST, BEFORE ANY FUNCTION BELOW -- ORDER MATTERS: this only
--    changes privileges on objects created AFTER it runs. Day 227 security sweep (Silver, brief
--    6732012d), Cloud's recalled-then-verified fix (quoted against docs.postgresql.org/current/
--    sql-alterdefaultprivileges.html): "you cannot revoke privileges per-schema if they are
--    granted globally... Per-schema REVOKE is only useful to reverse the effects of a previous
--    per-schema GRANT." PUBLIC's EXECUTE-on-functions is the GLOBAL built-in default, so a
--    schema-scoped revoke alone (line below it) can never remove it -- BOTH statements are
--    required, driven separately: the global one alone leaves Supabase's own anon/authenticated
--    per-schema grant standing; the schema one alone leaves PUBLIC's global grant standing, and
--    every role including anon/authenticated is a member of PUBLIC. Proved with a scratch
--    function carrying zero explicit grants, driven over the real PostgREST RPC endpoint as both
--    anon (401/42501) and service_role (200), not read off the ACL.
--    ⚠ THIS DOES NOT REPLACE THE PER-FUNCTION REVOKE. Every SECURITY DEFINER function not meant
--    to be public-callable still needs its own `revoke all on function X from public, anon,
--    authenticated;` -- this guard only stops the SILENT default; a function that explicitly
--    grants EXECUTE to anon (like capture_lead, correctly) still does exactly that.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'My Business',
  created_at timestamptz not null default now()
);
-- one workspace per user for v0 -- the plan's "Foundation" done-when is "a new user can sign up,
-- land on the dashboard" with no multi-workspace requirement. A unique constraint keeps that
-- true in the schema, not just in the app: relaxing it later is one DROP CONSTRAINT, tightening
-- it after multi-workspace data exists is a migration nobody wants.
alter table public.workspaces add constraint one_workspace_per_owner unique (owner_user_id);

-- Piece 6, Payments (brief 2fdd8d91). Plan lives ON the workspace row -- one workspace, one
-- plan, matches the "one workspace per user" v0 shape above. `stripe_customer_id` is set on
-- first checkout; `plan` and `plan_status` are written ONLY by the webhook handler (service
-- role), never by the client -- a user must not be able to grant themselves a paid plan by
-- calling the REST API directly. IF NOT EXISTS so this file stays safe to re-run against a
-- database that already has these columns.
alter table public.workspaces add column if not exists stripe_customer_id text;
alter table public.workspaces add column if not exists plan text not null default 'free';
alter table public.workspaces add column if not exists plan_status text not null default 'none';
-- Account area (W1, Day 227, Darren bench 12:2xZ): display_name is nullable and client-editable
-- (via the existing workspace_owner_update policy above -- no new policy needed), falling back
-- to the auth email everywhere it is shown. Applied live 2026-09-15; Darren's own row is set to
-- 'Darren' (row id redacted -- it is the principal's own account identifier and this file is
-- published in the public snapshot).
alter table public.workspaces add column if not exists display_name text;
-- 'none' | 'active' | 'past_due' | 'canceled' -- Stripe's own subscription.status vocabulary,
-- not reinvented, so the webhook handler can write it through with no translation table to
-- drift out of sync with Stripe's.

alter table public.workspaces enable row level security;
-- RLS DEFAULT-DENY: no policy below grants anything to `anon`. Every table a user's data lives
-- in is scoped through workspace_id and a policy checking auth.uid() = workspaces.owner_user_id.
create policy workspace_owner_select on public.workspaces
  for select using (owner_user_id = auth.uid());
create policy workspace_owner_update on public.workspaces
  for update using (owner_user_id = auth.uid());
-- INSERT is via a SECURITY DEFINER trigger on auth.users (below), never a direct client insert --
-- a user should never be able to create a second workspace for themselves by calling the API
-- directly, which a client-side INSERT policy would allow even with the unique constraint (the
-- constraint would just make the SECOND attempt fail loudly instead of never being offered).

-- 0c7abc2e (W1, Day 227): INVITE-ONLY for the challenge, enforced HERE too, not only in the
-- Worker -- defense-in-depth against any signup path that does not go through bizbox-challenge's
-- own /auth/login or /auth/google/callback (a direct REST call to /auth/v1/signup, a future
-- admin invite tool, a different Worker sharing this project). Raising inside an AFTER INSERT
-- trigger rolls back the WHOLE transaction, including the auth.users row that was just inserted
-- -- Postgres does not partially commit a statement whose trigger raised. KEPT IN SYNC BY HAND
-- with wrangler.toml's ALLOWED_EMAILS -- same two addresses, checked at two layers on purpose
-- (see the Env comment on ALLOWED_EMAILS in src/index.ts for why one check is not enough).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if lower(new.email) not in ('owner@example.com', 'qa@example.com') then
    raise exception 'invite_only: % is not on the allowlist', new.email;
  end if;
  insert into public.workspaces (owner_user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ⛔ ‼ SECURITY SWEEP, Day 227 (Silver, brief 6732012d): SUPABASE GRANTS EXECUTE ON EVERY NEW
--    FUNCTION TO anon/authenticated DIRECTLY AT CREATE TIME, AS SEPARATE ACL ENTRIES, PLUS THE
--    STANDARD POSTGRES DEFAULT GRANT TO PUBLIC -- NEITHER IS REMOVED BY REVOKING FROM THE OTHER.
--    A trigger function needs EXECUTE from nobody except its SECURITY DEFINER owner: Postgres
--    invokes a trigger function internally and does not check the firing role's EXECUTE grant on
--    it, so this revoke does not touch signup -- proven on an isolated throwaway schema (own
--    table, own trigger, anon insert still fired the effect row with zero EXECUTE grants
--    standing), not assumed from the mechanism's name.
--    ⇒ Without this, `handle_new_user()` was directly EXECUTE-able by anon and authenticated.
--    Not exploitable over PostgREST today (its return type is `trigger`, which PostgREST refuses
--    to expose as a callable RPC -- driven, 404) but revoked anyway: nothing should depend on a
--    REST-layer accident to stay safe, and the fix costs one statement.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- USAGE / COST METER -- "from day one", per the plan's Piece 0 step. One row per AI/lookup call,
-- so the sum is a query, not a running total that can drift from what actually happened.
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null,               -- 'claude_call' | 'research_lookup' | ... (open, not enumerated
                                     -- here on purpose -- coding-discipline: don't enumerate what
                                     -- the app will keep adding to in a schema comment)
  cost_usd_micros bigint not null,  -- integer micros ($1 = 1,000,000) -- never store money as float
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.usage_events enable row level security;
create policy usage_owner_select on public.usage_events
  for select using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );
-- INSERT is server-side only (service role), never a client policy -- a user must never be able
-- to write their own cost meter rows.

-- STORAGE: one bucket, path-scoped by workspace_id, not a bucket per workspace (buckets don't
-- scale to thousands of users the way a policy on object path does).
insert into storage.buckets (id, name, public) values ('uploads', 'uploads', false)
  on conflict (id) do nothing;
create policy uploads_owner_rw on storage.objects
  for all using (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = (
      select id::text from public.workspaces where owner_user_id = auth.uid()
    )
  );

-- Piece 1, Idea Validator (brief 36de4e90). One row per validator run -- a user may run this
-- more than once (a different idea, a revised pitch), so it is NOT folded onto workspaces the
-- way plan/billing is.
create table public.validator_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  idea_text text not null,
  linkedin_url text,
  competitor_urls text[] not null default '{}',
  -- storage.objects paths under uploads/<workspace_id>/validator/<run_id>/<filename>, NOT the
  -- file content -- this table is metadata, the bucket is the blob store.
  upload_paths text[] not null default '{}',
  status text not null default 'uploaded',
  -- 'uploaded' | 'extracting' | 'researching' | 'scoring' | 'queued_over_cap' | 'done' | 'failed'
  -- -- a STATE MACHINE, not a boolean, because "not done yet" and "failed" must never be the
  -- same value: a failed run that reads as merely-not-done-yet is a run nobody ever revisits.
  -- ⛔ 'researching' IS THE COMPLETION STATUS extract-worker.py WRITES (Day 227 fix, item 11) --
  -- extraction done, ready for judgement, not "extraction in progress". 'scoring' is
  -- judge-worker.py's claim marker while a judgement call is actually in flight.
  -- 'queued_over_cap' (Day 227, Cloud's scheduling ruling dadf4249): the daily judgement-call
  -- cap (judge-worker.py's DAILY_CAP) was reached -- a VISIBLE state, never a run silently left
  -- at 'researching' forever. Picked up automatically once the cap resets.
  extracted_text text,
  -- competitors / founder_assessment / costs are jsonb so the SOURCING RULE (every figure
  -- carries a source and a date, or explicitly "not found") lives in the DATA, not just in a
  -- rendering convention -- a report re-rendered a year from now still shows its own dates.
  competitors jsonb not null default '[]',
  founder_assessment jsonb,
  costs jsonb,
  score int,
  score_reasons text,
  -- item 11 (judge-worker.py) writes this alongside score_reasons -- prose reasons and a
  -- structured list serve different readers: one is read, the other is rendered as bullets.
  market_gaps jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.validator_runs enable row level security;
create policy validator_owner_all on public.validator_runs
  for all using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );
-- ⛔ UNLIKE workspaces/usage_events, this policy is FOR ALL (not split select/update), because a
-- run genuinely belongs to its owner end to end and there is no server-only-write field on this
-- table the way plan_status is server-only on workspaces -- status transitions are driven by a
-- background process using the service role regardless, so a client USING this policy can only
-- ever read/update fields it already has plausible reason to see.

-- Piece 7, One Engine Three Doors (brief 614ca396). THE STEP LIBRARY -- Cloud's ruling, Day 227
-- 11:1xZ: a step is DATA, not code, so all three doors (web app, prompt playbooks, MCP
-- connector) run the SAME definition instead of three copies drifting apart. This table is what
-- 36de4e90's validator reads its prompt from -- built BEFORE any LLM call is wired, on purpose,
-- so the shape is right from the start rather than hardcode-then-refactor.
create table public.steps (
  id text primary key,  -- 'validate', 'build_site', 'post', ... -- stable, referenced by callers
  -- typed_inputs / typed_outputs are JSON-SCHEMA-SHAPED (not our own invented format), so a
  -- generic validator can check a caller's payload against them without per-step code.
  typed_inputs jsonb not null,
  typed_outputs jsonb not null,
  instructions text not null,  -- the prompt the engine runs, one copy, all three doors read it
  -- the SOURCING RULE, structural, not prose buried in `instructions` -- Cloud's own gap-find
  -- for the validator (every competitor figure carries a source and a date, or "not found")
  -- generalises to every step this engine ever runs, so it lives as its own typed column.
  sources_rule text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- no RLS: this is our own product definition, not per-workspace user data -- every workspace
-- reads the same step library, none of them own or can write it. `anon`/`authenticated` get
-- SELECT via a policy; only the service role writes (the engine team edits steps, not users).
alter table public.steps enable row level security;
create policy steps_readable_by_all on public.steps for select using (true);

-- Piece 8, live business plan + marketing plan (brief f73d589b, W1, Day 227). One of each per
-- workspace (folded onto workspace_id as the primary key, same "one per workspace" shape as the
-- workspaces table itself), created lazily by the Worker on first visit rather than by a trigger
-- -- unlike workspaces, an empty plan is a legitimate starting state a user edits INTO existence,
-- not a side effect of signup.
create table public.business_plans (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  elevator_pitch text not null default '',
  -- plan_sections DROPPED (f73d589b item 6 fix, 761a4cb5): the heading+body card list moved
  -- onto public.page_sections (page='business-plan') under 2df0e973, W1, before this table's
  -- worker landed. Do not re-add it here -- read/write sections via getPageSections/
  -- savePageSections, never a column on this row.
  -- cost_estimate is CARRIED FROM THE VALIDATOR (item 1), so it uses the SAME sourced_figure
  -- shape ({value, source, as_of} or {not_found: true}) the validator's competitors already use
  -- -- one contract for "where did this number come from" across the whole product, not two.
  cost_estimate jsonb not null default '{}',
  -- break_even: {assumptions: [{label, value, editable: true}], monthly_revenue, monthly_costs,
  -- months_to_break_even} -- EVERY assumption the forecast depends on is a named, user-editable
  -- field here, never baked into a formula string the user cannot see or change (item 5: "every
  -- figure carries its source or is labelled an assumption the user can change").
  break_even jsonb not null default '{}',
  -- source_run_id / user_edited: f73d589b item 6 (plans worker, Silver, Day 227). Which
  -- validator_runs row the plan was generated from, and whether a human has edited the text
  -- since -- the worker's own guard against a background regenerate silently clobbering an
  -- edit, independent of whatever confirm dialog the button shows (see plan_jobs.overwrite_confirmed).
  source_run_id uuid references public.validator_runs(id) on delete set null,
  user_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.business_plans enable row level security;
create policy business_plan_owner_all on public.business_plans
  for all using (workspace_id in (select id from public.workspaces where owner_user_id = auth.uid()));

create table public.marketing_plans (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  -- posting_goals: {"x": {"per": "week", "count": 3}, ...} -- open on channel, per item 2's own
  -- wording ("posting goal per day or week per channel"), never enumerated to "x only" here.
  posting_goals jsonb not null default '{}',
  target_keywords text[] not null default '{}',
  -- seo_keywords feeds the Site Builder's page titles/descriptions/headings (a2ea1529) --
  -- {"title": [...], "description": [...], "headings": [...]}, read by that piece, written by
  -- this one, so the two never hold two independently-typed copies of the same keyword list.
  seo_keywords jsonb not null default '{}',
  -- bid_keywords: worth bidding on, "with no prices" (item 2's own wording -- this product does
  -- not estimate ad spend, only surfaces candidate terms).
  bid_keywords text[] not null default '{}',
  -- source_run_id / user_edited: same contract as business_plans, see there.
  source_run_id uuid references public.validator_runs(id) on delete set null,
  user_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.marketing_plans enable row level security;
create policy marketing_plan_owner_all on public.marketing_plans
  for all using (workspace_id in (select id from public.workspaces where owner_user_id = auth.uid()));

-- f73d589b item 6 (Silver, Day 227): "Generate my business and marketing plans" job queue.
-- One row per generation attempt (queued by the button on a done validator_run, regenerate
-- inserts a new row rather than mutating one), consumed by bin/plan-worker.py.
create table public.plan_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_run_id uuid not null references public.validator_runs(id) on delete cascade,
  status text not null default 'queued',
  -- 'queued' | 'generating' | 'done' | 'failed' | 'queued_over_cap' -- same state-machine shape
  -- as validator_runs.status: "not done yet" and "failed" must never collapse into one value.
  -- 'generating' rows older than 20 minutes are reclaimed as 'queued' by the worker's claim
  -- query (same staleness rule as judge-worker.py's known gap, built in here from day one).
  error text,
  -- set true by the button only after the user has explicitly accepted overwriting their own
  -- edited text; the worker refuses to write over a user_edited plan unless this is also true,
  -- and fails the job with that reason instead of silently discarding the edit.
  overwrite_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index plan_jobs_workspace_created_idx on public.plan_jobs (workspace_id, created_at desc);
alter table public.plan_jobs enable row level security;
create policy plan_job_owner_all on public.plan_jobs
  for all using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );

-- VERSION HISTORY (item 3), shared by both plan types rather than two near-identical tables --
-- an append-only snapshot log, written by the Worker (service role) on every save, NEVER by a
-- client policy: a version history a user could rewrite is not a history. `plan_type` is
-- 'business' | 'marketing', kept as text (not enumerated here) matching this schema's existing
-- convention for open-ended-by-design classifiers (see `usage_events.kind` above).
create table public.plan_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  plan_type text not null,
  content jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.plan_versions enable row level security;
create policy plan_versions_owner_select on public.plan_versions
  for select using (workspace_id in (select id from public.workspaces where owner_user_id = auth.uid()));

-- 0c7abc2e item 14 -- ONE SOURCE FOR SITE STRUCTURE (W1, Day 227). See
-- migrations/0c7abc2e-item14-site-chrome.sql for the full comment and the seed rows; this is
-- the schema kept in sync by hand, same convention as every other section above. Product-owned
-- chrome, workspace-agnostic, same RLS shape as public.steps: readable by anon/authenticated,
-- written only by the service role.
create table public.nav_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  href text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.nav_items enable row level security;
create policy nav_items_readable_by_all on public.nav_items for select using (true);

create table public.footer_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  href text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.footer_items enable row level security;
create policy footer_items_readable_by_all on public.footer_items for select using (true);
-- INSERT is server-side only (service role) -- no client policy, matching usage_events.

-- 696d3b4c item 1 (W1, Day 227): the three-ways-in start screen. See
-- migrations/696d3b4c-item1-entry-point.sql for the full comment.
-- ⛔ location_country was DROPPED by migrations/696d3b4c-item3-unify-country-and-money-card.sql
-- (Cloud's ruling, Day 227): it duplicated workspaces.country (a2ea1529 item 8) and "the plan
-- worker must never have to choose between two countries" -- /start now reads/writes `country`
-- directly, below, so this alter no longer names it. Reading this block alone on a fresh DB
-- never creates the column; the later migration's DROP would simply be a no-op.
alter table public.workspaces
  add column if not exists entry_point text
    check (entry_point is null or entry_point in ('idea','no_website','has_website')),
  add column if not exists location_region text,
  add column if not exists ai_tools_used text[]
    check (ai_tools_used is null or ai_tools_used <@ array['none','chatgpt','claude','grok','grok_bot','other']::text[]);

-- 696d3b4c item 6 (W1, Day 227): the has-a-website flow. See
-- migrations/696d3b4c-item6-website-platform.sql for the full comment.
alter table public.workspaces
  add column if not exists website_platform text
    check (website_platform is null or website_platform in
      ('wordpress','wix','squarespace','shopify','custom','dont_know')),
  add column if not exists website_url text;

-- 696d3b4c item 3 (W1, Day 227): existing-business plan jobs have no validator run. See
-- migrations/696d3b4c-item3-plan-jobs-start-screen.sql and
-- migrations/696d3b4c-item3-unify-country-and-money-card.sql for the full comments.
alter table public.plan_jobs
  add column if not exists source_kind text not null default 'validator_run'
    check (source_kind in ('validator_run','start_screen')),
  alter column source_run_id drop not null;
alter table public.plan_jobs
  add constraint plan_jobs_source_kind_run_id_check
    check (
      (source_kind = 'validator_run' and source_run_id is not null) or
      (source_kind = 'start_screen' and source_run_id is null)
    );
alter table public.business_plans
  add column if not exists current_monthly_revenue numeric,
  add column if not exists current_monthly_costs numeric,
  add column if not exists revenue_target numeric;


-- ── c93cd200 item 3 (Silver, Day 227): popup.bizxm.com data model ───────────────────────────
-- Applied live to this project as migrations/c93cd200-item3-popup-schema.sql; mirrored here
-- because schema.sql is what a FRESH deploy is built from. RLS below is driven, not assumed:
-- 8 anon negative-control arms (published visible / draft NOT visible / rsvps and waitlist
-- unreadable while real rows exist / anon insert, update and delete all refused), Day 227.
-- ⛔ The service role bypasses ALL of this. Worker routes re-assert ownership themselves; see
-- the header of handlePopupApi in src/popup.ts.

-- c93cd200 item 3 (Silver, Day 227): popup.bizxm.com data model, same Supabase project as
-- demo.bizxm.com (item 1's own instruction: same Worker and Supabase project, routed by host).
-- Namespaced popup_* deliberately -- this is a DIFFERENT product sharing this database, not a
-- generalisation of validator_runs/business_plans, and an unprefixed "events" table would
-- invite exactly the kind of name collision this fleet's own discipline warns about.
--
-- ROLES SIMPLIFICATION, stated so the next reader does not assume more than was built: the spec
-- says "workspace roles user and admin". This product ALREADY has an admin concept
-- (isDarren()/ADMIN_EMAILS, used identically for the item-14 chrome editor) -- reusing it here
-- rather than inventing a second, redundant admin mechanism. "User" role is simply "owns a
-- workspace", the same concept every other table in this schema already uses. No new roles
-- table; if a later requirement needs MULTIPLE admins per workspace (not just Darren
-- platform-wide), that is a real gap this migration does not close.

create table if not exists public.popup_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  food_or_format text,
  city text,
  venue_or_area text,
  starts_at timestamptz,
  ends_at timestamptz,
  capacity int,
  cover_image_url text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists popup_events_status_starts_idx on public.popup_events (status, starts_at)
  where status = 'published';
alter table public.popup_events enable row level security;
-- Owner: full access to their own events (create/edit/publish/unpublish, item 4).
create policy popup_events_owner_all on public.popup_events
  for all using (workspace_id in (select id from public.workspaces where owner_user_id = auth.uid()));
-- Public: read-only, PUBLISHED events only -- item 3's own wording ("public read of published
-- events only"), same shape as page_sections' workspace_id-is-null public-read policy but keyed
-- on status instead, since every popup event genuinely belongs to an operator's workspace.
create policy popup_events_public_read_published on public.popup_events
  for select using (status = 'published');

-- Soft RSVP: name, email, party size, NO PAYMENT. item 3's own wording: "anon insert only
-- through Worker routes with the existing function-grant guard" -- deliberately NO anon insert
-- RLS policy here at all. The Worker route inserts via the service role after its own
-- rate-limit/validation, same shape as capture_lead (a2ea1529 item 5); RLS on this table only
-- ever grants the event OWNER a read, never a client-side write path of any kind.
create table if not exists public.popup_rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.popup_events(id) on delete cascade,
  name text not null,
  email text not null,
  party_size int not null default 1 check (party_size >= 1),
  created_at timestamptz not null default now()
);
create index if not exists popup_rsvps_event_idx on public.popup_rsvps (event_id);
alter table public.popup_rsvps enable row level security;
create policy popup_rsvps_owner_read on public.popup_rsvps
  for select using (
    event_id in (
      select e.id from public.popup_events e
      where e.workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
    )
  );
-- No insert/update/delete policy for anon or authenticated -- service-role-only write, by the
-- Worker route, exactly as item 3 specifies.

-- Waitlist: operators, locations and makers expressing interest -- NOT workspace-owned (a
-- general interest list, not any one operator's data), so RLS is default-deny for every client
-- role; only the admin route (service role, gated by isDarren() in the Worker, same pattern as
-- the item-14 chrome editor) ever reads it, and inserts are anon-via-Worker-only, same shape as
-- popup_rsvps above.
create table if not exists public.popup_waitlist (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('operator', 'location', 'maker')),
  city text,
  contact text not null,
  note text,
  created_at timestamptz not null default now()
);
alter table public.popup_waitlist enable row level security;
-- Deliberately NO policy at all: default-deny for anon/authenticated, matching this fleet's own
-- RLS default-deny convention (workspaces' own comment: "no policy below grants anything to
-- anon"). Every access to this table goes through a Worker route on the service role.

-- c93cd200 items 8 and 6 (Silver, Day 227): the popup site shell's editable copy, and the
-- carousel feature flag.
--
-- OWNERSHIP, stated because Cloud asked for it explicitly before either of us wrote this: SILVER
-- writes this migration, W1 builds the shell that reads it. Said on fleet (447a29ab) before a
-- line of it existed, so we cannot both ship a popup_pages.
--
-- popup_pages: item 8's requirement is that the shell's copy is "read from a new popup_pages
-- table in the same Supabase project, not hard-coded". So this is a copy store, not a CMS: a
-- slug, a title, and a jsonb body the render layer decides the shape of. jsonb rather than a
-- column per slot deliberately -- the shell's slots are W1's to design and will change while
-- item 8 is built, and a text column per slot means a migration every time one moves.
--
-- RLS: public read of EVERY row (this is site copy, it is on a public page by definition), and
-- NO client write path at all -- same shape as popup_waitlist, for the same reason. Edits go
-- through a Worker route on the service role gated by isDarren(), which is where item 10's admin
-- sign-in lands. ⛔ A public-read policy on a table an admin edits is only safe while nothing
-- private is put in `body`; the column is site copy and must stay site copy.
create table if not exists public.popup_pages (
  slug text primary key,
  title text,
  body jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.popup_pages enable row level security;
-- Public read: anon and authenticated alike. Nothing here is workspace-scoped.
drop policy if exists popup_pages_public_read on public.popup_pages;
create policy popup_pages_public_read on public.popup_pages
  for select using (true);
-- No insert/update/delete policy for any client role. Service-role only, via the admin route.

-- Seed rows so the shell has something to render on its first load rather than an empty header.
-- ⛔ `on conflict do nothing`: if W1 has already put real copy in these slugs, this must not
-- overwrite it. A seed that clobbers is not a seed.
insert into public.popup_pages (slug, title, body) values
  ('shell', 'Pop-Up', '{"nav":[{"label":"Home","href":"/"},{"label":"How it works","href":"/#how"},{"label":"Register your pop-up","href":"/#waitlist"}],"login_label":"Login","footer":"Pop-Up -- a home for street-food pop-ups, chef takeovers and maker markets."}'::jsonb)
on conflict (slug) do nothing;

-- c93cd200 item 6 (W1's to USE, Silver's to provide): "admin can feature an event in the
-- carousel and hide one". Two independent booleans rather than one status enum, because they are
-- genuinely independent -- a hidden event is not an unfeatured one, and `status` already carries
-- draft/published and must not be overloaded with a third meaning.
-- ⚠ NOTHING READS THESE YET. The carousel query still filters on status='published' alone; item
-- 6 is what wires them, and until it does, `featured` and `hidden` are inert columns. That is a
-- deliberate sequencing choice (the tolerant half first), not an oversight -- but it means a
-- reader must not take the presence of these columns as evidence the feature works.
alter table public.popup_events
  add column if not exists featured boolean not null default false,
  add column if not exists hidden boolean not null default false;
create index if not exists popup_events_featured_idx on public.popup_events (featured, starts_at)
  where featured and status = 'published';
