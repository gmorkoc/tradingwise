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



// Binance public market data CDN — geo-unrestricted, open CORS
const bnApi = axios.create({
  baseURL: 'https://data-api.binance.vision',
  timeout: 20000,
  headers: { accept: 'application/json' },
});
addRetry(bnApi);


interface CMEGapZone { low: number; high: number; }

interface CMEGap {
  above: CMEGapZone | null;
  below: CMEGapZone | null;
}

export interface ExchangeActivity {
  exchange: string;
  fundingRate: number;   // raw, e.g. 0.0001
  fundingPct: string;    // formatted, e.g. "+0.0100%"
  priceChange: number;   // 4h price change %
  signal: 'buying' | 'selling' | 'neutral';
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
  // Majors
  { symbol: 'BTC',     name: 'Bitcoin'           },
  { symbol: 'ETH',     name: 'Ethereum'          },
  { symbol: 'BNB',     name: 'BNB'               },
  { symbol: 'SOL',     name: 'Solana'            },
  { symbol: 'XRP',     name: 'XRP'               },
  { symbol: 'ADA',     name: 'Cardano'           },
  { symbol: 'AVAX',    name: 'Avalanche'         },
  { symbol: 'DOT',     name: 'Polkadot'          },
  { symbol: 'ATOM',    name: 'Cosmos'            },
  { symbol: 'TRX',     name: 'TRON'              },
  { symbol: 'ETC',     name: 'Ethereum Classic'  },
  { symbol: 'LTC',     name: 'Litecoin'          },
  { symbol: 'BCH',     name: 'Bitcoin Cash'      },
  // L1 / Infra
  { symbol: 'NEAR',    name: 'NEAR Protocol'     },
  { symbol: 'ICP',     name: 'Internet Computer' },
  { symbol: 'FIL',     name: 'Filecoin'          },
  { symbol: 'AR',      name: 'Arweave'           },
  { symbol: 'TIA',     name: 'Celestia'          },
  { symbol: 'EGLD',    name: 'MultiversX'        },
  { symbol: 'APT',     name: 'Aptos'             },
  { symbol: 'SUI',     name: 'Sui'               },
  { symbol: 'STX',     name: 'Stacks'            },
  { symbol: 'CFX',     name: 'Conflux'           },
  { symbol: 'DASH',    name: 'Dash'              },
  { symbol: 'ZEC',     name: 'Zcash'             },
  { symbol: 'XLM',     name: 'Stellar'           },
  // DeFi
  { symbol: 'LINK',    name: 'Chainlink'         },
  { symbol: 'UNI',     name: 'Uniswap'           },
  { symbol: 'AAVE',    name: 'Aave'              },
  { symbol: 'CRV',     name: 'Curve'             },
  { symbol: 'INJ',     name: 'Injective'         },
  { symbol: 'ENS',     name: 'Ethereum Name Svc' },
  { symbol: 'COMP',    name: 'Compound'          },
  { symbol: 'LDO',     name: 'Lido DAO'          },
  { symbol: 'DYDX',    name: 'dYdX'              },
  { symbol: 'SNX',     name: 'Synthetix'         },
  { symbol: 'YFI',     name: 'Yearn Finance'     },
  { symbol: 'UMA',     name: 'UMA'               },
  { symbol: 'TRB',     name: 'Tellor'            },
  { symbol: 'LPT',     name: 'Livepeer'          },
  { symbol: 'NMR',     name: 'Numeraire'         },
  { symbol: 'AUCTION', name: 'Bounce'            },
  { symbol: 'KSM',     name: 'Kusama'            },
  { symbol: 'ZEN',     name: 'Horizen'           },
  { symbol: 'SSV',     name: 'SSV Network'       },
  // L2 / Scaling
  { symbol: 'OP',      name: 'Optimism'          },
  { symbol: 'ARB',     name: 'Arbitrum'          },
  // New Narratives
  { symbol: 'HYPE',    name: 'Hyperliquid'       },
  { symbol: 'TAO',     name: 'Bittensor'         },
  { symbol: 'WLD',     name: 'Worldcoin'         },
  { symbol: 'ORDI',    name: 'ORDI'              },
  { symbol: 'BERA',    name: 'Berachain'         },
  { symbol: 'ENA',     name: 'Ethena'            },
  { symbol: 'JTO',     name: 'Jito'              },
  { symbol: 'VIRTUAL', name: 'Virtuals Protocol' },
  { symbol: 'GRASS',   name: 'Grass'             },
  { symbol: 'RENDER',  name: 'Render'            },
  { symbol: 'ONDO',    name: 'Ondo Finance'      },
  // Memes
  { symbol: 'DOGE',    name: 'Dogecoin'          },
  { symbol: 'SHIB',    name: 'Shiba Inu'         },
  { symbol: 'PEPE',    name: 'Pepe'              },
  { symbol: 'FLOKI',   name: 'Floki'             },
  { symbol: 'BONK',    name: 'Bonk'              },
  { symbol: 'WIF',     name: 'dogwifhat'         },
  { symbol: 'TRUMP',   name: 'TRUMP'             },
  { symbol: 'MEME',    name: 'Memecoin'          },
  { symbol: 'BOME',    name: 'Book of Meme'      },
  { symbol: 'NOT',     name: 'Notcoin'           },
  // Gaming / Metaverse
  { symbol: 'GALA',    name: 'Gala'              },
  { symbol: 'CHZ',     name: 'Chiliz'            },
  { symbol: 'APE',     name: 'ApeCoin'           },
  { symbol: 'AXS',     name: 'Axie Infinity'     },
  { symbol: 'SAND',    name: 'The Sandbox'       },
  { symbol: 'MANA',    name: 'Decentraland'      },
  { symbol: 'ENJ',     name: 'Enjin Coin'        },
] as const;

