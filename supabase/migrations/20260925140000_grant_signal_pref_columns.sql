-- profiles uses column-level grants, not a table-wide UPDATE grant (see
-- 20260901020000_grant_profile_columns.sql) — notify_buy_signals,
-- notify_sell_signals, signal_muted_coins and signal_min_confidence were
-- all added without this step, so every write to them (the mute button,
-- the Settings toggles, the min-confidence picker) was silently failing
-- with "permission denied for table profiles".
grant update (notify_buy_signals, notify_sell_signals, signal_muted_coins, signal_min_confidence)
  on public.profiles to authenticated;
