-- 9c0ee591 -- ACCOUNTING, DB HALF. Silver, Day 227. No src/ needed (Cloud's routing).
-- Scope, per Cloud's explicit order: the ledger schema mapped to the Xero/QuickBooks models,
-- RLS, and the CSV export function. Items 2/3/6/8/9 (receipt-photo AI reading, drag-and-drop
-- linking, Gmail/MCP stretch, the first end-to-end test, business-type flavour) are NOT this
-- file -- they need either src/ (uploads UI) or the LLM key, and are named in the brief, not here.
--
-- SOURCING, stated per item 7's own requirement, and stated honestly about its limits:
-- Xero's OWN developer docs (developer.xero.com) render as an empty shell to a non-JS fetcher --
-- driven twice, confirmed empty both times. PRIMARY source actually used for Xero's field
-- vocabulary: Xero's own OpenAPI spec, raw.githubusercontent.com/XeroAPI/Xero-OpenAPI (fetched
-- today, genuine field names present in the file: Type/ACCREC/ACCPAY, Contact, LineItems, Date,
-- DueDate, InvoiceNumber, Reference, CurrencyCode, Status, LineAmountTypes on Invoice;
-- Description, Quantity, UnitAmount, ItemCode, AccountCode, TaxType, TaxAmount, LineAmount,
-- DiscountRate, Tracking on LineItem -- truncated by fetch size, so this is a PARTIAL primary
-- read, not the whole schema).
-- QuickBooks' own developer docs (developer.intuit.com) also render empty to a non-JS fetcher,
-- and a community OpenAPI mirror 404'd. NOT FETCHED FROM THE VENDOR TODAY. The CSV column names
-- below (Invoice No., Customer, Invoice Date, Due Date, Terms, Item, Item Description,
-- Item Quantity, Item Rate, Item Amount, Item Tax Code) come from THIRD-PARTY aggregator sites
-- (entryrocket.com, xtractor.app and others), cross-checked across multiple independent sources
-- that agree with each other -- RELAYED, not primary, and named as such rather than passed off
-- as Intuit's own words. Whoever wires an actual QuickBooks import should re-verify against a
-- real QBO account before shipping the export to a customer.

-- CHART OF ACCOUNTS -- deliberately minimal and TEXT-coded, not a fixed enum: both Xero
-- (AccountCode) and QuickBooks (account names/refs) let the org define their own codes, so a
-- fixed list here would be wrong for most businesses. Seeded with a small honest starter set,
-- editable by the owner -- accounting-flavour-by-business-type (item 9) extends this, not this
-- file.
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  code text not null,             -- short code, e.g. '200' -- Xero's AccountCode is exactly this
  name text not null,             -- e.g. 'Sales', 'Office Supplies'
  kind text not null,             -- 'income' | 'expense' | 'asset' | 'liability' | 'equity' --
                                   -- the PORTABLE part: both Xero and QBO classify every account
                                   -- into one of these five types under the hood, however they
                                   -- label it in their own UI
  created_at timestamptz not null default now()
);
alter table public.ledger_accounts add constraint ledger_accounts_kind_check
  check (kind in ('income','expense','asset','liability','equity'));
alter table public.ledger_accounts add constraint ledger_accounts_workspace_code_uniq
  unique (workspace_id, code);
alter table public.ledger_accounts enable row level security;
drop policy if exists ledger_accounts_owner_all on public.ledger_accounts;
create policy ledger_accounts_owner_all on public.ledger_accounts
  for all using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );

-- CONTACTS -- one table for both customers and suppliers, like Xero's own Contact model
-- (IsCustomer/IsSupplier flags on one entity) rather than QuickBooks' split Customer/Vendor --
-- picking Xero's shape here because it is the SUPERSET: a QuickBooks export can filter this
-- table into two lists, but a QuickBooks-shaped split table could not merge back into Xero's
-- single-contact model without losing information about which contacts are both.
create table public.ledger_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  email text,
  is_customer boolean not null default false,
  is_supplier boolean not null default false,
  address text,
  created_at timestamptz not null default now()
);
alter table public.ledger_contacts enable row level security;
drop policy if exists ledger_contacts_owner_all on public.ledger_contacts;
create policy ledger_contacts_owner_all on public.ledger_contacts
  for all using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );

