-- Buy/sell signals are a Pro feature. Both tables were readable by every
-- signed-in user (`using (true)`), so a free account could query them or
-- subscribe to buy_signal_fires over Realtime directly, even though the
-- app's own UI and the push sender (buy-signal-scan) only serve pro/elite.
-- Restrict reads to pro and elite profiles. Realtime postgres_changes
-- applies the same SELECT policy, so free users stop receiving fire rows
-- too. The edge function uses the service role and is unaffected.

drop policy if exists "authenticated users can read buy signals" on public.buy_signals;
drop policy if exists "pro users can read buy signals" on public.buy_signals;
create policy "pro users can read buy signals"
  on public.buy_signals for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.tier in ('pro', 'elite')
    )
  );

drop policy if exists "authenticated users can read buy signal fires" on public.buy_signal_fires;
drop policy if exists "pro users can read buy signal fires" on public.buy_signal_fires;
create policy "pro users can read buy signal fires"
  on public.buy_signal_fires for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.tier in ('pro', 'elite')
    )
  );
