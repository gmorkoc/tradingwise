-- Which tier (if any) the user's current Apple subscription gives them.
--
-- Lets the RevenueCat webhook tell an Apple plan apart from a web (Stripe)
-- or admin-granted one, so Apple events can lower or remove a tier only
-- when Apple is where that tier came from:
--   • Elite → Pro downgrade through Apple, applied at the renewal
--   • refunds and expiries drop to free only an Apple-backed tier
--   • a purchase moved to another account (TRANSFER) leaves the old one
-- Written only by the server (service role); clients have no column grant.
alter table public.profiles add column if not exists apple_tier text;

comment on column public.profiles.apple_tier is
  'Tier granted by the current Apple (RevenueCat) subscription: pro | elite | null. Server-written.';
