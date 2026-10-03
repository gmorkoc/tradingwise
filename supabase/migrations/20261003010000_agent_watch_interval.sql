-- Watches used to always be re-checked on a hardcoded timeframe (first 1h,
-- then 4h once that was aligned to match the app's header) with no way for
-- the user to pick something else. This lets each watch choose its own
-- interval at confirm time (the client now shows a selector before the
-- watch is actually created) and agent-watch-scan fetch the matching
-- timeframe's indicator data per watch instead of one fixed default for all.
alter table public.agent_watches
  add column if not exists interval text not null default '4h'
    check (interval in ('1h', '4h', '1d'));
