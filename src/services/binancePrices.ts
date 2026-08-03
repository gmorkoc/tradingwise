export interface PriceEntry { price: number; pct: number; vol: number }

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
    const res = await fetch(
      "https://data-api.binance.vision/api/v3/ticker/24hr",
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return new Map();
    const all: { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[] =
      await res.json();
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

export async function fetchSparklines(symbols: string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  await Promise.all(symbols.map(async sym => {
    try {
      const res = await fetch(
        `https://data-api.binance.vision/api/v3/klines?symbol=${toBinanceSym(sym)}&interval=1d&limit=7`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return;
      const data: (string | number)[][] = await res.json();
      result.set(sym, data.map(c => parseFloat(String(c[4])))); // close prices
    } catch { /* symbol may not exist on Binance */ }
  }));
  return result;
}
