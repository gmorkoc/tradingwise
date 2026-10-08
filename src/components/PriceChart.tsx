import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
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
import { coinglass, CandleDataPoint, CoinSymbol, COINS, getTickerSnapshot } from "../services/coinglass";
import { ZoneResult, ZoneSignal } from "./PriceChart.types";
import {
  getCandlePatternAnalysis,
  CandlePatternResult,
  ChartPrediction,
  getZoneAnalysis,
  ZoneAnalysisResult,
} from "../services/openai";
import { PredictionOverlay, PredictionPath, LineDotFillOverlay } from "./DrawingOverlay";
import { ChartEventAnnotations } from "./ChartEventAnnotations";
import { OrderBookProfileModal } from "./OrderBookProfile";
import { PredictionModal } from "./PredictionModal";
import { ChartDrawingTools, Drawing, ChartDrawingToolsHandle } from "./ChartDrawingTools";
import { ZoneAnalysisModal } from "./ZoneAnalysisModal";
import { analyseLiquidations, LEVERAGES_ALL } from "../utils/liquidationClusters";
import { AstroSuggestions } from "./AstroSuggestions";
import { CompactPriceView } from "./CompactPriceView";
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
  | "1month"
  | "all";
// Default visible window per interval on a fresh view — shared between the
// initial per-coin/interval load and the fullscreen-toggle view reset
// (see the isFullscreen effect further down), so both apply exactly the
// same "what does a reset view look like" definition.
const INTERVAL_WINDOW: Partial<Record<TimeInterval, number>> = {
  "1min": 6 * 60 * 60,
  "5min": 2 * 24 * 60 * 60,
  "15min": 4 * 24 * 60 * 60,
  "1h": 14 * 24 * 60 * 60,
  "4h": 28 * 24 * 60 * 60,
  "6h": 56 * 24 * 60 * 60,
};
type IntervalTrends = Record<string, "bullish" | "bearish" | null>;
type ChartStyle = "candle" | "hollow" | "line" | "heikinAshi";
const CHART_STYLE_LABELS: Record<ChartStyle, string> = {
  candle: "Candle",
  hollow: "Hollow Candle",
  line: "Line",
  heikinAshi: "Heikin Ashi",
};
const CHART_STYLE_ICONS: Record<ChartStyle, JSX.Element> = {
  candle: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="7" y1="2" x2="7" y2="6" />
      <rect x="4.5" y="6" width="5" height="9" fill="currentColor" stroke="none" />
      <line x1="7" y1="15" x2="7" y2="20" />
      <line x1="17" y1="4" x2="17" y2="9" />
      <rect x="14.5" y="9" width="5" height="7" fill="currentColor" stroke="none" />
      <line x1="17" y1="16" x2="17" y2="22" />
    </svg>
  ),
  hollow: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <line x1="7" y1="2" x2="7" y2="6" />
      <rect x="4.5" y="6" width="5" height="9" />
      <line x1="7" y1="15" x2="7" y2="20" />
      <line x1="17" y1="4" x2="17" y2="9" />
      <rect x="14.5" y="9" width="5" height="7" />
      <line x1="17" y1="16" x2="17" y2="22" />
    </svg>
  ),
  line: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 16 9 10 13 14 21 4" />
    </svg>
  ),
  heikinAshi: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="7" y1="3" x2="7" y2="7" />
      <rect x="4.5" y="7" width="5" height="7" rx="1.5" fill="currentColor" stroke="none" />
      <line x1="7" y1="14" x2="7" y2="19" />
      <line x1="17" y1="5" x2="17" y2="8" />
      <rect x="14.5" y="8" width="5" height="9" rx="1.5" fill="currentColor" stroke="none" />
      <line x1="17" y1="17" x2="17" y2="21" />
    </svg>
  ),
};

interface PriceChartProps {
  refreshTrigger?: number;
  theme?: "dark" | "light";
  coin?: CoinSymbol;
  quoteVolume24h?: number;
  onZoneChange?: (zone: ZoneResult | null, price: number) => void;
  onOpenAuth?: () => void;
  onOpenUpgrade?: (plan?: "pro" | "elite") => void;
  onOpenCoinPicker?: (anchor: HTMLElement) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  coinChatOpen?: boolean;
  onToggleCoinChat?: () => void;
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
  "1month",
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
  "1day": "24H (90 days)",
  "1week": "1W  (52 weeks)",
  "1month": "1M  (24 months)",
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
  "1day": "24H",
  "1week": "1W",
  "1month": "1M",
  "all": "ALL",
};

// Intervals that require at least Pro
const PRO_INTERVALS = new Set<TimeInterval>(["1sec", "all"]);

// Shared with the day-hl-badge and the mobile price header — both show a
// change/high-low figure "as of" a window matched to the selected candle
// interval, so they need to agree on what that window is called.
const HL_WINDOW_LABEL: Record<TimeInterval, string> = {
  "1sec": "30M",
  "1min": "1H",
  "5min": "24H",
  "15min": "48H",
  "1h": "24H",
  "4h": "24H",
  "6h": "24H",
  "1day": "24H",
  "1week": "7D",
  "1month": "30D",
  "all": "ATH",
};

// Full coin name for the chart title ("Bitcoin" rather than "BTC") — COINS
// already carries this (services/coinglass.ts), just keyed by symbol here
// for an O(1) lookup instead of re-scanning the array on every render.
const COIN_FULL_NAME: Record<string, string> = Object.fromEntries(
  COINS.map((c) => [c.symbol, c.name]),
);

// Coin avatar (mobile header, right column) — glyph + brand color per
// coin, same glyph set App.tsx/GlobalSearch.tsx/PriceTickerFullscreen.tsx
// each keep their own copy of rather than sharing.
const COIN_GLYPHS: Record<string, string> = {
  BTC: "₿",
  ETH: "Ξ",
  XRP: "◈",
  SOL: "◎",
  BNB: "⬡",
  SUI: "⬟",
  DOGE: "Ð",
  ADA: "₳",
  NEAR: "Ⓝ",
  RENDER: "⬡",
  ZEC: "ⓩ",
};
const COIN_COLORS: Record<string, string> = {
  BTC: "#f7931a",
  ETH: "#627eea",
  XRP: "#23292f",
  SOL: "#9945ff",
  BNB: "#f0b90b",
  SUI: "#4da2ff",
  DOGE: "#c2a633",
  ADA: "#0033ad",
  NEAR: "#000000",
  RENDER: "#6633cc",
  ZEC: "#f4b728",
};

const FIB_LEVELS = [
  { ratio: 0, label: "0", color: "rgba(251,191,36,0.85)" },
  { ratio: 0.236, label: "0.236", color: "rgba(167,139,250,0.85)" },
  { ratio: 0.382, label: "0.382", color: "rgba(52,211,153,0.85)" },
  { ratio: 0.5, label: "0.5", color: "rgba(251,113,133,0.85)" },
  { ratio: 0.618, label: "0.618", color: "rgba(129,140,248,0.85)" },
  { ratio: 0.786, label: "0.786", color: "rgba(249,115,22,0.85)" },
  { ratio: 1, label: "1", color: "rgba(251,191,36,0.85)" },
] as const;

