-- Two new agent response shapes, mirrored onto agent_messages so past
-- turns re-render correctly on reload (same reasoning as the existing
-- `action` column):
--   `basket` — multiple trade legs proposed/executed together (e.g.
--   "long the 3 strongest coins on my watchlist"), reusing action_status
--   for the whole basket's pending/confirmed/dismissed state rather than
--   tracking per-leg status.
--   `question` — a clarifying multiple-choice question the agent asks
--   before it has enough to propose a trade/basket (e.g. budget, how many
--   coins to include), rendered as tappable option chips.
alter table public.agent_messages
  add column if not exists basket jsonb,
  add column if not exists question jsonb;
