-- Username, mandatory at signup, checked for availability in real time.
-- Nullable at the column level only because existing accounts predate
-- this and can't retroactively be assigned one automatically.
alter table public.profiles
  add column if not exists username text,
  add constraint username_format check (username is null or username ~ '^[A-Za-z0-9_]{3,20}$');

-- Case-insensitive uniqueness — "Alice" and "alice" are the same handle.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username))
  where username is not null;

-- Column-level grant, not just RLS — see the account_events / notify_*
-- lesson from this same session: profiles uses per-column grants, and a
-- newly added column doesn't inherit them automatically.
grant update (username) on public.profiles to authenticated;

-- Realtime availability check needs to work for a user who isn't signed
-- in yet (mid-signup), so it can't be a normal RLS-gated select — a
-- SECURITY DEFINER function that returns only a boolean, never row data,
-- keeps the rest of the table's columns (email, tier, etc.) unexposed.
create or replace function public.is_username_available(check_username text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.profiles where lower(username) = lower(check_username)
  );
$$;

grant execute on function public.is_username_available(text) to anon, authenticated;