-- LEDGER ENTRIES -- the invoice/bill HEADER. `kind` mirrors Xero's Type (ACCREC/ACCPAY) exactly,
-- because that is the one distinction every double-entry system makes and it is the field a
-- reader most needs to get right -- get this wrong and money owed TO the business and money
-- owed BY it swap.
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid references public.ledger_contacts(id) on delete set null,
  kind text not null,              -- 'invoice' (ACCREC, we are owed) | 'bill' (ACCPAY, we owe)
  doc_number text,                 -- InvoiceNumber / Invoice No. -- user-facing, not this row's id
  entry_date date not null,
  due_date date,
  reference text,
  currency text not null default 'USD',
  -- tax_amount is STORED, not derived from line items summed -- a receipt or a CSV row may state
  -- a tax figure that doesn't cleanly recompute from a rounded per-line rate, and item 1's own
  -- checklist wording is "tax amount AS ENTERED", not "as calculated".
  tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  receipt_path text,                -- storage.objects path under uploads/<workspace>/ledger/... ,
                                     -- same convention as validator_runs.upload_paths -- item 2's
                                     -- landing spot, not built here
  status text not null default 'draft',  -- 'draft' | 'confirmed' -- item 2's "AI reads it into a
                                          -- DRAFT line the user CONFIRMS" needs exactly two states,
                                          -- not more, until a real workflow proves more are needed
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ledger_entries add constraint ledger_entries_kind_check
  check (kind in ('invoice','bill'));
alter table public.ledger_entries add constraint ledger_entries_status_check
  check (status in ('draft','confirmed'));
alter table public.ledger_entries enable row level security;
drop policy if exists ledger_entries_owner_all on public.ledger_entries;
create policy ledger_entries_owner_all on public.ledger_entries
  for all using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );
create index if not exists ledger_entries_workspace_date_idx
  on public.ledger_entries (workspace_id, entry_date desc);

