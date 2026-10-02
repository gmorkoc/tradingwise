-- Lets the client know about a new agent message the instant it's
-- inserted — specifically ones agent-watch-scan posts in the background
-- (a watch triggering, a position auto-closing) while the Trading Agent
-- panel is closed or the user is elsewhere in the app. Same role
-- buy_signal_fires/strategy_fires realtime already plays for those
-- features (see useBuySignalRealtime.ts, StrategyAlerts.tsx).
alter publication supabase_realtime add table public.agent_messages;
