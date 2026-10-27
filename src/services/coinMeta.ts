// Advance Chart page, mobile fullscreen — the TradingView-style "symbol
// info" bottom sheet (Overview/Technicals/Key stats/About) needs real
// fundamental data (ATH, supply, market cap, project links) this app has
// never tracked before (its own data sources are all OHLCV/derivatives —
// see coinglass.ts), so this is a new, separate fetch, not a repurposing
// of anything existing.

const CG_API_KEY = import.meta.env.VITE_COINGECKO_API_KEY as string | undefined;

// Straight to CoinGecko, not through the app's own /gecko-api proxy — same
// reasoning MarketHeatmap.tsx already documented for its own CoinGecko
// call: CoinGecko 403s some endpoints when hit through Vercel's outbound
// IP but allows the identical request from a real browser origin.
const COINGECKO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  XRP: "ripple",
  SOL: "solana",
  BNB: "binancecoin",
  SUI: "sui",
  DOGE: "dogecoin",
  ADA: "cardano",
  NEAR: "near",
  RENDER: "render-token",
  ZEC: "zcash",
};

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
  // CoinGecko genesis_date ("YYYY-MM-DD"), often null for newer coins.
  genesisDate: string | null;
}

const TTL = 5 * 60 * 1000;
const cache = new Map<string, { data: CoinMeta | null; ts: number }>();

export async function fetchCoinMeta(coin: string): Promise<CoinMeta | null> {
  const id = COINGECKO_ID[coin];
  if (!id) return null;
  const cached = cache.get(id);
  if (cached && Date.now() - cached.ts < TTL) return cached.data;
  try {
    const keyParam = CG_API_KEY ? `&x_cg_demo_api_key=${CG_API_KEY}` : "";
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false${keyParam}`,
    );
    if (!res.ok) {
      cache.set(id, { data: null, ts: Date.now() });
      return null;
    }
    const d = await res.json();
    const md = d.market_data ?? {};
    const links = d.links ?? {};
    const meta: CoinMeta = {
      marketCapUSD: md.market_cap?.usd ?? null,
      fdvUSD: md.fully_diluted_valuation?.usd ?? null,
      circulatingSupply: md.circulating_supply ?? null,
      totalSupply: md.total_supply ?? null,
      athUSD: md.ath?.usd ?? null,
      athChangePercent: md.ath_change_percentage?.usd ?? null,
      weekChangePercent: md.price_change_percentage_7d ?? null,
      category: Array.isArray(d.categories) ? (d.categories.find((c: string) => c) ?? null) : null,
      genesisDate: typeof d.genesis_date === "string" && d.genesis_date ? d.genesis_date : null,
      homepage: (links.homepage ?? []).find((u: string) => u) ?? null,
      sourceCode: (links.repos_url?.github ?? []).find((u: string) => u) ?? null,
      explorer: (links.blockchain_site ?? []).find((u: string) => u) ?? null,
      whitepaper: links.whitepaper || null,
      subreddit: links.subreddit_url || null,
    };
    cache.set(id, { data: meta, ts: Date.now() });
    return meta;
  } catch {
    return null;
  }
}

// Raw contract count (coin units), not USD — the caller already has a live
// price to multiply by, so this avoids a second redundant price fetch.
export async function fetchOpenInterestCoins(coin: string): Promise<number | null> {
  try {
    const res = await fetch(`/bnf-api/fapi/v1/openInterest?symbol=${coin}USDT`);
    if (!res.ok) return null;
    const d = await res.json();
    const oi = parseFloat(d?.openInterest ?? "");
    return isFinite(oi) ? oi : null;
  } catch {
    return null;
  }
}
