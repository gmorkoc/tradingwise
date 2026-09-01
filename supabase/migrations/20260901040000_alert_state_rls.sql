-- Both tables are single-row cron/state trackers written only by the
-- service-role edge functions (btc-price-alert-push, daily-brief-push),
-- which bypass RLS entirely — so enabling RLS with zero policies is the
-- correct fix: it makes them fully private to anon/authenticated (who
-- have no legitimate reason to touch them) without needing any policy at
-- all, while service_role access is unaffected.
alter table public.btc_price_alert_state enable row level security;
alter table public.daily_brief_alert_state enable row level security;
