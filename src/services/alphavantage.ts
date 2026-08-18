// Alpha Vantage — used as (a) the primary source for stock symbol search,
// falling back to TwelveData, and (b) a fallback for single-symbol candle
// fetches when TwelveData itself fails (e.g. its daily quota is exhausted).
// Free tier is 25 requests/day TOTAL with no batch-quote endpoint (every
// symbol needs its own call), which rules it out for the ticker strip and
// movers list (those need frequent multi-symbol batched data) — but a
// single chart fetch is naturally one symbol per call already, so it's a
// safe fit there. Because both search and the candles fallback share this
// same 25/day budget, treat it as a last resort, not a second primary.

import type { StockSearchResult, StockCandle, StockInterval } from "./twelvedata";

const AV_BASE = "/av-api";
const API_KEY = import.meta.env.VITE_ALPHAVANTAGE_API_KEY as string | undefined;

export const hasAlphaVantageKey = Boolean(API_KEY);

// Same circuit-breaker idea as twelveDataStatus.ts, scoped to this file
// since only these three functions ever call Alpha Vantage. Once any call
// sees the rate-limit response shape ({ Information: "..." } or
// { Note: "..." }, no real data), skip further AV calls for a cooldown
// instead of hitting a known-dead endpoint on every search keystroke/chart
// load/ticker poll.
const AV_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let avExhaustedUntil = 0;

function isAvExhausted(): boolean {
  return Date.now() < avExhaustedUntil;
}

function checkAvRateLimit(data: unknown): boolean {
  if (data && typeof data === "object" && ("Information" in data || "Note" in data)) {
    avExhaustedUntil = Date.now() + AV_COOLDOWN_MS;
    return true;
  }
  return false;
}

interface RawMatch {
  "1. symbol": string;
  "2. name": string;
  "3. type": string;
  "4. region": string;
}

export async function searchStocksAlphaVantage(query: string): Promise<StockSearchResult[] | null> {
  if (!API_KEY || query.trim().length < 1 || isAvExhausted()) return null;
  try {
    const url = `${AV_BASE}/query?${new URLSearchParams({
      function: "SYMBOL_SEARCH",
      keywords: query,
      apikey: API_KEY,
    }).toString()}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    checkAvRateLimit(data);
    // Rate-limited / error responses come back as { Information: "..." } or
    // { Note: "..." } with no bestMatches — treat that as "unavailable",
    // let the caller fall back to TwelveData rather than showing an error.
    if (!Array.isArray(data.bestMatches)) return null;
    return (data.bestMatches as RawMatch[])
      .filter(m => m["3. type"] === "Equity" || m["3. type"] === "ETF")
      .slice(0, 20)
      .map(m => ({
        symbol: m["1. symbol"],
        name: m["2. name"],
        exchange: m["4. region"],
        country: m["4. region"],
        type: m["3. type"],
      }));
  } catch {
    return null;
  }
}

// Maps our interval type to Alpha Vantage's function/interval params. AV has
// no native 4h intraday bucket (only 1/5/15/30/60min, daily, weekly) — that
// one interval isn't supported by the fallback and returns null immediately.
function avFunctionFor(interval: StockInterval): { fn: string; avInterval?: string } | null {
  switch (interval) {
    case "5min": return { fn: "TIME_SERIES_INTRADAY", avInterval: "5min" };
    case "15min": return { fn: "TIME_SERIES_INTRADAY", avInterval: "15min" };
    case "1h": return { fn: "TIME_SERIES_INTRADAY", avInterval: "60min" };
    case "4h": return null;
    case "1day": return { fn: "TIME_SERIES_DAILY" };
    case "1week": return { fn: "TIME_SERIES_WEEKLY" };
  }
}

interface RawCandle {
  "1. open": string;
  "2. high": string;
  "3. low": string;
  "4. close": string;
  "5. volume"?: string;
}

export async function fetchStockCandlesAlphaVantage(
  symbol: string,
  interval: StockInterval,
  outputsize: number,
): Promise<StockCandle[] | null> {
  const mapped = avFunctionFor(interval);
  if (!API_KEY || !mapped || isAvExhausted()) return null;
  try {
    const params: Record<string, string> = { function: mapped.fn, symbol, apikey: API_KEY };
    if (mapped.avInterval) params.interval = mapped.avInterval;
    const url = `${AV_BASE}/query?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    checkAvRateLimit(data);

    // The time-series payload lives under a key whose name varies by
    // function ("Time Series (Daily)", "Weekly Time Series", "Time Series
    // (5min)", ...) — find it rather than hardcoding one name per case.
    const seriesKey = Object.keys(data).find(k => /time series/i.test(k));
    const series = seriesKey ? (data[seriesKey] as Record<string, RawCandle>) : null;
    if (!series) return null; // rate-limited/error response — no such key present

    const candles: StockCandle[] = Object.entries(series)
      .map(([datetime, v]) => ({
        time: Math.floor(new Date(datetime.replace(" ", "T") + "Z").getTime() / 1000),
        open: parseFloat(v["1. open"]),
        high: parseFloat(v["2. high"]),
        low: parseFloat(v["3. low"]),
        close: parseFloat(v["4. close"]),
        volume: v["5. volume"] ? parseFloat(v["5. volume"]) : 0,
      }))
      .sort((a, b) => a.time - b.time)
      .slice(-outputsize);

    return candles.length > 0 ? candles : null;
  } catch {
    return null;
  }
}

