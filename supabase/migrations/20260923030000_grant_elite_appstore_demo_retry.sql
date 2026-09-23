-- Retry of 20260922170000_grant_elite_appstore_demo.sql — that one matched
-- 0 rows because appleaccount@example.com didn't actually exist yet (it
-- was only ever declared in App Review Information, never signed up).
-- Discovered when the account failed to sign in on web with "No account
-- found" — now created with the exact credentials on file, so this grant
-- can actually take effect.
DO $$
DECLARE
  matched int;
BEGIN
  UPDATE public.profiles SET tier = 'elite' WHERE email = 'appleaccount@example.com';
  GET DIAGNOSTICS matched = ROW_COUNT;
  RAISE NOTICE 'appleaccount@example.com elite grant matched % row(s)', matched;
END $$;
