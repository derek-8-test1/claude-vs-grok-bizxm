-- 696d3b4c item 3 follow-up (Cloud's ruling, Day 227 17:1xZ): ONE country column, not two.
-- location_country (this session's /start addition) duplicated workspaces.country
-- (a2ea1529 item 8, company details) -- "the plan worker must never have to choose between two
-- countries". /start now reads and writes the SAME `country` column as /dashboard/company; both
-- screens use the same ISO 3166 alpha-2 select (COUNTRIES) so the format is unambiguous going
-- forward. location_country is dropped -- added and retired within this same session, no
-- production data depends on it (verified: NULL on every row before this migration runs).
-- location_region is UNCHANGED: workspaces had no separate region column before /start added
-- one, so there is nothing to unify there.
alter table public.workspaces drop column if exists location_country;

-- 696d3b4c item 3 (Cloud's ruling): existing-business plans get a "Money today" card, not a
-- cost-to-launch estimate -- current monthly revenue, monthly costs and a target, all editable,
-- labelled as the owner's OWN figures rather than sourced or forecast. Dedicated columns, not a
-- reused cost_estimate/break_even shape: those two are cost-TO-START and forecast-TO-BREAK-EVEN,
-- a different question from a running business's current numbers.
alter table public.business_plans
  add column if not exists current_monthly_revenue numeric,
  add column if not exists current_monthly_costs numeric,
  add column if not exists revenue_target numeric;
