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
  source: 'coinglass';
}

export async function getETFData(): Promise<ETFData> {
  const [flowsRes, listRes] = await Promise.all([
    fetch('/cg-api/etf/bitcoin/flow-history').then(r => r.json()),
    fetch('/cg-api/etf/bitcoin/list').then(r => r.json()),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flowData: any[] = flowsRes?.data ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listData: any[] = listRes?.data ?? [];

  const rows: ETFRow[] = listData.map(f => {
    const price    = Number(f.price_usd ?? 0);
    const btcDelta = Number(f.asset_details?.change_quantity_24h ?? 0);
    return {
      ticker:            f.ticker ?? '',
      name:              f.fund_name ?? f.ticker ?? '',
      dailyFlowUsd:      btcDelta * price,
      aumUsd:            Number(f.aum_usd ?? 0),
      priceUsd:          price,
      priceChangePct:    Number(f.price_change_percent ?? 0),
      volumeUsd:         Number(f.volume_usd ?? 0),
      sharesOutstanding: Number(f.shares_outstanding ?? 0),
    };
  });

  const history: ETFDayTotal[] = flowData.map(d => ({
    date:     new Date(d.timestamp).toISOString().slice(0, 10),
    flowUsd:  Number(d.flow_usd ?? 0),
    priceUsd: Number(d.price_usd ?? 0),
    perFund:  Array.isArray(d.etf_flows) ? d.etf_flows : [],
  }));

  const latestDate = history[history.length - 1]?.date ?? new Date().toISOString().slice(0, 10);

  return { rows, history, latestDate, source: 'coinglass' };
}
