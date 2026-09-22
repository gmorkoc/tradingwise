-- handle_new_user() (20260101000000_baseline_schema.sql) copies full_name
-- and email from auth.users.raw_user_meta_data into the new profiles row,
-- but never copied username — the signup form collects one and passes it
-- as signup metadata (AuthContext.tsx's signUp), but this trigger fires
-- before the client ever sees the row, so every new signup landed with
-- username = null regardless, and UsernameGateModal re-asked for one that
-- had already been entered.
CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.profiles (id, full_name, email, username)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.email,
    new.raw_user_meta_data->>'username'
  );
  return new;
end;
$$;
