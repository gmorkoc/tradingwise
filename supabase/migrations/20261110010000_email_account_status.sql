-- Live "is this email already registered?" check for the sign-up form, so a
-- person typing an email that already has an account (password or Google /
-- Apple sign-in) is told right away instead of submitting and waiting for a
-- verification code Supabase never sends for existing accounts.
--
-- Returns ONLY a status word, never row data:
--   'available' — no account with this email
--   'password'  — an account that signs in with email + password
--   'google' / 'apple' / … — an account that signs in only with that provider
--                            (comma-separated if several)
--   'invalid'   — not an email
--
-- Same trade-off as is_username_available: it reveals whether an email has an
-- account, which the sign-up flow reveals anyway ("already registered").

create or replace function public.email_account_status(check_email text)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  with e as (select lower(trim(coalesce(check_email, ''))) as v),
  ids as (
    select i.provider
      from auth.users u
      join auth.identities i on i.user_id = u.id, e
     where lower(u.email) = e.v
  )
  select case
    when (select v from e) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then 'invalid'
    when not exists (select 1 from auth.users u, e where lower(u.email) = e.v) then 'available'
    when exists (select 1 from ids where provider = 'email') then 'password'
    else coalesce((select string_agg(distinct provider, ',') from ids), 'password')
  end;
$$;

-- Explicit grants (Supabase no longer auto-grants).
revoke all on function public.email_account_status(text) from public;
grant execute on function public.email_account_status(text) to anon, authenticated;
