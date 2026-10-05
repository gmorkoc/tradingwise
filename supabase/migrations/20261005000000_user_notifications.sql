-- Unified per-user notification history — one row per push actually sent
-- (buy/sell signals, price alerts, strategy alerts, coin mentions, daily
-- brief/breaking news, trading agent watches/position closes, upgrade
-- reminders), so the app's Notifications tab can show a real feed instead
-- of only ever reacting to a live push. `data` carries the same tap
-- payload already sent in the push itself (see supabase/functions/_shared/
-- notificationLog.ts and src/utils/notificationRouting.ts) so tapping a
-- row in the feed routes exactly like tapping the original push did.
create table if not exists public.user_notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text not null,
  data       jsonb not null default '{}'::jsonb,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_user_recent_idx
  on public.user_notifications (user_id, created_at desc);

alter table public.user_notifications enable row level security;

-- Read-only for users, same shape as strategy_fires — only the cron jobs
-- (service role, via _shared/notificationLog.ts) ever insert rows. Users
-- can flip `read` on their own rows (tapping/opening a notification).
drop policy if exists "Users view their own notifications" on public.user_notifications;
create policy "Users view their own notifications"
  on public.user_notifications
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users mark their own notifications read" on public.user_notifications;
create policy "Users mark their own notifications read"
  on public.user_notifications
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
