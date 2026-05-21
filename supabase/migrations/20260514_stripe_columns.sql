-- Add Stripe + subscription columns to profiles if they don't exist
alter table public.profiles
  add column if not exists tier                 text    not null default 'free',
  add column if not exists stripe_customer_id   text    unique,
  add column if not exists subscription_status  text,
  add column if not exists subscription_end_at  timestamptz;

-- Index for webhook lookups by stripe_customer_id
create index if not exists profiles_stripe_customer_id_idx
  on public.profiles (stripe_customer_id);
