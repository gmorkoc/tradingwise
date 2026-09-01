-- Per-category push notification opt-outs, shown in Profile → Notifications.
-- Alert sound already existed (alert_sound, added earlier) — these three
-- gate whether a category sends at all, checked server-side by
-- daily-brief-push, btc-price-alert-push, and upgrade-reminder-push.
alter table public.profiles
  add column if not exists notify_daily_brief       boolean not null default true,
  add column if not exists notify_price_alerts      boolean not null default true,
  add column if not exists notify_upgrade_reminders boolean not null default true;
