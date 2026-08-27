-- Runs btc-price-alert-push every minute so a >= $50 BTC move triggers a
-- push even when no client has a tab open to poll from (mirrors the
-- in-app useBtcMoveAlert.ts toast, which only runs while the app is open).
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Shared secret the edge function checks (verify_jwt is off for it — its
-- only legitimate caller is this cron job, not a signed-in client) instead
-- of embedding a real credential in this git-tracked file.
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'btc_price_alert_cron_secret',
  'Shared secret pg_cron sends to the btc-price-alert-push edge function'
)
where not exists (
  select 1 from vault.secrets where name = 'btc_price_alert_cron_secret'
);

select cron.schedule(
  'btc-price-alert-push',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://odkutrsfiqlydqpudpli.supabase.co/functions/v1/btc-price-alert-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'btc_price_alert_cron_secret' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
