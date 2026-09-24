-- Runs buy-signal-scan once daily, shortly after the daily candle closes
-- at 00:00 UTC (10 min buffer for the new candle to settle on Binance's
-- side). Reuses the same shared vault secret every other cron job in this
-- project uses (created in 20260827_btc_price_alert_cron.sql).
select cron.schedule(
  'buy-signal-scan',
  '10 0 * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/buy-signal-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
