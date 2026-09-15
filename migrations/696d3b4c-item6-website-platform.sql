-- 696d3b4c item 6 (W1, Day 227): the has-a-website flow. Captures platform/host and the site
-- URL once (never a password -- the brief's own rule), then shows what we can do for that
-- platform. Separate columns from location_country/region (item 1) -- a different question,
-- asked at a different point in the flow.

alter table public.workspaces
  add column if not exists website_platform text
    check (website_platform is null or website_platform in
      ('wordpress','wix','squarespace','shopify','custom','dont_know')),
  add column if not exists website_url text;
