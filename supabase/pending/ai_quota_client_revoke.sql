-- HELD: apply once the app build with server-side AI counting (build 57+ /
-- the matching web deploy) is what users are running. Older builds write
-- ai_requests_used directly; after this their AI features stop working.
--
-- To apply: move this file into supabase/migrations/ with a new timestamp
-- name (e.g. 20261105000000_ai_quota_client_revoke.sql) and `supabase db push`.

revoke update (ai_requests_used, ai_requests_week) on public.profiles from authenticated;
revoke update (ai_requests_used, ai_requests_week) on public.profiles from anon;
