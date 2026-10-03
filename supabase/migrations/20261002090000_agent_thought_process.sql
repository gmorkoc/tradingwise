-- The agent's full live-streamed reasoning (trend/RSI/MACD/volume/news
-- walkthrough) was ephemeral-only — shown while streaming, then discarded
-- once the reply replaced it. Now persisted so it survives the response
-- and a reload, instead of disappearing the moment the turn finishes.
alter table public.agent_messages
  add column if not exists thought_process text;
