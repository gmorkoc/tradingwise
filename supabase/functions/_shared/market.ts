// Shared by trading-agent-reply (proposing trades) and agent-watch-scan
// (re-checking standing watch conditions + TP/SL/liquidation) — both need
// the exact same live indicator snapshot for a coin, and having them drift
// out of sync would mean a watch could trigger on a reading the agent
// itself would never have proposed against.
import { fetchKlines } from "./klines.ts";
import { calcRSI, calcMACD, calcBB, calcATR, calcVolRatio, calcSMA, CandleDataPoint } from "./indicators.ts";

export interface MarketContext {
  coin: string;
  price: number;
  rsi: number | null;
  macdHist: number | null;
  bbPct: number | null;
  atr: number | null;
  volRatio: number | null;
  htfTrend: "up" | "down" | "range" | null;
  riskPct: number | null;
}

// A real desk trader never reads one timeframe in isolation — the 1h data
// drives entry timing/momentum, but a 4h SMA20-vs-SMA50 trend read decides
// whether a setup is "with the trend" (higher conviction) or "counter-trend"
// (needs a much stronger reason to take). Fetched alongside the 1h candles
// so this costs one extra request, not a second round trip.
export async function getMarketContext(coin: string): Promise<MarketContext | null> {
  try {
    const [candles, htfCandles]: [CandleDataPoint[], CandleDataPoint[]] = await Promise.all([
      fetchKlines(coin, "1h", 100),
      fetchKlines(coin, "4h", 60),
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
      price,
      rsi: calcRSI(candles),
      macdHist: macd.hist,
      bbPct: bb?.pct ?? null,
      atr,
      volRatio: calcVolRatio(candles),
      htfTrend,
      riskPct: atr != null && price > 0 ? (atr / price) * 100 : null,
    };
  } catch {
    return null;
  }
}
