import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Who gets ProVision, and how much:
//   Elite, or the ProVision plan ($99/yr)  → unlimited
//   Free, during the 3-day trial            → unlimited until it ends
//   Pro                                     → 3 coins per rolling 24h
//   Free (no / used-up trial), signed out   → locked (paywall)
//
// Pro's coin allowance is counted on the SERVER (provision_coin_usage +
// claim_provision_coin, see 20261030040000_provision_coin_usage.sql), so
// it's the same on every device and can't be reset by clearing storage.
// A coin stays unlocked for 24h after its first use.

export type PvAccessMode = "unlimited" | "trial" | "limited" | "locked";
export type PvLockReason = "signin" | "trial-available" | "trial-ended" | "pro-limit" | "trial-active";

export const PV_TRIAL_DAYS = 3;
export const PV_PRO_COINS_PER_DAY = 3;
const PV_PRO_WINDOW_MS = 24 * 3600 * 1000;
const EVT = "provision-coins-change";

type CoinLog = Record<string, number>; // COIN -> first-used timestamp (ms)
const norm = (c: string) => c.trim().toUpperCase();

/** Pro's coins used in the last 24h, from the server (own rows only, RLS). */
async function fetchServerLog(): Promise<CoinLog> {
  const since = new Date(Date.now() - PV_PRO_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("provision_coin_usage")
    .select("coin, first_used_at")
    .gt("first_used_at", since);
  if (error || !data) return {};
  const out: CoinLog = {};
  for (const r of data as { coin: string; first_used_at: string }[]) out[norm(r.coin)] = new Date(r.first_used_at).getTime();
  return out;
}

export interface PvAccessInput {
  signedIn: boolean;
  tier: "free" | "pro" | "elite" | string;
  /** Owns the standalone ProVision plan. */
  hasPlan: boolean;
  /** When the free trial was started (ISO), or null if never. */
  trialStartedAt: string | null;
}

export interface PvAccess {
  mode: PvAccessMode;
  /** Can ProVision run on this coin right now? */
  allowed: (coin: string) => boolean;
  /** Why it's locked for this coin (null when allowed). */
  lockReason: (coin: string) => PvLockReason | null;
  /** Ask the server to count this coin toward Pro's 3/day (no-op otherwise). */
  markUsed: (coin: string) => void;
  /** Pro: coins used in the last 24h and how many are left. */
  usedCoins: string[];
  coinsLeft: number;
  /** Pro: when the oldest used coin frees up again (ms), if at the limit. */
  nextFreeAt: number | null;
  /** Trial end time (ms) when on / after a trial. */
  trialEndsAt: number | null;
}

export function useProVisionAccess(input: PvAccessInput): PvAccess {
  const { signedIn, tier, hasPlan, trialStartedAt } = input;
  const [log, setLog] = useState<CoinLog>({});
  const [now, setNow] = useState(() => Date.now());

  const trialEndsAt = trialStartedAt ? new Date(trialStartedAt).getTime() + PV_TRIAL_DAYS * 86_400_000 : null;
  const onTrial = trialEndsAt !== null && now < trialEndsAt;

  const mode: PvAccessMode =
    tier === "elite" || hasPlan ? "unlimited"
      : tier === "pro" ? "limited"
        : signedIn && onTrial ? "trial"
          : "locked";

  // Pro: load the server's count, keep every hook instance in sync, and
  // re-check once a minute so 24h windows / trials expire on their own.
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (mode !== "limited") { setLog({}); return; }
      fetchServerLog().then((l) => { if (alive) setLog(l); });
    };
    load();
    window.addEventListener(EVT, load);
    const id = window.setInterval(() => { setNow(Date.now()); load(); }, 60_000);
    return () => {
      alive = false;
      window.removeEventListener(EVT, load);
      clearInterval(id);
    };
  }, [mode]);

  const usedCoins = Object.keys(log).filter((c) => now - log[c] < PV_PRO_WINDOW_MS);
  const coinsLeft = Math.max(0, PV_PRO_COINS_PER_DAY - usedCoins.length);
  const nextFreeAt = usedCoins.length >= PV_PRO_COINS_PER_DAY
    ? Math.min(...usedCoins.map((c) => log[c])) + PV_PRO_WINDOW_MS
    : null;

  const allowed = useCallback((coin: string) => {
    if (mode === "unlimited" || mode === "trial") return true;
    if (mode === "limited") return norm(coin) in log || Object.keys(log).length < PV_PRO_COINS_PER_DAY;
    return false;
  }, [mode, log]);

  const lockReason = useCallback((coin: string): PvLockReason | null => {
    if (allowed(coin)) return null;
    if (mode === "limited") return "pro-limit";
    if (!signedIn) return "signin";
    return trialStartedAt ? "trial-ended" : "trial-available";
  }, [allowed, mode, signedIn, trialStartedAt]);

  const markUsed = useCallback((coin: string) => {
    if (mode !== "limited" || norm(coin) in log) return;
    supabase.rpc("claim_provision_coin", { p_coin: coin }).then(({ data, error }) => {
      if (error || !data) return;
      const res = data as { allowed: boolean; used: string[] };
      // Server is the source of truth (it may refuse if another device
      // used the last slot first) — reload so every instance agrees.
      if (!res.allowed || !res.used.includes(norm(coin))) setLog((l) => ({ ...l }));
      window.dispatchEvent(new Event(EVT));
    });
  }, [mode, log]);

  return { mode, allowed, lockReason, markUsed, usedCoins, coinsLeft, nextFreeAt, trialEndsAt };
}
