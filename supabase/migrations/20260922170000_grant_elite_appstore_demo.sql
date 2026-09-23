-- One-time admin grant, not a schema change — appleaccount@example.com is
-- the demo account provided in App Store Connect's "App Review Information"
-- (sign-in credentials for reviewers). Elite so the reviewer can see every
-- gated feature (Candle AI, Alt Analysis, etc.) without hitting a paywall.
-- RAISEs so the row-match is visible in `supabase db push` output instead
-- of silently no-op'ing if the email doesn't actually match any account.
DO $$
DECLARE
  matched int;
BEGIN
  UPDATE public.profiles
  SET tier = 'elite'
  WHERE email = 'appleaccount@example.com';

  GET DIAGNOSTICS matched = ROW_COUNT;
  IF matched = 0 THEN
    RAISE WARNING 'No profiles row matched appleaccount@example.com — account may not exist yet.';
  ELSE
    RAISE NOTICE 'Granted elite tier to % profile row(s) for appleaccount@example.com', matched;
  END IF;
END $$;
