-- Changing your avatar previously only showed up on comments posted
-- afterward (avatar_url is denormalized onto coin_comments at post time,
-- same as username/tier). Now also backfills every one of the user's own
-- past comments, so an updated photo shows up everywhere immediately —
-- SECURITY DEFINER + scoped to auth.uid() so this doesn't need (and
-- doesn't grant) a general client-side UPDATE on coin_comments.
create or replace function public.update_my_comment_avatars(new_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.coin_comments
  set avatar_url = new_avatar_url
  where user_id = auth.uid();
end;
$$;

grant execute on function public.update_my_comment_avatars(text) to authenticated;
