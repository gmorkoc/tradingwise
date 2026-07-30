import axios from 'axios';
import { coinglass, type CandleDataPoint } from './coinglass';

export type CorrelationAsset = 'BTC' | 'ETH' | 'SOL' | 'XRP' | 'BNB' | 'GOLD' | 'DXY' | 'SPX';
export type CorrelationWindow = '30d' | '90d' | '1y';

export const CORRELATION_ASSETS: CorrelationAsset[] = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'GOLD', 'DXY', 'SPX'];

// GOLD is proxied via Binance PAXG/USDT (tokenized, 1:1-backed gold) rather
// than a traditional gold feed — FRED's free gold series was discontinued.
const CRYPTO_LEGS: { asset: CorrelationAsset; symbol: string }[] = [
  { asset: 'BTC', symbol: 'BTC' },
  { asset: 'ETH', symbol: 'ETH' },
  { asset: 'SOL', symbol: 'SOL' },
  { asset: 'XRP', symbol: 'XRP' },
  { asset: 'BNB', symbol: 'BNB' },
  { asset: 'GOLD', symbol: 'PAXG' },
];

// DXY is proxied via FRED's Broad USD Index (DTWEXBGS) — close enough to
// ICE's narrower DXY for a macro-correlation view, not identical.
const FRED_LEGS: { asset: CorrelationAsset; seriesId: string }[] = [
  { asset: 'DXY', seriesId: 'DTWEXBGS' },
  { asset: 'SPX', seriesId: 'SP500' },
];

const WINDOW_DAYS: Record<CorrelationWindow, number> = { '30d': 30, '90d': 90, '1y': 365 };

export interface CorrelationCell {
  r: number | null;
  n: number;
}

export interface CorrelationMatrix {
  assets: CorrelationAsset[];
  cells: Record<string, CorrelationCell>; // key `${a}:${b}`
  unavailable: CorrelationAsset[];
  window: CorrelationWindow;
  fetchedAt: number;
}

const fredApi = axios.create({ baseURL: '/fred-api', timeout: 15000 });

function toDateKey(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

function returnsFromCandles(candles: CandleDataPoint[]): Map<string, number> {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const map = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].close;
    const cur = sorted[i].close;
    if (prev > 0) map.set(toDateKey(sorted[i].time), cur / prev - 1);
  }
  return map;
}

// FRED CSVs use "." for missing observations (holidays) — filtered out below.
async function fetchFredReturns(seriesId: string, days: number): Promise<Map<string, number>> {
  const res = await fredApi.get('/graph/fredgraph.csv', { params: { id: seriesId } });
  const text: string = res.data;
  const lines = text.trim().split('\n').slice(1);

  const points: { date: string; value: number }[] = [];
  for (const line of lines) {
    const [date, raw] = line.split(',');
    const value = parseFloat(raw);
    if (!date || Number.isNaN(value)) continue;
    points.push({ date, value });
  }

  const cutoff = Date.now() - (days + 5) * 86_400_000;
  const recent = points.filter(p => new Date(p.date).getTime() >= cutoff);

  const map = new Map<string, number>();
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1].value;
    const cur = recent[i].value;
    if (prev > 0) map.set(recent[i].date, cur / prev - 1);
  }
  return map;
}

// Crypto trades 7 days/week while FRED series are business-days-only, so
// series must be inner-joined by calendar date rather than zipped by index —
// sample size `n` will differ per pair and is surfaced to the caller.
function pearson(a: Map<string, number>, b: Map<string, number>): CorrelationCell {
  const dates = [...a.keys()].filter(d => b.has(d));
  const n = dates.length;
  if (n < 5) return { r: null, n };

  const xs = dates.map(d => a.get(d)!);
  const ys = dates.map(d => b.get(d)!);
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return { r: denom > 0 ? num / denom : null, n };
}

const CACHE_TTL = 60 * 60 * 1000;
const matrixCache = new Map<CorrelationWindow, { data: CorrelationMatrix; fetchedAt: number }>();
const inFlight = new Map<CorrelationWindow, Promise<CorrelationMatrix>>();

async function getMatrix(window: CorrelationWindow): Promise<CorrelationMatrix> {
  const cached = matrixCache.get(window);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

  const flying = inFlight.get(window);
  if (flying) return flying;

  const days = WINDOW_DAYS[window];
  const klineLimit = days + 10;

  const promise = (async (): Promise<CorrelationMatrix> => {
    const seriesByAsset = new Map<CorrelationAsset, Map<string, number>>();

    const cryptoResults = await Promise.allSettled(
      CRYPTO_LEGS.map(leg => coinglass.getCandles(leg.symbol, '1d', klineLimit)),
    );
    cryptoResults.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        seriesByAsset.set(CRYPTO_LEGS[i].asset, returnsFromCandles(res.value));
      }
    });

    const fredResults = await Promise.allSettled(
      FRED_LEGS.map(leg => fetchFredReturns(leg.seriesId, days)),
    );
    fredResults.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        seriesByAsset.set(FRED_LEGS[i].asset, res.value);
      }
      // On failure the asset is simply absent — its row/column renders as
      // "unavailable" without breaking the cells that don't depend on it.
    });

    const unavailable = CORRELATION_ASSETS.filter(a => !seriesByAsset.has(a));

    const cells: Record<string, CorrelationCell> = {};
    for (const a of CORRELATION_ASSETS) {
      for (const b of CORRELATION_ASSETS) {
        const key = `${a}:${b}`;
        if (a === b) { cells[key] = { r: 1, n: seriesByAsset.get(a)?.size ?? 0 }; continue; }
        const sa = seriesByAsset.get(a);
        const sb = seriesByAsset.get(b);
        cells[key] = sa && sb ? pearson(sa, sb) : { r: null, n: 0 };
      }
    }

    const data: CorrelationMatrix = { assets: CORRELATION_ASSETS, cells, unavailable, window, fetchedAt: Date.now() };
    matrixCache.set(window, { data, fetchedAt: Date.now() });
    return data;
  })().finally(() => inFlight.delete(window));

  inFlight.set(window, promise);
  return promise;
}

export const correlation = {
  getMatrix,
};
