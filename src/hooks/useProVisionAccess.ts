import { useCallback, useEffect, useState } from "react";

// Who gets ProVision, and how much:
//   Elite, or the ProVision plan ($99/yr)  → unlimited
//   Free, during the 3-day trial            → unlimited until it ends
//   Pro                                     → 3 coins per rolling 24h
//   Free (no / used-up trial), signed out   → locked (paywall)
//
// Pro's coin allowance is kept per coin with the time it was first used and
// saved to localStorage, so a refresh can't reset it (same idea as the AI
// cooldowns). A coin stays unlocked for 24h after its first use.

export type PvAccessMode = "unlimited" | "trial" | "limited" | "locked";
export type PvLockReason = "signin" | "trial-available" | "trial-ended" | "pro-limit";

export const PV_TRIAL_DAYS = 3;
export const PV_PRO_COINS_PER_DAY = 3;
const PV_PRO_WINDOW_MS = 24 * 3600 * 1000;
const KEY = "provision:coins:v1";
const EVT = "provision-coins-change";

type CoinLog = Record<string, number>; // coin -> first-used timestamp (ms)

function readLog(): CoinLog {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}") as CoinLog;
    const now = Date.now();
    const out: CoinLog = {};
    for (const [c, t] of Object.entries(raw)) if (typeof t === "number" && now - t < PV_PRO_WINDOW_MS) out[c] = t;
    return out;
  } catch {
    return {};
  }
}
function writeLog(log: CoinLog) {
  try { localStorage.setItem(KEY, JSON.stringify(log)); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVT));
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
  /** Record that ProVision ran on this coin (counts toward Pro's 3/day). */
  markUsed: (coin: string) => void;
  /** Pro: coins already used in the last 24h and how many are left. */
  usedCoins: string[];
  coinsLeft: number;
  /** Pro: when the oldest used coin frees up again (ms), if at the limit. */
  nextFreeAt: number | null;
  /** Trial end time (ms) when on / after a trial. */
  trialEndsAt: number | null;
}

export function useProVisionAccess(input: PvAccessInput): PvAccess {
  const { signedIn, tier, hasPlan, trialStartedAt } = input;
  const [log, setLog] = useState<CoinLog>(readLog);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const sync = () => setLog(readLog());
    window.addEventListener(EVT, sync);
    window.addEventListener("storage", sync);
    // Re-check once a minute so trials / 24h windows expire on their own.
    const id = window.setInterval(() => { setNow(Date.now()); setLog(readLog()); }, 60_000);
    return () => {
      window.removeEventListener(EVT, sync);
      window.removeEventListener("storage", sync);
      clearInterval(id);
    };
  }, []);

  const trialEndsAt = trialStartedAt ? new Date(trialStartedAt).getTime() + PV_TRIAL_DAYS * 86_400_000 : null;
  const onTrial = trialEndsAt !== null && now < trialEndsAt;

  const mode: PvAccessMode =
    tier === "elite" || hasPlan ? "unlimited"
      : tier === "pro" ? "limited"
        : signedIn && onTrial ? "trial"
          : "locked";

  const usedCoins = Object.keys(log);
  const coinsLeft = Math.max(0, PV_PRO_COINS_PER_DAY - usedCoins.length);
  const nextFreeAt = usedCoins.length >= PV_PRO_COINS_PER_DAY
    ? Math.min(...Object.values(log)) + PV_PRO_WINDOW_MS
    : null;

  const allowed = useCallback((coin: string) => {
    if (mode === "unlimited" || mode === "trial") return true;
    if (mode === "limited") return coin in log || Object.keys(log).length < PV_PRO_COINS_PER_DAY;
    return false;
  }, [mode, log]);

  const lockReason = useCallback((coin: string): PvLockReason | null => {
    if (allowed(coin)) return null;
    if (mode === "limited") return "pro-limit";
    if (!signedIn) return "signin";
    return trialStartedAt ? "trial-ended" : "trial-available";
  }, [allowed, mode, signedIn, trialStartedAt]);

  const markUsed = useCallback((coin: string) => {
    if (mode !== "limited") return;
    const cur = readLog();
    if (coin in cur || Object.keys(cur).length >= PV_PRO_COINS_PER_DAY) return;
    cur[coin] = Date.now();
    writeLog(cur);
  }, [mode]);

  return { mode, allowed, lockReason, markUsed, usedCoins, coinsLeft, nextFreeAt, trialEndsAt };
}
