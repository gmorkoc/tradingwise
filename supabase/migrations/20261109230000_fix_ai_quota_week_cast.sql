-- Fix: try_increment_ai_quota always errored.
--
-- profiles.ai_requests_week is a DATE, but the function wrote the text
-- parameter p_day_key straight into it. Postgres won't cast text to date
-- implicitly in an UPDATE, so every call failed ("column is of type date
-- but expression is of type text"). Since the 2026-10-30 lockdown made the
-- server the only counter, that turned every Pro/Elite AI request through
-- this function into a "weekly limit reached" refusal.
--
-- Same logic as before; only the week value is cast to date, and the
-- comparison is done on dates too. CREATE OR REPLACE keeps the existing
-- grants (service_role / postgres EXECUTE).
create or replace function public.try_increment_ai_quota(p_user_id uuid, p_day_key text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_used    int;
  v_week    date;
  v_current int;
begin
  -- Lock this row so concurrent requests queue up instead of racing
  select ai_requests_used, ai_requests_week
  into   v_used, v_week
  from   public.profiles
  where  id = p_user_id
  for    update;

  if not found then return false; end if;

  v_current := case when v_week = p_day_key::date
                    then coalesce(v_used, 0)
                    else 0 end;

  if v_current >= p_limit then return false; end if;

  update public.profiles
  set    ai_requests_used = v_current + 1,
         ai_requests_week = p_day_key::date
  where  id = p_user_id;

  return true;
end;
$function$;
