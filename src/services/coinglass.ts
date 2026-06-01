import axios, { type AxiosInstance } from 'axios';

function addRetry(instance: AxiosInstance, retries = 2) {
  instance.interceptors.response.use(undefined, async (err) => {
    const cfg = err.config;
    if (!cfg) return Promise.reject(err);
    cfg._retry = (cfg._retry ?? 0) + 1;
    if (cfg._retry > retries) return Promise.reject(err);
    await new Promise(r => setTimeout(r, cfg._retry * 1500));
    return instance(cfg);
  });
}

const api = axios.create({
  baseURL: '/cg-api',
  timeout: 15000,
  headers: { accept: 'application/json' },
});
addRetry(api);

// CryptoCompare free API — used for monthly/CME-gap historical data
const ccApi = axios.create({
  baseURL: '/cc-api',
  timeout: 10000,
  headers: { accept: 'application/json' },
});


// Binance public market data CDN — geo-unrestricted, open CORS
const bnApi = axios.create({
  baseURL: 'https://data-api.binance.vision',
  timeout: 10000,
  headers: { accept: 'application/json' },
});


interface CMEGapZone { low: number; high: number; }

interface CMEGap {
  above: CMEGapZone | null;
  below: CMEGapZone | null;
}

interface BTCData {
  price: number;
  liquidationAbove: number;
  liquidationBelow: number;
  openInterest: number;
  fundingRate: number;
  longShortRatio: number;
  rsi: number;
  macd: number;
  macdSignal: number;
  cmeGap: CMEGap | null;
  timestamp: number;
}

interface PriceDataPoint {
  timestamp: number;
  price: number;
  time: string;
}

interface CandleDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export const COINS = [
  { symbol: 'BTC',  name: 'Bitcoin'  },
  { symbol: 'ETH',  name: 'Ethereum' },
  { symbol: 'XRP',  name: 'XRP'      },
  { symbol: 'SOL',  name: 'Solana'   },
  { symbol: 'BNB',  name: 'BNB'      },
  { symbol: 'SUI',  name: 'Sui'      },
  { symbol: 'DOGE', name: 'Dogecoin' },
  { symbol: 'ADA',  name: 'Cardano'  },
] as const;

export type CoinSymbol = typeof COINS[number]['symbol'];

// HOBBYIST plan supports: 4h, 6h, 8h, 12h, 1d, 1w — 1min/1h use CryptoCompare, 1sec uses OKX public API
type TimeInterval = '1sec' | '1min' | '5min' | '15min' | '1h' | '4h' | '6h' | '1day' | '1week';

export type HeatmapRange = '12h' | '1d' | '2d' | '3d' | '1w' | '1m';

const HEATMAP_RANGE: Record<HeatmapRange, { interval: string; limit: number }> = {
  '12h': { interval: '4h', limit: 3  },
  '1d':  { interval: '4h', limit: 6  },
  '2d':  { interval: '4h', limit: 12 },
  '3d':  { interval: '4h', limit: 18 },
  '1w':  { interval: '4h', limit: 42 },
  '1m':  { interval: '1d', limit: 30 },
};

type CgInterval = Exclude<TimeInterval, '1sec' | '1min' | '5min' | '15min' | '1h'>;
const CG_INTERVAL: Record<CgInterval, { interval: string; limit: number }> = {
  '4h':    { interval: '4h', limit: 168 },
  '6h':    { interval: '6h', limit: 60  },
  '1day':  { interval: '1d', limit: 90  },
  '1week': { interval: '1w', limit: 52  },
};

// Unique CG intervals used by getIntervalTrends — avoids duplicate requests
const UNIQUE_CG_INTERVALS = [
  { interval: '4h', limit: 42 },
  { interval: '6h', limit: 60 },
  { interval: '1d', limit: 30 },
  { interval: '1w', limit: 52 },
] as const;

function toCgSymbol(coin: CoinSymbol | string): string {
  return `${coin}USDT`;
}

// In-flight deduplication + result cache with stale-fallback on 429.
// fresh = served directly; stale = served when rate-limited so the UI never goes blank.
const CACHE_TTL = 30_000;
const candleCache = new Map<string, { data: CandleDataPoint[]; fetchedAt: number }>();
const candleInFlight = new Map<string, Promise<CandleDataPoint[]>>();

