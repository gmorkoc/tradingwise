-- Tightened from every 5 minutes to every 1 minute, matching
-- strategy-alert-eval's cadence — faster reaction to a triggered watch or
-- a TP/SL/liquidation hit outweighs the extra OpenAI call volume.
-- cron.schedule with the same job name updates it in place rather than
-- creating a duplicate.
select cron.unschedule('agent-watch-scan');
select cron.schedule(
  'agent-watch-scan',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/agent-watch-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
