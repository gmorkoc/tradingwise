import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
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
  LineStyle,
  PriceScaleMode,
} from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol, COINS, getTickerSnapshot } from "../services/coinglass";
import { fetchCoinMeta, fetchOpenInterestCoins, CoinMeta } from "../services/coinMeta";
import { ZoneResult, ZoneSignal } from "./PriceChart.types";
import SignalIndicator from "./SignalIndicator";
import {
  getCandlePatternAnalysis,
  CandlePatternResult,
  ChartPrediction,
  getZoneAnalysis,
  ZoneAnalysisResult,
} from "../services/openai";
import { PredictionOverlay, PredictionPath, LineDotFillOverlay, RoundedCandleOverlay } from "./DrawingOverlay";
import { ChartEventAnnotations, ChartEvent } from "./ChartEventAnnotations";
import { OrderBookProfileModal } from "./OrderBookProfile";
import { PredictionModal } from "./PredictionModal";
import { ChartDrawingTools, Drawing, ChartDrawingToolsHandle } from "./ChartDrawingTools";
import { ZoneAnalysisModal } from "./ZoneAnalysisModal";
import { ChartGoTo } from "./ChartGoTo";
import { analyseLiquidations, LEVERAGES_ALL } from "../utils/liquidationClusters";
import { AstroSuggestions } from "./AstroSuggestions";
import { CompactPriceView } from "./CompactPriceView";
import { useAIQuota } from "../hooks/useAIQuota";
import { supabase } from "../services/supabase";
import "../styles/PriceChart.css";

export type TimeInterval =
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
export type ChartStyle = "candle" | "hollow" | "line" | "heikinAshi";
const CHART_STYLE_LABELS: Record<ChartStyle, string> = {
  candle: "Candle",
  hollow: "Hollow Candle",
  line: "Line",
  heikinAshi: "Heikin Ashi",
};
export const CHART_STYLE_ICONS: Record<ChartStyle, JSX.Element> = {
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
  // Direct jump to one of the top-5-by-market-cap coins shown next to the
  // selector (chart-hero-top-coins below) — skips the full picker modal,
  // same shortcut Watchlist/TopMoversCarousel's own onSelectCoin already
  // gives from further down this same page.
  onSelectCoin?: (symbol: string) => void;
  onFullscreenChange?: (isFullscreen: boolean) => void;
  coinChatOpen?: boolean;
  onToggleCoinChat?: () => void;
  // Standalone "Advance Price Chart" page instance — permanently
  // fullscreen-rendered, independent mount from the compact chart card.
  // See toggleFullscreen below for how these replace the old local-overlay
  // enter/exit behavior.
  pageMode?: boolean;
  onNavigateToPage?: () => void;
  onNavigateBack?: () => void;
  // MobileSymbolSheet.tsx — lets an external interval row (built outside
  // this component, against its own simpler reference-match label set)
  // drive this chart's real interval instead of duplicating candle-fetch/
  // indicator logic in a second chart implementation. One-way: setting
  // requestInterval pushes it into this component's own internal
  // `interval` state (below); onIntervalChange reports every change
  // (external or from this component's own UI) back out so the caller's
  // row can highlight the active one. Both optional — every other call
  // site is unaffected.
  requestInterval?: TimeInterval;
  onIntervalChange?: (interval: TimeInterval) => void;
  // Same controlled pattern as requestInterval/onIntervalChange, for the
  // candle-style toggle only — MobileSymbolSheet.tsx deliberately exposes
  // nothing for indicators/grid (never mirrors indicatorsList/
  // gridStyleControls out), so there's no way for that sheet to show
  // either regardless of what's added here later.
  requestChartStyle?: ChartStyle;
  onChartStyleChange?: (style: ChartStyle) => void;
  // MobileSymbolSheet.tsx — every indicator/overlay toggle is a shared,
  // persisted (readChartPrefs/localStorage) preference across every
  // PriceChart instance app-wide, so simply not rendering this
  // component's own Indicators menu (that sheet never does) isn't enough
  // — whatever the user last turned on elsewhere would still draw on this
  // embedded chart. This forces every one of them off for just this
  // instance, once, without touching the saved preference other
  // instances still read.
  forceHideIndicators?: boolean;
  // MobileSymbolSheet.tsx again — this sheet builds its own coin/price/
  // change header and its own interval row (mss-interval-row) above/below
  // this embedded compact <PriceChart>, so this instance's own header
  // (hero id/price row, Full/Compact switch, interval pills + fullscreen)
  // would just duplicate what the sheet already shows. Every OTHER
  // <PriceChart> instance (the plain #chart page, pageMode) still renders
  // its own header as normal — this only suppresses it for this one embed.
  forceHideHeader?: boolean;
  // OrderFlowPanel.tsx's "Today's Story" feed (App.tsx) — App.tsx has no
  // other way to reach the candles/srLevels/zone state ChartEventAnnotations
  // already computes these from internally.
  onChartEventsChange?: (events: ChartEvent[]) => void;
  // Rendered inside .price-chart-container itself (below the chart, outside
  // the fullscreen/scroll wrapper) — App.tsx uses this for Watchlist/
  // TopMoversCarousel so they visually live inside this card instead of as
  // separate full-width blocks below it.
  children?: React.ReactNode;
  // App.tsx's own .mch-stats (LIQ above/below, Open Interest, Funding,
  // RSI/MACD/L-S ratio) — same composition pattern as `children` above,
  // just rendered inside .chart-fs-header-group instead of below the whole
  // card, so it reads as part of the chart's own header instead of a
  // separate top-level bar. Already collapsed to nothing in pageMode via
  // that group's own chart-fs-header-group--empty modifier, so this never
  // needs its own pageMode check here.
  headerStats?: React.ReactNode;
  // Optional column rendered inside .price-chart-container, to the right of
  // the chart (header, canvas, range bar, AI read) — App.tsx's Order Book /
  // Order Flow column. Not shown in fullscreen. `children` still runs full
  // width below both.
  sideColumn?: React.ReactNode;
}

