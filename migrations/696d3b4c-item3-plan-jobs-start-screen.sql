-- 696d3b4c item 3 (W1, Day 227), Cloud's split with Silver (job input shape agreed on fleet):
-- an existing business (entry_point no_website/has_website) generates plans from the start-
-- screen answers, not from a validator_runs row -- there may be no run at all. source_run_id
-- becomes nullable and source_kind says which branch a reader/worker is looking at.

alter table public.plan_jobs
  add column if not exists source_kind text not null default 'validator_run'
    check (source_kind in ('validator_run','start_screen')),
  alter column source_run_id drop not null,
  add constraint plan_jobs_source_kind_run_id_check
    check (
      (source_kind = 'validator_run' and source_run_id is not null) or
      (source_kind = 'start_screen' and source_run_id is null)
    );
-- Existing rows are all source_kind='validator_run' (the column default) with source_run_id
-- already set, so the new check is satisfied by every row that exists today -- no backfill.