export type CoinSymbol = typeof COINS[number]['symbol'];

// HOBBYIST plan supports: 4h, 6h, 8h, 12h, 1d, 1w — 1min/1h use CryptoCompare, 1sec uses OKX public API
type TimeInterval = '1sec' | '1min' | '5min' | '15min' | '1h' | '4h' | '6h' | '1day' | '1week' | 'all';

export type HeatmapRange = '12h' | '1d' | '2d' | '3d' | '1w' | '1m' | '3m';

const HEATMAP_RANGE: Record<HeatmapRange, { interval: string; limit: number }> = {
  '12h': { interval: '4h', limit: 3  },
  '1d':  { interval: '4h', limit: 6  },
  '2d':  { interval: '4h', limit: 12 },
  '3d':  { interval: '4h', limit: 18 },
  '1w':  { interval: '4h', limit: 42 },
  '1m':  { interval: '1d', limit: 30 },
  '3m':  { interval: '1d', limit: 90 },
};


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
    catch (err) {
      if (cached?.data.length) return cached.data;  // serve stale rather than failing
      throw err;                                      // no cache — let caller handle it
    }
    finally { candleInFlight.delete(key); }
  })();

  candleInFlight.set(key, promise);
  return promise;
}

async function fetchCoinGlassAllTime(coin: CoinSymbol | string): Promise<CandleDataPoint[]> {
  const sym = String(coin).toUpperCase();
  const key = `cg-all:${sym}`;
  const TTL = 4 * 60 * 60 * 1000;
  const cached = candleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL) return cached.data;

  const allCandles: CandleDataPoint[] = [];
  // Bitstamp has BTC/USD data from 2011; Coinbase from 2015; Binance from 2017
  // Try Bitstamp BTCUSD first for the oldest coverage, fall back to Binance BTCUSDT
  const candidates = [
    { exchange: 'Bitstamp', symbol: `${sym}USD`  },
    { exchange: 'Coinbase', symbol: `${sym}USD`  },
    { exchange: 'Binance',  symbol: `${sym}USDT` },
  ];

  const DAY_MS    = 86_400_000;
  const LIMIT     = 1000;
  const START_MS  = 1_325_376_000_000; // 2012-01-01 UTC

  for (const { exchange, symbol } of candidates) {
    const pages: CandleDataPoint[] = [];
    let startTime = START_MS;
    const now = Date.now();
    let ok = false;

    while (startTime < now) {
      const endTime = Math.min(startTime + LIMIT * DAY_MS, now);
      try {
        const res = await api.get('spot/price/history', {
          params: { exchange, symbol, interval: '1d', limit: LIMIT, start_time: startTime, end_time: endTime },
        });
        if (res.data?.code === '0' && Array.isArray(res.data.data) && res.data.data.length > 0) {
          const batch = (res.data.data as { time: number; open: string; high: string; low: string; close: string }[])
            .map(c => ({
              time:  Math.floor(c.time / 1000),
              open:  parseFloat(c.open),
              high:  parseFloat(c.high),
              low:   parseFloat(c.low),
              close: parseFloat(c.close),
            }))
            .filter(c => c.open > 0);
          pages.push(...batch);
          ok = true;
        }
      } catch { /* skip failed page */ }
      startTime = endTime + DAY_MS;
    }

    if (ok && pages.length > 0) {
      allCandles.push(...pages);
      break;
    }
  }

  allCandles.sort((a, b) => a.time - b.time);
  candleCache.set(key, { data: allCandles, fetchedAt: Date.now() });
  return allCandles;
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
    // Wilder's smoothed RSI — matches TradingView / industry standard
    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
    // Seed with simple average of first `period` changes
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) avgGain += changes[i];
      else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;
    // Wilder's smoothing for the rest
    for (let i = period; i < changes.length; i++) {
      avgGain = (avgGain * (period - 1) + Math.max(changes[i], 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-changes[i], 0)) / period;
    }
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

      // 200 candles: RSI needs 14 warmup + history, MACD needs 26+9; 200 gives accurate results
      const [candlesRes, oiRes, frRes, cmeRes, lsRes] = await Promise.all([
        fetchBinanceKlines(coin, '4h', 200),
        api.get('futures/open-interest/history', {
          params: { symbol, interval: '4h', limit: 1, exchange: 'Binance' },
        }).catch(() => null),
        api.get('futures/funding-rate/history', {
          params: { symbol, interval: '4h', limit: 1, exchange: 'Binance' },
        }).catch(() => null),
        fetchBinanceKlines(coin, '1h', 1440).catch(() => [] as CandleDataPoint[]),
        api.get('futures/global-long-short-account-ratio/history', {
          params: { symbol, interval: '4h', limit: 1, exchange: 'Binance' },
        }).catch(() => null),
      ]);

      const candles = candlesRes;
      if (!candles.length) return null;

      const price = candles[candles.length - 1].close;

      // Liquidation levels: use recent swing high/low as realistic magnet levels
      const recentCandles = candles.slice(-48); // last 8 days on 4h
      const swingHigh = Math.max(...recentCandles.map(c => c.high));
      const swingLow  = Math.min(...recentCandles.map(c => c.low));
      const liquidationAbove = swingHigh;
      const liquidationBelow = swingLow;

      const openInterest = oiRes?.data?.code === '0'
        ? parseFloat(oiRes.data.data?.[0]?.close ?? '0')
        : 0;

      const fundingRate = frRes?.data?.code === '0'
        ? parseFloat(frRes.data.data?.[0]?.close ?? '0')
        : 0;

      const closes = candles.map(c => c.close);
      const rsi = coinglass.calculateRSI(closes);
      const macdData = coinglass.calculateMACD(closes);

      // Real L/S ratio from CoinGlass; fall back to funding-rate estimate if unavailable
      const lsPoint = lsRes?.data?.code === '0' ? lsRes.data.data?.[0] : null;
      const longShortRatio = lsPoint
        ? (() => {
            const longPct  = parseFloat(lsPoint.global_account_long_percent  ?? lsPoint.longAccount  ?? '0');
            const shortPct = parseFloat(lsPoint.global_account_short_percent ?? lsPoint.shortAccount ?? '0');
            return shortPct > 0 ? Math.round((longPct / shortPct) * 100) / 100 : 1;
          })()
        : (fundingRate >= 0
            ? 1 + Math.min(fundingRate * 200, 0.5)
            : 1 / (1 + Math.min(Math.abs(fundingRate) * 200, 0.5)));

      return {
        price,
        liquidationAbove,
        liquidationBelow,
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
    if (interval === '4h')    return fetchBinanceKlines(coin, '4h',  168);
    if (interval === '6h')    return fetchBinanceKlines(coin, '6h',  60);
    if (interval === '1day')  return fetchBinanceKlines(coin, '1d',  90);
    if (interval === '1week') return fetchBinanceKlines(coin, '1w',  52);
    if (interval === 'all')   return fetchCoinGlassAllTime(coin);
    return fetchBinanceKlines(coin, '4h', 168);
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
    return fetchBinanceKlines(coin, interval, limit);
  },

  getIntervalTrends: async (coin: CoinSymbol | string = 'BTC'): Promise<Record<TimeInterval, 'bullish' | 'bearish' | null>> => {
    const trend = (candles: CandleDataPoint[]): 'bullish' | 'bearish' | null => {
      if (candles.length < 2) return null;
      return candles[candles.length - 1].close >= candles[0].close ? 'bullish' : 'bearish';
    };

    const [m1, m4, m6, m1d, m1w] = await Promise.all([
      fetchBinanceKlines(coin, '1m',  60),
      fetchBinanceKlines(coin, '4h',  42),
      fetchBinanceKlines(coin, '6h',  60),
      fetchBinanceKlines(coin, '1d',  30),
      fetchBinanceKlines(coin, '1w',  52),
    ]);

    return {
      '1min':  trend(m1),
      '4h':    trend(m4),
      '6h':    trend(m6),
      '1day':  trend(m1d),
      '1week': trend(m1w),
      '5min':  trend(m1),
      '15min': trend(m1),
      '1h':    trend(m4),
    } as Record<TimeInterval, 'bullish' | 'bearish' | null>;
  },

  getHTFCandles: async (coin: CoinSymbol | string = 'BTC'): Promise<CandleDataPoint[]> => {
    return fetchBinanceKlines(coin, '1w', 260);
  },

  getCandles: async (coin: CoinSymbol | string, interval: string, limit = 100): Promise<CandleDataPoint[]> => {
    return fetchBinanceKlines(coin, interval, limit);
  },

  getMonthlyReturns: async (coin: CoinSymbol | string = 'BTC'): Promise<MonthlyReturn[]> => {
    const cacheKey = `monthly:${coin}`;
    const cached = monthlyCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < 3_600_000) return cached.data;

    // Binance daily klines — covers full history back to Aug 2017 (~3300 days)
    const candles = await fetchBinanceKlines(coin, '1d', 3500);
    if (!candles.length) return [];

    const monthMap = new Map<string, { year: number; month: number; open: number; close: number }>();
    for (const c of candles) {
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

  getExchangeActivity: async (coin: CoinSymbol | string = 'BTC'): Promise<ExchangeActivity[]> => {
    const sym = `${coin}USDT`;

    // 4H price change from Binance Vision (always reliable, open CORS)
    const priceCandles = await fetchBinanceKlines(coin, '4h', 3).catch(() => [] as CandleDataPoint[]);
    const priceChange = priceCandles.length >= 2
      ? ((priceCandles[priceCandles.length - 1].close - priceCandles[priceCandles.length - 2].close)
          / priceCandles[priceCandles.length - 2].close) * 100
      : 0;

    const classify = (fr: number): ExchangeActivity['signal'] => {
      if (fr > 0.00005)  return 'buying';
      if (fr < -0.00005) return 'selling';
      return 'neutral';
    };

    const fmt = (fr: number): string => {
      const pct = fr * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(4)}%`;
    };

    const mkNeutral = (exchange: string): ExchangeActivity =>
      ({ exchange, fundingRate: 0, fundingPct: '0.0000%', priceChange, signal: 'neutral' });

    // CoinGlass funding-rate/history: works for Binance on hobbyist plan, try Bybit too
    const parseCgFR = (res: { data?: { code?: string; data?: { close?: string }[] } } | null): number => {
      if (res?.data?.code !== '0') return NaN;
      return parseFloat(res.data.data?.[0]?.close ?? '');
    };

    const [bnRes, bybitCgRes, okxRes, bitgetRes, cbCgRes, cbIntxRes] = await Promise.all([
      api.get('futures/funding-rate/history', { params: { symbol: sym, interval: '8h', limit: 1, exchange: 'Binance' } }).catch(() => null),
      api.get('futures/funding-rate/history', { params: { symbol: sym, interval: '8h', limit: 1, exchange: 'Bybit' }   }).catch(() => null),
      fetch(`/okx-api/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`).then(r => r.json()).catch(() => null),
      fetch(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${sym}&productType=USDT-FUTURES`).then(r => r.json()).catch(() => null),
      api.get('futures/funding-rate/history', { params: { symbol: sym, interval: '8h', limit: 1, exchange: 'Coinbase' } }).catch(() => null),
      fetch(`/coinbase-api/api/v1/instruments/${coin}-PERP/quote`).then(r => r.json()).catch(() => null),
    ]);

    // ── Binance via CoinGlass ────────────────────────────────────────────────
    let binance = mkNeutral('Binance');
    const bnFR = parseCgFR(bnRes);
    if (isFinite(bnFR)) binance = { exchange: 'Binance', fundingRate: bnFR, fundingPct: fmt(bnFR), priceChange, signal: classify(bnFR) };

    // ── Bybit via CoinGlass (falls back to neutral if hobbyist plan blocks) ──
    let bybit = mkNeutral('Bybit');
    const bybitFR = parseCgFR(bybitCgRes);
    if (isFinite(bybitFR)) bybit = { exchange: 'Bybit', fundingRate: bybitFR, fundingPct: fmt(bybitFR), priceChange, signal: classify(bybitFR) };

    // ── OKX via /okx-api proxy ───────────────────────────────────────────────
    let okx = mkNeutral('OKX');
    const okxFR = parseFloat(okxRes?.data?.[0]?.fundingRate ?? '');
    if (isFinite(okxFR)) okx = { exchange: 'OKX', fundingRate: okxFR, fundingPct: fmt(okxFR), priceChange, signal: classify(okxFR) };

    // ── Bitget direct (data may be object or array) ──────────────────────────
    let bitget = mkNeutral('Bitget');
    const bgData = bitgetRes?.data;
    const bitgetFR = parseFloat(
      (Array.isArray(bgData) ? bgData[0]?.fundingRate : bgData?.fundingRate) ?? ''
    );
    if (isFinite(bitgetFR)) bitget = { exchange: 'Bitget', fundingRate: bitgetFR, fundingPct: fmt(bitgetFR), priceChange, signal: classify(bitgetFR) };

    // ── Coinbase: CoinGlass first, fallback to INTX instrument endpoint ──────
    let coinbase = mkNeutral('Coinbase');
    const cbFRcg = parseCgFR(cbCgRes);
    const cbFRintx = parseFloat(cbIntxRes?.predicted_funding ?? cbIntxRes?.funding_rate ?? '');
    const cbFR = isFinite(cbFRcg) ? cbFRcg : cbFRintx;
    if (isFinite(cbFR)) coinbase = { exchange: 'Coinbase', fundingRate: cbFR, fundingPct: fmt(cbFR), priceChange, signal: classify(cbFR) };

    return [binance, bybit, okx, bitget, coinbase];
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

