-- Buy Signals → Buy & Sell Signals: a coin can now carry an independent
-- active buy row and active sell row at once (rare, but structurally
-- possible), so direction becomes part of the identity instead of being
-- implied by the table.

alter table public.buy_signals
  add column direction text not null default 'buy' check (direction in ('buy', 'sell'));

alter table public.buy_signals drop constraint buy_signals_pkey;
alter table public.buy_signals add primary key (coin, direction);

alter table public.buy_signal_fires
  add column direction text not null default 'buy' check (direction in ('buy', 'sell'));

-- drawdown_pct only ever made sense for the buy side (always negative) —
-- renamed to a signed, direction-agnostic move_pct (negative = drawdown,
-- positive = rally) now that sell rows populate the same column.
alter table public.buy_signals rename column drawdown_pct to move_pct;

-- New raw values for the expanded signal set (MACD cross, medium-term
-- trend filter, funding/positioning) — stored raw, same convention as the
-- existing rsi/bb_pct/vol_ratio columns, so the full checklist (triggered
-- AND not-yet-triggered) is reconstructable client-side without needing
-- signals jsonb to carry misses.
alter table public.buy_signals
  add column macd_hist numeric,
  add column sma_ratio numeric,      -- price / 200-period SMA; >1 = above (uptrend context)
  add column funding_rate numeric,
  add column long_short_ratio numeric;

-- Per-user signal preferences.
alter table public.profiles
  add column notify_sell_signals boolean not null default true,
  add column signal_muted_coins text[] not null default '{}',
  add column signal_min_confidence text not null default 'low' check (signal_min_confidence in ('low', 'medium', 'high'));
