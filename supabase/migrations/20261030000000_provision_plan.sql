-- ProVision: a standalone $99/yr plan that sits NEXT TO the Pro/Elite tier.
--
-- Access (enforced in the app, see src/hooks/useProVisionAccess.ts):
--   elite, or an active ProVision plan  → unlimited
--   free, within 3 days of starting the trial → unlimited
--   pro                                 → 3 coins per rolling 24h
--
-- These columns are written only by the service role (stripe-webhook,
-- revenuecat-webhook, sync-iap-entitlement) and by start_provision_trial()
-- below. Clients get no UPDATE grant on them, and the billing guard trigger
-- (next migration) stops a client insert/update from setting them.

alter table public.profiles
  add column if not exists provision_status            text,
  add column if not exists provision_end_at            timestamptz,
  add column if not exists provision_stripe_sub_id     text,
  add column if not exists provision_trial_started_at  timestamptz;

comment on column public.profiles.provision_status is
  'ProVision plan status (active / canceling / past_due / canceled …); null = never bought.';
comment on column public.profiles.provision_trial_started_at is
  'When the free 3-day ProVision trial was started; null = never started (one per account).';

-- Client inserts/updates can't set these: see the billing guard trigger in
-- 20261030010000_profiles_billing_lockdown.sql (covers tier too).

-- Start the free trial: once per account, free tier only. Returns the start
-- time (the existing one if it was already started), or null if not allowed.
create or replace function public.start_provision_trial()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  started timestamptz;
begin
  if auth.uid() is null then
    return null;
  end if;

  update public.profiles
     set provision_trial_started_at = now()
   where id = auth.uid()
     and provision_trial_started_at is null
     and coalesce(tier, 'free') = 'free'
  returning provision_trial_started_at into started;

  if started is null then
    select provision_trial_started_at into started
      from public.profiles
     where id = auth.uid();
  end if;

  return started;
end;
$$;

revoke all on function public.start_provision_trial() from public;
revoke all on function public.start_provision_trial() from anon;
grant execute on function public.start_provision_trial() to authenticated;
