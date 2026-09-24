-- Lets the client subscribe to new buy_signal_fires rows via Supabase
-- Realtime (postgres_changes) — needed for an in-app toast that shows up
-- immediately while the web app is open, independent of whether a push
-- notification actually gets delivered (browser push subscriptions can go
-- stale; this doesn't depend on one at all). Same mechanism strategy_fires
-- already uses the client API for, just was never actually added to the
-- publication that makes postgres_changes broadcast in the first place.
alter publication supabase_realtime add table public.buy_signal_fires;
