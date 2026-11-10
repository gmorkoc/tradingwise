-- Run btc-price-alert-push in Frankfurt instead of the default US region.
-- Binance refuses requests from the US (HTTP 451), and alerts should use
-- Binance prices because the chart and every alert level are Binance USDT
-- prices. Supabase routes an edge-function call to the region named in the
-- x-region header. Same schedule (every minute), same secret as before.

select cron.unschedule('btc-price-alert-push')
where exists (select 1 from cron.job where jobname = 'btc-price-alert-push');

select cron.schedule(
  'btc-price-alert-push',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/btc-price-alert-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-region', 'eu-central-1',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