// Fallback for most of the ticker strip's index/commodity chips when
// TwelveData has no data for them — never the full batch in one shot, and
// never movers, since those would exhaust the whole 25/day budget (shared
// with search + the candles fallback above) in a single refresh; this is
// still capped to whichever of these are CURRENTLY missing (see
// StockTickerStrip.tsx), fetched one at a time. GLOBAL_QUOTE doesn't support
// raw index tickers (SPX/IXIC return empty — verified live), so these use
// tight-tracking, US-listed equity ETF proxies instead. VIX is deliberately
// excluded: the only tradable "VIX" ETFs (VIXY, VXX) track VIX FUTURES, not
// spot VIX, and bleed value from contango over time — showing that as "VIX"
// would be a materially misleading number, not just an approximation.
export const KEY_INDEX_PROXIES: Record<string, string> = {
  SPX: "SPY",    // S&P 500
  DJI: "DIA",    // Dow 30
  IXIC: "QQQ",   // Nasdaq (tracks the Nasdaq-100, not the full Composite — closest available proxy)
  RUT: "IWM",    // Russell 2000
  "XAU/USD": "GLD",  // Gold
  "WTI/USD": "USO",  // Crude Oil (tracks WTI futures — some tracking drift from contango, but a fair approximation)
};

interface RawGlobalQuote {
  "05. price"?: string;
  "09. change"?: string;
  "10. change percent"?: string;
}

async function fetchGlobalQuote(symbol: string): Promise<{ price: number; change: number; percentChange: number } | null> {
  if (!API_KEY || isAvExhausted()) return null;
  try {
    const url = `${AV_BASE}/query?${new URLSearchParams({ function: "GLOBAL_QUOTE", symbol, apikey: API_KEY }).toString()}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    checkAvRateLimit(data);
    const q = data["Global Quote"] as RawGlobalQuote | undefined;
    if (!q?.["05. price"]) return null;
    return {
      price: parseFloat(q["05. price"]),
      change: parseFloat(q["09. change"] ?? "0") || 0,
      percentChange: parseFloat((q["10. change percent"] ?? "0%").replace("%", "")) || 0,
    };
  } catch {
    return null;
  }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// Only fetches for the index keys actually passed in (caller filters to
// "currently has no data" before calling), and only ones we have a proxy
// for. Sequential with a 1.1s gap between calls — Alpha Vantage's free tier
// also enforces a 1 request/second burst limit, confirmed live (rapid
// parallel calls returned a rate-limit "Information" response instead of
// data during testing).
export async function fetchKeyIndexFallback(
  missingKeys: string[],
): Promise<Map<string, { price: number; change: number; percentChange: number }>> {
  const out = new Map<string, { price: number; change: number; percentChange: number }>();
  const targets = missingKeys.filter(k => KEY_INDEX_PROXIES[k]);
  for (let i = 0; i < targets.length; i++) {
    if (isAvExhausted()) break; // no point waiting out the burst-limit gap for calls that won't fire
    if (i > 0) await wait(1100);
    const key = targets[i];
    const quote = await fetchGlobalQuote(KEY_INDEX_PROXIES[key]);
    if (quote) out.set(key, quote);
  }
  return out;
}
