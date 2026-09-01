-- Account activity timeline shown in the Profile → Activity tab. Written
-- only by edge functions (service role key, bypasses RLS) on subscription
-- lifecycle transitions; "account created" itself is derived client-side
-- from auth.users.created_at instead of a row here, so it shows up for
-- every existing account with no backfill needed.
create table if not exists public.account_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists account_events_user_id_created_at_idx
  on public.account_events (user_id, created_at desc);

alter table public.account_events enable row level security;

create policy "Users can view their own account events"
  on public.account_events for select
  using (auth.uid() = user_id);
