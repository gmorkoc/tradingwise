-- Lets the agent offer a direct "take me there" button to a relevant
-- in-app page/section (e.g. the Liquidation Heatmap) instead of recomm-
-- ending an external platform for something this app already covers.
-- Persisted (not transient like marketSnapshot) since it needs to stay
-- tappable on reload, same as action/watch/question.
alter table public.agent_messages
  add column if not exists navigate_to jsonb;
