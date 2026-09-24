-- Buy Opportunity signals: a background scanner (buy-signal-scan edge
-- function, run daily via cron) scores every actively-tracked coin on
-- daily-candle confluence (RSI oversold, at/below lower Bollinger Band,
-- recent drawdown, elevated volume) and stores the current read here.
-- Global/coin-scoped, not user-owned — same data for everyone, unlike
-- strategy_alerts — so RLS is read-only-for-everyone, write-only-by-cron.

create table if not exists public.buy_signals (
  coin          text primary key,
  score         int not null,
  max_score     int not null,
  signals       jsonb not null,
  price         numeric not null,
  rsi           numeric,
  bb_pct        numeric,
  drawdown_pct  numeric,
  vol_ratio     numeric,
  is_active     boolean not null default false,
  scanned_at    timestamptz not null default now()
);

alter table public.buy_signals enable row level security;

drop policy if exists "authenticated users can read buy signals" on public.buy_signals;
create policy "authenticated users can read buy signals"
  on public.buy_signals for select
  to authenticated
  using (true);

-- Fire log — one row per coin per time it newly crosses the active
-- threshold (not every scan it stays active), same cooldown-source-of-truth
-- role strategy_fires plays for strategy_alerts.
create table if not exists public.buy_signal_fires (
  id         bigint generated always as identity primary key,
  coin       text not null,
  score      int not null,
  signals    jsonb not null,
  price      numeric not null,
  fired_at   timestamptz not null default now()
);

create index if not exists buy_signal_fires_coin_idx
  on public.buy_signal_fires (coin, fired_at desc);

alter table public.buy_signal_fires enable row level security;

drop policy if exists "authenticated users can read buy signal fires" on public.buy_signal_fires;
create policy "authenticated users can read buy signal fires"
  on public.buy_signal_fires for select
  to authenticated
  using (true);

-- Opt-out preference, same default-on convention as notify_strategy_alerts.
alter table public.profiles
  add column if not exists notify_buy_signals boolean not null default true;
