-- buy-signal-scan sequentially fetches daily candles for ~73 coins (~60-90s
-- total) — well past pg_net's default 5s wait-for-response timeout. The
-- function itself completes fine regardless (Edge Functions run
-- independently of whether the caller is still waiting), confirmed by a
-- manual trigger during testing that fully populated buy_signals despite
-- pg_net logging a timeout — but leaving the default meant net._http_response
-- would show a false "timed out" error on every single daily run, masking
-- real failures behind expected noise. cron.schedule with the same job name
-- updates it in place rather than creating a duplicate.
select cron.unschedule('buy-signal-scan');
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
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  $$
);
