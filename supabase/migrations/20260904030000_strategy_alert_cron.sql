-- Runs strategy-alert-eval every minute, evaluating every enabled
-- strategy_alerts row against fresh candle data. Reuses the same shared
-- vault secret btc-price-alert-push and daily-brief-push already use
-- (created in 20260827_btc_price_alert_cron.sql) rather than minting a new
-- one — the edge function checks it the same way theirs do.
select cron.schedule(
  'strategy-alert-eval',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/strategy-alert-eval',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
