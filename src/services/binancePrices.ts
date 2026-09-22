import { fetchBn } from "./coinglass";
import { CATALOG } from "./coinCatalog";

export interface PriceEntry { price: number; pct: number; vol: number }
export interface TopMover { symbol: string; name: string; price: number; pct: number }

// Some symbols trade under a different name on Binance
const BINANCE_OVERRIDE: Record<string, string> = {
  POL:   "MATIC",  // Polygon still lists as MATIC
  MIOTA: "IOTA",
};

export function toBinanceSym(symbol: string): string {
  return (BINANCE_OVERRIDE[symbol] ?? symbol) + "USDT";
}

export async function fetchBinancePrices(symbols: string[]): Promise<Map<string, PriceEntry>> {
  try {
    const all: { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[] =
      await fetchBn("/api/v3/ticker/24hr", { signal: AbortSignal.timeout(6000) });
    const lookup = new Map(all.map(t => [t.symbol, t]));
    const result = new Map<string, PriceEntry>();
    for (const sym of symbols) {
      const t = lookup.get(toBinanceSym(sym));
      if (t) result.set(sym, {
        price: parseFloat(t.lastPrice),
        pct:   parseFloat(t.priceChangePercent),
        vol:   parseFloat(t.quoteVolume),
      });
    }
    return result;
  } catch { return new Map(); }
}

// Ranks every catalog coin that actually trades on Binance by 24h % change
// and returns the top `limit` — a single full-ticker fetch (no symbol
// filter, same endpoint fetchBinancePrices uses) rather than one request
// per coin. Restricting the ranking to CATALOG (curated, ~145 known coins)
// rather than Binance's whole listing is what keeps this from surfacing
// illiquid/leveraged-token noise with wild, meaningless swings.
export async function fetchTopMovers(limit = 8): Promise<TopMover[]> {
  try {
    const all: { symbol: string; lastPrice: string; priceChangePercent: string }[] =
      await fetchBn("/api/v3/ticker/24hr", { signal: AbortSignal.timeout(8000) });
    const lookup = new Map(all.map(t => [t.symbol, t]));
    const movers: TopMover[] = [];
    for (const c of CATALOG) {
      const t = lookup.get(toBinanceSym(c.symbol));
      if (!t) continue;
      movers.push({ symbol: c.symbol, name: c.name, price: parseFloat(t.lastPrice), pct: parseFloat(t.priceChangePercent) });
    }
    return movers.sort((a, b) => b.pct - a.pct).slice(0, limit);
  } catch { return []; }
}

export async function fetchSparklines(symbols: string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  await Promise.all(symbols.map(async sym => {
    try {
      const data: (string | number)[][] = await fetchBn(
        `/api/v3/klines?symbol=${toBinanceSym(sym)}&interval=1d&limit=7`,
        { signal: AbortSignal.timeout(5000) },
      );
      result.set(sym, data.map(c => parseFloat(String(c[4])))); // close prices
    } catch { /* symbol may not exist on Binance */ }
  }));
  return result;
}
