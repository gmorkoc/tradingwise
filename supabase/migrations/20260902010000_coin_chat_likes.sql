-- Likes on coin_comments. Unlike posting (pro/elite only), liking is open
-- to any authenticated user, including free tier — a lighter-weight
-- engagement action, not "posting."
create table if not exists public.coin_comment_likes (
  id bigint generated always as identity primary key,
  comment_id bigint not null references public.coin_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);

create index if not exists coin_comment_likes_comment_idx on public.coin_comment_likes (comment_id);
create index if not exists coin_comment_likes_user_idx on public.coin_comment_likes (user_id);

alter table public.coin_comment_likes enable row level security;

create policy "users can see their own likes"
  on public.coin_comment_likes for select
  to authenticated
  using (auth.uid() = user_id);

create policy "authenticated users can like a comment"
  on public.coin_comment_likes for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users can remove their own like"
  on public.coin_comment_likes for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, delete on public.coin_comment_likes to authenticated;

-- Denormalized count on the comment itself so the feed query (fetchCoinComments)
-- doesn't need a join/group-by — kept in sync by the trigger below. The
-- client has no UPDATE grant on coin_comments at all (see coin_chat.sql),
-- so this column can only ever move through this trigger.
alter table public.coin_comments
  add column if not exists like_count integer not null default 0;

create or replace function public.adjust_comment_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.coin_comments set like_count = like_count + 1 where id = new.comment_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.coin_comments set like_count = greatest(0, like_count - 1) where id = old.comment_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists adjust_comment_like_count_trigger on public.coin_comment_likes;
create trigger adjust_comment_like_count_trigger
  after insert or delete on public.coin_comment_likes
  for each row execute function public.adjust_comment_like_count();