async function fetchPriceCandles(
  coin: CoinSymbol | string,
  interval: string,
  limit: number,
): Promise<CandleDataPoint[]> {
  const key = `${toCgSymbol(coin)}:${interval}:${limit}`;

  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

  const flying = candleInFlight.get(key);
  if (flying) return flying;

  const params = { symbol: toCgSymbol(coin), interval, limit, exchange: 'Binance' };

  const doFetch = async (): Promise<CandleDataPoint[]> => {
    const res = await api.get('futures/price/history', { params });
    if (res.data?.code !== '0') return cached?.data ?? [];
    const data = (res.data.data as { time: number; open: string; high: string; low: string; close: string; vol?: string }[])
      .map(c => ({
        time:   Math.floor(c.time / 1000),
        open:   parseFloat(c.open),
        high:   parseFloat(c.high),
        low:    parseFloat(c.low),
        close:  parseFloat(c.close),
        volume: c.vol ? parseFloat(c.vol) : undefined,
      }));
    candleCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  };

  const promise = (async (): Promise<CandleDataPoint[]> => {
    try {
      return await doFetch();
    } catch (err) {
      // Rate-limited: wait 5 s then retry once before falling back to stale data
      if (axios.isAxiosError(err) && err.response?.status === 429) {
        await new Promise(r => setTimeout(r, 5_000));
        try { return await doFetch(); } catch { /* fall through */ }
      }
      return cached?.data ?? [];
    } finally {
      candleInFlight.delete(key);
    }
  })();

  candleInFlight.set(key, promise);
  return promise;
}


async function fetchBinanceKlines(
  coin: CoinSymbol | string,
  interval: string,
  limit: number,
): Promise<CandleDataPoint[]> {
  const symbol = `${coin}USDT`;
  const key = `bn:${symbol}:${interval}:${limit}`;
  const ttl = interval === '1s' ? 2_000 : CACHE_TTL;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.data;

  const flying = candleInFlight.get(key);
  if (flying) return flying;

  const doFetch = async (): Promise<CandleDataPoint[]> => {
    const MAX_PER_REQ = 1000;
    const raw: (string | number)[][] = [];
    let remaining = limit;
    let endTime: number | undefined = undefined;

    while (remaining > 0) {
      const params: Record<string, string | number> = {
        symbol, interval, limit: Math.min(remaining, MAX_PER_REQ),
      };
      if (endTime !== undefined) params.endTime = endTime;
      const res = await bnApi.get('/api/v3/klines', { params });
      const page = res.data as (string | number)[][];
      if (!page.length) break;
      raw.unshift(...page);
      remaining -= page.length;
      endTime = (page[0][0] as number) - 1;
      if (page.length < MAX_PER_REQ) break;
    }

    const data: CandleDataPoint[] = raw.map(c => ({
      time:   Math.floor((c[0] as number) / 1000),
      open:   parseFloat(c[1] as string),
      high:   parseFloat(c[2] as string),
      low:    parseFloat(c[3] as string),
      close:  parseFloat(c[4] as string),
      volume: parseFloat(c[5] as string),
    }));
    candleCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  };

  const promise = (async (): Promise<CandleDataPoint[]> => {
    try { return await doFetch(); }
    catch { return cached?.data ?? []; }
    finally { candleInFlight.delete(key); }
  })();

  candleInFlight.set(key, promise);
  return promise;
}


async function fetchCryptoCompareHourlyCandles(
  coin: CoinSymbol | string,
  limit: number,
): Promise<CandleDataPoint[]> {
  const key = `cc:${coin}:1h:${limit}`;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;
  const flying = candleInFlight.get(key);
  if (flying) return flying;

  const doFetch = async (): Promise<CandleDataPoint[]> => {
    const res = await ccApi.get('/data/histohour', {
      params: { fsym: coin, tsym: 'USD', limit },
    });
    if (res.data?.Response !== 'Success') return cached?.data ?? [];
    const data = (res.data.Data as { time: number; open: number; high: number; low: number; close: number; volumeto: number }[])
      .map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volumeto }));
    candleCache.set(key, { data, fetchedAt: Date.now() });
    return data;
  };

  const promise = (async (): Promise<CandleDataPoint[]> => {
    try { return await doFetch(); }
    catch { return cached?.data ?? []; }
    finally { candleInFlight.delete(key); }
  })();

  candleInFlight.set(key, promise);
  return promise;
}

