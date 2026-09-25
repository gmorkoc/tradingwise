// Funding rate + long/short ratio.
//
// Binance Futures direct (fapi.binance.com) was tried and confirmed dead
// from this region too, not just Vercel's — a live test got back HTTP 451
// "Service unavailable from a restricted location" for both endpoints. So
// this can't be Binance-only: no CoinGlass subscription anymore (per the
// account), and Binance itself is geo-blocked from both places this app
// runs. Coinalyze is the one leg of the client's old fallback chain that's
// free-tier, not paid — using it alone here for funding rate. It has no
// simple "current" long/short-ratio endpoint (only an hourly-history one),
// so that stays unavailable until a paid source is added back.
//
// Both values come back null (not thrown) on failure — the scan treats a
// missing positioning read as "signal unavailable" for that coin, same as
// any other indicator that can't be computed, not a scan failure.
const COINALYZE_API_KEY = Deno.env.get("COINALYZE_API_KEY") ?? "";

export interface Positioning {
  fundingRate: number | null;
  longShortRatio: number | null;
}

export async function fetchPositioning(coin: string): Promise<Positioning> {
  const symbol = `${coin.toUpperCase()}USDT`;
  let fundingRate: number | null = null;

  if (COINALYZE_API_KEY) {
    try {
      const res = await fetch(`https://api.coinalyze.net/v1/funding-rate?symbols=${symbol}_PERP.A`,
        { headers: { api_key: COINALYZE_API_KEY, accept: "application/json" } });
      if (res.ok) {
        const json = await res.json();
        const row = Array.isArray(json) ? json[0] : null;
        if (typeof row?.value === "number") fundingRate = row.value / 100;
      }
    } catch { /* leave null */ }
  }

  return { fundingRate, longShortRatio: null };
}
