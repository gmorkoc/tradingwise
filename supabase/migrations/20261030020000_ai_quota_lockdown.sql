-- AI cost / quota lockdown.
--
-- 1. try_increment_ai_quota took any p_user_id + p_limit and was executable
--    by anon/authenticated, so anyone could burn another user's quota (or
--    pass a huge limit). It's now service-role only — called by api/openai.ts
--    and the AI edge functions (_shared/aiLimits.ts) on the user's behalf.
-- 2. Clients could UPDATE their own ai_requests_used / ai_requests_week and
--    reset their quota. Those grants are revoked; only the server counts.
-- 3. New try_ai_rate_limit (+ table) for per-user, per-feature rate limits
--    on the free / Elite-unlimited AI endpoints. Service role only.
-- 4. agent_watches: each active watch costs an AI call every minute, and
--    clients could insert unlimited rows. Inserts/activations now require
--    Elite, at most 10 active watches per user, and a short condition.

-- ── 1. Quota RPC: service role only ───────────────────────────────────────
revoke execute on function public.try_increment_ai_quota(uuid, text, integer) from public;
revoke execute on function public.try_increment_ai_quota(uuid, text, integer) from anon;
revoke execute on function public.try_increment_ai_quota(uuid, text, integer) from authenticated;
grant  execute on function public.try_increment_ai_quota(uuid, text, integer) to service_role;

-- ── 2. No client writes to the AI counters ───────────────────────────────
-- HELD BACK: older app builds still write ai_requests_used directly, so the
-- column revoke lives in supabase/pending/ai_quota_client_revoke.sql and is
-- applied once the new app build (server-side counting) is in users' hands.

-- ── 3. Per-user rate limits ──────────────────────────────────────────────
create table if not exists public.ai_rate_limits (
  user_id       uuid        not null references auth.users(id) on delete cascade,
  bucket        text        not null,
  window_start  timestamptz not null,
  count         integer     not null default 0,
  primary key (user_id, bucket)
);

-- Server-only table: RLS on with no policies (deny-all for clients) and no
-- client grants; explicit grant for the service role.
alter table public.ai_rate_limits enable row level security;
revoke all on table public.ai_rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.ai_rate_limits to service_role;

-- true = allowed (and counted); false = over p_max in the current window.
create or replace function public.try_ai_rate_limit(
  p_user_id uuid,
  p_bucket text,
  p_window_seconds integer,
  p_max integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_count integer;
begin
  insert into public.ai_rate_limits (user_id, bucket, window_start, count)
  values (p_user_id, p_bucket, now(), 0)
  on conflict (user_id, bucket) do nothing;

  select window_start, count into v_start, v_count
    from public.ai_rate_limits
   where user_id = p_user_id and bucket = p_bucket
   for update;

  if v_start < now() - make_interval(secs => p_window_seconds) then
    v_start := now();
    v_count := 0;
  end if;

  if v_count >= p_max then
    return false;
  end if;

  update public.ai_rate_limits
     set window_start = v_start, count = v_count + 1
   where user_id = p_user_id and bucket = p_bucket;

  return true;
end;
$$;

revoke execute on function public.try_ai_rate_limit(uuid, text, integer, integer) from public;
revoke execute on function public.try_ai_rate_limit(uuid, text, integer, integer) from anon;
revoke execute on function public.try_ai_rate_limit(uuid, text, integer, integer) from authenticated;
grant  execute on function public.try_ai_rate_limit(uuid, text, integer, integer) to service_role;

-- ── 4. agent_watches limits ──────────────────────────────────────────────
create or replace function public.agent_watches_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active integer;
begin
  -- Server writers (agent-watch-scan, service role) are not limited.
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  -- Only check when a watch is created or switched (back) on.
  if tg_op = 'UPDATE' and not (new.active and not old.active) then
    return new;
  end if;
  if not new.active then
    return new;
  end if;

  if not exists (select 1 from public.profiles where id = new.user_id and tier = 'elite') then
    raise exception 'Watches are part of Agent Ready (Elite).' using errcode = '42501';
  end if;

  if char_length(coalesce(new.condition_text, '')) > 500 then
    raise exception 'That watch condition is too long.' using errcode = '22001';
  end if;

  select count(*) into v_active
    from public.agent_watches
   where user_id = new.user_id and active and id <> new.id;
  if v_active >= 10 then
    raise exception 'You already have 10 active watches. Cancel one to add another.' using errcode = '54000';
  end if;

  return new;
end;
$$;

drop trigger if exists agent_watches_guard on public.agent_watches;
create trigger agent_watches_guard
  before insert or update on public.agent_watches
  for each row execute function public.agent_watches_guard();
