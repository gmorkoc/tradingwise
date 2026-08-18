// TwelveData quote fetching for the Stocks homepage — market ticker strip
// (indices/commodities) and a watchlist-based movers list (gainers/losers/
// most active). TwelveData's free tier has no native "market movers"
// endpoint, so movers are computed client-side from a curated watchlist,
// not screened across the full market — see StockMovers.tsx's disclaimer.
//
// The free tier is 800 requests/DAY total, shared across every visitor to
// the deployed app — not just a per-minute cap. Callers (StockTickerStrip,
// StockMovers) poll via usePollWhileVisible with intervals sized against
// that daily budget, not just an instantaneous rate limit; see the comments
// at each call site for the reasoning. fetchStockCandles in twelvedata.ts
// falls back to Alpha Vantage when TwelveData itself errors (e.g. quota
// exhausted) — that fallback doesn't apply here, since these are batched
// multi-symbol calls Alpha Vantage's free tier can't support.

import { isTdQuotaExhausted, checkTdQuotaResponse } from "./twelveDataStatus";

const TD_BASE = "/td-api";
const API_KEY = import.meta.env.VITE_TWELVEDATA_API_KEY as string | undefined;

export const hasStockApiKey = Boolean(API_KEY);

// ── Module-level TTL cache, keyed by request URL ────────────────────────────
const cache: Record<string, { data: unknown; ts: number }> = {};

async function tdFetch<T>(path: string, params: Record<string, string>, ttl: number): Promise<T> {
  const url = `${TD_BASE}${path}?${new URLSearchParams({ ...params, apikey: API_KEY ?? "" }).toString()}`;
  const now = Date.now();
  const cached = cache[url];
  if (cached && now - cached.ts < ttl) return cached.data as T;
  // Known-exhausted for the day — skip the network round-trip entirely
  // rather than hitting an endpoint that will just error again.
  if (isTdQuotaExhausted()) throw new Error("td_quota_exhausted");
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const data = await res.json().catch(() => null);
  if (checkTdQuotaResponse(data)) throw new Error("td_quota_exhausted");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  cache[url] = { data, ts: now };
  return data as T;
}

export interface QuoteRow {
  symbol: string;
  name: string;
  price: number;
  change: number;
  percentChange: number;
  volume: number;
}

interface RawQuote {
  symbol?: string;
  name?: string;
  close?: string;
  change?: string;
  percent_change?: string;
  volume?: string;
  status?: string;
}

function parseQuote(raw: RawQuote | undefined, fallbackSymbol: string): QuoteRow | null {
  if (!raw || raw.status === "error" || raw.close == null) return null;
  const price = parseFloat(raw.close);
  if (!isFinite(price)) return null;
  return {
    symbol: raw.symbol ?? fallbackSymbol,
    name: raw.name ?? fallbackSymbol,
    price,
    change: parseFloat(raw.change ?? "0") || 0,
    percentChange: parseFloat(raw.percent_change ?? "0") || 0,
    volume: parseFloat(raw.volume ?? "0") || 0,
  };
}

// Batched /quote call — comma-separated symbols in ONE request. TwelveData
// returns a single object (not keyed by symbol) when only one symbol
// resolves, and a {symbol: quote} map when multiple do — handle both shapes,
// and let individual symbols fail/be omitted rather than erroring the batch.
async function fetchQuoteBatch(symbols: string[]): Promise<Map<string, QuoteRow>> {
  const out = new Map<string, QuoteRow>();
  if (!API_KEY || symbols.length === 0) return out;
  try {
    const data = await tdFetch<Record<string, unknown>>(
      "/quote",
      { symbol: symbols.join(",") },
      5 * 60_000,
    );
    const isSingle = typeof data.symbol === "string";
    for (const sym of symbols) {
      const raw = (isSingle ? data : data[sym]) as RawQuote | undefined;
      const row = parseQuote(raw, sym);
      if (row) out.set(sym, row);
    }
  } catch {
    // whole batch failed (network/rate-limit) — caller treats this as "no data yet", not an error
  }
  return out;
}

