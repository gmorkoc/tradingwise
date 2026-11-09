// Market-wide snapshot for the trading agent: top coins by market cap plus
// the day's biggest gainers / losers among them — real CoinGecko data, so
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

export async function fetchMarketOverview(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false",
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return null;
    const all = (await res.json()) as Gecko[];
    if (!Array.isArray(all) || !all.length) return null;
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
