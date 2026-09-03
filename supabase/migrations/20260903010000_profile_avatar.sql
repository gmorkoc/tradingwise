-- Profile avatar images. profiles.avatar_url stores the public Storage
-- URL; coin_comments.avatar_url is denormalized onto each comment at post
-- time by stamp_comment_author() (same convention already used for
-- username/tier — a comment shows the poster's avatar as of when they
-- posted, not a live join against profiles).

alter table public.profiles add column if not exists avatar_url text;

-- profiles uses column-level grants, not a blanket table UPDATE grant —
-- see 20260901020000_grant_profile_columns.sql. Every new updatable
-- column needs its own grant or client updates silently no-op.
grant update (avatar_url) on public.profiles to authenticated;

alter table public.coin_comments add column if not exists avatar_url text;
-- No new grant needed — coin_comments already has a blanket
-- select/insert/delete grant to authenticated (20260901060000_coin_chat.sql),
-- and avatar_url is stamped by the trigger below, never written directly
-- by the client, same as username/tier.

create or replace function public.stamp_comment_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select p.username, p.tier, p.avatar_url into new.username, new.tier, new.avatar_url
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

-- Avatar image storage. One object per user at a flat path equal to their
-- own uid (no extension — contentType is stored as object metadata, so
-- Storage serves the right Content-Type regardless), overwritten via
-- upsert on every re-upload rather than accumulating old files.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "avatar images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "users can upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and name = auth.uid()::text);

create policy "users can replace their own avatar"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and name = auth.uid()::text)
  with check (bucket_id = 'avatars' and name = auth.uid()::text);
