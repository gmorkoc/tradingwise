-- Hyperliquid top traders' open positions (Trade page "Top Traders" tab).
-- Public market data: anyone (signed in or not) can read it; only the
-- hl-top-traders edge function (service role) writes. One row per
-- trader per coin, refreshed every 5 minutes.
create table if not exists public.hl_top_traders (
  coin            text not null,
  address         text not null,
  label           text not null,
  side            text not null check (side in ('long', 'short')),
  size            numeric not null,
  position_value  numeric not null,
  entry_px        numeric not null,
  mark_px         numeric not null,
  liquidation_px  numeric,
  leverage        numeric not null,
  unrealized_pnl  numeric not null,
  roe             numeric not null,
  funding         numeric not null,
  account_value   numeric not null,
  month_pnl       numeric not null,
  updated_at      timestamptz not null default now(),
  primary key (coin, address)
);

create index if not exists hl_top_traders_coin_pnl_idx
  on public.hl_top_traders (coin, unrealized_pnl desc);

alter table public.hl_top_traders enable row level security;

drop policy if exists "Anyone can read top traders" on public.hl_top_traders;
create policy "Anyone can read top traders"
  on public.hl_top_traders
  for select
  using (true);

-- Supabase no longer auto-grants Data API access to new tables.
grant select on public.hl_top_traders to anon, authenticated;
grant all on public.hl_top_traders to service_role;

-- Every 5 minutes, same shared cron secret as the other scheduled jobs.
select cron.schedule(
  'hl-top-traders',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/hl-top-traders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
