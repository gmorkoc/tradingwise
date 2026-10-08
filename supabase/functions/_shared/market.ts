// Shared by trading-agent-reply (proposing trades) and agent-watch-scan
// (re-checking standing watch conditions + TP/SL/liquidation) — both need
// the exact same live indicator snapshot for a coin, and having them drift
// out of sync would mean a watch could trigger on a reading the agent
// itself would never have proposed against.
import { fetchKlines } from "./klines.ts";
import { calcRSI, calcMACD, calcBB, calcATR, calcVolRatio, calcSMA, CandleDataPoint } from "./indicators.ts";

export type MarketInterval = "1h" | "4h" | "1d";

export interface MarketContext {
  coin: string;
  interval: MarketInterval;
  price: number;
  rsi: number | null;
  macdHist: number | null;
  bbPct: number | null;
  atr: number | null;
  volRatio: number | null;
  htfTrend: "up" | "down" | "range" | null;
  riskPct: number | null;
  // Last ~30 closes, oldest first — free to include (candles are already
  // fetched below regardless), just a trimmed slice for a client to draw a
  // sparkline from. agent-watch-scan, the other consumer of this function,
  // simply ignores the extra field — same cost as before for it.
  recentCloses: number[];
}

// The timeframe one step up from each supported interval — used for the
// higher-timeframe trend read, same "never read one timeframe in
// isolation" reasoning regardless of which interval is the primary one.
const HTF_FOR: Record<MarketInterval, string> = { "1h": "4h", "4h": "1d", "1d": "1w" };

// Default ("4h") is deliberate, not arbitrary — it matches the number this
// app's own header widget shows elsewhere (coinglass.ts's getAllBTCData,
// also built off 4h candles). Reasoning off a different timeframe than what
// the user can see on screen caused real, repeated confusion (a user
// quoting the header's RSI, which never matched what a watch here was
// actually checking) before this was aligned. A standing watch can still
// choose "1h" or "1d" explicitly (see agent_watches.interval) when the user
// wants faster or slower alerts than the header's own default.
export async function getMarketContext(coin: string, interval: MarketInterval = "4h"): Promise<MarketContext | null> {
  try {
    const [candles, htfCandles]: [CandleDataPoint[], CandleDataPoint[]] = await Promise.all([
      fetchKlines(coin, interval, 100),
      fetchKlines(coin, HTF_FOR[interval], 60),
    ]);
    if (candles.length < 20) return null;
    const price = candles[candles.length - 1].close;
    const macd = calcMACD(candles);
    const bb = calcBB(candles);
    const atr = calcATR(candles);

    let htfTrend: MarketContext["htfTrend"] = null;
    if (htfCandles.length >= 50) {
      const sma20 = calcSMA(htfCandles, 20);
      const sma50 = calcSMA(htfCandles, 50);
      if (sma20 != null && sma50 != null) {
        const spread = (sma20 - sma50) / sma50;
        htfTrend = spread > 0.01 ? "up" : spread < -0.01 ? "down" : "range";
      }
    }

    return {
      coin,
      interval,
      price,
      rsi: calcRSI(candles),
      macdHist: macd.hist,
      bbPct: bb?.pct ?? null,
      atr,
      volRatio: calcVolRatio(candles),
      htfTrend,
      riskPct: atr != null && price > 0 ? (atr / price) * 100 : null,
      recentCloses: candles.slice(-30).map((c) => c.close),
    };
  } catch {
    return null;
  }
}