-- LINE ITEMS -- field names follow Xero's LineItem vocabulary directly (Description, Quantity,
-- UnitAmount, AccountCode via account_id, TaxType, LineAmount), since that is the primary-sourced
-- half of today's research; a QuickBooks export maps these onto Item/Item Description/Item
-- Quantity/Item Rate/Item Amount/Item Tax Code at export time (see the function below), not by
-- storing two parallel schemas.
create table public.ledger_lines (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.ledger_entries(id) on delete cascade,
  account_id uuid references public.ledger_accounts(id) on delete set null,
  description text not null,
  quantity numeric(14,4) not null default 1,
  unit_amount numeric(14,2) not null default 0,
  tax_type text,                    -- free text, e.g. 'Tax on Sales', 'NONE' -- Xero's TaxType is
                                     -- an org-specific configured value, not a fixed global enum
  line_amount numeric(14,2) not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.ledger_lines enable row level security;
-- RLS on a child table has to re-check through the PARENT's workspace -- there is no
-- workspace_id column here to compare against auth.uid() directly.
drop policy if exists ledger_lines_owner_all on public.ledger_lines;
create policy ledger_lines_owner_all on public.ledger_lines
  for all using (
    entry_id in (
      select le.id from public.ledger_entries le
      join public.workspaces w on w.id = le.workspace_id
      where w.owner_user_id = auth.uid()
    )
  );
create index if not exists ledger_lines_entry_idx on public.ledger_lines (entry_id, sort_order);

-- CSV FIELD ESCAPING -- RFC 4180: quote a field if it contains a comma, a double-quote, a
-- newline or leading/trailing whitespace; double any internal quotes. Shared by both export
-- functions below so the escaping rule is written once, not twice with two chances to diverge.
create or replace function public._csv_field(v text) returns text
language sql immutable
as $$
  select case
    when v is null then ''
    when v ~ '[,"\n\r]' or v <> btrim(v)
      then '"' || replace(v, '"', '""') || '"'
    else v
  end;
$$;

-- EXPORT: XERO invoice CSV import shape. One row per LINE, InvoiceNumber repeated across an
-- invoice's rows -- Xero groups rows back into one invoice by matching InvoiceNumber, per its
-- own CSV-import convention. RETURNS TEXT so the client's whole job is "save this string as a
-- .csv file", no client-side CSV logic needed.
create or replace function public.export_ledger_csv_xero(
  p_workspace uuid, p_kind text default 'invoice',
  p_from date default null, p_to date default null
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_out text := 'ContactName,InvoiceNumber,InvoiceDate,DueDate,Description,Quantity,UnitAmount,AccountCode,TaxType' || E'\n';
  r record;
begin
  if p_workspace not in (select id from workspaces where owner_user_id = auth.uid()) then
    raise exception 'not_your_workspace';
  end if;
  for r in
    select c.name as contact_name, e.doc_number, e.entry_date, e.due_date,
           l.description, l.quantity, l.unit_amount, a.code as account_code, l.tax_type
    from ledger_entries e
    join ledger_lines l on l.entry_id = e.id
    left join ledger_contacts c on c.id = e.contact_id
    left join ledger_accounts a on a.id = l.account_id
    where e.workspace_id = p_workspace
      and e.kind = p_kind
      and (p_from is null or e.entry_date >= p_from)
      and (p_to   is null or e.entry_date <= p_to)
    order by e.entry_date, e.doc_number, l.sort_order
  loop
    v_out := v_out || string_agg(x, ',') || E'\n'
    from unnest(array[
      _csv_field(coalesce(r.contact_name, '')),
      _csv_field(coalesce(r.doc_number, '')),
      _csv_field(to_char(r.entry_date, 'YYYY-MM-DD')),
      _csv_field(coalesce(to_char(r.due_date, 'YYYY-MM-DD'), '')),
      _csv_field(r.description),
      _csv_field(r.quantity::text),
      _csv_field(r.unit_amount::text),
      _csv_field(coalesce(r.account_code, '')),
      _csv_field(coalesce(r.tax_type, ''))
    ]) as x;
  end loop;
  return v_out;
end;
$$;
revoke all on function public.export_ledger_csv_xero(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.export_ledger_csv_xero(uuid, text, date, date) to authenticated;

-- EXPORT: QUICKBOOKS invoice CSV shape. Column names per the RELAYED sourcing noted above --
-- NOT vendor-primary, flagged in the function's own comment so nobody upgrades that silently.
create or replace function public.export_ledger_csv_quickbooks(
  p_workspace uuid, p_kind text default 'invoice',
  p_from date default null, p_to date default null
) returns text
language plpgsql security definer set search_path = public
as $$
declare
  -- ⚠ Column names here are RELAYED from third-party aggregator sites, not fetched from
  -- Intuit's own docs today (both the docs site and a community OpenAPI mirror were
  -- unreachable to a non-JS fetch). Re-verify against a real QuickBooks Online account before
  -- this export ships to a customer.
  v_out text := 'Invoice No.,Customer,Invoice Date,Due Date,Terms,Item,Item Description,Item Quantity,Item Rate,Item Amount,Item Tax Code' || E'\n';
  r record;
begin
  if p_workspace not in (select id from workspaces where owner_user_id = auth.uid()) then
    raise exception 'not_your_workspace';
  end if;
  for r in
    select c.name as contact_name, e.doc_number, e.entry_date, e.due_date,
           a.name as account_name, l.description, l.quantity, l.unit_amount,
           (l.quantity * l.unit_amount) as line_total, l.tax_type
    from ledger_entries e
    join ledger_lines l on l.entry_id = e.id
    left join ledger_contacts c on c.id = e.contact_id
    left join ledger_accounts a on a.id = l.account_id
    where e.workspace_id = p_workspace
      and e.kind = p_kind
      and (p_from is null or e.entry_date >= p_from)
      and (p_to   is null or e.entry_date <= p_to)
    order by e.entry_date, e.doc_number, l.sort_order
  loop
    v_out := v_out || string_agg(x, ',') || E'\n'
    from unnest(array[
      _csv_field(coalesce(r.doc_number, '')),
      _csv_field(coalesce(r.contact_name, '')),
      -- MM/DD/YYYY, the US-default QuickBooks Online date form per the relayed sourcing above;
      -- an org on a different regional format needs this parameterised, not hardcoded -- flagged
      -- rather than silently wrong for a non-US business.
      _csv_field(to_char(r.entry_date, 'MM/DD/YYYY')),
      _csv_field(coalesce(to_char(r.due_date, 'MM/DD/YYYY'), '')),
      _csv_field(''),  -- Terms -- not modeled yet, left blank rather than guessed
      _csv_field(coalesce(r.account_name, '')),
      _csv_field(r.description),
      _csv_field(r.quantity::text),
      _csv_field(r.unit_amount::text),
      _csv_field(r.line_total::text),
      _csv_field(coalesce(r.tax_type, ''))
    ]) as x;
  end loop;
  return v_out;
end;
$$;
revoke all on function public.export_ledger_csv_quickbooks(uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.export_ledger_csv_quickbooks(uuid, text, date, date) to authenticated;

-- item 5's on-screen tax disclaimer is a UI string (src/), not a DB object -- named here so it
-- is not forgotten, not built here.
