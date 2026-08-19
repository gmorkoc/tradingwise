import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  HistogramSeries,
  IChartApi,
  createSeriesMarkers,
  SeriesMarker,
  UTCTimestamp,
} from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol } from "../services/coinglass";
import { ZoneResult, ZoneSignal } from "./PriceChart.types";
import {
  getCandlePatternAnalysis,
  CandlePatternResult,
  ChartPrediction,
  getZoneAnalysis,
  ZoneAnalysisResult,
} from "../services/openai";
import { PredictionOverlay, PredictionPath } from "./DrawingOverlay";
import { OrderBookProfileModal } from "./OrderBookProfile";
import { PredictionModal } from "./PredictionModal";
import { ChartDrawingTools, Drawing, ChartDrawingToolsHandle } from "./ChartDrawingTools";
import { ZoneAnalysisModal } from "./ZoneAnalysisModal";
import { analyseLiquidations, LEVERAGES_ALL } from "../utils/liquidationClusters";
import { AstroSuggestions } from "./AstroSuggestions";
import { useAIQuota } from "../hooks/useAIQuota";
import "../styles/PriceChart.css";

type TimeInterval =
  | "1sec"
  | "1min"
  | "5min"
  | "15min"
  | "1h"
  | "4h"
  | "6h"
  | "1day"
  | "1week"
  | "all";
type IntervalTrends = Record<string, "bullish" | "bearish" | null>;

interface PriceChartProps {
  refreshTrigger?: number;
  theme?: "dark" | "light";
  coin?: CoinSymbol;
  onZoneChange?: (zone: ZoneResult | null, price: number) => void;
  onOpenAuth?: () => void;
  onOpenUpgrade?: (plan?: "pro" | "elite") => void;
}

const INTERVALS: TimeInterval[] = [
  "1sec",
  "1min",
  "5min",
  "15min",
  "1h",
  "4h",
  "6h",
  "1day",
  "1week",
  "all",
];

const INTERVAL_LABELS: Record<TimeInterval, string> = {
  "1sec": "1s  (last 30 min)",
  "1min": "1m  (last 6 hours)",
  "5min": "5m  (last 24 hours)",
  "15min": "15m (last 48 hours)",
  "1h": "1H  (~7 days)",
  "4h": "4H  (~4 weeks)",
  "6h": "6H  (~15 days)",
  "1day": "1D  (90 days)",
  "1week": "1W  (52 weeks)",
  "all": "ALL (full history)",
};

const INTERVAL_SHORT: Record<TimeInterval, string> = {
  "1sec": "1s",
  "1min": "1m",
  "5min": "5m",
  "15min": "15m",
  "1h": "1H",
  "4h": "4H",
  "6h": "6H",
  "1day": "1D",
  "1week": "1W",
  "all": "ALL",
};

// Intervals that require at least Pro
const PRO_INTERVALS = new Set<TimeInterval>(["1sec", "all"]);

const FIB_LEVELS = [
  { ratio: 0, label: "0", color: "rgba(251,191,36,0.85)" },
  { ratio: 0.236, label: "0.236", color: "rgba(167,139,250,0.85)" },
  { ratio: 0.382, label: "0.382", color: "rgba(52,211,153,0.85)" },
  { ratio: 0.5, label: "0.5", color: "rgba(251,113,133,0.85)" },
  { ratio: 0.618, label: "0.618", color: "rgba(56,189,248,0.85)" },
  { ratio: 0.786, label: "0.786", color: "rgba(249,115,22,0.85)" },
  { ratio: 1, label: "1", color: "rgba(251,191,36,0.85)" },
] as const;

// ── Utility: Bollinger Bands ────────────────────────────────────────────────

function calcBollingerBands(candles: CandleDataPoint[], period = 20, mult = 2) {
  const upper: { time: number; value: number }[] = [];
  const middle: { time: number; value: number }[] = [];
  const lower: { time: number; value: number }[] = [];

  for (let i = period - 1; i < candles.length; i++) {
    const closes = candles.slice(i - period + 1, i + 1).map((c) => c.close);
    const sma = closes.reduce((s, v) => s + v, 0) / period;
    const variance = closes.reduce((s, v) => s + (v - sma) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push({
      time: candles[i].time,
      value: Math.round((sma + mult * sd) * 100) / 100,
    });
    middle.push({ time: candles[i].time, value: Math.round(sma * 100) / 100 });
    lower.push({
      time: candles[i].time,
      value: Math.round((sma - mult * sd) * 100) / 100,
    });
  }
  return { upper, middle, lower };
}

// ── Utility: Support / Resistance ──────────────────────────────────────────

function calcSupportResistance(
  candles: CandleDataPoint[],
  lookback = 5,
  maxLevels = 5,
  tolerance = 0.005,
) {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const isSwingHigh = candles
      .slice(i - lookback, i + lookback + 1)
      .every((c, idx) => idx === lookback || c.high <= high);
    const isSwingLow = candles
      .slice(i - lookback, i + lookback + 1)
      .every((c, idx) => idx === lookback || c.low >= low);
    if (isSwingHigh) highs.push(high);
    if (isSwingLow) lows.push(low);
  }

  const cluster = (levels: number[]) => {
    const clusters: { price: number; count: number }[] = [];
    for (const price of levels) {
      const existing = clusters.find(
        (c) => Math.abs(c.price - price) / price < tolerance,
      );
      if (existing) {
        existing.price =
          (existing.price * existing.count + price) / (existing.count + 1);
        existing.count++;
      } else {
        clusters.push({ price, count: 1 });
      }
    }
    return clusters.sort((a, b) => b.count - a.count).slice(0, maxLevels);
  };

  return { resistance: cluster(highs), support: cluster(lows) };
}

// ── Utility: Buy / Sell Zones ──────────────────────────────────────────────

function calcBuySellZones(candles: CandleDataPoint[]): ZoneResult | null {
  if (candles.length < 20) return null;

  const last = candles[candles.length - 1];
  const { upper, lower } = calcBollingerBands(candles);
  const { resistance, support } = calcSupportResistance(candles);

  const topBand = upper[upper.length - 1]?.value;
  const botBand = lower[lower.length - 1]?.value;
  if (!topBand || !botBand || topBand === botBand) return null;

  const bbPos = (last.close - botBand) / (topBand - botBand);
  const buyRef = support[0]?.price ?? botBand;
  const sellRef = resistance[0]?.price ?? topBand;

  const buyZone = { upper: buyRef * 1.006, lower: buyRef * 0.994 };
  const sellZone = { upper: sellRef * 1.006, lower: sellRef * 0.994 };

  // Trend context via EMA50 — prevents "Strong Buy" in a downtrend
  const closes = candles.map((c) => c.close);
  const ema50arr = coinglass.calculateEMA(closes, 50);
  const ema50 = ema50arr[ema50arr.length - 1];
  const downtrend = ema50 != null && last.close < ema50;
  const uptrend = ema50 != null && last.close > ema50;

  let signal: ZoneSignal;
  if (bbPos <= 0.12 || last.close <= buyZone.upper)
    signal = downtrend ? "oversold" : "strong-buy";
  else if (bbPos <= 0.35) signal = downtrend ? "neutral" : "buy";
  else if (bbPos >= 0.88 || last.close >= sellZone.lower)
    signal = uptrend ? "overbought" : "strong-sell";
  else if (bbPos >= 0.65) signal = uptrend ? "neutral" : "sell";
  else signal = "neutral";

  return { buyZone, sellZone, signal };
}

// ── Utility: RSI ───────────────────────────────────────────────────────────

function calcRSI(
  candles: CandleDataPoint[],
  period = 14,
): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  if (candles.length <= period) return result;

  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  result.push({
    time: candles[period].time,
    value: +(100 - 100 / (1 + avgGain / (avgLoss || 1e-10))).toFixed(2),
  });

  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result.push({
      time: candles[i].time,
      value: +(100 - 100 / (1 + avgGain / (avgLoss || 1e-10))).toFixed(2),
    });
  }
  return result;
}

// ── Utility: RSI Divergence detection ─────────────────────────────────────

interface DivergenceResult {
  type: "bullish" | "bearish";
  pivots: { time: number; price: number; rsi: number }[];
}

function detectRSIDivergence(
  candles: CandleDataPoint[],
  rsiData: { time: number; value: number }[],
  lookback = 120,
): DivergenceResult | null {
  if (candles.length < 14 || rsiData.length < 5) return null;
  const recent = candles.slice(-Math.min(candles.length, lookback));
  // Smaller datasets need a tighter window to find enough swing points
  const swingWindow = recent.length >= 60 ? 3 : recent.length >= 30 ? 2 : 1;
  const rsiByTime = new Map(rsiData.map((r) => [r.time, r.value]));

  const swingLows: { time: number; price: number; rsi: number }[] = [];
  const swingHighs: { time: number; price: number; rsi: number }[] = [];

  for (let i = swingWindow; i < recent.length - swingWindow; i++) {
    const c = recent[i];
    const rsi = rsiByTime.get(c.time as number);
    if (rsi === undefined) continue;
    let isLow = true,
      isHigh = true;
    for (let j = i - swingWindow; j <= i + swingWindow; j++) {
      if (j === i) continue;
      if (recent[j].low < c.low) isLow = false;
      if (recent[j].high > c.high) isHigh = false;
    }
    if (isLow) swingLows.push({ time: c.time as number, price: c.low, rsi });
    if (isHigh) swingHighs.push({ time: c.time as number, price: c.high, rsi });
  }

  if (swingLows.length >= 2) {
    const l1 = swingLows[swingLows.length - 2];
    const l2 = swingLows[swingLows.length - 1];
    if (l2.price < l1.price && l2.rsi > l1.rsi + 0.2)
      return { type: "bullish", pivots: [l1, l2] };
  }
  if (swingHighs.length >= 2) {
    const h1 = swingHighs[swingHighs.length - 2];
    const h2 = swingHighs[swingHighs.length - 1];
    if (h2.price > h1.price && h2.rsi < h1.rsi - 0.2)
      return { type: "bearish", pivots: [h1, h2] };
  }
  return null;
}

// ── Utility: SMA / EMA overlay lines ──────────────────────────────────────

function calcSMALine(
  candles: CandleDataPoint[],
  period: number,
): { time: number; value: number }[] {
  const result: { time: number; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    result.push({ time: candles[i].time, value: +(sum / period).toFixed(2) });
  }
  return result;
}

function calcEMALine(
  candles: CandleDataPoint[],
  period: number,
): { time: number; value: number }[] {
  if (candles.length < period) return [];
  const closes = candles.map((c) => c.close);
  const out = emaArr(closes, period);
  const result: { time: number; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    result.push({ time: candles[i].time, value: +out[i].toFixed(2) });
  }
  return result;
}

// ── Utility: EMA + MACD ────────────────────────────────────────────────────

