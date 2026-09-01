-- Once daily at 15:00 UTC — the schedule itself is what limits this to
-- one reminder per day, no state table needed like the other cron jobs.
select cron.schedule(
  'upgrade-reminder-push',
  '0 15 * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/upgrade-reminder-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
