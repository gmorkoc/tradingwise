alter table public.profiles
  add column if not exists notify_strategy_alerts boolean not null default true;