function emaArr(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function calcMACD(
  candles: CandleDataPoint[],
  fast = 12,
  slow = 26,
  signal = 9,
) {
  const closes = candles.map((c) => c.close);
  const emaF = emaArr(closes, fast);
  const emaS = emaArr(closes, slow);

  const raw: number[] = [];
  const times: number[] = [];
  for (let i = slow - 1; i < candles.length; i++) {
    raw.push(emaF[i] - emaS[i]);
    times.push(candles[i].time);
  }

  const sig = emaArr(raw, signal);
  const macdLine: { time: number; value: number }[] = [];
  const signalLine: { time: number; value: number }[] = [];
  const histogram: { time: number; value: number; color: string }[] = [];

  for (let i = signal - 1; i < raw.length; i++) {
    const m = raw[i],
      s = sig[i],
      h = m - s;
    const prev = histogram[histogram.length - 1]?.value ?? h;
    const color =
      h >= 0
        ? h >= prev
          ? "rgba(34,197,94,0.85)"
          : "rgba(34,197,94,0.45)"
        : h <= prev
          ? "rgba(239,68,68,0.85)"
          : "rgba(239,68,68,0.45)";
    macdLine.push({ time: times[i], value: +m.toFixed(2) });
    signalLine.push({ time: times[i], value: +s.toFixed(2) });
    histogram.push({ time: times[i], value: +h.toFixed(2), color });
  }
  return { macdLine, signalLine, histogram };
}

// ── Utility: CME Gaps ─────────────────────────────────────────────────────

interface CMEGap {
  top: number;
  bottom: number;
  direction: "up" | "down";
}

function calcCMEGaps(candles: CandleDataPoint[]): CMEGap[] {
  const gaps: CMEGap[] = [];

  for (let i = 0; i < candles.length - 1; i++) {
    const date = new Date(candles[i].time * 1000);
    if (date.getUTCDay() !== 5) continue; // Only Friday candles

    // Find Monday within the next 3 candles
    let mondayIdx = -1;
    for (let j = i + 1; j < Math.min(i + 4, candles.length); j++) {
      if (new Date(candles[j].time * 1000).getUTCDay() === 1) {
        mondayIdx = j;
        break;
      }
    }
    if (mondayIdx === -1) continue;

    const fridayClose = candles[i].close;
    const mondayOpen = candles[mondayIdx].open;
    const gapPct = Math.abs(mondayOpen - fridayClose) / fridayClose;
    if (gapPct < 0.001) continue; // Skip gaps < 0.1%

    const isGapUp = mondayOpen > fridayClose;
    const top = Math.max(fridayClose, mondayOpen);
    const bottom = Math.min(fridayClose, mondayOpen);

    // Check if filled by any subsequent candle
    let filled = false;
    for (let j = mondayIdx + 1; j < candles.length; j++) {
      if (isGapUp ? candles[j].low <= bottom : candles[j].high >= top) {
        filled = true;
        break;
      }
    }

    if (!filled) {
      gaps.push({ top, bottom, direction: isGapUp ? "up" : "down" });
    }
  }

  return gaps;
}

// ── Interval analysis + candle pattern (unchanged) ─────────────────────────

interface IntervalAnalysis {
  sentiment: "bullish" | "bearish" | "neutral";
  title: string;
  body: string;
}

function analyzeInterval(
  candles: CandleDataPoint[],
  intervalLabel: string,
): IntervalAnalysis {
  if (candles.length < 5) {
    return {
      sentiment: "neutral",
      title: "Not enough data",
      body: "Insufficient candle history to analyse this interval.",
    };
  }
  const first = candles[0],
    last = candles[candles.length - 1];
  const overallChange = (last.close - first.close) / first.close;
  const pct = (overallChange * 100).toFixed(2);
  const absPct = Math.abs(parseFloat(pct));
  const recent = candles.slice(-5);
  const greenCount = recent.filter((c) => c.close > c.open).length;
  const redCount = recent.filter((c) => c.close < c.open).length;
  const { upper, lower } = calcBollingerBands(candles);
  const topBand = upper[upper.length - 1]?.value;
  const botBand = lower[lower.length - 1]?.value;
  const bbPos =
    topBand && botBand && topBand !== botBand
      ? (last.close - botBand) / (topBand - botBand)
      : 0.5;
  const isBullish = overallChange > 0;

  if (bbPos > 0.85)
    return {
      sentiment: "bullish",
      title: `Pushing the Upper Band on ${intervalLabel}`,
      body: `Price is up ${pct}% and pressing against the upper Bollinger Band. Momentum is strong, but the market may be overextended — a short-term cooldown or sideways consolidation is common before the next leg higher.`,
    };
  if (bbPos < 0.15)
    return {
      sentiment: "bearish",
      title: `Testing the Lower Band on ${intervalLabel}`,
      body: `Price has fallen ${absPct}% and is compressing near the lower Bollinger Band. Sellers have been dominant, but this zone often attracts buyers — watch for a relief bounce or a confirmed breakdown below support.`,
    };
  if (greenCount >= 4)
    return {
      sentiment: "bullish",
      title: `Strong Buying Pressure on ${intervalLabel}`,
      body: `${greenCount} of the last 5 candles closed green with price up ${pct}% overall. Buyers are clearly in control. The trend could extend, but watch for a pullback to the mid-band as profit-taking kicks in.`,
    };
  if (redCount >= 4)
    return {
      sentiment: "bearish",
      title: `Sustained Selling on ${intervalLabel}`,
      body: `${redCount} of the last 5 candles closed red with price down ${absPct}% overall. Sellers are dominating. A short-term oversold bounce is possible, but the path of least resistance remains lower until buyers reclaim momentum.`,
    };
  if (absPct < 0.3)
    return {
      sentiment: "neutral",
      title: `Tight Consolidation on ${intervalLabel}`,
      body: `Price has moved just ${pct}% over this window and is coiling near the middle band. The market is in indecision — a directional breakout is building. Watch volume and the next 2–3 candles for a clue.`,
    };
  if (isBullish)
    return {
      sentiment: "bullish",
      title: `Upward Bias on ${intervalLabel}`,
      body: `Price is up ${pct}% with ${greenCount} of the last 5 candles green. The trend leans bullish but lacks explosive momentum — likely a steady grind higher unless macro sentiment shifts.`,
    };
  return {
    sentiment: "bearish",
    title: `Downward Bias on ${intervalLabel}`,
    body: `Price is down ${absPct}% with ${redCount} of the last 5 candles red. Bearish pressure is present but not extreme — watch for stabilisation near the lower band or a key support level before calling a reversal.`,
  };
}

// ── AI pattern cache ────────────────────────────────────────────────────────
type PatternInsight = CandlePatternResult;

function patternCacheKey(coin: string, interval: string) {
  return `ai_pattern_${coin}_${interval}`;
}
function readPatternCache(
  coin: string,
  interval: string,
): PatternInsight | null {
  try {
    const r = localStorage.getItem(patternCacheKey(coin, interval));
    return r ? JSON.parse(r) : null;
  } catch {
    return null;
  }
}
function writePatternCache(
  coin: string,
  interval: string,
  data: PatternInsight,
) {
  try {
    localStorage.setItem(patternCacheKey(coin, interval), JSON.stringify(data));
  } catch {}
}

// ── Gann Pivot Detection ────────────────────────────────────────────────────

interface GannPivot {
  time: number;
  price: number;
  type: "high" | "low";
}

interface GannCycleDate {
  label: string;
  timestamp: number;
  isPast: boolean;
}

function detectGannPivots(candles: CandleDataPoint[], n: number): GannPivot[] {
  const pivots: GannPivot[] = [];
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i];
    let isHigh = true,
      isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) pivots.push({ time: c.time, price: c.high, type: "high" });
    if (isLow) pivots.push({ time: c.time, price: c.low, type: "low" });
  }
  return pivots;
}

// Gann time cycle offsets in seconds for different interval granularities
const GANN_CYCLE_OFFSETS: Record<string, { label: string; seconds: number }[]> =
  {
    daily: [
      { label: "30d", seconds: 30 * 86400 },
      { label: "45d", seconds: 45 * 86400 },
      { label: "60d", seconds: 60 * 86400 },
      { label: "90d", seconds: 90 * 86400 },
      { label: "120d", seconds: 120 * 86400 },
      { label: "144d", seconds: 144 * 86400 },
      { label: "180d", seconds: 180 * 86400 },
      { label: "270d", seconds: 270 * 86400 },
      { label: "360d", seconds: 360 * 86400 },
    ],
    hourly: [
      { label: "24h", seconds: 24 * 3600 },
      { label: "48h", seconds: 48 * 3600 },
      { label: "72h", seconds: 72 * 3600 },
      { label: "90h", seconds: 90 * 3600 },
      { label: "120h", seconds: 120 * 3600 },
      { label: "144h", seconds: 144 * 3600 },
      { label: "180h", seconds: 180 * 3600 },
    ],
    minutes: [
      { label: "4h", seconds: 4 * 3600 },
      { label: "8h", seconds: 8 * 3600 },
      { label: "12h", seconds: 12 * 3600 },
      { label: "24h", seconds: 24 * 3600 },
      { label: "48h", seconds: 48 * 3600 },
    ],
  };

function gannCycleGroup(interval: string): string {
  if (interval === "1day" || interval === "1week") return "daily";
  if (interval === "1h" || interval === "4h" || interval === "6h")
    return "hourly";
  return "minutes";
}

function computeGannCycles(
  lastPivot: GannPivot,
  interval: string,
): GannCycleDate[] {
  const now = Date.now() / 1000;
  const offsets = GANN_CYCLE_OFFSETS[gannCycleGroup(interval)];
  return offsets.map(({ label, seconds }) => {
    const timestamp = lastPivot.time + seconds;
    return { label, timestamp, isPast: timestamp < now };
  });
}

