-- Blocking on top of coin_comments (see comment_reports in coin_chat.sql
-- for the reporting half) — Apple's Guideline 1.2/2.1 requires both a
-- report AND a block mechanism for apps with user-generated content.
-- Same shape as coin_comment_likes: a per-user join table, RLS scoped so
-- everyone can only ever see/manage their own rows, never anyone else's.
-- blocked_username is denormalized at block time (same reasoning as
-- coin_comments' own username/tier columns — see coin_chat.sql) rather
-- than joined from profiles, since profiles' own RLS ("Users can view own
-- profile") only lets a user read their own row, not a blocked user's.
create table if not exists public.blocked_users (
  id bigint generated always as identity primary key,
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  blocked_username text not null,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists blocked_users_blocker_idx on public.blocked_users (blocker_id);

alter table public.blocked_users enable row level security;

drop policy if exists "users can see their own blocks" on public.blocked_users;
create policy "users can see their own blocks"
  on public.blocked_users for select
  to authenticated
  using (auth.uid() = blocker_id);

drop policy if exists "authenticated users can block another user" on public.blocked_users;
create policy "authenticated users can block another user"
  on public.blocked_users for insert
  to authenticated
  with check (auth.uid() = blocker_id);

drop policy if exists "users can remove their own block" on public.blocked_users;
create policy "users can remove their own block"
  on public.blocked_users for delete
  to authenticated
  using (auth.uid() = blocker_id);

grant select, insert, delete on public.blocked_users to authenticated;
