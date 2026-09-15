-- b0e0450b item 2 -- CONNECT-X (Twitter) BACKEND. Silver, Day 227.
-- DB half only: token storage + the RPCs a Worker route needs. The two new routes
-- (/auth/x/start, /auth/x/callback) are NOT added here -- Cloud's own point (1) puts the OAuth
-- exchange server-side in the Worker (confidential client, like W1's Google flow), and W1 is
-- mid-restyle across every route in src/index.ts right now. Adding routes there today would be
-- exactly the coordination collision Cloud flagged for my validator pages. This lands the part
-- that does not touch src/ at all, so the route work is a smaller, isolated diff once W1 clears.

create table if not exists public.x_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  x_user_id text not null,       -- the X account's numeric id, from GET /2/users/me at connect time
  x_username text not null,      -- @handle, display only -- NEVER used as the identity key, X
                                  -- usernames are mutable and re-issuable to a different account
  access_token text not null,
  -- ⛔ REFRESH TOKEN IS NULLABLE ON PURPOSE. offline.access is what makes X issue one; if a future
  --    connect flow omits that scope (unlikely, but the column should not assert a thing that
  --    didn't happen), a null here is the honest record, not a broken row.
  refresh_token text,
  scope text not null,           -- space-separated scopes actually granted, as X returned them --
                                  -- NEVER the scopes we asked for, in case X narrows the grant
  expires_at timestamptz not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz    -- soft-disconnect: keep the row for audit (what did we post as,
                                  -- when), null out the tokens via revoke_x_connection() below
);

-- ONE X ACCOUNT CONNECTED PER WORKSPACE for v0, same shape as one_workspace_per_owner --
-- the Marketing Engine posts as "the business", not as several accounts at once.
create unique index if not exists x_connections_workspace_uniq
  on public.x_connections (workspace_id) where disconnected_at is null;

alter table public.x_connections enable row level security;
-- RLS DEFAULT-DENY. The owner can see THAT they are connected and as whom (x_username, scope,
-- connected_at, expiry) -- never the tokens. Tokens are read only by the service role, from the
-- Worker, when it actually needs to call the X API on the user's behalf.
drop view if exists public.x_connections_public;
create view public.x_connections_public
  with (security_invoker = true) as
  select id, workspace_id, x_username, scope, connected_at, expires_at, disconnected_at
  from public.x_connections;

drop policy if exists x_connections_owner_select on public.x_connections;
create policy x_connections_owner_select on public.x_connections
  for select using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );
-- ⚠ THE POLICY ABOVE STILL LETS A DIRECT REST CALL SELECT access_token/refresh_token -- RLS
--   scopes ROWS, not COLUMNS. The real column-level protection is that the CLIENT queries
--   `x_connections_public`, never `x_connections`, and the app must be built that way. Documented
--   here because it is the kind of gap a reader assumes RLS already closed.
-- No insert/update/delete policy: every write is server-side (service role), via the functions
-- below or the Worker directly with the service key -- a user must never set their own tokens.

-- Called by the Worker's /auth/x/callback, server-side, after exchanging the code with X.
create or replace function public.upsert_x_connection(
  p_workspace uuid,
  p_x_user_id text,
  p_x_username text,
  p_access_token text,
  p_refresh_token text,
  p_scope text,
  p_expires_at timestamptz
) returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.workspaces where id = p_workspace) then
    raise exception 'unknown_workspace';
  end if;
  -- Replace any existing LIVE connection for this workspace rather than erroring -- reconnecting
  -- (e.g. after a revoke on X's side, or switching which account posts) is a normal action, not
  -- an edge case to refuse.
  update public.x_connections set disconnected_at = now()
   where workspace_id = p_workspace and disconnected_at is null;

  insert into public.x_connections
    (workspace_id, x_user_id, x_username, access_token, refresh_token, scope, expires_at)
  values
    (p_workspace, p_x_user_id, p_x_username, p_access_token, p_refresh_token, p_scope, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;
-- ⛔ ‼ REVOKING FROM `public` IS NOT ENOUGH -- FOUND BY DRIVING, NOT READING. Supabase's own
--    ALTER DEFAULT PRIVILEGES on this schema grants EXECUTE on every new function DIRECTLY to
--    anon, authenticated and service_role as SEPARATE ACL entries at CREATE FUNCTION time --
--    they are NOT inherited from the PUBLIC pseudo-role, so `revoke ... from public` leaves all
--    three grants standing untouched. The first version of this migration did exactly that and
--    an anon-key drive script wrote a forged connection row on the first try (workspace known,
--    tokens invented, x_username='hacker') before this line existed.
-- ⇒ REVOKE FROM THE NAMED ROLES EXPLICITLY, every time a SECURITY DEFINER function is not meant
--    to be public, and DRIVE THE NEGATIVE CONTROL as the anon key before believing the DDL --
--    reading the CREATE/REVOKE/GRANT statements gives no signal that this defect exists.
revoke all on function public.upsert_x_connection(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.upsert_x_connection(uuid, text, text, text, text, text, timestamptz)
  to service_role;

-- Called by the owner (client-side, authenticated) to disconnect -- does NOT call X's own revoke
-- endpoint; that is a Worker-side follow-up once the route exists. This just stops US using the
-- token and is safe to ship before the Worker route lands.
create or replace function public.disconnect_x(p_workspace uuid) returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  if p_workspace not in (select id from public.workspaces where owner_user_id = auth.uid()) then
    raise exception 'not_your_workspace';
  end if;
  update public.x_connections set disconnected_at = now(), access_token = '', refresh_token = null
   where workspace_id = p_workspace and disconnected_at is null;
  return found;
end;
$$;
-- Same class as upsert_x_connection above: `from public` alone is insufficient, anon gets a
-- default grant directly and must be revoked by name even though this function IS meant for
-- authenticated (never anon -- an unauthenticated caller has no auth.uid() to check against).
revoke all on function public.disconnect_x(uuid) from public, anon;
grant execute on function public.disconnect_x(uuid) to authenticated;

-- ⚠ STILL OPEN, NOT THIS FILE: the actual /auth/x/start and /auth/x/callback Worker routes
--   (PKCE code_verifier storage across the redirect, the token exchange call, calling
--   upsert_x_connection with the service key); the post-generation write to usage_events per
--   $0.015/$0.200 once (2) above resolves; and revoking on X's own /2/oauth2/revoke when
--   disconnect_x runs, which needs the Worker too. Tracked on b0e0450b, not duplicated here.
