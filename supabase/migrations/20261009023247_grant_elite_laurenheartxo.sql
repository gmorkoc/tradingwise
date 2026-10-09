-- One-time admin grant, not a schema change — requested directly by the
-- app owner for this specific account. RAISEs so the row-match is visible
-- in `supabase db push` output instead of silently no-op'ing if the email
-- doesn't actually match any account.
DO $$
DECLARE
  matched int;
BEGIN
  UPDATE public.profiles
  SET tier = 'elite'
  WHERE email = 'laurenheartxo@icloud.com';

  GET DIAGNOSTICS matched = ROW_COUNT;
  IF matched = 0 THEN
    RAISE WARNING 'No profiles row matched laurenheartxo@icloud.com — account may not exist yet.';
  ELSE
    RAISE NOTICE 'Granted elite tier to % profile row(s) for laurenheartxo@icloud.com', matched;
  END IF;
END $$;
