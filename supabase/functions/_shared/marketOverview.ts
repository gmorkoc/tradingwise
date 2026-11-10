// Market-wide snapshot for the trading agent: top coins by market cap plus
// the day's biggest gainers / losers among them — real market data
// (CoinGecko, falling back to CoinPaprika then CoinLore), so
// "show me the top 10" or "what's pumping today" gets an actual list
// instead of a guess. Never throws: on any failure it returns null and the
// prompt says the overview is unavailable.
const SKIP = new Set([
  "USDT", "USDC", "USDE", "USDS", "DAI", "FDUSD", "TUSD", "PYUSD", "USDD", "USD1", "BUSD", "USDX",
  "STETH", "WSTETH", "WBTC", "WETH", "WEETH", "CBBTC", "CBETH", "RETH", "WBETH", "BSC-USD",
]);

interface Gecko {
  symbol: string;
  name: string;
  market_cap_rank: number | null;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  price_change_percentage_24h: number | null;
}

const usd = (v: number | null) => {
  if (v == null || !isFinite(v)) return "n/a";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 6 : 2 })}`;
};
const pct = (v: number | null) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
const line = (c: Gecko) =>
  `#${c.market_cap_rank ?? "?"} ${c.symbol.toUpperCase()} (${c.name}) price ${usd(c.current_price)}, 24h ${pct(c.price_change_percentage_24h)}, mcap ${usd(c.market_cap)}, vol ${usd(c.total_volume)}`;

const getJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
};
const n = (v: unknown): number | null => {
  const x = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : typeof v === "number" ? v : NaN;
  return isFinite(x) ? x : null;
};

// Top 100 by market cap, CoinGecko-shaped. Fallback chain: CoinGecko →
// CoinPaprika → CoinLore — each only if the previous one fails (non-2xx,
// network error / timeout, or an empty / unexpected payload).
async function fromCoinGecko(): Promise<Gecko[]> {
  const all = await getJson("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false");
  if (!Array.isArray(all) || !all.length || typeof all[0]?.current_price !== "number") throw new Error("bad payload");
  return all as Gecko[];
}
async function fromCoinPaprika(): Promise<Gecko[]> {
  type T = { symbol: string; name: string; rank: number; quotes?: { USD?: { price?: number; market_cap?: number; volume_24h?: number; percent_change_24h?: number } } };
  const all = await getJson("https://api.coinpaprika.com/v1/tickers?quotes=USD&limit=100");
  if (!Array.isArray(all) || !all.length) throw new Error("bad payload");
  return (all as T[]).filter((t) => t.rank > 0 && t.quotes?.USD?.price).sort((a, b) => a.rank - b.rank).map((t) => ({
    symbol: t.symbol, name: t.name, market_cap_rank: t.rank,
    current_price: n(t.quotes!.USD!.price), market_cap: n(t.quotes!.USD!.market_cap),
    total_volume: n(t.quotes!.USD!.volume_24h), price_change_percentage_24h: n(t.quotes!.USD!.percent_change_24h),
  }));
}
async function fromCoinLore(): Promise<Gecko[]> {
  type T = { symbol: string; name: string; rank: number; price_usd: string; market_cap_usd?: string; volume24?: number | string; percent_change_24h?: string };
  const j = (await getJson("https://api.coinlore.net/api/tickers/?start=0&limit=100")) as { data?: T[] };
  if (!Array.isArray(j?.data) || !j.data.length) throw new Error("bad payload");
  return j.data.filter((t) => n(t.price_usd)).map((t) => ({
    symbol: t.symbol, name: t.name, market_cap_rank: Number(t.rank) || null,
    current_price: n(t.price_usd), market_cap: n(t.market_cap_usd),
    total_volume: n(t.volume24), price_change_percentage_24h: n(t.percent_change_24h),
  }));
}

export async function fetchMarketOverview(): Promise<string | null> {
  try {
    let all: Gecko[] | null = null;
    for (const source of [fromCoinGecko, fromCoinPaprika, fromCoinLore]) {
      try { all = await source(); break; } catch { /* next source */ }
    }
    if (!all || !all.length) return null;
    const coins = all.filter((c) => !SKIP.has(c.symbol.toUpperCase()));
    const byChange = coins.filter((c) => c.price_change_percentage_24h != null)
      .sort((a, b) => (b.price_change_percentage_24h ?? 0) - (a.price_change_percentage_24h ?? 0));
    return [
      "Top 10 by market cap (stablecoins and wrapped tokens excluded):",
      ...coins.slice(0, 10).map(line),
      "",
      "Top 10 gainers, 24h (among the top 100):",
      ...byChange.slice(0, 10).map(line),
      "",
      "Top 10 losers, 24h (among the top 100):",
      ...byChange.slice(-10).reverse().map(line),
    ].join("\n");
  } catch {
    return null;
  }
}