function computeCMEGap(spotCandles: CandleDataPoint[], currentPrice: number): CMEGap {
  // CME BTC futures close Friday ~21:00 UTC and reopen Sunday ~22:00 UTC.
  // We approximate gap prices using BTC spot hourly candles at those times.
  // Fill rule: gap is filled when price returns to the pre-gap Friday close level.

  if (spotCandles.length < 50) return { above: null, below: null };

  type Gap = { fridayClose: number; sundayOpen: number; sundayIdx: number; low: number; high: number };
  const gaps: Gap[] = [];
  const usedSundayIdx = new Set<number>();

  for (let i = 0; i < spotCandles.length; i++) {
    const c = spotCandles[i];
    const d = new Date(c.time * 1000);
    if (d.getUTCDay() !== 5) continue;        // Fridays only
    const h = d.getUTCHours();
    if (h < 20 || h > 22) continue;           // CME close window: 20–22 UTC

    // Find the Sunday CME-open candle: 44–56 hours later, Sunday 21–23 UTC
    for (let j = i + 1; j < spotCandles.length; j++) {
      const diff = spotCandles[j].time - c.time;
      if (diff < 44 * 3600) continue;
      if (diff > 56 * 3600) break;
      const sd = new Date(spotCandles[j].time * 1000);
      if (sd.getUTCDay() !== 0) continue;
      const sh = sd.getUTCHours();
      if (sh < 21 || sh > 23) continue;
      if (usedSundayIdx.has(j)) break;

      const fridayClose = c.close;
      const sundayOpen  = spotCandles[j].open;
      const low  = Math.min(fridayClose, sundayOpen);
      const high = Math.max(fridayClose, sundayOpen);

      usedSundayIdx.add(j);
      if ((high - low) / low >= 0.001) {
        gaps.push({ fridayClose, sundayOpen, sundayIdx: j, low, high });
      }
      break;
    }
  }

  // Filled = price returned to the pre-gap Friday close level after gap opened
  const unfilled = gaps.filter(gap => {
    const isDownGap = gap.sundayOpen < gap.fridayClose;
    for (let i = gap.sundayIdx + 1; i < spotCandles.length; i++) {
      const c = spotCandles[i];
      if (isDownGap  && c.high >= gap.fridayClose) return false;
      if (!isDownGap && c.low  <= gap.fridayClose) return false;
    }
    return true;
  });

  console.debug('[CME] gaps:', gaps.length, 'unfilled:', unfilled.length,
    'price:', Math.round(currentPrice),
    unfilled.map(g => `${Math.round(g.low)}–${Math.round(g.high)}`));

  // "above" = fill target is above current price (includes gaps where price is inside the zone)
  // "below" = gap is entirely below current price
  const aboveGaps = unfilled.filter(g => g.high > currentPrice).sort((a, b) => a.low - b.low);
  const belowGaps = unfilled.filter(g => g.high < currentPrice).sort((a, b) => b.high - a.high);

  return {
    above: aboveGaps[0] ? { low: aboveGaps[0].low, high: aboveGaps[0].high } : null,
    below: belowGaps[0] ? { low: belowGaps[0].low, high: belowGaps[0].high } : null,
  };
}

