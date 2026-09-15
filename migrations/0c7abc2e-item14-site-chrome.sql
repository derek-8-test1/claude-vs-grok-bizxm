-- 0c7abc2e item 14 -- ONE SOURCE FOR SITE STRUCTURE. W1, Day 227.
-- Darren, bench 12:3xZ, locked: the product's pages AND user sites render from one shared
-- header, one footer and one menu, with menu and footer items stored as DATA, not hand-written
-- static pages. This is the first slice, scoped to W1 by Cloud (fbc4316f): move the nav and
-- footer to data, change one nav row and screenshot two pages to prove it renders live with no
-- redeploy.
--
-- WORKSPACE-AGNOSTIC ON PURPOSE. This is the product's OWN chrome, shared across every visitor
-- signed in or not -- same shape as public.steps above (RLS enabled, `select using (true)` for
-- anon/authenticated, no insert/update/delete policy so only the service role writes). Section
-- data for individual pages (the ordered-sections half of item 14) is a separate, larger piece
-- and is NOT this migration -- see f73d589b/2df0e973 for where that lands.

create table if not exists public.nav_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  href text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.nav_items enable row level security;
drop policy if exists nav_items_readable_by_all on public.nav_items;
create policy nav_items_readable_by_all on public.nav_items for select using (true);

create table if not exists public.footer_items (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  href text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.footer_items enable row level security;
drop policy if exists footer_items_readable_by_all on public.footer_items;
create policy footer_items_readable_by_all on public.footer_items for select using (true);

-- SEED: exactly what was hardcoded in src/homepage.ts and src/index.ts's siteHeader() before
-- this migration, so the first load after the deploy is byte-identical to the old hardcoded
-- render -- the swap itself must change nothing visible; only a later row EDIT should.
insert into public.nav_items (label, href, sort_order)
select v.label, v.href, v.sort_order
from (values ('BizXM', '/', 0)) as v(label, href, sort_order)
where not exists (select 1 from public.nav_items);

insert into public.footer_items (label, href, sort_order)
select v.label, v.href, v.sort_order
from (values
  ('meridianxm.com', 'https://meridianxm.com', 0),
  ('duoxm.com', 'https://duoxm.com', 1),
  ('bizxm.com', 'https://bizxm.com', 2),
  ('statefulxm.com', 'https://statefulxm.com', 3),
  ('youtube.com/@meridianxm', 'https://youtube.com/@meridianxm', 4),
  ('x.com/MeridianXM', 'https://x.com/MeridianXM', 5),
  ('instagram.com/meridianxm', 'https://instagram.com/meridianxm', 6)
) as v(label, href, sort_order)
where not exists (select 1 from public.footer_items);
