-- Move the scan from once/day to every 4h, matching the new 4h-candle
-- scoring model (buy-signal-scan/index.ts). Each run now does noticeably
-- more work per coin than before — bigger candle fetch (260 vs 40) plus up
-- to 3 extra HTTP calls for funding-rate/long-short-ratio positioning data,
-- across both buy and sell scoring — so the pg_net wait timeout goes up
-- from 180s to 280s as headroom. cron.schedule with the same job name
-- updates it in place rather than creating a duplicate.
select cron.unschedule('buy-signal-scan');
select cron.schedule(
  'buy-signal-scan',
  '10 */4 * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/buy-signal-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
