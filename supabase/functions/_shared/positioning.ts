// Funding rate + long/short ratio, server-side twin of the fallback chain
// in src/services/coinglass.ts (CoinGlass primary, Coinalyze fallback).
// Deliberately skips that client's third leg (direct Binance futures via
// fapi.binance.com) — already confirmed geo-blocked from this app's other
// hosting region for OI specifically, and untested from Supabase's, unlike
// data-api.binance.vision (klines.ts) which IS confirmed reachable here.
// Both values come back null (not thrown) on total failure — the scan
// treats a missing positioning read as "signal unavailable" for that coin,
// same as any other indicator that can't be computed, not a scan failure.
const CG_API_KEY = Deno.env.get("COINGLASS_API_KEY") ?? "";
const COINALYZE_API_KEY = Deno.env.get("COINALYZE_API_KEY") ?? "";

export interface Positioning {
  fundingRate: number | null;
  longShortRatio: number | null;
}

export async function fetchPositioning(coin: string): Promise<Positioning> {
  const symbol = `${coin.toUpperCase()}USDT`;
  let fundingRate: number | null = null;
  let longShortRatio: number | null = null;

  if (CG_API_KEY) {
    const [frRes, lsRes] = await Promise.all([
      fetch(`https://open-api-v4.coinglass.com/api/futures/funding-rate/history?symbol=${symbol}&interval=4h&limit=1&exchange=Binance`,
        { headers: { "CG-API-KEY": CG_API_KEY, accept: "application/json" } })
        .then(r => r.json()).catch(() => null),
      fetch(`https://open-api-v4.coinglass.com/api/futures/global-long-short-account-ratio/history?symbol=${symbol}&interval=4h&limit=1&exchange=Binance`,
        { headers: { "CG-API-KEY": CG_API_KEY, accept: "application/json" } })
        .then(r => r.json()).catch(() => null),
    ]);
    if (frRes?.code === "0") {
      const v = parseFloat(frRes.data?.[0]?.close ?? "");
      if (isFinite(v)) fundingRate = v;
    }
    if (lsRes?.code === "0") {
      const p = lsRes.data?.[0];
      const longPct = parseFloat(p?.global_account_long_percent ?? p?.longAccount ?? "0");
      const shortPct = parseFloat(p?.global_account_short_percent ?? p?.shortAccount ?? "0");
      if (shortPct > 0) {
        const v = Math.round((longPct / shortPct) * 100) / 100;
        if (isFinite(v)) longShortRatio = v;
      }
    }
  }

  // Coinalyze only backs up funding rate — it has no simple "current L/S
  // ratio" endpoint (only an hourly history one, more porting than this
  // scan needs), so a CoinGlass L/S miss is just left null.
  if (fundingRate === null && COINALYZE_API_KEY) {
    const fr = await fetch(`https://api.coinalyze.net/v1/funding-rate?symbols=${symbol}_PERP.A`,
      { headers: { api_key: COINALYZE_API_KEY, accept: "application/json" } })
      .then(r => r.json()).catch(() => null);
    const row = Array.isArray(fr) ? fr[0] : null;
    if (typeof row?.value === "number") fundingRate = row.value / 100;
  }

  return { fundingRate, longShortRatio };
}
