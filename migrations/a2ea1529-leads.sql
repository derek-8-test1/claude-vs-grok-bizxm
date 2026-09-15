-- a2ea1529 item 5 -- EMAIL CAPTURE BACKEND. Silver, Day 227.
-- Cloud's routing: the leads table plus a PUBLIC capture endpoint with basic rate limiting.
-- Sterling owns the page side; nothing here renders anything.
--
-- ⛔ WHY THE ENDPOINT IS AN RPC AND NOT A WORKER ROUTE. W1 is deploying src/ under c00acb8e, so a
--    route from me would race their deploy. An RPC granted to `anon` IS a public endpoint (POST
--    /rest/v1/rpc/capture_lead with the publishable key), so the backend half is complete and
--    drivable WITHOUT touching src/. A Worker route can later be a thin proxy that adds the real
--    client IP -- see the rate-limit bound below for why that proxy is worth having.

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  name text,
  message text,
  -- which page on the user's site captured it, so a user with several pages can tell them apart
  source_path text,
  -- ⛔ A HASH, NEVER THE ADDRESS. We do not need to know who a visitor is to rate-limit them, and
  --    storing a raw IP on a lead row turns every user's lead list into personal data we then owe
  --    a retention story for. The hash is supplied by the caller today (see the bound on
  --    capture_lead) -- that is a weakness in the LIMIT, not a reason to store the address.
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ONE ROW PER LEAD PER SITE. A visitor who submits twice should not produce two rows for the user
-- to de-duplicate by hand, and it removes the cheapest spam shape (resubmit the same form).
-- lower() because a lead list that treats Foo@ and foo@ as two people is wrong to its reader.
create unique index if not exists leads_workspace_email_uniq
  on public.leads (workspace_id, lower(email));
create index if not exists leads_workspace_created_idx
  on public.leads (workspace_id, created_at desc);

alter table public.leads enable row level security;
-- RLS DEFAULT-DENY, same shape as usage_events: the owner reads and deletes their own leads.
-- There is deliberately NO insert policy -- every write goes through capture_lead() below, so
-- `anon` can never write an arbitrary row (a wrong workspace_id, a forged created_at, a row on
-- somebody else's site).
drop policy if exists leads_owner_select on public.leads;
create policy leads_owner_select on public.leads
  for select using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );
drop policy if exists leads_owner_delete on public.leads;
create policy leads_owner_delete on public.leads
  for delete using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );

-- THE PUBLIC ENDPOINT.
-- ⚠ RATE-LIMIT BOUND, STATED HERE BECAUSE IT IS THE PART A READER WILL OTHERWISE ASSUME:
--   THE PER-WORKSPACE LIMIT IS REAL. The submitter does not choose the workspace -- it is the site
--   they are on -- so it genuinely caps what one site can be made to absorb in an hour.
--   THE PER-IP LIMIT IS BEST-EFFORT AND FORGEABLE. `p_ip_hash` arrives from the caller, and
--   inet_client_addr() under PostgREST is the pooler, not the visitor. A caller that varies the
--   hash evades it entirely. It becomes real the moment a Worker route supplies the hash from
--   CF-Connecting-IP server-side; until then it stops accidents and casual repeats, not an
--   attacker. Do NOT describe this as IP rate limiting without that clause.
create or replace function public.capture_lead(
  p_workspace uuid,
  p_email text,
  p_name text default null,
  p_message text default null,
  p_source_path text default null,
  p_ip_hash text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  -- Limits are named, not sprinkled through the body, so changing one is one edit and a reader can
  -- see the policy without reading the logic.
  k_per_workspace_hour constant int := 60;
  k_per_ip_hour        constant int := 10;
  v_email text := lower(btrim(p_email));
  v_count int;
begin
  if p_workspace is null then
    return jsonb_build_object('ok', false, 'error', 'workspace_required');
  end if;
  -- The workspace must EXIST. Without this a caller can probe for valid uuids by the difference
  -- between an FK error and a success, and every miss still costs us the rate-limit queries.
  if not exists (select 1 from public.workspaces where id = p_workspace) then
    return jsonb_build_object('ok', false, 'error', 'unknown_workspace');
  end if;
  -- Deliberately a SHAPE check, not an RFC 5322 parser: the only real validator of an email
  -- address is sending to it, and a strict regex would reject valid addresses while still
  -- admitting fake ones. This rejects the obviously-not-an-address and nothing more.
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_email');
  end if;
  if length(v_email) > 320 or length(coalesce(p_message, '')) > 5000
     or length(coalesce(p_name, '')) > 200 then
    return jsonb_build_object('ok', false, 'error', 'too_long');
  end if;

  select count(*) into v_count from public.leads
   where workspace_id = p_workspace and created_at > now() - interval '1 hour';
  if v_count >= k_per_workspace_hour then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'scope', 'workspace');
  end if;

  if p_ip_hash is not null then
    select count(*) into v_count from public.leads
     where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
    if v_count >= k_per_ip_hour then
      return jsonb_build_object('ok', false, 'error', 'rate_limited', 'scope', 'ip');
    end if;
  end if;

  insert into public.leads (workspace_id, email, name, message, source_path, ip_hash, user_agent)
  values (p_workspace, v_email, nullif(btrim(p_name), ''), nullif(btrim(p_message), ''),
          p_source_path, p_ip_hash, left(coalesce(p_user_agent, ''), 500))
  on conflict (workspace_id, lower(email)) do update
    set name       = coalesce(excluded.name, public.leads.name),
        message    = coalesce(excluded.message, public.leads.message),
        updated_at = now();

  -- ⛔ THE RETURN CARRIES NO ROW AND SAYS NOTHING ABOUT NEW-VERSUS-REPEAT. Telling an anonymous
  --    caller "you already exist here" makes this form an email-membership oracle for somebody
  --    else's lead list. The owner sees the row; the submitter sees only that it worked.
  return jsonb_build_object('ok', true);
end;
$$;

-- `anon` is the publishable-key role: this is what makes it a PUBLIC endpoint. EXECUTE on the
-- function is the whole of the grant -- the table itself stays default-deny, so the function is
-- the only door and its body is the policy.
revoke all on function public.capture_lead(uuid, text, text, text, text, text, text) from public;
grant execute on function public.capture_lead(uuid, text, text, text, text, text, text)
  to anon, authenticated;
