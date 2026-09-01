-- Per-coin comment feed. Free tier reads; Pro/Elite can post. username and
-- tier are stamped server-side from profiles at insert time (never trusted
-- from the client) so a comment's badge can't be forged, and so the public
-- feed never needs read access to the rest of a stranger's profile row —
-- profiles.username/tier get denormalized onto the comment itself instead.
create table if not exists public.coin_comments (
  id bigint generated always as identity primary key,
  coin text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text,
  tier text,
  body text not null check (char_length(trim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists coin_comments_coin_created_idx
  on public.coin_comments (coin, created_at desc);

create or replace function public.stamp_comment_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select p.username, p.tier into new.username, new.tier
  from public.profiles p where p.id = new.user_id;

  if new.username is null then
    raise exception 'Set a username before posting';
  end if;
  if new.tier not in ('pro', 'elite') then
    raise exception 'Only Pro and Elite members can post comments';
  end if;

  return new;
end;
$$;

drop trigger if exists stamp_comment_author_trigger on public.coin_comments;
create trigger stamp_comment_author_trigger
  before insert on public.coin_comments
  for each row execute function public.stamp_comment_author();

alter table public.coin_comments enable row level security;

create policy "authenticated users can read coin comments"
  on public.coin_comments for select
  to authenticated
  using (true);

-- with_check re-validates tier defensively even though the trigger already
-- enforces it — belt and suspenders on a public-write table.
create policy "pro and elite members can post coin comments"
  on public.coin_comments for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.tier in ('pro', 'elite'))
  );

create policy "users can delete their own coin comments"
  on public.coin_comments for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, delete on public.coin_comments to authenticated;
-- username/tier are stamped by the trigger, never written directly by the
-- client — no UPDATE grant needed at all, on this table or those columns.

-- Broadcasts INSERT/DELETE on this table over Realtime so an open chat
-- panel updates live without polling.
alter publication supabase_realtime add table public.coin_comments;

-- Reports just accumulate for manual review for now — no admin UI/workflow
-- yet, so no SELECT policy for regular users either.
create table if not exists public.comment_reports (
  id bigint generated always as identity primary key,
  comment_id bigint not null references public.coin_comments(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (comment_id, reporter_id)
);

alter table public.comment_reports enable row level security;

create policy "authenticated users can report a comment"
  on public.comment_reports for insert
  to authenticated
  with check (auth.uid() = reporter_id);

grant insert on public.comment_reports to authenticated;
