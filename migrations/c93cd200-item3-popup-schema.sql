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

create table public.popup_events (
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
create index popup_events_status_starts_idx on public.popup_events (status, starts_at)
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
create table public.popup_rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.popup_events(id) on delete cascade,
  name text not null,
  email text not null,
  party_size int not null default 1 check (party_size >= 1),
  created_at timestamptz not null default now()
);
create index popup_rsvps_event_idx on public.popup_rsvps (event_id);
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
create table public.popup_waitlist (
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
