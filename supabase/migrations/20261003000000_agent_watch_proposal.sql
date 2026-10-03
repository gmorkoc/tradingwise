-- Watches used to be created immediately the moment the agent proposed
-- one, with only a post-hoc "Cancel" button — unlike action/basket/
-- balanceUpdate, which all require an explicit Confirm tap before they
-- take effect. This column lets a watch follow the same pending/confirmed/
-- dismissed pattern (action_status, already shared by the other three):
-- the proposed {coin, condition} is stored here first, and the real
-- agent_watches row (watch_id) is only created once the user taps Confirm.
alter table public.agent_messages
  add column if not exists watch jsonb;
