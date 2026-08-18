import axios from 'axios';
import { searchStocksAlphaVantage, fetchStockCandlesAlphaVantage } from './alphavantage';
import { isTdQuotaExhausted, checkTdQuotaResponse } from './twelveDataStatus';

const API_KEY = import.meta.env.VITE_TWELVEDATA_API_KEY as string | undefined;

export const hasStockApiKey = Boolean(API_KEY);

const td = axios.create({
  baseURL: 'https://api.twelvedata.com',
  timeout: 10000,
});

export interface StockCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  country: string;
  type: string;
}

export type StockInterval = '5min' | '15min' | '1h' | '4h' | '1day' | '1week';

// Simple TTL cache, keyed by request signature — avoids repeat network calls
// (e.g. re-selecting the same symbol/interval) eating into the free tier's
// ~8 req/min rate limit, same pattern used by marketOverview.ts.
const cache: Record<string, { data: unknown; ts: number }> = {};
const SEARCH_TTL = 60_000;
const CANDLES_TTL = 60_000;

function cached<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
  shouldCache: (data: T) => boolean = () => true,
): Promise<T> {
  const now = Date.now();
  const hit = cache[key];
  if (hit && now - hit.ts < ttl) return Promise.resolve(hit.data as T);
  return fetcher().then(data => {
    if (shouldCache(data)) cache[key] = { data, ts: now };
    return data;
  });
}

function parseError(data: unknown): string | null {
  if (data && typeof data === 'object' && 'status' in data && (data as { status?: string }).status === 'error') {
    checkTdQuotaResponse(data); // trips the shared circuit breaker if this is the daily-quota response
    return (data as { message?: string }).message ?? 'Unknown error';
  }
  return null;
}

// Alpha Vantage is tried first (primary), TwelveData is the fallback — used
// whenever Alpha Vantage is unavailable (no key, network error, or its
// 25/day quota is exhausted) or returns no matches. See alphavantage.ts for
// why Alpha Vantage is search-only and not used for the ticker strip/movers.
export async function searchStocks(query: string): Promise<StockSearchResult[]> {
  if (query.trim().length < 1) return [];
  return cached(`search:${query}`, SEARCH_TTL, async () => {
    const avResults = await searchStocksAlphaVantage(query);
    if (avResults && avResults.length > 0) return avResults;

    if (!API_KEY || isTdQuotaExhausted()) return [];
    try {
      const res = await td.get('/symbol_search', { params: { symbol: query, apikey: API_KEY } });
      const rows: Array<{ symbol: string; instrument_name: string; exchange: string; country: string; instrument_type: string }> =
        res.data?.data ?? [];
      return rows
        .filter(r => r.instrument_type === 'Common Stock' || r.instrument_type === 'ETF')
        .slice(0, 20)
        .map(r => ({
          symbol: r.symbol,
          name: r.instrument_name,
          exchange: r.exchange,
          country: r.country,
          type: r.instrument_type,
        }));
    } catch {
      return [];
    }
  }, results => results.length > 0);
}

// TwelveData is primary here (chart data has always come from it and works
// well); Alpha Vantage is only tried as a FALLBACK when TwelveData itself
// fails — network error, or an API-level error response like the daily
// quota being exhausted. Both providers share Alpha Vantage's 25/day budget
// with searchStocks() above, so this is a last resort, not routine traffic.
// Internal-only codes used by fetchFromTwelveData/fetchStockCandles's early
// exits — never meant to reach the UI directly, only used to decide flow.
// humanizeError() below translates these (and a missing-AV-fallback case)
// into an actual message before anything is returned to the caller.
function humanizeError(code: string | null, avAttempted: boolean): string | null {
  if (code === null) return null;
  if (code === 'missing_api_key') return 'Stock data requires a TwelveData API key.';
  if (code === 'td_quota_exhausted') {
    return avAttempted
      ? 'Both data providers have hit their daily request limits. Try again later.'
      : 'TwelveData has hit its daily request limit. Try again later.';
  }
  return code; // a genuine API error message (e.g. "Invalid symbol") — show as-is
}

export async function fetchStockCandles(
  symbol: string,
  interval: StockInterval,
  outputsize = 300,
): Promise<{ candles: StockCandle[]; error: string | null }> {
  return cached(`candles:${symbol}:${interval}:${outputsize}`, CANDLES_TTL, async () => {
    const tdResult = await fetchFromTwelveData(symbol, interval, outputsize);
    if (tdResult.candles.length > 0) return tdResult;

    const avCandles = await fetchStockCandlesAlphaVantage(symbol, interval, outputsize);
    if (avCandles && avCandles.length > 0) return { candles: avCandles, error: null };

    // neither provider had data — surface a clean, honest message instead of
    // an internal placeholder code
    return { candles: [], error: humanizeError(tdResult.error, true) };
  }, result => result.error === null);
}

async function fetchFromTwelveData(
  symbol: string,
  interval: StockInterval,
  outputsize: number,
): Promise<{ candles: StockCandle[]; error: string | null }> {
  if (!API_KEY) return { candles: [], error: 'missing_api_key' };
  // Known-exhausted for the day — skip straight to the Alpha Vantage
  // fallback in fetchStockCandles() instead of hitting a dead endpoint.
  if (isTdQuotaExhausted()) return { candles: [], error: 'td_quota_exhausted' };
  try {
    const res = await td.get('/time_series', {
      params: { symbol, interval, outputsize, apikey: API_KEY, order: 'ASC' },
    });
    const apiError = parseError(res.data);
    if (apiError) {
      // parseError() already tripped the circuit breaker if this was a quota
      // response — route through the same internal code so humanizeError()
      // shows the friendly message on this first detection too, not just on
      // later calls that hit the isTdQuotaExhausted() fast-path above.
      if (isTdQuotaExhausted()) return { candles: [], error: 'td_quota_exhausted' };
      return { candles: [], error: apiError };
    }

    const values: Array<{ datetime: string; open: string; high: string; low: string; close: string; volume?: string }> =
      res.data?.values ?? [];

    const candles: StockCandle[] = values.map(v => ({
      time: Math.floor(new Date(v.datetime.replace(' ', 'T') + 'Z').getTime() / 1000),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0,
    }));

    return { candles, error: null };
  } catch (err) {
    const message = axios.isAxiosError(err) ? err.response?.data?.message ?? err.message : 'Network error';
    return { candles: [], error: message };
  }
}
