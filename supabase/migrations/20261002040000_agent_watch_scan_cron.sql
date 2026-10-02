-- Runs agent-watch-scan every 5 minutes: re-checks every active
-- agent_watches condition (via a cheap LLM classification against fresh
-- market data) and every open leveraged position's take-profit/stop-loss/
-- liquidation price against the live price. Anything that's now true gets
-- resolved in the DB, a confirmation message in that user's chat, and a
-- push notification (FCM -> iOS/Android, Web Push -> browsers).
-- 5 minutes rather than strategy-alert-eval's 1 minute: each watch check
-- costs an OpenAI call, and a trading watch doesn't need tick-level
-- reaction time the way a candle-close strategy condition does. Reuses the
-- same shared vault secret every other cron job in this project uses.
select cron.schedule(
  'agent-watch-scan',
  '*/5 * * * *',
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
