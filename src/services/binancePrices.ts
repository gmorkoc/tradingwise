import { fetchBn } from "./coinglass";
import { CATALOG } from "./coinCatalog";

export interface PriceEntry { price: number; pct: number; vol: number }
export interface TopMover { symbol: string; name: string; price: number; pct: number; thumb?: string }

// Some symbols trade under a different name on Binance
const BINANCE_OVERRIDE: Record<string, string> = {
  POL:   "MATIC",  // Polygon still lists as MATIC
  MIOTA: "IOTA",
};

export function toBinanceSym(symbol: string): string {
  return (BINANCE_OVERRIDE[symbol] ?? symbol) + "USDT";
}

type RawTicker = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string };

// Watchlist (every 5s) and both Top Movers components (every 30s) each used
// to call the full, unfiltered /api/v3/ticker/24hr endpoint independently —
// on first page load, when all of them mount within the same instant, that
// meant 2-3 near-simultaneous fetches of the same several-hundred-KB
// payload, each paying its own full network+parse cost before anything
// could render. One shared cache + in-flight dedup means whichever of them
// asks second (almost always, on mount) gets the data instantly instead of
// waiting on a duplicate fetch — this is the actual fix for "available
// ASAP," not a bigger timeout or a loading spinner tweak.
let tickerCache: RawTicker[] | null = null;
let tickerFetchedAt = 0;
let tickerInFlight: Promise<RawTicker[]> | null = null;
const TICKER_TTL = 5_000; // matches Watchlist's own 5s poll cadence

async function fetchFullTicker(): Promise<RawTicker[]> {
  if (tickerCache && Date.now() - tickerFetchedAt < TICKER_TTL) return tickerCache;
  if (tickerInFlight) return tickerInFlight;
  tickerInFlight = (async (): Promise<RawTicker[]> => {
    try {
      const all: RawTicker[] = await fetchBn("/api/v3/ticker/24hr", { signal: AbortSignal.timeout(8000) });
      tickerCache = all;
      tickerFetchedAt = Date.now();
      return all;
    } catch {
      return tickerCache ?? []; // serve stale rather than empty on a transient failure
    } finally {
      tickerInFlight = null;
    }
  })();
  return tickerInFlight;
}

export async function fetchBinancePrices(symbols: string[]): Promise<Map<string, PriceEntry>> {
  try {
    const all = await fetchFullTicker();
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
export async function fetchTopMovers(limit = 8, direction: "gainers" | "losers" = "gainers"): Promise<TopMover[]> {
  try {
    const all = await fetchFullTicker();
    const lookup = new Map(all.map(t => [t.symbol, t]));
    const movers: TopMover[] = [];
    for (const c of CATALOG) {
      const t = lookup.get(toBinanceSym(c.symbol));
      if (!t) continue;
      movers.push({ symbol: c.symbol, name: c.name, price: parseFloat(t.lastPrice), pct: parseFloat(t.priceChangePercent) });
    }
    return movers.sort((a, b) => direction === "losers" ? a.pct - b.pct : b.pct - a.pct).slice(0, limit);
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
