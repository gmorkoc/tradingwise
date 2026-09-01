-- Every 10 minutes — RSS feeds don't update fast enough to warrant the
-- 1-minute cadence btc-price-alert-push uses, and this matches
-- DailyBrief.tsx's own client-side refetch interval.
select cron.schedule(
  'daily-brief-push',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/daily-brief-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
