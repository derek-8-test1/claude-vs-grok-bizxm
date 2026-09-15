-- 36de4e90 item 16 (legal and licences) + the item 22/23 form fields, final shape locked by
-- Cloud (cbf6cde1, superseding Silver's earlier country_region proposal -- no such column).
-- Silver owns this migration; W1 wires the form against these exact names.

alter table public.validator_runs
  add column if not exists country text,      -- ISO 3166 alpha-2. Gates BOTH legal eligibility
                                                -- and item 22's build-plan branching -- one field,
                                                -- not two, per Cloud's ruling.
  add column if not exists region text,        -- optional city or state, free text
  add column if not exists tech_comfort text
    check (tech_comfort is null or tech_comfort in ('never_used','basic','confident','builds_software')),
  add column if not exists hours_per_week integer
    check (hours_per_week is null or (hours_per_week >= 0 and hours_per_week <= 100));
-- ⛔ Cloud's ruling, stated explicitly: "the form writes it, so enforce where it lands, not only
-- in the worker." Both CHECKs enforce the SAME enum/range judge-worker.py and legal-worker.py
-- also validate in Python -- defense-in-depth, not a substitute for either layer.

alter table public.validator_runs
  add column if not exists legal_status text
    check (legal_status is null or legal_status in
      ('clearly_legal','licence_required','restricted','likely_not_legal','unknown')),
  -- structured trigger for the page banner (raised ABOVE the score, same slot as the safety
  -- banner, when restricted or likely_not_legal) -- never parsed out of the prose verdict.
  add column if not exists legal_verdict text,       -- plain-language, "not legal advice" wording
                                                       -- baked into the step's own instructions
  add column if not exists licences jsonb,           -- [{name, issuing_authority, source}] or
                                                       -- [{not_found:true}], same sourcing rule
  add column if not exists law_areas jsonb,          -- ["GDPR", "local business registration", ...]
  add column if not exists required_documents jsonb; -- [{name, why, applies_because, source}] --
                                                       -- feeds the unbuilt a2ea1529 item 10 as its
                                                       -- future input (W1 confirmed nothing
                                                       -- pre-exists to match, 50f5d007)
