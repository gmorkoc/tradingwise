-- Misc security hardening (from the 2026-10-30 audit).

-- 1. coin_comments: clients insert their own comments, and the table-wide
--    insert grant let them set like_count too (fake like counts). New
--    comments always start at 0; the likes triggers maintain it after that.
--    Kept separate from stamp_comment_author so that function isn't
--    redefined here.
create or replace function public.coin_comments_reset_like_count()
returns trigger
language plpgsql
as $$
begin
  new.like_count := 0;
  return new;
end;
$$;

drop trigger if exists coin_comments_reset_like_count on public.coin_comments;
create trigger coin_comments_reset_like_count
  before insert on public.coin_comments
  for each row execute function public.coin_comments_reset_like_count();

-- 2. handle_new_user is SECURITY DEFINER without a fixed search_path —
--    pin it so it can't be steered to a lookalike table/function.
alter function public.handle_new_user() set search_path = public;
