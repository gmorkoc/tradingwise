// Candle-source spike (Strategy Alerts plan, Step 0) confirmed Supabase
// Edge Functions CAN reach Binance directly at data-api.binance.vision —
// unlike Binance's main REST host, which is what 451s from this region (see
// btc-price-alert-push/index.ts's comment). Every server-side candle fetch
// goes through this one function so a future source change touches one file.
import { CandleDataPoint } from "./indicators.ts";

const BASE = "https://data-api.binance.vision/api/v3/klines";

export async function fetchKlines(coin: string, interval: string, limit: number): Promise<CandleDataPoint[]> {
  const symbol = `${coin.toUpperCase()}USDT`;
  const res = await fetch(`${BASE}?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`klines fetch failed for ${symbol} ${interval}: ${res.status}`);
  const raw: unknown[] = await res.json();
  return raw.map((row) => {
    const r = row as [number, string, string, string, string, string, ...unknown[]];
    return {
      time: Math.floor(r[0] / 1000),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
    };
  });
}