export async function getPositionData(coin: CoinSymbol | string = 'BTC', interval = '4h', limit = 180): Promise<PositionData> {
  const symbol = toCgSymbol(coin);
  const params = { symbol, interval, limit, exchange: 'Binance' };

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

export interface LSExchangeSnapshot {
  exchange: string;
  longPct: number;
  shortPct: number;
  ratio: number;
  type: 'global' | 'top';
}

const LS_EXCHANGES = ['Binance', 'Bybit', 'OKX', 'Bitget'] as const;

// ── Taker buy/sell volume ────────────────────────────────────────────────────

export interface TakerVolData {
  buyVolUsd: number;
  sellVolUsd: number;
  buyRatio: number;   // 0–1
  sellRatio: number;  // 0–1
}

export async function getTakerBuySellVol(
  coin: CoinSymbol | string = 'BTC',
  interval = '4h',
  limit = 1,
  exchange = 'Binance',
): Promise<TakerVolData | null> {
  const symbol = toCgSymbol(coin);
  try {
    const res = await api.get('futures/taker-buy-sell-vol/history', {
      params: { symbol, interval, limit, exchange },
    });
    if (res.data?.code !== '0' || !res.data.data?.length) return null;
    const d = res.data.data[0];
    const buy  = parseFloat(d.buyVol ?? d.buy_vol ?? d.buyVolUsd  ?? d.longVol  ?? '0');
    const sell = parseFloat(d.sellVol ?? d.sell_vol ?? d.sellVolUsd ?? d.shortVol ?? '0');
    const total = buy + sell;
    if (!total) return null;
    return { buyVolUsd: buy, sellVolUsd: sell, buyRatio: buy / total, sellRatio: sell / total };
  } catch { return null; }
}

export interface TakerVolHistory {
  time: number;
  buyVolUsd: number;
  sellVolUsd: number;
  ratio: number; // buy/sell
}

export async function getTakerBuySellHistory(
  coin: CoinSymbol | string = 'BTC',
  interval = '4h',
  limit = 180,
  exchange = 'Binance',
): Promise<TakerVolHistory[]> {
  const symbol = toCgSymbol(coin);
  try {
    const res = await api.get('futures/taker-buy-sell-vol/history', {
      params: { symbol, interval, limit, exchange },
    });
    if (res.data?.code !== '0') return [];
    return (res.data.data ?? []).map((d: Record<string, string>) => {
      const buy  = parseFloat(d.buyVol ?? d.buy_vol ?? d.buyVolUsd  ?? '0');
      const sell = parseFloat(d.sellVol ?? d.sell_vol ?? d.sellVolUsd ?? '0');
      return {
        time: Math.floor(Number(d.time ?? d.createTime) / 1000),
        buyVolUsd: buy,
        sellVolUsd: sell,
        ratio: sell > 0 ? buy / sell : 1,
      };
    });
  } catch { return []; }
}

// ── Per-exchange L/S breakdown ───────────────────────────────────────────────

export interface ExchangeRatioRow {
  longPct: number;
  shortPct: number;
  ratio: number;
}

export interface ExchangeLSData {
  exchange: string;
  retail: ExchangeRatioRow | null;
  whaleAccount: ExchangeRatioRow | null;
  whalePosition: ExchangeRatioRow | null;
}

const LS_BREAKDOWN_EXCHANGES = ['Binance', 'OKX', 'Bybit'] as const;

export async function getExchangeLSData(coin: CoinSymbol | string = 'BTC'): Promise<ExchangeLSData[]> {
  const symbol = toCgSymbol(coin);
  const params = (exchange: string) => ({ symbol, interval: '4h', limit: 1, exchange });

  const all = await Promise.all(
    LS_BREAKDOWN_EXCHANGES.flatMap(exchange => [
      api.get('futures/global-long-short-account-ratio/history',  { params: params(exchange) }).catch(() => null),
      api.get('futures/top-long-short-account-ratio/history',     { params: params(exchange) }).catch(() => null),
      api.get('futures/top-long-short-position-ratio/history',    { params: params(exchange) }).catch(() => null),
    ])
  );

  const parseRow = (res: typeof all[0], lKey: string, sKey: string): ExchangeRatioRow | null => {
    if (res?.data?.code !== '0') return null;
    const d = res.data.data?.[0];
    if (!d) return null;
    const longPct  = parseFloat(d[lKey] ?? '0');
    const shortPct = parseFloat(d[sKey] ?? '0');
    if (!longPct && !shortPct) return null;
    return { longPct, shortPct, ratio: shortPct > 0 ? longPct / shortPct : 1 };
  };

  return LS_BREAKDOWN_EXCHANGES.map((exchange, i) => ({
    exchange,
    retail:       parseRow(all[i * 3],     'global_account_long_percent', 'global_account_short_percent'),
    whaleAccount: parseRow(all[i * 3 + 1], 'top_account_long_percent',   'top_account_short_percent'),
    whalePosition:parseRow(all[i * 3 + 2], 'top_position_long_percent',  'top_position_short_percent'),
  }));
}

export async function getLSRatioByExchange(coin: CoinSymbol | string = 'BTC'): Promise<LSExchangeSnapshot[]> {
  const symbol = toCgSymbol(coin);

  const requests = LS_EXCHANGES.flatMap(exchange => [
    api.get('futures/global-long-short-account-ratio/history', {
      params: { symbol, interval: '4h', limit: 1, exchange },
    }).catch(() => null),
    api.get('futures/top-long-short-account-ratio/history', {
      params: { symbol, interval: '4h', limit: 1, exchange },
    }).catch(() => null),
  ]);

  const results = await Promise.all(requests);
  const snapshots: LSExchangeSnapshot[] = [];

  LS_EXCHANGES.forEach((exchange, i) => {
    const globalRes = results[i * 2];
    const topRes    = results[i * 2 + 1];

    const parseSnap = (res: typeof globalRes, type: 'global' | 'top', lKey: string, sKey: string) => {
      if (res?.data?.code !== '0') return;
      const d = res.data.data?.[0];
      if (!d) return;
      const longPct  = parseFloat(d[lKey] ?? '0');
      const shortPct = parseFloat(d[sKey] ?? '0');
      if (!longPct && !shortPct) return;
      snapshots.push({ exchange, longPct, shortPct, ratio: shortPct > 0 ? longPct / shortPct : 1, type });
    };

    parseSnap(globalRes, 'global', 'global_account_long_percent', 'global_account_short_percent');
    parseSnap(topRes,    'top',    'top_account_long_percent',    'top_account_short_percent');
  });

  return snapshots;
}

export async function getPriceCandles(
  coin: CoinSymbol | string,
  interval: string,
  limit: number,
): Promise<CandleDataPoint[]> {
  return fetchPriceCandles(coin, interval, limit);
}

// ── Per-exchange taker buy/sell volume table ─────────────────────────────────

export interface ExchangeTakerRow {
  exchange: string;
  longPct: number;
  shortPct: number;
  longVolUsd: number;
  shortVolUsd: number;
}

const TAKER_EXCHANGE_LIST = [
  'Binance', 'OKX', 'Bybit', 'Bitget', 'Gate', 'KuCoin', 'BingX', 'MEXC',
] as const;

export async function getAllExchangeTakerVol(
  coin: CoinSymbol | string = 'BTC',
  interval = '4h',
): Promise<ExchangeTakerRow[]> {
  const symbol = toCgSymbol(coin);

  const results = await Promise.allSettled(
    TAKER_EXCHANGE_LIST.map(exchange =>
      api.get('futures/taker-buy-sell-vol/history', {
        params: { symbol, interval, limit: 1, exchange },
      }).catch(() => null)
    )
  );

  const rows: ExchangeTakerRow[] = [];
  TAKER_EXCHANGE_LIST.forEach((exchange, i) => {
    const res = results[i].status === 'fulfilled' ? results[i].value : null;
    if (res?.data?.code !== '0' || !res.data.data?.length) return;
    const d   = res.data.data[0] as Record<string, string>;
    const buy  = parseFloat(d.buyVol  ?? d.buy_vol  ?? d.buyVolUsd  ?? d.longVol  ?? '0');
    const sell = parseFloat(d.sellVol ?? d.sell_vol ?? d.sellVolUsd ?? d.shortVol ?? '0');
    const total = buy + sell;
    if (!total) return;
    rows.push({
      exchange,
      longPct:     (buy  / total) * 100,
      shortPct:    (sell / total) * 100,
      longVolUsd:   buy,
      shortVolUsd:  sell,
    });
  });

  return rows;
}

// ── Large trades from Binance futures (public, CORS-friendly via CDN) ─────────

export interface LargeTradeItem {
  pair: string;
  price: number;
  valueUsd: number;
  isBuy: boolean;
  time: number; // unix ms
}

export async function getRecentLargeTrades(
  coin: CoinSymbol | string = 'BTC',
  minValueUsd = 50_000,
): Promise<LargeTradeItem[]> {
  // Binance futures aggTrades via CORS-open CDN mirror
  const symbol = `${coin}USDT`;
  try {
    const res = await bnApi.get('/api/v3/aggTrades', {
      params: { symbol, limit: 500 },
    });
    const raw = res.data as { p: string; q: string; T: number; m: boolean }[];
    return raw
      .map(t => ({
        pair:     symbol,
        price:    parseFloat(t.p),
        valueUsd: parseFloat(t.p) * parseFloat(t.q),
        isBuy:    !t.m,   // m = buyer is market maker → !m means taker bought
        time:     t.T,
      }))
      .filter(t => t.valueUsd >= minValueUsd)
      .reverse()
      .slice(0, 30);
  } catch {
    return [];
  }
}

// ── Price + L/S Ratio history (for dual-axis chart) ─────────────────────────

export interface PriceLSPoint {
  time: number;
  price: number;
  lsRatio: number;  // longPct / shortPct
}

export async function getPriceLSHistory(
  coin: CoinSymbol | string = 'BTC',
  interval = '4h',
  limit = 90,
): Promise<PriceLSPoint[]> {
  const symbol = toCgSymbol(coin);
  const bnInterval = interval === '1d' ? '1d' : interval === '1h' ? '1h' : '4h';

  const [lsRes, priceCandles] = await Promise.all([
    api.get('futures/global-long-short-account-ratio/history', {
      params: { symbol, interval, limit, exchange: 'Binance' },
    }).catch(() => null),
    fetchBinanceKlines(coin, bnInterval, limit),
  ]);

  if (!priceCandles.length) return [];

  const priceMap = new Map(priceCandles.map(c => [c.time, c.close]));

  if (lsRes?.data?.code !== '0' || !lsRes.data.data?.length) {
    return priceCandles.map(c => ({ time: c.time, price: c.close, lsRatio: 1 }));
  }

  const points: PriceLSPoint[] = [];
  const pTimes = priceCandles.map(c => c.time);

  for (const d of (lsRes.data.data as Record<string, string>[])) {
    const t = Math.floor(Number(d.time) / 1000);
    const longPct  = parseFloat(d.global_account_long_percent  ?? '50');
    const shortPct = parseFloat(d.global_account_short_percent ?? '50');
    const lsRatio  = shortPct > 0 ? longPct / shortPct : 1;

    // nearest price timestamp
    const nearest = pTimes.reduce((best, pt) =>
      Math.abs(pt - t) < Math.abs(best - t) ? pt : best, pTimes[0]);
    const price = priceMap.get(nearest);
    if (price) points.push({ time: t, price, lsRatio });
  }

  return points.sort((a, b) => a.time - b.time);
}

// ── Multi-coin L/S snapshot (for futures table) ──────────────────────────────

export interface CoinLSSnapshot {
  coin: string;
  name: string;
  price: number;
  change24h: number;
  longPct: number;
  shortPct: number;
  lsRatio: number;
}

export async function getMultiCoinLSSnapshot(
  coins: readonly { symbol: string; name: string }[],
): Promise<CoinLSSnapshot[]> {
  // Binance 24h ticker — all coins in one request
  const symbols = JSON.stringify(coins.map(c => `${c.symbol}USDT`));
  const tickerRes = await bnApi.get('/api/v3/ticker/24hr', { params: { symbols } }).catch(() => null);

  const priceMap = new Map<string, { price: number; change: number }>();
  if (Array.isArray(tickerRes?.data)) {
    for (const t of tickerRes.data as { symbol: string; lastPrice: string; priceChangePercent: string }[]) {
      const sym = t.symbol.replace('USDT', '');
      priceMap.set(sym, {
        price:  parseFloat(t.lastPrice ?? '0'),
        change: parseFloat(t.priceChangePercent ?? '0'),
      });
    }
  }

  // CoinGlass global L/S ratio per coin — parallel
  const lsResults = await Promise.allSettled(
    coins.map(c =>
      api.get('futures/global-long-short-account-ratio/history', {
        params: { symbol: toCgSymbol(c.symbol), interval: '4h', limit: 1, exchange: 'Binance' },
      }).catch(() => null)
    )
  );

  return coins.map((c, i) => {
    const lsRes  = lsResults[i].status === 'fulfilled' ? lsResults[i].value : null;
    const lsData = lsRes?.data?.code === '0' ? lsRes.data.data?.[0] : null;
    const longPct  = lsData ? parseFloat(lsData.global_account_long_percent  ?? '50') : 50;
    const shortPct = lsData ? parseFloat(lsData.global_account_short_percent ?? '50') : 50;
    const pd = priceMap.get(c.symbol) ?? { price: 0, change: 0 };

    return {
      coin:     c.symbol,
      name:     c.name,
      price:    pd.price,
      change24h: pd.change,
      longPct,
      shortPct,
      lsRatio: shortPct > 0 ? longPct / shortPct : 1,
    };
  });
}

// ── Macro context for forecast ────────────────────────────────────────────────

export interface MacroContextData {
  btcDominance:   number | null;   // e.g. 54.2 (%)
  fundingRate:    number | null;   // raw 8h rate, e.g. 0.0001
  oiDelta:        number | null;   // % OI change last period
  marketStructure: "uptrend" | "downtrend" | "ranging" | null;
}

export async function getMacroContext(coin: CoinSymbol | string = 'BTC'): Promise<MacroContextData> {
  const sym = toCgSymbol(coin);

  const [dominanceRes, fundingRes, oiRes, dailyRes] = await Promise.allSettled([
    fetch('https://api.coingecko.com/api/v3/global').then(r => r.json()),
    api.get('futures/funding-rate/history',  { params: { symbol: sym, interval: '8h', limit: 2,  exchange: 'Binance' } }),
    api.get('futures/open-interest/history', { params: { symbol: sym, interval: '4h', limit: 3,  exchange: 'Binance' } }),
    fetchBinanceKlines(coin, '1d', 60),
  ]);

  // BTC Dominance
  let btcDominance: number | null = null;
  if (dominanceRes.status === 'fulfilled') {
    const raw = dominanceRes.value?.data?.btc_dominance;
    if (raw != null) btcDominance = Math.round(raw * 10) / 10;
  }

  // Funding rate (latest)
  let fundingRate: number | null = null;
  if (fundingRes.status === 'fulfilled' && fundingRes.value?.data?.code === '0') {
    const d = fundingRes.value.data.data ?? [];
    if (d.length) fundingRate = parseFloat(d[0]?.close ?? '');
    if (!isFinite(fundingRate!)) fundingRate = null;
  }

  // OI delta (% change between latest two points)
  let oiDelta: number | null = null;
  if (oiRes.status === 'fulfilled' && oiRes.value?.data?.code === '0') {
    const d = oiRes.value.data.data ?? [];
    if (d.length >= 2) {
      const curr = parseFloat(d[0]?.close ?? '0');
      const prev = parseFloat(d[1]?.close ?? '0');
      if (prev > 0) oiDelta = Math.round(((curr - prev) / prev) * 10000) / 100;
    }
  }

  // Market structure from daily EMA20 vs EMA50
  let marketStructure: MacroContextData['marketStructure'] = null;
  if (dailyRes.status === 'fulfilled' && dailyRes.value.length >= 50) {
    const closes = dailyRes.value.map(c => c.close);
    const ema20arr = closes.map((_, i) => {
      if (i < 19) return NaN;
      const k = 2 / 21;
      let e = closes.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
      for (let j = 20; j <= i; j++) e = closes[j] * k + e * (1 - k);
      return e;
    });
    const ema50arr = closes.map((_, i) => {
      if (i < 49) return NaN;
      const k = 2 / 51;
      let e = closes.slice(0, 50).reduce((s, v) => s + v, 0) / 50;
      for (let j = 50; j <= i; j++) e = closes[j] * k + e * (1 - k);
      return e;
    });
    const lastClose = closes[closes.length - 1];
    const e20 = ema20arr[ema20arr.length - 1];
    const e50 = ema50arr[ema50arr.length - 1];
    if (!isNaN(e20) && !isNaN(e50)) {
      if (lastClose > e20 && e20 > e50)       marketStructure = 'uptrend';
      else if (lastClose < e20 && e20 < e50)  marketStructure = 'downtrend';
      else                                     marketStructure = 'ranging';
    }
  }

  return { btcDominance, fundingRate, oiDelta, marketStructure };
}

export function clearCandleCache(): void {
  // Expire all entries so the next fetch triggers a fresh request,
  // but keep the stale data in place so a 429 response can fall back to it.
  for (const [key, entry] of candleCache) {
    candleCache.set(key, { ...entry, fetchedAt: 0 });
  }
  candleInFlight.clear();
}

// ── Market caps from CoinGecko public API ─────────────────────────────────────

let marketCapCache: Map<string, number> | null = null;
let change24hCache: Map<string, number> | null = null;
let price24hCache: Map<string, number> | null = null;
let marketCapFetchedAt = 0;
const MARKET_CAP_TTL = 5 * 60 * 1000; // 5 min

interface CoinGeckoMarket {
  symbol: string;
  market_cap: number;
  current_price: number;
  price_change_percentage_24h: number;
}

async function fetchCoinGeckoMarkets(): Promise<CoinGeckoMarket[]> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false',
    { headers: { accept: 'application/json' } }
  );
  return res.json();
}

