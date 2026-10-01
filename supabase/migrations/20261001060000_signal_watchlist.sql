-- Per-user "always show + prioritize notifications for these coins" signal
-- watchlist — the opposite complement to signal_muted_coins (which hides
-- unwanted coins): coins the user specifically wants to track. Shown with
-- their current score even when it's below the active threshold, and when
-- non-empty, narrows push notifications down to just these coins instead
-- of every coin that crosses the threshold.
alter table public.profiles
  add column signal_watchlist_coins text[] not null default '{}';

-- profiles uses column-level grants, not a table-wide UPDATE grant (see
-- 20260901020000_grant_profile_columns.sql) — signal_muted_coins was once
-- added without this step and every write to it silently failed with
-- "permission denied for table profiles" until a follow-up migration
-- granted it (20260925140000). Granting it here in the same migration
-- this time instead of repeating that mistake.
grant update (signal_watchlist_coins) on public.profiles to authenticated;
