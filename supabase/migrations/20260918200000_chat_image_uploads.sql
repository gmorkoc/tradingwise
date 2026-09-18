-- Image attachments for coin chat — lets a poster attach a chart
-- screenshot for MarketPulse to analyze, same capability the old
-- standalone AI Chat panel had (removed in favor of folding it into the
-- bot). image_url stores the public Storage URL, same convention as
-- avatar_url (20260903010000_profile_avatar.sql).

alter table public.coin_comments add column if not exists image_url text;
-- No new grant needed — coin_comments already has a blanket
-- select/insert/delete grant to authenticated (20260901060000_coin_chat.sql),
-- and this is client-written like body, not stamped by a trigger.

-- One folder per user (not a flat per-user file like avatars) since a
-- user can post many chat images over time, not just replace a single
-- profile photo — each upload gets its own random filename within their
-- folder, never overwritten.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', true, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "chat images are publicly readable"
  on storage.objects for select
  using (bucket_id = 'chat-images');

create policy "users can upload chat images into their own folder"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'chat-images' and (storage.foldername(name))[1] = auth.uid()::text);