function populateCoinGeckoCaches(data: CoinGeckoMarket[]) {
  const capMap = new Map<string, number>();
  const chgMap = new Map<string, number>();
  const priceMap = new Map<string, number>();
  for (const coin of data) {
    const sym = coin.symbol.toUpperCase();
    capMap.set(sym, coin.market_cap);
    chgMap.set(sym, coin.price_change_percentage_24h ?? 0);
    priceMap.set(sym, coin.current_price ?? 0);
  }
  marketCapCache = capMap;
  change24hCache = chgMap;
  price24hCache  = priceMap;
  marketCapFetchedAt = Date.now();
}

export async function fetchCoinMarketCaps(): Promise<Map<string, number>> {
  if (marketCapCache && Date.now() - marketCapFetchedAt < MARKET_CAP_TTL) {
    return marketCapCache;
  }
  try {
    populateCoinGeckoCaches(await fetchCoinGeckoMarkets());
    return marketCapCache!;
  } catch {
    return marketCapCache ?? new Map();
  }
}

export interface CoinSnapshot { change: number; price: number; }

export async function fetchCoinChanges24h(): Promise<Map<string, CoinSnapshot>> {
  if (change24hCache && Date.now() - marketCapFetchedAt < MARKET_CAP_TTL) {
    const map = new Map<string, CoinSnapshot>();
    change24hCache.forEach((chg, sym) => map.set(sym, { change: chg, price: price24hCache?.get(sym) ?? 0 }));
    return map;
  }
  try {
    populateCoinGeckoCaches(await fetchCoinGeckoMarkets());
    const map = new Map<string, CoinSnapshot>();
    change24hCache!.forEach((chg, sym) => map.set(sym, { change: chg, price: price24hCache?.get(sym) ?? 0 }));
    return map;
  } catch {
    return new Map();
  }
}

