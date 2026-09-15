-- f73d589b item 6 (Silver, Day 227): "Generate my business and marketing plans" actually
-- generates. Darren clicked it and it only linked to an empty plan page -- there was no queue,
-- no worker, no "which run" link, and no guard against a background regenerate clobbering
-- text the user had already edited. This migration adds the job queue and the missing columns
-- on the two plan tables; W1 wires the button/job-insert/progress-state side against this shape
-- (agreed on fleet, post b8af096c, before either of us built).

create table public.plan_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_run_id uuid not null references public.validator_runs(id) on delete cascade,
  status text not null default 'queued',
  -- 'queued' | 'generating' | 'done' | 'failed' | 'queued_over_cap' -- same state-machine shape
  -- as validator_runs.status, same reason: "not done yet" and "failed" must never collapse into
  -- one value, or a failed job reads as merely-not-done and nobody ever revisits it.
  -- 'generating' is the worker's claim marker while a claude -p call is actually in flight
  -- (same role as validator_runs.status='scoring' in judge-worker.py).
  -- 'queued_over_cap' (same daily cap and same visible-state ruling as dadf4249): the plans
  -- worker shares judge-worker.py's DAILY_CAP and usage_events.kind counting, so a plans job
  -- can hit the cap exactly like a judgement call can, and must not stall silently either.
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- A workspace can have many plan_jobs over its lifetime -- every regenerate is a NEW row, not
-- an overwrite of one mutable job, so the history of what was generated when survives. The page
-- reads the LATEST row per workspace for its Generating banner.
create index plan_jobs_workspace_created_idx on public.plan_jobs (workspace_id, created_at desc);

alter table public.plan_jobs enable row level security;
create policy plan_job_owner_all on public.plan_jobs
  for all using (
    workspace_id in (select id from public.workspaces where owner_user_id = auth.uid())
  );

-- Which run a plan came from (item 6's own wording: "the plan pages show ... with which run it
-- came from"), and whether a human has edited the text since it was (re)generated -- the
-- worker's own guard against silently clobbering an edit, independent of whatever confirm
-- dialog W1 puts in front of the regenerate button. user_edited is set true wherever the
-- click-to-edit save path (cff5b38) writes to these tables, and set false by the worker on
-- every successful generation.
alter table public.business_plans
  add column if not exists source_run_id uuid references public.validator_runs(id),
  add column if not exists user_edited boolean not null default false;

alter table public.marketing_plans
  add column if not exists source_run_id uuid references public.validator_runs(id),
  add column if not exists user_edited boolean not null default false;