export const coinglass = {
  getBTCPrice: async (coin: CoinSymbol | string = 'BTC', candles?: CandleDataPoint[]): Promise<number> => {
    const data = candles ?? await fetchPriceCandles(coin, '4h', 1);
    return data[data.length - 1]?.close ?? 0;
  },

  getLiquidationLevels: (candles: CandleDataPoint[]): { above: number; below: number } => {
    if (!candles.length) return { above: 0, below: 0 };
    const prices = candles.map(c => c.close);
    const current = prices[prices.length - 1];
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const vol = Math.abs(current - avg);
    return { above: current + vol * 2, below: current - vol * 2 };
  },

  calculateRSI: (closes: number[], period = 14): number => {
    if (closes.length <= period) return 0;
    const recent = closes.slice(-period - 1);
    let gain = 0, loss = 0;
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i] - recent[i - 1];
      if (d > 0) gain += d; else loss += Math.abs(d);
    }
    const avgGain = gain / period;
    const avgLoss = loss / period;
    if (avgLoss === 0) return 100;
    return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 10) / 10;
  },

  calculateEMA: (values: number[], period: number): (number | undefined)[] => {
    const ema: (number | undefined)[] = [];
    if (values.length < period) return ema;
    ema[period - 1] = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    const k = 2 / (period + 1);
    for (let i = period; i < values.length; i++)
      ema[i] = (values[i] - (ema[i - 1] as number)) * k + (ema[i - 1] as number);
    return ema;
  },

  calculateMACD: (closes: number[]) => {
    if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
    const ema12 = coinglass.calculateEMA(closes, 12);
    const ema26 = coinglass.calculateEMA(closes, 26);
    const macdLine: number[] = [];
    for (let i = 0; i < closes.length; i++)
      if (ema12[i] !== undefined && ema26[i] !== undefined)
        macdLine[i] = (ema12[i] as number) - (ema26[i] as number);
    const valid = macdLine.slice(25);
    if (valid.length < 9) return { macd: 0, signal: 0, histogram: 0 };
    const sig = coinglass.calculateEMA(valid, 9).filter((v): v is number => v !== undefined);
    const macd   = valid[valid.length - 1] ?? 0;
    const signal = sig[sig.length - 1] ?? 0;
    return {
      macd:      Math.round(macd * 100) / 100,
      signal:    Math.round(signal * 100) / 100,
      histogram: Math.round((macd - signal) * 100) / 100,
    };
  },

  getAllBTCData: async (coin: CoinSymbol | string = 'BTC'): Promise<Partial<BTCData> | null> => {
    try {
      const symbol = toCgSymbol(coin);

      const [candlesRes, oiRes, frRes, cmeRes] = await Promise.all([
        fetchPriceCandles(coin, '4h', 42),
        api.get('futures/open-interest/history', {
          params: { symbol, interval: '4h', limit: 1, exchange: 'Binance' },
        }).catch(() => null),
        api.get('futures/funding-rate/history', {
          params: { symbol, interval: '4h', limit: 1, exchange: 'Binance' },
        }).catch(() => null),
        fetchCryptoCompareHourlyCandles(coin, 1440).catch(() => [] as CandleDataPoint[]),
      ]);

      const candles = candlesRes;
      if (!candles.length) return null;

      const price = candles[candles.length - 1].close;
      const liquidation = coinglass.getLiquidationLevels(candles);

      const openInterest = oiRes?.data?.code === '0'
        ? parseFloat(oiRes.data.data?.[0]?.close ?? '0')
        : 0;

      const fundingRate = frRes?.data?.code === '0'
        ? parseFloat(frRes.data.data?.[0]?.close ?? '0')
        : 0;

      const closes = candles.map(c => c.close);
      const rsi = coinglass.calculateRSI(closes);
      const macdData = coinglass.calculateMACD(closes);

      const longShortRatio = fundingRate >= 0
        ? 1 + Math.min(fundingRate * 200, 0.5)
        : 1 / (1 + Math.min(Math.abs(fundingRate) * 200, 0.5));

      return {
        price,
        liquidationAbove: liquidation.above,
        liquidationBelow: liquidation.below,
        openInterest,
        fundingRate,
        longShortRatio,
        rsi,
        macd: macdData.macd,
        macdSignal: macdData.signal,
        cmeGap: computeCMEGap(cmeRes, price),
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  },

  getHistoricalCandles: async (interval: TimeInterval, coin: CoinSymbol | string = 'BTC'): Promise<CandleDataPoint[]> => {
    if (interval === '1sec')  return fetchBinanceKlines(coin, '1s',  1800);
    if (interval === '1min')  return fetchBinanceKlines(coin, '1m',  60);
    if (interval === '5min')  return fetchBinanceKlines(coin, '5m',  288);
    if (interval === '15min') return fetchBinanceKlines(coin, '15m', 192);
    if (interval === '1h')    return fetchBinanceKlines(coin, '1h',  168);
    const { interval: cgInterval, limit } = CG_INTERVAL[interval as CgInterval];
    return fetchPriceCandles(coin, cgInterval, limit);
  },

  get24hMinuteCandles: async (coin: CoinSymbol | string = 'BTC', limit = 1440): Promise<CandleDataPoint[]> => {
    return fetchBinanceKlines(coin, '1m', limit);
  },

  getLiveSecondCandle: async (coin: CoinSymbol | string = 'BTC'): Promise<CandleDataPoint | null> => {
    try {
      const res = await bnApi.get('/api/v3/klines', {
        params: { symbol: `${coin}USDT`, interval: '1s', limit: 2 },
      });
      const arr = res.data as (string | number)[][];
      const c = arr[arr.length - 1];
      if (!c) return null;
      return {
        time:   Math.floor((c[0] as number) / 1000),
        open:   parseFloat(c[1] as string),
        high:   parseFloat(c[2] as string),
        low:    parseFloat(c[3] as string),
        close:  parseFloat(c[4] as string),
        volume: parseFloat(c[5] as string),
      };
    } catch {
      return null;
    }
  },

  getLiveMinuteCandle: async (coin: CoinSymbol | string = 'BTC'): Promise<CandleDataPoint | null> => {
    try {
      const res = await bnApi.get('/api/v3/klines', {
        params: { symbol: `${coin}USDT`, interval: '1m', limit: 2 },
      });
      const arr = res.data as (string | number)[][];
      const c = arr[arr.length - 1];
      if (!c) return null;
      return {
        time:   Math.floor((c[0] as number) / 1000),
        open:   parseFloat(c[1] as string),
        high:   parseFloat(c[2] as string),
        low:    parseFloat(c[3] as string),
        close:  parseFloat(c[4] as string),
        volume: parseFloat(c[5] as string),
      };
    } catch {
      return null;
    }
  },

  getHeatmapCandles: async (range: HeatmapRange, coin: CoinSymbol | string = 'BTC'): Promise<CandleDataPoint[]> => {
    const { interval, limit } = HEATMAP_RANGE[range];
    return fetchPriceCandles(coin, interval, limit);
  },

  getIntervalTrends: async (coin: CoinSymbol | string = 'BTC'): Promise<Record<TimeInterval, 'bullish' | 'bearish' | null>> => {
    const trend = (candles: CandleDataPoint[]): 'bullish' | 'bearish' | null => {
      if (candles.length < 2) return null;
      return candles[candles.length - 1].close >= candles[0].close ? 'bullish' : 'bearish';
    };

    const [cgFetched, minCandles] = await Promise.all([
      Promise.all(
        UNIQUE_CG_INTERVALS.map(({ interval, limit }) =>
          fetchPriceCandles(coin, interval, limit).then(candles => ({ interval, candles }))
        )
      ),
      fetchBinanceKlines(coin, '1m', 60),
    ]);

    const candleMap = Object.fromEntries(
      cgFetched.map((f: { interval: string; candles: CandleDataPoint[] }) => [f.interval, f.candles])
    );
    const cgTrends = Object.fromEntries(
      (Object.keys(CG_INTERVAL) as CgInterval[]).map(iv => [iv, trend(candleMap[CG_INTERVAL[iv].interval] ?? [])])
    );

    return { '1min': trend(minCandles), ...cgTrends } as Record<TimeInterval, 'bullish' | 'bearish' | null>;
  },

  getHTFCandles: async (coin: CoinSymbol | string = 'BTC'): Promise<CandleDataPoint[]> => {
    return fetchPriceCandles(coin, '1w', 260);
  },

  getMonthlyReturns: async (coin: CoinSymbol | string = 'BTC'): Promise<MonthlyReturn[]> => {
    const cacheKey = `monthly:${coin}`;
    const cached = monthlyCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 3_600_000) return cached.data;

    const fetchChunk = async (toTs?: number): Promise<{ time: number; open: number; close: number }[]> => {
      try {
        const params: Record<string, string | number> = { fsym: coin, tsym: 'USD', limit: 2000 };
        if (toTs) params.toTs = toTs;
        const res = await ccApi.get('/data/histoday', { params });
        if (res.data?.Response !== 'Success') return [];
        return (res.data.Data as { time: number; open: number; close: number }[])
          .filter(c => c.time > 0 && c.open > 0 && c.close > 0);
      } catch { return []; }
    };

    const chunk1 = await fetchChunk();
    if (chunk1.length === 0) return [];
    const chunk2 = await fetchChunk(chunk1[0].time - 1);
    const chunk3 = chunk2.length > 0 ? await fetchChunk(chunk2[0].time - 1) : [];

    const allDays = [...chunk3, ...chunk2, ...chunk1]
      .filter((c, i, arr) => i === 0 || arr[i - 1].time !== c.time)
      .sort((a, b) => a.time - b.time);

    const monthMap = new Map<string, { year: number; month: number; open: number; close: number }>();
    for (const c of allDays) {
      const d = new Date(c.time * 1000);
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth();
      const key = `${year}-${month}`;
      const ex = monthMap.get(key);
      if (!ex) monthMap.set(key, { year, month, open: c.open, close: c.close });
      else ex.close = c.close;
    }

    const result: MonthlyReturn[] = Array.from(monthMap.values())
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .map(m => ({ ...m, pct: (m.close / m.open - 1) * 100 }));

    monthlyCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  },

  getHistoricalPrices: async (interval: TimeInterval): Promise<PriceDataPoint[]> => {
    try {
      const candles = await coinglass.getHistoricalCandles(interval, 'BTC');
      return candles.map(c => {
        const date = new Date(c.time * 1000);
        let timeString = '';
        if (interval === '1min' || interval === '4h' || interval === '6h') {
          timeString = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        } else {
          timeString = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
        return { timestamp: c.time * 1000, price: c.close, time: timeString };
      });
    } catch {
      return [];
    }
  },
};

export interface MonthlyReturn {
  year: number;
  month: number;
  open: number;
  close: number;
  pct: number;
}

const monthlyCache = new Map<string, { data: MonthlyReturn[]; fetchedAt: number }>();

// ── Trader Position Data ──────────────────────────────────────────────────────

export interface LSRatioPoint {
  time: number;
  longRatio: number;   // 0–1
  shortRatio: number;  // 0–1
}

export interface PositionData {
  retail: LSRatioPoint[];
  smartMoney: LSRatioPoint[];
}

function parseLSRatio(raw: Record<string, number | string>[], longKey: string, shortKey: string): LSRatioPoint[] {
  return raw.map(d => ({
    time:       Math.floor(Number(d.time) / 1000),
    longRatio:  Number(d[longKey])  / 100,
    shortRatio: Number(d[shortKey]) / 100,
  }));
}

export async function getPositionData(coin: CoinSymbol | string = 'BTC'): Promise<PositionData> {
  const symbol = toCgSymbol(coin);
  const params = { symbol, interval: '4h', limit: 180, exchange: 'Binance' };

  const [retailRes, smartRes] = await Promise.all([
    api.get('futures/global-long-short-account-ratio/history', { params }).catch(() => null),
    api.get('futures/top-long-short-account-ratio/history',    { params }).catch(() => null),
  ]);

  return {
    retail:     retailRes?.data?.code === '0'
      ? parseLSRatio(retailRes.data.data ?? [], 'global_account_long_percent', 'global_account_short_percent')
      : [],
    smartMoney: smartRes?.data?.code  === '0'
      ? parseLSRatio(smartRes.data.data  ?? [], 'top_account_long_percent',    'top_account_short_percent')
      : [],
  };
}

export async function getPriceCandles(
  coin: CoinSymbol | string,
  interval: string,
  limit: number,
): Promise<CandleDataPoint[]> {
  return fetchPriceCandles(coin, interval, limit);
}

export function clearCandleCache(): void {
  // Expire all entries so the next fetch triggers a fresh request,
  // but keep the stale data in place so a 429 response can fall back to it.
  for (const [key, entry] of candleCache) {
    candleCache.set(key, { ...entry, fetchedAt: 0 });
  }
  candleInFlight.clear();
}

export type { BTCData, PriceDataPoint, CandleDataPoint };
