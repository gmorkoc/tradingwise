import axios from 'axios';

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

function parseError(data: unknown): string | null {
  if (data && typeof data === 'object' && 'status' in data && (data as { status?: string }).status === 'error') {
    return (data as { message?: string }).message ?? 'Unknown error';
  }
  return null;
}

export async function searchStocks(query: string): Promise<StockSearchResult[]> {
  if (!API_KEY || query.trim().length < 1) return [];
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
}

export async function fetchStockCandles(
  symbol: string,
  interval: StockInterval,
  outputsize = 300,
): Promise<{ candles: StockCandle[]; error: string | null }> {
  if (!API_KEY) return { candles: [], error: 'missing_api_key' };
  try {
    const res = await td.get('/time_series', {
      params: { symbol, interval, outputsize, apikey: API_KEY, order: 'ASC' },
    });
    const apiError = parseError(res.data);
    if (apiError) return { candles: [], error: apiError };

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