// ── 24h High/Low from Binance ticker ─────────────────────────────────────────

export interface Ticker24h { high: number; low: number; change: number; }

let ticker24hCache: Map<string, Ticker24h> | null = null;
let ticker24hFetchedAt = 0;
const TICKER_TTL = 60 * 1000; // 1 min

export async function fetchCoin24hTickers(
  coins: readonly { symbol: string }[],
): Promise<Map<string, Ticker24h>> {
  if (ticker24hCache && Date.now() - ticker24hFetchedAt < TICKER_TTL) {
    return ticker24hCache;
  }
  // Single batch request — one connection instead of one per coin.
  // Binance silently skips symbols that don't exist (no CORS errors from 400s).
  const symbolList = JSON.stringify(coins.map(c => `${c.symbol}USDT`));
  const map = new Map<string, Ticker24h>();
  try {
    const res = await bnApi.get('/api/v3/ticker/24hr', { params: { symbols: symbolList } });
    const rows = res.data as Record<string, string>[];
    for (const row of rows) {
      const sym = (row.symbol as string).replace(/USDT$/, '');
      const high = parseFloat(row.highPrice ?? '0');
      const low  = parseFloat(row.lowPrice  ?? '0');
      if (!high && !low) continue;
      map.set(sym, { high, low, change: parseFloat(row.priceChangePercent ?? '0') });
    }
  } catch {
    if (ticker24hCache) return ticker24hCache;
  }
  ticker24hCache = map;
  ticker24hFetchedAt = Date.now();
  return map;
}

export async function fetchFundingRate(coin: string): Promise<number | null> {
  try {
    const symbol = coin === 'BTC' ? 'BTCUSDT' : `${coin}USDT`;
    const res = await api.get('futures/funding-rate/history', {
      params: { symbol, interval: '8h', limit: 1, exchange: 'Binance' },
    });
    if (res?.data?.code === '0' && res.data.data?.[0]) {
      return parseFloat(res.data.data[0].close ?? '0');
    }
    return null;
  } catch {
    return null;
  }
}

export type { BTCData, PriceDataPoint, CandleDataPoint };
