-- Tracks the most recent article pubDate the daily-brief-push cron has
-- already pushed a notification for, so it only fires on genuinely new
-- stories rather than re-pushing the whole feed every run.
create table if not exists public.daily_brief_alert_state (
  id                int primary key default 1,
  last_seen_pubdate bigint,
  updated_at        timestamptz not null default now(),
  constraint daily_brief_alert_state_single_row check (id = 1)
);

insert into public.daily_brief_alert_state (id, last_seen_pubdate)
values (1, null)
on conflict (id) do nothing;
