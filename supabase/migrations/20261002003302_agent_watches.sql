-- "Notify me when ready to buy" support: a standing watch the agent
-- creates on request, evaluated periodically by agent-watch-scan (cron)
-- and pushed to the user when its condition is met. One-shot — triggering
-- deactivates it rather than repeating.
create table if not exists public.agent_watches (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  conversation_id  uuid not null,
  coin             text not null,
  condition_text   text not null,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  last_checked_at  timestamptz,
  triggered_at     timestamptz
);

create index if not exists agent_watches_active_idx
  on public.agent_watches (id) where active;

alter table public.agent_watches enable row level security;

drop policy if exists "Users manage their own agent watches" on public.agent_watches;
create policy "Users manage their own agent watches"
  on public.agent_watches
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Lets a chat bubble reference the watch it created, so the UI can render
-- a "👁 Watching BTC — ..." chip with a cancel button, same idea as the
-- existing action/action_status columns for trade proposals.
alter table public.agent_messages add column if not exists watch_id uuid references public.agent_watches(id) on delete set null;
