-- Nothing currently records whether a closed trade won or lost — paper_trades
-- logs qty/price/side per leg but never the realized gain/loss, so there's
-- no way to compute a real win rate from history. Null on an opening trade
-- (nothing realized yet); set on every close (manual sell/reduce, TP, SL,
-- liquidation) to (exit price - avg entry price) * qty closed, sign-flipped
-- for a short.
alter table public.paper_trades
  add column if not exists realized_pnl numeric;
