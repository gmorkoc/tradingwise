// Advance Chart page, mobile fullscreen — the TradingView-style "symbol
// info" bottom sheet (Overview/Technicals/Key stats/About) needs real
// fundamental data (ATH, supply, market cap, project links) this app has
// never tracked before (its own data sources are all OHLCV/derivatives —
// see coinglass.ts), so this is a new, separate fetch, not a repurposing
// of anything existing.

// Data: services/marketData.ts getCoinDetails — CoinGecko first, then
// CoinPaprika, then CoinLore (fields a source lacks come back null).
import { getCoinDetails } from "./marketData";

export interface CoinMeta {
  marketCapUSD: number | null;
  fdvUSD: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  athUSD: number | null;
  athChangePercent: number | null;
  weekChangePercent: number | null;
  category: string | null;
  homepage: string | null;
  sourceCode: string | null;
  explorer: string | null;
  whitepaper: string | null;
  subreddit: string | null;
  // Genesis / start date ("YYYY-MM-DD"), often null for newer coins.
  genesisDate: string | null;
}

export async function fetchCoinMeta(coin: string): Promise<CoinMeta | null> {
  try {
    const d = await getCoinDetails(coin);
    if (!d) return null;
    const md = d.market;
    return {
      marketCapUSD: md?.market_cap ?? null,
      fdvUSD: md?.fdv ?? null,
      circulatingSupply: md?.circulating_supply ?? null,
      totalSupply: md?.total_supply ?? null,
      athUSD: md?.ath ?? null,
      athChangePercent: md?.ath_change_percentage ?? null,
      weekChangePercent: md?.change_7d ?? null,
      category: d.tags[0] ?? null,
      genesisDate: d.genesis_date,
      homepage: d.links.website[0] ?? null,
      sourceCode: d.links.source_code.find((u) => /github\.com/.test(u)) ?? d.links.source_code[0] ?? null,
      explorer: d.links.explorer[0] ?? null,
      whitepaper: d.links.whitepaper,
      subreddit: d.links.reddit[0] ?? null,
    };
  } catch {
    return null;
  }
}

// Raw contract count (coin units), not USD — the caller already has a live
// price to multiply by, so this avoids a second redundant price fetch.
// Coinalyze (Binance USDT perp, in coin units) — Binance's own futures API
// answers 451 "restricted location" from our hosting region and from many
// users' networks, so it's not used.
export async function fetchOpenInterestCoins(coin: string): Promise<number | null> {
  try {
    const res = await fetch(`/coinalyze-api/v1/open-interest?symbols=${coin}USDT_PERP.A`);
    if (!res.ok) return null;
    const d = await res.json();
    const oi = Array.isArray(d) && typeof d[0]?.value === "number" ? d[0].value : NaN;
    return isFinite(oi) ? oi : null;
  } catch {
    return null;
  }
}
