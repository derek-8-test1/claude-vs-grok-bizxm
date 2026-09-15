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
