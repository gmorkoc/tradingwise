-- This table uses column-level grants (not a blanket table-wide UPDATE
-- grant), so every column added via plain ALTER TABLE ... ADD COLUMN in
-- earlier migrations (20260827030000, 20260901010000) never actually
-- became writable by authenticated users — RLS permitted the row, but the
-- underlying column privilege never existed, so every update to these four
-- columns from a signed-in client has been silently failing with
-- "permission denied for table profiles" this whole time (Supabase's JS
-- client doesn't surface that as a thrown error by default, which is why
-- it looked like the UI just wasn't saving rather than an explicit error).
grant update (alert_sound, notify_daily_brief, notify_price_alerts, notify_upgrade_reminders)
  on public.profiles to authenticated;