export const INTERVALS: TimeInterval[] = [
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

export const INTERVAL_SHORT: Record<TimeInterval, string> = {
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

// Live clock for the right end of the range bar ("14:01:15 (UTC-4)").
// Its own component so the once-a-second tick only re-renders this span,
// not the whole chart.
function RangeBarClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const off = -now.getTimezoneOffset();
  const h = Math.trunc(off / 60);
  const m = Math.abs(off % 60);
  const utc = `UTC${off === 0 ? "" : h > 0 ? `+${h}` : `${h}`}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  return <span className="chart-range-clock">{time} ({utc})</span>;
}

// Range presets for the bar under the chart (TradingView-style): each one
// picks a candle interval AND zooms to that much history.
const RANGE_PRESETS: { key: string; label: string; interval: TimeInterval; seconds: number; tip: string }[] = [
  { key: "1h", label: "1h", interval: "5min", seconds: 60 * 60, tip: "1 hour in 5 minute intervals" },
  { key: "4h", label: "4h", interval: "15min", seconds: 4 * 60 * 60, tip: "4 hours in 15 minute intervals" },
  { key: "1d", label: "1d", interval: "1h", seconds: 24 * 60 * 60, tip: "1 day in 1 hour intervals" },
  { key: "1w", label: "1w", interval: "4h", seconds: 7 * 24 * 60 * 60, tip: "1 week in 4 hour intervals" },
  { key: "1m", label: "1m", interval: "1day", seconds: 30 * 24 * 60 * 60, tip: "1 month in 1 day intervals" },
  { key: "1y", label: "1y", interval: "1week", seconds: 365 * 24 * 60 * 60, tip: "1 year in 1 week intervals" },
];

// Full coin name for the chart title ("Bitcoin" rather than "BTC") — COINS
// already carries this (services/coinglass.ts), just keyed by symbol here
// for an O(1) lookup instead of re-scanning the array on every render.
export const COIN_FULL_NAME: Record<string, string> = Object.fromEntries(
  COINS.map((c) => [c.symbol, c.name]),
);

// Coin avatar (mobile header, right column) — glyph + brand color per
// coin, same glyph set App.tsx/GlobalSearch.tsx/PriceTickerFullscreen.tsx
// each keep their own copy of rather than sharing.
export const COIN_GLYPHS: Record<string, string> = {
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
export const COIN_COLORS: Record<string, string> = {
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
// COINS (coinglass.ts) is already ordered by market cap — the first 5
// entries, in order, are the top 5. Next to the coin selector, overlapping
// avatar-stack style (chart-hero-top-coins below).
const TOP5_COINS = COINS.slice(0, 5).map((c) => c.symbol);

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

// Reference-match compact axis labels ("92k" instead of "92000.00") —
// desktop non-fullscreen only, wired through createChart's own
// localization.priceFormatter below.
function formatCompactAxisPrice(p: number): string {
  if (p >= 1000) {
    const k = p / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  if (p >= 1) return p.toFixed(2);
  return p.toFixed(6);
}

// Advance Price Chart page, mobile — tap feedback on the dock's toggles
// (sheet expand/collapse, Toolbox), Close, indicator checkboxes, and
// candle taps. No-op on web/desktop, where this plugin isn't meaningful
// (and may not be present). Medium rather than Light — Light was hard to
// feel reliably on-device.
function hapticTap() {
  if (Capacitor.isNativePlatform()) {
    Haptics.impact({ style: ImpactStyle.Medium }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[hapticTap] Haptics.impact failed:", e);
    });
  }
}

export function formatCompactVolume(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

// Same compact scale as formatCompactVolume, no $ prefix — for coin-unit
// quantities (circulating/total supply) rather than USD amounts.
export function formatCompactNumber(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
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

// ── Chart candle cache ──────────────────────────────────────────────────────
// Last real candle set fetched for a coin/interval, persisted across page
// loads/refreshes. On the very first load there's no in-memory stale data
// to blur the way a coin switch has (see hasLoadedOnce) — this gives the
// first-load placeholder the user's own actual last-seen chart (real
// price scale and shape) instead of an arbitrary hardcoded sawtooth, so
// it reads as "the chart, blurred" rather than visibly fake numbers.
// Capped to the most recent 150 candles — plenty for a placeholder shape,
// far smaller than a full history for localStorage's quota.
function chartCandleCacheKey(coin: string, interval: string) {
  return `chart_candles_${coin}_${interval}`;
}
function readChartCandleCache(
  coin: string,
  interval: string,
): CandleDataPoint[] | null {
  try {
    const r = localStorage.getItem(chartCandleCacheKey(coin, interval));
    if (!r) return null;
    const parsed = JSON.parse(r);
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as CandleDataPoint[])
      : null;
  } catch {
    return null;
  }
}
function writeChartCandleCache(
  coin: string,
  interval: string,
  data: CandleDataPoint[],
) {
  try {
    localStorage.setItem(
      chartCandleCacheKey(coin, interval),
      JSON.stringify(data.slice(-150)),
    );
  } catch {}
}

// ── Chart preferences (indicators/grid/candle style) ────────────────────────
// Global, not per-coin/interval (unlike the candle/pattern caches above) —
// these are display preferences the user set up once and expects every
// chart load to just remember, same as any other app setting.
const CHART_PREFS_KEY = "chart_prefs_v1";
interface ChartPrefs {
  showBB?: boolean;
  showRSI?: boolean;
  showMACD?: boolean;
  showEMA20?: boolean;
  showEMA50?: boolean;
  showEMA200?: boolean;
  showMA20?: boolean;
  showMA50?: boolean;
  showMA200?: boolean;
  showFib?: boolean;
  showSR?: boolean;
  showZones?: boolean;
  showDayHL?: boolean;
  showCME?: boolean;
  showGrid?: boolean;
  chartStyle?: ChartStyle;
}
function readChartPrefs(): ChartPrefs {
  try {
    const r = localStorage.getItem(CHART_PREFS_KEY);
    return r ? (JSON.parse(r) as ChartPrefs) : {};
  } catch {
    return {};
  }
}
function writeChartPrefs(prefs: ChartPrefs) {
  try {
    localStorage.setItem(CHART_PREFS_KEY, JSON.stringify(prefs));
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

// Most candle sequences don't match any of detectCandlePattern's named
// three-candle setups — that's normal, not a failure. Previously this just
// meant `null` all the way through, which read as "pattern-insight is
// broken" whenever the AI call on top of it was also unavailable (quota
// exhausted on a lower tier, or the call failed/is still pending): a paid
// user who'd already cleared the isPaid paywall gate got a blank gap
// instead of any analysis at all. This gives them the same trend read the
// interval banner already computed, in pattern-insight's own voice,
// instead of nothing — AI still overwrites it when it succeeds (see the
// getCandlePatternAnalysis call site), this is just what's always there
// underneath that.
function fallbackPatternInsight(
  bannerSentiment: "bullish" | "bearish" | "neutral" | null,
): PatternInsight {
  if (bannerSentiment === "bullish") {
    return {
      name: "No Named Pattern — Trend Intact",
      type: "bullish",
      summary: "No classic candlestick formation in the last few candles, but the broader trend remains bullish.",
      narrative: "There's no textbook three-candle setup right now, but price structure still favors buyers overall. No named pattern doesn't mean no direction — the underlying trend is doing the talking here.",
      nextMove: "Stay aligned with the trend rather than waiting for a specific pattern to appear. A pullback to support is a reasonable area to watch for continuation.",
    };
  }
  if (bannerSentiment === "bearish") {
    return {
      name: "No Named Pattern — Trend Intact",
      type: "bearish",
      summary: "No classic candlestick formation in the last few candles, but the broader trend remains bearish.",
      narrative: "There's no textbook three-candle setup right now, but price structure still favors sellers overall. No named pattern doesn't mean no direction — the underlying trend is doing the talking here.",
      nextMove: "Stay aligned with the trend rather than waiting for a specific pattern to appear. A bounce into resistance is a reasonable area to watch for continuation lower.",
    };
  }
  return {
    name: "No Clear Pattern",
    type: "neutral",
    summary: "No classic candlestick formation detected, and the broader trend is flat right now.",
    narrative: "Price action lacks both a textbook pattern and a clear directional bias at the moment — this usually means the market is consolidating before its next real move.",
    nextMove: "Wait for either a recognizable pattern or a decisive break from this range before leaning into a direction.",
  };
}

// Applies overall-trend context so the pattern and banner never contradict.
// If the detected pattern is bullish but the interval is in a downtrend
// (or vice versa), the type is softened to "neutral" and the nextMove note
// is prefixed with a counter-trend warning.
function trendAwarePattern(
  candles: CandleDataPoint[],
  bannerSentiment: "bullish" | "bearish" | "neutral" | null,
): PatternInsight {
  const result = detectCandlePattern(candles);
  if (!result) return fallbackPatternInsight(bannerSentiment);
  if (!bannerSentiment || bannerSentiment === "neutral") return result;

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

// A hardcoded placeholder chart drawn into the real candle/line/volume
// series on first page load/refresh only (see hasLoadedOnce) — there's no
// real stale data yet to blur the way a later coin/interval switch has,
// so this fills the canvas with a plausible-looking shape purely so
// there's something present to blur instead of an empty box. Gets
// overwritten by redrawCandleSeries(data) the instant the real fetch
// resolves.
function makeFakeFirstLoadCandles(): CandleDataPoint[] {
  const closes = [
    100, 102, 101, 104, 103, 106, 105, 108, 107, 110, 109, 112, 111, 114, 113,
    116, 115, 118, 117, 120, 119, 122, 121, 124, 123, 126, 125, 128, 127, 130,
  ];
  const now = Math.floor(Date.now() / 1000);
  const step = 3600;
  return closes.map((close, i) => {
    const open = i === 0 ? close - 1 : closes[i - 1];
    const high = Math.max(open, close) + 1;
    const low = Math.min(open, close) - 1;
    return {
      time: now - (closes.length - i) * step,
      open,
      high,
      low,
      close,
      volume: 50 + ((i * 37) % 60),
    };
  });
}

// Advance Price Chart page, mobile dock — "Option A: sliding highlight"
// (user-approved sketch) for a single-select picker expanded inline in its
// own quick-row button: one continuous track, no per-chip border/fill —
// a single rounded highlight slides to sit behind whichever option is
// active. Only fits single-select (Interval, Style); Indicators is
// multi-select and keeps its own per-chip highlighted-dot style instead,
// since there's no one position a single highlight could represent.
function FsSlidingOptions({
  options,
}: {
  options: Array<{ key: string; label: React.ReactNode; active: boolean; locked?: boolean; ariaLabel?: string; onClick: () => void }>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [highlight, setHighlight] = useState<{ left: number; width: number } | null>(null);
  const activeKey = options.find((o) => o.active)?.key;

  const measure = useCallback(() => {
    const el = activeKey != null ? itemRefs.current[activeKey] : null;
    const track = trackRef.current;
    if (!el) { setHighlight(null); return; }
    setHighlight({ left: el.offsetLeft, width: el.offsetWidth });
    // scrollIntoView's own inline:"center" is unreliable in WKWebView —
    // compute the centered scrollLeft by hand instead, same math.
    if (track) {
      track.scrollLeft = el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2;
    }
  }, [activeKey]);

  useLayoutEffect(() => {
    measure();
  }, [measure, options.length]);

  // The track sits inside the quick-row button that's mid flex-grow
  // transition (34px -> full width) the first time this item is the
  // default-expanded one on page load — measuring once on mount can
  // catch it before that animation settles, landing the highlight at a
  // stale/incorrect position. A ResizeObserver re-measures on every
  // frame the track's own box actually changes size, so it always
  // converges on the correct final position once the transition ends.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    // Re-center too, not just re-highlight — ResizeObserver only ever
    // fires from the track's own box actually changing size (the open
    // animation finishing, an orientation change), never from scrolling
    // it, so this can't fight a user's own horizontal swipe.
    const ro = new ResizeObserver(() => measure());
    ro.observe(track);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div className="fs-dock-slide-track" ref={trackRef}>
      {highlight && (
        <span
          className="fs-dock-slide-highlight"
          style={{ transform: `translateX(${highlight.left}px)`, width: highlight.width }}
        />
      )}
      {options.map((opt) => (
        <button
          type="button"
          key={opt.key}
          ref={(el) => { itemRefs.current[opt.key] = el; }}
          className={`fs-dock-slide-item${opt.active ? " fs-dock-slide-item--active" : ""}${opt.locked ? " fs-dock-slide-item--locked" : ""}`}
          onClick={opt.onClick}
          aria-label={opt.ariaLabel}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
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
  onSelectCoin,
  onFullscreenChange,
  coinChatOpen,
  onToggleCoinChat,
  pageMode,
  onNavigateToPage,
  onNavigateBack,
  requestInterval,
  onIntervalChange,
  requestChartStyle,
  onChartStyleChange,
  forceHideIndicators,
  forceHideHeader,
  onChartEventsChange,
  children,
  sideColumn,
  headerStats,
}) => {
  const { t, i18n } = useTranslation();
  const { exceeded, consume, isPaid } = useAIQuota();
  // AI chart read (trend + pattern card under the chart) is on request:
  // hidden behind an "Analyze" button until asked for. Stays open across
  // coin/interval switches for the session once opened.
  const [aiReadOpen, setAiReadOpen] = useState(false);
  const aiReadOpenRef = useRef(false);
  aiReadOpenRef.current = aiReadOpen;
  // Latest-closure ref so the chart load effect always calls the current
  // coin/interval/quota version.
  const runPatternAIRef = useRef<(candles: CandleDataPoint[]) => void>(() => {});
  runPatternAIRef.current = (candles: CandleDataPoint[]) => {
    if (exceeded || candles.length === 0) return;
    const c = coin;
    const iv = interval;
    consume().then((ok) => {
      if (!ok) return;
      getCandlePatternAnalysis(c, iv, candles).then((res) => {
        if (res.success && res.result) {
          setPatternInsight(res.result);
          setPatternInsightAt(Date.now());
          writePatternCache(c, iv, res.result);
        }
      });
    });
  };
  const openAiRead = () => {
    setAiReadOpen(true);
    // Skip the AI call if this coin+interval already has a cached result.
    if (!readPatternCache(coin, interval)) runPatternAIRef.current(lastCandlesRef.current);
  };
  const isLight = theme === "light";

  const [interval, setInterval] = useState<TimeInterval>("1day");
  // Active range preset (bar under the chart). Only counts while the chart
  // is still on that preset's interval — picking another interval anywhere
  // else silently drops it back to that interval's normal default window.
  const [rangePreset, setRangePreset] = useState<string | null>(null);
  const activeRangePreset = RANGE_PRESETS.find((p) => p.key === rangePreset && p.interval === interval) ?? null;
  const rangeSecondsRef = useRef<{ interval: TimeInterval; seconds: number } | null>(null);
  rangeSecondsRef.current = activeRangePreset ? { interval: activeRangePreset.interval, seconds: activeRangePreset.seconds } : null;
  // Visible window for a fresh view: the active preset's span if any,
  // otherwise the interval's own default.
  const viewWindowFor = (iv: TimeInterval) =>
    rangeSecondsRef.current?.interval === iv ? rangeSecondsRef.current.seconds : INTERVAL_WINDOW[iv];
  // "Go to" dialog (calendar button in the range bar). A custom range that
  // needs a different interval is parked here and applied by the normal
  // load path once that interval's candles arrive.
  const [goToOpen, setGoToOpen] = useState(false);
  // Price scale toggles (right end of the range bar): % / log are mutually
  // exclusive modes (both off = normal), auto = price axis auto-fits the
  // visible candles. Persisted.
  const [scaleMode, setScaleMode] = useState<"normal" | "percent" | "log">(() => {
    try {
      const v = localStorage.getItem("chartScaleMode");
      return v === "percent" || v === "log" ? v : "normal";
    } catch { return "normal"; }
  });
  const [autoScale, setAutoScale] = useState(true);
  useEffect(() => {
    try { localStorage.setItem("chartScaleMode", scaleMode); } catch { /* ignore */ }
  }, [scaleMode]);
  const pendingRangeRef = useRef<{ interval: TimeInterval; from: number; to: number } | null>(null);
  const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  // Jump to one moment, keeping the current zoom level. Returns an error
  // message instead when it's older than what this interval has loaded.
  const goToDate = (ts: number): string | null => {
    const candles = lastCandlesRef.current;
    const ts0 = chartRef.current?.timeScale();
    if (!candles.length || !ts0) return "Chart data hasn't loaded yet.";
    const first = candles[0].time as number;
    const last = candles[candles.length - 1].time as number;
    if (ts < first) {
      return `This interval only goes back to ${fmtDay(first)}. Pick a later date, or switch to a bigger interval (e.g. 1D or 1W) to go further back.`;
    }
    const vr = ts0.getVisibleRange();
    const span = vr ? (vr.to as number) - (vr.from as number) : (INTERVAL_WINDOW[interval] ?? 7 * 86400);
    let from = ts - span / 2;
    let to = ts + span / 2;
    if (to > last) { from -= to - last; to = last; }
    setRangePreset(null);
    ts0.setVisibleRange({ from: Math.max(from, first) as UTCTimestamp, to: to as UTCTimestamp });
    return null;
  };
  // Show exactly from → to, picking a candle size that fits the span.
  const goToRange = (from: number, to: number): string | null => {
    const span = to - from;
    const iv: TimeInterval =
      span <= 6 * 3600 ? "5min"
      : span <= 2 * 86400 ? "15min"
      : span <= 10 * 86400 ? "1h"
      : span <= 60 * 86400 ? "4h"
      : span <= 2 * 365 * 86400 ? "1day"
      : "1week";
    setRangePreset(null);
    if (iv === interval) {
      const candles = lastCandlesRef.current;
      if (!candles.length) return "Chart data hasn't loaded yet.";
      const first = candles[0].time as number;
      const last = candles[candles.length - 1].time as number;
      if (to < first) return `This interval only goes back to ${fmtDay(first)}.`;
      chartRef.current?.timeScale().setVisibleRange({
        from: Math.max(from, first) as UTCTimestamp,
        to: Math.min(to, last) as UTCTimestamp,
      });
      return null;
    }
    pendingRangeRef.current = { interval: iv, from, to };
    setInterval(iv);
    return null;
  };
  useEffect(() => {
    if (requestInterval && requestInterval !== interval) setInterval(requestInterval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestInterval]);
  useEffect(() => {
    onIntervalChange?.(interval);
  }, [interval, onIntervalChange]);
  const [loading, setLoading] = useState(true);
  // True once the very first fetch has completed — distinguishes "first
  // page load/refresh" (nothing real to blur yet, so placeholder content
  // fills in below) from a later coin/interval switch (real stale content
  // already exists and blurs in place instead).
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  // coin/interval the last fetch actually ran for — lets the fetch effect
  // tell a real coin/interval switch (the user did something, blur-in-
  // place is the right feedback) apart from a same-coin/interval refresh
  // (refreshTrigger alone changed, the user did nothing — this should be
  // silent). Without this, every 30s background refresh (App.tsx's own
  // setInterval(fetchBTCData, 30000), unrelated to whichever chart
  // interval is selected) re-blurred the whole chart/stats for its full
  // fetch+recompute+redraw duration, which read as a freeze.
  const lastLoadedKeyRef = useRef<string | null>(null);
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
  // Lazy-initialized from localStorage (readChartPrefs, above) once per
  // mount — indicator/grid/candle-style choices persist across page loads
  // instead of resetting to off/"line" every time.
  const [showBB, setShowBB] = useState(() => readChartPrefs().showBB ?? false);
  const [showRSI, setShowRSI] = useState(() => readChartPrefs().showRSI ?? false);
  const [showMACD, setShowMACD] = useState(() => readChartPrefs().showMACD ?? false);
  const [showEMA20, setShowEMA20] = useState(() => readChartPrefs().showEMA20 ?? false);
  const [showEMA50, setShowEMA50] = useState(() => readChartPrefs().showEMA50 ?? false);
  const [showEMA200, setShowEMA200] = useState(() => readChartPrefs().showEMA200 ?? false);
  const [showMA20, setShowMA20] = useState(() => readChartPrefs().showMA20 ?? false);
  const [showMA50, setShowMA50] = useState(() => readChartPrefs().showMA50 ?? false);
  const [showMA200, setShowMA200] = useState(() => readChartPrefs().showMA200 ?? false);
  // setShowGann dropped — nothing can turn this on while the Gann Pivots
  // checkbox is commented out of the indicators menu above (user request);
  // restoring that checkbox should also restore the setter here.
  const [showGann] = useState(false);
  const [showFib, setShowFib] = useState(() => readChartPrefs().showFib ?? false);
  const [showSR, setShowSR] = useState(() => readChartPrefs().showSR ?? false);
  const [showZones, setShowZones] = useState(() => readChartPrefs().showZones ?? false);
  const [showDayHL, setShowDayHL] = useState(() => readChartPrefs().showDayHL ?? false);
  useEffect(() => {
    if (!forceHideIndicators) return;
    setShowBB(false); setShowRSI(false); setShowMACD(false);
    setShowEMA20(false); setShowEMA50(false); setShowEMA200(false);
    setShowMA20(false); setShowMA50(false); setShowMA200(false);
    setShowFib(false); setShowSR(false);
    setShowZones(false); setShowDayHL(false); setShowCME(false);
    setShowGrid(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceHideIndicators]);
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
  const [showCME, setShowCME] = useState(() => readChartPrefs().showCME ?? false);
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
  const [patternInsightSheetOpen, setPatternInsightSheetOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dayLineRefs = useRef<any[]>([]);

  const [showDepthProfile, setShowDepthProfile] = useState(false);
  // Manual toggle — defaults on for the Advance Price Chart page
  // (pageMode), off everywhere else (compact view, desktop fullscreen).
  // Advance Price Chart page — always starts with grid on, regardless of
  // the shared saved preference other chart instances read/write (a user
  // who turned grid off elsewhere shouldn't land here with it off too;
  // they can still toggle it back off here if they want, same as always).
  const [showGrid, setShowGrid] = useState(() => (pageMode ? true : readChartPrefs().showGrid ?? false));
  // "candle" default for a first-ever visit — reference-match request —
  // otherwise whatever the user last picked (readChartPrefs).
  const [chartStyle, setChartStyle] = useState<ChartStyle>(() => readChartPrefs().chartStyle ?? "candle");
  useEffect(() => {
    if (requestChartStyle && requestChartStyle !== chartStyle) setChartStyle(requestChartStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestChartStyle]);
  useEffect(() => {
    onChartStyleChange?.(chartStyle);
  }, [chartStyle, onChartStyleChange]);
  // Persist indicator/grid/candle-style choices to localStorage on every
  // change — the matching lazy useState initializers above (readChartPrefs)
  // are what actually restores them on the next mount/page load.
  useEffect(() => {
    writeChartPrefs({
      showBB, showRSI, showMACD,
      showEMA20, showEMA50, showEMA200,
      showMA20, showMA50, showMA200,
      showFib, showSR, showZones, showDayHL, showCME,
      showGrid, chartStyle,
    });
  }, [showBB, showRSI, showMACD, showEMA20, showEMA50, showEMA200, showMA20, showMA50, showMA200, showFib, showSR, showZones, showDayHL, showCME, showGrid, chartStyle]);
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
  // Compact View shows one fixed live line, not a real per-interval
  // chart — changing the interval while it's up implies the user wants
  // the real candlestick chart at that interval, so switch back to Full
  // immediately instead of leaving them on a view the new interval
  // doesn't actually affect.
  useEffect(() => { setShowCompactView(false); }, [interval]);
  // Desktop #chart hero row's coin icon — real per-coin logo (same
  // CoinCap image CompactPriceView's own header already uses) instead of
  // the generic colored-letter circle every other icon spot here still
  // uses, falling back to that same letter circle if the image 404s.
  const [heroLogoError, setHeroLogoError] = useState(false);
  useEffect(() => setHeroLogoError(false), [coin]);
  const [isDesktopWidth, setIsDesktopWidth] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 641px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktopWidth(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  // Mobile never shows the grid or any overlay indicator — there's no
  // toggle UI for them there (gridToggleButton/indicatorsControl stay
  // desktop-only, chart-hero-icon-row), so a value persisted from
  // earlier desktop use (readChartPrefs' localStorage) would otherwise
  // be stuck permanently visible on a phone with no way to turn it back
  // off. Forces them off instead of adding more mobile toggle UI.
  useEffect(() => {
    // pageMode (Advance Chart) excluded — that page defaults showGrid to
    // true on purpose (see its own useState initializer above) regardless
    // of width, a different page this complaint isn't about.
    if (isDesktopWidth || pageMode) return;
    setShowGrid(false);
    setShowBB(false);
    setShowRSI(false);
    setShowMACD(false);
    setShowEMA20(false);
    setShowEMA50(false);
    setShowEMA200(false);
    setShowMA20(false);
    setShowMA50(false);
    setShowMA200(false);
    setShowFib(false);
    setShowSR(false);
    setShowZones(false);
    setShowDayHL(false);
    setShowCME(false);
  }, [isDesktopWidth]);
  const chartSectionRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(() => !!pageMode);
  useEffect(() => {
    onFullscreenChange?.(isFullscreen);
  }, [isFullscreen, onFullscreenChange]);
  // Fullscreen "Minimal Header" layout — High/Low/Vol/Signal collapse
  // into one tappable strip inline in the header (unchanged from the
  // original design), expanding in place to show Bid/Ask/Vol-coin/
  // Signal meter/Divergence meter. Starts expanded by default on desktop
  // (room to spare) but collapsed on mobile — either way, still a toggle
  // the user can collapse/expand themselves, not forced open. Reference-
  // match (TradingView desktop chart) exception: the Advance Chart page
  // starts collapsed too, tucked away behind the same chevron instead of
  // cluttering the clean reference look by default.
  const [fsStatsExpanded, setFsStatsExpanded] = useState(isDesktopWidth && !pageMode);
  useEffect(() => {
    if (!isFullscreen) setFsStatsExpanded(isDesktopWidth);
  }, [isFullscreen, isDesktopWidth]);
  // Fullscreen's persistent docked bottom sheet — options only (Style,
  // Indicators, Interval). The peek bar stays visible at all times; it
  // never fully disappears, only grows/shrinks. The sheet itself starts
  // collapsed (peek only) as before — only once the user expands it,
  // Style is the category that's already open, instead of none.
  const [fsSheetExpanded, setFsSheetExpanded] = useState(false);
  // Advance Price Chart page, mobile only — the floating drawing toolbox.
  // Hidden by default (this is only ever read when pageMode, so the
  // default is harmless elsewhere) — the full chart gets the full width
  // first; the "Toolbox" segment in the dock turns it on if wanted.
  const [fsDrawPanelOpen, setFsDrawPanelOpen] = useState(false);
  const [fsOpenCategories, setFsOpenCategories] = useState<Record<string, boolean>>({ overview: true });
  // Accordion — only one category open at a time; expanding one collapses
  // whichever other was open instead of stacking them all open at once.
  const toggleFsCategory = useCallback((key: string) => {
    setFsOpenCategories((prev) => (prev[key] ? {} : { [key]: true }));
  }, []);
  // No longer set by anything in the peek row — kept for the handle's
  // manual full-accordion expand/collapse, which always resets this to
  // null so the full category list shows.
  const [fsFocusedCategory, setFsFocusedCategory] = useState<string | null>(null);
  // Advance Price Chart page, mobile — "Option E" hero-card carousel in
  // the peek row: which of the content categories (Technicals/Key stats/
  // Overview/About/Stats) is currently showing, swiped between via
  // fsHeroTouchX below instead of a tap-to-reveal icon row.
  const [fsHeroIndex, setFsHeroIndex] = useState(0);
  const fsHeroTouchX = useRef<number | null>(null);
  // Peek handle — native-feeling drag instead of a binary swipe-up/down
  // threshold: the sheet's height follows the finger in real time
  // (imperative style writes during the drag, see onTouchMove below, for
  // 60fps without a re-render per pixel moved) and only commits to
  // fsSheetExpanded — which then drives the CSS-transitioned rest state
  // — once the finger lifts. fsDockBodyH is the body's own measured
  // natural height (ResizeObserver-tracked below) so max-height can
  // animate between 0 and an exact pixel value instead of "auto", which
  // CSS can't transition.
  const fsDockBodyRef = useRef<HTMLDivElement>(null);
  const fsDockBodyInnerRef = useRef<HTMLDivElement>(null);
  const [fsDockBodyH, setFsDockBodyH] = useState(0);
  const fsDockDragRef = useRef<{ startY: number; startH: number } | null>(null);
  // Same dot-pagination logic/UI as the hero card's own dots, applied to
  // the action strip below it: whichever item is expanded — Interval/
  // Indicators/Style show their own picker INSIDE that same button
  // (horizontally scrollable if it overflows) instead of anywhere else;
  // Toolbox/Alerts just show as a wide pill since they have nothing to
  // pick. -1 = nothing expanded, every item collapsed to a small dot.
  // Index into [interval, indicators, style, toolbox, alerts], defaults
  // to Interval expanded.
  const [fsActionIndex, setFsActionIndex] = useState(0);
  const fsDockRef = useRef<HTMLDivElement>(null);
  // Reference-match (TradingView mobile "symbol info" sheet) — Overview/
  // Key stats/About need real fundamentals (ATH, supply, market cap,
  // project links) this app never tracked before; Open Interest is a
  // separate live fetch (Binance futures, this app's own existing OI
  // source elsewhere is BTC-only, see coinglass.ts) multiplied by the
  // live price already on hand instead of a second price fetch. Both
  // reset to null on coin change so a stale coin's numbers never flash
  // before the new fetch resolves, and only run while the sheet can
  // actually be seen (isFullscreen && mobile) — no point spending the
  // request otherwise.
  const [coinMeta, setCoinMeta] = useState<CoinMeta | null>(null);
  const [oiCoins, setOiCoins] = useState<number | null>(null);
  useEffect(() => {
    const mobileFs = isFullscreen && !isDesktopWidth;
    // Desktop bar header also needs coin meta (genesis date → "16Y old").
    const desktopBar = isDesktopWidth && !isFullscreen && !pageMode;
    if (!mobileFs && !desktopBar) return;
    let cancelled = false;
    setCoinMeta(null);
    fetchCoinMeta(coin).then((m) => { if (!cancelled) setCoinMeta(m); });
    if (mobileFs) {
      setOiCoins(null);
      fetchOpenInterestCoins(coin).then((v) => { if (!cancelled) setOiCoins(v); });
    }
    return () => { cancelled = true; };
  }, [isFullscreen, isDesktopWidth, pageMode, coin]);
  // Advance Price Chart page, mobile — how much bottom clearance the
  // scroll container needs to reserve so the chart's own time-axis date
  // labels clear the docked bottom sheet. Measured from the actual
  // rendered dock (peek state only — see the fsSheetExpanded guard
  // below), not a guessed pixel constant, so it's correct on every
  // device (notch/no-notch, Dynamic Island, etc.) and stays correct if
  // the peek row's own content ever changes again later.
  const [fsDockClearance, setFsDockClearance] = useState(104);
  useEffect(() => {
    if (!(pageMode && !isDesktopWidth && isFullscreen)) return;
    const el = fsDockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // Only commit while collapsed — expanded, the sheet grows up to
      // 80vh and that's not clearance we want the chart to give up.
      if (!fsSheetExpanded) setFsDockClearance(el.offsetHeight);
    });
    ro.observe(el);
    if (!fsSheetExpanded) setFsDockClearance(el.offsetHeight);
    return () => ro.disconnect();
  }, [pageMode, isDesktopWidth, isFullscreen, fsSheetExpanded]);
  // Natural height of the (always-mounted) accordion body content, so
  // .fs-dock-body's max-height can animate to an exact px value instead
  // of "auto" — stays correct as categories open/close or data loads in.
  useEffect(() => {
    if (!(pageMode && !isDesktopWidth && isFullscreen)) return;
    const el = fsDockBodyInnerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFsDockBodyH(el.scrollHeight));
    ro.observe(el);
    setFsDockBodyH(el.scrollHeight);
    return () => ro.disconnect();
  }, [pageMode, isDesktopWidth, isFullscreen]);
  useEffect(() => {
    if (!isFullscreen) {
      setFsSheetExpanded(false);
      setFsOpenCategories({ style: true });
      setFsFocusedCategory(null);
      // Interval is always the default-expanded quick-row item — reset
      // back to it (not whatever the user last had open/collapsed)
      // every time the page is left and reopened.
      setFsActionIndex(0);
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
        setFsFocusedCategory(null);
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
  const textColor = isLight
    ? isFullscreen
      ? "#0a0b0d"
      : "#5b616e"
    : "#9490c0";
  const gridColor = isLight ? "#f0f1f3" : "#2b2748";
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
    // Standalone page instance — permanently fullscreen-rendered, never
    // has a local overlay state to toggle. Every exit affordance (Exit
    // button, double-tap, double-click) already calls this one function,
    // so routing it to onNavigateBack here covers all of them for free.
    if (pageMode) {
      onNavigateBack?.();
      return;
    }
    if (isFullscreen) {
      cssFsRef.current = false;
      setIsFullscreen(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      return;
    }
    // Compact instance — "entering fullscreen" now navigates to the
    // standalone Advance Price Chart page instead of toggling a local
    // CSS overlay. The local-overlay fallback below only fires if no
    // navigation callback was wired (shouldn't happen once App.tsx always
    // passes onNavigateToPage).
    if (onNavigateToPage) {
      onNavigateToPage();
      return;
    }
    cssFsRef.current = true;
    setIsFullscreen(true);
  }, [pageMode, isFullscreen, onNavigateToPage, onNavigateBack]);

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
  // Reference-match floating date/price bubble shown next to the crosshair,
  // desktop non-fullscreen only — written imperatively from
  // subscribeCrosshairMove (not React state) so it updates every mouse-move
  // tick without triggering a re-render.
  const crosshairTooltipRef = useRef<HTMLDivElement>(null);
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

      // Opens on whatever chartStyle already is — that state is itself
      // lazy-initialized from the saved chart_prefs_v1 preference (or
      // "candle" as the default for a first-ever visit, matching the
      // reference Coinbase-style screenshot the header/toolbar was
      // matched to). This must happen BEFORE the candle/line series are
      // created just below, since their own `visible` option is set once
      // at creation from this exact ref — setting it only afterward left
      // the new series born with the PREVIOUS mode's visibility already
      // baked in.
      const forcedStyle: ChartStyle = chartStyle;
      chartStyleRef.current = forcedStyle;

      const chart = createChart(el, {
        width,
        height,
        // Same built-in responsive sizing the RSI/MACD sub-charts already
        // use (their own createChart calls below) — the library's own
        // ResizeObserver keeps width/height in sync with the container on
        // every layout change (window resize, orientation change, sidebar
        // toggle, etc.), replacing the manual ResizeObserver/window
        // "resize" listener this used to hand-roll further down (removed —
        // autoSize and manual chart.resize() calls aren't meant to be used
        // together).
        autoSize: true,
        localization: !isFullscreen && isDesktopWidth
          ? { priceFormatter: formatCompactAxisPrice }
          : undefined,
        layout: {
          // Library's own TradingView attribution badge, bottom-left of
          // the pane — defaults to true on every createChart() call. Not
          // app content, not something we want showing.
          attributionLogo: false,
          background: {
            type: ColorType.Solid,
            // Matches bgColor below exactly (same #111827 reasoning) — this
            // is the INITIAL createChart call, a separate literal from the
            // theme-sync effect's applyOptions, so it needs the same fix or
            // every fresh mount/recreation briefly paints the old mismatched
            // value before the sync effect corrects it a tick later.
            color: isLight ? "#ffffff" : "#111827",
          },
          textColor: isLight ? "#5b616e" : "#9490c0",
        },
        // Gridlines only read as useful at fullscreen/expanded size — in
        // the compact inline card they just add visual noise, so start
        // transparent; the theme-sync effect below turns them on once
        // isFullscreen flips true.
        grid: {
          vertLines: { color: "transparent" },
          horzLines: { color: "transparent" },
        },
        // Reference-match: dashed crosshair with a dark price-label pill
        // on the axis, matching the Coinbase-style screenshot — only
        // visually distinct from the library default in the dashed style
        // + pill color; still off entirely in fullscreen/mobile via the
        // subscribeCrosshairMove gate below, which also drives the custom
        // white date/price tooltip bubble.
        crosshair: {
          mode: 1,
          vertLine: {
            width: 1,
            style: LineStyle.Dashed,
            color: isLight ? "#0a0b0d" : "#9490c0",
            labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
          },
          horzLine: {
            width: 1,
            style: LineStyle.Dashed,
            color: isLight ? "#0a0b0d" : "#9490c0",
            labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
          },
        },
        // Matches the gridlines — transparent until the theme-sync effect
        // turns it on for fullscreen/expanded view or the Grid toggle.
        rightPriceScale: { borderColor: "transparent" },
        timeScale: {
          borderColor: isLight ? "#e7e9eb" : "#2b2748",
          timeVisible: true,
          secondsVisible: false,
          // Without this, autoSize's resize() keeps bar spacing constant
          // and reveals more (unloaded) history instead of rescaling the
          // currently-visible range to fill the new width — if there isn't
          // enough history loaded yet, growing the window just exposes
          // blank canvas on one side instead of stretching the existing
          // candles to fill it.
          lockVisibleTimeRangeOnResize: true,
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

      // Every view (desktop/mobile, fullscreen or not) paints its own
      // rounded-corner candles via RoundedCandleOverlay instead (LWC's own
      // CandlestickSeries has no radius option) — making the real series
      // transparent (NOT
      // visible:false — that stopped the price scale autoscaling off it
      // entirely, collapsing the Y-axis to whatever tiny range the other
      // series left) keeps it painting nothing of its own while staying the
      // real data/scale source for autoscale, markers, crosshair price
      // lookups, and drawing tools; the overlay paints the rounded bars on
      // top of this invisible-but-present series.
      const candleColorsTransparent = (chartStyleRef.current as ChartStyle) !== "line";
      candleRef.current = chart.addSeries(CandlestickSeries, {
        upColor: candleColorsTransparent ? "transparent" : "#4ade80",
        downColor: candleColorsTransparent ? "transparent" : "#fb7185",
        borderUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        borderDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
        wickUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        wickDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
        visible: (chartStyleRef.current as ChartStyle) !== "line",
      });
      lineCloseRef.current = chart.addSeries(LineSeries, {
        color: "#818cf8",
        lineWidth: 2,
        visible: (chartStyleRef.current as ChartStyle) === "line",
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
        const window = viewWindowFor(interval);
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

      // Advance Price Chart page, mobile — light tap feedback when
      // tapping a candle (chart.remove() in this effect's cleanup tears
      // this subscription down with it, no separate unsubscribe needed).
      if (pageMode && !isDesktopWidth) {
        chart.subscribeClick(() => hapticTap());
      }

      // Reference-match floating tooltip bubble (date + price) that
      // follows the crosshair — desktop, non-fullscreen only; fullscreen/
      // mobile keep the library's default axis-only crosshair labels.
      // Written straight to the DOM (not React state) since this fires on
      // every mouse-move tick.
      if (!pageMode && isDesktopWidth) {
        chart.subscribeCrosshairMove((param) => {
          const tooltipEl = crosshairTooltipRef.current;
          const wrapEl = containerRef.current;
          if (!tooltipEl || !wrapEl) return;
          const activeSeries = chartStyleRef.current === "line" ? lineCloseRef.current : candleRef.current;
          const point = activeSeries && param.seriesData.get(activeSeries);
          if (
            !param.point ||
            !point ||
            param.point.x < 0 ||
            param.point.x > wrapEl.clientWidth ||
            param.point.y < 0 ||
            param.point.y > wrapEl.clientHeight
          ) {
            tooltipEl.style.opacity = "0";
            return;
          }
          const price = "close" in point ? point.close : (point as { value: number }).value;
          const date = new Date((param.time as number) * 1000);
          const dateLabel = date.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
          tooltipEl.querySelector(".chart-crosshair-tooltip-date")!.textContent = dateLabel;
          tooltipEl.querySelector(".chart-crosshair-tooltip-price")!.textContent = formatLivePrice(price);
          const tooltipWidth = 150;
          let left = param.point.x + 14;
          if (left + tooltipWidth > wrapEl.clientWidth) left = param.point.x - tooltipWidth - 14;
          let top = param.point.y - 44;
          if (top < 0) top = param.point.y + 14;
          tooltipEl.style.left = `${left}px`;
          tooltipEl.style.top = `${top}px`;
          tooltipEl.style.opacity = "1";
        });
      }
    };

    initChart();

    return () => {
      isMounted = false;
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
      layout: {
        background: { type: ColorType.Solid, color: bgColor },
        textColor,
      },
      localization: !isFullscreen && isDesktopWidth
        ? { priceFormatter: formatCompactAxisPrice }
        : { priceFormatter: undefined },
      grid: {
        // Reference-match (TradingView desktop chart): dotted gridlines
        // on the Advance Chart page specifically — every other view keeps
        // the existing solid (default) grid style.
        vertLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
        horzLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
      },
      rightPriceScale: { borderColor: showGrid ? gridColor : "transparent" },
      timeScale: { borderColor: gridColor },
      crosshair: {
        vertLine: {
          color: isLight ? "#0a0b0d" : "#9490c0",
          labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
        },
        horzLine: {
          color: isLight ? "#0a0b0d" : "#9490c0",
          labelBackgroundColor: isLight ? "#0a0b0d" : "#2b2748",
        },
      },
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
    // Keeps the real candle series' own paint transparent (so the
    // RoundedCandleOverlay shows through) in sync on a plain fullscreen
    // toggle too, not just the initial chart creation — see the long
    // comment at this series' addSeries() call above for why this is
    // transparent colors, not visible:false.
    {
      const candleColorsTransparent = (chartStyleRef.current as ChartStyle) !== "line";
      candleRef.current?.applyOptions({
        upColor: candleColorsTransparent ? "transparent" : "#4ade80",
        downColor: candleColorsTransparent ? "transparent" : "#fb7185",
        borderUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        borderDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
        wickUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
        wickDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
      });
    }
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
    // theme change, a separate effect above), so the "reset the view"
    // logic that used to live only inside chart creation never ran for a
    // plain fullscreen enter/exit at all. prevIsFullscreenForToggleRef
    // scopes this to an actual isFullscreen transition specifically —
    // this effect also fires for grid/theme changes alone, which
    // shouldn't reset the zoom the user was just looking at. Style is no
    // longer force-changed here (it used to reset to "candle" on every
    // fullscreen toggle) — chartStyle is a persisted user preference now
    // (chart_prefs_v1), so entering/exiting fullscreen shouldn't silently
    // override whatever style the user picked.
    if (chart && prevIsFullscreenForToggleRef.current !== isFullscreen) {
      prevIsFullscreenForToggleRef.current = isFullscreen;
      if (lastCandlesRef.current.length > 0) {
        const window = viewWindowFor(interval);
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

    const fetchKey = `${coin}:${interval}`;
    const isBackgroundRefresh = hasLoadedOnce && lastLoadedKeyRef.current === fetchKey;
    lastLoadedKeyRef.current = fetchKey;

    const fetch = async () => {
      if (!isBackgroundRefresh) setLoading(true);
      setError("");
      if (!hasLoadedOnce) {
        await waitForSeriesReady();
        if (!cancelled) {
          // Prefer the user's own real last-seen candles for this coin/
          // interval (persisted across page loads) over the generic
          // hardcoded shape — real price scale, real history, actually
          // theirs, just stale for a moment. Only genuinely new
          // coin/interval combos ever fall back to the synthetic one.
          const fake =
            readChartCandleCache(coin, interval) ?? makeFakeFirstLoadCandles();
          // Force the Line series specifically, regardless of whatever
          // chartStyleRef/candle series visibility happens to be at this
          // exact point in the mount sequence — this placeholder only
          // ever draws once, on the very first load, before fullscreen or
          // any style toggle is reachable, so always-line is correct here.
          lineCloseRef.current?.setData(
            fake.map((c) => ({ time: c.time, value: c.close })),
          );
          lineCloseRef.current?.applyOptions({ visible: true, color: "#818cf8" });
          candleRef.current?.applyOptions({ visible: false });
          volumeRef.current?.setData(
            fake.map((c) => ({
              time: c.time,
              value: c.volume ?? 0,
              color:
                c.close >= c.open
                  ? "rgba(74,222,128,0.45)"
                  : "rgba(251,113,133,0.45)",
            })),
          );
          chartRef.current?.timeScale().fitContent();
        }
      }
      try {
        const fresh = await coinglass.getHistoricalCandles(interval, coin);
        if (cancelled) return;
        const data = fresh.length > 0 ? fresh : lastCandlesRef.current;
        if (data.length === 0) {
          setError("No chart data available");
          // Nothing real ever came in for this coin/interval, so whatever
          // is on the canvas right now is only the fake/cached first-load
          // placeholder (see makeFakeFirstLoadCandles/readChartCandleCache
          // above) — showing it next to an error message reads as real
          // (if stale) data, which it never was.
          lineCloseRef.current?.setData([]);
          candleRef.current?.setData([]);
          volumeRef.current?.setData([]);
        } else {
          if (fresh.length > 0) {
            lastCandlesRef.current = fresh;
            writeChartCandleCache(coin, interval, fresh);
          }
          await waitForSeriesReady();
          if (cancelled) return;
          redrawCandleSeries(data);
          // The !hasLoadedOnce branch above force-hides candleRef (always-
          // line placeholder, by design) — now that real data is in,
          // restore its visibility to match the CURRENT style. Forcing
          // "candle" everywhere (chartStyleRef is now always "candle",
          // never "line" by default) means the chartStyle-sync effect
          // elsewhere never re-fires to undo that hide on its own (its
          // deps don't change if chartStyle was already "candle" from
          // mount), so candles silently never appeared after the very
          // first load — or after switching coins, which goes through
          // this same !hasLoadedOnce placeholder path again.
          candleRef.current?.applyOptions({ visible: (chartStyleRef.current as ChartStyle) !== "line" });
          lineCloseRef.current?.applyOptions({ visible: (chartStyleRef.current as ChartStyle) === "line" });
          // RoundedCandleOverlay only repaints when its
          // own `generation` prop changes or a visible-time-range event
          // fires on the chart — neither is guaranteed to happen exactly
          // when real data replaces the first-load placeholder, which is
          // what actually left the overlay blank/stale on some loads (the
          // real series itself was already fixed above, but the overlay
          // painting on top of it wasn't repainting in sync). Bumping
          // this here forces it to redraw against the real data every
          // time, not just at initial chart creation.
          setChartGeneration((g) => g + 1);
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
          // AI pattern call only while the viewer has the AI chart read
          // open (on request), and only if quota allows.
          if (aiReadOpenRef.current) runPatternAIRef.current(data);

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
            const priceMarkers: SeriesMarker<number>[] = (div && isPaid && !forceHideIndicators)
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
            const window = viewWindowFor(interval);
            const pending = pendingRangeRef.current;
            if (pending && pending.interval === interval && data.length > 0) {
              pendingRangeRef.current = null;
              const first = data[0].time as number;
              const last = data[data.length - 1].time as number;
              chartRef.current?.timeScale().setVisibleRange({
                from: Math.max(pending.from, first) as UTCTimestamp,
                to: Math.min(Math.max(pending.to, first), last) as UTCTimestamp,
              });
            } else if (window && data.length > 0) {
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
        if (!cancelled) {
          setError("Failed to fetch chart data");
          // Same reasoning as the "No chart data available" branch above —
          // only clear when there's no real data to fall back on, so a
          // failed refetch on an already-loaded coin still shows its last
          // real (stale) chart rather than wiping a working view.
          if (lastCandlesRef.current.length === 0) {
            lineCloseRef.current?.setData([]);
            candleRef.current?.setData([]);
            volumeRef.current?.setData([]);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setHasLoadedOnce(true);
        }
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

  // ── Refetch interval trends on coin/refresh change ───────────────────────
  // banner/zone/patternInsight are intentionally left alone here — they
  // used to get nulled out immediately, which meant those panels just
  // vanished the instant a coin/interval switch started instead of
  // staying on screen (blurred, see .price-chart-container--loading) until
  // the fresh fetch actually replaces them.
  useEffect(() => {
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
    // The rounded-candle overlay (RoundedCandleOverlay, below) only knows
    // how to paint standard OHLC bodies — picking Hollow/Line/Heikin Ashi
    // from the style dropdown needs the REAL series visible again (not
    // forced transparent) so those styles actually render, instead of the
    // overlay silently keeping yesterday's plain candles on screen no
    // matter what style got picked.
    const candleColorsTransparent = chartStyle !== "line";
    candleRef.current?.applyOptions({
      upColor: candleColorsTransparent ? "transparent" : "#4ade80",
      downColor: candleColorsTransparent ? "transparent" : "#fb7185",
      borderUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
      borderDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
      wickUpColor: candleColorsTransparent ? "transparent" : "#4ade80",
      wickDownColor: candleColorsTransparent ? "transparent" : "#fb7185",
    });
    if (lastCandlesRef.current.length > 0) redrawCandleSeries(lastCandlesRef.current);
  }, [chartStyle, isFullscreen, isDesktopWidth, redrawCandleSeries]);

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
      // Same attribution-logo opt-out as the main chart above — these sub-
      // charts (RSI/MACD panes) default it to true too.
      layout: { attributionLogo: false, background: { type: ColorType.Solid, color: bgColor }, textColor },
      // Matches the main chart — transparent until the manual Grid
      // toggle turns gridlines on (fullscreen no longer force-enables
      // them).
      grid: {
        vertLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
        horzLines: { color: showGrid ? gridColor : "transparent", style: pageMode ? LineStyle.Dotted : LineStyle.Solid },
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
  // Pulled out of handleScreenshot (below) so "Ask Agent Ready" can reuse
  // the exact same composed chart+overlays+RSI/MACD image without
  // triggering a save/share dialog — same canvas work, two different
  // destinations for the resulting data URL.
  const captureChartDataUrl = (): { dataUrl: string; filename: string } | null => {
    const mainCanvas = chartRef.current?.takeScreenshot();
    if (!mainCanvas) return null;

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
    return { dataUrl, filename };
  };

  const handleScreenshot = async () => {
    const captured = captureChartDataUrl();
    if (!captured) return;
    const { dataUrl, filename } = captured;

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

  // "Ask Agent Ready" button (Advance Chart page toolbar) — captures the
  // current chart the same way Save does, then hands it to TradingAgent
  // (always mounted at the App.tsx root) via the same kind of custom-
  // event trigger "open-trading-agent"/"toggle-trading-agent" already
  // use there, instead of a new prop drilled all the way down to this
  // page specifically. TradingAgent owns showing/sending it from here —
  // this just opens the panel with the image attached, doesn't auto-send.
  // Shared by the Advance Chart page's top toolbar (next to Save) and
  // ChartDrawingTools' own mobile rail (its onReset prop) — same "fit
  // everything back to the loaded range" behavior either way.
  const handleResetView = () => {
    chartRef.current?.timeScale().fitContent();
    rsiChartRef.current?.timeScale().fitContent();
    macdChartRef.current?.timeScale().fitContent();
  };

  const handleAskAgentReady = () => {
    const captured = captureChartDataUrl();
    if (!captured) return;
    window.dispatchEvent(new CustomEvent("open-trading-agent-with-image", {
      detail: {
        imageDataUrl: captured.dataUrl,
        prompt: `Can you analyze this ${coin} chart?`,
      },
    }));
  };
  // TradingAgent's own floating trigger (bottom-right, always mounted at
  // the App.tsx root) dispatches this when tapped on this exact page
  // (triggerCapturesChart prop, App.tsx) instead of opening blank — the
  // toolbar's own "Ask Agent Ready" button was removed in favor of this
  // single entry point, so handleAskAgentReady above is now only ever
  // called from here.
  useEffect(() => {
    if (!(pageMode && isDesktopWidth)) return;
    const onRequest = () => handleAskAgentReady();
    window.addEventListener("request-chart-screenshot", onRequest);
    return () => window.removeEventListener("request-chart-screenshot", onRequest);
  }, [pageMode, isDesktopWidth, coin]);

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
      {/* Gann Pivots indicator temporarily hidden from the menu (user
          request) — underlying detection/toggle state left intact below,
          just not reachable from the UI, so re-enabling is a one-line
          revert of this comment-out rather than rebuilding the feature. */}
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

  // Minimal dot+label chip version of the same indicator toggles above,
  // for the Advance Chart page's quick-row (no checkbox input, no group
  // headers — those didn't fit a single scrollable row of small pills).
  const fsQuickIndicators: Array<{ key: string; label: string; color: string; checked: boolean; onToggle: () => void; pro?: boolean }> = [
    { key: "bb", label: t("chart.bollingerBands"), color: "rgba(251,113,133,0.85)", checked: showBB, onToggle: () => setShowBB((v) => !v) },
    { key: "ema20", label: t("chart.ema20"), color: "#4ade80", checked: showEMA20, onToggle: () => setShowEMA20((v) => !v) },
    { key: "ema50", label: t("chart.ema50"), color: "#fb923c", checked: showEMA50, onToggle: () => setShowEMA50((v) => !v) },
    { key: "ema200", label: t("chart.ema200"), color: "#c084fc", checked: showEMA200, onToggle: () => setShowEMA200((v) => !v) },
    { key: "ma20", label: t("chart.ma20"), color: "#818cf8", checked: showMA20, onToggle: () => setShowMA20((v) => !v) },
    { key: "ma50", label: t("chart.ma50"), color: "#f472b6", checked: showMA50, onToggle: () => setShowMA50((v) => !v) },
    { key: "ma200", label: t("chart.ma200"), color: "#facc15", checked: showMA200, onToggle: () => setShowMA200((v) => !v) },
    { key: "cme", label: t("chart.cmeGaps"), color: "rgba(251,191,36,0.85)", checked: showCME, onToggle: () => setShowCME((v) => !v) },
    { key: "fib", label: "Fibonacci Levels", color: "rgba(251,191,36,0.85)", checked: showFib, pro: true, onToggle: () => { if (!isPaid) { onOpenUpgrade?.("pro"); return; } setShowFib((v) => !v); } },
    { key: "sr", label: "Support / Resistance", color: "rgba(251,113,133,0.75)", checked: showSR, onToggle: () => setShowSR((v) => !v) },
    { key: "dayhl", label: "24H High/Low", color: "#facc15", checked: showDayHL, onToggle: () => setShowDayHL((v) => !v) },
    { key: "zones", label: "Buy/Sell Zones", color: "rgba(74,222,128,0.75)", checked: showZones, pro: true, onToggle: () => { if (!isPaid) { onOpenUpgrade?.("pro"); return; } setShowZones((v) => !v); } },
    { key: "rsi", label: t("chart.rsi14"), color: "#818cf8", checked: showRSI, onToggle: () => setShowRSI((v) => !v) },
    { key: "macd", label: t("chart.macd1269"), color: "#f97316", checked: showMACD, onToggle: () => setShowMACD((v) => !v) },
  ];

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
  // Desktop Chart page (not fullscreen, not the Advance Chart page) uses the
  // exchange-style bar header instead of the classic hero header.
  const useBarHeader = isDesktopWidth && !isFullscreen && !pageMode;
  // "16Y old" / "8M old" from CoinGecko's genesis date (when it has one).
  const coinAgeLabel = (() => {
    const g = coinMeta?.genesisDate;
    if (!g) return null;
    const t = Date.parse(g);
    if (!Number.isFinite(t)) return null;
    const months = Math.floor((Date.now() - t) / (30.44 * 86400000));
    if (months < 1) return "New";
    return months >= 12 ? `${Math.floor(months / 12)}Y old` : `${months}M old`;
  })();
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

  // Reference-match inline interval pills (desktop, non-fullscreen only) —
  // the 11-value INTERVALS list is too many for a flat pill row like the
  // screenshot's 5m/1h/8h/1D/1W, so this shows the 5 most-used intervals
  // as real pills and folds the rest (1sec/15min/6h/1month/all) behind a
  // trailing "More" pill that opens the exact same dropdown fsIntervalButton
  // already uses above — nothing becomes unreachable, it's reorganized.
  // Re-applied on anything that can recreate the chart (theme, fullscreen,
  // coin/interval reloads), not just on toggle.
  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({
      mode: scaleMode === "percent" ? PriceScaleMode.Percentage : scaleMode === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      autoScale,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleMode, autoScale, coin, interval, isFullscreen, theme, showGrid, loading]);
  const QUICK_INTERVALS: TimeInterval[] = ["5min", "1h", "4h", "1day", "1week"];
  const quickIntervalPills = (
    <div className="chart-quick-interval-pills">
      {QUICK_INTERVALS.map((opt) => {
        const needsPro = PRO_INTERVALS.has(opt);
        const locked = needsPro && !isPaid;
        const trend = trends[opt];
        return (
          <button
            type="button"
            key={opt}
            className={`interval-pill${interval === opt ? " interval-pill--active" : ""}`}
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
      <button
        ref={intervalBtnRef}
        type="button"
        className={`interval-pill interval-pill--more${(isDesktopWidth ? intervalMenuOpen : intervalSheetOpen) ? " interval-pill--active" : ""}${QUICK_INTERVALS.includes(interval) ? "" : " interval-pill--more-selected"}`}
        onClick={() => {
          // Same width-aware split as fsIntervalButton above: desktop gets
          // the floating anchored dropdown, mobile/iOS gets the real
          // native-style bottom sheet (.interval-sheet/intervalSheetPortal,
          // portaled to document.body below) instead of that dropdown
          // rendered small and cramped at phone width.
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
        {QUICK_INTERVALS.includes(interval) ? "···" : INTERVAL_SHORT[interval]}
      </button>
      {/* fsIntervalButton (above) owns the only other copy of this exact
          dropdown, but that component is never mounted at the same time
          as this one (the toolbar picks one or the other) — without its
          own copy here, the "···" button toggled state with nothing ever
          rendering the list. Desktop only — mobile/iOS uses intervalSheetOpen
          (intervalSheetPortal, rendered once near the bottom of this
          component) instead, same as fsIntervalButton already does. */}
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

  // Back to a single icon button (the label+link version in between was
  // its own separate row, disconnected from the other icon controls) —
  // now styled and placed exactly like its chart-hero-icon-row siblings
  // (chart-depth-btn: depth profile/screenshot/fullscreen), not its own
  // row below the header. One constant, rendered from inside that row
  // only now, so the icon/handler still can't drift out of sync between
  // call sites.
  const chartViewSwitchRow = (
    <button
      type="button"
      className={`chart-depth-btn${showCompactView ? " chart-depth-btn--active" : ""}`}
      onClick={() => {
        if (showCompactView) { setShowCompactView(false); return; }
        if (!isPaid) { onOpenUpgrade?.("pro"); return; }
        setShowCompactView(true);
      }}
      title={showCompactView ? t("chart.switchToFull", "Switch to Full Chart") : t("chart.switchToCompact", "Switch to Compact View")}
      data-tooltip={showCompactView ? t("chart.switchToFull", "Switch to Full Chart") : t("chart.switchToCompact", "Switch to Compact View")}
    >
      {/* Shape-based, not another set of lines (grid/depth/chart-style
          nearby already are) — represents the CURRENT view, not the
          target: candles while on the normal full chart, radio-wave
          while already in compact. */}
      {!showCompactView ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="3" x2="8" y2="21" />
          <rect x="6" y="8" width="4" height="8" rx="1" fill="currentColor" stroke="none" />
          <line x1="16" y1="5" x2="16" y2="19" />
          <rect x="14" y="9" width="4" height="7" rx="1" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
          <path d="M15.21 8.17 A5 5 0 0 1 15.21 15.83" />
          <path d="M8.79 8.17 A5 5 0 0 0 8.79 15.83" />
          <path d="M17.14 5.87 A8 8 0 0 1 17.14 18.13" />
          <path d="M6.86 5.87 A8 8 0 0 0 6.86 18.13" />
          <path d="M19.07 3.57 A11 11 0 0 1 19.07 20.43" />
          <path d="M4.93 3.57 A11 11 0 0 0 4.93 20.43" />
        </svg>
      )}
    </button>
  );

  // Fullscreen's persistent docked bottom sheet — options only (Style/
  // Indicators/Interval), grouped as independent accordion categories the
  // user expands one at a time instead of scrolling one long list. High/
  // Low/Vol/Signal/Bid/Ask/Divergence stay inline in the header instead
  // (chart-fs-stats-strip/chart-fs-info-row above) — this sheet never
  // duplicates live stats, only settings.
  // Chart style / grid / depth / view-switch / screenshot / fullscreen
  // icon buttons — shared by the classic header and the desktop bar header.
  const heroIconRow = (
    <div className="chart-hero-icon-row">
      {/* Chart style (candle/line/area) picker — mobile and
          desktop both now; it already has its own mobile
          bottom-sheet branch built in (isDesktopWidth ? portal
          dropdown : indicators-sheet), unlike gridToggleButton
          right below, which stays desktop-only. */}
      {gridStyleControls}
      {isDesktopWidth && gridToggleButton}
      <button
        className={`chart-depth-btn${showDepthProfile ? " chart-depth-btn--active" : ""}`}
        onClick={() => setShowDepthProfile((v) => !v)}
        title={showDepthProfile ? "Hide depth profile" : "Show depth profile"}
        data-tooltip={showDepthProfile ? "Hide depth profile" : "Show depth profile"}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="6" />
          <line x1="21" y1="10" x2="6" y2="10" />
          <line x1="15" y1="14" x2="6" y2="14" />
          <line x1="12" y1="18" x2="6" y2="18" />
        </svg>
      </button>
      {/* Desktop only — mobile goes back to its own text link
          below the header instead (chart-compact-link, right
          after this row closes), not merged into this icon
          set. */}
      {isDesktopWidth && chartViewSwitchRow}
      <button
        type="button"
        className="chart-depth-btn"
        onClick={handleScreenshot}
        title={t("chart.save")}
        data-tooltip={t("chart.save")}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>
      {isDesktopWidth && (
        <button
          type="button"
          className="chart-depth-btn"
          onClick={toggleFullscreen}
          title={t("chart.fullscreen", "Fullscreen")}
          data-tooltip={t("chart.fullscreen", "Fullscreen")}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
          </svg>
        </button>
      )}
    </div>
  );
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

  // Reference-match (TradingView mobile "symbol info" sheet) — the
  // Technicals gauge reuses zone.signal, the exact same real composite
  // signal already driving fsSignalBucket/the zone-signal badges
  // elsewhere on this page, just read as a 5-point Strong Sell…Strong Buy
  // scale instead of the 3-bucket oversold/neutral/overbought one those
  // use. oversold/overbought fold into Buy/Sell respectively — same
  // bullish-on-oversold convention fsSignalBucket already uses above.
  const fsTechnicalsPct: Record<ZoneSignal, number> = {
    "strong-sell": 5, "sell": 25, "overbought": 25,
    "neutral": 50,
    "oversold": 75, "buy": 75, "strong-buy": 95,
  };
  const fsTechnicalsLabel: Record<ZoneSignal, string> = {
    "strong-sell": t("chart.strongSell"), "sell": t("chart.sell"), "overbought": t("chart.sell"),
    "neutral": t("chart.neutralZone"),
    "oversold": t("chart.buy"), "buy": t("chart.buy"), "strong-buy": t("chart.strongBuy"),
  };
  const fsTechnicalsColor: Record<ZoneSignal, string> = {
    "strong-sell": "#ef4444", "sell": "#ef4444", "overbought": "#ef4444",
    "neutral": "var(--color-text-muted)",
    "oversold": "#16a34a", "buy": "#16a34a", "strong-buy": "#16a34a",
  };
  const fsSignalClass = (signal: ZoneSignal) =>
    signal === "strong-sell" || signal === "sell" || signal === "overbought" ? " fs-hero-value--down"
    : signal === "strong-buy" || signal === "buy" || signal === "oversold" ? " fs-hero-value--up"
    : "";

  // "Option E — swipeable hero card" (user-approved) — one full, rich
  // category card at a time instead of a tap-to-reveal icon row; the
  // data itself is the card. Only the categories that actually have
  // browsable content belong here — Style/Indicators/Interval/Toolbox/
  // Alerts stay pure actions in the slim strip below since there's
  // nothing to "read" about them, just a value to set.
  const fsHeroCategories = useMemo(() => {
    const list: Array<"technicals" | "keystats" | "overview" | "about" | "stats" | "agent"> = [];
    if (zone) list.push("technicals");
    list.push("keystats", "overview", "about", "stats", "agent");
    return list;
  }, [zone]);
  const fsHeroKey = fsHeroCategories[Math.min(fsHeroIndex, fsHeroCategories.length - 1)];
  // Agent Ready's quick take, hero card only — cached per-coin for 5
  // minutes (not a real Agent Ready conversation turn, see chart-quick-
  // take edge function's own comment) so swiping back to the same coin
  // doesn't refire the request, but switching coins or waiting past the
  // window asks again.
  const fsAgentTakeCache = useRef<Record<string, { text: string; at: number } | "loading" | "error">>({});
  const [, forceFsAgentTakeRerender] = useState(0);
  useEffect(() => {
    if (!(pageMode && !isDesktopWidth && isFullscreen && fsHeroKey === "agent")) return;
    const cached = fsAgentTakeCache.current[coin];
    if (cached === "loading") return;
    if (cached && cached !== "error" && Date.now() - cached.at < 5 * 60 * 1000) return;
    fsAgentTakeCache.current[coin] = "loading";
    forceFsAgentTakeRerender((v) => v + 1);
    let cancelled = false;
    supabase.functions.invoke("chart-quick-take", {
      body: {
        coin,
        interval: INTERVAL_SHORT[interval],
        price: currentPrice,
        changePct24h: dayChangePercent,
        signal: zone ? fsTechnicalsLabel[zone.signal] : null,
      },
    }).then(({ data, error }) => {
      if (cancelled) return;
      fsAgentTakeCache.current[coin] = error || !data?.take ? "error" : { text: data.take, at: Date.now() };
      forceFsAgentTakeRerender((v) => v + 1);
    });
    return () => { cancelled = true; };
  }, [pageMode, isDesktopWidth, isFullscreen, fsHeroKey, coin, interval, currentPrice, dayChangePercent, zone]);
  const renderFsHeroCard = (key: string) => {
    switch (key) {
      case "technicals": {
        const pct = zone ? fsTechnicalsPct[zone.signal] : 50;
        const color = zone ? fsTechnicalsColor[zone.signal] : "var(--color-text-muted)";
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("chart.technicals", "Technicals")}</div>
              <div className={`fs-hero-value${zone ? fsSignalClass(zone.signal) : ""}`}>
                {zone ? fsTechnicalsLabel[zone.signal] : "—"}
              </div>
              <div className="fs-hero-sub">
                <span>{t("chart.divergence", "Divergence")} {fsDivLabel}</span>
              </div>
            </div>
            <div className="fs-hero-icon" style={{ background: `conic-gradient(${color} ${pct}%, var(--color-border) 0)` }}>
              <span className="fs-hero-icon-core" />
            </div>
          </>
        );
      }
      case "keystats":
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("chart.keyStats", "Key stats")}</div>
              <div className="fs-hero-value">{coinMeta?.marketCapUSD != null ? formatCompactVolume(coinMeta.marketCapUSD) : "—"}</div>
              <div className="fs-hero-sub">
                <span>{t("chart.tradingVolume24h", "Trading volume 24h")} {quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </span>
          </>
        );
      case "overview":
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("chart.overview", "Overview")}</div>
              <div className="fs-hero-value">{coinMeta?.athUSD != null ? formatLivePrice(coinMeta.athUSD) : "—"}</div>
              <div className="fs-hero-sub">
                <span>{t("chart.circulatingSupply", "Circulating supply")} {coinMeta?.circulatingSupply != null ? `${formatCompactNumber(coinMeta.circulatingSupply)} ${coin}` : "—"}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
          </>
        );
      case "about":
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("chart.about", "About")}</div>
              <div className="fs-hero-value">{coinMeta?.category ?? "—"}</div>
              <div className="fs-hero-sub">
                <span>{coinMeta?.homepage ? coinMeta.homepage.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : t("chart.noLink", "No link")}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
              </svg>
            </span>
          </>
        );
      case "agent": {
        const cached = fsAgentTakeCache.current[coin];
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow-row">
                <span className="ta-trigger-orb fs-hero-agent-orb" aria-hidden="true" />
                <span className="fs-hero-eyebrow">{t("chart.agentTake", "Agent Ready")}</span>
              </div>
              {cached === "loading" || cached === undefined ? (
                <div className="fs-hero-value fs-hero-agent-loading">{t("chart.agentThinking", "Reading the chart…")}</div>
              ) : cached === "error" ? (
                <div className="fs-hero-value">{t("chart.agentUnavailable", "Couldn't get a take — try again later")}</div>
              ) : (
                <div className="fs-hero-agent-text">{cached.text}</div>
              )}
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l1.8 4.6L18 8l-4.2 1.4L12 14l-1.8-4.6L6 8l4.2-1.4L12 2z" />
                <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
              </svg>
            </span>
          </>
        );
      }
      case "stats":
      default:
        return (
          <>
            <div>
              <div className="fs-hero-eyebrow">{t("chart.stats", "Stats")}</div>
              <div className="fs-hero-value fs-hero-value--up">{dayHigh !== null ? formatLivePrice(dayHigh) : "—"}</div>
              <div className="fs-hero-sub">
                <span className="fs-hero-sub-down">{t("chart.low", "Low")} {dayLow !== null ? formatLivePrice(dayLow) : "—"}</span>
                <span>{t("chart.volUsd", "Vol (USD)")} {quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
              </div>
            </div>
            <span className="fs-hero-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" /><path d="M7 16l4-5 3 3 5-7" />
              </svg>
            </span>
          </>
        );
    }
  };

  const fsDockSheet = isFullscreen && !isDesktopWidth && ReactDOM.createPortal(
    <div ref={fsDockRef} className={`fs-dock${fsSheetExpanded ? " fs-dock--expanded" : ""}`}>
      <div className="fs-dock-peek">
        <button
          type="button"
          className="fs-dock-peek-toggle"
          onClick={() => {
            if (pageMode) hapticTap();
            setFsFocusedCategory(null);
            setFsSheetExpanded((v) => !v);
          }}
          onTouchStart={(e) => {
            fsDockDragRef.current = { startY: e.touches[0].clientY, startH: fsSheetExpanded ? fsDockBodyH : 0 };
            const body = fsDockBodyRef.current;
            // No transition while actively dragging — it has to follow
            // the finger with zero lag, not ease toward it.
            if (body) body.style.transition = "none";
          }}
          onTouchMove={(e) => {
            const drag = fsDockDragRef.current;
            const body = fsDockBodyRef.current;
            if (!drag || !body || fsDockBodyH <= 0) return;
            const dy = e.touches[0].clientY - drag.startY;
            let next = drag.startH - dy; // dragging up (dy<0) opens further
            // Rubber-band resistance past either end, like a native sheet.
            if (next < 0) next = next / 3;
            else if (next > fsDockBodyH) next = fsDockBodyH + (next - fsDockBodyH) / 3;
            body.style.maxHeight = `${Math.max(0, next)}px`;
          }}
          onTouchEnd={(e) => {
            const drag = fsDockDragRef.current;
            fsDockDragRef.current = null;
            const body = fsDockBodyRef.current;
            if (body) body.style.transition = "";
            if (!drag || !body) return;
            const dy = e.changedTouches[0].clientY - drag.startY;
            body.style.maxHeight = "";
            // Negligible movement = a tap, left entirely to onClick above
            // (no need to also decide expanded/collapsed here — that
            // would just fight the toggle on a plain tap).
            if (Math.abs(dy) < 6) return;
            const settled = fsDockBodyH > 0 ? (drag.startH - dy) / fsDockBodyH : 0;
            if (pageMode) hapticTap();
            setFsFocusedCategory(null);
            setFsSheetExpanded(settled > 0.35);
          }}
        >
          <span className="fs-dock-handle" />
        </button>
        {/* "Option E — swipeable hero card" (user-approved) — one full,
            rich category card at a time (Technicals/Key stats/Overview/
            About/Stats), swiped between with dot pagination instead of a
            row of tap-to-reveal icons. The data shown IS the card: no tap
            needed to see it. Advance Chart page, mobile only. */}
        {pageMode && !isDesktopWidth && fsHeroCategories.length > 0 && (
          <div
            className="fs-hero"
            onTouchStart={(e) => { fsHeroTouchX.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const startX = fsHeroTouchX.current;
              fsHeroTouchX.current = null;
              if (startX == null) return;
              const dx = e.changedTouches[0].clientX - startX;
              if (Math.abs(dx) < 36) return;
              hapticTap();
              setFsHeroIndex((i) => {
                const len = fsHeroCategories.length;
                return dx < 0 ? (i + 1) % len : (i - 1 + len) % len;
              });
            }}
          >
            <div className="fs-hero-card">
              {/* key={fsHeroKey} forces a remount on every card change (auto
                  or manual) so the slide-in animation replays each time. */}
              <div className="fs-hero-card-content" key={fsHeroKey}>
                {renderFsHeroCard(fsHeroKey)}
              </div>
            </div>
            {fsHeroCategories.length > 1 && (
              <div className="fs-hero-dots">
                {fsHeroCategories.map((key, i) => (
                  <button
                    key={key}
                    type="button"
                    className={`fs-hero-dot${i === fsHeroIndex ? " fs-hero-dot--active" : ""}`}
                    aria-label={key}
                    onClick={() => { hapticTap(); setFsHeroIndex(i); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {/* Slim fixed action strip — Interval/Indicators/Style expand
            INSIDE their own button when tapped (horizontally scrollable
            if the options overflow), instead of showing anywhere else;
            Toolbox/Alerts stay direct actions with nothing to pick. */}
        {pageMode && !isDesktopWidth && (
          <div className={`fs-dock-quick-row${fsActionIndex !== -1 ? " fs-dock-quick-row--expanded" : ""}`}>
            {fsActionIndex === 0 ? (
              <div className="fs-dock-quick-btn fs-dock-quick-btn--active fs-dock-quick-btn--picker">
                <button
                  type="button"
                  className="fs-dock-quick-collapse"
                  onClick={() => { hapticTap(); setFsActionIndex(-1); }}
                  aria-label={t("chart.interval", "Interval")}
                  title={t("chart.interval", "Interval")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3.5 2" />
                  </svg>
                </button>
                <FsSlidingOptions
                  options={INTERVALS.map((opt) => {
                    const needsPro = PRO_INTERVALS.has(opt);
                    const locked = needsPro && !isPaid;
                    const trend = trends[opt];
                    return {
                      key: opt,
                      active: interval === opt,
                      locked,
                      ariaLabel: INTERVAL_LABELS[opt],
                      onClick: () => {
                        hapticTap();
                        if (locked) { onOpenUpgrade?.("pro"); return; }
                        setInterval(opt);
                      },
                      label: (
                        <>
                          {INTERVAL_LABELS[opt]}
                          {trend === "bullish" ? <span className="interval-pill-trend interval-pill-trend--up">↑</span>
                            : trend === "bearish" ? <span className="interval-pill-trend interval-pill-trend--down">↓</span>
                            : null}
                          {locked && <span className="interval-sheet-item-pro">PRO</span>}
                        </>
                      ),
                    };
                  })}
                />
              </div>
            ) : (
              <button
                type="button"
                className="fs-dock-quick-btn"
                onClick={() => { setFsActionIndex(0); hapticTap(); }}
                aria-label={t("chart.interval", "Interval")}
                title={t("chart.interval", "Interval")}
              >
                <span className="fs-dock-quick-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3.5 2" />
                  </svg>
                </span>
                <span className="fs-dock-quick-label">{INTERVAL_SHORT[interval]}</span>
              </button>
            )}
            {fsActionIndex === 1 ? (
              <div className="fs-dock-quick-btn fs-dock-quick-btn--active fs-dock-quick-btn--picker">
                <button
                  type="button"
                  className="fs-dock-quick-collapse"
                  onClick={() => { hapticTap(); setFsActionIndex(-1); }}
                  aria-label={t("chart.indicators")}
                  title={t("chart.indicators")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 3v18h18" />
                    <path d="M7 16l4-5 3 3 5-7" />
                  </svg>
                </button>
                <div className="fs-dock-quick-options">
                  {fsQuickIndicators.map((ind) => (
                    <button
                      type="button"
                      key={ind.key}
                      className={`fs-dock-quick-option${ind.checked ? " fs-dock-quick-option--active" : ""}`}
                      onClick={() => { hapticTap(); ind.onToggle(); }}
                    >
                      <span className="fs-dock-quick-option-dot" style={{ background: ind.color }} />
                      {ind.label}
                      {ind.pro && !isPaid && <span className="tier-badge tier-badge--pro">P</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="fs-dock-quick-btn"
                onClick={() => { setFsActionIndex(1); hapticTap(); }}
                aria-label={t("chart.indicators")}
                title={t("chart.indicators")}
              >
                <span className="fs-dock-quick-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 3v18h18" />
                    <path d="M7 16l4-5 3 3 5-7" />
                  </svg>
                </span>
                <span className="fs-dock-quick-label">
                  {[showBB, showRSI, showMACD, showEMA20, showEMA50, showEMA200, showMA20, showMA50, showMA200, showFib, showSR].filter(Boolean).length || t("chart.indicators")}
                </span>
              </button>
            )}
            {fsActionIndex === 2 ? (
              <div className="fs-dock-quick-btn fs-dock-quick-btn--active fs-dock-quick-btn--picker">
                <button
                  type="button"
                  className="fs-dock-quick-collapse"
                  onClick={() => { hapticTap(); setFsActionIndex(-1); }}
                  aria-label={t("chart.style", "Style")}
                  title={t("chart.style", "Style")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.4-4-8.9-10-8.9z" />
                  </svg>
                </button>
                <FsSlidingOptions
                  options={(Object.keys(CHART_STYLE_LABELS) as ChartStyle[]).map((s) => ({
                    key: s,
                    active: chartStyle === s,
                    ariaLabel: CHART_STYLE_LABELS[s],
                    onClick: () => { hapticTap(); setChartStyle(s); },
                    label: (
                      <>
                        <span className="fs-controls-chip-icon">{CHART_STYLE_ICONS[s]}</span>
                        {CHART_STYLE_LABELS[s]}
                      </>
                    ),
                  }))}
                />
              </div>
            ) : (
              <button
                type="button"
                className="fs-dock-quick-btn"
                onClick={() => { setFsActionIndex(2); hapticTap(); }}
                aria-label={t("chart.style", "Style")}
                title={t("chart.style", "Style")}
              >
                <span className="fs-dock-quick-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.4-4-8.9-10-8.9z" />
                  </svg>
                </span>
                <span className="fs-dock-quick-label">{CHART_STYLE_LABELS[chartStyle]}</span>
              </button>
            )}
            <button
              type="button"
              className={`fs-dock-quick-btn${fsActionIndex === 3 ? " fs-dock-quick-btn--active" : fsDrawPanelOpen ? " fs-dock-quick-btn--on" : ""}`}
              onClick={() => { setFsActionIndex(3); hapticTap(); setFsDrawPanelOpen((v) => !v); }}
              aria-label={t("chart.toolbox", "Toolbox")}
              title={t("chart.toolbox", "Toolbox")}
            >
              <span className="fs-dock-quick-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19l7-7 3 3-7 7-3-3z" />
                  <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
                  <path d="M2 2l7.586 7.586" />
                  <circle cx="11" cy="11" r="2" />
                </svg>
              </span>
              <span className="fs-dock-quick-label">{t("chart.toolbox", "Toolbox")}</span>
            </button>
            <button
              type="button"
              className={`fs-dock-quick-btn${fsActionIndex === 4 ? " fs-dock-quick-btn--active" : ""}`}
              onClick={() => {
                setFsActionIndex(4);
                hapticTap();
                // PriceAlerts (App.tsx root, always mounted) owns its own
                // open state internally too — same click-through reuse as
                // the desktop toolbar's own Alert button, via its real
                // bell button (.alerts-bell) instead of a new prop here.
                document.querySelector<HTMLButtonElement>(".alerts-bell")?.click();
              }}
              aria-label={t("priceAlerts.title", "Alert")}
              title={t("priceAlerts.title", "Alert")}
            >
              <span className="fs-dock-quick-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="1" x2="12" y2="23" />
                  <path d="M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </span>
              <span className="fs-dock-quick-label">{t("priceAlerts.title", "Alert")}</span>
            </button>
          </div>
        )}
      </div>

      <div
        ref={fsDockBodyRef}
        className="fs-dock-body"
        style={{ maxHeight: fsSheetExpanded ? fsDockBodyH : 0 }}
      >
        <div ref={fsDockBodyInnerRef} className="fs-dock-body-inner">

          {/* Reference-match (TradingView mobile "symbol info" sheet) —
              Overview/Technicals/Key stats/About, Advance Chart page only
              (same pageMode scoping the existing Stats category below
              already uses) — the regular compact-chart mobile fullscreen
              doesn't grow this extra content unexpectedly. */}
          {pageMode && (!fsFocusedCategory || fsFocusedCategory === "overview") && (
          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("overview")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--overview">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.overview", "Overview")}</span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.overview ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.overview && (
              <div className="fs-dock-category-body">
                <div className="fs-info-list">
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.allTimeHigh", "All time high")}</span>
                    <span className="fs-info-value">{coinMeta?.athUSD != null ? formatLivePrice(coinMeta.athUSD) : "—"}</span>
                  </div>
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.circulatingSupply", "Circulating supply")}</span>
                    <span className="fs-info-value">{coinMeta?.circulatingSupply != null ? `${formatCompactNumber(coinMeta.circulatingSupply)} ${coin}` : "—"}</span>
                  </div>
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.totalSupply", "Total supply")}</span>
                    <span className="fs-info-value">{coinMeta?.totalSupply != null ? `${formatCompactNumber(coinMeta.totalSupply)} ${coin}` : "—"}</span>
                  </div>
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.openInterest", "Open interest")}</span>
                    <span className="fs-info-value">{oiCoins != null && currentPrice != null ? formatCompactVolume(oiCoins * currentPrice) : "—"}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          {pageMode && zone && (!fsFocusedCategory || fsFocusedCategory === "technicals") && (
          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("technicals")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--technicals">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a10 10 0 1 0 10 10" />
                  <path d="M12 12l5-5" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.technicals", "Technicals")}</span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.technicals ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.technicals && (() => {
              const pct = fsTechnicalsPct[zone.signal];
              const theta = (180 - pct * 1.8) * (Math.PI / 180);
              const needleX = 80 + 52 * Math.cos(theta);
              const needleY = 86 - 52 * Math.sin(theta);
              return (
                <div className="fs-dock-category-body">
                  <div className="fs-gauge">
                    <svg width="160" height="92" viewBox="0 0 160 92">
                      <path d="M10,86 A70,70 0 0 1 23.4,44.8" fill="none" stroke="#ef4444" strokeWidth="14" strokeLinecap="round" />
                      <path d="M23.4,44.8 A70,70 0 0 1 58.4,19.4" fill="none" stroke="#f97316" strokeWidth="14" />
                      <path d="M58.4,19.4 A70,70 0 0 1 101.6,19.4" fill="none" stroke="#9ca3af" strokeWidth="14" />
                      <path d="M101.6,19.4 A70,70 0 0 1 136.6,44.8" fill="none" stroke="#4ade80" strokeWidth="14" />
                      <path d="M136.6,44.8 A70,70 0 0 1 150,86" fill="none" stroke="#16a34a" strokeWidth="14" strokeLinecap="round" />
                      <line x1="80" y1="86" x2={needleX} y2={needleY} stroke="var(--color-text)" strokeWidth="2.4" strokeLinecap="round" />
                      <circle cx="80" cy="86" r="4.5" fill="var(--color-text)" />
                    </svg>
                    <div className="fs-gauge-labels">
                      <span>{t("chart.strongSell")}</span>
                      <span>{t("chart.sell")}</span>
                      <span>{t("chart.neutralZone")}</span>
                      <span>{t("chart.buy")}</span>
                      <span>{t("chart.strongBuy")}</span>
                    </div>
                    <div className={`fs-gauge-value fs-gauge-value--${zone.signal}`}>{fsTechnicalsLabel[zone.signal]}</div>
                  </div>
                </div>
              );
            })()}
          </div>
          )}

          {pageMode && (!fsFocusedCategory || fsFocusedCategory === "keystats") && (
          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("keystats")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--keystats">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.keyStats", "Key stats")}</span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.keystats ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.keystats && (
              <div className="fs-dock-category-body">
                <div className="fs-info-list">
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.tradingVolume24h", "Trading volume 24h")}</span>
                    <span className="fs-info-value">{quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}</span>
                  </div>
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.marketCap", "Market capitalization")}</span>
                    <span className="fs-info-value">{coinMeta?.marketCapUSD != null ? formatCompactVolume(coinMeta.marketCapUSD) : "—"}</span>
                  </div>
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.fdv", "Fully diluted market cap")}</span>
                    <span className="fs-info-value">{coinMeta?.fdvUSD != null ? formatCompactVolume(coinMeta.fdvUSD) : "—"}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          {pageMode && (!fsFocusedCategory || fsFocusedCategory === "about") && (
          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("about")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--about">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.about", "About")}</span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.about ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.about && (
              <div className="fs-dock-category-body">
                <div className="fs-info-list">
                  <div className="fs-info-row">
                    <span className="fs-info-label">{t("chart.category", "Category")}</span>
                    <span className="fs-info-value">{coinMeta?.category ?? "—"}</span>
                  </div>
                  {([
                    ["chart.website", "Website", coinMeta?.homepage],
                    ["chart.sourceCode", "Source Code", coinMeta?.sourceCode],
                    ["chart.explorers", "Explorers", coinMeta?.explorer],
                    ["chart.whitepaper", "Whitepaper", coinMeta?.whitepaper],
                    ["chart.community", "Community", coinMeta?.subreddit],
                  ] as const).map(([key, fallback, url]) => (
                    <div className="fs-info-row" key={key}>
                      <span className="fs-info-label">{t(key, fallback)}</span>
                      {url ? (
                        <a className="fs-info-link" href={url} target="_blank" rel="noopener noreferrer">
                          {url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                        </a>
                      ) : (
                        <span className="fs-info-value">—</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}

          {(!fsFocusedCategory || fsFocusedCategory === "style") && (
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
          )}

          {(!fsFocusedCategory || fsFocusedCategory === "indicators") && (
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
                {/* onChangeCapture delegates one haptic call to every
                    indicator checkbox inside indicatorsList (15+ of them)
                    without touching each one's own onChange — this is the
                    Advance Price Chart page's dock only, so it doesn't
                    affect the same indicatorsList embedded elsewhere
                    (compact view / desktop fullscreen dropdowns). */}
                <div
                  className="indicators-menu indicators-menu--sheet"
                  onChangeCapture={() => { if (pageMode) hapticTap(); }}
                >
                  {indicatorsList}
                </div>
              </div>
            )}
          </div>
          )}

          {(!fsFocusedCategory || fsFocusedCategory === "interval") && (
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
          )}

          {/* Advance Price Chart page only — High/Low/Vol/Bid/Ask/Vol-coin/
              Signal/Divergence, the same content the header's expandable
              stats strip shows elsewhere, just relocated here since the
              header on this page is trimmed down to coin/price/change. */}
          {pageMode && (!fsFocusedCategory || fsFocusedCategory === "stats") && (
          <div className="fs-dock-category">
            <button type="button" className="fs-dock-category-header" onClick={() => toggleFsCategory("stats")}>
              <span className="fs-dock-category-icon fs-dock-category-icon--stats">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="M7 16l4-5 3 3 5-7" />
                </svg>
              </span>
              <span className="fs-dock-category-label">{t("chart.stats", "Stats")}</span>
              <span className="chart-fs-strip-item" style={{ marginLeft: 6 }}>{t("chart.high", "High")} <b className="chart-fs-strip-up">{dayHigh !== null ? formatLivePrice(dayHigh) : "—"}</b></span>
              <span className="chart-fs-strip-item">{t("chart.low", "Low")} <b className="chart-fs-strip-down">{dayLow !== null ? formatLivePrice(dayLow) : "—"}</b></span>
              <svg className={`fs-dock-category-chevron${fsOpenCategories.stats ? " fs-dock-category-chevron--open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {fsOpenCategories.stats && (
              <div className="fs-dock-category-body">
                <div className="chart-fs-stats-grid">
                  <div className="chart-fs-stat-col">
                    <div className="chart-fs-stat-row">
                      <span className="chart-fs-stat-label">{t("chart.volUsd", "Vol (USD)")}</span>
                      <span className="chart-fs-stat-value">
                        {quoteVolume24h !== undefined ? formatCompactVolume(quoteVolume24h) : "—"}
                      </span>
                    </div>
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
          )}

        </div>
      </div>
    </div>,
    document.body,
  );

  // First page load/refresh has no real data yet to show blurred, unlike
  // a later coin/interval switch — these placeholders fill the same spots
  // with plausible-looking content purely so there's something present to
  // blur (via .price-chart-container--loading) instead of empty gaps.
  // They're display-only derived values, never written back into the
  // real dayHigh/banner/patternInsight state those features rely on.
  const isFirstLoad = loading && !hasLoadedOnce;
  const displayDayHigh = dayHigh ?? (isFirstLoad ? 100 : null);
  const displayDayLow = dayLow ?? (isFirstLoad ? 95 : null);
  const displayBanner: IntervalAnalysis | null =
    banner ??
    (isFirstLoad
      ? {
          sentiment: "neutral",
          title: "Analyzing price action…",
          body: "Crunching recent candles to size up momentum and trend strength.",
        }
      : null);
  const displayPatternInsight: PatternInsight | null =
    patternInsight ??
    (isFirstLoad
      ? {
          name: "Scanning for patterns…",
          type: "neutral",
          summary: "Looking at recent candles for a recognizable setup.",
          narrative: "Running the same pattern checks we always do — give it a moment.",
          nextMove: "Hang tight, real analysis is on its way.",
        }
      : null);

  // Shared by both title-row zone-signal spots below (fullscreen compact
  // header + normal/desktop header) — same label, computed once.
  const zoneLabel = zone && {
    "strong-buy": t("chart.strongBuy"),
    "buy": t("chart.buy"),
    "oversold": t("chart.oversold"),
    "overbought": t("chart.overbought"),
    "neutral": t("chart.neutralZone"),
    "sell": t("chart.sell"),
    "strong-sell": t("chart.strongSell"),
  }[zone.signal];

  // Reference-match: signal + zone + divergence as one plain-text sentence
  // inside the AI insight banner, instead of separate dot-indicator/pill
  // badges (SignalIndicator, .div-badge) next to the title. These three
  // are genuinely independent sources (an earlier version used a
  // zone.signal-derived bull/bear bucket as "signal" too, which just
  // restated zoneLabel in different words — "Buy Zone signal in a
  // bullish zone" — so this uses trends[interval] instead, the same
  // independent bullish/bearish reading the interval pills' own little
  // arrows already show): "signal" = this interval's trend direction,
  // "zone" = zoneLabel (the price-zone status, e.g. "Buy Zone"/
  // "Oversold"), "div" = divergence.
  const intervalSignal = trends[interval];
  const rawZoneDivergenceSentence = isPaid && (intervalSignal || zoneLabel || divergence)
    ? intervalSignal && zoneLabel && divergence
      ? t("chart.signalZoneDivSentence", "{{signal}} signal in a {{zone}}, with a {{div}} divergence.", { signal: intervalSignal, zone: zoneLabel, div: divergence.type })
      : intervalSignal && zoneLabel
        ? t("chart.signalZoneSentence", "{{signal}} signal in a {{zone}}.", { signal: intervalSignal, zone: zoneLabel })
        : zoneLabel && divergence
          ? t("chart.zoneDivSentence", "In a {{zone}}, with a {{div}} divergence.", { zone: zoneLabel, div: divergence.type })
          : intervalSignal && divergence
            ? t("chart.signalDivSentence", "{{signal}} signal with a {{div}} divergence.", { signal: intervalSignal, div: divergence.type })
            : zoneLabel
              ? t("chart.zoneSentence", "In a {{zone}}.", { zone: zoneLabel })
              : intervalSignal
                ? t("chart.signalSentence", "{{signal}} signal.", { signal: intervalSignal })
                : divergence
                  ? t("chart.divergenceSentence", "{{div}} divergence detected.", { div: divergence.type })
                  : null
    : null;
  // Sentence-case regardless of how the pieces above were capitalized
  // (zoneLabel comes in as "Buy Zone"/"Oversold" etc) — first letter up,
  // everything else down.
  const zoneDivergenceSentence = rawZoneDivergenceSentence
    ? rawZoneDivergenceSentence.charAt(0).toUpperCase() + rawZoneDivergenceSentence.slice(1).toLowerCase()
    : null;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={chartSectionRef}
      className={`price-chart-container${sideColumn && !isFullscreen ? " price-chart-container--split" : ""}${isFullscreen ? " price-chart-container--fs" : ""}${loading ? " price-chart-container--loading" : ""}${pageMode ? " price-chart-container--page" : ""}`}
    >
      <div
        ref={isFullscreen ? fsScrollRef : undefined}
        className={isFullscreen ? "price-chart-fs-scroll pcc-main" : "pcc-main"}
        style={
          pageMode && !isDesktopWidth
            ? ({ "--fs-dock-clearance": `${fsDockClearance}px` } as React.CSSProperties)
            : undefined
        }
        onScroll={isFullscreen ? updateFsThumb : undefined}
      >
        {/* Reference-match (TradingView desktop chart) — the Advance Chart
            page's own top toolbar: symbol/interval/style/indicators on the
            left, save + Trade + Upgrade on the right. Desktop pageMode
            only; reuses the exact same gridStyleControls/fsIntervalButton/
            indicatorsControl components the old .chart-legend-actions row
            used (now excluded from that row in this exact scope, above,
            so there's no duplicate-ref/duplicate-menu collision). */}
        {pageMode && isDesktopWidth && (
          <div className="chart-tv-toolbar">
            <div className="chart-tv-toolbar-left">
              <button
                type="button"
                className="chart-tv-symbol"
                onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
              >
                <span
                  className="chart-tv-symbol-icon"
                  style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                >
                  {COIN_GLYPHS[coin] ?? coin[0]}
                </span>
                {coin}USD
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {fsIntervalButton}
              {gridStyleControls}
              {indicatorsControl}
              {gridToggleButton}
              <button
                type="button"
                className="chart-tv-save-btn"
                onClick={() => {
                  // PriceAlerts (App.tsx root, always mounted) owns its own
                  // open state internally too — same .ta-trigger-style
                  // click-through reuse as the Trade button above, via its
                  // own real bell button (.alerts-bell) instead of a new
                  // prop just for this.
                  document.querySelector<HTMLButtonElement>(".alerts-bell")?.click();
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="1" x2="12" y2="23" />
                  <path d="M17 5.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
                {t("priceAlerts.title", "Alert")}
              </button>
            </div>
            <div className="chart-tv-toolbar-right">
              <div className="chart-tv-segmented-group">
                <button type="button" className="chart-tv-segment-btn" onClick={handleScreenshot}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
                  </svg>
                  {t("chart.save")}
                </button>
                <button type="button" className="chart-tv-segment-btn" onClick={handleResetView} title={t("chart.reset")} data-tooltip={t("chart.reset")}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  {t("chart.reset")}
                </button>
                {!isPaid && (
                  <button
                    type="button"
                    className="chart-tv-segment-btn chart-tv-segment-upgrade"
                    onClick={() => onOpenUpgrade?.("pro")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <path d="M13 2L3 14h7l-1 8 11-14h-8l1-6z" />
                    </svg>
                    {t("chart.upgrade", "Upgrade")}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Reference-match (TradingView desktop chart): the coin name/
            price/change/High-Low/signal header block is replaced by an
            OHLC readout + Buy/Sell boxes OVERLAID directly on the chart
            canvas's own top-left corner (new block below, inside
            .chart-canvas-wrap) instead of taking its own layout row —
            collapsing this whole group the same way pageMode mobile
            already does, reclaiming that vertical space for the chart. */}
        {!forceHideHeader && (
        <>
        <div className={`chart-fs-header-group${pageMode ? " chart-fs-header-group--empty" : ""}`}>
          {useBarHeader ? (
          <>
            {/* Desktop Chart page header, exchange-style (reference:
                Hyperliquid): coin + price + change on the left, a divider,
                then a single row of label-over-value stats, with the
                interval pills / chart icons on their own toolbar row
                underneath. headerStats (App.tsx's .mch-stats) joins the
                same stat row, restyled to match (PriceChart.css). */}
            {/* Exchange-style bar header (reference: Hyperliquid): coin +
                price + change, a divider, then label-over-value stats. */}
            <div className="chart-bar-header">
              <div className="chart-bar-id">
          {/* Reference: Hyperliquid's market selector — coin icon, ticker +
              full name, price / 24h change / age underneath, and the picker
              as its own small button (mini icon + chevron) beside it. */}
          <div className="chart-bar-coin">
            {!heroLogoError ? (
              <img
                className="chart-bar-coin-icon"
                src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                alt=""
                loading="lazy"
                onError={() => setHeroLogoError(true)}
              />
            ) : (
              <span className="chart-bar-coin-icon chart-bar-coin-icon--glyph" style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}>
                {COIN_GLYPHS[coin] ?? coin[0]}
              </span>
            )}
            <span className="chart-bar-coin-text">
              <span className="chart-bar-coin-name">
                {coin}
                <span className="chart-bar-coin-full">{COIN_FULL_NAME[coin] ?? ""}</span>
              </span>
              <span className="chart-bar-coin-price-row">
                {currentPrice !== null && (
                  <span className={`chart-bar-price${dayChangePercent !== null ? (dayChangePercent >= 0 ? " chart-bar-price--up" : " chart-bar-price--down") : ""}`}>
                    {formatLivePrice(currentPrice)}
                  </span>
                )}
                {dayChangePercent !== null && (
                  <span className={`chart-bar-change${dayChangePercent >= 0 ? " up" : " down"}`}>
                    {dayChangePercent >= 0 ? "↑" : "↓"}{Math.abs(dayChangePercent).toFixed(2)}%
                  </span>
                )}
                {coinAgeLabel && <span className="chart-bar-age">{coinAgeLabel}</span>}
              </span>
            </span>
          </div>
          <button
            type="button"
            className="chart-bar-picker"
            onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
            aria-label="Change coin"
            title="Change coin"
          >
            <span className="chart-bar-picker-icon" style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}>
              {COIN_GLYPHS[coin] ?? coin[0]}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
        <span className="chart-bar-divider" />
              <div className="chart-bar-stats">
                {/* 24H change as its own stat (was a line under the price). */}
                <div className="chart-bar-stat">
                  <span className="chart-bar-stat-label">{INTERVAL_SHORT[interval]} Change</span>
                  <span className={`chart-bar-stat-value${dayChangePercent === null ? "" : dayChangePercent >= 0 ? " up" : " down"}`}>
                    {dayChangeAbs !== null && dayChangePercent !== null
                      ? `${dayChangeAbs >= 0 ? "+" : "-"}${formatLivePrice(Math.abs(dayChangeAbs))} / ${dayChangePercent >= 0 ? "+" : ""}${dayChangePercent.toFixed(2)}%`
                      : "—"}
                    {dayChangePercent !== null && (
                      <span className={`chart-bar-arrow ${dayChangePercent >= 0 ? "up" : "down"}`}>{dayChangePercent >= 0 ? "▲" : "▼"}</span>
                    )}
                  </span>
                </div>
                <div className="chart-bar-stat">
                  <span className="chart-bar-stat-label">{INTERVAL_SHORT[interval]} {t("chart.high", "High")}</span>
                  <span className="chart-bar-stat-value">{displayDayHigh !== null ? formatLivePrice(displayDayHigh) : "—"}<span className="chart-bar-arrow up">▲</span></span>
                </div>
                <div className="chart-bar-stat">
                  <span className="chart-bar-stat-label">{INTERVAL_SHORT[interval]} {t("chart.low", "Low")}</span>
                  <span className="chart-bar-stat-value">{displayDayLow !== null ? formatLivePrice(displayDayLow) : "—"}<span className="chart-bar-arrow down">▼</span></span>
                </div>
                {quoteVolume24h !== undefined && (
                  <div className="chart-bar-stat">
                    <span className="chart-bar-stat-label">24h Vol</span>
                    <span className="chart-bar-stat-value">{formatCompactVolume(quoteVolume24h)}</span>
                  </div>
                )}
                {headerStats}
              </div>
            </div>
            <div className="chart-bar-toolbar">
              {quickIntervalPills}
              <span className="chart-bar-toolbar-spacer" />
              {heroIconRow}
            </div>
          </>
          ) : (
          <>
          <div className="chart-header">
            <div className="chart-header-left">
              {/* Fullscreen (mobile/iOS and desktop alike): exchange-style
                  stats grid (High/Low · Bid/Ask · Vol) + price/change
                  line, replacing the name/LIVE/zone-signal/div-badge row
                  entirely — picked over the badge-based header directions
                  above. Only normal (non-fullscreen) mobile/desktop keep
                  the original title row below/further down. */}
              {isFullscreen ? (() => {
                // Advance Price Chart page, mobile — no header row here;
                // coin/price/change now overlay directly on the chart
                // canvas instead (chart-mobile-top-header, rendered inside
                // .chart-canvas-wrap below, same technique the desktop
                // OHLC overlay already uses) so the canvas keeps the full
                // flex height instead of losing a row's worth of space to
                // a header block.
                if (pageMode && !isDesktopWidth) return null;
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
                      className={`chart-fs-coin-name chart-fs-coin-name--compact chart-title-tappable${pageMode ? " chart-title-tappable--plain" : ""}`}
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

                  {/* Advance Price Chart page, mobile — stats move into
                      the dock's new Stats category instead (fsDockSheet
                      below), so the header stays just the compact coin/
                      price/change row and the chart gets the rest of the
                      screen. Desktop fullscreen (and any fallback) keeps
                      the tappable strip + expandable panel as before. */}
                  {!(pageMode && !isDesktopWidth) && (
                  <>
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
                  </>
                  )}
                </div>
                );
              })() : (
                // Identical for mobile and desktop now — same markup,
                // same classes, no separate mobile-only version. The
                // existing responsive CSS (the .chart-header grid is
                // itself min-width:641px-gated, falling back to its
                // base flex-wrap below that) adapts this to width on its
                // own instead of two parallel hand-built layouts drifting
                // apart from each other over time.
                <>
                {/* Reference-match hero rows (compact view only — fullscreen
                    keeps its own header above untouched): small coin-icon +
                    pair-name row, then a big price + rounded %-change badge
                    row below it. currentPrice/dayChangePercent/priceDirection
                    already exist in this component's scope (used by the
                    fullscreen/mobile branches above). */}
                {!isFullscreen && (
                  <div className="chart-hero-id-row">
                    {(() => {
                      const icon = !heroLogoError ? (
                        <img
                          className="chart-hero-coin-icon chart-hero-coin-icon--img"
                          src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                          alt=""
                          loading="lazy"
                          onError={() => setHeroLogoError(true)}
                        />
                      ) : (
                        <span
                          className="chart-hero-coin-icon"
                          style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                        >
                          {COIN_GLYPHS[coin] ?? coin[0]}
                        </span>
                      );
                      // Now the ONE coin switcher on this page, mobile and
                      // desktop alike — App.tsx's own mch-coin-btn (top bar)
                      // is gone, so this is the only entry point left;
                      // same onOpenCoinPicker the Advance Chart page's own
                      // chart-tv-symbol button (above) already opens.
                      return (
                        <button
                          type="button"
                          className="chart-hero-coin-selector"
                          onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                        >
                          {icon}
                          <span className="chart-hero-pair-name">{coin}/USD</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      );
                    })()}
                    {/* Top 5 by market cap, overlapping avatar stack —
                        hover un-overlaps them for an easier target; click
                        one to jump straight to it (onSelectCoin, skips the
                        full picker), or click the trailing "…" to open the
                        full picker (onOpenCoinPicker) same as the main
                        selector button above. */}
                    <div className="chart-hero-top-coins">
                      {TOP5_COINS.map((symbol, i) => (
                        <button
                          key={symbol}
                          type="button"
                          className={`chart-hero-top-coin${symbol === coin ? " chart-hero-top-coin--current" : ""}`}
                          style={{ zIndex: TOP5_COINS.length - i, background: COIN_COLORS[symbol] ?? "var(--pc-accent)" }}
                          onClick={() => onSelectCoin?.(symbol)}
                          title={`Switch to ${symbol}`}
                        >
                          {COIN_GLYPHS[symbol] ?? symbol[0]}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="chart-hero-top-coin chart-hero-top-coin--more"
                        style={{ zIndex: 0 }}
                        onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                        title="More coins"
                      >
                        …
                      </button>
                    </div>
                  </div>
                )}
                <div className="chart-title-row">
                  {!isFullscreen && currentPrice !== null ? (
                    // Same cpv-price-row markup/classes CompactPriceView's
                    // own price display uses — adopted here (price chart's
                    // header), same direction as the icon/LIVE-badge swap,
                    // using this page's own real 24H change instead of
                    // CompactPriceView's separate 1H-window figures.
                    <span className="cpv-price-row">
                      <span className={`cpv-price${dayChangePercent !== null && dayChangePercent >= 0 ? " cpv-up" : " cpv-down"}`}>
                        {formatLivePrice(currentPrice)}
                      </span>
                      {dayChangeAbs !== null && dayChangePercent !== null && (
                        <span className={`cpv-change${dayChangePercent >= 0 ? " cpv-up" : " cpv-down"}`}>
                          {dayChangePercent >= 0 ? "▲" : "▼"} {Math.abs(dayChangePercent).toFixed(2)}%
                          <span className="cpv-change-abs">
                            ({formatLivePrice(Math.abs(dayChangeAbs))})
                          </span>
                          <span className="cpv-change-window">24H</span>
                        </span>
                      )}
                    </span>
                  ) : (
                    <h3>{t("chart.title", { coin: COIN_FULL_NAME[coin] ?? coin })}</h3>
                  )}
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
                  {/* Reference-match: the compact hero stays just
                      icon+name/price+change — zone/divergence signal
                      badges and the High/Low row are real functionality,
                      not deleted, just folded to the fullscreen header
                      only now so the compact card matches the reference's
                      clean, minimal look. */}
                  {isFullscreen && zone && isPaid && zoneLabel && (
                    <SignalIndicator signal={zone.signal} label={zoneLabel} />
                  )}
                  {isFullscreen && !isPaid && (
                    <button
                      className={`zone-signal-gate zone-signal-gate--${zone?.signal ?? "neutral"}`}
                      onClick={() => onOpenUpgrade?.("pro")}
                    >
                      <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-${zone?.signal ?? "neutral"}`} />
                      Unlock Status
                    </button>
                  )}
                  {isFullscreen && divergence && isPaid && (
                    <span className={`div-badge div-badge--${divergence.type}`}>
                      {divergence.type === "bullish" ? "↑ Bull Div" : "↓ Bear Div"}
                    </span>
                  )}
                  {isFullscreen && !isPaid && (
                    <button
                      className={`zone-signal-gate zone-signal-gate--div-${divergence?.type ?? "neutral"}`}
                      onClick={() => onOpenUpgrade?.("pro")}
                    >
                      <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-div-${divergence?.type ?? "neutral"}`} />
                      Unlock Divergence
                    </button>
                  )}
                </div>
                {displayDayHigh !== null && displayDayLow !== null && (
                  <div className="chart-fs-stat-col">
                    <div className="chart-fs-stat-col chart-fs-stat-col--row">
                      {!isFullscreen && (
                        <span className="chart-hero-selected-interval">{INTERVAL_SHORT[interval]}</span>
                      )}
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("chart.high", "High")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--up">{formatLivePrice(displayDayHigh)}</span>
                      </div>
                      <div className="chart-fs-stat-row">
                        <span className="chart-fs-stat-label">{t("chart.low", "Low")}</span>
                        <span className="chart-fs-stat-value chart-fs-stat-value--down">{formatLivePrice(displayDayLow)}</span>
                      </div>
                      {!isFullscreen && quoteVolume24h !== undefined && (
                        <div className="chart-fs-stat-row">
                          {/* Mobile/iOS only — small coin icon ahead of the
                              label, same icon/fallback pattern as the hero
                              row above (.chart-hero-coin-icon). */}
                          {!isDesktopWidth && (
                            !heroLogoError ? (
                              <img
                                className="chart-fs-stat-coin-icon"
                                src={`https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
                                alt=""
                                loading="lazy"
                                onError={() => setHeroLogoError(true)}
                              />
                            ) : (
                              <span
                                className="chart-fs-stat-coin-icon chart-fs-stat-coin-icon--fallback"
                                style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                              >
                                {COIN_GLYPHS[coin] ?? coin[0]}
                              </span>
                            )
                          )}
                          <span className="chart-fs-stat-label">{t("chart.vol24h", "24hr vol")}</span>
                          <span className="chart-fs-stat-value">{formatCompactVolume(quoteVolume24h)}</span>
                        </div>
                      )}
                    </div>
                    {/* Zone status + divergence badges moved into the AI
                        insight banner's header below (interval-banner-
                        header) instead of living here too — same data,
                        one place. Free users (no banner at all) still get
                        the upsell gates here. */}
                    {!isFullscreen && !isPaid && (
                      <div className="chart-fs-stat-col chart-fs-stat-col--row chart-hero-zone-row">
                        <button
                          className={`zone-signal-gate zone-signal-gate--${zone?.signal ?? "neutral"}`}
                          onClick={() => onOpenUpgrade?.("pro")}
                        >
                          <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-${zone?.signal ?? "neutral"}`} />
                          Unlock Status
                        </button>
                        <button
                          className={`zone-signal-gate zone-signal-gate--div-${divergence?.type ?? "neutral"}`}
                          onClick={() => onOpenUpgrade?.("pro")}
                        >
                          <span className={`zone-signal-live zone-signal-live--gate zone-signal-live--gate-div-${divergence?.type ?? "neutral"}`} />
                          Unlock Divergence
                        </button>
                      </div>
                    )}
                  </div>
                )}
                </>
              )}
            </div>
            {/* Mobile only — headerStats (.mch-body/.mch-stats) moves up
                here, above chart-header-right (the pills/icon row right
                below), instead of its usual spot after .chart-header
                closes entirely (still that spot on desktop, below). */}
            {!isDesktopWidth && headerStats}
            {/* Reference-match: pills + icon buttons sit beside the coin-
                name/price rows (a 2x2 grid on desktop — name/pills on top,
                price/icons below; the grid CSS itself is min-width:641px-
                gated, so this just stacks below 641px instead). Mobile and
                desktop both now, identical markup; reuses the exact same
                handlers/components (quickIntervalPills, indicatorsControl,
                gridStyleControls, handleScreenshot, toggleFullscreen) the
                old below-header row used, so nothing is duplicated —
                that row's own copies are hidden for this exact scope
                just below (search chart-legend-actions). */}
            {!isFullscreen && (
              <div className="chart-header-right">
                {/* Mobile web/iOS: moved below the chart, merged with the
                    fullscreen button into one row (see
                    chart-mobile-interval-fs-row, right after
                    .chart-dblclick-wrap closes) — desktop keeps both here. */}
                {isDesktopWidth && quickIntervalPills}
                {heroIconRow}
                {/* Mobile's own separate row — the text link this control
                    used to be before it was folded into chart-hero-icon-
                    row (desktop only now, above) as a bare icon. */}
                {!isDesktopWidth && (
                  <button
                    type="button"
                    className="chart-compact-link"
                    onClick={() => {
                      if (showCompactView) { setShowCompactView(false); return; }
                      if (!isPaid) { onOpenUpgrade?.("pro"); return; }
                      setShowCompactView(true);
                    }}
                  >
                    {!showCompactView ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="8" y1="3" x2="8" y2="21" />
                        <rect x="6" y="8" width="4" height="8" rx="1" fill="currentColor" stroke="none" />
                        <line x1="16" y1="5" x2="16" y2="19" />
                        <rect x="14" y="9" width="4" height="7" rx="1" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                        <path d="M15.21 8.17 A5 5 0 0 1 15.21 15.83" />
                        <path d="M8.79 8.17 A5 5 0 0 0 8.79 15.83" />
                        <path d="M17.14 5.87 A8 8 0 0 1 17.14 18.13" />
                        <path d="M6.86 5.87 A8 8 0 0 0 6.86 18.13" />
                        <path d="M19.07 3.57 A11 11 0 0 1 19.07 20.43" />
                        <path d="M4.93 3.57 A11 11 0 0 0 4.93 20.43" />
                      </svg>
                    )}
                    <span>{showCompactView ? t("chart.switchToFull", "Switch to Full Chart") : t("chart.switchToCompact", "Switch to Compact View")}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {isDesktopWidth && headerStats}
          </>
          )}

        </div>
        </>
        )}

        {patternInsightSheetOpen && displayBanner && ReactDOM.createPortal(
          <>
            <div className="interval-sheet-backdrop" onClick={() => setPatternInsightSheetOpen(false)} />
            <div className="interval-sheet pattern-insight-sheet">
              <div className="interval-sheet-header">
                <span className={`interval-sheet-title pattern-insight-sheet-title pattern-insight-sheet-title--${displayBanner.sentiment}`}>
                  {displayBanner.title}
                </span>
                <button type="button" className="interval-sheet-close" onClick={() => setPatternInsightSheetOpen(false)}>✕</button>
              </div>
              <div className="pattern-insight-sheet-meta">
                {bannerAt !== null && (
                  <span className="pattern-insight-updated">
                    {t("chart.lastUpdated", "Updated")} {formatClockTime(bannerAt)}
                  </span>
                )}
                <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
                <span className="pattern-insight-ai-badge pattern-insight-ai-badge--pill">{t("chart.aiPowered")}</span>
              </div>
              <p className="pattern-insight-sheet-body">{displayBanner.body}</p>
            </div>
          </>,
          document.body,
        )}

        {/* Free-user AI upsell: one combined banner, under the chart
            (below), instead of one here and another one there. */}

        <div
          style={
            pageMode && !isDesktopWidth
              ? // Direct child of .price-chart-fs-scroll (the actual flex
                // container) — this is the element that needs flex:1, not
                // .chart-canvas-wrap below, which is nested one level
                // deeper inside here and isn't a flex item of anything.
                { position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }
              : { position: "relative" }
          }
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
            {/* "Compact" side of the Full/Compact switch above — covers
                just this chart area (not the header/switch themselves,
                both outside .chart-dblclick-wrap) instead of the old
                full-viewport portal takeover, so switching feels like
                swapping the chart in place rather than leaving the page.
                Mobile and desktop compact both use this now — only
                fullscreen/pageMode still get the standalone modal. */}
            {showCompactView && !pageMode && !isFullscreen && (
              <div className="chart-compact-inline">
                <CompactPriceView inline coin={coin} theme={theme} onClose={() => setShowCompactView(false)} />
              </div>
            )}
            {/* Advance Price Chart page, mobile — this whole icon row
                (Save/Reset/depth/Exit-fullscreen etc.) moves into the
                dock's peek row instead (fsDockSheet below), so the chart
                gets the space back. Desktop fullscreen keeps it.
                Compact (non-fullscreen, non-pageMode) also skips this row
                now, mobile AND desktop — its equivalent (style/indicators/
                interval pills + save/fullscreen) moved up into
                .chart-header-right, identical reference-match layout
                either width. pageMode desktop (the dedicated Advance
                Chart page) also skips it — its own equivalent moved into
                the new top toolbar (.chart-tv-toolbar, TradingView-
                reference-match) instead, so there's one toolbar row,
                not two. */}
            {!(pageMode && !isDesktopWidth) && !(!isFullscreen && isDesktopWidth) && !(pageMode && isDesktopWidth) && !(!pageMode && !isFullscreen) && (
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
                  // OrderBookProfileModal (below) is a self-contained
                  // full-screen modal of its own — it never actually
                  // needed the CHART to also be fullscreen. That old
                  // coupling meant tapping this on the compact chart now
                  // navigated to the Advance Price Chart page instead of
                  // just opening the depth panel, since entering
                  // fullscreen there means a real page navigation.
                  setShowDepthProfile((v) => !v);
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
                    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
                    <path d="M15.21 8.17 A5 5 0 0 1 15.21 15.83" />
                    <path d="M8.79 8.17 A5 5 0 0 0 8.79 15.83" />
                    <path d="M17.14 5.87 A8 8 0 0 1 17.14 18.13" />
                    <path d="M6.86 5.87 A8 8 0 0 0 6.86 18.13" />
                    <path d="M19.07 3.57 A11 11 0 0 1 19.07 20.43" />
                    <path d="M4.93 3.57 A11 11 0 0 0 4.93 20.43" />
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
            )}
          {loading && (
            <div className="chart-loading-overlay">
              <span className="chart-loading-label">
                {t("chart.loading")}
                <svg
                  className="chart-loading-line"
                  viewBox="0 0 28 14"
                  width="28"
                  height="14"
                  fill="none"
                >
                  <path
                    pathLength={1}
                    d="M1,11 L6,8 L10,10 L14,4 L18,7 L22,3 L27,6"
                  />
                </svg>
              </span>
            </div>
          )}
          {!loading && error && lastCandlesRef.current.length === 0 && (
            <div className="chart-error">⚠️ {error}</div>
          )}
          <div
            ref={containerRef}
            className="chart-canvas-wrap chart-main-wrap"
            style={
              pageMode
                ? // Advance Price Chart page (mobile AND desktop) —
                  // flex-fill instead of a fixed viewport-relative height
                  // (.price-chart-fs-scroll is a flex column for this case,
                  // see PriceChart.css — desktop now matches mobile's own
                  // treatment here instead of being a scrolling page). The
                  // chart gets exactly whatever's left after the header/
                  // toolbar, so the whole page fits in one viewport with
                  // no scroll, instead of a guessed pixel height that goes
                  // stale every time the header's own content changes.
                  { width: "100%", flex: "1 1 auto", minHeight: 0 }
                : {
                    width: "100%",
                    height: isFullscreen
                      ? (isDesktopWidth ? "calc(100vh - 200px)" : "calc(100vh - 260px)")
                      : "400px",
                  }
            }
          />
          {/* Reference-match (TradingView desktop chart) — interval-range
              bar docked at the bottom of the page instead of only living
              in the top toolbar's single pill, same real intervals/pro-
              gating the rest of the app already uses. flex-shrink:0 (see
              PriceChart.css) keeps this a fixed-height row while the
              chart canvas above it (flex:1) does all the shrinking. */}
          {/* Range presets bar (desktop — Chart page AND the Advance
              Chart page, where it replaced the old interval-pill bottom
              bar; intervals are still in the top toolbar there).
              TradingView-style: each button switches the candle interval
              and zooms the view to that span. Hover shows what it means. */}
          {isDesktopWidth && (
            <div className={`chart-range-bar${pageMode ? " chart-range-bar--page" : ""}`}>
              {RANGE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.key}
                  className={`chart-range-btn${activeRangePreset?.key === p.key ? " active" : ""}`}
                  data-tip={p.tip}
                  aria-label={p.tip}
                  onClick={() => {
                    setRangePreset(p.key);
                    if (interval === p.interval) {
                      // Same interval — no reload coming, so zoom right now.
                      const candles = lastCandlesRef.current;
                      if (candles.length) {
                        const to = candles[candles.length - 1].time as number;
                        chartRef.current?.timeScale().setVisibleRange({
                          from: (to - p.seconds) as UTCTimestamp,
                          to: to as UTCTimestamp,
                        });
                      }
                    } else {
                      // Different interval — the normal load path applies
                      // the preset's window via viewWindowFor() on first
                      // load for the new coin+interval.
                      rangeSecondsRef.current = { interval: p.interval, seconds: p.seconds };
                      setInterval(p.interval);
                    }
                  }}
                >
                  {p.label}
                </button>
              ))}
              <span className="chart-range-divider" />
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--icon${goToOpen ? " active" : ""}`}
                data-tip="Go to date or custom range"
                aria-label="Go to date or custom range"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setGoToOpen((o) => !o)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <path d="M16 2v4M8 2v4M3 10h18" />
                  <path d="M10 15h7M14 12l3 3-3 3" />
                </svg>
              </button>
              {goToOpen && (
                <ChartGoTo
                  onClose={() => setGoToOpen(false)}
                  onGoToDate={goToDate}
                  onGoToRange={goToRange}
                />
              )}
              <span className="chart-range-spacer" />
              <RangeBarClock />
              <span className="chart-range-divider" />
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--scale${scaleMode === "percent" ? " active" : ""}`}
                data-tip="Percentage scale"
                aria-pressed={scaleMode === "percent"}
                onClick={() => setScaleMode((m) => (m === "percent" ? "normal" : "percent"))}
              >
                %
              </button>
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--scale${scaleMode === "log" ? " active" : ""}`}
                data-tip="Logarithmic scale"
                aria-pressed={scaleMode === "log"}
                onClick={() => setScaleMode((m) => (m === "log" ? "normal" : "log"))}
              >
                log
              </button>
              <button
                type="button"
                className={`chart-range-btn chart-range-btn--scale${autoScale ? " active" : ""}`}
                data-tip="Auto-fit price axis to visible candles"
                aria-pressed={autoScale}
                onClick={() => setAutoScale((a) => !a)}
              >
                auto
              </button>
            </div>
          )}
          {!pageMode && isDesktopWidth && (
            <div
              ref={crosshairTooltipRef}
              className="chart-crosshair-tooltip"
              style={{ opacity: 0 }}
            >
              <span className="chart-crosshair-tooltip-date" />
              <span className="chart-crosshair-tooltip-price" />
            </div>
          )}
          {/* Reference-match (TradingView desktop chart): OHLC readout +
              Buy/Sell boxes overlaid on the chart canvas's own top-left
              corner, replacing the old separate header row (collapsed
              above via chart-fs-header-group--empty). Real data — the
              latest loaded candle's own open/high/low/close, not
              placeholder numbers; "Sell"/"Buy" open the real TradingAgent
              panel (same .ta-trigger reuse as the toolbar's own Trade
              button) since this app has no literal order-ticket feature
              to back a real buy/sell action here. */}
          {pageMode && isDesktopWidth && (() => {
            const lastCandle = lastCandlesRef.current[lastCandlesRef.current.length - 1];
            if (!lastCandle) return null;
            const live = currentPrice ?? lastCandle.close;
            const changeUp = (dayChangeAbs ?? 0) >= 0;
            return (
              <div className="chart-tv-ohlc-overlay">
                <div className="chart-tv-ohlc-row">
                  <span
                    className="chart-tv-ohlc-icon"
                    style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                  >
                    {COIN_GLYPHS[coin] ?? coin[0]}
                  </span>
                  <span className="chart-tv-ohlc-title">
                    {COIN_FULL_NAME[coin] ?? coin} / U.S. Dollar · {INTERVAL_SHORT[interval]} · CRYPTO
                  </span>
                  <span className={`chart-tv-ohlc-dot${changeUp ? " up" : " down"}`} />
                  <span className="chart-tv-ohlc-values">
                    O<b>{formatLivePrice(lastCandle.open)}</b>{" "}
                    H<b>{formatLivePrice(lastCandle.high)}</b>{" "}
                    L<b>{formatLivePrice(lastCandle.low)}</b>{" "}
                    <span className={changeUp ? "chart-tv-ohlc-up" : "chart-tv-ohlc-down"}>
                      C<b>{formatLivePrice(live)}</b>{" "}
                      {dayChangeAbs !== null && dayChangePercent !== null && (
                        <>
                          {changeUp ? "+" : ""}{dayChangeAbs.toFixed(2)} ({changeUp ? "+" : ""}{dayChangePercent.toFixed(2)}%)
                        </>
                      )}
                    </span>
                  </span>
                </div>
                <div className="chart-tv-ticket-row">
                  <button
                    type="button"
                    className="chart-tv-sell-box"
                    onClick={() => document.querySelector<HTMLButtonElement>(".ta-trigger")?.click()}
                  >
                    <span className="chart-tv-ticket-price">{formatLivePrice(live)}</span>
                    <span className="chart-tv-ticket-label">SELL</span>
                  </button>
                  <span className="chart-tv-ticket-mid">0.00</span>
                  <button
                    type="button"
                    className="chart-tv-buy-box"
                    onClick={() => document.querySelector<HTMLButtonElement>(".ta-trigger")?.click()}
                  >
                    <span className="chart-tv-ticket-price">{formatLivePrice(live)}</span>
                    <span className="chart-tv-ticket-label">BUY</span>
                  </button>
                </div>
              </div>
            );
          })()}
          {/* Reference-match (TradingView mobile full chart) — coin icon/
              name + live pill + price/%-change, overlaid directly on the
              canvas the same way the desktop OHLC overlay above is
              (.chart-fs-header-group is collapsed to empty for this page
              now, same as desktop pageMode already was), instead of
              taking its own row and shrinking the chart's available
              height. */}
          {pageMode && !isDesktopWidth && (
            <div className="chart-mobile-top-header">
              <div className="chart-mobile-top-row">
                <span
                  className="chart-mobile-top-icon"
                  style={{ background: COIN_COLORS[coin] ?? "var(--pc-accent)" }}
                >
                  {COIN_GLYPHS[coin] ?? coin[0]}
                </span>
                <span className="chart-mobile-top-name">{COIN_FULL_NAME[coin] ?? coin} / U.S. Dollar</span>
                <span className="chart-mobile-top-live" aria-hidden="true" />
              </div>
              {currentPrice !== null && (
                <div className="chart-mobile-top-price-row">
                  <span className="chart-mobile-top-price">{formatLivePrice(currentPrice)}</span>
                  {dayChangeAbs !== null && dayChangePercent !== null && (
                    <span className={`chart-mobile-top-change${dayChangePercent >= 0 ? " chart-mobile-top-change--up" : " chart-mobile-top-change--down"}`}>
                      {dayChangePercent >= 0 ? "+" : "-"}{formatLivePrice(Math.abs(dayChangeAbs))} ({dayChangePercent >= 0 ? "+" : ""}{dayChangePercent.toFixed(2)}%)
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          {pageMode && !isDesktopWidth && (
            <button
              type="button"
              className="chart-mobile-top-close"
              onClick={() => { hapticTap(); toggleFullscreen(); }}
              aria-label={t("chart.close", "Close")}
              title={t("chart.close", "Close")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
          <PredictionOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            prediction={predictionPath}
          />
          <RoundedCandleOverlay
            chartRef={chartRef}
            seriesRef={candleRef}
            candlesRef={lastCandlesRef}
            upColor="#4ade80"
            downColor="#fb7185"
            style={chartStyle === "hollow" ? "hollow" : chartStyle === "heikinAshi" ? "heikinAshi" : "candle"}
            generation={chartGeneration}
            visible={chartStyle !== "line"}
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
            onEventsChange={onChartEventsChange}
          />
          <ChartDrawingTools
            ref={drawingToolsRef}
            chartRef={chartRef}
            seriesRef={candleRef}
            containerRef={containerRef}
            candlesRef={lastCandlesRef}
            visible={pageMode && !isDesktopWidth ? fsDrawPanelOpen : isFullscreen}
            persistRef={drawingsPersistRef}
            onZoneComplete={handleZoneComplete}
            onSave={pageMode && !isDesktopWidth ? handleScreenshot : undefined}
            // Desktop pageMode's own Reset moved next to Save in the top
            // toolbar (.chart-tv-toolbar-right) instead of living here —
            // mobile keeps it in this rail, unchanged.
            onReset={pageMode && !isDesktopWidth ? handleResetView : undefined}
            fullHeightRail={pageMode && isDesktopWidth}
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

        {/* Mobile web/iOS only — desktop keeps both of these up in
            .chart-header-right instead (see isDesktopWidth guards there).
            Same quickIntervalPills constant, just relocated + the
            fullscreen button merged onto its trailing end as one row.
            Also suppressed for forceHideHeader (MobileSymbolSheet) — that
            embed has its own mss-interval-row + Full Chart button already. */}
        {!isFullscreen && !isDesktopWidth && !forceHideHeader && (
          <div className="chart-mobile-interval-fs-row">
            {quickIntervalPills}
            <button
              type="button"
              className="chart-depth-btn chart-mobile-interval-fs-btn"
              onClick={toggleFullscreen}
              title={t("chart.fullscreen", "Fullscreen")}
              data-tooltip={t("chart.fullscreen", "Fullscreen")}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </button>
          </div>
        )}

        <div ref={eventCardsSlotRef} />

        {fsDockSheet}
        {intervalSheetPortal}

        {showDepthProfile && (
          <OrderBookProfileModal
            coin={coin}
            onClose={() => setShowDepthProfile(false)}
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
                  <span className="cap-overlay-title">AI Chart Read</span>
                  <span className="cap-overlay-ai-badge">AI</span>
                  <span className="cap-overlay-tier-badge">PRO</span>
                  <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
                </div>
                <div className="cap-overlay-features">
                  {/* Both former banners' features, in one list. */}
                  {[
                    "Interval sentiment & trend context",
                    "Candlestick pattern recognition",
                    "Bullish / bearish confidence score",
                    "Next-move predictions & outlook",
                  ].map(f => (
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
        ) : !aiReadOpen ? (
          // On request: nothing is generated or shown until the viewer asks
          // for it — the pattern AI call (which spends AI quota) only runs
          // from here, not on every chart load.
          <button type="button" className="ai-read-cta" onClick={openAiRead}>
            <span className="ai-read-cta-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" />
              </svg>
            </span>
            <span className="ai-read-cta-text">
              <span className="ai-read-cta-title">AI Chart Read</span>
              <span className="ai-read-cta-sub">Trend bias + candlestick pattern for {coin} {INTERVAL_SHORT[interval]}</span>
            </span>
            <span className="ai-read-cta-btn">Analyze</span>
          </button>
        ) : (displayPatternInsight || (displayBanner && !isFullscreen)) ? (
          <div className={`ai-read ai-read--${displayBanner?.sentiment ?? displayPatternInsight?.type ?? "neutral"}`}>
            <div className="ai-read-head">
              <span className="ai-read-head-title">
                <span className="ai-read-spark">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z" /></svg>
                </span>
                AI Chart Read
                <span className="ai-read-head-ctx">{coin} · {INTERVAL_SHORT[interval]}</span>
              </span>
              <span className="ai-read-head-right">
                {(bannerAt ?? patternInsightAt) !== null && (
                  <span className="ai-read-updated">
                    {t("chart.lastUpdated", "Updated")} {formatClockTime((bannerAt ?? patternInsightAt) as number)}
                  </span>
                )}
                <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
                <button type="button" className="ai-read-close" aria-label="Hide AI Chart Read" onClick={() => setAiReadOpen(false)}>✕</button>
              </span>
            </div>

            <div className="ai-read-body">
              {displayBanner && !isFullscreen && (
                <div
                  className={`ai-read-col ai-read-trend${isDesktopWidth ? "" : " interval-banner--tappable"}`}
                  role={isDesktopWidth ? undefined : "button"}
                  tabIndex={isDesktopWidth ? undefined : 0}
                  onClick={isDesktopWidth ? undefined : () => setPatternInsightSheetOpen(true)}
                  onKeyDown={isDesktopWidth ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") setPatternInsightSheetOpen(true); }}
                >
                  <span className="ai-read-label">Trend</span>
                  <span className={`ai-read-chip ai-read-chip--${displayBanner.sentiment}`}>
                    {displayBanner.sentiment === "bullish" ? "▲" : displayBanner.sentiment === "bearish" ? "▼" : "●"} {displayBanner.title}
                  </span>
                  <p className="ai-read-text pi-fade-in">{displayBanner.body}</p>
                  {zoneDivergenceSentence && (
                    <p className={`ai-read-note chart-hero-zone-sentence--${intervalSignal ?? divergence?.type ?? "neutral"}`}>
                      {zoneDivergenceSentence}
                    </p>
                  )}
                </div>
              )}
              {displayPatternInsight && (
                <div className="ai-read-col ai-read-pattern">
                  <span className="ai-read-label">Pattern</span>
                  <span className={`ai-read-chip ai-read-chip--${displayPatternInsight.type}`}>
                    {displayPatternInsight.name}
                  </span>
                  <p key={`summary-${displayPatternInsight.name}`} className="ai-read-summary pi-fade-in">
                    {displayPatternInsight.summary}
                  </p>
                  <p key={`narrative-${displayPatternInsight.name}`} className="ai-read-text pi-fade-in pi-fade-in--d1">
                    {displayPatternInsight.narrative}
                  </p>
                </div>
              )}
            </div>

            {displayPatternInsight && (
              <div className="ai-read-next">
                <span className="ai-read-next-label">{t("chart.nextMove")}</span>
                <p key={`nextmove-${displayPatternInsight.name}`} className="ai-read-next-text pi-fade-in pi-fade-in--d2">
                  {displayPatternInsight.nextMove}
                </p>
              </div>
            )}
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

      {sideColumn && !isFullscreen && <aside className="pcc-side">{sideColumn}</aside>}

      {/* #chart (compact, non-fullscreen) renders its own inline version
          above instead (chart-compact-inline), mobile and desktop both —
          this modal only stays for pageMode/fullscreen now. */}
      {showCompactView && !(!pageMode && !isFullscreen) && (
        <CompactPriceView coin={coin} theme={theme} onClose={() => setShowCompactView(false)} />
      )}

      {/* Watchlist/TopMoversCarousel (App.tsx) — rendered here, inside
          .price-chart-container itself, below the chart but outside the
          fullscreen/scroll wrapper above, so fullscreen mode doesn't drag
          them along with it. */}
      {!isFullscreen && children}
    </div>
  );
};
