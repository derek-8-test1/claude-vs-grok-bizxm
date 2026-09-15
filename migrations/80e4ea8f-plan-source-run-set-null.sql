-- Cloud's catch (80e4ea8f), after W1's plans-button drive: business_plans.source_run_id and
-- marketing_plans.source_run_id defaulted to ON DELETE NO ACTION (a bare `references`), which
-- blocks deleting a validator_run a plan was generated from. Fixed to ON DELETE SET NULL: a
-- future "delete this report" keeps the plan and just drops the link, never blocks the delete.
alter table public.business_plans drop constraint business_plans_source_run_id_fkey;
alter table public.business_plans add constraint business_plans_source_run_id_fkey
  foreign key (source_run_id) references public.validator_runs(id) on delete set null;

alter table public.marketing_plans drop constraint marketing_plans_source_run_id_fkey;
alter table public.marketing_plans add constraint marketing_plans_source_run_id_fkey
  foreign key (source_run_id) references public.validator_runs(id) on delete set null;
