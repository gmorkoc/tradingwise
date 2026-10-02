-- Exchange-style trading: the agent can now propose either a plain spot
-- buy/sell (own the asset, no leverage, no liquidation) or a leveraged
-- futures long/short (margin posted, blended leverage, a computed
-- liquidation price, optional TP/SL) — same position table, branching on
-- `market`. A user can hold a spot position AND a futures position in the
-- same coin at once (they're economically different things), so the old
-- one-row-per-(user,coin) uniqueness becomes one-row-per-(user,coin,market).

alter table public.paper_positions drop constraint if exists paper_positions_user_id_coin_key;

alter table public.paper_positions
  add column if not exists market text not null default 'spot' check (market in ('spot', 'futures')),
  add column if not exists side text not null default 'long' check (side in ('long', 'short')),
  add column if not exists leverage numeric not null default 1 check (leverage >= 1 and leverage <= 20),
  add column if not exists margin_usd numeric not null default 0 check (margin_usd >= 0),
  add column if not exists liquidation_price numeric,
  add column if not exists take_profit_price numeric,
  add column if not exists stop_loss_price numeric;

alter table public.paper_positions add constraint paper_positions_user_coin_market_key unique (user_id, coin, market);

-- Mirrors the same new fields on the trade log, purely for history/audit
-- (e.g. showing "closed via liquidation" vs "closed manually" later) — all
-- nullable so existing spot-only rows stay valid as-is.
alter table public.paper_trades
  add column if not exists market text not null default 'spot' check (market in ('spot', 'futures')),
  add column if not exists position_side text check (position_side in ('long', 'short')),
  add column if not exists leverage numeric,
  add column if not exists margin_usd numeric,
  add column if not exists liquidation_price numeric,
  add column if not exists take_profit_price numeric,
  add column if not exists stop_loss_price numeric,
  add column if not exists close_reason text check (close_reason in ('manual', 'take_profit', 'stop_loss', 'liquidation'));

-- Opt-in, asked at onboarding alongside the risk disclaimer — defaults to
-- false (spot only) so a user who blows past the consent screen without
-- reading closely doesn't end up with leveraged futures proposals they
-- never asked for.
alter table public.paper_portfolios
  add column if not exists allow_leverage boolean not null default false;

-- Specific coins the user says they actually want to trade (e.g. "BTC,
-- ETH"), asked at onboarding alongside the broader style chips (large-cap
-- alts/memecoins/everything) — lets the agent default to a concrete coin
-- instead of a category when the user doesn't name one in their message.
alter table public.paper_portfolios
  add column if not exists focus_coins text[] not null default '{}';

-- Superseded by focus_coins (a specific-coin picker is more useful to the
-- agent than a broad category) — dropped rather than left dead.
alter table public.paper_portfolios drop column if exists preferred_styles;
