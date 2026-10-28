-- AI-built chart indicators ("Build with AI" in the Indicators picker).
-- Each row is one saved indicator: the user's prompt and the JSON recipe
-- the AI returned (building blocks only — never code; the app validates
-- it before drawing). Synced so a user's indicators follow them across
-- devices; the app keeps a local cache for instant loads.

create table if not exists public.custom_indicators (
  id          text primary key,            -- client id, e.g. "ai-lx3k9f"
  user_id     uuid not null references auth.users(id) on delete cascade,
  prompt      text not null default '',
  recipe      jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists custom_indicators_user_idx
  on public.custom_indicators (user_id, created_at);

alter table public.custom_indicators enable row level security;

drop policy if exists "Users read their own indicators" on public.custom_indicators;
create policy "Users read their own indicators"
  on public.custom_indicators for select
  using (auth.uid() = user_id);

drop policy if exists "Users add their own indicators" on public.custom_indicators;
create policy "Users add their own indicators"
  on public.custom_indicators for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update their own indicators" on public.custom_indicators;
create policy "Users update their own indicators"
  on public.custom_indicators for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users delete their own indicators" on public.custom_indicators;
create policy "Users delete their own indicators"
  on public.custom_indicators for delete
  using (auth.uid() = user_id);

-- Supabase no longer auto-grants Data API access to new tables.
grant select, insert, update, delete on public.custom_indicators to authenticated;
grant all on public.custom_indicators to service_role;
