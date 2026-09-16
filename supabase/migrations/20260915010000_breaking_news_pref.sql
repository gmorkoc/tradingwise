-- Separate opt-out for the new "breaking news" urgent push tier (see
-- daily-brief-push's classifyImportant()) — distinct from notify_daily_brief
-- since it's a different intent (rare/urgent vs. routine digest).
alter table public.profiles
  add column if not exists notify_breaking_news boolean not null default true;

-- profiles uses column-level grants, not a table-wide UPDATE grant — see
-- 20260901020000_grant_profile_columns.sql's own comment for why this step
-- can't be skipped (a plain ALTER TABLE ADD COLUMN alone leaves the column
-- unwritable by authenticated clients, silently).
grant update (notify_breaking_news) on public.profiles to authenticated;