// ── Ticker strip: indices + commodities ─────────────────────────────────────
// This is a FIXED list — the strip always shows exactly these 7 slots (+BTC,
// added separately in StockTickerStrip.tsx), same as Yahoo Finance's ticker
// bar. Individual symbols can still fail to resolve on TwelveData's free
// tier, but the caller renders a placeholder for those rather than shrinking
// the row — the set of chips must never change shape based on API success.
export const INDEX_SYMBOLS: { symbol: string; label: string }[] = [
  { symbol: "SPX", label: "S&P 500" },
  { symbol: "DJI", label: "Dow 30" },
  { symbol: "IXIC", label: "Nasdaq" },
  { symbol: "RUT", label: "Russell 2000" },
  { symbol: "VIX", label: "VIX" },
  { symbol: "XAU/USD", label: "Gold" },
  { symbol: "WTI/USD", label: "Crude Oil" },
];

// Returns a lookup keyed by symbol — deliberately NOT filtered down to only
// the symbols that resolved, so the caller can tell "no data yet" apart from
// "this symbol doesn't exist" and still render a fixed-shape row either way.
export async function fetchIndicesAndCommodities(): Promise<Map<string, QuoteRow>> {
  return fetchQuoteBatch(INDEX_SYMBOLS.map(s => s.symbol));
}

// ── Sparklines: one batched intraday /time_series call for the whole strip ──
// Deliberately a SEPARATE, lower-frequency call from the quote batch above —
// a sparkline doesn't need 60s freshness, and keeping it separate means one
// slow/failed sparkline fetch never blocks the price/% chips from showing.
interface RawSeriesPoint { datetime: string; close: string }
interface RawSeries { values?: RawSeriesPoint[]; status?: string }

export async function fetchIndexSparklines(symbols: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!API_KEY || symbols.length === 0) return out;
  try {
    const data = await tdFetch<Record<string, unknown>>(
      "/time_series",
      { symbol: symbols.join(","), interval: "15min", outputsize: "26" },
      15 * 60_000,
    );
    const isSingle = Array.isArray((data as RawSeries).values);
    for (const sym of symbols) {
      const raw = (isSingle ? data : data[sym]) as RawSeries | undefined;
      if (!raw?.values || raw.status === "error") continue;
      const closes = raw.values.map(v => parseFloat(v.close)).filter(isFinite).reverse();
      if (closes.length >= 2) out.set(sym, closes);
    }
  } catch {
    // sparklines are decorative — a failed fetch just means no sparkline this cycle
  }
  return out;
}

// ── Movers: watchlist-based gainers/losers/most-active ──────────────────────
// A curated set of liquid large-cap US stocks across sectors, NOT a
// market-wide screen — TwelveData's free tier has no movers endpoint.
export const MOVERS_WATCHLIST = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA",
  "JPM", "V", "MA", "BAC",
  "WMT", "HD", "PG", "UNH", "JNJ",
  "XOM", "CVX",
  "DIS", "NFLX", "ADBE", "CRM",
  "AMD", "INTC", "PYPL", "COIN",
];

export interface StockMovers {
  gainers: QuoteRow[];
  losers: QuoteRow[];
  mostActive: QuoteRow[];
}

export async function fetchStockMovers(): Promise<StockMovers> {
  const quotes = Array.from((await fetchQuoteBatch(MOVERS_WATCHLIST)).values());
  const byChange = [...quotes].sort((a, b) => b.percentChange - a.percentChange);
  const byVolume = [...quotes].sort((a, b) => b.volume - a.volume);
  return {
    gainers: byChange.slice(0, 5),
    losers: byChange.slice(-5).reverse(),
    mostActive: byVolume.slice(0, 5),
  };
}
