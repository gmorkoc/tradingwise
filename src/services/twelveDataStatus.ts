// Shared circuit-breaker state for TwelveData's daily quota, used by both
// twelvedata.ts and marketOverview.ts — they hit the same account/quota
// from different call sites. Once a response matches the known "out of API
// credits for the day" shape, further TwelveData calls are skipped outright
// for a cooldown window instead of repeatedly hitting a known-dead endpoint;
// callers fall straight to whatever fallback exists (Alpha Vantage for
// candles and 6 of the 7 ticker chips) or their existing empty/placeholder
// state (movers, VIX — no fallback for those).

// TwelveData's exact daily reset time isn't known without a paid account
// dashboard, so this re-checks periodically rather than waiting a full 24h.
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

let exhaustedUntil = 0;

export function isTdQuotaExhausted(): boolean {
  return Date.now() < exhaustedUntil;
}

export function markTdQuotaExhausted(): void {
  exhaustedUntil = Date.now() + COOLDOWN_MS;
}

// Inspects a parsed TwelveData JSON response body for the specific
// rate-limit shape ({ status: "error", code: 429, message: "...run out of
// API credits..." }) and marks the breaker if it matches. Returns whether
// it matched, so callers can short-circuit their own error handling too.
export function checkTdQuotaResponse(data: unknown): boolean {
  if (data && typeof data === "object") {
    const d = data as { code?: number; status?: string; message?: string };
    if (d.status === "error" && (d.code === 429 || /run out of api credits/i.test(d.message ?? ""))) {
      markTdQuotaExhausted();
      return true;
    }
  }
  return false;
}
