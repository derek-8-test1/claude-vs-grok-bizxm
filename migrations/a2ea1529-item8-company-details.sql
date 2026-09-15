-- a2ea1529 item 8 -- COMPANY DETAILS. W1, Day 227.
-- Darren bench 11:2xZ: after picking a style, the user enters company name and details
-- (trading name, contact, address, country, currency, tax registration if any); saving them is
-- what creates the accounting profile in child 4 (9c0ee591).
--
-- business_type LIVES HERE, not on validator_runs -- 36de4e90 item 9 asked for it to be "stored
-- on the workspace" and nothing had done that yet (checked: no such column existed before this
-- migration). The validator's own detect-then-confirm flow is not built (no ANTHROPIC_API_KEY),
-- so this is a manual select for now, same "manual editing is the must-have" pattern as f73d589b
-- -- a future detect step fills the same column, it does not need a different one.

alter table public.workspaces add column if not exists trading_name text;
alter table public.workspaces add column if not exists contact_email text;
alter table public.workspaces add column if not exists address text;
alter table public.workspaces add column if not exists country text;
-- ISO 4217, uppercase, 3 letters -- a real currency code, not a free-text guess a renderer would
-- have to sanitise every time it formats money.
alter table public.workspaces add column if not exists currency text;
alter table public.workspaces add column if not exists tax_registration text;
alter table public.workspaces add column if not exists business_type text;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspaces_business_type_check'
  ) then
    alter table public.workspaces add constraint workspaces_business_type_check
      check (business_type is null or business_type in ('product', 'digital', 'service', 'mix'));
  end if;
end $$;
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspaces_currency_check'
  ) then
    alter table public.workspaces add constraint workspaces_currency_check
      check (currency is null or currency ~ '^[A-Z]{3}$');
  end if;
end $$;

-- DEFAULT CHART OF ACCOUNTS -- the "creates the accounting profile" link to 9c0ee591 (Silver's
-- ledger_accounts, kind in income|expense|asset|liability|equity). Idempotent: only seeds when
-- the workspace has ZERO ledger_accounts rows, so re-saving company details never duplicates a
-- chart the user (or Silver's accounting piece) has already started customising.
create or replace function public.seed_default_chart_of_accounts(p_workspace uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (select 1 from public.ledger_accounts where workspace_id = p_workspace) then
    return;
  end if;
  insert into public.ledger_accounts (workspace_id, code, name, kind) values
    (p_workspace, '4000', 'Sales income', 'income'),
    (p_workspace, '5000', 'Cost of goods sold', 'expense'),
    (p_workspace, '6000', 'Operating expenses', 'expense'),
    (p_workspace, '1000', 'Bank and cash', 'asset'),
    (p_workspace, '3000', 'Owner''s equity', 'equity');
end;
$$;
revoke all on function public.seed_default_chart_of_accounts(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_chart_of_accounts(uuid) to service_role;
