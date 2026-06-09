import axios from "axios";

const YF_TICKERS = ['IBIT', 'FBTC', 'GBTC', 'ARKB', 'BITB', 'BRRR', 'HODL', 'EZBC', 'BTCO', 'BTCW'];

const YF_NAMES: Record<string, string> = {
  IBIT:  'iShares Bitcoin Trust',
  FBTC:  'Fidelity Wise Origin Bitcoin',
  GBTC:  'Grayscale Bitcoin Trust',
  ARKB:  'ARK 21Shares Bitcoin ETF',
  BITB:  'Bitwise Bitcoin ETF',
  BRRR:  'Valkyrie Bitcoin Fund',
  HODL:  'VanEck Bitcoin ETF',
  EZBC:  'Franklin Bitcoin ETF',
  BTCO:  'Invesco Galaxy Bitcoin ETF',
  BTCW:  'WisdomTree Bitcoin Fund',
};

// IBIT shares ≈ 0.00094 BTC each; invert to get approx BTC spot price from IBIT price
const IBIT_TO_BTC = 1 / 0.00094;

export interface ETFRow {
  ticker: string;
  name: string;
  dailyFlowUsd: number;   // daily trading volume in USD (proxy for activity)
  aumUsd: number;
  priceUsd: number;
  priceChangePct: number;
  volumeUsd: number;
  sharesOutstanding: number;
}

export interface ETFDayTotal {
  date: string;
  flowUsd: number;    // IBIT daily USD volume (proxy for market activity)
  priceUsd: number;   // estimated BTC spot price
  perFund: { etf_ticker: string; flow_usd: number }[];
}

export interface ETFData {
  rows: ETFRow[];
  history: ETFDayTotal[];
  latestDate: string;
  source: 'yahoo';
}

export async function getETFData(): Promise<ETFData> {
  const symbols = YF_TICKERS.join(',');

  const [quoteRes, histRes] = await Promise.all([
    axios.get(`/yf-api/v7/finance/quote`, {
      params: { symbols, fields: 'shortName,regularMarketPrice,regularMarketChangePercent,regularMarketVolume,marketCap,sharesOutstanding' },
      timeout: 12000,
    }),
    axios.get(`/yf-api/v8/finance/chart/IBIT`, {
      params: { interval: '1d', range: '1mo' },
      timeout: 12000,
    }),
  ]);

  // ── Fund rows ──────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const quotes: any[] = quoteRes.data?.quoteResponse?.result ?? [];
  const rows: ETFRow[] = quotes.map(q => {
    const volUsd = (q.regularMarketVolume ?? 0) * (q.regularMarketPrice ?? 0);
    return {
      ticker:           q.symbol,
      name:             q.shortName ?? YF_NAMES[q.symbol as string] ?? q.symbol,
      dailyFlowUsd:     volUsd,
      aumUsd:           q.marketCap ?? 0,
      priceUsd:         q.regularMarketPrice ?? 0,
      priceChangePct:   q.regularMarketChangePercent ?? 0,
      volumeUsd:        volUsd,
      sharesOutstanding: q.sharesOutstanding ?? 0,
    };
  });

  // ── 30-day IBIT history → proxy for market activity ───────────────────
  const chart  = histRes.data?.chart?.result?.[0];
  const tsList: number[]  = chart?.timestamp ?? [];
  const closes: number[]  = chart?.indicators?.quote?.[0]?.close  ?? [];
  const vols:   number[]  = chart?.indicators?.quote?.[0]?.volume ?? [];

  const history: ETFDayTotal[] = tsList
    .map((ts, i) => ({
      date:     new Date(ts * 1000).toISOString().slice(0, 10),
      flowUsd:  (vols[i] ?? 0) * (closes[i] ?? 0),
      priceUsd: Math.round((closes[i] ?? 0) * IBIT_TO_BTC),
      perFund:  [],
    }))
    .filter(d => d.flowUsd > 0);

  const latestDate = history[history.length - 1]?.date ?? new Date().toISOString().slice(0, 10);

  return { rows, history, latestDate, source: 'yahoo' };
}
