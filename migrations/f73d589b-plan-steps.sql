-- f73d589b item 4 -- business plan and marketing plan as STEP LIBRARY entries (W1, Day 227).
-- Same reasoning as the 'validate' step already in this table (614ca396, Cloud's ruling, Day
-- 227 11:1xZ): a step is DATA, not code, so the web app, the prompt playbooks and the MCP
-- connector all read and (later) write these plans through the SAME typed definition instead of
-- three copies drifting apart. Applied now, before ANTHROPIC_API_KEY exists, same as 'validate'
-- was -- the shape is right from the start rather than hardcode-then-refactor.

insert into public.steps (id, typed_inputs, typed_outputs, instructions, sources_rule)
values (
  'business_plan',
  '{
    "type": "object",
    "required": ["idea_text"],
    "properties": {
      "idea_text": {"type": "string"},
      "validator_run_id": {"type": ["string", "null"], "format": "uuid",
        "description": "the accepted idea-validation run this plan is generated from, if any"}
    }
  }'::jsonb,
  '{
    "type": "object",
    "required": ["elevator_pitch", "plan_sections", "cost_estimate", "break_even"],
    "properties": {
      "elevator_pitch": {"type": "string"},
      "plan_sections": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["heading", "body"],
          "properties": {"heading": {"type": "string"}, "body": {"type": "string"}}
        }
      },
      "cost_estimate": {
        "description": "sourced_figure or not_found -- SAME shape as validate step''s sourced_figure, carried from validator_runs.costs, never invented here",
        "oneOf": [
          {"type": "object", "required": ["value", "source", "as_of"],
           "properties": {"value": {}, "source": {"type": "string"}, "as_of": {"type": "string", "format": "date"}}},
          {"type": "object", "required": ["not_found"], "properties": {"not_found": {"const": true}}}
        ]
      },
      "break_even": {
        "type": "object",
        "required": ["assumptions", "monthly_revenue", "monthly_costs", "months_to_break_even"],
        "properties": {
          "assumptions": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["label", "value", "editable"],
              "properties": {"label": {"type": "string"}, "value": {"type": "number"}, "editable": {"const": true}}
            }
          },
          "monthly_revenue": {"type": "number"},
          "monthly_costs": {"type": "number"},
          "months_to_break_even": {"type": ["number", "null"]}
        }
      }
    }
  }'::jsonb,
  'Given an accepted business idea (and its validator run if one exists), draft an elevator pitch and full plan sections (problem, solution, market, operations, team at minimum). Carry the cost estimate from the validator run''s costs field if present, never invent one. Draft a break-even forecast: every assumption (price, customers per month, fixed costs, startup cost) must be labelled editable and left for the user to confirm or change -- this is a forecast the user owns, not a fact the system asserts. Manual editing by the user is the must-have (a plan generated here is a first draft, never the only path to a finished one -- the AI may be down or unpaid).',
  'cost_estimate follows the sourcing rule structurally (oneOf, matching the validate step''s sourced_figure): a real value with a source and date, or not_found=true, never a bare number. break_even has no external source -- every figure there is an ASSUMPTION and is typed with editable:true rather than a source, because it is a forecast the user can change, not a measured fact.'
)
on conflict (id) do nothing;

insert into public.steps (id, typed_inputs, typed_outputs, instructions, sources_rule)
values (
  'marketing_plan',
  '{
    "type": "object",
    "required": ["idea_text"],
    "properties": {
      "idea_text": {"type": "string"},
      "business_plan_pitch": {"type": ["string", "null"]}
    }
  }'::jsonb,
  '{
    "type": "object",
    "required": ["posting_goals", "target_keywords", "seo_keywords", "bid_keywords"],
    "properties": {
      "posting_goals": {
        "type": "object",
        "description": "per channel: {\"x\": {\"per\": \"day\"|\"week\", \"count\": n}, ...} -- open on channel, more land as they connect (b0e0450b)",
        "additionalProperties": {
          "type": "object",
          "required": ["per", "count"],
          "properties": {"per": {"type": "string", "enum": ["day", "week"]}, "count": {"type": "integer"}}
        }
      },
      "target_keywords": {"type": "array", "items": {"type": "string"}},
      "seo_keywords": {
        "type": "object",
        "description": "feeds the Site Builder''s page titles/descriptions/headings (a2ea1529) -- read by that piece, written by this one",
        "required": ["title", "description", "headings"],
        "properties": {
          "title": {"type": "array", "items": {"type": "string"}},
          "description": {"type": "array", "items": {"type": "string"}},
          "headings": {"type": "array", "items": {"type": "string"}}
        }
      },
      "bid_keywords": {
        "type": "array", "items": {"type": "string"},
        "description": "worth bidding on, WITH NO PRICES -- this product does not estimate ad spend"
      }
    }
  }'::jsonb,
  'Given the business idea and (if available) the elevator pitch from the business plan, draft a marketing plan: a posting goal per channel (only X is built today, per week/day with a count), target keywords, SEO keywords split into title/description/headings that the Site Builder can read directly, and a list of bid-worthy keywords with NO price estimates attached -- this product does not model ad spend. Manual editing by the user is the must-have, same as the business plan.',
  'No externally-sourced figures in this step''s output -- every field is a candidate the user reviews and edits, never presented as a measured fact. bid_keywords is explicitly unpriced by contract (typed_outputs carries no price field), so a future implementation cannot silently add one without changing this schema.'
)
on conflict (id) do nothing;