// kept as instant fallback while AI loads
function detectCandlePattern(
  candles: CandleDataPoint[],
): PatternInsight | null {
  if (candles.length < 3) return null;
  const c0 = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];
  const c2 = candles[candles.length - 3];
  const rng = (c: CandleDataPoint) => Math.max(c.high - c.low, 0.0001);
  const bod = (c: CandleDataPoint) => Math.abs(c.close - c.open);
  const upW = (c: CandleDataPoint) => c.high - Math.max(c.open, c.close);
  const loW = (c: CandleDataPoint) => Math.min(c.open, c.close) - c.low;
  const mid = (c: CandleDataPoint) => (c.open + c.close) / 2;
  const bull = (c: CandleDataPoint) => c.close > c.open;
  const bear = (c: CandleDataPoint) => c.close < c.open;

  if (
    bull(c2) &&
    bull(c1) &&
    bull(c0) &&
    c1.close > c2.close &&
    c0.close > c1.close &&
    bod(c2) / rng(c2) > 0.5 &&
    bod(c1) / rng(c1) > 0.5 &&
    bod(c0) / rng(c0) > 0.5
  )
    return {
      name: "Three White Soldiers",
      type: "bullish",
      summary:
        "Three consecutive bullish candles, each closing higher with strong bodies.",
      narrative:
        "Market makers are in full accumulation mode — they are buying every dip and not allowing sellers any foothold. Each candle opens near the prior close and extends gains without meaningful pullback, signalling institutional conviction.",
      nextMove:
        "Momentum strongly favours continuation higher. Look for a break above the current high as confirmation. A pullback to the middle candle's body is a potential re-entry zone before the next leg up.",
    };
  if (
    bear(c2) &&
    bear(c1) &&
    bear(c0) &&
    c1.close < c2.close &&
    c0.close < c1.close &&
    bod(c2) / rng(c2) > 0.5 &&
    bod(c1) / rng(c1) > 0.5 &&
    bod(c0) / rng(c0) > 0.5
  )
    return {
      name: "Three Black Crows",
      type: "bearish",
      summary:
        "Three consecutive bearish candles, each closing lower with strong bodies.",
      narrative:
        "Institutional sellers are systematically distributing. Every relief bounce is being sold — market makers are preventing any meaningful recovery, suggesting they are positioned short or offloading large inventory onto retail buyers.",
      nextMove:
        "Expect further downside. Each bounce toward the previous candle's open is a potential short entry. The move is likely over-extended short-term, so watch for a brief relief bounce before the next leg lower.",
    };
  if (
    bear(c2) &&
    bod(c1) / rng(c1) < 0.35 &&
    bull(c0) &&
    c0.close > mid(c2) &&
    bod(c2) / rng(c2) > 0.4
  )
    return {
      name: "Morning Star",
      type: "bullish",
      summary:
        "Three-candle bottom reversal: large red → small indecisive → large green.",
      narrative:
        "Market makers engineered a classic stop-hunt then reversed. The large red candle shook out weak longs, the small middle candle shows sellers losing conviction at the lows, and the strong green candle confirms institutions stepped in and absorbed all the supply.",
      nextMove:
        "Bullish bias. A close above the morning star high is the trigger for long entries. The prior swing low from the red candle now acts as key support — if price revisits and holds, that is the higher-probability entry with tight risk.",
    };
  if (
    bull(c2) &&
    bod(c1) / rng(c1) < 0.35 &&
    bear(c0) &&
    c0.close < mid(c2) &&
    bod(c2) / rng(c2) > 0.4
  )
    return {
      name: "Evening Star",
      type: "bearish",
      summary:
        "Three-candle top reversal: large green → small indecisive → large red.",
      narrative:
        "Market makers distributed inventory at the highs. The bullish candle lured in retail buyers, the small middle candle revealed buyer exhaustion, and the bearish candle confirms institutions unloaded onto the crowd. Retail longs are now trapped.",
      nextMove:
        "Bearish bias. A break below the evening star low is the trigger for short entries. The prior swing high from the green candle now acts as resistance — any failed rally back into that level is a distribution signal.",
    };
  if (bear(c1) && bull(c0) && c0.open < c1.close && c0.close > c1.open)
    return {
      name: "Bullish Engulfing",
      type: "bullish",
      summary:
        "Large green candle completely engulfs the prior red candle's body.",
      narrative:
        "Institutional buyers stepped in with force. The green candle consuming the entire prior red signals market makers absorbed all seller supply and then pushed price beyond the open. Traders who sold the previous candle are now trapped short.",
      nextMove:
        "Bullish. Their stop-losses sit above the engulfing candle's high — when hit, they add fuel to the rally. Target the next resistance zone or prior swing high. Hold long as long as price stays above the midpoint of the engulfing candle.",
    };
  if (bull(c1) && bear(c0) && c0.open > c1.close && c0.close < c1.open)
    return {
      name: "Bearish Engulfing",
      type: "bearish",
      summary:
        "Large red candle completely engulfs the prior green candle's body.",
      narrative:
        "Institutional sellers appeared suddenly and overwhelmed buyers. The red candle consuming the entire prior green signals market makers distributed inventory to retail buyers who chased the move up. Those buyers are now underwater.",
      nextMove:
        "Bearish. Their stop-losses below the engulfing candle's low will accelerate the drop when triggered. Target the next support zone or prior swing low. Avoid longs until price reclaims the midpoint of the engulfing candle.",
    };
  if (bear(c1) && bull(c0) && c0.open < c1.low && c0.close > mid(c1))
    return {
      name: "Piercing Line",
      type: "bullish",
      summary:
        "Green candle opens below the red low but closes above the red midpoint.",
      narrative:
        "Market makers swept below support to trigger stop-losses — a classic liquidity grab — then reversed sharply as institutions absorbed the flush. Every seller who chased the breakdown is now losing money.",
      nextMove:
        "Bullish. The next likely move is back toward the top of the red candle. If price holds above the piercing candle's midpoint on any pullback, the reversal is intact. A break above the red candle's open confirms the pattern.",
    };
  if (bull(c1) && bear(c0) && c0.open > c1.high && c0.close < mid(c1))
    return {
      name: "Dark Cloud Cover",
      type: "bearish",
      summary:
        "Red candle opens above the green high but closes below the green midpoint.",
      narrative:
        "Market makers used the gap higher to offload supply onto retail buyers chasing the breakout. The rejection deep into the prior green candle's body shows institutions sold aggressively into strength — a textbook distribution move.",
      nextMove:
        "Bearish. The next likely move is back toward the bottom of the green candle. If price fails to reclaim the dark cloud candle's open on a bounce, the distribution is confirmed. A break below the green candle's low opens up further downside.",
    };
  if (
    bear(c1) &&
    bull(c0) &&
    c0.open > c1.close &&
    c0.close < c1.open &&
    bod(c1) > bod(c0) * 2
  )
    return {
      name: "Bullish Harami",
      type: "bullish",
      summary:
        "Small green candle completely inside the prior large red candle's body.",
      narrative:
        "Selling momentum is stalling — the bears can no longer push price lower. Market makers may be quietly absorbing supply within the prior red candle's range, building a base without drawing attention.",
      nextMove:
        "Watch for the breakout direction. A close above the harami high (prior red candle's open) signals buyers are taking over. A close below the harami low (prior red candle's close) means the trend continues — wait for one of these confirmations before acting.",
    };
  if (
    bull(c1) &&
    bear(c0) &&
    c0.open < c1.close &&
    c0.close > c1.open &&
    bod(c1) > bod(c0) * 2
  )
    return {
      name: "Bearish Harami",
      type: "bearish",
      summary:
        "Small red candle completely inside the prior large green candle's body.",
      narrative:
        "Buying momentum is losing steam — bulls can no longer extend the move. Market makers may be quietly distributing into strength within the prior green candle's range, without triggering a panic that would close their positions at worse prices.",
      nextMove:
        "Watch for the breakout direction. A close below the harami low (prior green candle's open) signals sellers are taking control. A close above the harami high (prior green candle's close) means the trend resumes — wait for confirmation.",
    };

  const r0 = rng(c0),
    b0 = bod(c0),
    u0 = upW(c0),
    l0 = loW(c0);
  if (b0 / r0 < 0.06) {
    if (u0 / r0 > 0.6 && l0 / r0 < 0.1)
      return {
        name: "Gravestone Doji",
        type: "bearish",
        summary:
          "Price rallied strongly then fell back to the open — buyers rejected at the top.",
        narrative:
          "Market makers drove price higher to collect buy-stop liquidity from breakout traders, then aggressively sold into the move. The long upper wick is a clear supply rejection — institutions used retail FOMO as exit liquidity.",
        nextMove:
          "Bearish bias. A close below the gravestone's low on the next candle is a strong sell signal. The high of this candle is now a key resistance level — failed re-tests of that high are short opportunities.",
      };
    if (l0 / r0 > 0.6 && u0 / r0 < 0.1)
      return {
        name: "Dragonfly Doji",
        type: "bullish",
        summary:
          "Price fell sharply but buyers fully reclaimed the open — sellers rejected at the bottom.",
        narrative:
          "Market makers swept below support to hunt stop-losses and collect cheap inventory, then immediately reversed. The long lower wick shows every unit of selling was absorbed by institutional buyers — a classic stop-hunt accumulation move.",
        nextMove:
          "Bullish bias. A close above the dragonfly's high on the next candle is a strong buy signal. The low of this candle now acts as key support — a hold above that level on any pullback is a long entry with tight risk.",
      };
    return {
      name: "Doji",
      type: "neutral",
      summary:
        "Open and close are virtually equal — market is in perfect equilibrium.",
      narrative:
        "Neither buyers nor sellers have the upper hand. Market makers are absorbing orders on both sides without committing to a direction yet. This standoff typically precedes a sharp move once one side capitulates.",
      nextMove:
        "Wait for the breakout. A close above the doji high is a bullish trigger; below the doji low is bearish. The larger the next candle's body in either direction, the more conviction behind the move — volume confirms.",
    };
  }
  if (b0 / r0 > 0.9) {
    if (bull(c0))
      return {
        name: "Bullish Marubozu",
        type: "bullish",
        summary:
          "No wicks — buyers controlled the entire candle with zero hesitation.",
        narrative:
          "Pure institutional buying pressure. Market makers opened and drove price higher without allowing any meaningful pullback — there were simply no sellers willing to step in. This one-sided aggression signals strong demand at this price level.",
        nextMove:
          "Strongly bullish. The open of this candle now acts as major support — a pullback to that level is a high-probability long entry. Expect continuation toward the next major resistance level, with minimal consolidation.",
      };
    return {
      name: "Bearish Marubozu",
      type: "bearish",
      summary:
        "No wicks — sellers controlled the entire candle with zero hesitation.",
      narrative:
        "Pure institutional selling pressure. Market makers drove price lower from open to close without pause — buyers had no meaningful window to fight back. This relentless aggression signals strong supply at this price level.",
      nextMove:
        "Strongly bearish. The open of this candle now acts as major resistance — a bounce to that level is a high-probability short entry. Expect continuation toward the next major support level.",
    };
  }
  if (l0 / r0 >= 0.55 && u0 / r0 <= 0.15 && b0 / r0 <= 0.3) {
    const isDown =
      candles.length >= 5 && c0.close < candles[candles.length - 5].close;
    if (isDown)
      return {
        name: "Hammer",
        type: "bullish",
        summary:
          "Long lower wick shows sellers failed — buyers absorbed every unit of supply.",
        narrative:
          "Market makers engineered a stop-loss sweep below support. The long wick reveals that sellers pushed hard but institutions absorbed it all and reclaimed the open. This shakeout move removes weak hands before a reversal.",
        nextMove:
          "Bullish if the next candle closes above the hammer's high. The low of the wick is now critical support — that level represents where institutions chose to buy. A re-test and hold of that zone is a high-probability entry.",
      };
    return {
      name: "Hanging Man",
      type: "bearish",
      summary:
        "Hammer shape after an uptrend — sellers are beginning to push back.",
      narrative:
        "Despite the visual recovery, this is a distribution warning at the top. Market makers allowed price to dip sharply, revealing that sellers are becoming active at these elevated levels. The recovery masks underlying selling pressure building.",
      nextMove:
        "Bearish if the next candle closes below the hanging man's low. The high of this candle is now resistance — watch for a failed re-test of that level, which would confirm distribution is underway.",
    };
  }
  if (u0 / r0 >= 0.55 && l0 / r0 <= 0.15 && b0 / r0 <= 0.3) {
    const isUp =
      candles.length >= 5 && c0.close > candles[candles.length - 5].close;
    if (isUp)
      return {
        name: "Shooting Star",
        type: "bearish",
        summary:
          "Long upper wick shows buyers failed — sellers absorbed every rally attempt.",
        narrative:
          "Market makers used the spike higher to offload inventory onto retail traders chasing the breakout. The long wick is evidence of institutional selling into strength — every buyer at the top is immediately losing money.",
        nextMove:
          "Bearish if the next candle closes below the shooting star's low. The high of the wick is now strong resistance — short entries on a failed re-test of that level offer a favourable risk/reward setup.",
      };
    return {
      name: "Inverted Hammer",
      type: "bullish",
      summary:
        "Long upper wick after a downtrend — buyers tested higher ground from the lows.",
      narrative:
        "Market makers may be testing resistance from below. Buyers pushed price up significantly before sellers regained control, signalling weakening seller dominance. This is a first sign of demand emerging after a decline.",
      nextMove:
        "Bullish if the next candle closes above the inverted hammer's high — that confirms buyers are taking control. Wait for that confirmation candle before acting; without it, the pattern has no follow-through.",
    };
  }
  if (c0.high < c1.high && c0.low > c1.low)
    return {
      name: "Inside Bar (Consolidation)",
      type: "neutral",
      summary:
        "Current candle is fully within the prior candle's range — coiling for a breakout.",
      narrative:
        "Market makers are absorbing orders quietly within a tight range, building energy for a directional move. This compression pattern is favoured by institutions before they commit to a trend — it keeps retail guessing while they position.",
      nextMove:
        "The break above the prior candle's high is bullish; below the prior low is bearish. The larger the breakout candle's body relative to the inside bar, the stronger the conviction. Trade the breakout, not the inside bar itself.",
    };
  if (candles.length >= 5) {
    const slice = candles.slice(-5);
    if (slice.every((c) => c.close > c.open))
      return {
        name: "Sustained Bullish Momentum",
        type: "bullish",
        summary:
          "Five consecutive green candles — buyers have dominated without pause.",
        narrative:
          "Institutions are systematically accumulating. Every potential pullback is being bought immediately — market makers are not allowing sellers any traction, signalling they want price higher before retail fully participates.",
        nextMove:
          "Momentum favours continuation, but 5 straight green candles often lead to a short-term pause or minor pullback. Wait for a 1-2 candle consolidation and a close back above the prior high for the next entry. The first red candle is not a reversal — it is a reset.",
      };
    if (slice.every((c) => c.close < c.open))
      return {
        name: "Sustained Bearish Momentum",
        type: "bearish",
        summary:
          "Five consecutive red candles — sellers have dominated without pause.",
        narrative:
          "Institutions are systematically distributing. Every attempted bounce is being sold — market makers are preventing any meaningful recovery, signalling they are positioned short or unloading inventory progressively.",
        nextMove:
          "Momentum favours continuation lower, but 5 straight red candles often produce a short-term bounce. Shorts should manage risk and trail stops. The first green candle is not a reversal — it is a breather before the next leg down.",
      };
  }
  return null;
}

