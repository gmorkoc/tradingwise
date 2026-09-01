-- Every other table referencing auth.users(id) cascades on account
-- deletion (profiles, device_push_tokens, price_alerts, account_events) —
-- this one didn't, so deleting the account of anyone who'd ever submitted
-- the contact form would hit a foreign key violation and fail with a
-- generic 500 from api/deleteAccount.ts's admin user-delete call.
alter table public.contact_submissions
  drop constraint contact_submissions_user_id_fkey,
  add constraint contact_submissions_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;
