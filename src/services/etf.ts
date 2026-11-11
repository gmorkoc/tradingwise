import { Capacitor } from '@capacitor/core';

export interface ETFRow {
  ticker: string;
  name: string;
  dailyFlowUsd: number;
  aumUsd: number;
  priceUsd: number;
  priceChangePct: number;
  volumeUsd: number;
  sharesOutstanding: number;
}

export interface ETFDayTotal {
  date: string;
  flowUsd: number;
  priceUsd: number;
  perFund: { etf_ticker: string; flow_usd: number }[];
}

export interface ETFData {
  rows: ETFRow[];
  history: ETFDayTotal[];
  latestDate: string;
  source: 'coinmarketcap';
}

// US spot Bitcoin ETF data from CoinMarketCap's public data API, through our
// own /etf-api proxy (middleware.ts / vite.config.ts) since it sends no CORS
// header. Our CoinGlass plan doesn't include ETF endpoints. The app loads
// from capacitor://localhost, so it calls the live site's proxy directly.
const ETF_BASE = Capacitor.isNativePlatform() ? 'https://www.coinhintz.io/etf-api' : '/etf-api';

export async function getETFData(): Promise<ETFData> {
  const [flowsRes, listRes] = await Promise.all([
    fetch(`${ETF_BASE}/overview/netflow/chart?category=btc&range=90d`).then(r => r.json()),
    fetch(`${ETF_BASE}/list?category=btc`).then(r => r.json()),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const points: any[] = flowsRes?.data?.points ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listData: any[] = Array.isArray(listRes?.data) ? listRes.data : [];
  if (!points.length && !listData.length) throw new Error('ETF data unavailable');

  // Per-fund daily flow and price change aren't published by this source
  // (fundFlow is usually null) — those cells show "–".
  const rows: ETFRow[] = listData
    .filter(f => f.active !== 0)
    .map(f => ({
      ticker:            f.ticker ?? '',
      name:              f.name ?? f.ticker ?? '',
      dailyFlowUsd:      Number(f.fundFlow ?? 0),
      aumUsd:            Number(f.aum ?? 0),
      priceUsd:          Number(f.price ?? 0),
      priceChangePct:    NaN,
      volumeUsd:         Number(f.volume ?? 0),
      sharesOutstanding: 0,
    }));

  const history: ETFDayTotal[] = points
    .map(d => ({
      date:     new Date(Number(d.timestamp)).toISOString().slice(0, 10),
      flowUsd:  Number(d.btcValue ?? d.value ?? 0),
      priceUsd: Number(d.cryptoPrice ?? 0),
      perFund:  [] as { etf_ticker: string; flow_usd: number }[],
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Latest day with a settled flow (today's entry is often still 0).
  const settled = [...history].reverse().find(d => d.flowUsd !== 0);
  const latestDate = settled?.date ?? history[history.length - 1]?.date ?? new Date().toISOString().slice(0, 10);

  return { rows, history, latestDate, source: 'coinmarketcap' };
}
