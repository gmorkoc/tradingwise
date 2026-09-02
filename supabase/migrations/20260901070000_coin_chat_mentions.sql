-- @mentions in coin chat: autocomplete search, server-side resolution of
-- @username -> user_id (never trusted from the client, same reasoning as
-- stamp_comment_author), and a queue of pending notifications a client-
-- invoked edge function drains to actually send the push.

-- Column-level grant, not just RLS — profiles uses per-column grants (see
-- the account_events / notify_* lesson from this same session).
alter table public.profiles
  add column if not exists notify_mentions boolean not null default true;

grant update (notify_mentions) on public.profiles to authenticated;

-- Composer autocomplete. Same shape of problem as is_username_available:
-- needs to work without exposing any other profile column, so a
-- SECURITY DEFINER function returning bare usernames only.
create or replace function public.search_usernames(prefix text, limit_n int default 6)
returns table (username text)
language sql
security definer
set search_path = public
as $$
  select p.username
  from public.profiles p
  where p.username is not null
    and p.username ilike prefix || '%'
  order by p.username
  limit greatest(1, least(limit_n, 20));
$$;

grant execute on function public.search_usernames(text, int) to authenticated;

-- One row per (comment, mentioned user) — a queue the notify-mention edge
-- function drains right after the client posts a comment, same
-- client-invoked-right-after-the-action pattern as sync-iap-entitlement,
-- not a cron poll (there's no reason to delay a mention notification).
create table if not exists public.mention_notifications (
  id bigint generated always as identity primary key,
  comment_id bigint not null references public.coin_comments(id) on delete cascade,
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  mentioning_user_id uuid not null references auth.users(id) on delete cascade,
  coin text not null,
  created_at timestamptz not null default now(),
  sent boolean not null default false
);

create index if not exists mention_notifications_pending_idx
  on public.mention_notifications (comment_id) where sent = false;

alter table public.mention_notifications enable row level security;

-- No insert/update policy for authenticated at all — only the trigger
-- (SECURITY DEFINER) and the edge function (service role) ever write here.
create policy "users can see their own mentions"
  on public.mention_notifications for select
  to authenticated
  using (auth.uid() = mentioned_user_id);

grant select on public.mention_notifications to authenticated;

create or replace function public.queue_comment_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  handle text;
begin
  for handle in
    select distinct m[1]
    from regexp_matches(new.body, '@([A-Za-z0-9_]{3,20})', 'g') as m
  loop
    insert into public.mention_notifications (comment_id, mentioned_user_id, mentioning_user_id, coin)
    select new.id, p.id, new.user_id, new.coin
    from public.profiles p
    where lower(p.username) = lower(handle)
      and p.id != new.user_id;
  end loop;

  return new;
end;
$$;

drop trigger if exists queue_comment_mentions_trigger on public.coin_comments;
create trigger queue_comment_mentions_trigger
  after insert on public.coin_comments
  for each row execute function public.queue_comment_mentions();
