-- Single-row table holding the last "anchor" BTC price the push-alert cron
-- compared against, so a stateless scheduled function can detect a >= $50
-- move since its last run. Mirrors the client-side anchor in useBtcMoveAlert.ts,
-- just with a much larger threshold since this fires a push, not an in-app toast.
create table if not exists public.btc_price_alert_state (
  id           int primary key default 1,
  anchor_price double precision,
  updated_at   timestamptz not null default now(),
  constraint btc_price_alert_state_single_row check (id = 1)
);

insert into public.btc_price_alert_state (id, anchor_price)
values (1, null)
on conflict (id) do nothing;
