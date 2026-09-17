-- Market Pulse bot: an automated account that posts a 15-minute market
-- summary into every coin's live chat that's had real (non-bot) activity
-- in the last 24h — candle direction/move %, current price + 24h change,
-- and (BTC only, where a real data feed actually exists) large whale
-- transfers seen in the last 15 minutes.
--
-- Liquidations are intentionally left out everywhere: this app has no real
-- liquidation-events feed for any coin (the existing liquidation heatmap
-- is a computed leverage-cluster estimate, not actual exchange data), and
-- posting a fabricated number into a trading chat isn't something to do
-- quietly.

alter table public.profiles add column if not exists is_bot boolean not null default false;
-- No update grant added — is_bot is never set by a client, only by this
-- migration (for the bot's own row, via the service-role edge function).

alter table public.coin_comments add column if not exists is_bot boolean not null default false;
-- Denormalized at post time, same convention already used for
-- username/tier/avatar_url (see stamp_comment_author below).

create or replace function public.stamp_comment_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select p.username, p.tier, p.avatar_url, p.is_bot
    into new.username, new.tier, new.avatar_url, new.is_bot
  from public.profiles p where p.id = new.user_id;

  if new.username is null then
    raise exception 'Set a username before posting';
  end if;
  if new.tier not in ('pro', 'elite') then
    raise exception 'Only Pro and Elite members can post comments';
  end if;

  return new;
end;
$$;

-- Reuses the same shared vault secret every other cron-triggered function
-- already checks (see strategy-alert-eval's cron migration) rather than
-- minting a new one.
select cron.schedule(
  'market-pulse-bot',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/market-pulse-bot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
