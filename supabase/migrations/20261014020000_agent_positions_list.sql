-- Persists the agent's "show my open/closed positions" pickable list card
-- (positionsList) — originally left transient like marketSnapshot, but
-- unlike marketSnapshot it renders inline in the message feed itself, and
-- the feed gets reloaded straight from this table from multiple places
-- (the explicit post-send reload AND the realtime postgres_changes
-- subscription in TradingAgent.tsx both re-fetch independently), so a
-- transient-only field kept getting silently wiped out moments after it
-- first rendered. Persisted the same way navigate_to/action/basket already
-- are, so every reload path reads the real thing instead of having to
-- individually know to preserve it.
alter table public.agent_messages
  add column if not exists positions_list jsonb;
