-- Strategy Alerts: rules-based, multi-condition, multi-instrument alert
-- builder (TickScan-style). See coinhintz plan "glimmering-rolling-liskov"
-- for the full design.

create table if not exists public.strategy_alerts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  name             text not null,
  template_id      text,
  logic            text not null default 'AND' check (logic in ('AND','OR')),
  conditions       jsonb not null,
  coins            text[] not null check (array_length(coins, 1) > 0),
  cooldown_minutes int not null default 60 check (cooldown_minutes >= 1),
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists strategy_alerts_enabled_idx
  on public.strategy_alerts (id) where enabled;

alter table public.strategy_alerts enable row level security;

create policy "Users manage their own strategy alerts"
  on public.strategy_alerts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Fire log — also the cooldown source of truth (max(fired_at) per
-- strategy+coin), which we need to store anyway for the recent-fires view.
create table if not exists public.strategy_fires (
  id           bigint generated always as identity primary key,
  strategy_id  uuid not null references public.strategy_alerts(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  coin         text not null,
  timeframe    text not null,
  summary      text not null,
  fired_at     timestamptz not null default now()
);

create index if not exists strategy_fires_cooldown_idx
  on public.strategy_fires (strategy_id, coin, fired_at desc);
create index if not exists strategy_fires_user_recent_idx
  on public.strategy_fires (user_id, fired_at desc);

alter table public.strategy_fires enable row level security;

-- Read-only for users: only the cron (service role) ever writes fires,
-- unlike strategy_alerts which users own end-to-end.
create policy "Users view their own strategy fires"
  on public.strategy_fires
  for select
  using (auth.uid() = user_id);
