-- Lock billing / entitlement columns on profiles to the server.
--
-- Problem: authenticated users have table-level INSERT on profiles (the app
-- lazily creates a missing row in fetchProfile), so a client could create
-- its own row with tier = 'elite', a fake stripe_customer_id or an active
-- subscription. UPDATE is column-granted and excludes these today, but a
-- future grant mistake would reopen it. anon also had GRANT ALL.
--
-- Fix: a guard trigger that, for client roles (anon / authenticated),
--   • on INSERT forces every billing column to its free default, and
--   • on UPDATE keeps every billing column at its old value.
-- Server writers are unaffected: edge functions use service_role, and
-- SECURITY DEFINER functions (handle_new_user, start_provision_trial) run
-- as their owner, so current_user is not a client role there.

create or replace function public.profiles_guard_billing()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.tier                       := 'free';
    new.stripe_customer_id         := null;
    new.subscription_status        := 'none';
    new.subscription_end_at        := null;
    new.provision_status           := null;
    new.provision_end_at           := null;
    new.provision_stripe_sub_id    := null;
    new.provision_trial_started_at := null;
  else
    new.tier                       := old.tier;
    new.stripe_customer_id         := old.stripe_customer_id;
    new.subscription_status        := old.subscription_status;
    new.subscription_end_at        := old.subscription_end_at;
    new.provision_status           := old.provision_status;
    new.provision_end_at           := old.provision_end_at;
    new.provision_stripe_sub_id    := old.provision_stripe_sub_id;
    new.provision_trial_started_at := old.provision_trial_started_at;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_billing on public.profiles;
create trigger profiles_guard_billing
  before insert or update on public.profiles
  for each row execute function public.profiles_guard_billing();

-- Signed-out visitors have no business touching profiles at all.
revoke all on table public.profiles from anon;

-- Belt and braces: no client UPDATE on billing columns even if a later
-- migration grants table-wide UPDATE by mistake (column revokes are no-ops
-- when not granted).
revoke update (tier, stripe_customer_id, subscription_status, subscription_end_at,
               provision_status, provision_end_at, provision_stripe_sub_id,
               provision_trial_started_at)
  on public.profiles from authenticated;