// Applies overall-trend context so the pattern and banner never contradict.
// If the detected pattern is bullish but the interval is in a downtrend
// (or vice versa), the type is softened to "neutral" and the nextMove note
// is prefixed with a counter-trend warning.
function trendAwarePattern(
  candles: CandleDataPoint[],
  bannerSentiment: "bullish" | "bearish" | "neutral" | null,
): PatternInsight | null {
  const result = detectCandlePattern(candles);
  if (!result || !bannerSentiment || bannerSentiment === "neutral")
    return result;

  if (result.type === "bullish" && bannerSentiment === "bearish")
    return {
      ...result,
      type: "neutral",
      nextMove:
        "Counter-trend signal — the overall move is still bearish. " +
        result.nextMove +
        " Wait for the dominant trend to shift before treating this as a primary long entry.",
    };
  if (result.type === "bearish" && bannerSentiment === "bullish")
    return {
      ...result,
      type: "neutral",
      nextMove:
        "Counter-trend signal — the overall move is still bullish. " +
        result.nextMove +
        " Treat this as a caution flag rather than a primary short signal.",
    };
  return result;
}

// ── Component ──────────────────────────────────────────────────────────────

export const PriceChart: React.FC<PriceChartProps> = ({
  refreshTrigger,
  theme = "dark",
  coin = "BTC",
  onZoneChange,
  onOpenUpgrade = () => {},
}) => {
  const { t, i18n } = useTranslation();
  const { exceeded, consume, isPaid } = useAIQuota();
  const isLight = theme === "light";

  const [interval, setInterval] = useState<TimeInterval>("1h");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [trends, setTrends] = useState<IntervalTrends>({});
  const [banner, setBanner] = useState<IntervalAnalysis | null>(null);
  const [zone, setZone] = useState<ZoneResult | null>(null);
  const [patternInsight, setPatternInsight] = useState<PatternInsight | null>(
    () => readPatternCache(coin, "1h"),
  );
  const [showBB, setShowBB] = useState(true);
  const [showRSI, setShowRSI] = useState(false);
  const [showMACD, setShowMACD] = useState(false);
  const [showEMA20, setShowEMA20] = useState(true);
  const [showEMA50, setShowEMA50] = useState(true);
  const [showEMA200, setShowEMA200] = useState(false);
  const [showMA20, setShowMA20] = useState(false);
  const [showMA50, setShowMA50] = useState(false);
  const [showMA200, setShowMA200] = useState(false);
  const [showGann, setShowGann] = useState(false);
  const [showFib, setShowFib] = useState(false);
  const fibDefaultSet = useRef(false);
  const [gannCycles, setGannCycles] = useState<GannCycleDate[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCME, setShowCME] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [dayHigh, setDayHigh] = useState<number | null>(null);
  const [dayLow, setDayLow] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dayLineRefs = useRef<any[]>([]);

  const [showDepthProfile, setShowDepthProfile] = useState(false);
  const [showAstroChart, setShowAstroChart] = useState(false);
  const chartSectionRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const textColor = isLight
    ? isFullscreen
      ? "#0f172a"
      : "#475569"
    : "#94a3b8";
  const gridColor = isLight
    ? isFullscreen
      ? "#94a3b8"
      : "#e2e8f0"
    : "#1e293b";
  const bgColor = isLight ? (isFullscreen ? "#f8fafc" : "#ffffff") : "#0f172a";
  // true when we're using the CSS fallback (iOS / no Fullscreen API)
  const cssFsRef = useRef(false);

  // Set Fib default to true only for Pro+ users, once tier is known
  useEffect(() => {
    if (fibDefaultSet.current) return;
    fibDefaultSet.current = true;
    if (isPaid) setShowFib(true);
  }, [isPaid]);

  useEffect(() => {
    const onChange = () => {
      if (!cssFsRef.current) setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) {
      cssFsRef.current = false;
      setIsFullscreen(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      return;
    }
    cssFsRef.current = true;
    setIsFullscreen(true);
  }, [isFullscreen]);

  const fsScrollRef = useRef<HTMLDivElement>(null);

  const updateFsThumb = useCallback(() => {}, []);

  useEffect(() => {
    if (!isFullscreen) return;
    const t = setTimeout(updateFsThumb, 120);
    return () => clearTimeout(t);
  }, [isFullscreen, updateFsThumb]);

  // Manual touch-scroll: intercept in capture phase before LWC canvas consumes events
  useEffect(() => {
    if (!isFullscreen) return;
    const outer = chartSectionRef.current;
    const inner = fsScrollRef.current;
    if (!outer || !inner) return;

    let startY = 0;
    let startX = 0;
    let startScrollTop = 0;
    let scrolling: boolean | null = null;

    const onStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      startScrollTop = inner.scrollTop;
      scrolling = null;
    };

    const onMove = (e: TouchEvent) => {
      const dy = startY - e.touches[0].clientY;
      const dx = startX - e.touches[0].clientX;
      if (scrolling === null) scrolling = Math.abs(dy) > Math.abs(dx);
      if (!scrolling) return;
      e.stopPropagation();
      e.preventDefault();
      inner.scrollTop = startScrollTop + dy;
      updateFsThumb();
    };

    outer.addEventListener("touchstart", onStart, {
      passive: true,
      capture: true,
    });
    outer.addEventListener("touchmove", onMove, {
      passive: false,
      capture: true,
    });
    return () => {
      outer.removeEventListener("touchstart", onStart, {
        capture: true,
      } as EventListenerOptions);
      outer.removeEventListener("touchmove", onMove, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [isFullscreen, updateFsThumb]);

  // Main chart refs
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const volumeRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbUpperRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbMiddleRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbLowerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbFillUpperRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbFillLowerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const priceLineRefs = useRef<any[]>([]);
  const lastCandlesRef = useRef<CandleDataPoint[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gannMarkersPluginRef = useRef<any>(null);

  // Indicator chart refs
  const rsiContainerRef = useRef<HTMLDivElement>(null);
  const macdContainerRef = useRef<HTMLDivElement>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rsiSeriesRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const macdLineRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const macdSignalRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const macdHistRef = useRef<any>(null);
  const syncingRef = useRef(false);
  const viewInitializedForRef = useRef<string | null>(null);

  // Persists drawings across fullscreen toggle (component unmount/remount)
  const drawingsPersistRef = useRef<Drawing[]>([]);

  // Drawing tools state
  const [predictionPath, setPredictionPath] = useState<PredictionPath | null>(
    null,
  );
  const [chartPrediction, setChartPrediction] =
    useState<ChartPrediction | null>(null);
  const [showPredictionModal, setShowPredictionModal] = useState(false);

  const [zoneAnalysis, setZoneAnalysis] = useState<{
    candles: CandleDataPoint[];
    loading: boolean;
    error?: string;
    result?: ZoneAnalysisResult;
  } | null>(null);
  // True while the user is expected to be dragging out a zone on the chart —
  // drives the button's "Draw a zone…" state until the draw commits.
  const [awaitingZoneDraw, setAwaitingZoneDraw] = useState(false);
  const drawingToolsRef = useRef<ChartDrawingToolsHandle>(null);

  const handleExplainZoneStart = useCallback(() => {
    if (!isPaid) { onOpenUpgrade?.("pro"); return; }
    drawingToolsRef.current?.activateZoneTool();
    setAwaitingZoneDraw(true);
  }, [isPaid, onOpenUpgrade]);

  const handleZoneComplete = useCallback((_drawing: Drawing, candles: CandleDataPoint[]) => {
    setAwaitingZoneDraw(false);
    if (candles.length < 2) {
      setZoneAnalysis({ candles, loading: false, error: "Draw a larger area — need at least 2 candles inside the zone." });
      return;
    }
    if (exceeded) {
      setZoneAnalysis({ candles, loading: false, error: "Daily AI analysis limit reached." });
      return;
    }
    setZoneAnalysis({ candles, loading: true });

    // Give the AI extra context: a few candles right before the zone (to spot
    // what prior high/low might get swept) and an estimated liquidation-cluster
    // picture as of the zone's end, so it can reason about stop hunts / liquidity
    // grabs instead of only describing candle shapes.
    const allCandles = lastCandlesRef.current;
    const zoneStartTime = candles[0].time as number;
    const zoneEndTime = candles[candles.length - 1].time as number;
    const startIdx = allCandles.findIndex((c) => (c.time as number) === zoneStartTime);
    const endIdx = allCandles.findIndex((c) => (c.time as number) === zoneEndTime);
    const leadIn = startIdx > 0 ? allCandles.slice(Math.max(0, startIdx - 15), startIdx) : [];
    const liqHistoryEnd = endIdx >= 0 ? endIdx : allCandles.length - 1;
    const liqHistory = allCandles.slice(Math.max(0, liqHistoryEnd - 300), liqHistoryEnd + 1);
    const liqResult = liqHistory.length >= 10 ? analyseLiquidations(liqHistory, [...LEVERAGES_ALL]) : null;

    consume().then((ok) => {
      if (!ok) {
        setZoneAnalysis((prev) => prev ? { ...prev, loading: false, error: "Daily AI analysis limit reached." } : prev);
        return;
      }
      getZoneAnalysis(coin, interval, candles, {
        leadIn,
        liquidation: liqResult
          ? {
              dominantSide: liqResult.dominantSide,
              longClusters: liqResult.longClusters.map((c) => ({ priceCenter: c.priceCenter, strength: c.strength, label: c.label })),
              shortClusters: liqResult.shortClusters.map((c) => ({ priceCenter: c.priceCenter, strength: c.strength, label: c.label })),
            }
          : null,
      }).then((res) => {
        setZoneAnalysis((prev) => {
          if (!prev) return prev;
          return res.success && res.result
            ? { ...prev, loading: false, result: res.result }
            : { ...prev, loading: false, error: res.error || "Failed to analyse zone" };
        });
      });
    });
  }, [coin, interval, exceeded, consume]);

  const [divergence, setDivergence] = useState<DivergenceResult | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const divMarkersRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rsiDivMarkersRef = useRef<any>(null);

  // CME gap price line refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmeLineRefs = useRef<any[]>([]);

  // Fibonacci retracement price line refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fibLineRefs = useRef<any[]>([]);
  const showFibRef = useRef(true);

  // EMA / MA overlay refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema20Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema50Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ema200Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ma20Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ma50Ref = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ma200Ref = useRef<any>(null);

  // ── Create main chart ────────────────────────────────────────────────────
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let resizeListener: (() => void) | null = null;
    let isMounted = true;

    const initChart = () => {
      const el = containerRef.current;
      if (!el || !isMounted) return;
      const width = el.clientWidth || el.offsetWidth;
      const height = el.clientHeight || 400;

      if (width <= 0 || height <= 0) {
        requestAnimationFrame(initChart);
        return;
      }

      const chart = createChart(el, {
        width,
        height,
        layout: {
          background: {
            type: ColorType.Solid,
            color: isLight ? "#ffffff" : "#0f1117",
          },
          textColor: isLight ? "#475569" : "#94a3b8",
        },
        grid: {
          vertLines: {
            color: isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.04)",
          },
          horzLines: {
            color: isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.04)",
          },
        },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: isLight ? "#e2e8f0" : "#1e293b" },
        timeScale: {
          borderColor: isLight ? "#e2e8f0" : "#1e293b",
          timeVisible: true,
          secondsVisible: false,
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: {
          mouseWheel: true,
          pinch: true,
          axisPressedMouseMove: true,
        },
      });

      const bbOpts = {
        lineWidth: 1 as const,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      };
      const maOpts = {
        lineWidth: 1 as const,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
      };

      // Bollinger Band channel fill — two stacked Area series. The first
      // fills from the upper band down to the bottom of the pane; the
      // second "erases" everything below the lower band by repainting it
      // in the chart's own background color, leaving only the band
      // between upper and lower visibly tinted. Added before the candles
      // so the fill sits behind price action, not on top of it.
      bbFillUpperRef.current = chart.addSeries(AreaSeries, {
        lineVisible: false,
        topColor: "rgba(56,189,248,0.10)",
        bottomColor: "rgba(56,189,248,0.10)",
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      bbFillLowerRef.current = chart.addSeries(AreaSeries, {
        lineVisible: false,
        topColor: bgColor,
        bottomColor: bgColor,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      candleRef.current = chart.addSeries(CandlestickSeries, {
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
      });
      volumeRef.current = chart.addSeries(HistogramSeries, {
        priceScaleId: "volume",
        priceLineVisible: false,
        lastValueVisible: false,
        color: "rgba(100,100,100,0.4)",
      });
      chart
        .priceScale("volume")
        .applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

      bbUpperRef.current = chart.addSeries(LineSeries, {
        ...bbOpts,
        color: "rgba(251,113,133,0.7)",
      });
      bbMiddleRef.current = chart.addSeries(LineSeries, {
        ...bbOpts,
        color: "rgba(148,163,184,0.6)",
        lineStyle: 1,
      });
      bbLowerRef.current = chart.addSeries(LineSeries, {
        ...bbOpts,
        color: "rgba(34,197,94,0.7)",
      });
      ema20Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#4ade80",
        title: "EMA 20",
      });
      ema50Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#fb923c",
        title: "EMA 50",
      });
      ema200Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#c084fc",
        title: "EMA 200",
        visible: false,
      });
      ma20Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#38bdf8",
        title: "MA 20",
        visible: false,
      });
      ma50Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#f472b6",
        title: "MA 50",
        visible: false,
      });
      ma200Ref.current = chart.addSeries(LineSeries, {
        ...maOpts,
        color: "#facc15",
        title: "MA 200",
        visible: false,
      });

      chartRef.current = chart;
      if (lastCandlesRef.current.length > 0) {
        candleRef.current?.setData(lastCandlesRef.current);
      }

      const resizeChart = () => {
        const currentEl = containerRef.current;
        if (!currentEl || !chart) return;
        const nextWidth = currentEl.clientWidth || currentEl.offsetWidth;
        const nextHeight = currentEl.clientHeight || 400;
        if (nextWidth > 0 && nextHeight > 0) {
          chart.resize(nextWidth, nextHeight);
        }
      };

      ro = new ResizeObserver(resizeChart);
      ro.observe(el);

      resizeListener = () => resizeChart();
      window.addEventListener("resize", resizeListener);
    };

    initChart();

    return () => {
      isMounted = false;
      if (ro) ro.disconnect();
      if (resizeListener) window.removeEventListener("resize", resizeListener);
      chartRef.current?.remove();
      chartRef.current = candleRef.current = volumeRef.current = null;
      bbUpperRef.current = bbMiddleRef.current = bbLowerRef.current = null;
      bbFillUpperRef.current = bbFillLowerRef.current = null;
      ema20Ref.current = ema50Ref.current = ema200Ref.current = null;
      ma20Ref.current = ma50Ref.current = ma200Ref.current = null;
      viewInitializedForRef.current = null;
    };
  }, [isLight]);

  // ── Predict handler ───────────────────────────────────────────────────────

  // ── Update chart colours on theme change ────────────────────────────────
  useEffect(() => {
    const themeOpts = {
      layout: { background: { type: ColorType.Solid, color: bgColor }, textColor },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      rightPriceScale: { borderColor: gridColor },
      timeScale: { borderColor: gridColor },
    };
    chartRef.current?.applyOptions(themeOpts);
    rsiChartRef.current?.applyOptions(themeOpts);
    macdChartRef.current?.applyOptions(themeOpts);
    bbFillLowerRef.current?.applyOptions({ topColor: bgColor, bottomColor: bgColor });
  }, [theme, isFullscreen, bgColor, textColor, gridColor]);

  // ── Fetch candles ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const waitForSeriesReady = async () => {
      let attempts = 0;
      while (!cancelled && !candleRef.current && attempts < 200) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempts += 1;
      }
    };

    const fetch = async () => {
      setLoading(true);
      setError("");
      try {
        const fresh = await coinglass.getHistoricalCandles(interval, coin);
        if (cancelled) return;
        const data = fresh.length > 0 ? fresh : lastCandlesRef.current;
        if (data.length === 0) {
          setError("No chart data available");
        } else {
          if (fresh.length > 0) lastCandlesRef.current = fresh;
          await waitForSeriesReady();
          if (cancelled) return;
          candleRef.current?.setData(data);
          if (showFibRef.current) redrawFibLines();
          volumeRef.current?.setData(
            data.map((c) => ({
              time: c.time,
              value: c.volume ?? 0,
              color:
                c.close >= c.open
                  ? "rgba(34,197,94,0.45)"
                  : "rgba(239,68,68,0.45)",
            })),
          );
          const { upper, middle, lower } = calcBollingerBands(data);
          bbUpperRef.current?.setData(upper);
          bbMiddleRef.current?.setData(middle);
          bbLowerRef.current?.setData(lower);
          bbFillUpperRef.current?.setData(upper);
          bbFillLowerRef.current?.setData(lower);

          // S/R price lines
          for (const pl of priceLineRefs.current) {
            try {
              candleRef.current?.removePriceLine(pl);
            } catch {
              /* already removed */
            }
          }
          priceLineRefs.current = [];
          const { resistance, support } = calcSupportResistance(data);
          for (const { price } of resistance) {
            const pl = candleRef.current?.createPriceLine({
              price,
              color: "rgba(251,113,133,0.75)",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: "R",
            });
            if (pl) priceLineRefs.current.push(pl);
          }
          for (const { price } of support) {
            const pl = candleRef.current?.createPriceLine({
              price,
              color: "rgba(34,197,94,0.75)",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: "S",
            });
            if (pl) priceLineRefs.current.push(pl);
          }

          // Buy/sell zone — always calculate for signal direction; chart lines only for Pro+
          const lastPrice = data[data.length - 1].close;
          const zones = calcBuySellZones(data);
          setZone(zones);
          onZoneChange?.(isPaid ? zones : null, lastPrice);
          if (isPaid && zones) {
            const zoneLines: [number, string, string][] = [
              [zones.buyZone.upper, "rgba(34,197,94,0.5)", "Buy Zone ▲"],
              [zones.buyZone.lower, "rgba(34,197,94,0.5)", "Buy Zone ▼"],
              [zones.sellZone.upper, "rgba(251,113,133,0.5)", "Sell Zone ▲"],
              [zones.sellZone.lower, "rgba(251,113,133,0.5)", "Sell Zone ▼"],
            ];
            for (const [price, color, title] of zoneLines) {
              const pl = candleRef.current?.createPriceLine({
                price,
                color,
                title,
                lineWidth: 1,
                lineStyle: 3,
                axisLabelVisible: true,
              });
              if (pl) priceLineRefs.current.push(pl);
            }
          }

          // 24H high / low price lines
          for (const pl of dayLineRefs.current) {
            try {
              candleRef.current?.removePriceLine(pl);
            } catch {
              /* ok */
            }
          }
          dayLineRefs.current = [];
          const now24 = Date.now() / 1000;
          const cutoff24 = now24 - 86400;
          // For 1sec/1min only a few minutes of data exist — use all of it.
          // For 1week candles open days ago and won't pass the filter — fallback to last candle.
          const shortInterval =
            interval === "1sec" ||
            interval === "1min" ||
            interval === "5min" ||
            interval === "15min" ||
            interval === "all";
          const filtered24 = shortInterval
            ? data
            : data.filter((c) => (c.time as number) >= cutoff24);
          const hlCandles = filtered24.length > 0 ? filtered24 : data.slice(-1);
          if (hlCandles.length > 0) {
            const dHigh = Math.max(...hlCandles.map((c) => c.high));
            const dLow = Math.min(...hlCandles.map((c) => c.low));
            setDayHigh(dHigh);
            setDayLow(dLow);
            const hlHigh = candleRef.current?.createPriceLine({
              price: dHigh,
              color: "#facc15",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: "24H H",
            });
            const hlLow = candleRef.current?.createPriceLine({
              price: dLow,
              color: "#38bdf8",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: "24H L",
            });
            if (hlHigh) dayLineRefs.current.push(hlHigh);
            if (hlLow) dayLineRefs.current.push(hlLow);
          } else {
            setDayHigh(null);
            setDayLow(null);
          }

          const newBanner = analyzeInterval(data, INTERVAL_LABELS[interval]);
          setBanner(newBanner);

          // Show cached or rule-based insight immediately; fallback is trend-aware
          const cached = readPatternCache(coin, interval);
          setPatternInsight(
            cached ?? trendAwarePattern(data, newBanner?.sentiment ?? null),
          );
          // Only call AI if quota allows
          if (!exceeded) {
            consume().then((ok) => {
              if (!ok) return;
              getCandlePatternAnalysis(coin, interval, data).then((res) => {
                if (res.success && res.result) {
                  setPatternInsight(res.result);
                  writePatternCache(coin, interval, res.result);
                }
              });
            });
          }

          // EMA / MA overlays
          ema20Ref.current?.setData(calcEMALine(data, 20));
          ema50Ref.current?.setData(calcEMALine(data, 50));
          ema200Ref.current?.setData(calcEMALine(data, 200));
          ma20Ref.current?.setData(calcSMALine(data, 20));
          ma50Ref.current?.setData(calcSMALine(data, 50));
          ma200Ref.current?.setData(calcSMALine(data, 200));

          // Push data to indicator charts if they exist
          const rsiData = calcRSI(data);
          if (rsiSeriesRef.current) {
            rsiSeriesRef.current.setData(rsiData);
          }

          // RSI divergence — always calculate for signal direction; markers only for Pro+
          const div = detectRSIDivergence(data, rsiData);
          setDivergence(div);
          if (candleRef.current) {
            const priceMarkers: SeriesMarker<number>[] = (div && isPaid)
              ? div.pivots.map((p) => ({
                  time: p.time,
                  position:
                    div.type === "bullish"
                      ? ("belowBar" as const)
                      : ("aboveBar" as const),
                  shape:
                    div.type === "bullish"
                      ? ("arrowUp" as const)
                      : ("arrowDown" as const),
                  color: div.type === "bullish" ? "#22c55e" : "#ef4444",
                  size: 3,
                  text: div.type === "bullish" ? "Bull Div" : "Bear Div",
                }))
              : [];
            if (!divMarkersRef.current) {
              divMarkersRef.current = createSeriesMarkers(
                candleRef.current,
                priceMarkers,
              );
            } else {
              divMarkersRef.current.setMarkers(priceMarkers);
            }
          }
          if (rsiSeriesRef.current) {
            const rsiMarkers: SeriesMarker<number>[] = div
              ? div.pivots.map((p) => ({
                  time: p.time,
                  position:
                    div.type === "bullish"
                      ? ("belowBar" as const)
                      : ("aboveBar" as const),
                  shape:
                    div.type === "bullish"
                      ? ("arrowUp" as const)
                      : ("arrowDown" as const),
                  color: div.type === "bullish" ? "#22c55e" : "#ef4444",
                  size: 2,
                }))
              : [];
            if (!rsiDivMarkersRef.current) {
              rsiDivMarkersRef.current = createSeriesMarkers(
                rsiSeriesRef.current,
                rsiMarkers,
              );
            } else {
              rsiDivMarkersRef.current.setMarkers(rsiMarkers);
            }
          }
          if (
            macdHistRef.current &&
            macdLineRef.current &&
            macdSignalRef.current
          ) {
            const { macdLine, signalLine, histogram } = calcMACD(data);
            macdHistRef.current.setData(histogram);
            macdLineRef.current.setData(macdLine);
            macdSignalRef.current.setData(signalLine);
          }

          // Set visible range only on first load for this coin+interval — preserves zoom on refresh
          const viewKey = `${coin}-${interval}`;
          if (viewInitializedForRef.current !== viewKey) {
            viewInitializedForRef.current = viewKey;
            const INTERVAL_WINDOW: Partial<Record<TimeInterval, number>> = {
              "1min": 6 * 60 * 60,
              "5min": 2 * 24 * 60 * 60,
              "15min": 4 * 24 * 60 * 60,
              "1h": 14 * 24 * 60 * 60,
              "4h": 28 * 24 * 60 * 60,
              "6h": 56 * 24 * 60 * 60,
            };
            const window = INTERVAL_WINDOW[interval];
            if (window && data.length > 0) {
              const to = data[data.length - 1].time as number;
              chartRef.current?.timeScale().setVisibleRange({
                from: (to - window) as UTCTimestamp,
                to: to as UTCTimestamp,
              });
            } else {
              chartRef.current?.timeScale().fitContent();
            }
          }
        }
      } catch {
        if (!cancelled) setError("Failed to fetch chart data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetch();
    return () => {
      cancelled = true;
    };
  }, [interval, refreshTrigger, coin]);

  // ── Clear prediction + divergence on interval/coin change ────────────────
  useEffect(() => {
    setPredictionPath(null);
    setChartPrediction(null);
    setDivergence(null);
    divMarkersRef.current?.setMarkers([]);
    rsiDivMarkersRef.current?.setMarkers([]);
    divMarkersRef.current = null;
    rsiDivMarkersRef.current = null;
  }, [interval, coin]);

  // ── Live polling (1sec + 1min) ───────────────────────────────────────────
  useEffect(() => {
    if (interval !== "1sec" && interval !== "1min") {
      setIsLive(false);
      return;
    }
    setIsLive(true);
    const isSecond = interval === "1sec";
    const timer = window.setInterval(
      async () => {
        const candle = isSecond
          ? await coinglass.getLiveSecondCandle(coin)
          : await coinglass.getLiveMinuteCandle(coin);
        if (candle) {
          candleRef.current?.update(candle);
          if (candle.volume !== undefined) {
            volumeRef.current?.update({
              time: candle.time,
              value: candle.volume,
              color:
                candle.close >= candle.open
                  ? "rgba(34,197,94,0.45)"
                  : "rgba(239,68,68,0.45)",
            });
          }
        }
      },
      isSecond ? 1_000 : 10_000,
    );
    return () => {
      window.clearInterval(timer);
      setIsLive(false);
    };
  }, [interval, coin]);

  // ── Clear stale state on coin/refresh change ─────────────────────────────
  useEffect(() => {
    setBanner(null);
    setZone(null);
    setPatternInsight(null);
    setTrends({});
    coinglass
      .getIntervalTrends(coin)
      .then(setTrends)
      .catch(() => {});
  }, [refreshTrigger, coin]);

  useEffect(() => {
    lastCandlesRef.current = [];
  }, [coin]);

  // ── Close indicator menu on outside click ───────────────────────────────
  useEffect(() => {
    if (!menuOpen) return;
    const handle = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [menuOpen]);

  // ── Overlay visibility ───────────────────────────────────────────────────
  useEffect(() => {
    bbUpperRef.current?.applyOptions({ visible: showBB });
    bbMiddleRef.current?.applyOptions({ visible: showBB });
    bbLowerRef.current?.applyOptions({ visible: showBB });
    bbFillUpperRef.current?.applyOptions({ visible: showBB });
    bbFillLowerRef.current?.applyOptions({ visible: showBB });
  }, [showBB]);
  useEffect(() => {
    ema20Ref.current?.applyOptions({ visible: showEMA20 });
  }, [showEMA20]);
  useEffect(() => {
    ema50Ref.current?.applyOptions({ visible: showEMA50 });
  }, [showEMA50]);
  useEffect(() => {
    ema200Ref.current?.applyOptions({ visible: showEMA200 });
  }, [showEMA200]);
  useEffect(() => {
    ma20Ref.current?.applyOptions({ visible: showMA20 });
  }, [showMA20]);
  useEffect(() => {
    ma50Ref.current?.applyOptions({ visible: showMA50 });
  }, [showMA50]);
  useEffect(() => {
    ma200Ref.current?.applyOptions({ visible: showMA200 });
  }, [showMA200]);

  // ── Fibonacci retracement lines ──────────────────────────────────────────
  const redrawFibLines = useCallback(() => {
    for (const pl of fibLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    fibLineRefs.current = [];
    if (!showFibRef.current || !candleRef.current) return;
    const candles = lastCandlesRef.current;
    if (candles.length === 0) return;
    const high = Math.max(...candles.map((c) => c.high));
    const low = Math.min(...candles.map((c) => c.low));
    const range = high - low;
    for (const { ratio, label, color } of FIB_LEVELS) {
      const price = high - ratio * range;
      const pl = candleRef.current.createPriceLine({
        price,
        color,
        lineWidth: 3,
        lineStyle: 0,
        axisLabelVisible: true,
        title: `Fib ${label}`,
      });
      if (pl) fibLineRefs.current.push(pl);
    }
  }, []);

  useEffect(() => {
    showFibRef.current = showFib;
    redrawFibLines();
  }, [showFib, redrawFibLines]);

  // ── Gann Pivot markers ───────────────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current) return;
    if (!showGann) {
      gannMarkersPluginRef.current?.setMarkers([]);
      setGannCycles([]);
      return;
    }
    const candles = lastCandlesRef.current;
    if (candles.length === 0) return;
    const n =
      interval === "1week" || interval === "all"
        ? 3
        : interval === "1day" || interval === "4h" || interval === "6h"
          ? 5
          : 8;
    const pivots = detectGannPivots(candles, n);
    if (pivots.length === 0) return;
    const lastPivot = pivots[pivots.length - 1];
    setGannCycles(computeGannCycles(lastPivot, interval));
    const markers: SeriesMarker<number>[] = pivots.map((p) => ({
      time: p.time as number,
      position: p.type === "high" ? "aboveBar" : "belowBar",
      shape: p.type === "high" ? "arrowDown" : "arrowUp",
      color: p.type === "high" ? "#ef4444" : "#22c55e",
      size: 1,
    }));
    if (!gannMarkersPluginRef.current) {
      gannMarkersPluginRef.current = createSeriesMarkers(
        candleRef.current,
        markers,
      );
    } else {
      gannMarkersPluginRef.current.setMarkers(markers);
    }
  }, [showGann, interval]);

  // Re-sync sub-chart time scales after they become visible (display:none → block
  // causes lightweight-charts to emit a stale range change that overwrites main chart)
  useEffect(() => {
    if (!showRSI && !showMACD) return;
    requestAnimationFrame(() => {
      const range = chartRef.current?.timeScale().getVisibleLogicalRange();
      if (range) {
        if (showRSI)
          rsiChartRef.current?.timeScale().setVisibleLogicalRange(range);
        if (showMACD)
          macdChartRef.current?.timeScale().setVisibleLogicalRange(range);
      } else {
        chartRef.current?.timeScale().fitContent();
      }
    });
  }, [showRSI, showMACD]);

  // ── CME gap lines ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    for (const pl of cmeLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* noop */
      }
    }
    cmeLineRefs.current = [];

    if (!showCME) return;

    coinglass
      .getHistoricalCandles("1day", coin)
      .then((candles) => {
        if (cancelled || !candleRef.current || candles.length === 0) return;
        const gaps = calcCMEGaps(candles);
        for (const gap of gaps) {
          const color = "rgba(251, 191, 36, 0.85)";
          const topLine = candleRef.current.createPriceLine({
            price: gap.top,
            color,
            lineWidth: 1 as const,
            lineStyle: 2,
            axisLabelVisible: true,
            title: gap.direction === "up" ? "CME ↑▲" : "CME ↓▲",
          });
          const botLine = candleRef.current.createPriceLine({
            price: gap.bottom,
            color,
            lineWidth: 1 as const,
            lineStyle: 2,
            axisLabelVisible: true,
            title: gap.direction === "up" ? "CME ↑▼" : "CME ↓▼",
          });
          if (topLine) cmeLineRefs.current.push(topLine);
          if (botLine) cmeLineRefs.current.push(botLine);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [coin, refreshTrigger, showCME]);

  // ── Create indicator charts once on mount ───────────────────────────────
  useEffect(() => {
    const rsiEl = rsiContainerRef.current;
    const macdEl = macdContainerRef.current;
    if (!rsiEl || !macdEl) return;
    const baseOpts = {
      layout: { background: { type: ColorType.Solid, color: bgColor }, textColor },
      grid: {
        vertLines: { color: gridColor },
        horzLines: { color: gridColor },
      },
      rightPriceScale: {
        borderColor: gridColor,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    };

    const rsiChart = createChart(rsiEl, {
      ...baseOpts,
      autoSize: true,
      timeScale: { visible: false },
    });

    const macdChart = createChart(macdEl, {
      ...baseOpts,
      autoSize: true,
      timeScale: {
        borderColor: gridColor,
        timeVisible: true,
        secondsVisible: false,
      },
    });

    // RSI series
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rsiSeries: any = rsiChart.addSeries(LineSeries, {
      color: "#38bdf8",
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    rsiSeries.createPriceLine({
      price: 70,
      color: "rgba(251,113,133,0.65)",
      lineWidth: 1 as const,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "OB",
    });
    rsiSeries.createPriceLine({
      price: 50,
      color: "rgba(148,163,184,0.25)",
      lineWidth: 1 as const,
      lineStyle: 1,
      axisLabelVisible: false,
      title: "",
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: "rgba(34,197,94,0.65)",
      lineWidth: 1 as const,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "OS",
    });

    // MACD series
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const macdHist: any = macdChart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
      base: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const macdLn: any = macdChart.addSeries(LineSeries, {
      color: "#38bdf8",
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const macdSig: any = macdChart.addSeries(LineSeries, {
      color: "#f97316",
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    macdHist.createPriceLine({
      price: 0,
      color: "rgba(148,163,184,0.3)",
      lineWidth: 1 as const,
      lineStyle: 0,
      axisLabelVisible: false,
      title: "",
    });

    rsiSeriesRef.current = rsiSeries;
    macdHistRef.current = macdHist;
    macdLineRef.current = macdLn;
    macdSignalRef.current = macdSig;
    rsiChartRef.current = rsiChart;
    macdChartRef.current = macdChart;

    // Time scale sync (bidirectional, all three charts)
    const mainChart = chartRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncMain = (r: any) => {
      if (syncingRef.current || !r) return;
      syncingRef.current = true;
      try {
        rsiChart.timeScale().setVisibleLogicalRange(r);
        macdChart.timeScale().setVisibleLogicalRange(r);
      } finally {
        syncingRef.current = false;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncRsi = (r: any) => {
      if (syncingRef.current || !r) return;
      syncingRef.current = true;
      try {
        mainChart?.timeScale().setVisibleLogicalRange(r);
        macdChart.timeScale().setVisibleLogicalRange(r);
      } finally {
        syncingRef.current = false;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncMacd = (r: any) => {
      if (syncingRef.current || !r) return;
      syncingRef.current = true;
      try {
        mainChart?.timeScale().setVisibleLogicalRange(r);
        rsiChart.timeScale().setVisibleLogicalRange(r);
      } finally {
        syncingRef.current = false;
      }
    };
    mainChart?.timeScale().subscribeVisibleLogicalRangeChange(syncMain);
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(syncRsi);
    macdChart.timeScale().subscribeVisibleLogicalRangeChange(syncMacd);

    // Populate immediately from cached candles
    const candles = lastCandlesRef.current;
    if (candles.length > 0) {
      rsiSeries.setData(calcRSI(candles));
      const { macdLine, signalLine, histogram } = calcMACD(candles);
      macdHist.setData(histogram);
      macdLn.setData(macdLine);
      macdSig.setData(signalLine);
    }

    return () => {
      mainChart?.timeScale().unsubscribeVisibleLogicalRangeChange(syncMain);
      rsiChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncRsi);
      macdChart.timeScale().unsubscribeVisibleLogicalRangeChange(syncMacd);
      rsiChart.remove();
      macdChart.remove();
      rsiChartRef.current = macdChartRef.current = null;
      rsiSeriesRef.current =
        macdHistRef.current =
        macdLineRef.current =
        macdSignalRef.current =
          null;
    };
  }, []);

  // iOS Safari pans the viewport on any touch-drag inside the chart.
  // Fix: block ALL touchmove here, then manually forward vertical deltas to
  // the real scroll container (.main-content) so scrolling still works.
  useEffect(() => {
    const el = chartSectionRef.current;
    if (!el) return;
    let lastY = 0;
    let direction: "h" | "v" | null = null;
    let startX = 0;
    let startY = 0;

    const onStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      lastY = startY;
      direction = null;
    };

    const onMove = (e: TouchEvent) => {
      // Two-finger pinch — let TradingView handle zoom natively
      if (e.touches.length >= 2) return;
      e.preventDefault();
      const curX = e.touches[0].clientX;
      const curY = e.touches[0].clientY;

      if (!direction) {
        const dx = Math.abs(curX - startX);
        const dy = Math.abs(curY - startY);
        if (dx > 5 || dy > 5) direction = dx > dy ? "h" : "v";
      }

      if (direction === "v") {
        const delta = lastY - curY;
        lastY = curY;
        const scroller = el.closest(".main-content") as HTMLElement | null;
        if (scroller) scroller.scrollTop += delta;
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
    };
  }, []);

  // ── Screenshot ───────────────────────────────────────────────────────────
  const handleScreenshot = () => {
    const mainCanvas = chartRef.current?.takeScreenshot();
    if (!mainCanvas) return;

    const rsiCanvas =
      showRSI && rsiChartRef.current
        ? rsiChartRef.current.takeScreenshot()
        : null;
    const macdCanvas =
      showMACD && macdChartRef.current
        ? macdChartRef.current.takeScreenshot()
        : null;

    const HEADER_H = 44;
    const W = mainCanvas.width;
    const H =
      HEADER_H +
      mainCanvas.height +
      (rsiCanvas?.height ?? 0) +
      (macdCanvas?.height ?? 0);

    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const ctx = out.getContext("2d")!;

    // Background
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, W, H);

    // Header bar
    ctx.fillStyle = "#0a1628";
    ctx.fillRect(0, 0, W, HEADER_H);
    ctx.fillStyle = "rgba(56,189,248,0.18)";
    ctx.fillRect(0, HEADER_H - 1, W, 1);

    // Left label: coin + interval
    ctx.font = "bold 14px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = "#e2e8f0";
    ctx.textBaseline = "middle";
    const shortInterval = INTERVAL_LABELS[interval]?.split(" ")[0] ?? interval;
    ctx.fillText(`${coin}/USDT · ${shortInterval}`, 16, HEADER_H / 2);

    // Zone signal
    if (zone) {
      const sigLabel: Record<string, string> = {
        "strong-buy": t("chart.strongBuy"),
        buy: t("chart.buy"),
        oversold: t("chart.oversold"),
        neutral: t("chart.neutralZone"),
        overbought: t("chart.overbought"),
        sell: t("chart.sell"),
        "strong-sell": t("chart.strongSell"),
      };
      const sigColor: Record<string, string> = {
        "strong-buy": "#22c55e",
        buy: "#86efac",
        oversold: "#f59e0b",
        neutral: "#94a3b8",
        overbought: "#f59e0b",
        sell: "#fca5a5",
        "strong-sell": "#ef4444",
      };
      const sigText = sigLabel[zone.signal] ?? zone.signal;
      ctx.font = "bold 11px 'Inter', system-ui, sans-serif";
      ctx.fillStyle = sigColor[zone.signal] ?? "#94a3b8";
      ctx.fillText(
        `● ${sigText}`,
        W / 2 - ctx.measureText(`● ${sigText}`).width / 2,
        HEADER_H / 2,
      );
    }

    // Right label: timestamp
    ctx.font = "12px 'Inter', system-ui, sans-serif";
    ctx.fillStyle = "#64748b";
    const ts = new Date().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    ctx.fillText(ts, W - ctx.measureText(ts).width - 16, HEADER_H / 2);

    // Draw chart canvases
    let y = HEADER_H;
    ctx.drawImage(mainCanvas, 0, y);

    // Composite drawing overlay on top of main chart (same position/size)
    const drawingCanvas = document.querySelector(
      ".cdt-canvas",
    ) as HTMLCanvasElement | null;
    if (drawingCanvas && drawingCanvas.width > 0 && drawingCanvas.height > 0) {
      ctx.drawImage(drawingCanvas, 0, y, mainCanvas.width, mainCanvas.height);
    }

    y += mainCanvas.height;
    if (rsiCanvas) {
      ctx.drawImage(rsiCanvas, 0, y);
      y += rsiCanvas.height;
    }
    if (macdCanvas) {
      ctx.drawImage(macdCanvas, 0, y);
    }

    // Trigger download
    const link = document.createElement("a");
    link.href = out.toDataURL("image/png");
    link.download = `${coin}-${shortInterval}-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={chartSectionRef}
      className={`price-chart-container${isFullscreen ? " price-chart-container--fs" : ""}`}
    >
      <div
        ref={isFullscreen ? fsScrollRef : undefined}
        className={isFullscreen ? "price-chart-fs-scroll" : undefined}
        onScroll={isFullscreen ? updateFsThumb : undefined}
      >
        <div className="chart-fs-header-group">
          <div className="chart-header">
            <div className="chart-header-left">
              <div className="chart-title-row">
                <h3>{t("chart.title", { coin })}</h3>
                {(interval === "1sec" || interval === "1min") && isLive && (
                  <span className="live-badge">{t("chart.live")}</span>
                )}
                {zone && isPaid && (
                  <span className={`zone-signal zone-signal--${zone.signal}`}>
                    <span className="zone-signal-live" />
                    {zone.signal === "strong-buy" && t("chart.strongBuy")}
                    {zone.signal === "buy" && t("chart.buy")}
                    {zone.signal === "oversold" && t("chart.oversold")}
                    {zone.signal === "overbought" && t("chart.overbought")}
                    {zone.signal === "neutral" && t("chart.neutralZone")}
                    {zone.signal === "sell" && t("chart.sell")}
                    {zone.signal === "strong-sell" && t("chart.strongSell")}
                  </span>
                )}
                {!isPaid && (
                  <button
                    className={`zone-signal-gate zone-signal-gate--${zone?.signal ?? "neutral"}`}
                    onClick={() => onOpenUpgrade?.("pro")}
                  >
                    <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-${zone?.signal ?? "neutral"}`} />
                    Unlock Status
                  </button>
                )}
                {isFullscreen && (
                  <div className="chart-title-actions">
                    <button
                      className="chart-screenshot-btn"
                      onClick={handleScreenshot}
                      title="Save chart as PNG"
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                        <circle cx="12" cy="13" r="4" />
                      </svg>
                      <span className="chart-icon-label">
                        {t("chart.save")}
                      </span>
                    </button>
                    <button
                      className="chart-fullscreen-btn"
                      onClick={toggleFullscreen}
                      title="Exit fullscreen"
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3" />
                      </svg>
                      <span className="chart-icon-label">
                        {t("chart.exit")}
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                {dayHigh !== null && dayLow !== null && (
                  <span className="day-hl-badge">
                    <span className="day-hl-label">
                      {interval === "1sec"
                        ? "30M"
                        : interval === "1min"
                          ? "1H"
                          : interval === "5min"
                            ? "24H"
                            : interval === "15min"
                              ? "48H"
                              : interval === "1h"
                                ? "24H"
                                : interval === "1week"
                                  ? "7D"
                                  : interval === "all"
                                    ? "ATH"
                                    : "24H"}
                    </span>
                    <span className="day-hl-high">
                      H: $
                      {dayHigh.toLocaleString("en-US", {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}
                    </span>
                    <span className="day-hl-sep"> · </span>
                    <span className="day-hl-low">
                      L: $
                      {dayLow.toLocaleString("en-US", {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}
                    </span>
                  </span>
                )}
                {divergence && isPaid && (
                  <span className={`div-badge div-badge--${divergence.type}`}>
                    {divergence.type === "bullish" ? "↑ Bull Div" : "↓ Bear Div"}
                  </span>
                )}
                {!isPaid && (
                  <button
                    className={`zone-signal-gate zone-signal-gate--div-${divergence?.type ?? "neutral"}`}
                    onClick={() => onOpenUpgrade?.("pro")}
                  >
                    <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-div-${divergence?.type ?? "neutral"}`} />
                    Unlock Divergence
                  </button>
                )}
              </div>
            </div>
            <div className="chart-header-right">
              <div className="chart-header-controls">
                <div className="indicators-menu-wrapper" ref={menuRef}>
                  <button
                    className={`indicators-toggle${menuOpen ? " indicators-toggle--active" : ""}`}
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    ◈ {t("chart.indicators")} {menuOpen ? "▴" : "▾"}
                  </button>
                  {menuOpen && (
                    <div className="indicators-menu">
                      <div className="indicators-menu-group-label">
                        {t("chart.overlays")}
                      </div>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showBB}
                          onChange={(e) => setShowBB(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "rgba(251,113,133,0.85)" }}
                        />
                        <span>{t("chart.bollingerBands")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showEMA20}
                          onChange={(e) => setShowEMA20(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#4ade80" }}
                        />
                        <span>{t("chart.ema20")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showEMA50}
                          onChange={(e) => setShowEMA50(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#fb923c" }}
                        />
                        <span>{t("chart.ema50")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showEMA200}
                          onChange={(e) => setShowEMA200(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#c084fc" }}
                        />
                        <span>{t("chart.ema200")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showMA20}
                          onChange={(e) => setShowMA20(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#38bdf8" }}
                        />
                        <span>{t("chart.ma20")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showMA50}
                          onChange={(e) => setShowMA50(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#f472b6" }}
                        />
                        <span>{t("chart.ma50")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showMA200}
                          onChange={(e) => setShowMA200(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#facc15" }}
                        />
                        <span>{t("chart.ma200")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showCME}
                          onChange={(e) => setShowCME(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "rgba(251,191,36,0.85)" }}
                        />
                        <span>{t("chart.cmeGaps")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showGann}
                          onChange={(e) => {
                            if (!isPaid) { onOpenUpgrade?.("pro"); return; }
                            setShowGann(e.target.checked);
                          }}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#f97316" }}
                        />
                        <span>Gann Pivots</span>
                        <span className="tier-badge tier-badge--pro">P</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showFib}
                          onChange={(e) => {
                            if (!isPaid) { onOpenUpgrade?.("pro"); return; }
                            setShowFib(e.target.checked);
                          }}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "rgba(251,191,36,0.85)" }}
                        />
                        <span>Fibonacci Levels</span>
                        <span className="tier-badge tier-badge--pro">P</span>
                      </label>
                      <div className="indicators-menu-divider" />
                      <div className="indicators-menu-group-label">
                        {t("chart.subcharts")}
                      </div>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showRSI}
                          onChange={(e) => setShowRSI(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#38bdf8" }}
                        />
                        <span>{t("chart.rsi14")}</span>
                      </label>
                      <label className="indicators-menu-item">
                        <input
                          type="checkbox"
                          checked={showMACD}
                          onChange={(e) => setShowMACD(e.target.checked)}
                        />
                        <span
                          className="indicators-menu-dot"
                          style={{ background: "#f97316" }}
                        />
                        <span>{t("chart.macd1269")}</span>
                      </label>
                    </div>
                  )}
                </div>
                {/* Desktop: fancy pill buttons */}
                <div className="interval-pills">
                  {INTERVALS.map((opt) => {
                    const needsPro = PRO_INTERVALS.has(opt);
                    const locked   = needsPro && !isPaid;
                    const trend    = trends[opt];
                    return (
                      <button
                        key={opt}
                        className={`interval-pill${interval === opt ? " interval-pill--active" : ""}${locked ? " interval-pill--locked" : ""}`}
                        title={INTERVAL_LABELS[opt]}
                        onClick={() => {
                          if (locked) { onOpenUpgrade?.("pro"); return; }
                          setInterval(opt);
                        }}
                      >
                        {INTERVAL_SHORT[opt]}
                        {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                          : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                          : null}
                      </button>
                    );
                  })}
                </div>

                {/* Mobile: native dropdown */}
                <select
                  className="interval-select interval-select--mobile"
                  value={interval}
                  onChange={(e) => {
                    const val = e.target.value as TimeInterval;
                    if (PRO_INTERVALS.has(val) && !isPaid) { onOpenUpgrade?.("pro"); return; }
                    setInterval(val);
                  }}
                >
                  {INTERVALS.map((opt) => {
                    const needsPro = PRO_INTERVALS.has(opt);
                    const trend    = trends[opt];
                    const arrow    = trend === "bullish" ? " ↑" : trend === "bearish" ? " ↓" : "";
                    const pro      = needsPro ? " · PRO" : "";
                    return (
                      <option key={opt} value={opt}>
                        {INTERVAL_LABELS[opt]}{arrow}{pro}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
          </div>

          <div className="chart-legend">
            {showBB && (
              <>
                <span className="legend-item legend-bb-upper">
                  {t("chart.bbUpperLegend")}
                </span>
                <span className="legend-item legend-bb-middle">
                  {t("chart.bbMiddleLegend")}
                </span>
                <span className="legend-item legend-bb-lower">
                  {t("chart.bbLowerLegend")}
                </span>
              </>
            )}
            <div className="chart-legend-actions">
              <button
                className={`chart-depth-btn${showDepthProfile ? " chart-depth-btn--active" : ""}`}
                onClick={() => {
                  if (showDepthProfile) {
                    setShowDepthProfile(false);
                    if (document.fullscreenElement) {
                      document.exitFullscreen().catch(() => {});
                    } else if (cssFsRef.current) {
                      cssFsRef.current = false;
                      setIsFullscreen(false);
                    }
                  } else {
                    toggleFullscreen();
                    setShowDepthProfile(true);
                  }
                }}
                title={
                  showDepthProfile ? "Hide depth profile" : "Show depth profile"
                }
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="6" x2="6" y2="6" />
                  <line x1="21" y1="10" x2="6" y2="10" />
                  <line x1="15" y1="14" x2="6" y2="14" />
                  <line x1="12" y1="18" x2="6" y2="18" />
                </svg>
                <span className="chart-icon-label">
                  {t("chart.orderDepth")}
                </span>
              </button>
              <button
                className={`chart-depth-btn${showAstroChart ? " chart-depth-btn--active" : ""}`}
                onClick={() => setShowAstroChart(true)}
                title={t("astro.title", "Astro Suggestions")}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 2l1.8 5.6L19 9l-5.2 1.4L12 16l-1.8-5.6L5 9l5.2-1.4z" />
                  <path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z" />
                </svg>
                <span className="chart-icon-label">
                  {t("astro.title", "Astro Suggestions")}
                </span>
              </button>
              <button
                className="chart-screenshot-btn"
                onClick={handleScreenshot}
                title="Save chart as PNG"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span className="chart-icon-label">{t("chart.save")}</span>
              </button>
              <button
                className="chart-fullscreen-btn"
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3" />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3" />
                  </svg>
                )}
                <span className="chart-icon-label">
                  {isFullscreen ? t("chart.exit") : t("chart.expand")}
                </span>
              </button>
            </div>
          </div>
        </div>

        {banner && isPaid && (
          <div
            key={banner.title}
            className={`interval-banner interval-banner--${banner.sentiment}`}
          >
            <div className="interval-banner-header">
              <span className="interval-banner-title pi-fade-in">{banner.title}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="aiqw-live-badge">
                  <span className="aiqw-live-dot" />
                  LIVE
                </span>
                <span className="pattern-insight-ai-badge">
                  {t("chart.aiPowered")}
                </span>
                <button
                  className="interval-banner-close"
                  onClick={() => setBanner(null)}
                >
                  ✕
                </button>
              </div>
            </div>
            <p className="interval-banner-body pi-fade-in pi-fade-in--d1">{banner.body}</p>
          </div>
        )}

        {!isPaid && (
          <div className="chart-ai-placeholder">
            <div className="chart-ai-placeholder-preview" aria-hidden="true">
              <div className="chart-ai-placeholder-header">
                <div className="cap-badge" />
                <div className="cap-title" />
                <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                  <div className="cap-pill" />
                  <div className="cap-pill" />
                </div>
              </div>
              <div className="cap-line cap-line--full" />
              <div className="cap-line cap-line--three-quarter" />
            </div>
            <div className="chart-ai-placeholder-overlay">
              <div className="cap-overlay-left">
                <div className="cap-overlay-header">
                  <span className="cap-overlay-title">AI Chart Features</span>
                  <span className="cap-overlay-ai-badge">AI</span>
                  <span className="cap-overlay-tier-badge">PRO</span>
                  <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
                </div>
                <div className="cap-overlay-features">
                  {["Interval sentiment & trend context", "Candlestick pattern detection", "Next-move predictions"].map(f => (
                    <span key={f} className="cap-overlay-feature">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
              <button
                className="cap-overlay-btn"
                onClick={() => onOpenUpgrade?.("pro")}
              >
                <span className="cap-btn-full">Upgrade Now</span>
                <span className="cap-btn-short">Upgrade</span>
              </button>
            </div>
          </div>
        )}

        {error && lastCandlesRef.current.length === 0 && (
          <div className="chart-error">⚠️ {error}</div>
        )}

        <div
          style={{ position: "relative" }}
          onDoubleClick={toggleFullscreen}
          className="chart-dblclick-wrap"
        >
          {loading && (
            <div className="chart-loading-overlay">
              <span>{t("chart.loading")}</span>
            </div>
          )}
          <div
            ref={containerRef}
            className="chart-canvas-wrap chart-main-wrap"
            style={{
              width: "100%",
              height: isFullscreen ? "calc(100vh - 290px)" : "400px",
            }}
          />
          <PredictionOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            prediction={predictionPath}
          />
          <ChartDrawingTools
            ref={drawingToolsRef}
            chartRef={chartRef}
            seriesRef={candleRef}
            containerRef={containerRef}
            candlesRef={lastCandlesRef}
            visible={isFullscreen}
            persistRef={drawingsPersistRef}
            onZoneComplete={handleZoneComplete}
          />
          <button
            className="chart-reset-view-btn"
            onClick={() => {
              chartRef.current?.timeScale().fitContent();
              rsiChartRef.current?.timeScale().fitContent();
              macdChartRef.current?.timeScale().fitContent();
            }}
          >
            {t("chart.reset")}
          </button>
          {isFullscreen && (
            <button
              className={`chart-explain-zone-btn${awaitingZoneDraw ? " chart-explain-zone-btn--active" : ""}`}
              onClick={handleExplainZoneStart}
              title="Draw a free area on the chart and get an AI explanation of it"
            >
              <span className="chart-explain-zone-btn__icon">
                {awaitingZoneDraw ? "✏️" : "✨"}
                {!isPaid && <span className="chart-explain-zone-btn__pro">PRO</span>}
              </span>
              <span className="chart-explain-zone-btn__label">
                {awaitingZoneDraw ? "Draw a zone…" : "Explain Zone"}
              </span>
            </button>
          )}
        </div>

        {showDepthProfile && (
          <OrderBookProfileModal
            coin={coin}
            onClose={() => {
              setShowDepthProfile(false);
              if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
              } else if (cssFsRef.current) {
                cssFsRef.current = false;
                setIsFullscreen(false);
              }
            }}
          />
        )}

        {showAstroChart && (
          <AstroSuggestions
            coin={coin}
            theme={theme}
            onClose={() => setShowAstroChart(false)}
          />
        )}

        {showGann && gannCycles.length > 0 && (
          <div className="gann-cycles-strip">
            <span className="gann-cycles-label">
              {t("chart.gannCyclesLabel")}
            </span>
            {gannCycles.map((gc) => (
              <span
                key={gc.label}
                className={`gann-cycle-pill${gc.isPast ? " gann-cycle-pill--past" : ""}`}
              >
                {gc.label} ·{" "}
                {new Date(gc.timestamp * 1000).toLocaleDateString(
                  i18n.language,
                  { month: "short", day: "numeric" },
                )}
              </span>
            ))}
          </div>
        )}

        <div className="sub-charts">
          <div
            className={`sub-chart-panel${showRSI ? "" : " sub-chart-panel--hidden"}`}
          >
            <div className="sub-chart-header">
              <span className="sub-chart-title">{t("chart.rsi14")}</span>
              <div className="sub-chart-legend">
                <span className="sub-chart-legend-item legend-rsi">
                  ── {t("chart.rsiLegend")}
                </span>
                <span className="sub-chart-legend-item legend-ob">
                  ▬ {t("chart.rsiOB")}
                </span>
                <span className="sub-chart-legend-item legend-os">
                  ▬ {t("chart.rsiOS")}
                </span>
              </div>
            </div>
            <div
              ref={rsiContainerRef}
              className="chart-canvas-wrap"
              style={{ width: "100%", height: "130px" }}
            />
          </div>

          <div
            className={`sub-chart-panel${showMACD ? "" : " sub-chart-panel--hidden"}`}
          >
            <div className="sub-chart-header">
              <span className="sub-chart-title">{t("chart.macd1269")}</span>
              <div className="sub-chart-legend">
                <span className="sub-chart-legend-item legend-macd">
                  ── {t("chart.macdLegend")}
                </span>
                <span className="sub-chart-legend-item legend-signal">
                  ── {t("chart.signalLegend")}
                </span>
              </div>
            </div>
            <div
              ref={macdContainerRef}
              className="chart-canvas-wrap"
              style={{ width: "100%", height: "130px" }}
            />
          </div>
        </div>

        {!isPaid ? (
          <div className="chart-ai-placeholder">
            <div className="chart-ai-placeholder-preview" aria-hidden="true">
              <div className="chart-ai-placeholder-header">
                <div className="cap-badge" />
                <div className="cap-title" />
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <div className="cap-pill" />
                  <div className="cap-pill" />
                </div>
              </div>
              <div className="cap-line cap-line--full" />
              <div className="cap-line cap-line--three-quarter" />
              <div className="cap-line" style={{ width: "88%" }} />
            </div>
            <div className="chart-ai-placeholder-overlay">
              <div className="cap-overlay-left">
                <div className="cap-overlay-header">
                  <span className="cap-overlay-title">AI Pattern Analysis</span>
                  <span className="cap-overlay-ai-badge">AI</span>
                  <span className="cap-overlay-tier-badge">PRO</span>
                  <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
                </div>
                <div className="cap-overlay-features">
                  {["Candlestick pattern recognition", "Bullish / bearish confidence score", "Next-move narrative & outlook"].map(f => (
                    <span key={f} className="cap-overlay-feature">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
              <button
                className="cap-overlay-btn"
                onClick={() => onOpenUpgrade?.("pro")}
              >
                <span className="cap-btn-full">Upgrade Now</span>
                <span className="cap-btn-short">Upgrade</span>
              </button>
            </div>
          </div>
        ) : !loading && patternInsight ? (
          <div
            className={`pattern-insight pattern-insight--${patternInsight.type}`}
          >
            <div className="pattern-insight-header">
              <span
                className={`pattern-insight-badge pattern-insight-badge--${patternInsight.type}`}
              >
                {patternInsight.type === "bullish"
                  ? "🟢"
                  : patternInsight.type === "bearish"
                    ? "🔴"
                    : "⚪"}{" "}
                {patternInsight.name}
              </span>
              <div className="pattern-insight-header-right">
                <span className="aiqw-live-badge">
                  <span className="aiqw-live-dot" />
                  LIVE
                </span>
                <span className="pattern-insight-ai-badge">
                  {t("chart.aiPowered")}
                </span>
              </div>
            </div>
            <p
              key={`summary-${patternInsight.name}`}
              className="pattern-insight-summary pi-fade-in"
            >
              {patternInsight.summary}
            </p>
            <p
              key={`narrative-${patternInsight.name}`}
              className="pattern-insight-narrative pi-fade-in pi-fade-in--d1"
            >
              {patternInsight.narrative}
            </p>
            <div className="pattern-insight-next">
              <span className="pattern-insight-next-label">
                {t("chart.nextMove")}
              </span>
              <p
                key={`nextmove-${patternInsight.name}`}
                className="pattern-insight-next-text pi-fade-in pi-fade-in--d2"
              >
                {patternInsight.nextMove}
              </p>
            </div>
          </div>
        ) : null}

        {showPredictionModal && predictionPath && chartPrediction && (
          <PredictionModal
            candles={lastCandlesRef.current}
            prediction={predictionPath}
            chartPrediction={chartPrediction}
            coin={coin}
            interval={interval}
            theme={theme}
            divergence={
              divergence
                ? {
                    type: divergence.type,
                    pivots: divergence.pivots.map((p) => ({
                      time: p.time,
                      price: p.price,
                    })),
                  }
                : null
            }
            onClose={() => setShowPredictionModal(false)}
          />
        )}

        {zoneAnalysis && (
          <ZoneAnalysisModal
            coin={coin}
            interval={interval}
            candles={zoneAnalysis.candles}
            loading={zoneAnalysis.loading}
            error={zoneAnalysis.error}
            result={zoneAnalysis.result}
            theme={theme}
            onClose={() => setZoneAnalysis(null)}
          />
        )}
      </div>
    </div>
  );
};
