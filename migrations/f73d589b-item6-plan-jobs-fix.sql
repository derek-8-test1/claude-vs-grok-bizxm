-- f73d589b item 6, Cloud's 3 corrections on the agreed shape (761a4cb5, 15:25Z) --
-- composition issues caught before either of us built against the wrong one.

-- (1) business_plans.plan_sections is DEAD: W1 already moved business-plan sections onto
-- public.page_sections (page='business-plan') under 2df0e973, before this migration landed.
-- Verified zero rows use it (0 of 2 business_plans rows have plan_sections != '[]') so this is
-- a clean drop, not data loss.
alter table public.business_plans drop column if exists plan_sections;

-- (2) user_edited alone cannot distinguish a legitimate regenerate from a clobber -- the button
-- sets this true only after the user has explicitly accepted overwriting their own edits; the
-- worker refuses to write over a user_edited row unless this is also true, and fails the job
-- with that reason rather than silently discarding the user's text.
alter table public.plan_jobs add column if not exists overwrite_confirmed boolean not null default false;
