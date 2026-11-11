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
  // Per-fund daily flows: 20 days per page, 5 pages ≈ the 90-day chart.
  const PER_FUND_PAGES = 5;
  const [flowsRes, listRes, ...fundPages] = await Promise.all([
    fetch(`${ETF_BASE}/overview/netflow/chart?category=btc&range=90d`).then(r => r.json()),
    fetch(`${ETF_BASE}/list?category=btc`).then(r => r.json()),
    ...Array.from({ length: PER_FUND_PAGES }, (_, i) =>
      fetch(`${ETF_BASE}/detail/netflow/list?category=btc&page=${i + 1}&size=20`)
        .then(r => r.json()).catch(() => null)),
  ]);

  // date → [{ ticker, usd }] (skips the all-time "date 0" row and days
  // not reported yet, where every fund is null).
  const perFundByDate = new Map<string, { etf_ticker: string; flow_usd: number }[]>();
  for (const pg of fundPages) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const pt of (pg?.data?.points ?? []) as any[]) {
      const ts = Number(pt?.date);
      if (!ts) continue;
      const funds = Object.entries(pt)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter(([k, v]: [string, any]) => k !== 'date' && k !== 'total' && v && v.usd != null)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map(([k, v]: [string, any]) => ({ etf_ticker: k, flow_usd: Number(v.usd) || 0 }));
      if (funds.length) perFundByDate.set(new Date(ts).toISOString().slice(0, 10), funds);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const points: any[] = flowsRes?.data?.points ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listData: any[] = Array.isArray(listRes?.data) ? listRes.data : [];
  if (!points.length && !listData.length) throw new Error('ETF data unavailable');

  // Per-fund price change isn't published by this source — that column
  // hides. Daily flow comes from the per-fund list above.
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
  for (const d of history) d.perFund = perFundByDate.get(d.date) ?? [];

  // Latest day with a settled flow (today's entry is often still 0).
  const settled = [...history].reverse().find(d => d.flowUsd !== 0);
  const latestDate = settled?.date ?? history[history.length - 1]?.date ?? new Date().toISOString().slice(0, 10);

  // The list's own fundFlow is usually null — use the latest day's per-fund flows.
  const latestFunds = perFundByDate.get(latestDate);
  if (latestFunds) {
    const m = new Map(latestFunds.map(f => [f.etf_ticker, f.flow_usd]));
    for (const r of rows) if (!r.dailyFlowUsd && m.has(r.ticker)) r.dailyFlowUsd = m.get(r.ticker)!;
  }

  return { rows, history, latestDate, source: 'coinmarketcap' };
}
