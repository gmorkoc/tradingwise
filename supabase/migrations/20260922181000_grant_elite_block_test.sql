-- Throwaway verification account for the block-user feature — same
-- reasoning as the App Store demo grant, just for a local test signup.
-- Safe to leave; it's a normal test account, not a real user's data.
DO $$
DECLARE
  matched int;
BEGIN
  UPDATE public.profiles SET tier = 'elite' WHERE email = 'blocktest_verify@example.com';
  GET DIAGNOSTICS matched = ROW_COUNT;
  RAISE NOTICE 'blocktest_verify grant matched % row(s)', matched;
END $$;
