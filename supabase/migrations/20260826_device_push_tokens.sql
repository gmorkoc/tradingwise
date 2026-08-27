-- Stores one row per device FCM token so we can target push notifications
-- at a user's devices. Keyed by token (not user_id) since the same device
-- can only ever be one row — re-registering just moves it to the current user.
create table if not exists public.device_push_tokens (
  token       text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  platform    text not null default 'ios',
  updated_at  timestamptz not null default now()
);

create index if not exists device_push_tokens_user_id_idx
  on public.device_push_tokens (user_id);

alter table public.device_push_tokens enable row level security;

create policy "Users manage their own push tokens"
  on public.device_push_tokens
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
