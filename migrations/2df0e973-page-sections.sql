-- 2df0e973 -- GENERIC ORDERED PAGE SECTIONS. W1, Day 227.
-- Cloud's ruling (bead0b30, option b): build a generic ordered page_sections model on
-- bizbox-challenge (page, position, type, content jsonb, with version history), point the
-- editor at bizbox-challenge first (item 14 chrome plus sections), and move the f73d589b plan
-- pages onto sections instead of bespoke columns. Lab /p pages come after the stream, not now.
-- Warrant: Darren bench 12:37Z, no multiple static pages, WordPress-style editing.
--
-- SCOPE OF THE MOVE, STATED HERE SO THE NEXT READER DOES NOT ASSUME MORE THAN WAS DONE: only
-- business_plans.plan_sections (the heading+body card list) moves onto this table. elevator_pitch
-- and break_even stay typed columns on business_plans -- they are not prose blocks a WordPress-
-- style editor clicks into, they carry real computed structure (break_even's server-computed
-- months_to_break_even) that a generic {type,content} row would either have to special-case right
-- back into typed code, or lose. "Sections" in the WordPress sense is the ordered heading+body
-- list; that is what moves.
--
-- WORKSPACE_ID NULL = a product-owned page (home, dashboard, any future marketing/product page
-- this product renders for itself), readable by anon/authenticated, written by service role only
-- -- same shape as public.steps and the item-14 chrome tables. WORKSPACE_ID NOT NULL = a user's
-- own page (their business plan today; their site pages once the Site Builder lands), owner-
-- scoped RLS same as every other per-workspace table in this schema.

create table if not exists public.page_sections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  page text not null,
  position int not null default 0,
  type text not null,
  content jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists page_sections_page_idx on public.page_sections (workspace_id, page, position);
alter table public.page_sections enable row level security;
drop policy if exists page_sections_product_readable on public.page_sections;
create policy page_sections_product_readable on public.page_sections
  for select using (workspace_id is null);
drop policy if exists page_sections_owner_all on public.page_sections;
create policy page_sections_owner_all on public.page_sections
  for all using (workspace_id in (select id from public.workspaces where owner_user_id = auth.uid()));

-- VERSION HISTORY, one snapshot per save -- same append-only, service-role-write-only shape as
-- plan_versions: "a version history a user could rewrite is not a history". content is the FULL
-- ordered array for that (workspace_id, page) at save time, not a per-row diff -- 2df0e973's own
-- round-trip arm ("open, save with no change, stored body byte-identical") is a claim about the
-- WHOLE page, so the version snapshot has to be the whole page too.
create table if not exists public.page_section_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  page text not null,
  content jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.page_section_versions enable row level security;
drop policy if exists page_section_versions_readable on public.page_section_versions;
create policy page_section_versions_readable on public.page_section_versions
  for select using (
    workspace_id is null
    or workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );
