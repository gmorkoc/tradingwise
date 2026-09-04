-- Web Push equivalent of device_push_tokens — one row per browser
-- subscription (endpoint + the two keys the browser hands back from
-- PushManager.subscribe()). Keyed by endpoint (not user_id), same reasoning
-- as device_push_tokens: re-subscribing the same browser just moves the row.
create table if not exists public.web_push_subscriptions (
  endpoint    text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  updated_at  timestamptz not null default now()
);

create index if not exists web_push_subscriptions_user_id_idx
  on public.web_push_subscriptions (user_id);

alter table public.web_push_subscriptions enable row level security;

create policy "Users manage their own web push subscriptions"
  on public.web_push_subscriptions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
