import { Capacitor } from "@capacitor/core";
import type { CoinSymbol, ExchangeLSData, ExchangeRatioRow } from "./coinglass";

// Long/short positioning for Position Intelligence (5-minute periods —
// both exchanges publish a new point every 5 min), from exchanges' own
// free public APIs. CoinGlass's long/short endpoints aren't on our plan
// (401 "Upgrade plan"), and Binance/Bybit block US requests, so this uses:
//   - OKX (via the existing /okx-api proxy — no CORS on OKX itself)
//   - Gate.io (open CORS, called directly)
// Same shape as coinglass.ts's ExchangeLSData so the UI doesn't care
// where it came from:
//   retail        = all accounts
//   whaleAccount  = top trader accounts ("Smart Money")
//   whalePosition = top trader positions, by size ("Whales")

// Gate.io also reports the top traders' actual long/short SIZE, which the
// UI shows in dollars on the Whales row. OKX only gives ratios.
export interface PositionIntelRow extends ExchangeLSData {
  whaleUsd?: { longUsd: number; shortUsd: number };
}

const OKX_BASE = Capacitor.isNativePlatform() ? "https://www.okx.com" : "/okx-api";
const GATE_BASE = "https://api.gateio.ws";

// Ratio (long ÷ short) → percentages.
function fromRatio(ratio: number): ExchangeRatioRow | null {
  if (!isFinite(ratio) || ratio <= 0) return null;
  const longPct = (ratio / (1 + ratio)) * 100;
  return { longPct, shortPct: 100 - longPct, ratio };
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function okx(coin: string): Promise<PositionIntelRow> {
  const inst = `${coin}-USDT-SWAP`;
  const q = `instId=${inst}&period=5m&limit=1`;
  const base = `${OKX_BASE}/api/v5/rubik/stat/contracts`;
  const [all, topAcct, topPos] = await Promise.all([
    getJson(`${base}/long-short-account-ratio-contract?${q}`),
    getJson(`${base}/long-short-account-ratio-contract-top-trader?${q}`),
    getJson(`${base}/long-short-position-ratio-contract-top-trader?${q}`),
  ]);
  // Rows are [timestamp, ratio], newest first.
  const pick = (r: any) => (r?.code === "0" && r.data?.[0] ? fromRatio(parseFloat(r.data[0][1])) : null);
  return { exchange: "OKX", retail: pick(all), whaleAccount: pick(topAcct), whalePosition: pick(topPos) };
}

async function gate(coin: string): Promise<PositionIntelRow> {
  const r = await getJson(`${GATE_BASE}/api/v4/futures/usdt/contract_stats?contract=${coin}_USDT&interval=5m&limit=1`);
  const d = Array.isArray(r) ? r[r.length - 1] : null;
  if (!d) return { exchange: "Gate.io", retail: null, whaleAccount: null, whalePosition: null };
  // Sizes are in contracts. USD per contract = open_interest_usd ÷
  // open_interest (contract multiplier × price, without a second request).
  const usdPerContract = Number(d.open_interest) > 0 ? Number(d.open_interest_usd) / Number(d.open_interest) : NaN;
  const longUsd = Number(d.top_long_size) * usdPerContract;
  const shortUsd = Number(d.top_short_size) * usdPerContract;
  return {
    exchange: "Gate.io",
    retail: fromRatio(Number(d.lsr_account)),
    whaleAccount: fromRatio(Number(d.top_lsr_account)),
    whalePosition: fromRatio(Number(d.top_lsr_size)),
    whaleUsd: isFinite(longUsd) && isFinite(shortUsd) && longUsd + shortUsd > 0 ? { longUsd, shortUsd } : undefined,
  };
}

export async function getPositionIntel(coin: CoinSymbol | string = "BTC"): Promise<PositionIntelRow[]> {
  const rows = await Promise.all([okx(coin), gate(coin)]);
  // Drop exchanges that returned nothing at all (e.g. coin not listed there).
  return rows.filter((r) => r.retail || r.whaleAccount || r.whalePosition);
}
