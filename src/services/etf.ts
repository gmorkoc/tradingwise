import axios, { type AxiosInstance } from "axios";

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

export interface ETFRow {
  ticker: string;
  name: string;
  dailyFlowUsd: number;    // USD — positive = inflow, negative = outflow
  aumUsd: number;          // USD
  priceUsd: number;
  priceChangePct: number;
  volumeUsd: number;
  sharesOutstanding: number;
}

export interface ETFDayTotal {
  date: string;            // "YYYY-MM-DD"
  flowUsd: number;         // USD total net flow (positive = inflow)
  priceUsd: number;        // BTC price that day
  perFund: { etf_ticker: string; flow_usd: number }[];
}

export interface ETFData {
  rows: ETFRow[];          // latest fund snapshot
  history: ETFDayTotal[];  // 30-day daily totals
  latestDate: string;      // trading date of most recent history entry
}

const api = axios.create({ baseURL: "/cg-api", timeout: 15000 });
addRetry(api);

export async function getETFData(): Promise<ETFData> {
  const [listRes, histRes] = await Promise.all([
    api.get("/etf/bitcoin/list"),
    api.get("/etf/bitcoin/flow-history", { params: { days: 30 } }),
  ]);

  // ── Fund list ──────────────────────────────────────────────────────────
  interface CgFund {
    ticker: string;
    fund_name: string;
    aum_usd: string | number;
    volume_usd: string | number;
    price_usd: string | number;
    price_change_percent: string | number;
    shares_outstanding: string | number;
  }
  const fundArr: CgFund[] = listRes.data?.data ?? [];

  // ── Flow history ───────────────────────────────────────────────────────
  interface CgHistEntry {
    timestamp: number;
    flow_usd: number;
    price_usd: number;
    etf_flows: { etf_ticker: string; flow_usd: number }[];
  }
  const histArr: CgHistEntry[] = histRes.data?.data ?? [];

  // Latest trading day's per-fund flows for the table
  const latestEntry = histArr[histArr.length - 1];
  const latestFlowMap: Record<string, number> = {};
  if (latestEntry?.etf_flows) {
    latestEntry.etf_flows.forEach(f => { latestFlowMap[f.etf_ticker] = f.flow_usd; });
  }

  const rows: ETFRow[] = fundArr.map(f => ({
    ticker: f.ticker,
    name: f.fund_name,
    dailyFlowUsd: latestFlowMap[f.ticker] ?? 0,
    aumUsd: Number(f.aum_usd) || 0,
    priceUsd: Number(f.price_usd) || 0,
    priceChangePct: Number(f.price_change_percent) || 0,
    volumeUsd: Number(f.volume_usd) || 0,
    sharesOutstanding: Number(f.shares_outstanding) || 0,
  }));

  const history: ETFDayTotal[] = histArr.map(entry => ({
    date: new Date(entry.timestamp).toISOString().slice(0, 10),
    flowUsd: entry.flow_usd,
    priceUsd: entry.price_usd,
    perFund: entry.etf_flows ?? [],
  }));

  const latestDate = history[history.length - 1]?.date ?? new Date().toISOString().slice(0, 10);

  return { rows, history, latestDate };
}
