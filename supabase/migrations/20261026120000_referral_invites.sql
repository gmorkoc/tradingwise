-- Invite-a-friend reward: every invite sent (send-invite edge function)
-- is logged here; when someone signs up with an email that was invited,
-- the inviter gets +$10,000 paper cash (and an in-app notification).
-- One reward per new account (earliest inviter wins), capped at 20
-- rewarded invites per inviter.

create table if not exists public.referral_invites (
  id            uuid primary key default gen_random_uuid(),
  inviter_id    uuid not null references auth.users(id) on delete cascade,
  invitee_email text not null,
  created_at    timestamptz not null default now(),
  invitee_id    uuid references auth.users(id) on delete set null,
  rewarded_at   timestamptz,
  unique (inviter_id, invitee_email)
);

create index if not exists referral_invites_email_idx
  on public.referral_invites (lower(invitee_email))
  where rewarded_at is null;

alter table public.referral_invites enable row level security;

-- Inviters can see their own invites (and which ones paid out). Inserts
-- only happen from send-invite (service role).
drop policy if exists "Users view their own invites" on public.referral_invites;
create policy "Users view their own invites"
  on public.referral_invites
  for select
  using (auth.uid() = inviter_id);

-- Supabase no longer auto-grants Data API access to new tables.
grant select on public.referral_invites to authenticated;
grant all on public.referral_invites to service_role;

-- Reward on signup.
create or replace function public.reward_referral_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  rewarded_count int;
begin
  if new.email is null then
    return new;
  end if;

  select * into inv
  from public.referral_invites
  where lower(invitee_email) = lower(new.email)
    and rewarded_at is null
    and inviter_id <> new.id
  order by created_at asc
  limit 1;

  if inv is null then
    return new;
  end if;

  select count(*) into rewarded_count
  from public.referral_invites
  where inviter_id = inv.inviter_id and rewarded_at is not null;

  if rewarded_count >= 20 then
    update public.referral_invites
      set invitee_id = new.id
      where id = inv.id;
    return new;
  end if;

  -- +$10,000 paper cash (creates the portfolio at the normal $100,000
  -- start + the reward if the inviter hasn't opened paper trading yet).
  insert into public.paper_portfolios (user_id, cash_balance)
  values (inv.inviter_id, 110000)
  on conflict (user_id) do update
    set cash_balance = public.paper_portfolios.cash_balance + 10000,
        updated_at = now();

  update public.referral_invites
    set invitee_id = new.id, rewarded_at = now()
    where id = inv.id;

  -- Any other inviters of this same email don't get paid again.
  update public.referral_invites
    set invitee_id = new.id
    where lower(invitee_email) = lower(new.email)
      and rewarded_at is null
      and id <> inv.id;

  insert into public.user_notifications (user_id, type, title, body, data)
  values (
    inv.inviter_id,
    'referral_reward',
    'Your friend joined CoinHintz 🎉',
    'You just got $10,000 in free paper trading cash for inviting them.',
    jsonb_build_object('type', 'referral_reward')
  );

  return new;
exception when others then
  -- Never block a signup because of the reward.
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_referral on auth.users;
create trigger on_auth_user_created_referral
  after insert on auth.users
  for each row execute function public.reward_referral_on_signup();
