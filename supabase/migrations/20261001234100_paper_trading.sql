-- AI Paper-Trading Agent (v1): simulated portfolio + trades, no real money,
-- no exchange connection. See coinhintz plan "splendid-chasing-spring" for
-- the full design. Four tables, all user-owned (client writes directly —
-- v1 has no cron/autonomous execution, so there's no service-role writer
-- yet, unlike strategy_alerts/strategy_fires).

create table if not exists public.paper_portfolios (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  cash_balance numeric not null default 100000 check (cash_balance >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.paper_portfolios enable row level security;

drop policy if exists "Users manage their own paper portfolio" on public.paper_portfolios;
create policy "Users manage their own paper portfolio"
  on public.paper_portfolios
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.paper_positions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  coin             text not null,
  qty              numeric not null check (qty > 0),
  avg_entry_price  numeric not null check (avg_entry_price > 0),
  updated_at       timestamptz not null default now(),
  unique (user_id, coin)
);

alter table public.paper_positions enable row level security;

drop policy if exists "Users manage their own paper positions" on public.paper_positions;
create policy "Users manage their own paper positions"
  on public.paper_positions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Append-only trade log — written by the authenticated client itself on
-- execution (not a cron/service-role writer, since v1 is approval-gated
-- and synchronous). Still read-only from the RLS policy's perspective is
-- unnecessary restriction here (the client IS the writer), so this uses
-- the same owner "for all" shape as the two tables above rather than
-- strategy_fires's select-only pattern — v2's autonomous Loops is what
-- will need a service-role writer + a read-only client policy.
create table if not exists public.paper_trades (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  coin       text not null,
  side       text not null check (side in ('buy','sell')),
  qty        numeric not null check (qty > 0),
  price      numeric not null check (price > 0),
  reason     text,
  created_at timestamptz not null default now()
);

create index if not exists paper_trades_user_recent_idx
  on public.paper_trades (user_id, created_at desc);

alter table public.paper_trades enable row level security;

drop policy if exists "Users manage their own paper trades" on public.paper_trades;
create policy "Users manage their own paper trades"
  on public.paper_trades
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Persisted agent chat history. `action` holds the structured proposal
-- payload (nullable — only set on agent messages that proposed a concrete
-- trade) so the UI can re-render past proposal cards (and their
-- confirmed/dismissed state) after a reload instead of losing them.
create table if not exists public.agent_messages (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  role           text not null check (role in ('user','agent')),
  content        text not null,
  action         jsonb,
  action_status  text check (action_status in ('pending','confirmed','dismissed')),
  created_at     timestamptz not null default now()
);

create index if not exists agent_messages_user_recent_idx
  on public.agent_messages (user_id, created_at desc);

alter table public.agent_messages enable row level security;

drop policy if exists "Users manage their own agent messages" on public.agent_messages;
create policy "Users manage their own agent messages"
  on public.agent_messages
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
