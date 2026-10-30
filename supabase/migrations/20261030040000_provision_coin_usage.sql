-- ProVision for Pro: 3 coins per rolling 24h, counted on the SERVER so the
-- allowance is the same on every device and can't be reset by clearing
-- local storage. (Elite, ProVision-plan owners and free-trial users are
-- unlimited and are never recorded here.)
--
-- Clients can only READ their own rows. Rows are written only by
-- claim_provision_coin() below.

create table if not exists public.provision_coin_usage (
  user_id       uuid        not null references auth.users (id) on delete cascade,
  coin          text        not null,
  first_used_at timestamptz not null default now(),
  primary key (user_id, coin)
);

alter table public.provision_coin_usage enable row level security;

drop policy if exists "read own provision coin usage" on public.provision_coin_usage;
create policy "read own provision coin usage"
  on public.provision_coin_usage for select
  to authenticated
  using (user_id = auth.uid());

-- Explicit grants (Supabase no longer auto-grants new tables).
revoke all on table public.provision_coin_usage from anon, authenticated;
grant select on table public.provision_coin_usage to authenticated;
grant select, insert, update, delete on table public.provision_coin_usage to service_role;

-- Ask to run ProVision on a coin. Returns:
--   allowed      — may ProVision run on this coin now?
--   unlimited    — true for Elite / plan / trial (nothing recorded)
--   used         — Pro: coins used in the last 24h
--   next_free_at — Pro at the limit: when the oldest slot frees up
create or replace function public.claim_provision_coin(p_coin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  p          record;
  plan_ok    boolean;
  trial_ok   boolean;
  n_used     int;
  used_coins text[];
  next_free  timestamptz;
  coin_norm  text := upper(trim(coalesce(p_coin, '')));
  max_coins  constant int := 3;
begin
  if uid is null or coin_norm = '' or length(coin_norm) > 20 then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'used', '[]'::jsonb, 'next_free_at', null);
  end if;

  select tier, provision_status, provision_end_at, provision_trial_started_at
    into p
    from public.profiles
   where id = uid;

  plan_ok := p.provision_status is not null
         and p.provision_status not in ('canceled', 'incomplete_expired', 'unpaid')
         and (p.provision_end_at is null or p.provision_end_at > now());
  trial_ok := coalesce(p.tier, 'free') = 'free'
          and p.provision_trial_started_at is not null
          and p.provision_trial_started_at > now() - interval '3 days';

  if p.tier = 'elite' or plan_ok or trial_ok then
    return jsonb_build_object('allowed', true, 'unlimited', true, 'used', '[]'::jsonb, 'next_free_at', null);
  end if;

  if coalesce(p.tier, 'free') <> 'pro' then
    return jsonb_build_object('allowed', false, 'unlimited', false, 'used', '[]'::jsonb, 'next_free_at', null);
  end if;

  -- Pro: drop slots older than 24h, then claim this coin if there's room.
  delete from public.provision_coin_usage
   where user_id = uid and first_used_at <= now() - interval '24 hours';

  select count(*) into n_used from public.provision_coin_usage where user_id = uid;

  if not exists (select 1 from public.provision_coin_usage where user_id = uid and coin = coin_norm)
     and n_used < max_coins then
    insert into public.provision_coin_usage (user_id, coin) values (uid, coin_norm)
    on conflict do nothing;
  end if;

  select coalesce(array_agg(coin order by first_used_at), '{}'),
         min(first_used_at) + interval '24 hours'
    into used_coins, next_free
    from public.provision_coin_usage
   where user_id = uid;

  return jsonb_build_object(
    'allowed',      coin_norm = any(used_coins),
    'unlimited',    false,
    'used',         to_jsonb(used_coins),
    'next_free_at', case when array_length(used_coins, 1) >= max_coins then next_free else null end
  );
end;
$$;

revoke all on function public.claim_provision_coin(text) from public;
revoke all on function public.claim_provision_coin(text) from anon;
grant execute on function public.claim_provision_coin(text) to authenticated;