export function formatLivePrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (p >= 1) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(6)}`;
}

function formatCompactVolume(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatClockTime(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

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

// Heikin Ashi — each bar's open/close smoothed against the running HA
// sequence rather than the raw candle, which is what gives it its
// characteristic smoother, trend-following look. High/low still anchor to
// the real wick extremes (widened to include the HA open/close) so it
// never clips through the actual price action.
function calcHeikinAshi(candles: CandleDataPoint[]): CandleDataPoint[] {
  const result: CandleDataPoint[] = [];
  let prevHaOpen = 0;
  let prevHaClose = 0;
  candles.forEach((c, i) => {
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    result.push({ ...c, open: haOpen, high: haHigh, low: haLow, close: haClose });
    prevHaOpen = haOpen;
    prevHaClose = haClose;
  });
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
          ? "rgba(74,222,128,0.85)"
          : "rgba(74,222,128,0.45)"
        : h <= prev
          ? "rgba(251,113,133,0.85)"
          : "rgba(251,113,133,0.45)";
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
): { data: PatternInsight; at: number } | null {
  try {
    const r = localStorage.getItem(patternCacheKey(coin, interval));
    if (!r) return null;
    const parsed = JSON.parse(r);
    // Older cache entries (written before the "at" timestamp was added)
    // are a bare PatternInsight, not the {data,at} wrapper.
    if (parsed && typeof parsed === "object" && "data" in parsed && "at" in parsed) {
      return parsed as { data: PatternInsight; at: number };
    }
    return { data: parsed as PatternInsight, at: Date.now() };
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
    localStorage.setItem(
      patternCacheKey(coin, interval),
      JSON.stringify({ data, at: Date.now() }),
    );
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
  if (interval === "1day" || interval === "1week" || interval === "1month") return "daily";
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
  quoteVolume24h,
  onZoneChange,
  onOpenUpgrade = () => {},
  onOpenCoinPicker,
  onFullscreenChange,
  coinChatOpen,
  onToggleCoinChat,
}) => {
  const { t, i18n } = useTranslation();
  const { exceeded, consume, isPaid } = useAIQuota();
  const isLight = theme === "light";

  const [interval, setInterval] = useState<TimeInterval>("1day");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [trends, setTrends] = useState<IntervalTrends>({});
  const [banner, setBanner] = useState<IntervalAnalysis | null>(null);
  const [bannerAt, setBannerAt] = useState<number | null>(null);
  const [zone, setZone] = useState<ZoneResult | null>(null);
  const [patternInsight, setPatternInsight] = useState<PatternInsight | null>(
    () => readPatternCache(coin, "1h")?.data ?? null,
  );
  const [patternInsightAt, setPatternInsightAt] = useState<number | null>(
    () => readPatternCache(coin, "1h")?.at ?? null,
  );
  const [showBB, setShowBB] = useState(false);
  const [showRSI, setShowRSI] = useState(false);
  const [showMACD, setShowMACD] = useState(false);
  const [showEMA20, setShowEMA20] = useState(false);
  const [showEMA50, setShowEMA50] = useState(false);
  const [showEMA200, setShowEMA200] = useState(false);
  const [showMA20, setShowMA20] = useState(false);
  const [showMA50, setShowMA50] = useState(false);
  const [showMA200, setShowMA200] = useState(false);
  const [showGann, setShowGann] = useState(false);
  const [showFib, setShowFib] = useState(false);
  const [showSR, setShowSR] = useState(false);
  const [showZones, setShowZones] = useState(false);
  const [showDayHL, setShowDayHL] = useState(false);
  const [srLevels, setSrLevels] = useState<{ resistance: { price: number }[]; support: { price: number }[] }>({ resistance: [], support: [] });
  const [gannCycles, setGannCycles] = useState<GannCycleDate[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  // Desktop's Indicators/Chart style dropdowns portal to document.body
  // (like the mobile sheets already do) instead of position:absolute
  // inside the component tree — an ancestor (.main-content) has
  // overflow-x:hidden, which was clipping/hiding part of the dropdown
  // behind the side nav regardless of z-index, since overflow clipping
  // isn't something z-index can escape. Position is computed from the
  // trigger button's own rect on open.
  const indicatorsBtnRef = useRef<HTMLButtonElement>(null);
  const styleBtnRef = useRef<HTMLButtonElement>(null);
  const [indicatorsMenuPos, setIndicatorsMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [styleMenuPos, setStyleMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Desktop's Interval button opens the same kind of dropdown as
  // Indicators/Chart style instead of the mobile bottom sheet, for
  // consistency across the three.
  const [intervalMenuOpen, setIntervalMenuOpen] = useState(false);
  const intervalBtnRef = useRef<HTMLButtonElement>(null);
  const [intervalMenuPos, setIntervalMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [showCME, setShowCME] = useState(false);
  const [, setIsLive] = useState(false);
  const [dayHigh, setDayHigh] = useState<number | null>(null);
  const [dayLow, setDayLow] = useState<number | null>(null);
  const [bidPrice, setBidPrice] = useState<number | null>(null);
  const [askPrice, setAskPrice] = useState<number | null>(null);
  const [baseVolume24h, setBaseVolume24h] = useState<number | null>(null);
  const [dayChangePercent, setDayChangePercent] = useState<number | null>(null);
  const [dayChangeAbs, setDayChangeAbs] = useState<number | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [priceDirection, setPriceDirection] = useState<"up" | "down" | null>(null);
  const prevPriceRef = useRef<number | null>(null);
  const updateCurrentPrice = useCallback((price: number) => {
    const prev = prevPriceRef.current;
    if (prev !== null && price !== prev) {
      setPriceDirection(price > prev ? "up" : "down");
    }
    prevPriceRef.current = price;
    setCurrentPrice(price);
  }, []);
  const [intervalSheetOpen, setIntervalSheetOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dayLineRefs = useRef<any[]>([]);

  const [showDepthProfile, setShowDepthProfile] = useState(false);
  // Manual override for the compact (non-fullscreen) view — gridlines
  // auto-show in fullscreen/expanded regardless of this.
  const [showGrid, setShowGrid] = useState(false);
  const [chartStyle, setChartStyle] = useState<ChartStyle>("line");
  // Line-style color — green/red when the visible window has moved
  // meaningfully in one direction, blue when it's basically flat. Recomputed
  // in redrawCandleSeries alongside the line data itself, from the same
  // candles array, so it always matches whatever's actually on screen.
  const [lineTrendColor, setLineTrendColor] = useState("#818cf8");
  // Bumped every time the chart instance itself is recreated (theme/grid/
  // fullscreen change calls createChart() again) — a real, guaranteed-to-
  // differ signal for LineDotFillOverlay to resubscribe/repaint against
  // the new instance, independent of whether lineTrendColor happens to
  // compute to the same value as before (a same-value setState is a no-op
  // in React, so color alone isn't a reliable trigger here).
  const [chartGeneration, setChartGeneration] = useState(0);
  // Mirrors chartStyle for the fetch effect to read without depending on
  // it directly (same ref-mirror pattern as showFibRef) — switching style
  // should redraw from already-fetched data, not re-fetch candles.
  const chartStyleRef = useRef<ChartStyle>("candle");
  const [showAstroChart, setShowAstroChart] = useState(false);
  // Native iOS, or desktop web (not mobile web — the regular chart is
  // already compact enough there) — a full-screen, minimal price + live
  // trade-tick view (see CompactPriceView.tsx), toggled on top of the
  // full chart rather than replacing it. Same min-width:641px breakpoint
  // App.tsx's own isDesktopWidth uses.
  const [showCompactView, setShowCompactView] = useState(false);
  const [isDesktopWidth, setIsDesktopWidth] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 641px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktopWidth(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  const chartSectionRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    onFullscreenChange?.(isFullscreen);
  }, [isFullscreen, onFullscreenChange]);
  // Fullscreen "Minimal Header" layout — High/Low/Vol/Signal collapse
  // into one tappable strip inline in the header (unchanged from the
  // original design), expanding in place to show Bid/Ask/Vol-coin/
  // Signal meter/Divergence meter. Starts expanded by default on desktop
  // (room to spare) but collapsed on mobile — either way, still a toggle
  // the user can collapse/expand themselves, not forced open.
  const [fsStatsExpanded, setFsStatsExpanded] = useState(isDesktopWidth);
  useEffect(() => {
    if (!isFullscreen) setFsStatsExpanded(isDesktopWidth);
  }, [isFullscreen, isDesktopWidth]);
  // Fullscreen's persistent docked bottom sheet — options only (Style,
  // Indicators, Interval). The peek bar stays visible at all times; it
  // never fully disappears, only grows/shrinks. The sheet itself starts
  // collapsed (peek only) as before — only once the user expands it,
  // Style is the category that's already open, instead of none.
  const [fsSheetExpanded, setFsSheetExpanded] = useState(false);
  const [fsOpenCategories, setFsOpenCategories] = useState<Record<string, boolean>>({ style: true });
  // Accordion — only one category open at a time; expanding one collapses
  // whichever other was open instead of stacking them all open at once.
  const toggleFsCategory = useCallback((key: string) => {
    setFsOpenCategories((prev) => (prev[key] ? {} : { [key]: true }));
  }, []);
  const fsDockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isFullscreen) {
      setFsSheetExpanded(false);
      setFsOpenCategories({ style: true });
    }
  }, [isFullscreen]);
  // Tapping anywhere outside the docked sheet collapses it back to peek,
  // same as tapping its own peek bar would — only listens while it's
  // actually expanded, so it never intercepts normal chart taps.
  useEffect(() => {
    if (!fsSheetExpanded) return;
    const onPointerDown = (e: PointerEvent) => {
      if (fsDockRef.current && !fsDockRef.current.contains(e.target as Node)) {
        setFsSheetExpanded(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [fsSheetExpanded]);
  // Lets the fullscreen-toggle effect (further down) tell a genuine
  // isFullscreen transition apart from this same effect re-firing for an
  // unrelated reason (grid/theme change) — only a real transition should
  // force the chart style/reset the view, not every fire of that effect.
  const prevIsFullscreenForToggleRef = useRef(isFullscreen);
  // Watches .chart-mobile-price-row (the $price/change row under the coin
  // name, compact view only) and broadcasts its visibility — App.tsx's
  // sticky .mch-stats row listens for this to show/hide a compact coin+
  // price badge of its own once this one scrolls out of view. A plain
  // window CustomEvent (not a prop) since App.tsx mounts way above this
  // component in the tree — same cross-component pattern this app already
  // uses for "coin-chat-active" elsewhere.
  const mobilePriceRowRef = useRef<HTMLDivElement>(null);
  const priceRowDataRef = useRef({ coin, price: null as number | null, changePercent: null as number | null, direction: null as "up" | "down" | null });
  useEffect(() => {
    priceRowDataRef.current = { coin, price: currentPrice, changePercent: dayChangePercent, direction: priceDirection };
  });
  useEffect(() => {
    // iOS native or any mobile-width web viewport — desktop web never
    // shows this badge, since .mch-stats already has room for the full
    // price there without needing to borrow space from the chart.
    const isIosOrMobileWeb = (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") || !isDesktopWidth;
    const dispatch = (visible: boolean) => {
      window.dispatchEvent(new CustomEvent("chart-price-row-visibility", {
        detail: { visible, ...priceRowDataRef.current },
      }));
    };
    if (!isIosOrMobileWeb || isFullscreen) {
      // Fullscreen/desktop never hides this row in the first place —
      // treat as always-visible so a stale "hidden" state from a previous
      // compact-view session can't linger into either of these.
      dispatch(true);
      return;
    }
    const el = mobilePriceRowRef.current;
    // .chart-mobile-price-row only renders once currentPrice !== null — on
    // first mount that's still null (price loads async), so the ref isn't
    // attached yet. currentPrice is deliberately in the deps below so this
    // effect re-runs once it actually arrives, instead of permanently
    // bailing out here on a ref that was never going to populate in time.
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => dispatch(entry.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => {
      io.disconnect();
      dispatch(true);
    };
  }, [isDesktopWidth, isFullscreen, coin, currentPrice === null]);
  const textColor = isLight
    ? isFullscreen
      ? "#0f172a"
      : "#475569"
    : "#9490c0";
  const gridColor = isLight ? "#eef2f7" : "#2b2748";
  // Light is #ffffff (--color-background) in BOTH modes — compact
  // already was; the old code had fullscreen light backwards at
  // "#f8fafc" (--color-surface-alt), the exact same grayish mismatch
  // dark had, just never noticed since dark was the one being tested.
  // Dark compact matches --pc-bg's real value (--color-surface-alt,
  // #111827), same as always. Dark FULLSCREEN uses --color-background's
  // real value (#070c18) instead — confirmed working earlier this
  // session. Scoped to just this chart-canvas paint color, not the
  // shared --pc-bg/--pc-scrim-rgb tokens other components use too.
  const bgColor = isLight
    ? "#ffffff"
    : (isFullscreen ? "#070c18" : "#111827");
  // true when we're using the CSS fallback (iOS / no Fullscreen API)
  const cssFsRef = useRef(false);

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

  // REMOVED: this used to manually forward vertical touchmove deltas to
  // fsScrollRef's scrollTop (capture-phase, stopPropagation+preventDefault)
  // as a workaround for LWC's canvas consuming the touch before native
  // scroll could. Same anti-pattern as the compact-view scroll handler
  // removed earlier this session — no momentum after releasing, and now
  // actively fights the real fix: touch-action:pan-y on .chart-dblclick-
  // wrap (PriceChart.css) plus vertTouchDrag:false below (so LWC's own
  // vertical-drag price-scale feature never competes for the same
  // gesture) lets iOS scroll .price-chart-fs-scroll on its native fast
  // path, full momentum included, while horizontal drag/pinch still goes
  // to LWC exactly as before (pan-y only ever claims the vertical axis).

  const dblClickWrapRef = useRef<HTMLDivElement>(null);
  // Portal target for ChartEventAnnotations' cards/pager — rendered as a
  // sibling AFTER .chart-dblclick-wrap closes, so they're normal page
  // flow and can't stretch that wrapper's absolutely-positioned overlays
  // (dots layer, PredictionOverlay, LineDotFillOverlay) down over them.
  const eventCardsSlotRef = useRef<HTMLDivElement>(null);

  // Manual double-tap to enter/exit fullscreen (iOS) — native dblclick
  // synthesis from two touches is unreliable here (gets swallowed once
  // LWC's own pan/zoom/crosshair touch handling is active in fullscreen,
  // same root cause as the scroll-capture effect above), so this tracks
  // tap timing/position independently instead of depending on the browser
  // to synthesize it. Used to be fullscreen-only (exit), now covers both
  // directions since the same risk applies entering from the compact view
  // too. Passive-only (no preventDefault/stopPropagation) — it just
  // watches, so it can't interfere with whatever LWC or native scroll
  // does with the same touches.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const el = dblClickWrapRef.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let lastTapTime = 0;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1 || e.touches.length !== 0) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      // Moved too far to be a tap — a pan/drag, ignore and reset.
      if (Math.hypot(endX - startX, endY - startY) > 20) {
        lastTapTime = 0;
        return;
      }
      // Position-matching between the two taps was the real stiffness —
      // "anywhere on the chart" means a second tap several hundred px
      // from the first (top of the chart, then lower down near the
      // volume bars, say) should still count as a double-tap. Timing
      // alone — two taps close together in time, each individually a
      // real tap and not a drag — is what actually matters here.
      const now = Date.now();
      const sincePrev = now - lastTapTime;
      if (lastTapTime > 0 && sincePrev < 450) {
        toggleFullscreen();
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true, capture: true });
    el.addEventListener("touchend", onEnd, { passive: true, capture: true });
    return () => {
      el.removeEventListener("touchstart", onStart, { capture: true } as EventListenerOptions);
      el.removeEventListener("touchend", onEnd, { capture: true } as EventListenerOptions);
    };
  }, [isFullscreen, toggleFullscreen]);

  // Main chart refs
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleRef = useRef<any>(null);
  // Close-price line, used only when chartStyle === "line" — kept alive
  // (hidden) the rest of the time rather than swapped in/out, so toggling
  // styles never has to add/remove a series mid-session.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lineCloseRef = useRef<any>(null);
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
  const srLineRefs = useRef<any[]>([]);
  const zoneLineRefs = useRef<any[]>([]);
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
  // True once a zone shape exists on the chart — shows the "Clear" button
  // next to "Explain Zone" instead of floating it over the drawn shape.
  const [hasZone, setHasZone] = useState(false);
  const drawingToolsRef = useRef<ChartDrawingToolsHandle>(null);

  const handleExplainZoneStart = useCallback(() => {
    if (!isPaid) { onOpenUpgrade?.("pro"); return; }
    drawingToolsRef.current?.activateZoneTool();
    setAwaitingZoneDraw(true);
  }, [isPaid, onOpenUpgrade]);

  const handleClearZone = useCallback(() => {
    drawingToolsRef.current?.clearZoneTool();
    setHasZone(false);
  }, []);

  const handleZoneComplete = useCallback((_drawing: Drawing, candles: CandleDataPoint[]) => {
    setAwaitingZoneDraw(false);
    setHasZone(true);
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

      // Fullscreen always opens on candles, compact always on line — must
      // happen BEFORE the candle/line series are created just below,
      // since their own `visible` option is set once at creation from
      // this exact ref. Setting it only afterward (what this used to do)
      // meant the new series were born with the PREVIOUS mode's
      // visibility already baked in, and the fix only arrived a render
      // later via the chartStyle state-sync effect — which never fired
      // at all if chartStyle state hadn't actually changed (e.g. it was
      // already "candle" from an earlier fullscreen session), leaving
      // the wrong series visible with no correction ever coming.
      const forcedStyle = isFullscreen ? "candle" : "line";
      chartStyleRef.current = forcedStyle;
      if (chartStyle !== forcedStyle) setChartStyle(forcedStyle);

      const chart = createChart(el, {
        width,
        height,
        layout: {
          background: {
            type: ColorType.Solid,
            // Matches bgColor below exactly (same #111827 reasoning) — this
            // is the INITIAL createChart call, a separate literal from the
            // theme-sync effect's applyOptions, so it needs the same fix or
            // every fresh mount/recreation briefly paints the old mismatched
            // value before the sync effect corrects it a tick later.
            color: isLight ? "#ffffff" : "#111827",
          },
          textColor: isLight ? "#475569" : "#9490c0",
        },
        // Gridlines only read as useful at fullscreen/expanded size — in
        // the compact inline card they just add visual noise, so start
        // transparent; the theme-sync effect below turns them on once
        // isFullscreen flips true.
        grid: {
          vertLines: { color: "transparent" },
          horzLines: { color: "transparent" },
        },
        crosshair: { mode: 1 },
        // Matches the gridlines — transparent until the theme-sync effect
        // turns it on for fullscreen/expanded view or the Grid toggle.
        rightPriceScale: { borderColor: "transparent" },
        timeScale: {
          borderColor: isLight ? "#e2e8f0" : "#2b2748",
          timeVisible: true,
          secondsVisible: false,
        },
        // Matches the theme-sync effect — starts display-only (isFullscreen
        // is false on first mount) so the page scrolls past the chart
        // smoothly instead of the chart eating the gesture to pan/zoom.
        handleScroll: {
          mouseWheel: false,
          pressedMouseMove: false,
          horzTouchDrag: false,
          vertTouchDrag: false,
        },
        handleScale: {
          mouseWheel: false,
          pinch: false,
          axisPressedMouseMove: false,
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
        topColor: "rgba(129,140,248,0.10)",
        bottomColor: "rgba(129,140,248,0.10)",
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
        upColor: "#4ade80",
        downColor: "#fb7185",
        borderUpColor: "#4ade80",
        borderDownColor: "#fb7185",
        wickUpColor: "#4ade80",
        wickDownColor: "#fb7185",
        visible: chartStyleRef.current !== "line",
      });
      lineCloseRef.current = chart.addSeries(LineSeries, {
        color: "#818cf8",
        lineWidth: 2,
        visible: chartStyleRef.current === "line",
      });
      volumeRef.current = chart.addSeries(HistogramSeries, {
        priceScaleId: "volume",
        priceLineVisible: false,
        lastValueVisible: false,
        color: "rgba(100,100,100,0.4)",
      });
      chart
        .priceScale("volume")
        // Mobile fullscreen only — the "Chart Settings" dock sits fixed
        // at the bottom of the viewport there and was covering the
        // volume bars entirely (bottom:0 ran them right to the canvas
        // edge); a bottom margin lifts them clear of it. Desktop
        // fullscreen and compact (no dock overlay) keep bottom:0.
        .applyOptions({ scaleMargins: { top: 0.8, bottom: isFullscreen && !isDesktopWidth ? 0.14 : 0 } });

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
        color: "rgba(74,222,128,0.7)",
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
        color: "#818cf8",
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
      setChartGeneration((g) => g + 1);
      if (lastCandlesRef.current.length > 0) {
        // redrawCandleSeries (not a narrower candleRef-only setData) —
        // this effect recreates the whole chart (theme/grid/fullscreen
        // change), including a brand-new lineCloseRef with no data on it
        // yet. The old candleRef-only call left "line" style's series
        // empty after a theme switch until some unrelated later refresh
        // happened to repopulate it — invisible back when "candle" was
        // the default (candleRef did get redrawn), but immediately
        // obvious now that "line" is. This also recomputes lineTrendColor
        // from the real data instead of leaving it stale.
        redrawCandleSeries(lastCandlesRef.current);
        updateCurrentPrice(lastCandlesRef.current[lastCandlesRef.current.length - 1].close);
        // Reset to the same default window every recreation (theme/grid/
        // fullscreen toggle all land here) — most relevantly, closing
        // fullscreen back to the compact view no longer leaves whatever
        // zoom/pan the chart was left at; it's always a fresh, correct
        // view instead, same INTERVAL_WINDOW definition the very first
        // load for this coin+interval already uses.
        const window = INTERVAL_WINDOW[interval];
        const lastCandleTime = lastCandlesRef.current[lastCandlesRef.current.length - 1].time as number;
        if (window) {
          chart.timeScale().setVisibleRange({
            from: (lastCandleTime - window) as UTCTimestamp,
            to: lastCandleTime as UTCTimestamp,
          });
        } else {
          chart.timeScale().fitContent();
        }
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
      chartRef.current = candleRef.current = lineCloseRef.current = volumeRef.current = null;
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
        vertLines: { color: showGrid ? gridColor : "transparent" },
        horzLines: { color: showGrid ? gridColor : "transparent" },
      },
      rightPriceScale: { borderColor: showGrid ? gridColor : "transparent" },
      timeScale: { borderColor: gridColor },
      // Pan/zoom only once expanded — in the compact inline card these
      // gestures mostly just fight with the page's own scroll/swipe
      // instead of being useful, so the compact view is display-only and
      // double-click (see .chart-dblclick-wrap) is the way to zoom at all.
      // vertTouchDrag now follows isFullscreen too — the fullscreen page
      // itself no longer scrolls at all on mobile (a fixed header + a
      // non-scrolling flex layout instead), so there's nothing left for
      // this gesture to compete with there; a single-finger vertical drag
      // now pans/zooms the price scale, same as TradingView. Compact view
      // still needs it off, since that page does scroll normally.
      handleScroll: { mouseWheel: isFullscreen, pressedMouseMove: isFullscreen, horzTouchDrag: isFullscreen, vertTouchDrag: isFullscreen },
      handleScale: {
        mouseWheel: isFullscreen,
        pinch: isFullscreen,
        axisPressedMouseMove: isFullscreen,
      },
    };
    const chart = chartRef.current;
    chart?.applyOptions(themeOpts);
    rsiChartRef.current?.applyOptions(themeOpts);
    macdChartRef.current?.applyOptions(themeOpts);
    bbFillLowerRef.current?.applyOptions({ topColor: bgColor, bottomColor: bgColor });
    // Mirrors the volume scaleMargins set at chart creation (initChart,
    // above) — that only re-runs on a theme change, not a plain
    // fullscreen toggle, so this effect (which DOES fire on every
    // fullscreen toggle) needs its own copy to actually keep the volume
    // bars clear of the mobile fullscreen dock when just entering/
    // exiting fullscreen without a theme change alongside it.
    chart?.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: isFullscreen && !isDesktopWidth ? 0.14 : 0 },
    });

    // THIS is the effect that actually fires on a fullscreen toggle — the
    // chart instance itself is NOT recreated here (that only happens on a
    // theme change, a separate effect above), so the "force candle in
    // fullscreen / line in compact, reset the view" logic that used to
    // live only inside chart creation never ran for a plain fullscreen
    // enter/exit at all. prevIsFullscreenForToggleRef scopes this to an
    // actual isFullscreen transition specifically — this effect also
    // fires for grid/theme changes alone, which shouldn't force a style
    // switch or reset the zoom the user was just looking at.
    if (chart && prevIsFullscreenForToggleRef.current !== isFullscreen) {
      prevIsFullscreenForToggleRef.current = isFullscreen;
      const forcedStyle = isFullscreen ? "candle" : "line";
      if (chartStyleRef.current !== forcedStyle) {
        chartStyleRef.current = forcedStyle;
        setChartStyle(forcedStyle);
        candleRef.current?.applyOptions({ visible: forcedStyle !== "line" });
        lineCloseRef.current?.applyOptions({ visible: forcedStyle === "line" });
        if (lastCandlesRef.current.length > 0) redrawCandleSeries(lastCandlesRef.current);
      }
      if (lastCandlesRef.current.length > 0) {
        const window = INTERVAL_WINDOW[interval];
        const lastCandleTime = lastCandlesRef.current[lastCandlesRef.current.length - 1].time as number;
        if (window) {
          chart.timeScale().setVisibleRange({
            from: (lastCandleTime - window) as UTCTimestamp,
            to: lastCandleTime as UTCTimestamp,
          });
        } else {
          chart.timeScale().fitContent();
        }
      }
    }
  // redrawCandleSeries intentionally omitted — a useCallback with []
  // deps, so its reference is provably stable across renders; including
  // it would need a forward reference this effect can't take (it's
  // declared further down the component).
  }, [theme, isFullscreen, showGrid, bgColor, textColor, gridColor, interval]);

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
          redrawCandleSeries(data);
          updateCurrentPrice(data[data.length - 1].close);
          if (showFibRef.current) redrawFibLines();
          volumeRef.current?.setData(
            data.map((c) => ({
              time: c.time,
              value: c.volume ?? 0,
              color:
                c.close >= c.open
                  ? "rgba(74,222,128,0.45)"
                  : "rgba(251,113,133,0.45)",
            })),
          );
          const { upper, middle, lower } = calcBollingerBands(data);
          bbUpperRef.current?.setData(upper);
          bbMiddleRef.current?.setData(middle);
          bbLowerRef.current?.setData(lower);
          bbFillUpperRef.current?.setData(upper);
          bbFillLowerRef.current?.setData(lower);

          // S/R, Buy/Sell zone, and 24H High/Low are all rendered by their
          // own dedicated effects below (redrawn on toggle without
          // re-fetching candles) — this just computes the raw data they
          // read from state.
          const { resistance, support } = calcSupportResistance(data);
          setSrLevels({ resistance, support });

          // Buy/sell zone — always calculate for signal direction; chart lines only for Pro+
          const lastPrice = data[data.length - 1].close;
          const zones = calcBuySellZones(data);
          setZone(zones);
          onZoneChange?.(isPaid ? zones : null, lastPrice);

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
            const windowOpen = hlCandles[0].open;
            if (windowOpen) {
              setDayChangeAbs(lastPrice - windowOpen);
              setDayChangePercent(((lastPrice - windowOpen) / windowOpen) * 100);
            } else {
              setDayChangeAbs(null);
              setDayChangePercent(null);
            }
          } else {
            setDayHigh(null);
            setDayLow(null);
            setDayChangeAbs(null);
            setDayChangePercent(null);
          }

          const newBanner = analyzeInterval(data, INTERVAL_LABELS[interval]);
          setBanner(newBanner);
          setBannerAt(newBanner ? Date.now() : null);

          // Show cached or rule-based insight immediately; fallback is trend-aware
          const cached = readPatternCache(coin, interval);
          if (cached) {
            setPatternInsight(cached.data);
            setPatternInsightAt(cached.at);
          } else {
            setPatternInsight(trendAwarePattern(data, newBanner?.sentiment ?? null));
            setPatternInsightAt(Date.now());
          }
          // Only call AI if quota allows
          if (!exceeded) {
            consume().then((ok) => {
              if (!ok) return;
              getCandlePatternAnalysis(coin, interval, data).then((res) => {
                if (res.success && res.result) {
                  setPatternInsight(res.result);
                  setPatternInsightAt(Date.now());
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
                  color: div.type === "bullish" ? "#4ade80" : "#fb7185",
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
                  color: div.type === "bullish" ? "#4ade80" : "#fb7185",
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

  // ── Bid/ask + base-asset volume for the fullscreen stats bar ─────────────
  // Only polled while that bar is actually on screen (fullscreen, any
  // width — mobile and desktop both show it now) — it's the only
  // consumer, and Binance's /24hr ticker is cheap but no reason to hit it
  // in the background.
  useEffect(() => {
    if (!isFullscreen) {
      setBidPrice(null);
      setAskPrice(null);
      setBaseVolume24h(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const snap = await getTickerSnapshot(coin);
      if (!cancelled && snap) {
        setBidPrice(snap.bid);
        setAskPrice(snap.ask);
        setBaseVolume24h(snap.volume);
      }
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coin, isFullscreen]);

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
          // Heikin Ashi needs the running prior-bar state to update
          // correctly tick-by-tick — skipped here and left to catch up on
          // the next full refresh rather than injecting a raw (wrong) bar.
          if (chartStyleRef.current === "line") {
            lineCloseRef.current?.update({ time: candle.time, value: candle.close });
          } else if (chartStyleRef.current === "hollow") {
            candleRef.current?.update({
              ...candle,
              color: candle.close >= candle.open ? "transparent" : undefined,
            });
          } else if (chartStyleRef.current === "candle") {
            candleRef.current?.update(candle);
          }
          updateCurrentPrice(candle.close);
          if (candle.volume !== undefined) {
            volumeRef.current?.update({
              time: candle.time,
              value: candle.volume,
              color:
                candle.close >= candle.open
                  ? "rgba(74,222,128,0.45)"
                  : "rgba(251,113,133,0.45)",
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
    setBannerAt(null);
    setZone(null);
    setPatternInsight(null);
    setPatternInsightAt(null);
    setTrends({});
    coinglass
      .getIntervalTrends(coin)
      .then(setTrends)
      .catch(() => {});
  }, [refreshTrigger, coin]);

  useEffect(() => {
    lastCandlesRef.current = [];
  }, [coin]);

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

  // ── Chart style (candle / hollow / line / Heikin Ashi) ───────────────────
  // candleRef stays a CandlestickSeries at all times (every price-line
  // feature in this file — S/R, zones, Fib, CME, day H/L — is anchored to
  // it), so "line" mode just hides it and shows lineCloseRef instead,
  // rather than swapping series types.
  const redrawCandleSeries = useCallback((candles: CandleDataPoint[]) => {
    lineCloseRef.current?.setData(
      candles.map((c) => ({ time: c.time, value: c.close })),
    );
    if (candles.length > 1) {
      const first = candles[0].close;
      const last = candles[candles.length - 1].close;
      const pctChange = first !== 0 ? ((last - first) / first) * 100 : 0;
      // A small dead zone around 0 reads as "flat" (blue/neutral) rather
      // than flipping to green/red on a barely-there move.
      const color = pctChange > 0.15 ? "#4ade80" : pctChange < -0.15 ? "#fb7185" : "#818cf8";
      setLineTrendColor(color);
      lineCloseRef.current?.applyOptions({ color });
    }
    if (!candleRef.current) return;
    const style = chartStyleRef.current;
    const source = style === "heikinAshi" ? calcHeikinAshi(candles) : candles;
    if (style === "hollow") {
      candleRef.current.setData(
        source.map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          color: c.close >= c.open ? "transparent" : undefined,
        })),
      );
    } else {
      candleRef.current.setData(source);
    }
  }, []);

  useEffect(() => {
    chartStyleRef.current = chartStyle;
    candleRef.current?.applyOptions({ visible: chartStyle !== "line" });
    lineCloseRef.current?.applyOptions({ visible: chartStyle === "line" });
    if (lastCandlesRef.current.length > 0) redrawCandleSeries(lastCandlesRef.current);
  }, [chartStyle, redrawCandleSeries]);

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
      interval === "1week" || interval === "1month" || interval === "all"
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
      color: p.type === "high" ? "#fb7185" : "#4ade80",
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

  // ── Support / Resistance lines ───────────────────────────────────────────
  useEffect(() => {
    for (const pl of srLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    srLineRefs.current = [];
    if (!showSR || !candleRef.current) return;
    for (const { price } of srLevels.resistance) {
      const pl = candleRef.current.createPriceLine({
        price,
        color: "rgba(251,113,133,0.75)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "R",
      });
      if (pl) srLineRefs.current.push(pl);
    }
    for (const { price } of srLevels.support) {
      const pl = candleRef.current.createPriceLine({
        price,
        color: "rgba(74,222,128,0.75)",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "S",
      });
      if (pl) srLineRefs.current.push(pl);
    }
  }, [showSR, srLevels]);

  // ── Buy / Sell zone lines ────────────────────────────────────────────────
  useEffect(() => {
    for (const pl of zoneLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    zoneLineRefs.current = [];
    if (!showZones || !isPaid || !zone || !candleRef.current) return;
    const zoneLines: [number, string, string][] = [
      [zone.buyZone.upper, "rgba(74,222,128,0.5)", "Buy Zone ▲"],
      [zone.buyZone.lower, "rgba(74,222,128,0.5)", "Buy Zone ▼"],
      [zone.sellZone.upper, "rgba(251,113,133,0.5)", "Sell Zone ▲"],
      [zone.sellZone.lower, "rgba(251,113,133,0.5)", "Sell Zone ▼"],
    ];
    for (const [price, color, title] of zoneLines) {
      const pl = candleRef.current.createPriceLine({
        price,
        color,
        title,
        lineWidth: 1,
        lineStyle: 3,
        axisLabelVisible: true,
      });
      if (pl) zoneLineRefs.current.push(pl);
    }
  }, [showZones, zone, isPaid]);

  // ── 24H High/Low lines ────────────────────────────────────────────────────
  useEffect(() => {
    for (const pl of dayLineRefs.current) {
      try {
        candleRef.current?.removePriceLine(pl);
      } catch {
        /* ok */
      }
    }
    dayLineRefs.current = [];
    if (!showDayHL || dayHigh === null || dayLow === null || !candleRef.current) return;
    const hlHigh = candleRef.current.createPriceLine({
      price: dayHigh,
      color: "#facc15",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "24H H",
    });
    const hlLow = candleRef.current.createPriceLine({
      price: dayLow,
      color: "#818cf8",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "24H L",
    });
    if (hlHigh) dayLineRefs.current.push(hlHigh);
    if (hlLow) dayLineRefs.current.push(hlLow);
  }, [showDayHL, dayHigh, dayLow]);

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
      // Matches the main chart — transparent until the manual Grid
      // toggle turns gridlines on (fullscreen no longer force-enables
      // them).
      grid: {
        vertLines: { color: showGrid ? gridColor : "transparent" },
        horzLines: { color: showGrid ? gridColor : "transparent" },
      },
      rightPriceScale: {
        borderColor: showGrid ? gridColor : "transparent",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      // vertTouchDrag follows isFullscreen here too — same reasoning as
      // the main chart above.
      handleScroll: { mouseWheel: isFullscreen, pressedMouseMove: isFullscreen, horzTouchDrag: isFullscreen, vertTouchDrag: isFullscreen },
      handleScale: {
        axisPressedMouseMove: isFullscreen,
        mouseWheel: isFullscreen,
        pinch: isFullscreen,
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
      color: "#818cf8",
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
      color: "rgba(74,222,128,0.65)",
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
      color: "#818cf8",
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

  // REMOVED: this used to manually forward every touchmove pixel to
  // .main-content's scrollTop (no isFullscreen guard — ran in both modes),
  // as a workaround for "iOS Safari pans the viewport on any touch-drag
  // inside the chart." That workaround predates the real fix now in
  // PriceChart.css (pointer-events:none on .chart-canvas-wrap outside
  // fullscreen + touch-action:pan-y on .chart-dblclick-wrap), which lets
  // iOS scroll .main-content on its own native fast path, full momentum
  // included. With both active at once, native momentum scroll would
  // start, then this handler's unconditional preventDefault + manual
  // scrollTop += took back over mid-gesture and killed it — exactly the
  // "smooth while the finger is still down, dead the instant you release"
  // symptom. The CSS fix alone is sufficient; this was actively fighting it.

  // ── Screenshot ───────────────────────────────────────────────────────────
  const handleScreenshot = async () => {
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
    ctx.fillStyle = "rgba(129,140,248,0.18)";
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
        "strong-buy": "#4ade80",
        buy: "#86efac",
        oversold: "#f59e0b",
        neutral: "#94a3b8",
        overbought: "#f59e0b",
        sell: "#fca5a5",
        "strong-sell": "#fb7185",
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

    const dataUrl = out.toDataURL("image/png");
    const filename = `${coin}-${shortInterval}-${new Date().toISOString().slice(0, 10)}.png`;

    if (Capacitor.isNativePlatform()) {
      // <a download> is a no-op in a WKWebView — there's no downloads
      // folder on iOS for it to land in, so the button did nothing.
      // Write the PNG to the app's cache dir instead and hand it to the
      // native share sheet, where "Save Image" drops it straight into
      // Photos (NSPhotoLibraryAddUsageDescription already covers this —
      // see Info.plist).
      try {
        const base64 = dataUrl.split(",")[1];
        const written = await Filesystem.writeFile({
          path: filename,
          data: base64,
          directory: Directory.Cache,
        });
        await Share.share({ url: written.uri, dialogTitle: t("chart.save") });
      } catch (err) {
        console.error("Chart save failed:", err);
      }
      return;
    }

    // Trigger download
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = filename;
    link.click();
  };

  // The checkbox list — shared between desktop's positioned dropdown and
  // mobile's bottom sheet (indicatorsControl below).
  const indicatorsList = (
    <>
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
          style={{ background: "#818cf8" }}
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
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showSR}
          onChange={(e) => setShowSR(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "rgba(251,113,133,0.75)" }}
        />
        <span>Support / Resistance</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showDayHL}
          onChange={(e) => setShowDayHL(e.target.checked)}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "#facc15" }}
        />
        <span>24H High/Low</span>
      </label>
      <label className="indicators-menu-item">
        <input
          type="checkbox"
          checked={showZones}
          onChange={(e) => {
            if (!isPaid) { onOpenUpgrade?.("pro"); return; }
            setShowZones(e.target.checked);
          }}
        />
        <span
          className="indicators-menu-dot"
          style={{ background: "rgba(74,222,128,0.75)" }}
        />
        <span>Buy/Sell Zones</span>
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
          style={{ background: "#818cf8" }}
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
    </>
  );

  // Indicators toggle — icon button matches Order Depth/Save/Expand
  // (chart-legend-actions), same spot on desktop and mobile. Desktop opens
  // the classic positioned dropdown under the button; mobile opens a
  // bottom sheet instead — same indicatorsList content either way.
  const indicatorsControl = (
    <div className="indicators-menu-wrapper">
      <button
        ref={indicatorsBtnRef}
        className={`chart-depth-btn chart-indicators-btn${menuOpen ? " chart-depth-btn--active" : ""}`}
        onClick={() => {
          if (!menuOpen && isDesktopWidth && indicatorsBtnRef.current) {
            const r = indicatorsBtnRef.current.getBoundingClientRect();
            setIndicatorsMenuPos({ top: r.bottom + 6, left: r.left });
          }
          setMenuOpen((v) => !v);
        }}
        title={t("chart.indicators")}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
        <span className="chart-icon-label">{t("chart.indicators")}</span>
      </button>
      {menuOpen && (isDesktopWidth ? (
        indicatorsMenuPos && ReactDOM.createPortal(
          <>
            <div className="indicators-menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="indicators-menu indicators-menu--portal" style={{ top: indicatorsMenuPos.top, left: indicatorsMenuPos.left }}>
              {indicatorsList}
            </div>
          </>,
          document.body,
        )
      ) : ReactDOM.createPortal(
        <>
          <div className="indicators-sheet-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="indicators-sheet">
            <div className="indicators-sheet-header">
              <span className="indicators-sheet-title">{t("chart.indicators")}</span>
              <button type="button" className="indicators-sheet-close" onClick={() => setMenuOpen(false)}>✕</button>
            </div>
            <div className="indicators-menu indicators-menu--sheet">{indicatorsList}</div>
          </div>
        </>,
        document.body,
      ))}
    </div>
  );

  // Mobile-only right column — just 24h volume now; price/change moved to
  // its own row under the coin name on the left (chart-mobile-price-row,
  // in the JSX below).
  const mobileStatsBlock = (
    <div className="chart-mobile-stats">
      <span
        className="chart-mobile-avatar"
        style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
      >
        {COIN_GLYPHS[coin] ?? coin[0]}
      </span>
      {quoteVolume24h !== undefined && quoteVolume24h > 0 && (
        <span className="chart-mobile-vol">
          <span className="chart-mobile-vol-label">{t("chart.vol24h", "24hr vol")}</span>
          <span className="chart-mobile-vol-value">{formatCompactVolume(quoteVolume24h)}</span>
        </span>
      )}
    </div>
  );

  // The "Select Interval" bottom sheet — opened by fsIntervalButton
  // (below), now the only interval control on every platform/width.
  // Rendered unconditionally (not tied to any one trigger button's own
  // mount state) further down in the main return.
  const intervalSheetPortal = intervalSheetOpen && ReactDOM.createPortal(
    <>
      <div className="interval-sheet-backdrop" onClick={() => setIntervalSheetOpen(false)} />
      <div className="interval-sheet">
        <div className="interval-sheet-header">
          <span className="interval-sheet-title">{t("chart.selectInterval", "Select Interval")}</span>
          <button type="button" className="interval-sheet-close" onClick={() => setIntervalSheetOpen(false)}>✕</button>
        </div>
        <div className="interval-sheet-list">
          {INTERVALS.map((opt) => {
            const needsPro = PRO_INTERVALS.has(opt);
            const locked   = needsPro && !isPaid;
            const trend    = trends[opt];
            return (
              <button
                type="button"
                key={opt}
                className={`interval-sheet-item${interval === opt ? " interval-sheet-item--active" : ""}${locked ? " interval-sheet-item--locked" : ""}`}
                onClick={() => {
                  if (locked) { onOpenUpgrade?.("pro"); return; }
                  setInterval(opt);
                  setIntervalSheetOpen(false);
                }}
              >
                <span className="interval-sheet-item-label">
                  {INTERVAL_LABELS[opt]}
                  {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                    : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                    : null}
                </span>
                {locked ? <span className="interval-sheet-item-pro">PRO</span>
                  : interval === opt ? <span className="interval-sheet-item-check">✓</span>
                  : null}
              </button>
            );
          })}
        </div>
      </div>
    </>,
    document.body,
  );

  // Grid toggle + chart-style picker — shown both in the compact view's
  // own standalone row (chart-interval-row-standalone) and in fullscreen's
  // legend-actions row, so switching into fullscreen doesn't hide them.
  // Grid toggle now renders next to Indicators in .chart-legend-actions
  // instead of alongside Chart style — split out of the combined control
  // below so it can be positioned separately while Chart style stays put.
  const gridToggleButton = (
    <button
      type="button"
      className={`chart-depth-btn chart-grid-toggle-btn${showGrid ? " chart-depth-btn--active" : ""}`}
      onClick={() => setShowGrid((v) => !v)}
      title={showGrid ? "Hide grid" : "Show grid"}
      data-tooltip={showGrid ? "Hide grid" : "Show grid"}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
      <span className="chart-icon-label">Grid</span>
    </button>
  );
  const gridStyleControls = (
    <div className="chart-grid-style-row">
      <div className="indicators-menu-wrapper chart-style-menu-wrapper">
        <button
          ref={styleBtnRef}
          type="button"
          className={`chart-depth-btn chart-style-btn${styleMenuOpen ? " chart-depth-btn--active" : ""}`}
          onClick={() => {
            if (!styleMenuOpen && isDesktopWidth && styleBtnRef.current) {
              const r = styleBtnRef.current.getBoundingClientRect();
              setStyleMenuPos({ top: r.bottom + 6, left: r.left });
            }
            setStyleMenuOpen((v) => !v);
          }}
          title="Chart style"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="7" y1="3" x2="7" y2="8" />
            <rect x="4" y="8" width="6" height="8" />
            <line x1="7" y1="16" x2="7" y2="21" />
            <line x1="17" y1="5" x2="17" y2="10" />
            <rect x="14" y="10" width="6" height="6" />
            <line x1="17" y1="16" x2="17" y2="19" />
          </svg>
          <span className="chart-icon-label">{CHART_STYLE_LABELS[chartStyle]}</span>
        </button>
        {styleMenuOpen && (isDesktopWidth ? (
          styleMenuPos && ReactDOM.createPortal(
            <>
              <div className="indicators-menu-backdrop" onClick={() => setStyleMenuOpen(false)} />
              <div className="indicators-menu indicators-menu--portal" style={{ top: styleMenuPos.top, left: styleMenuPos.left }}>
                {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                  <div
                    key={s}
                    className="indicators-menu-item"
                    onClick={() => {
                      setChartStyle(s);
                      setStyleMenuOpen(false);
                    }}
                  >
                    {CHART_STYLE_LABELS[s]}
                    {chartStyle === s && <span className="chart-style-check">✓</span>}
                  </div>
                ))}
              </div>
            </>,
            document.body,
          )
        ) : ReactDOM.createPortal(
          <>
            <div className="indicators-sheet-backdrop" onClick={() => setStyleMenuOpen(false)} />
            <div className="indicators-sheet">
              <div className="indicators-sheet-header">
                <span className="indicators-sheet-title">Chart style</span>
                <button type="button" className="indicators-sheet-close" onClick={() => setStyleMenuOpen(false)}>✕</button>
              </div>
              <div className="indicators-menu indicators-menu--sheet">
                {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                  <div
                    key={s}
                    className="indicators-menu-item"
                    onClick={() => {
                      setChartStyle(s);
                      setStyleMenuOpen(false);
                    }}
                  >
                    {CHART_STYLE_LABELS[s]}
                    {chartStyle === s && <span className="chart-style-check">✓</span>}
                  </div>
                ))}
              </div>
            </div>
          </>,
          document.body,
        ))}
      </div>
    </div>
  );

  // Fullscreen only (mobile/iOS and desktop alike) — Interval sits next
  // to Grid in the icon row, opening the SAME "Select Interval" bottom
  // sheet chartControlsPanel's own "more" button already uses
  // (intervalSheetOpen) rather than a second, duplicate picker.
  const fsIntervalButton = (
    <div className="indicators-menu-wrapper">
      <button
        ref={intervalBtnRef}
        type="button"
        className={`chart-depth-btn chart-fs-interval-btn${(isDesktopWidth ? intervalMenuOpen : intervalSheetOpen) ? " chart-depth-btn--active" : ""}`}
        onClick={() => {
          if (isDesktopWidth) {
            if (!intervalMenuOpen && intervalBtnRef.current) {
              const r = intervalBtnRef.current.getBoundingClientRect();
              setIntervalMenuPos({ top: r.bottom + 6, left: r.left });
            }
            setIntervalMenuOpen((v) => !v);
            return;
          }
          setIntervalSheetOpen(true);
        }}
        title={t("chart.interval", "Interval")}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </svg>
        <span className="chart-icon-label">{INTERVAL_SHORT[interval]}</span>
      </button>
      {intervalMenuOpen && isDesktopWidth && intervalMenuPos && ReactDOM.createPortal(
        <>
          <div className="indicators-menu-backdrop" onClick={() => setIntervalMenuOpen(false)} />
          <div className="indicators-menu indicators-menu--portal" style={{ top: intervalMenuPos.top, left: intervalMenuPos.left }}>
            {INTERVALS.map((opt) => {
              const needsPro = PRO_INTERVALS.has(opt);
              const locked = needsPro && !isPaid;
              const trend = trends[opt];
              return (
                <div
                  key={opt}
                  className="indicators-menu-item"
                  onClick={() => {
                    if (locked) { onOpenUpgrade?.("pro"); return; }
                    setInterval(opt);
                    setIntervalMenuOpen(false);
                  }}
                >
                  {INTERVAL_LABELS[opt]}
                  {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                    : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                    : null}
                  {locked ? <span className="interval-sheet-item-pro">PRO</span>
                    : interval === opt ? <span className="chart-style-check">✓</span>
                    : null}
                </div>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );

  // Fullscreen's persistent docked bottom sheet — options only (Style/
  // Indicators/Interval), grouped as independent accordion categories the
  // user expands one at a time instead of scrolling one long list. High/
  // Low/Vol/Signal/Bid/Ask/Divergence stay inline in the header instead
  // (chart-fs-stats-strip/chart-fs-info-row above) — this sheet never
  // duplicates live stats, only settings.
  const fsSignalBucket = zone
    ? (zone.signal === "oversold" || zone.signal === "buy" || zone.signal === "strong-buy"
        ? "oversold"
        : zone.signal === "overbought" || zone.signal === "sell" || zone.signal === "strong-sell"
        ? "overbought"
        : "neutral")
    : null;
  const fsSignalLabel = fsSignalBucket === "oversold" ? t("chart.oversold")
    : fsSignalBucket === "overbought" ? t("chart.overbought")
    : fsSignalBucket === "neutral" ? t("chart.neutralZone")
    : null;
  const fsSignalPct = fsSignalBucket === "oversold" ? 0 : fsSignalBucket === "overbought" ? 100 : 50;
  const fsDivBucket = divergence?.type === "bearish" ? "bearish" : divergence?.type === "bullish" ? "bullish" : "none";
  const fsDivDotBucket = fsDivBucket === "bearish" ? "overbought" : fsDivBucket === "bullish" ? "oversold" : "neutral";
  const fsDivLabel = fsDivBucket === "bearish" ? t("chart.bearish", "Bearish")
    : fsDivBucket === "bullish" ? t("chart.bullish", "Bullish")
    : t("chart.none", "None");
  const fsDivPct = fsDivBucket === "bearish" ? 0 : fsDivBucket === "bullish" ? 100 : 50;

  const fsDockSheet = isFullscreen && !isDesktopWidth && ReactDOM.createPortal(
    <div ref={fsDockRef} className={`fs-dock${fsSheetExpanded ? " fs-dock--expanded" : ""}`}>
      <button
        type="button"
        className="fs-dock-peek"
        onClick={() => setFsSheetExpanded((v) => !v)}
      >
        <span className="fs-dock-handle" />
        <span className="fs-dock-title-row">
          <svg className="fs-dock-title-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="fs-dock-title">{t("chart.chartSettings", "Chart Settings")}</span>
          <span className="fs-dock-interval-badge">{INTERVAL_SHORT[interval]}</span>
          <div style={{ flex: 1 }} />
          {fsSheetExpanded ? (
            <svg className="chart-fs-strip-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          ) : (
            <svg className="chart-fs-strip-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </span>
      </button>

      {fsSheetExpanded && (
        <div className="fs-dock-body">

          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("style")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--style">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                  <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                  <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                  <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                  <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.4-4-8.9-10-8.9z" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.style", "Style")}</span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.style ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.style && (
              <div className="fs-dock-category-body">
                <button
                  type="button"
                  className={`fs-controls-row-toggle${showGrid ? " fs-controls-row-toggle--on" : ""}`}
                  onClick={() => setShowGrid((v) => !v)}
                >
                  <span>{t("chart.grid", "Grid")}</span>
                  <span className="fs-controls-switch" />
                </button>
                <div className="fs-controls-style-grid">
                  {(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => (
                    <button
                      type="button"
                      key={s}
                      className={`fs-controls-chip${chartStyle === s ? " fs-controls-chip--active" : ""}`}
                      onClick={() => setChartStyle(s)}
                    >
                      <span className="fs-controls-chip-icon">{CHART_STYLE_ICONS[s]}</span>
                      {CHART_STYLE_LABELS[s]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("indicators")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--indicators">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="M7 16l4-5 3 3 5-7" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.indicators")}</span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.indicators ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.indicators && (
              <div className="fs-dock-category-body">
                <div className="indicators-menu indicators-menu--sheet">{indicatorsList}</div>
              </div>
            )}
          </div>

          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("interval")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--interval">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3.5 2" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.interval", "Interval")}</span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.interval ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.interval && (
              <div className="fs-dock-category-body">
                <div className="interval-sheet-list">
                  {INTERVALS.map((opt) => {
                    const needsPro = PRO_INTERVALS.has(opt);
                    const locked = needsPro && !isPaid;
                    const trend = trends[opt];
                    return (
                      <button
                        type="button"
                        key={opt}
                        className={`interval-sheet-item${interval === opt ? " interval-sheet-item--active" : ""}${locked ? " interval-sheet-item--locked" : ""}`}
                        onClick={() => {
                          if (locked) { onOpenUpgrade?.("pro"); return; }
                          setInterval(opt);
                        }}
                      >
                        <span className="interval-sheet-item-label">
                          {INTERVAL_LABELS[opt]}
                          {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                            : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                            : null}
                        </span>
                        {locked ? <span className="interval-sheet-item-pro">PRO</span>
                          : interval === opt ? <span className="interval-sheet-item-check">✓</span>
                          : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

        </div>
      )}
    </div>,
    document.body,
  );

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
              {/* Fullscreen (mobile/iOS and desktop alike): exchange-style
                  stats grid (High/Low · Bid/Ask · Vol) + price/change
                  line, replacing the name/LIVE/zone-signal/div-badge row
                  entirely — picked over the badge-based header directions
                  above. Only normal (non-fullscreen) mobile/desktop keep
                  the original title row below/further down. */}
              {isFullscreen ? (() => {
                // "Minimal Header" layout — single compact coin+price row,
                // High/Low/Vol/Signal collapsed into one tappable strip
                // instead of sitting permanently expanded. Style/
                // Indicators/Interval live in the persistent docked sheet
                // instead (fsDockSheet, portaled to document.body).
                return (
                <div className="chart-fs-header-block">
                  <div className="chart-fs-compact-row">
                    <span
                      className="chart-fs-coin-avatar"
                      style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                    >
                      {COIN_GLYPHS[coin] ?? coin[0]}
                    </span>
                    <h3
                      className="chart-fs-coin-name chart-fs-coin-name--compact chart-title-tappable"
                      onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                    >
                      {t("chart.title", { coin: COIN_FULL_NAME[coin] ?? coin })}
                      <svg className="chart-title-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </h3>
                    {currentPrice !== null && (
                      <span
                        className={`chart-current-price chart-fs-compact-price${priceDirection ? ` chart-current-price--${priceDirection}` : ""}`}
                      >
                        {formatLivePrice(currentPrice)}
                      </span>
                    )}
                    {dayChangeAbs !== null && dayChangePercent !== null && (
                      <span
                        className={`chart-fs-price-change chart-fs-compact-change${dayChangePercent >= 0 ? " chart-fs-price-change--up" : " chart-fs-price-change--down"}`}
                      >
                        {dayChangePercent >= 0 ? "+" : ""}{dayChangePercent.toFixed(2)}%
                      </span>
                    )}
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="chart-fs-exit-corner-btn"
                      onClick={toggleFullscreen}
                      title="Exit fullscreen"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <button
                    type="button"
                    className="chart-fs-stats-strip"
                    onClick={() => setFsStatsExpanded((v) => !v)}
                  >
                    <span className="chart-fs-strip-item">{t("chart.high", "High")} <b className="chart-fs-strip-up">{dayHigh !== null ? formatLivePrice(dayHigh) : "—"}</b></span>
                    <span className="chart-fs-strip-item">{t("chart.low", "Low")} <b className="chart-fs-strip-down">{dayLow !== null ? formatLivePrice(dayLow) : "—"}</b></span>
                    <span className="chart-fs-strip-item">{t("chart.volUsd", "Vol (USD)")} <b>{quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</b></span>
                    {isPaid && fsSignalBucket && (
                      <span className={`chart-fs-strip-signal chart-fs-strip-signal--${fsSignalBucket}`}>{fsSignalLabel}</span>
                    )}
                    <div style={{ flex: 1 }} />
                    <svg className="chart-fs-strip-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: fsStatsExpanded ? "rotate(180deg)" : "rotate(0deg)" }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {fsStatsExpanded && (
                  <div className="chart-fs-info-row">
                  <div className="chart-fs-stats-grid">
                    <div className="chart-fs-stat-col">
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("chart.bid", "Bid")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--up">
                          {bidPrice !== null ? formatLivePrice(bidPrice) : "—"}
                        </span>
                      </div>
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("chart.ask", "Ask")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--down">
                          {askPrice !== null ? formatLivePrice(askPrice) : "—"}
                        </span>
                      </div>
                    </div>
                    <div className="chart-fs-stat-col chart-fs-stat-col--right">
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("chart.volCoin", "Vol ({{coin}})", { coin })}</span>
                        <span className="chart-fs-stat-value">
                          {baseVolume24h !== null ? formatCompactVolume(baseVolume24h) : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                  {zone && isPaid && fsSignalBucket && (
                    <div className="chart-fs-meter">
                      <span className="chart-fs-meter-label">{t("chart.signal", "Signal")}</span>
                      <div className="chart-fs-meter-row">
                        <span className="chart-fs-meter-track">
                          <span
                            className={`chart-fs-meter-dot chart-fs-meter-dot--${fsSignalBucket}`}
                            style={{ left: `${fsSignalPct}%` }}
                          />
                        </span>
                        <span className={`chart-fs-meter-value chart-fs-meter-value--${fsSignalBucket}`}>{fsSignalLabel}</span>
                      </div>
                    </div>
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
                  {isPaid && (
                    <div className="chart-fs-meter">
                      <span className="chart-fs-meter-label">{t("chart.divergence", "Div")}</span>
                      <div className="chart-fs-meter-row">
                        <span className="chart-fs-meter-track chart-fs-meter-track--rev">
                          <span
                            className={`chart-fs-meter-dot chart-fs-meter-dot--${fsDivDotBucket}`}
                            style={{ left: `${fsDivPct}%` }}
                          />
                        </span>
                        <span className={`chart-fs-meter-value chart-fs-meter-value--${fsDivDotBucket}`}>{fsDivLabel}</span>
                      </div>
                    </div>
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
                  )}
                </div>
                );
              })() : !isDesktopWidth ? (
                <div className="chart-fs-header-block">
                  <div className="chart-title-row">
                    <h3
                      className="chart-title-tappable"
                      onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                    >
                      {t("chart.title", { coin: COIN_FULL_NAME[coin] ?? coin })}
                      <svg className="chart-title-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </h3>
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
                  {dayHigh !== null && dayLow !== null && (
                    <div className="chart-fs-stat-col chart-fs-stat-col--row">
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("chart.high", "High")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--up">{formatLivePrice(dayHigh)}</span>
                      </div>
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("chart.low", "Low")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--down">{formatLivePrice(dayLow)}</span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                <div className="chart-title-row">
                  <h3>{t("chart.title", { coin: COIN_FULL_NAME[coin] ?? coin })}</h3>
                  {isFullscreen && currentPrice !== null && (
                    <span className="chart-current-price-group">
                      <span
                        className={`chart-current-price${priceDirection ? ` chart-current-price--${priceDirection}` : ""}`}
                      >
                        {formatLivePrice(currentPrice)}
                      </span>
                      <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
                    </span>
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
                {dayHigh !== null && dayLow !== null && (
                  <div className="chart-fs-stat-col chart-fs-stat-col--row">
                    <div className="chart-fs-stat-row">
                      <span className="chart-fs-stat-label">{t("chart.high", "High")}</span>
                      <span className="chart-fs-stat-value chart-fs-stat-value--up">{formatLivePrice(dayHigh)}</span>
                    </div>
                    <div className="chart-fs-stat-row">
                      <span className="chart-fs-stat-label">{t("chart.low", "Low")}</span>
                      <span className="chart-fs-stat-value chart-fs-stat-value--down">{formatLivePrice(dayLow)}</span>
                    </div>
                  </div>
                )}
                </>
              )}
              {!isFullscreen && currentPrice !== null && (
                <div className="chart-mobile-price-row" ref={mobilePriceRowRef}>
                  <span
                    className={`chart-mobile-price${priceDirection ? ` chart-mobile-price--${priceDirection}` : ""}`}
                  >
                    {formatLivePrice(currentPrice)}
                  </span>
                  {dayChangePercent !== null && dayChangeAbs !== null && (
                    <span
                      className={`chart-mobile-price-change chart-mobile-price-change--${dayChangePercent >= 0 ? "up" : "down"}`}
                    >
                      <span className="chart-mobile-price-change-arrow">
                        {dayChangePercent >= 0 ? "↗" : "↘"}
                      </span>
                      {formatLivePrice(Math.abs(dayChangeAbs))} ({Math.abs(dayChangePercent).toFixed(2)}%)
                      <span className="chart-mobile-price-change-period">
                        {HL_WINDOW_LABEL[interval]}
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>
            {!isFullscreen && (
              <div className="chart-header-right">
                {mobileStatsBlock}
              </div>
            )}
          </div>

        </div>

        {banner && isPaid && !isFullscreen && (
          <div
            className={`interval-banner interval-banner--${banner.sentiment}`}
          >
            <div className="interval-banner-header">
              <span className="interval-banner-title pi-fade-in">{banner.title}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {bannerAt !== null && (
                  <span className="pattern-insight-updated">
                    {t("chart.lastUpdated", "Updated")} {formatClockTime(bannerAt)}
                  </span>
                )}
                <span style={{ display: "flex", alignItems: "center", gap: 0 }}>
                  <span className="aiqw-live-badge">
                    <span className="aiqw-live-dot" />
                    LIVE
                  </span>
                  <span className="pattern-insight-ai-badge pattern-insight-ai-badge--pill">
                    {t("chart.aiPowered")}
                  </span>
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
          // This onDoubleClick prop only ever worked on web — native
          // dblclick synthesis from two touches is unreliable on iOS, which
          // is why it's left disabled here rather than firing unreliably.
          // iOS gets the real double-tap-to-enter/exit via the manual
          // touch-timing detector above instead (see dblClickWrapRef's
          // effect) — plus an explicit Full Screen button as a visible
          // affordance for anyone who doesn't discover the gesture.
          onDoubleClick={
            Capacitor.isNativePlatform() && !isFullscreen ? undefined : toggleFullscreen
          }
          className={`chart-dblclick-wrap${
            Capacitor.isNativePlatform() && !isFullscreen ? " chart-dblclick-wrap--no-hint" : ""
          }${
            Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" && !isFullscreen ? " chart-dblclick-wrap--ios-bleed" : ""
          }`}
          ref={dblClickWrapRef}
        >
            <div className={`chart-legend-actions${Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios" ? " chart-legend-actions--ios" : ""}`}>
              {/* Chart style/Interval/Indicators — every compact view
                  (mobile/iOS and desktop alike) plus desktop fullscreen,
                  each opening its own dropdown there; mobile fullscreen
                  still uses the "Chart Settings" dock instead
                  (fsDockSheet below). */}
              {(!isFullscreen || isDesktopWidth) && gridStyleControls}
              {(!isFullscreen || isDesktopWidth) && fsIntervalButton}
              {(!isFullscreen || isDesktopWidth) && indicatorsControl}
              <span className="chart-legend-actions-group--right" />
              {/* Grid is already inside the dock's Style category too —
                  no separate standalone button in fullscreen. */}
              {!isFullscreen && gridToggleButton}
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
                data-tooltip={showDepthProfile ? "Hide depth profile" : "Show depth profile"}
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
              {/* Hidden for now — button removed, but showAstroChart/
                  AstroSuggestions render logic below is untouched so this
                  is a one-line revert (just uncomment) whenever it comes
                  back. */}
              {false && (
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
              )}
              {((Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") || (!Capacitor.isNativePlatform() && isDesktopWidth)) && (
                <button
                  className="chart-depth-btn"
                  onClick={() => {
                    if (!isPaid) { onOpenUpgrade?.("pro"); return; }
                    setShowCompactView(true);
                  }}
                  title={t("chart.compactView", "Compact View")}
                  data-tooltip={t("chart.compactView", "Compact View")}
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
                    <path d="M3 12h4M17 12h4M12 3v4M12 17v4" />
                    <circle cx="12" cy="12" r="4" />
                  </svg>
                  <span className="chart-icon-label">{t("chart.compactView", "Compact View")}</span>
                </button>
              )}
              {onToggleCoinChat && Capacitor.getPlatform() !== "ios" && (
                <button
                  className={`chart-livechat-pill${coinChatOpen ? " chart-livechat-pill--active" : ""}`}
                  onClick={onToggleCoinChat}
                  title={coinChatOpen ? t("coinChat.hide", "Hide chat") : t("coinChat.triggerLabel")}
                  data-tooltip={coinChatOpen ? t("coinChat.hide", "Hide chat") : t("coinChat.triggerLabel")}
                >
                  {coinChatOpen ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  ) : (
                    <span className="chart-livechat-dot" />
                  )}
                  {t("coinChat.triggerLabel")}
                </button>
              )}
              {/* Desktop fullscreen only — compact view already has its
                  own Grid button earlier in this row; mobile fullscreen
                  still covers Grid via the dock's Style category. */}
              {isFullscreen && isDesktopWidth && gridToggleButton}
              {/* Save joins this row everywhere (compact and fullscreen,
                  mobile/iOS and desktop alike); Reset only in fullscreen
                  (it has no non-fullscreen equivalent). The old floating
                  top-left buttons (.chart-reset-view-btn/.chart-save-
                  view-btn) are hidden unconditionally now — see below —
                  since every platform uses this icon row instead. */}
              <button
                type="button"
                className={`chart-depth-btn chart-fs-save-btn${!isDesktopWidth ? " chart-fs-save-btn--ios-push-right" : ""}`}
                onClick={handleScreenshot}
                title={t("chart.save")}
                data-tooltip={t("chart.save")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span className="chart-icon-label">{t("chart.save")}</span>
              </button>
              {isFullscreen && (
                <button
                  type="button"
                  className="chart-depth-btn chart-fs-reset-btn"
                  onClick={() => {
                    chartRef.current?.timeScale().fitContent();
                    rsiChartRef.current?.timeScale().fitContent();
                    macdChartRef.current?.timeScale().fitContent();
                  }}
                  title={t("chart.reset")}
                  data-tooltip={t("chart.reset")}
                >
                  <span aria-hidden="true">⤢</span>
                  <span className="chart-icon-label">{t("chart.reset")}</span>
                </button>
              )}
              <button
                type="button"
                className="chart-depth-btn chart-fullscreen-btn"
                onClick={toggleFullscreen}
                title={t("chart.fullscreen", "Fullscreen")}
                data-tooltip={t("chart.fullscreen", "Fullscreen")}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
                </svg>
                <span className="chart-icon-label">{t("chart.fullscreen", "Fullscreen")}</span>
              </button>
            </div>
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
              height: isFullscreen ? "calc(100vh - 200px)" : "400px",
            }}
          />
          <PredictionOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            prediction={predictionPath}
          />
          <LineDotFillOverlay
            chartRef={chartRef}
            seriesRef={lineCloseRef}
            candlesRef={lastCandlesRef}
            color={lineTrendColor}
            generation={chartGeneration}
            visible={!isFullscreen && chartStyle === "line"}
          />
          <ChartEventAnnotations
            chartRef={chartRef}
            seriesRef={chartStyle === "line" ? lineCloseRef : candleRef}
            candlesRef={lastCandlesRef}
            srLevels={srLevels}
            zone={zone}
            coin={coin}
            visible={!isFullscreen && !isDesktopWidth}
            cardsSlotRef={eventCardsSlotRef}
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
            className="chart-reset-view-btn chart-save-view-btn"
            onClick={handleScreenshot}
            title="Save chart as PNG"
          >
            {t("chart.save")}
          </button>
          {/* iOS-only entry point for fullscreen, since double-tap no
              longer does it there (see .chart-dblclick-wrap above) — lands
              in the same slot Reset uses in fullscreen (top:38px, via the
              shared :not(.chart-save-view-btn) selector) since the two
              never show at the same time. */}
          {Capacitor.isNativePlatform() && !isFullscreen && (
            <button
              className="chart-reset-view-btn chart-ios-fullscreen-btn"
              onClick={toggleFullscreen}
              title="Fullscreen"
            >
              Full Screen
            </button>
          )}
          {/* Fullscreen only — compact view relies entirely on
              double-click/double-tap (.chart-dblclick-wrap) to expand.
              Exit moved into the title row itself (chart-fs-coin-row,
              above) so it's pixel-aligned with the title instead of
              approximated via position:fixed + safe-area-inset guesswork
              — the header isn't sticky anymore so there was no longer any
              reason for Exit to float independently of it either. */}
          {isFullscreen && (
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
          )}
          {isFullscreen && (
            <div className="chart-zone-btn-row">
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
              {hasZone && (
                <button
                  className="chart-clear-zone-btn"
                  onClick={handleClearZone}
                  title="Clear the drawn zone"
                >
                  <span className="chart-clear-zone-btn__icon">✕</span>
                  <span className="chart-clear-zone-btn__label">Clear</span>
                </button>
              )}
            </div>
          )}
        </div>

        <div ref={eventCardsSlotRef} />

        {fsDockSheet}
        {intervalSheetPortal}

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

        {isFullscreen ? null : !isPaid ? (
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
                {patternInsightAt !== null && (
                  <span className="pattern-insight-updated">
                    {t("chart.lastUpdated", "Updated")} {formatClockTime(patternInsightAt)}
                  </span>
                )}
                <span style={{ display: "flex", alignItems: "center", gap: 0 }}>
                  <span className="aiqw-live-badge">
                    <span className="aiqw-live-dot" />
                    LIVE
                  </span>
                  <span className="pattern-insight-ai-badge pattern-insight-ai-badge--pill">
                    {t("chart.aiPowered")}
                  </span>
                </span>
              </div>
            </div>
            <div className="pattern-insight-body-scroll">
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

      {showCompactView && (
        <CompactPriceView coin={coin} theme={theme} onClose={() => setShowCompactView(false)} />
      )}
    </div>
  );
};
