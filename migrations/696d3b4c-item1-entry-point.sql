-- 696d3b4c item 1 (W1, Day 227): the three-ways-in start screen.
-- Deliberately separate from workspaces.country/business_type's existing use (the free-text
-- company/invoicing address on /dashboard/company) -- location_country/location_region are the
-- onboarding answer used to route and to seed items 2/4's market research, a different question
-- with a different format (ISO code here, same list as validator_runs.country), not a rename.
-- business_type IS reused as-is (product/digital/service/mix, already on this table) -- one
-- vocabulary for "what kind of business", not two.

alter table public.workspaces
  add column if not exists entry_point text
    check (entry_point is null or entry_point in ('idea','no_website','has_website')),
  add column if not exists location_country text,   -- ISO 3166 alpha-2, optional
  add column if not exists location_region text,    -- free text (city/state), optional
  add column if not exists ai_tools_used text[]
    check (ai_tools_used is null or ai_tools_used <@ array['none','chatgpt','claude','grok','grok_bot','other']::text[]);
-- entry_point is the routing signal read by GET /dashboard (redirect to /start while null) and
-- by items 5/6/7 once they land. NULL means "not answered yet", not "idea" -- do not default it.
