-- Lets the agent itself propose changing the user's overall paper cash
-- balance (not a trade) when asked directly, e.g. "update my budget to
-- $5,000" — same confirm/dismiss-gated proposal pattern as action/basket,
-- just for a portfolio setting instead of a trade.
alter table public.agent_messages
  add column if not exists balance_update jsonb;
