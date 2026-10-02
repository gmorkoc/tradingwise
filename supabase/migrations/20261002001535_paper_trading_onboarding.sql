-- Trading Agent onboarding/consent: gates the chat UI until the user
-- accepts the "paper trading only, not financial advice" disclaimer and
-- answers a few preference questions. No grant needed — unlike profiles,
-- paper_portfolios already has a "for all" owner RLS policy from its own
-- migration, which already covers updates to these new columns.
alter table public.paper_portfolios
  add column if not exists consent_accepted_at timestamptz,
  add column if not exists typical_trade_usd numeric check (typical_trade_usd is null or typical_trade_usd > 0),
  add column if not exists preferred_styles text[] not null default '{}';
