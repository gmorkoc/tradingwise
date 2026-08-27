-- Server-side twin of the client-only PriceAlerts.tsx alerts (localStorage
-- "priceAlerts" key) — same shape (coin, target_price, direction, one-shot
-- triggered flag) but persisted so the price-alert cron can push a
-- notification even when the app is closed, not just play an in-app toast.
create table if not exists public.price_alerts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  coin         text not null,
  target_price double precision not null,
  direction    text not null check (direction in ('above', 'below')),
  triggered    boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists price_alerts_pending_idx
  on public.price_alerts (coin)
  where not triggered;

alter table public.price_alerts enable row level security;

create policy "Users manage their own price alerts"
  on public.price_alerts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
