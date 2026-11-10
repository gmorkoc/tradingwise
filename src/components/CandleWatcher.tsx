import { Fragment, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { createChart, IChartApi, ISeriesApi, IPriceLine, CandlestickData, ColorType, LineStyle, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers, ISeriesMarkersPluginApi, SeriesMarker, UTCTimestamp, PriceScaleMode } from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol, getMacroContext, MacroContextData, fetchBn, Ticker24h, COINS, MAX_RANGE_CANDLES } from "../services/coinglass";
import { calcEMA, calcRSI, calcRSIArray, calcMACD, calcTEMA, calcBB, calcATR, calcVolRatio } from "../services/indicators";
import { openai, callOpenAI, PredictionResponse } from "../services/openai";
import { fetchFearGreed } from "../services/feargreed";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import { BlurGate } from "./MembershipGate";
import { useAuth } from "../contexts/AuthContext";
import { hasAccess } from "../services/supabase";
import { MMNarrationFeed, MMFeedEntry } from "./MMNarrationFeed";
import { COIN_COLORS, COIN_GLYPHS, RangeBarClock } from "./PriceChart";
import { BottomSheet } from "./BottomSheet";
import { IndicatorPicker, type PickerItem } from "./IndicatorPicker";
import { useChartIndicators, useIndicatorSelection } from "../hooks/useChartIndicators";
import { useLiveKline } from "../hooks/useLiveKline";
import { getIndicatorDef } from "../services/customIndicators";
import { RoundedCandleOverlay } from "./DrawingOverlay";
import { PatternHighlight } from "./PatternHighlight";
import { ChartPatternOverlay } from "./ChartPatternOverlay";
import { addPriceAlert, hasPriceAlert, removePriceAlert, pruneServerTriggered, PRICE_ALERTS_EVENT } from "../services/priceAlertStore";
import { isPushAvailable, completePushPriming } from "../services/pushNotifications";
import { isWebPushAvailable, isWebPushSubscribed, subscribeWebPush } from "../services/webPush";
import { FirebaseMessaging } from "@capacitor-firebase/messaging";
import { detectChartPatterns, type PBar, type ChartPattern } from "../utils/chartPatterns";
import { ChartDrawingTools, Drawing } from "./ChartDrawingTools";
import "../styles/CandleWatcher.css";

// Translated text for helpers outside the component (generated sentences,
// pattern names). Keys live in src/locales/extra/<lang>/candleInsights.json.
const T = (k: string, o?: Record<string, unknown>): string => i18next.t(`candleInsights.${k}`, o) as string;
/** Translation key for an English name, e.g. "Bullish Engulfing" → "BullishEngulfing". */
const tKey = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  coin: CoinSymbol | string;
  theme: "dark" | "light";
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  onReady?: () => void;
  refreshTrigger?: number;
  visible?: boolean;
  // Real 24h High/Low/Volume — App.tsx's own coinTickers Map (fetchCoin24hTickers),
  // the same source PriceChart.tsx's chart-hero stat row reads from; candles
  // alone can't give this (lastPrice below is derived from whatever
  // interval's candles are selected, not a fixed 24h window).
  ticker?: Ticker24h;
  /** Opens App's coin picker (same one the Trade chart uses). */
  onOpenCoinPicker?: (anchor: HTMLElement) => void;
}

// "FORECAST · BULLISH · WEAK" chart badge — off; it overlapped the coin name.
const SHOW_FORECAST_BADGE: boolean = false;

type Interval = { label: string; value: string; refresh: number; limit: number; durationSec: number; nextClose?: (nowSec: number) => number };

interface Indicators {
  rsi: number | null;
  stochK: number | null;         // Stochastic RSI %K (0–100)
  stochD: number | null;         // Stochastic RSI %D (0–100)
  macdLine: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbPct: number | null;          // 0–1 where price sits in band
  bbUpper: number | null;
  bbLower: number | null;
  volRatio: number | null;       // last closed candle's vol / 20-period avg
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  atr: number | null;
  support: number[];
  resistance: number[];
}

interface Pattern {
  name: string;
  type: "bullish" | "bearish" | "neutral";
  emoji: string;
  desc: string;
}

interface AIRead {
  pattern: string;
  patternType: "bullish" | "bearish" | "neutral";
  mmReading: string;
  mmAction:
    | "liquidity_grab"
    | "stop_hunt"
    | "accumulation"
    | "distribution"
    | "breakout"
    | "retest"
    | "consolidation"
    | "continuation"
    | "reversal";
  nextMove: string;
  keyLevels: { label: string; price: number; side: "above" | "below" }[];
  bias: "bullish" | "bearish" | "neutral";
  confidence: "high" | "medium" | "low";
  scenario: {
    headline: string;          // 1 bold sentence — the dominant likely outcome
    bullCase: string;          // what happens if buyers win
    bearCase: string;          // what happens if sellers win
    trigger: string;           // the specific price event / level that decides it
    probability: "bulls favored" | "bears favored" | "50/50";
  };
}

// ── Intervals ─────────────────────────────────────────────────────────────────
// Structure analysis + AI inputs use at most this many recent candles, even
// when a date range loads more history for the chart.
const CW_ANALYSIS_WINDOW = 300;

const INTERVALS: Interval[] = [
  { label: "15m", value: "15m", refresh: 60_000,   limit: 100, durationSec: 900     },
  { label: "1h",  value: "1h",  refresh: 300_000,  limit: 100, durationSec: 3_600   },
  { label: "4h",  value: "4h",  refresh: 600_000,  limit: 100, durationSec: 14_400  },
  { label: "8h",  value: "8h",  refresh: 900_000,  limit: 100, durationSec: 28_800  },
  { label: "1d",  value: "1d",  refresh: 1800_000, limit: 100, durationSec: 86_400  },
  { label: "1w",  value: "1w",  refresh: 3600_000, limit: 100, durationSec: 604_800 },
  { label: "1M",  value: "1d",  refresh: 3600_000, limit: 30,  durationSec: 86_400,
    nextClose: (nowSec) => {
      const d = new Date(nowSec * 1000);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
    },
  },
];

// Mobile toolbar: quick intervals shown inline (the rest via ⌄), like the
// Trade page chart. Labels match it: minutes lowercase, the rest upper.
const CW_QUICK_IVS = ["15m", "1h", "4h", "1d"];
const cwIvShort = (l: string) => (l.endsWith("m") && l !== "1M" ? l : l.toUpperCase());
const CW_RANGES = [["1D", "1 day", 86400], ["1W", "1 week", 7 * 86400], ["1M", "1 month", 30 * 86400], ["3M", "3 months", 90 * 86400], ["1Y", "1 year", 365 * 86400], [null, "Default view", null]] as const;
const CW_LAYERS = [
  ["ema", "EMA 20 / 50", "#38bdf8"],
  ["bb", "Bollinger Bands", "#6366f1"],
  ["volume", "Volume", "#94a3b8"],
  ["ict", "Smart Money levels (OB, FVG, BOS)", "#ef4444"],
  ["retests", "Retests", "#22c55e"],
  ["patterns", "Candle patterns & Wyckoff", "#f59e0b"],
  ["divergence", "RSI divergences", "#a855f7"],
] as const;

function fmtCountdown(sec: number): string {
  if (sec <= 0) return T("closing");
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) { const m = Math.floor(sec / 60); const s = sec % 60; return `${m}m ${String(s).padStart(2,"0")}s`; }
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2,"0")}m`;
}

// Remaining time until the next UTC candle close for a given interval.
function fmtTabBadge(iv: Interval, nowSec: number): string {
  const nextCloseSec = iv.nextClose ? iv.nextClose(nowSec) : Math.ceil(nowSec / iv.durationSec) * iv.durationSec;
  const remaining = nextCloseSec - nowSec;
  if (remaining <= 0) return T("closing");
  if (remaining < 60) return `${remaining}s`;
  if (remaining < 3600) return `${Math.floor(remaining / 60)}m`;
  const h = Math.floor(remaining / 3600); const m = Math.floor((remaining % 3600) / 60);
  return `${h}h ${String(m).padStart(2,"0")}m`;
}

function fmtCountdownFull(sec: number): string {
  if (sec <= 0) return T("closing");
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,"0")}m ${String(s).padStart(2,"0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2,"0")}s`;
  return `${s}s`;
}

function dailyCloseInsight(o: number, h: number, l: number, c: number, pct: number): string {
  const range  = h - l || 1;
  const body   = Math.abs(c - o);
  const bodyPct = body / range;
  const upperWick = (h - Math.max(o, c)) / range;
  const lowerWick = (Math.min(o, c) - l) / range;
  const bull = c >= o;
  const mag  = Math.abs(pct);

  const bodyTxt = (bodyPct*100).toFixed(0), p = pct.toFixed(2);
  if (bull) {
    if (bodyPct > 0.7)  return T("daily.bullDominant", { pct: bodyTxt });
    if (upperWick > 0.4) return T("daily.bullUpperWick");
    if (lowerWick > 0.4) return T("daily.bullLowerWick");
    if (mag > 3) return T("daily.bullStrong", { pct: p });
    return T("daily.bullModest", { pct: p });
  } else {
    if (bodyPct > 0.7)  return T("daily.bearDominant", { pct: bodyTxt });
    if (lowerWick > 0.4) return T("daily.bearLowerWick");
    if (upperWick > 0.4) return T("daily.bearUpperWick");
    if (mag > 3) return T("daily.bearHeavy", { pct: p });
    return T("daily.bearMild", { pct: p });
  }
}

// ── Indicator math ────────────────────────────────────────────────────────────
// calcEMA/calcRSI/calcRSIArray/calcMACD/calcTEMA/calcBB/calcATR/calcVolRatio
// now live in ../services/indicators.ts (shared with Strategy Alerts).

type DivMarker = { time: number; type: "bull" | "bear" };

function findSRLevels(data: CandleDataPoint[], swing = 4): { supports: number[]; resistances: number[] } {
  const supports: number[] = [], resistances: number[] = [];
  for (let i = swing; i < data.length - swing; i++) {
    const lo = data[i].low, hi = data[i].high;
    if (data.slice(i - swing, i).every(c => c.low >= lo) && data.slice(i + 1, i + swing + 1).every(c => c.low >= lo))
      supports.push(lo);
    if (data.slice(i - swing, i).every(c => c.high <= hi) && data.slice(i + 1, i + swing + 1).every(c => c.high <= hi))
      resistances.push(hi);
  }
  return { supports, resistances };
}

function nearSR(candle: CandleDataPoint, supports: number[], resistances: number[], tol = 0.006): boolean {
  const check = (levels: number[], price: number) => levels.some(l => Math.abs(price - l) / l < tol);
  return check(supports, candle.low) || check(resistances, candle.high);
}

function detectRSIDivergences(candles: CandleDataPoint[], swing = 5): DivMarker[] {
  if (candles.length < swing * 2 + 20) return [];
  const rsi = calcRSIArray(candles);
  const divs: DivMarker[] = [];

  const lows:  Array<{ i: number; price: number; rsi: number }> = [];
  const highs: Array<{ i: number; price: number; rsi: number }> = [];

  for (let i = swing; i < candles.length - swing; i++) {
    const r = rsi[i];
    if (r === null) continue;
    const lo = candles[i].low,  hi = candles[i].high;
    let isLow = true, isHigh = true;
    for (let k = i - swing; k <= i + swing; k++) {
      if (k === i) continue;
      if (candles[k].low  <= lo) isLow  = false;
      if (candles[k].high >= hi) isHigh = false;
    }
    if (isLow)  lows.push({ i, price: lo, rsi: r });
    if (isHigh) highs.push({ i, price: hi, rsi: r });
  }

  // Bullish div: price LL but RSI HL (look at consecutive swing-low pairs)
  for (let j = 1; j < lows.length; j++) {
    const prev = lows[j - 1], curr = lows[j];
    if (curr.price < prev.price && curr.rsi > prev.rsi + 1)
      divs.push({ time: candles[curr.i].time, type: "bull" });
  }
  // Bearish div: price HH but RSI LH
  for (let j = 1; j < highs.length; j++) {
    const prev = highs[j - 1], curr = highs[j];
    if (curr.price > prev.price && curr.rsi < prev.rsi - 1)
      divs.push({ time: candles[curr.i].time, type: "bear" });
  }

  return divs;
}

// Historical volatility cone: zero-drift range from weekly log-return stddev,
// scaled by sqrt(time). Same category of technique as an options-implied
// price cone — expresses uncertainty, not a directional call. Centered on
// current price rather than a trend-extrapolated value on purpose: baking in
// trailing average return as "drift" would make the band look bullish just
// because BTC has trended up over most 3-year windows.
// Standard normal CDF (Abramowitz & Stegun approximation) — used to turn
// historical weekly drift + volatility into a P(price higher) estimate.
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function calcVolatilityCone(
  weeklyCloses: number[],
  weeksAhead: number,
  lookbackWeeks = 156,
): { low: number; high: number; upProb: number; weeklySigma: number } | null {
  if (weeklyCloses.length < lookbackWeeks + 1) return null;
  const recent = weeklyCloses.slice(-(lookbackWeeks + 1));
  const logReturns = recent.slice(1).map((c, i) => Math.log(c / recent[i]));
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const sigma = Math.sqrt(variance);
  const lastClose = recent[recent.length - 1];
  const spread = sigma * Math.sqrt(weeksAhead);
  // P(price higher than now) under the same drift+volatility model — unlike
  // the drift-free low/high band above, this DOES use the historical trend,
  // since "which is more likely" is inherently a directional question.
  const upProb = normalCDF(mean * Math.sqrt(weeksAhead) / sigma);
  return { low: lastClose * Math.exp(-spread), high: lastClose * Math.exp(spread), upProb, weeklySigma: sigma };
}

// Same 4-year halving-cycle context already used in openai.ts's
// getAltPricePrediction, reimplemented as a plain deterministic function —
// no LLM call needed for a fixed historical calendar fact.
function getHalvingCyclePhase(): { phase: string; daysSinceLast: number; daysUntilNext: number } {
  const HALVINGS = [
    new Date("2012-11-28"),
    new Date("2016-07-09"),
    new Date("2020-05-11"),
    new Date("2024-04-19"),
  ];
  const CYCLE_DAYS = 4 * 365.25;
  const now = new Date();
  const lastHalving = HALVINGS[HALVINGS.length - 1];
  const nextHalving = new Date(lastHalving.getTime() + CYCLE_DAYS * 24 * 60 * 60 * 1000);
  const daysSinceLast = Math.floor((now.getTime() - lastHalving.getTime()) / (1000 * 60 * 60 * 24));
  const daysUntilNext = Math.floor((nextHalving.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const cyclePosition = daysSinceLast / CYCLE_DAYS; // 0–1

  const phase =
    cyclePosition < 0.25 ? "Early bull phase" :
    cyclePosition < 0.50 ? "Peak bull phase" :
    cyclePosition < 0.75 ? "Bear market phase" :
    "Accumulation/bottom phase";

  return { phase, daysSinceLast, daysUntilNext };
}

function calcSR(candles: CandleDataPoint[], lookback = 5): { support: number[]; resistance: number[] } {
  const highs: number[] = [], lows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].high, l = candles[i].low;
    if (candles.slice(i - lookback, i + lookback + 1).every((c, idx) => idx === lookback || c.high <= h)) highs.push(h);
    if (candles.slice(i - lookback, i + lookback + 1).every((c, idx) => idx === lookback || c.low >= l)) lows.push(l);
  }
  const cluster = (arr: number[], tol = 0.005) => {
    const out: number[] = [];
    for (const p of arr) {
      const ex = out.findIndex(v => Math.abs(v - p) / p < tol);
      if (ex >= 0) out[ex] = (out[ex] + p) / 2;
      else out.push(p);
    }
    return out.slice(-5);
  };
  const cur = candles[candles.length - 1].close;
  const r = cluster(highs).filter(v => v > cur).sort((a, b) => a - b).slice(0, 3);
  const s = cluster(lows).filter(v => v < cur).sort((a, b) => b - a).slice(0, 3);
  return { support: s, resistance: r };
}

// Stochastic RSI (14, 14, 3, 3): where RSI sits in its own 14-bar range,
// smoothed — %K = 3-bar average of that, %D = 3-bar average of %K.
function calcStochRSI(candles: CandleDataPoint[]): { k: number | null; d: number | null } {
  const rsi = calcRSIArray(candles).filter((v): v is number => v != null);
  const raw: number[] = [];
  for (let i = 13; i < rsi.length; i++) {
    const win = rsi.slice(i - 13, i + 1);
    const lo = Math.min(...win);
    const hi = Math.max(...win);
    raw.push(hi === lo ? 50 : ((rsi[i] - lo) / (hi - lo)) * 100);
  }
  const sma3 = (a: number[]) => a.slice(2).map((_, i) => (a[i] + a[i + 1] + a[i + 2]) / 3);
  const k = sma3(raw);
  const d = sma3(k);
  return { k: k.length ? k[k.length - 1] : null, d: d.length ? d[d.length - 1] : null };
}

function buildIndicators(candles: CandleDataPoint[]): Indicators {
  const closes = candles.map(c => c.close);
  const ema20arr  = calcEMA(closes, 20);
  const ema50arr  = calcEMA(closes, 50);
  const ema200arr = calcEMA(closes, 200);
  const bb = calcBB(candles);
  const macd = calcMACD(candles);
  const { support, resistance } = calcSR(candles);
  const stoch = calcStochRSI(candles);
  return {
    rsi:        calcRSI(candles),
    stochK:     stoch.k,
    stochD:     stoch.d,
    macdLine:   macd.line,
    macdSignal: macd.signal,
    macdHist:   macd.hist,
    bbPct:      bb?.pct ?? null,
    bbUpper:    bb?.upper ?? null,
    bbLower:    bb?.lower ?? null,
    // Last finished candle vs the 20 before it — the live candle has only
    // just started trading, so it read as e.g. "0.01× normal" right after
    // every candle opened.
    volRatio:   calcVolRatio(candles.slice(0, -1)),
    ema20:      ema20arr[ema20arr.length - 1] ?? null,
    ema50:      ema50arr[ema50arr.length - 1] ?? null,
    ema200:     ema200arr[ema200arr.length - 1] ?? null,
    atr:        calcATR(candles),
    support,
    resistance,
  };
}

// ── Candle pattern detector ───────────────────────────────────────────────────

function detectPattern(candles: CandleDataPoint[]): Pattern {
  if (candles.length < 3) return { name: "Insufficient data", type: "neutral", emoji: "—", desc: "Not enough candles yet to detect a pattern" };
  const [c2, c1, c0] = candles.slice(-3);   // oldest → newest
  const body0 = Math.abs(c0.close - c0.open);
  const body1 = Math.abs(c1.close - c1.open);
  const range0 = c0.high - c0.low || 0.0001;
  const range1 = c1.high - c1.low || 0.0001;
  const bull0 = c0.close > c0.open;
  const bull1 = c1.close > c1.open;
  const bull2 = c2.close > c2.open;
  const upperWick0 = c0.high - Math.max(c0.open, c0.close);
  const lowerWick0 = Math.min(c0.open, c0.close) - c0.low;

  // Doji
  if (body0 / range0 < 0.08)
    return { name: "Doji", type: "neutral", emoji: "⊕", desc: "Buyers and sellers fought to a standstill — the next candle decides who wins" };

  // Marubozu (no wicks)
  if (upperWick0 / range0 < 0.03 && lowerWick0 / range0 < 0.03)
    return bull0
      ? { name: "Bullish Marubozu", type: "bullish", emoji: "▮", desc: "Buyers dominated the entire session with zero hesitation — strong momentum candle" }
      : { name: "Bearish Marubozu", type: "bearish", emoji: "▮", desc: "Sellers controlled open to close without a pause — aggressive distribution in play" };

  // Hammer / Hanging Man
  if (lowerWick0 > body0 * 2 && upperWick0 < body0 * 0.5 && body0 / range0 < 0.35)
    return bull0
      ? { name: "Hammer", type: "bullish", emoji: "🔨", desc: "Price was slammed down then fully recovered — buyers absorbed the sell-off and reclaimed control" }
      : { name: "Hanging Man", type: "bearish", emoji: "🔨", desc: "Long lower wick at a high shows sellers tested lower — distribution may be starting" };

  // Shooting Star / Inverted Hammer
  if (upperWick0 > body0 * 2 && lowerWick0 < body0 * 0.5 && body0 / range0 < 0.35)
    return !bull0
      ? { name: "Shooting Star", type: "bearish", emoji: "⭐", desc: "Price rallied hard then was rejected back down — market makers used the spike to dump into buyers" }
      : { name: "Inverted Hammer", type: "neutral", emoji: "⭐", desc: "Buyers tried to push higher but gave some back — watch for follow-through confirmation" };

  // Bullish Engulfing
  if (bull0 && !bull1 && c0.open < c1.close && c0.close > c1.open && body0 > body1)
    return { name: "Bullish Engulfing", type: "bullish", emoji: "🟢", desc: "This candle completely swallowed the previous red — buyers overwhelmed sellers, momentum has flipped" };

  // Bearish Engulfing
  if (!bull0 && bull1 && c0.open > c1.close && c0.close < c1.open && body0 > body1)
    return { name: "Bearish Engulfing", type: "bearish", emoji: "🔴", desc: "Sellers took back everything buyers gained and more — a clean momentum shift to the downside" };

  // Morning Star (3-candle bullish reversal)
  if (!bull2 && body1 / range1 < 0.25 && bull0 && c0.close > (c2.open + c2.close) / 2)
    return { name: "Morning Star", type: "bullish", emoji: "🌅", desc: "Classic 3-candle bottom: sell pressure faded into indecision, then buyers stepped in hard — reversal confirmed" };

  // Evening Star (3-candle bearish reversal)
  if (bull2 && body1 / range1 < 0.25 && !bull0 && c0.close < (c2.open + c2.close) / 2)
    return { name: "Evening Star", type: "bearish", emoji: "🌆", desc: "3-candle top pattern: rally stalled into a doji then sellers took over — smart money distributed into the strength" };

  // Pinbar — long wick one side, body at opposite end
  if (lowerWick0 > range0 * 0.6 && body0 < range0 * 0.25)
    return { name: "Bullish Pinbar", type: "bullish", emoji: "📍", desc: "Deep wick below shows stops were hunted then price snapped back — liquidity grab by market makers before a move up" };
  if (upperWick0 > range0 * 0.6 && body0 < range0 * 0.25)
    return { name: "Bearish Pinbar", type: "bearish", emoji: "📍", desc: "Upper wick reveals buyers were lured in then dumped on — a classic stop hunt before the real move down" };

  // Inside bar
  if (c0.high < c1.high && c0.low > c1.low)
    return { name: "Inside The Candle", type: "neutral", emoji: "🔲", desc: "Price coiled inside the prior candle's range — compression before expansion, breakout direction is the key" };

  // Spinning top
  if (body0 / range0 < 0.3 && upperWick0 > body0 && lowerWick0 > body0)
    return { name: "Spinning Top", type: "neutral", emoji: "🌀", desc: "Equal wicks on both sides show a tug-of-war — neither side has conviction, wait for the next candle" };

  // Three White Soldiers
  if (bull0 && bull1 && bull2 &&
      c0.close > c1.close && c1.close > c2.close &&
      c0.open > c1.open && c1.open > c2.open)
    return { name: "Three White Soldiers", type: "bullish", emoji: "🏹", desc: "Three consecutive strong closes with each open within the prior body — sustained institutional buying" };

  // Three Black Crows
  if (!bull0 && !bull1 && !bull2 &&
      c0.close < c1.close && c1.close < c2.close)
    return { name: "Three Black Crows", type: "bearish", emoji: "🐦‍⬛", desc: "Three consecutive lower closes — patient, relentless selling pressure with no meaningful bounce" };

  return {
    name: bull0 ? "Bullish Candle" : "Bearish Candle",
    type: bull0 ? "bullish" : "bearish",
    emoji: bull0 ? "▲" : "▼",
    desc: bull0
      ? "Buyers closed higher than they opened — upward pressure is present this candle"
      : "Sellers pushed price below the open — downward pressure is present this candle",
  };
}

// ── Candle pattern scan (Overview "Candle Patterns" card) ─────────────────────
// Runs detectPattern over every closed candle, finds the newest named
// pattern, and checks how that same pattern played out earlier on this
// coin + interval: did price move its way HIT_AHEAD candles later?

const GENERIC_PATTERNS = new Set(["Bullish Candle", "Bearish Candle", "Insufficient data"]);
// Pattern names stay English internally (logic + AI prompt); translate for display.
const patName = (name: string) => T(`pat.${tKey(name)}.name`, { defaultValue: name });
const patDesc = (p: { name: string; desc: string }) => T(`pat.${tKey(p.name)}.desc`, { defaultValue: p.desc });
const wyPhase = (phase: string) => T(`wyckoff.${tKey(phase)}`, { defaultValue: phase });
const HIT_AHEAD = 3;
const LATEST_WINDOW = 10; // only report a pattern from the last 10 closed candles
const MIN_SAMPLES = 5;    // fewer past cases than this → no hit rate

interface CandlePatternScan {
  pattern: Pattern;
  candlesAgo: number;            // 1 = the last closed candle
  hits: number | null;           // null for neutral patterns / too few samples
  samples: number;
  avgMovePct: number | null;     // average close-to-close move HIT_AHEAD candles later
  times: number[];               // the candles that form the pattern, oldest first
}

// How many candles each pattern is made of (default 1).
const PATTERN_SIZE: Record<string, number> = {
  "Morning Star": 3, "Evening Star": 3, "Three White Soldiers": 3, "Three Black Crows": 3,
  "Bullish Engulfing": 2, "Bearish Engulfing": 2, "Inside The Candle": 2,
};

function scanCandlePatterns(candles: CandleDataPoint[]): CandlePatternScan | null {
  // The last candle is still forming — only judge closed ones.
  const closed = candles.slice(0, -1);
  if (closed.length < 3) return null;
  const found: Array<{ i: number; p: Pattern }> = [];
  for (let i = 2; i < closed.length; i++) {
    const p = detectPattern(closed.slice(i - 2, i + 1));
    if (!GENERIC_PATTERNS.has(p.name)) found.push({ i, p });
  }
  // Neutral ones (doji, inside bar, spinning top) print almost every few
  // candles — prefer the newest bullish/bearish one in the window.
  const recent = found.filter(f => closed.length - 1 - f.i < LATEST_WINDOW);
  const last = [...recent].reverse().find(f => f.p.type !== "neutral") ?? recent[recent.length - 1];
  if (!last) return null;

  // Earlier cases of the same pattern that have HIT_AHEAD candles after them.
  const past = found.filter(f => f.p.name === last.p.name && f.i + HIT_AHEAD < closed.length);
  const moves = past.map(f => (closed[f.i + HIT_AHEAD].close - closed[f.i].close) / closed[f.i].close * 100);
  const enough = moves.length >= MIN_SAMPLES;
  const hits = enough && last.p.type !== "neutral"
    ? moves.filter(m => (last.p.type === "bullish" ? m > 0 : m < 0)).length
    : null;
  return {
    pattern: last.p,
    candlesAgo: closed.length - last.i,
    hits,
    samples: moves.length,
    avgMovePct: enough ? moves.reduce((a, b) => a + b, 0) / moves.length : null,
    times: closed.slice(last.i + 1 - (PATTERN_SIZE[last.p.name] ?? 1), last.i + 1).map(c => c.time as number),
  };
}

// ── Wyckoff phase detection ───────────────────────────────────────────────────

type WyckoffPhaseLabel = "Accumulation" | "Distribution" | "Markup" | "Markdown" | "Re-Accumulation" | "Ranging";

interface WyckoffResult {
  phase: WyckoffPhaseLabel;
  springs: number[];
  upthrusts: number[];
  rangeLow: number | null;
  rangeHigh: number | null;
}

function detectWyckoff(candles: CandleDataPoint[]): WyckoffResult {
  const empty: WyckoffResult = { phase: "Ranging", springs: [], upthrusts: [], rangeLow: null, rangeHigh: null };
  if (candles.length < 30) return empty;

  const n = candles.length;
  const closes = candles.map(c => c.close);

  // Trend via EMA20 vs EMA50 slope
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const e20now = ema20[n - 1], e20ago = ema20[n - 8];
  const e50now = ema50[n - 1];
  const slope = (e20now - e20ago) / e20ago;

  // If strong trend, skip TR analysis
  if (slope > 0.012 && e20now > e50now)  return { ...empty, phase: "Markup" };
  if (slope < -0.012 && e20now < e50now) return { ...empty, phase: "Markdown" };

  // Trading range analysis over last 40 candles
  const trLen = Math.min(40, n);
  const trCandles = candles.slice(-trLen);
  const rangeHigh = Math.max(...trCandles.map(c => c.high));
  const rangeLow  = Math.min(...trCandles.map(c => c.low));
  const rangeSize = (rangeHigh - rangeLow) / rangeLow;

  // Broader context for relative position
  const broader = candles.slice(-Math.min(80, n));
  const bHigh = Math.max(...broader.map(c => c.high));
  const bLow  = Math.min(...broader.map(c => c.low));
  const bRange = bHigh - bLow || 1;
  const trMid  = (rangeHigh + rangeLow) / 2;
  const relPos = (trMid - bLow) / bRange;

  let phase: WyckoffPhaseLabel;
  if (rangeSize < 0.04) {
    // Tight range — check if re-accumulation or distribution
    phase = relPos > 0.6 ? "Distribution" : relPos < 0.4 ? "Re-Accumulation" : "Ranging";
  } else {
    phase = relPos < 0.38 ? "Accumulation" : relPos > 0.62 ? "Distribution" : "Ranging";
  }

  // Spring & Upthrust detection — scan last 25 candles
  const scanLen = Math.min(25, n);
  const refLen  = Math.min(trLen - scanLen, trLen);
  const refCandles = trCandles.slice(0, refLen);
  const refLow  = Math.min(...refCandles.map(c => c.low));
  const refHigh = Math.max(...refCandles.map(c => c.high));
  const tol = (refHigh - refLow) * 0.008;

  const springs: number[]   = [];
  const upthrusts: number[] = [];

  for (let i = refLen; i < trCandles.length; i++) {
    const c = trCandles[i];
    const prev = trCandles[i - 1];
    if (!prev) continue;
    // Spring: wick below support, body closes back above
    if (c.low < refLow - tol && c.close > refLow && c.close > c.open * 0.998)
      springs.push(c.time);
    // Upthrust: wick above resistance, body closes back below
    if (c.high > refHigh + tol && c.close < refHigh && c.close < c.open * 1.002)
      upthrusts.push(c.time);
  }

  return { phase, springs, upthrusts, rangeHigh, rangeLow };
}

// ── Forecast conviction engine ────────────────────────────────────────────────

function computeForecastConviction(
  candles: CandleDataPoint[],
  aiRead: AIRead | null,
  ind: Indicators | null,
  wyckoff: WyckoffResult | null,
  ict: ICTResult | null,
  macro: MacroContextData | null = null,
  coin = 'BTC',
): { score: number; volatilityMult: number; targetDistMult: number } {
  const last = candles[candles.length - 1];

  // ── Base: AI bias + confidence ────────────────────────────────────────────
  const bias = aiRead?.bias ?? "neutral";
  let score  = bias === "bullish" ? 0.42 : bias === "bearish" ? -0.42 : 0;
  const confScale = aiRead?.confidence === "high" ? 1.15 : aiRead?.confidence === "low" ? 0.78 : 1.0;
  score *= confScale;

  // ── RSI ───────────────────────────────────────────────────────────────────
  if (ind?.rsi != null) {
    const r = ind.rsi;
    // Momentum agreement/disagreement
    const rsiNorm = (r - 50) / 50;
    score += rsiNorm * (Math.sign(rsiNorm) === Math.sign(score) ? 0.06 : 0.14);
    // Hard overbought/oversold caps — limits how far the forecast moves
    if (r > 75) score = Math.min(score,  0.28);
    if (r < 25) score = Math.max(score, -0.28);
  }

  // ── MACD histogram ────────────────────────────────────────────────────────
  if (ind?.macdHist != null && ind?.atr != null && ind.atr > 0) {
    const norm = Math.min(Math.abs(ind.macdHist) / ind.atr * 6, 0.14);
    score += ind.macdHist > 0 ? norm : -norm;
  }

  // ── EMA stack alignment ───────────────────────────────────────────────────
  if (ind?.ema20 != null && ind?.ema50 != null) {
    if (last.close > ind.ema20 && ind.ema20 > ind.ema50) score += 0.09;
    if (last.close < ind.ema20 && ind.ema20 < ind.ema50) score -= 0.09;
    if (ind.ema200 != null) {
      score += last.close > ind.ema200 ? 0.05 : -0.05;
    }
  }

  // ── Bollinger Band position ────────────────────────────────────────────────
  if (ind?.bbPct != null) {
    if (ind.bbPct > 0.88) score -= 0.11;  // near upper band → dampen bulls
    if (ind.bbPct < 0.12) score += 0.11;  // near lower band → dampen bears
  }

  // ── Volume confirmation ───────────────────────────────────────────────────
  if (ind?.volRatio != null) {
    const v = ind.volRatio;
    const vMult = v >= 2.0 ? 1.18 : v >= 1.4 ? 1.08 : v < 0.5 ? 0.72 : v < 0.75 ? 0.88 : 1.0;
    score *= vMult;
  }

  // ── Candle pattern from AI ────────────────────────────────────────────────
  if (aiRead?.patternType === "bullish") score += 0.06;
  if (aiRead?.patternType === "bearish") score -= 0.06;

  // ── Wyckoff phase ─────────────────────────────────────────────────────────
  if (wyckoff) {
    const phaseAdj: Partial<Record<WyckoffPhaseLabel, number>> = {
      Markup: 0.09, Markdown: -0.09, Accumulation: 0.05,
      Distribution: -0.05, "Re-Accumulation": 0.04,
    };
    score += phaseAdj[wyckoff.phase] ?? 0;
    // Recent Spring or Upthrust (within last 8 candle-times)
    const window = intervalIsRecent(candles, 8);
    if (wyckoff.springs.some(t => t >= window)) score += 0.11;
    if (wyckoff.upthrusts.some(t => t >= window)) score -= 0.11;
  }

  // ── ICT confluence ────────────────────────────────────────────────────────
  if (ict) {
    const p = last.close;
    // Near Order Block
    if (ict.orderBlocks.some(ob => ob.type === "bull" && p >= ob.low * 0.999 && p <= ob.high * 1.001)) score += 0.08;
    if (ict.orderBlocks.some(ob => ob.type === "bear" && p >= ob.low * 0.999 && p <= ob.high * 1.001)) score -= 0.08;
    // Premium vs Discount
    if (ict.pd) {
      if (p > ict.pd.mid * 1.005 && score > 0) score -= 0.06;  // overextended premium
      if (p < ict.pd.mid * 0.995 && score < 0) score += 0.06;  // oversold discount
    }
    // OTE confluence
    if (ict.ote) {
      const inOTE = p >= ict.ote.bottom * 0.999 && p <= ict.ote.top * 1.001;
      if (inOTE) score += ict.ote.type === "bull" ? 0.09 : -0.09;
    }
    // Near BSL (buy stops above) with bearish bias → strong bear signal
    const nearBSL = ict.liquidityPools.filter(lp => lp.type === "buy" && lp.price > p && lp.price < p * 1.005);
    if (nearBSL.length && score < 0) score -= 0.07;
    const nearSSL = ict.liquidityPools.filter(lp => lp.type === "sell" && lp.price < p && lp.price > p * 0.995);
    if (nearSSL.length && score > 0) score += 0.07;
  }

  // ── Macro context ─────────────────────────────────────────────────────────
  if (macro) {
    // BTC Dominance — direction of effect depends on which coin is being forecast
    if (macro.btcDominance != null) {
      const dom = macro.btcDominance;
      const isBTC = coin.toUpperCase() === 'BTC';
      if (isBTC) {
        // High dominance = capital flowing INTO BTC = mild bull confirmation
        if      (dom > 60) score += 0.07;
        else if (dom > 55) score += 0.04;
        else if (dom > 50) score += 0.02;
        else if (dom < 44) score -= 0.04; // alt season bleeding BTC dominance
      } else {
        // For alts: high BTC dominance = liquidity being pulled into BTC = bearish
        if      (dom > 60) score -= 0.08;
        else if (dom > 55) score -= 0.05;
        else if (dom < 44) score += 0.07; // alt season = bullish for alts
        else if (dom < 48) score += 0.03;
      }
    }
    // Positive funding = crowded longs = dampens bull conviction
    if (macro.fundingRate != null) {
      const fr = macro.fundingRate;
      if      (fr > 0.0002)  score -= 0.08;
      else if (fr > 0.0001)  score -= 0.04;
      else if (fr < -0.0001) score += 0.05;
    }
    // Rising OI amplifies the prevailing direction; falling OI weakens it
    if (macro.oiDelta != null) {
      const oi = macro.oiDelta;
      if      (oi >  2 && score > 0) score += 0.05;
      else if (oi >  2 && score < 0) score -= 0.05;
      else if (oi < -2)              score *= 0.88;
    }
    // Daily market structure alignment / counter-trend penalty
    if (macro.marketStructure === 'uptrend')   score += score > 0 ?  0.06 : 0.04;
    if (macro.marketStructure === 'downtrend') score += score < 0 ? -0.06 : -0.04;
  }

  // ── Volatility multiplier from BB width ───────────────────────────────────
  let volatilityMult = 1.0;
  if (ind?.bbUpper != null && ind?.bbLower != null && ind?.ema20 != null && ind.ema20 > 0) {
    const bw = (ind.bbUpper - ind.bbLower) / ind.ema20;
    volatilityMult = bw < 0.02 ? 1.35 : bw > 0.07 ? 0.72 : 1.0;
  }

  const absScore = Math.abs(score);
  const targetDistMult = 0.7 + absScore * 2.0;  // stronger conviction → larger move
  score = Math.max(-1, Math.min(1, score));
  return { score, volatilityMult, targetDistMult };
}

function intervalIsRecent(candles: CandleDataPoint[], n: number): number {
  if (candles.length < 2) return 0;
  const dur = Number(candles[candles.length - 1].time) - Number(candles[candles.length - 2].time);
  return Number(candles[candles.length - 1].time) - dur * n;
}

// ── Forecast candle generator ─────────────────────────────────────────────────

function generateForecastCandles(
  candles: CandleDataPoint[],
  aiRead: AIRead | null,
  ind: Indicators | null,
  intervalDurationSec: number,
  count = 6,
  wyckoff: WyckoffResult | null = null,
  ict: ICTResult | null = null,
  macro: MacroContextData | null = null,
  coin = 'BTC',
): { candles: CandlestickData[]; targetPrice: number; bias: string; conviction: number; bullPath: { time: UTCTimestamp; value: number }[]; bearPath: { time: UTCTimestamp; value: number }[] } {
  if (!candles.length) return { candles: [], targetPrice: 0, bias: "neutral", conviction: 0, bullPath: [], bearPath: [] };

  const last = candles[candles.length - 1];
  const atr  = ind?.atr ?? (Math.abs(last.high - last.low) * 0.8 || last.close * 0.005);

  const { score, volatilityMult, targetDistMult } = computeForecastConviction(candles, aiRead, ind, wyckoff, ict, macro, coin);
  const bias = score > 0.06 ? "bullish" : score < -0.06 ? "bearish" : "neutral";
  const absScore = Math.abs(score);

  // ── Target selection ──────────────────────────────────────────────────────
  const atrFallback = atr * count * 0.38 * targetDistMult;
  const bullCands: number[] = [
    ...(aiRead?.keyLevels.filter(l => l.price > last.close).map(l => l.price) ?? []),
    ...(ind?.resistance.filter(r => r > last.close) ?? []),
    ...(ict?.liquidityPools.filter(lp => lp.type === "buy" && lp.price > last.close).map(lp => lp.price) ?? []),
    ...(ict?.orderBlocks.filter(ob => ob.type === "bear" && ob.low > last.close).map(ob => ob.low) ?? []),
  ].sort((a, b) => a - b);

  const bearCands: number[] = [
    ...(aiRead?.keyLevels.filter(l => l.price < last.close).map(l => l.price) ?? []),
    ...(ind?.support.filter(s => s < last.close) ?? []),
    ...(ict?.liquidityPools.filter(lp => lp.type === "sell" && lp.price < last.close).map(lp => lp.price) ?? []),
    ...(ict?.orderBlocks.filter(ob => ob.type === "bull" && ob.high < last.close).map(ob => ob.high) ?? []),
  ].sort((a, b) => b - a);

  let target = last.close;
  const maxMove = atr * count * 1.4;   // sanity cap: no more than 1.4 ATR per candle
  if (bias === "bullish") {
    const reachable = bullCands.filter(p => p - last.close <= maxMove);
    target = reachable[0] ?? last.close + atrFallback;
  } else if (bias === "bearish") {
    const reachable = bearCands.filter(p => last.close - p <= maxMove);
    target = reachable[0] ?? last.close - atrFallback;
  } else {
    // Neutral: choppy oscillation — small move in last-candle direction then fade
    const micro = (last.close - last.open > 0 ? 1 : -1) * atr * 0.6;
    target = last.close + micro;
  }

  // ── Intermediate obstacles (S/R between current price and target) ─────────
  const allLevels = [
    ...(ind?.resistance ?? []),
    ...(ind?.support ?? []),
    ...(ict?.orderBlocks.map(ob => (ob.high + ob.low) / 2) ?? []),
    ...(ict?.fvgs.map(f => (f.top + f.bottom) / 2) ?? []),
  ];
  const totalMove = target - last.close;
  const obstacles = allLevels.filter(p =>
    totalMove > 0 ? p > last.close && p < target : p < last.close && p > target
  );

  // ── Path generation ───────────────────────────────────────────────────────
  // Sigmoid: smooth acceleration → deceleration
  const sigmoid = (t: number) => 1 / (1 + Math.exp(-7 * (t - 0.5)));
  // Seed deterministic RNG on last candle timestamp
  const seed = Number(last.time);
  const rng  = (i: number) => { const x = Math.sin(seed + i * 137.508) * 10000; return x - Math.floor(x); };

  const result: CandlestickData[] = [];
  const bullPath: { time: UTCTimestamp; value: number }[] = [];
  const bearPath: { time: UTCTimestamp; value: number }[] = [];
  let prevClose = last.close;

  for (let i = 0; i < count; i++) {
    const t        = (Number(last.time) + intervalDurationSec * (i + 1)) as UTCTimestamp;
    const progress = (i + 1) / count;
    let   sigProg  = sigmoid(progress);

    // Decelerate when approaching an obstacle
    const projectedPrice = last.close + totalMove * sigProg;
    for (const obs of obstacles) {
      const dist = Math.abs(projectedPrice - obs) / (Math.abs(totalMove) || 1);
      if (dist < 0.18) sigProg *= (0.72 + dist * 1.5);  // soft brake
    }

    // Noise: scales with volatility, shrinks as conviction rises and time progresses
    const noiseFactor = atr * volatilityMult * (0.18 + (1 - absScore) * 0.22) * (1 - progress * 0.25);
    const noise = noiseFactor * (rng(i * 3 + 1) - 0.5);

    const close = last.close + totalMove * sigProg + noise;
    const open  = prevClose;

    // Asymmetric wicks — trend direction gets small wick, opposite side larger
    const trendWick   = atr * volatilityMult * (0.06 + rng(i * 2) * 0.09);
    const nearObs     = obstacles.some(obs => Math.abs(close - obs) < atr * 0.5);
    const counterMult = nearObs ? 0.45 : (0.12 + (1 - absScore) * 0.18);
    const counterWick = atr * volatilityMult * counterMult * rng(i * 5 + 2);

    let high: number, low: number;
    if (score > 0.08) {
      high = Math.max(open, close) + trendWick;
      low  = Math.min(open, close) - counterWick;
    } else if (score < -0.08) {
      high = Math.max(open, close) + counterWick;
      low  = Math.min(open, close) - trendWick;
    } else {
      const ew = atr * volatilityMult * 0.14 * rng(i * 4 + 3);
      high = Math.max(open, close) + ew;
      low  = Math.min(open, close) - ew;
    }

    result.push({ time: t, open, high, low, close });

    // Fan bounds — widen as uncertainty grows over time
    const fanSpread = atr * volatilityMult * (1 - absScore * 0.45) * (i + 1) / count;
    bullPath.push({ time: t, value: close + fanSpread });
    bearPath.push({ time: t, value: close - fanSpread });

    prevClose = close;
  }

  return { candles: result, targetPrice: target, bias, conviction: score, bullPath, bearPath };
}

// ── Elliott Wave ─────────────────────────────────────────────────────────────

interface EWPivot { time: UTCTimestamp; price: number; label: string; pivotType: "high" | "low" }
interface EWProjection { label: string; price: number; color: string; isMain: boolean }
// Which of the 5 Elliott shapes this is. Impulse = classic 5-wave; diagonal =
// 5 waves inside a wedge (wave 4 overlaps wave 1); zigzag / flat /
// expanded-flat = the A-B-C corrections; triangle = A-B-C-D-E.
type EWSubtype = "impulse" | "diagonal" | "zigzag" | "flat" | "expanded-flat" | "triangle";
type EWPoint = { time: UTCTimestamp; value: number };
interface EWResult {
  pattern: "impulse" | "corrective" | "none";
  direction: "bullish" | "bearish" | "unknown";
  pivots: EWPivot[];
  currentWave: string;
  description: string;
  complete: boolean;
  projections: EWProjection[];
  projectionPath: EWPoint[];
  invalidation: number | null;
  subtype?: EWSubtype;
  /** Display name, e.g. "Zig-Zag", "Contracting Triangle". */
  name?: string;
  /** Triangle / diagonal boundary lines, drawn on the chart. */
  trendlines?: [EWPoint[], EWPoint[]];
  /** Translation key + values for `description` (which stays English for the AI prompt). */
  descKey?: string;
  descVars?: Record<string, string | number>;
}

/** Display (translated) Elliott pattern name, e.g. "Zig-Zag". */
const ewNameT = (name: string) => T(`ewName.${tKey(name)}`, { defaultValue: name });
/** Display (translated) Elliott description. */
const ewDescT = (ew: EWResult) => ew.descKey
  ? T(`ewDesc.${ew.descKey}`, { ...ew.descVars, name: ew.name ? ewNameT(ew.name) : "" })
  : ew.description;

type EWSwing = { price: number; time: UTCTimestamp; type: "high" | "low" };

const ewAlternates = (ps: EWSwing[]) => ps.every((p, i) => i === 0 || p.type !== ps[i - 1].type);
const ewFmt = (p: number) => "$" + p.toLocaleString("en-US", { maximumFractionDigits: p < 10 ? 4 : 0 });
// Value of the line through a and b at time t (for boundary lines).
const ewLineAt = (a: EWSwing, b: EWSwing, t: number) => a.price + (b.price - a.price) * (t - a.time) / (b.time - a.time || 1);

/** Names a finished A-B-C by how far B retraced wave A. */
function classifyABC(q0: EWSwing, qa: EWSwing, qb: EWSwing, qc: EWSwing): { subtype: EWSubtype; name: string } | null {
  if (!ewAlternates([q0, qa, qb, qc])) return null;
  const s = q0.type === "high" ? 1 : -1;          // flip so the correction always "falls"
  const lenA = (q0.price - qa.price) * s;
  const lenC = (qb.price - qc.price) * s;
  if (lenA <= 0 || lenC <= 0) return null;
  const rB = (qb.price - qa.price) * s / lenA;    // B as a share of A
  const cPastA = (qa.price - qc.price) * s > 0;
  if (rB >= 0.2 && rB < 0.8 && cPastA) return { subtype: "zigzag", name: "Zig-Zag" };
  if (rB >= 0.8 && rB <= 1.05 && lenC >= lenA * 0.9 && lenC <= lenA * 1.7) return { subtype: "flat", name: "Flat" };
  if (rB > 1.05 && rB <= 1.4 && cPastA) return { subtype: "expanded-flat", name: "Expanded Flat" };
  return null;
}

/** Ending diagonal: 5 waves inside a wedge where wave 4 overlaps wave 1. */
function detectDiagonal(ps: EWSwing[], now: UTCTimestamp, nowPrice: number, toEW: (p: EWSwing, l: string) => EWPivot): EWResult | null {
  if (ps.length !== 6 || !ewAlternates(ps)) return null;
  const bull = ps[0].type === "low";
  const s = bull ? 1 : -1;
  const [p0, p1, p2, p3, p4, p5] = ps.map(p => p.price * s);
  const w1 = p1 - p0, w2 = p1 - p2, w3 = p3 - p2, w4 = p3 - p4, w5 = p5 - p4;
  const wedge = p2 > p0 && p3 > p1 && p4 > p2 && p5 > p3;   // highs and lows both trend
  const overlap = p4 < p1;                                   // allowed only in diagonals
  const contracting = w1 > w3 && w3 > w5 && w2 > w4;
  const expanding = w1 < w3 && w3 < w5 && w2 < w4;
  const r2 = w2 / w1, r4 = w4 / w3;
  if (!wedge || !overlap || (w3 < w1 && w3 < w5) || !(contracting || expanding)) return null;
  if (r2 < 0.3 || r2 > 0.95 || r4 < 0.3 || r4 > 0.95) return null;

  const [q0, q1, q2, q3, q4, q5] = ps;
  const kind = contracting ? "Contracting" : "Expanding";
  const avgDur = Math.round((q5.time - q0.time) / 5);
  const col = bull ? ["#fca5a5", "#ef4444", "#f87171"] : ["#86efac", "#22c55e", "#4ade80"];
  return {
    pattern: "impulse", subtype: "diagonal", name: `${kind} Diagonal`,
    direction: bull ? "bullish" : "bearish", complete: true, currentWave: "5",
    description: `${kind} ${bull ? "rising" : "falling"} wedge (ending diagonal) — trend exhausted, sharp reversal toward ${ewFmt(q2.price)} expected`,
    descKey: `diagonal${kind}${bull ? "Rising" : "Falling"}`, descVars: { price: ewFmt(q2.price) },
    pivots: [toEW(q0, "0"), toEW(q1, "1"), toEW(q2, "2"), toEW(q3, "3"), toEW(q4, "4"), toEW(q5, "5")],
    trendlines: [
      [{ time: q1.time, value: q1.price }, { time: q5.time, value: ewLineAt(q1, q3, q5.time) }],
      [{ time: q2.time, value: q2.price }, { time: q5.time, value: ewLineAt(q2, q4, q5.time) }],
    ],
    projections: [
      { label: "W4", price: q4.price, color: col[0], isMain: false },
      { label: "W2", price: q2.price, color: col[1], isMain: true },
      { label: "Start", price: q0.price, color: col[2], isMain: false },
    ],
    projectionPath: [
      { time: now, value: nowPrice },
      { time: (now + avgDur) as UTCTimestamp, value: q2.price },
      { time: (now + avgDur * 2) as UTCTimestamp, value: q0.price },
    ],
    // A new extreme past wave 5 means the wedge isn't finished.
    invalidation: q5.price,
  };
}

/** Contracting triangle: A-B-C-D-E, each leg smaller, lines converging. */
function detectTriangle(ps: EWSwing[], now: UTCTimestamp, nowPrice: number, toEW: (p: EWSwing, l: string) => EWPivot): EWResult | null {
  if (ps.length !== 6 || !ewAlternates(ps)) return null;
  // Wave A falls in an uptrend triangle (and rises in a downtrend one); the
  // breakout ("thrust") after E goes the trend's way.
  const thrustUp = ps[0].type === "high";
  const s = thrustUp ? 1 : -1;
  const [t0, a, b, c, d, e] = ps.map(p => p.price * s);
  const highsFall = b < t0 && d < b;
  const lowsRise = c > a && e > c;
  if (!highsFall || !lowsRise) return null;
  const legs = [t0 - a, b - a, b - c, d - c, d - e];
  for (let i = 1; i < legs.length; i++) {
    const r = legs[i] / legs[i - 1];
    if (r < 0.3 || r > 0.98) return null;   // every leg shorter than the last
  }

  const [q0, qa, qb, qc, qd, qe] = ps;
  const widest = Math.abs(q0.price - qa.price);
  const avgDur = Math.round((qe.time - q0.time) / 5);
  const dir = thrustUp ? 1 : -1;
  const col = thrustUp ? ["#86efac", "#22c55e"] : ["#fca5a5", "#ef4444"];
  return {
    pattern: "corrective", subtype: "triangle", name: "Contracting Triangle",
    direction: thrustUp ? "bullish" : "bearish", complete: true, currentWave: "E",
    description: `Contracting triangle (A-B-C-D-E) complete — ${thrustUp ? "upside" : "downside"} breakout expected`,
    descKey: thrustUp ? "triangleUp" : "triangleDown",
    pivots: [toEW(q0, "0"), toEW(qa, "A"), toEW(qb, "B"), toEW(qc, "C"), toEW(qd, "D"), toEW(qe, "E")],
    trendlines: [
      [{ time: qb.time, value: qb.price }, { time: qe.time, value: ewLineAt(qb, qd, qe.time) }],
      [{ time: qa.time, value: qa.price }, { time: qe.time, value: ewLineAt(qa, qc, qe.time) }],
    ],
    projections: [
      { label: "Thrust 61.8%", price: qe.price + dir * widest * 0.618, color: col[0], isMain: false },
      { label: "Thrust 100%", price: qe.price + dir * widest, color: col[1], isMain: true },
    ],
    projectionPath: [
      { time: now, value: nowPrice },
      { time: (now + avgDur * 2) as UTCTimestamp, value: qe.price + dir * widest },
    ],
    // Breaking past E the wrong way means the triangle failed.
    invalidation: qe.price,
  };
}

// ── Elliott tab: plain-language story ────────────────────────────────────────
// Written so a beginner gets it: staircase (impulse), spring (triangle),
// tired runner (finished trend). One place for all the wording.

// Projection label → translation key under candleInsights.ewTarget.
const EW_TARGET_KEYS: Record<string, string> = {
  "A 38.2%": "a382", "A 61.8%": "a618", "Full 100%": "full100",
  "W4 38.2%": "w4_382", "W4 50%": "w4_50", "W4 61.8%": "w4_618", "W5 proj": "w5proj",
  "W5 0.618× W1": "w5_618", "W5 equal (1.0)": "w5eq",
  "W5 target (1.618)": "w5_1618", "W5 ext (2.618)": "w5_2618",
  "Rev 38.2%": "rev382", "Rev 61.8%": "rev618", "Rev 100%": "rev100",
  "Thrust 61.8%": "thrust618", "Thrust 100%": "thrust100",
  "W4": "w4", "W2": "w2", "Start": "start",
};
const ewTargetName = (label: string) => EW_TARGET_KEYS[label] ? T(`ewTarget.${EW_TARGET_KEYS[label]}`) : label;

/**
 * Where the count expects price to END UP (net), not the next little swing.
 * Wave 4 is only a small counter-trend rest before wave 5 continues the
 * trend, so its net call is the trend's direction — calling it "next move
 * up" inside a bearish count read as a contradiction.
 */
function ewNextUp(ew: EWResult): boolean {
  const b = ew.direction === "bullish";
  if (ew.subtype === "triangle") return b;                 // breakout goes with the trend
  if (ew.pattern === "impulse") return !ew.complete ? b : !b; // waves 4/5 continue; finished 5 reverses
  return !b;                                               // finished A-B-C reverses
}

/** Short label for the expected path, e.g. "small bounce, then down". */
function ewNextLabel(ew: EWResult): string {
  const b = ew.direction === "bullish";
  if (ew.pattern === "impulse" && !ew.complete && ew.currentWave === "4")
    return T(b ? "ewNext.dipThenUp" : "ewNext.bounceThenDown");
  return T(ewNextUp(ew) ? "ewNext.up" : "ewNext.down");
}

function ewKidStory(ew: EWResult): { rows: Array<{ label: string; desc: string; up: boolean; pct: string; price: number }>; what: string; next: string } {
  const $ = (n?: number | null) => (n == null ? "—" : ewFmt(n));
  const P = ew.pivots;
  const bull = ew.direction === "bullish";
  const st = ew.subtype;
  const proj = (l: string) => ew.projections.find(p => p.label === l)?.price;
  const main = ew.projections.find(p => p.isMain)?.price;
  // Targets price has already reached since the last swing (projectionPath
  // starts at the current price) — say so instead of pretending they're ahead.
  const nowPrice = ew.projectionPath[0]?.value;
  const lastSwing = P[P.length - 1]?.price;
  // The immediate swing (wave 4's rest goes against the trend) — that's the
  // way the listed wave-4 levels sit from the last swing.
  const nextUp = ew.pattern === "impulse" && !ew.complete && ew.currentWave === "4" ? !bull : ewNextUp(ew);
  const hit = nowPrice == null || lastSwing == null ? [] : ew.projections.filter(p =>
    nextUp ? p.price > lastSwing && p.price <= nowPrice : p.price < lastSwing && p.price >= nowPrice);
  const progressTxt = !hit.length ? ""
    : hit.length === ew.projections.filter(p => (nextUp ? p.price > lastSwing! : p.price < lastSwing!)).length
      ? " " + T("ewStory.progressAll", { price: $(nowPrice) })
      : " " + T("ewStory.progressPast", { price: $(nowPrice), past: $(hit.reduce((f, p) => (nextUp ? (p.price > f ? p.price : f) : (p.price < f ? p.price : f)), hit[0].price)) });
  const breakTxt = (up: boolean) => progressTxt +
    (ew.invalidation != null ? " " + T(up ? "ewStory.wrongAbove" : "ewStory.wrongBelow", { price: $(ew.invalidation) }) : "");
  const UD = (k: string) => `ewStory.${k}${bull ? "Up" : "Down"}`;
  // How much of the previous leg leg i took back, in %.
  const share = (i: number) => {
    const prevLeg = i >= 2 ? Math.abs(P[i - 1].price - P[i - 2].price) : 0;
    return prevLeg ? Math.round(Math.abs(P[i].price - P[i - 1].price) / prevLeg * 100) : 0;
  };
  const corrDown = ew.direction === "bearish";          // which way an A-B-C moved
  const cPastA = P.length >= 4 && (corrDown ? P[3].price < P[1].price : P[3].price > P[1].price);

  const rows = P.slice(1).map((p, k) => {
    const i = k + 1, prev = P[k], L = p.label;
    let desc = "";
    if (st === "triangle") {
      desc = ["A", "B", "C", "D", "E"].includes(L) ? T(`ewStory.tri${L}`) : "";
    } else if (ew.pattern === "impulse") {
      desc = ({
        "1": T(UD("w1")),
        "2": T("ewStory.w2", { pct: share(i) }),
        // Wave 3 can't be the shortest, but may be a bit shorter than wave 1.
        "3": st === "diagonal" ? T(UD("w3Diag"))
          : P.length > 3 && Math.abs(P[3].price - P[2].price) >= Math.abs(P[1].price - P[0].price) ? T(UD("w3Big")) : T(UD("w3Strong")),
        "4": st === "diagonal" ? T("ewStory.w4Diag") : T("ewStory.w4", { pct: share(i) }),
        "5": st === "diagonal" ? T(UD("w5Diag")) : T(UD("w5")),
      } as Record<string, string>)[L] ?? "";
    } else {
      desc = ({
        A: T("ewStory.corrA"),
        B: T(corrDown ? "ewStory.corrBBounce" : "ewStory.corrBDip", { pct: share(i) }),
        C: T(cPastA ? "ewStory.corrCPast" : "ewStory.corrCNear"),
      } as Record<string, string>)[L] ?? "";
    }
    return { label: /^\d$/.test(L) ? `W${L}` : L, desc, up: p.price > prev.price, pct: Math.abs((p.price - prev.price) / prev.price * 100).toFixed(1) + "%", price: p.price };
  });

  const stairs = T(UD("stairs"));
  let what = "", next = "";
  if (st === "triangle") {
    what = T("ewStory.triWhat");
    next = T(UD("triNext"), { price: $(main) }) + breakTxt(!bull);
  } else if (st === "diagonal") {
    what = T(UD("diagWhat"));
    next = T("ewStory.diagNext", { w2: $(proj("W2")), w4: $(proj("W4")), start: $(proj("Start")) }) + breakTxt(bull);
  } else if (ew.pattern === "impulse" && ew.complete) {
    what = T("ewStory.doneWhat", { stairs });
    next = T("ewStory.doneNext", { a: $(proj("A 38.2%")), b: $(proj("A 61.8%")), full: $(proj("Full 100%")) }) + breakTxt(bull);
  } else if (ew.pattern === "impulse" && ew.currentWave === "5") {
    what = T(UD("w5What"), { stairs });
    // Wave 3 was the big one → step 5 is usually about as long as step 1;
    // otherwise step 5 is often the long one (see the detector).
    const eqMain = ew.projections.find(p => p.isMain)?.label === "W5 equal (1.0)";
    next = T(eqMain ? "ewStory.w5NextEq" : "ewStory.w5NextLong", { price: $(main) })
      + " " + T("ewStory.w5Careful") + breakTxt(!bull);
  } else if (ew.pattern === "impulse" && ew.currentWave === "4") {
    what = T(UD("w4What"), { stairs, price: $(P[P.length - 1]?.price) });
    // Deep levels that would break the wave-1 rule are already removed.
    const w4 = ew.projections.filter(p => p.label.startsWith("W4")).map(p => p.price);
    const target = $(proj("W5 proj"));
    next = (w4.length > 1 ? T(UD("w4NextBetween"), { a: $(w4[0]), b: $(w4[w4.length - 1]), target })
      : w4.length ? T(UD("w4NextAround"), { a: $(w4[0]), target })
      : T(UD("w4NextSoon"), { target })) + breakTxt(!bull);
  } else if (ew.pattern === "corrective") {
    const cg = corrDown ? "Down" : "Up";
    if (st === "flat")
      what = T(`ewStory.flatWhat${cg}`);
    else if (st === "expanded-flat")
      what = T(`ewStory.expWhat${cg}`);
    else
      what = T(`ewStory.zigWhat${cg}${cPastA ? "Past" : ""}`);
    next = T(corrDown ? "ewStory.corrNextUp" : "ewStory.corrNextDown", { a: $(proj("Rev 38.2%")), b: $(proj("Rev 61.8%")), full: $(proj("Rev 100%")) }) + breakTxt(!corrDown);
  }
  return { rows, what, next };
}

function detectElliottWaves(candles: CandleDataPoint[]): EWResult {
  const empty: EWResult = { pattern: "none", direction: "unknown", pivots: [], currentWave: "—", description: "Insufficient data", descKey: "insufficient", complete: false, projections: [], projectionPath: [], invalidation: null };
  if (candles.length < 20) return empty;

  const lastCandle = candles[candles.length - 1];
  const now = lastCandle.time as UTCTimestamp;
  const nowPrice = lastCandle.close;

  // Minimum swing to filter micro-noise (0.15% of price — small enough for all timeframes)
  const minSwing = nowPrice * 0.0015;

  const lb = 3;
  type Pivot = { idx: number; price: number; time: UTCTimestamp; type: "high" | "low" };

  // Build local pivot highs/lows
  const rawPivots: Pivot[] = [];
  for (let i = lb; i < candles.length - lb; i++) {
    const hi = candles[i].high, lo = candles[i].low;
    const isH = candles.slice(i-lb,i).every(c=>c.high<hi) && candles.slice(i+1,i+lb+1).every(c=>c.high<hi);
    const isL = candles.slice(i-lb,i).every(c=>c.low>lo)  && candles.slice(i+1,i+lb+1).every(c=>c.low>lo);
    if (isH) rawPivots.push({ idx: i, price: hi, time: candles[i].time as UTCTimestamp, type: "high" });
    if (isL) rawPivots.push({ idx: i, price: lo, time: candles[i].time as UTCTimestamp, type: "low" });
  }
  rawPivots.sort((a,b) => a.idx - b.idx);

  // Zigzag: deduplicate consecutive same-type, keep most extreme
  const zz: Pivot[] = [];
  for (const p of rawPivots) {
    const last = zz[zz.length - 1];
    if (!last || last.type !== p.type) { zz.push(p); }
    else if (p.type === "high" && p.price > last.price) zz[zz.length-1] = p;
    else if (p.type === "low"  && p.price < last.price) zz[zz.length-1] = p;
  }

  // Filter out tiny swings that don't meet minimum move
  const filt: Pivot[] = [];
  for (const p of zz) {
    const prev = filt[filt.length - 1];
    if (!prev || Math.abs(p.price - prev.price) >= minSwing) filt.push(p);
  }

  if (filt.length < 4) return empty;

  const toEW = (p: EWSwing, label: string): EWPivot => ({ time: p.time, price: p.price, label, pivotType: p.type });

  // Fibonacci scoring (lower = better fit to ideal ratios)
  const fibDev = (actual: number, ideal: number) => Math.abs(actual - ideal);

  function validBull(ps: Pivot[]): boolean {
    const [p0,p1,p2,p3,p4,p5] = ps;
    if (!(p0.type==="low"&&p1.type==="high"&&p2.type==="low"&&p3.type==="high"&&p4.type==="low"&&p5.type==="high")) return false;
    const w1=p1.price-p0.price, w3=p3.price-p2.price, w5=p5.price-p4.price;
    if (p2.price <= p0.price) return false;          // W2 can't breach W0
    if (p3.price <= p1.price) return false;          // W3 must exceed W1 high
    if (p4.price <= p1.price) return false;          // W4 can't overlap W1 territory (strict rule)
    if (w3 < w1 && w3 < w5)  return false;          // W3 can't be shortest
    const r2 = (p1.price-p2.price)/w1, r4 = (p3.price-p4.price)/w3;
    if (r2 < 0.2 || r2 > 0.99) return false;
    if (r4 < 0.1 || r4 > 0.75) return false;
    if (w3/w1 < 0.8) return false;                  // W3 at least 80% of W1
    return true;
  }

  function scoreBull(ps: Pivot[]): number {
    const [p0,p1,p2,p3,p4,p5] = ps;
    const w1=p1.price-p0.price, w3=p3.price-p2.price, w5=p5.price-p4.price;
    return fibDev((p1.price-p2.price)/w1, 0.618)
         + fibDev(w3/w1, 1.618) * 0.5
         + fibDev((p3.price-p4.price)/w3, 0.382)
         + fibDev(w5/w1, 1.0) * 0.5;
  }

  function validBear(ps: Pivot[]): boolean {
    const [p0,p1,p2,p3,p4,p5] = ps;
    if (!(p0.type==="high"&&p1.type==="low"&&p2.type==="high"&&p3.type==="low"&&p4.type==="high"&&p5.type==="low")) return false;
    const w1=p0.price-p1.price, w3=p2.price-p3.price, w5=p4.price-p5.price;
    if (p2.price >= p0.price) return false;
    if (p3.price >= p1.price) return false;
    if (p4.price >= p1.price) return false;          // W4 overlap rule
    if (w3 < w1 && w3 < w5)  return false;
    const r2 = (p2.price-p1.price)/w1, r4 = (p4.price-p3.price)/w3;
    if (r2 < 0.2 || r2 > 0.99) return false;
    if (r4 < 0.1 || r4 > 0.75) return false;
    if (w3/w1 < 0.8) return false;
    return true;
  }

  function scoreBear(ps: Pivot[]): number {
    const [p0,p1,p2,p3,p4,p5] = ps;
    const w1=p0.price-p1.price, w3=p2.price-p3.price, w5=p4.price-p5.price;
    return fibDev((p2.price-p1.price)/w1, 0.618)
         + fibDev(w3/w1, 1.618) * 0.5
         + fibDev((p4.price-p3.price)/w3, 0.382)
         + fibDev(w5/w1, 1.0) * 0.5;
  }

  // Best-scoring complete 5-wave whose wave 5 is the latest swing (or the
  // one before it, i.e. wave A has just started). Older counts are stale —
  // the "correction expected" has already played out (it used to look back
  // 14 swings and report a months-old count as current).
  const SCORE_THRESHOLD = 1.8;
  let bestBullIdx = -1, bestBullScore = Infinity;
  let bestBearIdx = -1, bestBearScore = Infinity;

  for (let s = Math.max(0, filt.length - 7); s <= filt.length - 6; s++) {
    const ps = filt.slice(s, s + 6);
    if (validBull(ps)) { const sc = scoreBull(ps); if (sc < bestBullScore) { bestBullScore = sc; bestBullIdx = s; } }
    if (validBear(ps)) { const sc = scoreBear(ps); if (sc < bestBearScore) { bestBearScore = sc; bestBearIdx = s; } }
  }

  if (bestBullIdx >= 0 && bestBullScore < SCORE_THRESHOLD && (bestBearIdx < 0 || bestBullScore <= bestBearScore)) {
    const [p0,p1,p2,p3,p4,p5] = filt.slice(bestBullIdx, bestBullIdx + 6);
    const total = p5.price - p0.price;
    const avgDur = Math.round((p5.time - p0.time) / 5);
    // Path matches the text: A to the 38.2% level, B halfway back, C ends
    // at the typical 61.8% retrace (the old C formula overshot to 100%+).
    const aT = p5.price - total*0.382, bT = aT + (p5.price-aT)*0.5, cT = p5.price - total*0.618;
    return { pattern:"impulse", direction:"bullish", complete:true, currentWave:"5",
      description:`Bullish 5-wave complete — correction expected (score ${bestBullScore.toFixed(2)})`,
      descKey:"impulseDoneBull", descVars:{ score: bestBullScore.toFixed(2) },
      pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4"),toEW(p5,"5")],
      projections:[
        { label:"A 38.2%", price: p5.price-total*0.382, color:"#fcd34d", isMain:false },
        { label:"A 61.8%", price: p5.price-total*0.618, color:"#f97316", isMain:true },
        { label:"Full 100%", price: p5.price-total*1.0,   color:"#ef4444", isMain:false },
      ],
      projectionPath:[
        { time: now, value: nowPrice },
        { time: (now+avgDur) as UTCTimestamp, value: aT },
        { time: (now+Math.round(avgDur*1.6)) as UTCTimestamp, value: bT },
        { time: (now+Math.round(avgDur*2.6)) as UTCTimestamp, value: cT },
      ],
      // A new high above the wave-5 top means the impulse wasn't actually
      // done — the "correction expected" call is wrong.
      invalidation: p5.price };
  }

  if (bestBearIdx >= 0 && bestBearScore < SCORE_THRESHOLD) {
    const [p0,p1,p2,p3,p4,p5] = filt.slice(bestBearIdx, bestBearIdx + 6);
    const total = p0.price - p5.price;
    const avgDur = Math.round((p5.time - p0.time) / 5);
    // Path matches the text: A to the 38.2% level, B halfway back, C ends
    // at the typical 61.8% retrace (the old C formula overshot to 100%+).
    const aT = p5.price+total*0.382, bT = aT-(aT-p5.price)*0.5, cT = p5.price+total*0.618;
    return { pattern:"impulse", direction:"bearish", complete:true, currentWave:"5",
      description:`Bearish 5-wave complete — correction expected (score ${bestBearScore.toFixed(2)})`,
      descKey:"impulseDoneBear", descVars:{ score: bestBearScore.toFixed(2) },
      pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4"),toEW(p5,"5")],
      projections:[
        { label:"A 38.2%", price: p5.price+total*0.382, color:"#86efac", isMain:false },
        { label:"A 61.8%", price: p5.price+total*0.618, color:"#22c55e", isMain:true },
        { label:"Full 100%", price: p5.price+total*1.0,   color:"#16a34a", isMain:false },
      ],
      projectionPath:[
        { time: now, value: nowPrice },
        { time: (now+avgDur) as UTCTimestamp, value: aT },
        { time: (now+Math.round(avgDur*1.6)) as UTCTimestamp, value: bT },
        { time: (now+Math.round(avgDur*2.6)) as UTCTimestamp, value: cT },
      ],
      // A new low below the wave-5 bottom means the impulse wasn't
      // actually done — the "correction expected" call is wrong.
      invalidation: p5.price };
  }

  // Diagonal (wedge) and triangle — both end at the latest swing.
  const last6 = filt.slice(-6);
  const diag = detectDiagonal(last6, now, nowPrice, toEW);
  if (diag) return diag;
  const tri = detectTriangle(last6, now, nowPrice, toEW);
  if (tri) return tri;

  // In-progress: wave 4 complete → wave 5 forming (5 pivots)
  if (filt.length >= 5) {
    const [p0,p1,p2,p3,p4] = filt.slice(-5);
    // Bullish
    if (p0.type==="low"&&p1.type==="high"&&p2.type==="low"&&p3.type==="high"&&p4.type==="low") {
      const w1=p1.price-p0.price, w3=p3.price-p2.price;
      const r2=(p1.price-p2.price)/w1, r4=(p3.price-p4.price)/w3;
      if (p2.price>p0.price && p3.price>p1.price && p4.price>p1.price &&
          r2>=0.2 && r2<=0.99 && r4>=0.1 && r4<=0.75 && w3>=w1*0.8) {
        const avgDur = Math.round((p4.time-p0.time)/4);
        const t618=p4.price+w1*0.618, t100=p4.price+w1, t162=p4.price+w1*1.618, t262=p4.price+w1*2.618;
        // Guideline: when wave 3 was extended (>1.618× wave 1), wave 5
        // tends to equal wave 1; otherwise wave 5 is the one that stretches.
        const w3ext = w3 > w1 * 1.618;
        return { pattern:"impulse", direction:"bullish", complete:false, currentWave:"5",
          description:"Wave 4 complete — wave 5 forming", descKey:"wave5Forming",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4")],
          projections:[
            { label:"W5 0.618× W1",   price:t618, color:"#c4b5fd", isMain:false },
            { label:"W5 equal (1.0)",  price:t100, color:"#a78bfa", isMain:w3ext },
            { label:"W5 target (1.618)", price:t162, color:"#7c3aed", isMain:!w3ext },
            { label:"W5 ext (2.618)",  price:t262, color:"#ddd6fe", isMain:false },
          ],
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: w3ext ? t100 : t162 },
          ],
          // A break back below the wave-4 low means wave 5 never
          // materialized — the impulse count is dead.
          invalidation: p4.price };
      }
    }
    // Bearish
    if (p0.type==="high"&&p1.type==="low"&&p2.type==="high"&&p3.type==="low"&&p4.type==="high") {
      const w1=p0.price-p1.price, w3=p2.price-p3.price;
      const r2=(p2.price-p1.price)/w1, r4=(p4.price-p3.price)/w3;
      if (p2.price<p0.price && p3.price<p1.price && p4.price<p1.price &&
          r2>=0.2 && r2<=0.99 && r4>=0.1 && r4<=0.75 && w3>=w1*0.8) {
        const avgDur = Math.round((p4.time-p0.time)/4);
        const t618=p4.price-w1*0.618, t100=p4.price-w1, t162=p4.price-w1*1.618, t262=p4.price-w1*2.618;
        const w3ext = w3 > w1 * 1.618;   // see the bullish case
        return { pattern:"impulse", direction:"bearish", complete:false, currentWave:"5",
          description:"Wave 4 complete — wave 5 forming", descKey:"wave5Forming",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4")],
          projections:[
            { label:"W5 0.618× W1",   price:t618, color:"#c4b5fd", isMain:false },
            { label:"W5 equal (1.0)",  price:t100, color:"#a78bfa", isMain:w3ext },
            { label:"W5 target (1.618)", price:t162, color:"#7c3aed", isMain:!w3ext },
            { label:"W5 ext (2.618)",  price:t262, color:"#ddd6fe", isMain:false },
          ],
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: w3ext ? t100 : t162 },
          ],
          // A break back above the wave-4 high means wave 5 never
          // materialized — the impulse count is dead.
          invalidation: p4.price };
      }
    }
  }

  // In-progress: wave 3 complete → wave 4 retracing (4 pivots)
  if (filt.length >= 4) {
    const [p0,p1,p2,p3] = filt.slice(-4);
    // Four swings read either as waves 0-1-2-3 or as an A-B-C. A flat's B
    // (>80% retrace) or a zig-zag whose C isn't extended (<1.2× A) fits the
    // correction better — real wave 3s are usually extended.
    const abcAlt = classifyABC(p0, p1, p2, p3);
    const preferABC = !!abcAlt && (abcAlt.subtype !== "zigzag" || Math.abs(p3.price - p2.price) < Math.abs(p1.price - p0.price) * 1.2);
    // Bullish
    if (!preferABC && p0.type==="low"&&p1.type==="high"&&p2.type==="low"&&p3.type==="high") {
      const w1=p1.price-p0.price, w3=p3.price-p2.price;
      const r2=(p1.price-p2.price)/w1;
      if (p2.price>p0.price && p3.price>p1.price && r2>=0.2 && r2<=0.99 && w3>=w1*0.8) {
        const avgDur = Math.round((p3.time-p0.time)/3);
        const t382=p3.price-w3*0.382, t5=p3.price-w3*0.5, t618=p3.price-w3*0.618;
        // Wave 5 ≈ wave 1; when that wouldn't even pass wave 3's high (wave 3
        // was extended), use the other guideline: 0.618 × the whole 0→3 move.
        const w5eq = t382 + w1;
        const w5proj = w5eq > p3.price ? w5eq : t382 + (p3.price - p0.price) * 0.618;
        return { pattern:"impulse", direction:"bullish", complete:false, currentWave:"4",
          description:"Wave 3 complete — wave 4 retracement expected", descKey:"wave4Expected",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3")],
          projections:[
            { label:"W4 38.2%", price:t382,   color:"#fbbf24", isMain:false },
            { label:"W4 50%",   price:t5,     color:"#f59e0b", isMain:true },
            { label:"W4 61.8%", price:t618,   color:"#d97706", isMain:false },
            { label:"W5 proj",  price:w5proj, color:"#a78bfa", isMain:false },
          // A wave-4 level inside wave 1's range would break the rule below.
          ].filter(p => !p.label.startsWith("W4") || p.price > p1.price),
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: t382 },
            { time: (now+Math.round(avgDur*2)) as UTCTimestamp, value: w5proj },
          ],
          // Wave 4 can't trade back into wave 1's territory — a break
          // below the wave-1 high breaks the impulsive structure.
          invalidation: p1.price };
      }
    }
    // Bearish
    if (!preferABC && p0.type==="high"&&p1.type==="low"&&p2.type==="high"&&p3.type==="low") {
      const w1=p0.price-p1.price, w3=p2.price-p3.price;
      const r2=(p2.price-p1.price)/w1;
      if (p2.price<p0.price && p3.price<p1.price && r2>=0.2 && r2<=0.99 && w3>=w1*0.8) {
        const avgDur = Math.round((p3.time-p0.time)/3);
        const t382=p3.price+w3*0.382, t5=p3.price+w3*0.5, t618=p3.price+w3*0.618;
        // Same as the bullish case: never project a wave 5 that fails to
        // make a new low past wave 3.
        const w5eq = t382 - w1;
        const w5proj = w5eq < p3.price ? w5eq : t382 - (p0.price - p3.price) * 0.618;
        return { pattern:"impulse", direction:"bearish", complete:false, currentWave:"4",
          description:"Wave 3 complete — wave 4 retracement expected", descKey:"wave4Expected",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3")],
          projections:[
            { label:"W4 38.2%", price:t382,   color:"#fbbf24", isMain:false },
            { label:"W4 50%",   price:t5,     color:"#f59e0b", isMain:true },
            { label:"W4 61.8%", price:t618,   color:"#d97706", isMain:false },
            { label:"W5 proj",  price:w5proj, color:"#a78bfa", isMain:false },
          ].filter(p => !p.label.startsWith("W4") || p.price < p1.price),
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: t382 },
            { time: (now+Math.round(avgDur*2)) as UTCTimestamp, value: w5proj },
          ],
          // Wave 4 can't trade back into wave 1's territory — a break
          // above the wave-1 low breaks the impulsive structure.
          invalidation: p1.price };
      }
    }

    // A-B-C corrective — named Zig-Zag / Flat / Expanded Flat by how far
    // B retraced A (zig-zag < 80%, flat ≈ 80–105%, expanded flat > 105%).
    const [q0,qa,qb,qc] = filt.slice(-4);
    const abc = classifyABC(q0, qa, qb, qc);
    if (abc && q0.type==="high") {
      const drop=q0.price-qc.price, avgDur=Math.round((qc.time-q0.time)/3);
      return { pattern:"corrective", direction:"bearish", complete:true, currentWave:"C",
        subtype: abc.subtype, name: abc.name,
        description:`Bearish ${abc.name} (A-B-C) complete — expect bullish reversal`, descKey:"abcDoneBear",
        pivots:[toEW(q0,"0"),toEW(qa,"A"),toEW(qb,"B"),toEW(qc,"C")],
        projections:[
          { label:"Rev 38.2%", price:qc.price+drop*0.382, color:"#86efac", isMain:false },
          { label:"Rev 61.8%", price:qc.price+drop*0.618, color:"#22c55e", isMain:true },
          { label:"Rev 100%",  price:q0.price,            color:"#4ade80", isMain:false },
        ],
        projectionPath:[
          { time: now, value: nowPrice },
          { time: (now+avgDur) as UTCTimestamp, value: qc.price+drop*0.618 },
          { time: (now+Math.round(avgDur*2)) as UTCTimestamp, value: q0.price },
        ],
        // A new low below C means the correction wasn't actually over —
        // the "bullish reversal expected" call is wrong.
        invalidation: qc.price };
    }
    if (abc && q0.type==="low") {
      const rise=qc.price-q0.price, avgDur=Math.round((qc.time-q0.time)/3);
      return { pattern:"corrective", direction:"bullish", complete:true, currentWave:"C",
        subtype: abc.subtype, name: abc.name,
        description:`Bullish ${abc.name} (A-B-C) complete — expect bearish reversal`, descKey:"abcDoneBull",
        pivots:[toEW(q0,"0"),toEW(qa,"A"),toEW(qb,"B"),toEW(qc,"C")],
        projections:[
          { label:"Rev 38.2%", price:qc.price-rise*0.382, color:"#fca5a5", isMain:false },
          { label:"Rev 61.8%", price:qc.price-rise*0.618, color:"#ef4444", isMain:true },
          { label:"Rev 100%",  price:q0.price,            color:"#f87171", isMain:false },
        ],
        projectionPath:[
          { time: now, value: nowPrice },
          { time: (now+avgDur) as UTCTimestamp, value: qc.price-rise*0.618 },
          { time: (now+Math.round(avgDur*2)) as UTCTimestamp, value: q0.price },
        ],
        // A new high above C means the correction wasn't actually over —
        // the "bearish reversal expected" call is wrong.
        invalidation: qc.price };
    }
  }

  return empty;
}

// ── ICT / Smart Money Concepts ───────────────────────────────────────────────

interface OBZone  { type: "bull" | "bear"; high: number; low: number; time: number }
interface FVGZone { type: "bull" | "bear"; top: number; bottom: number; time: number }
interface SMCMarker { kind: "bos" | "choch"; dir: "bull" | "bear"; time: number }
interface LiqPool { type: "buy" | "sell"; price: number; count: number }
interface PDZone  { high: number; low: number; mid: number }
interface OTEZone { type: "bull" | "bear"; top: number; bottom: number }
interface ICTResult {
  orderBlocks: OBZone[];
  fvgs: FVGZone[];
  structure: SMCMarker[];
  liquidityPools: LiqPool[];
  pd: PDZone | null;
  ote: OTEZone | null;
}

function groupLevels(prices: number[], tol: number): { price: number; count: number }[] {
  const groups: { price: number; count: number }[] = [];
  for (const p of [...prices].sort((a, b) => a - b)) {
    const g = groups.find(x => Math.abs(x.price - p) / x.price < tol);
    if (g) { g.price = (g.price + p) / 2; g.count++; }
    else groups.push({ price: p, count: 1 });
  }
  return groups;
}

function detectICT(candles: CandleDataPoint[]): ICTResult {
  const empty: ICTResult = { orderBlocks: [], fvgs: [], structure: [], liquidityPools: [], pd: null, ote: null };
  if (candles.length < 12) return empty;
  const n = candles.length;

  // ── FVGs with mitigation ───────────────────────────────────────────────────
  const fvgs: FVGZone[] = [];
  for (let i = 1; i < n - 1; i++) {
    const prev = candles[i - 1], next = candles[i + 1];
    if (next.low > prev.high) {
      const mitigated = candles.slice(i + 2).some(c => c.low <= prev.high);
      if (!mitigated) fvgs.push({ type: "bull", top: next.low, bottom: prev.high, time: candles[i].time });
    }
    if (next.high < prev.low) {
      const mitigated = candles.slice(i + 2).some(c => c.high >= prev.low);
      if (!mitigated) fvgs.push({ type: "bear", top: prev.low, bottom: next.high, time: candles[i].time });
    }
  }

  // ── Order Blocks with mitigation ──────────────────────────────────────────
  const orderBlocks: OBZone[] = [];
  for (let i = 1; i < n - 2; i++) {
    const c = candles[i], n1 = candles[i + 1], n2 = candles[i + 2];
    const moveUp   = n1.close > n1.open && (n2.close - c.close) / c.close > 0.004;
    const moveDown = n1.close < n1.open && (c.close - n2.close) / c.close > 0.004;
    if (c.close < c.open && moveUp) {
      if (!candles.slice(i + 3).some(x => x.low <= c.close))
        orderBlocks.push({ type: "bull", high: c.open, low: c.close, time: c.time });
    }
    if (c.close > c.open && moveDown) {
      if (!candles.slice(i + 3).some(x => x.high >= c.close))
        orderBlocks.push({ type: "bear", high: c.close, low: c.open, time: c.time });
    }
  }

  // ── BOS / CHoCH ────────────────────────────────────────────────────────────
  const structure: SMCMarker[] = [];
  const sw = 3;
  let trendBull = true, lastSH: number | null = null, lastSL: number | null = null;
  for (let i = sw; i < n - sw; i++) {
    const hi = candles[i].high, lo = candles[i].low;
    const isSH = candles.slice(i-sw,i).every(c=>c.high<hi) && candles.slice(i+1,i+sw+1).every(c=>c.high<hi);
    const isSL = candles.slice(i-sw,i).every(c=>c.low>lo)  && candles.slice(i+1,i+sw+1).every(c=>c.low>lo);
    if (isSH && lastSH !== null && hi > lastSH) {
      structure.push({ kind: trendBull ? "bos" : "choch", dir: "bull", time: candles[i].time });
      if (!trendBull) trendBull = true;
    }
    if (isSL && lastSL !== null && lo < lastSL) {
      structure.push({ kind: !trendBull ? "bos" : "choch", dir: "bear", time: candles[i].time });
      if (trendBull) trendBull = false;
    }
    if (isSH) lastSH = hi;
    if (isSL) lastSL = lo;
  }

  // ── Liquidity Pools (equal highs / equal lows) ────────────────────────────
  const swHigbs: number[] = [], swLows: number[] = [];
  for (let i = sw; i < n - sw; i++) {
    const hi = candles[i].high, lo = candles[i].low;
    if (candles.slice(i-sw,i).every(c=>c.high<=hi) && candles.slice(i+1,i+sw+1).every(c=>c.high<=hi)) swHigbs.push(hi);
    if (candles.slice(i-sw,i).every(c=>c.low>=lo)  && candles.slice(i+1,i+sw+1).every(c=>c.low>=lo))  swLows.push(lo);
  }
  const liquidityPools: LiqPool[] = [
    ...groupLevels(swHigbs, 0.001).filter(g => g.count >= 2).map(g => ({ type: "buy"  as const, price: g.price, count: g.count })),
    ...groupLevels(swLows,  0.001).filter(g => g.count >= 2).map(g => ({ type: "sell" as const, price: g.price, count: g.count })),
  ];

  // ── Premium & Discount (last 60 candles range) ────────────────────────────
  const pdSlice = candles.slice(-Math.min(60, n));
  const pdHigh  = Math.max(...pdSlice.map(c => c.high));
  const pdLow   = Math.min(...pdSlice.map(c => c.low));
  const pd: PDZone = { high: pdHigh, low: pdLow, mid: (pdHigh + pdLow) / 2 };

  // ── OTE — 0.618–0.705 Fibonacci of last impulse leg ──────────────────────
  let ote: OTEZone | null = null;
  const oteSlice = candles.slice(-Math.min(40, n));
  let shIdx = -1, slIdx = -1, shPrice = 0, slPrice = Infinity;
  for (let i = 2; i < oteSlice.length - 2; i++) {
    const hi = oteSlice[i].high, lo = oteSlice[i].low;
    if (oteSlice.slice(i-2,i).every(c=>c.high<hi) && oteSlice.slice(i+1,i+3).every(c=>c.high<hi)) { shIdx=i; shPrice=hi; }
    if (oteSlice.slice(i-2,i).every(c=>c.low>lo)  && oteSlice.slice(i+1,i+3).every(c=>c.low>lo))  { slIdx=i; slPrice=lo; }
  }
  if (shIdx > 0 && slIdx > 0) {
    const impulse = shPrice - slPrice;
    if (slIdx < shIdx) {
      // Bullish impulse → OTE retracement zone below
      ote = { type: "bull", top: shPrice - impulse * 0.618, bottom: shPrice - impulse * 0.705 };
    } else {
      // Bearish impulse → OTE retracement zone above
      ote = { type: "bear", top: slPrice + impulse * 0.705, bottom: slPrice + impulse * 0.618 };
    }
  }

  return {
    orderBlocks: orderBlocks.slice(-4),
    fvgs:        fvgs.slice(-4),
    structure:   structure.slice(-8),
    liquidityPools: liquidityPools.slice(-6),
    pd,
    ote,
  };
}

// ── Retest detection ──────────────────────────────────────────────────────────

interface RetestEvent {
  time: number;
  price: number;
  type: "bearish" | "bullish";
}

function detectRetests(candles: CandleDataPoint[], ict: ICTResult): RetestEvent[] {
  if (candles.length < 20) return [];

  // Collect significant levels: S/R + liquidity pools + OB midpoints
  const { support, resistance } = calcSR(candles);
  const levels: number[] = [
    ...resistance,
    ...support,
    ...ict.liquidityPools.map(lp => lp.price),
    ...ict.orderBlocks.map(ob => (ob.high + ob.low) / 2),
  ];

  const tol = 0.009; // 0.9% proximity to level counts as a touch
  const breakTol = 0.004;
  const seen = new Set<number>();
  const retests: RetestEvent[] = [];

  for (const level of levels) {
    let state: "above" | "below" | null = null;
    let brokeIdx = -1;

    for (let i = 3; i < candles.length; i++) {
      const c = candles[i];
      const aboveNow = c.close > level;

      if (state === null) { state = aboveNow ? "above" : "below"; continue; }

      // Detect clean break below
      if (state === "above" && c.close < level * (1 - breakTol)) { state = "below"; brokeIdx = i; continue; }
      // Detect clean break above
      if (state === "below" && c.close > level * (1 + breakTol)) { state = "above"; brokeIdx = i; continue; }

      if (brokeIdx < 0 || i < brokeIdx + 2) continue;

      // Bearish retest: broke below, wick touches back up to level, closes below
      if (state === "below" && Math.abs(c.high - level) / level < tol && c.close < level) {
        if (!seen.has(c.time)) { seen.add(c.time); retests.push({ time: c.time, price: level, type: "bearish" }); brokeIdx = -1; }
      }
      // Bullish retest: broke above, wick touches back down to level, closes above
      if (state === "above" && Math.abs(c.low - level) / level < tol && c.close > level) {
        if (!seen.has(c.time)) { seen.add(c.time); retests.push({ time: c.time, price: level, type: "bullish" }); brokeIdx = -1; }
      }
    }
  }

  return retests.slice(-8);
}

// ── Volume Profile ────────────────────────────────────────────────────────────
// Candle-based approximation (no tick data available) — buckets each
// candle's volume into a price bin by its typical price ((h+l+c)/3), not
// spread across its full range. Standard simplification for retail tools
// working from OHLCV bars; genuinely accurate volume-at-price needs order
// book/tick data no public API here provides.

interface VolumeProfileResult { poc: number; vah: number; val: number }

function detectVolumeProfile(candles: CandleDataPoint[], bins = 30): VolumeProfileResult | null {
  if (candles.length < 10) return null;
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const max = Math.max(...highs), min = Math.min(...lows);
  if (!(max > min)) return null;

  const binSize = (max - min) / bins;
  const volAtBin = new Array(bins).fill(0);
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((typical - min) / binSize)));
    volAtBin[idx] += c.volume || 0;
  }

  const totalVol = volAtBin.reduce((a, b) => a + b, 0);
  if (totalVol <= 0) return null;

  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (volAtBin[i] > volAtBin[pocIdx]) pocIdx = i;

  // Grow the value area outward from POC, always taking whichever
  // neighbor has more volume, until 70% of total volume is enclosed.
  let loIdx = pocIdx, hiIdx = pocIdx, acc = volAtBin[pocIdx];
  const target = totalVol * 0.7;
  while (acc < target && (loIdx > 0 || hiIdx < bins - 1)) {
    const nextLoVol = loIdx > 0 ? volAtBin[loIdx - 1] : -1;
    const nextHiVol = hiIdx < bins - 1 ? volAtBin[hiIdx + 1] : -1;
    if (nextHiVol >= nextLoVol) { hiIdx++; acc += volAtBin[hiIdx]; }
    else { loIdx--; acc += volAtBin[loIdx]; }
  }

  return {
    poc: min + (pocIdx + 0.5) * binSize,
    vah: min + (hiIdx + 1) * binSize,
    val: min + loIdx * binSize,
  };
}

// ── Session reference levels ──────────────────────────────────────────────────
// Daily open, the current week's Monday open/high/low, and previous day's
// high/low — the fixed reference levels ICT-style traders anchor to,
// independent of whatever interval is currently on screen.

interface SessionLevels {
  dailyOpen: number;
  weeklyOpen: number;
  mondayHigh: number;
  mondayLow: number;
  prevDayHigh: number;
  prevDayLow: number;
}

function computeSessionLevels(dailyCandles: CandleDataPoint[]): SessionLevels | null {
  if (dailyCandles.length < 2) return null;
  const last = dailyCandles[dailyCandles.length - 1];
  const prev = dailyCandles[dailyCandles.length - 2];

  let monday: CandleDataPoint | null = null;
  for (let i = dailyCandles.length - 1; i >= 0; i--) {
    if (new Date(Number(dailyCandles[i].time) * 1000).getUTCDay() === 1) { monday = dailyCandles[i]; break; }
  }
  if (!monday) return null;

  return {
    dailyOpen: last.open,
    weeklyOpen: monday.open,
    mondayHigh: monday.high,
    mondayLow: monday.low,
    prevDayHigh: prev.high,
    prevDayLow: prev.low,
  };
}

// ── Historical Fractal / Pattern-Analog Detector ────────────────────────────────
// Not a rule-based classifier like Elliott/ICT/Wyckoff above — an empirical
// similarity search. Takes the current W-candle window, normalizes it to pure
// shape (% change from the window's own start, so absolute price and
// volatility level don't matter), then slides the same window across the
// historical corpus looking for past shapes that scored close on normalized
// Euclidean distance. For each match, reads what price actually did over the
// next F candles — the result is a distribution of real outcomes, not a
// prediction, same framing as the forecast fan/volatility cone elsewhere in
// this file.

interface FractalMatch {
  startTime: UTCTimestamp;
  time: UTCTimestamp;
  forwardEndTime: UTCTimestamp;
  similarity: number;
  forwardReturn: number;
  // Normalized % change from the match window's own start, covering the
  // full window + forward horizon — lets the UI plot this match's whole
  // path (the part that lines up with "now" AND what happened after)
  // overlaid against the live window on one shared axis.
  path: number[];
  // % change from the match's OWN end (day 0 = "today" for that analog),
  // one entry per day through the forward horizon — separate from `path`
  // because a detail view wants "how far did it swing before landing here,"
  // which has to be measured from the analog's own present, not its
  // window's start.
  forwardPath: number[];
}
interface FractalAnalogsResult {
  matches: FractalMatch[];
  upCount: number;
  avgForwardReturn: number;
  windowSize: number;
  forwardHorizon: number;
  // Same normalization as each match's path, but for the live/current
  // window — only windowSize long since there's no "after" yet.
  currentPath: number[];
  currentStart: UTCTimestamp;
  currentEnd: UTCTimestamp;
}

// Daily-candle, month-scale windows specifically — this is meant to answer
// "has this coin traced this same ~month-long shape before," not to
// shape-match on whatever interval happens to be on screen (1h/4h shapes
// are too noisy/short-lived for this kind of analog to mean much).
const FRACTAL_WINDOW = 30;
const FRACTAL_HORIZON = 15;
const FRACTAL_TOP_K = 5;
const FRACTAL_MIN_HISTORY = 365;

function shapeOf(candles: CandleDataPoint[], start: number, len: number): number[] {
  const base = candles[start].close;
  const out = new Array(len);
  for (let i = 0; i < len; i++) out[i] = (candles[start + i].close - base) / base;
  return out;
}

// Largest peak-to-trough drop and trough-to-peak rise within a % change
// path — used to characterize a window's choppiness for the detail view
// beyond just its net start-to-end move.
function maxDrawdownRally(path: number[]): { maxDrawdown: number; maxRally: number } {
  let runningMax = path[0], runningMin = path[0];
  let maxDrawdown = 0, maxRally = 0;
  for (let i = 1; i < path.length; i++) {
    const dd = path[i] - runningMax;
    if (dd < maxDrawdown) maxDrawdown = dd;
    const rl = path[i] - runningMin;
    if (rl > maxRally) maxRally = rl;
    runningMax = Math.max(runningMax, path[i]);
    runningMin = Math.min(runningMin, path[i]);
  }
  return { maxDrawdown, maxRally };
}

function detectFractalAnalogs(
  currentCandles: CandleDataPoint[],
  historicalCandles: CandleDataPoint[],
  windowSize = FRACTAL_WINDOW,
  forwardHorizon = FRACTAL_HORIZON,
  topK = FRACTAL_TOP_K,
): FractalAnalogsResult | null {
  if (currentCandles.length < windowSize || historicalCandles.length < windowSize + forwardHorizon + FRACTAL_MIN_HISTORY) {
    return null;
  }

  const currentShape = shapeOf(currentCandles, currentCandles.length - windowSize, windowSize);

  // Every historical window that ends far enough from the corpus's own end
  // to have a real forward outcome to read, scanned oldest-first.
  const lastStart = historicalCandles.length - windowSize - forwardHorizon;
  const candidates: { idx: number; distance: number }[] = [];
  for (let start = 0; start <= lastStart; start++) {
    const shape = shapeOf(historicalCandles, start, windowSize);
    let sumSq = 0;
    for (let i = 0; i < windowSize; i++) {
      const d = shape[i] - currentShape[i];
      sumSq += d * d;
    }
    candidates.push({ idx: start, distance: Math.sqrt(sumSq) });
  }
  candidates.sort((a, b) => a.distance - b.distance);

  // Greedily take the best non-overlapping matches — without this, the top
  // K would just be near-duplicate windows one candle apart from each other.
  const picked: { idx: number; distance: number }[] = [];
  for (const c of candidates) {
    if (picked.some(p => Math.abs(p.idx - c.idx) < windowSize)) continue;
    picked.push(c);
    if (picked.length >= topK) break;
  }
  if (picked.length === 0) return null;

  // Similarity as an absolute 0-100% score, anchored to the MEDIAN
  // distance across the entire historical scan (every `candidates` entry,
  // already computed above) rather than either (a) the worst of just the
  // 5 picks — self-referential, a 6% reading didn't mean "6% similar," it
  // meant "the least-close of whichever 5 happened to be closest" — or
  // (b) a single-sample estimate derived from currentShape's own RMS,
  // which Monte Carlo testing showed has high sampling variance (a 30-point
  // sample's RMS swings a lot trial to trial), making the % unstable in a
  // way that has nothing to do with actual match quality. The full
  // candidate population (typically thousands of windows) gives a far
  // more stable "what's a typical/unremarkable distance for this coin"
  // reference: 0 distance = 100%, at-or-past the population median = 0%.
  const noiseFloor = candidates[Math.floor(candidates.length / 2)].distance || 1e-9;
  const matches: FractalMatch[] = picked.map(({ idx, distance }) => {
    const matchEndIdx = idx + windowSize - 1;
    const endClose = historicalCandles[matchEndIdx].close;
    const fwdClose = historicalCandles[matchEndIdx + forwardHorizon].close;
    const forwardPath: number[] = [];
    for (let h = 0; h <= forwardHorizon; h++) {
      forwardPath.push((historicalCandles[matchEndIdx + h].close - endClose) / endClose);
    }
    return {
      startTime: historicalCandles[idx].time as UTCTimestamp,
      time: historicalCandles[matchEndIdx].time as UTCTimestamp,
      forwardEndTime: historicalCandles[matchEndIdx + forwardHorizon].time as UTCTimestamp,
      similarity: Math.max(0, Math.min(100, Math.round((1 - distance / noiseFloor) * 100))),
      forwardReturn: (fwdClose - endClose) / endClose * 100,
      forwardPath,
      path: shapeOf(historicalCandles, idx, windowSize + forwardHorizon),
    };
  });

  const upCount = matches.filter(m => m.forwardReturn > 0).length;
  const avgForwardReturn = matches.reduce((sum, m) => sum + m.forwardReturn, 0) / matches.length;

  return {
    matches, upCount, avgForwardReturn, windowSize, forwardHorizon,
    currentPath: currentShape,
    currentStart: currentCandles[currentCandles.length - windowSize].time as UTCTimestamp,
    currentEnd: currentCandles[currentCandles.length - 1].time as UTCTimestamp,
  };
}

// ── AI Analysis ───────────────────────────────────────────────────────────────

async function getMMAnalysis(
  coin: string,
  intervalLabel: string,
  candles: CandleDataPoint[],
  ind: Indicators,
  pattern: Pattern,
  wyckoff?: WyckoffResult | null,
  ict?: ICTResult | null,
  sessionLevels?: SessionLevels | null,
  volumeProfile?: VolumeProfileResult | null,
  fractalAnalogs?: FractalAnalogsResult | null,
): Promise<AIRead | null> {
  const last = candles[candles.length - 1];
  const recent50 = candles.slice(-35).map(c => ({
    o: c.open.toFixed(2), h: c.high.toFixed(2), l: c.low.toFixed(2), cl: c.close.toFixed(2),
    v: c.volume ? (c.volume / 1000).toFixed(1) + "K" : "?",
  }));

  const rsiLabel  = ind.rsi == null ? "N/A" : `${ind.rsi.toFixed(1)} (${ind.rsi >= 70 ? "overbought" : ind.rsi <= 30 ? "oversold" : "neutral"})`;
  const macdLabel = ind.macdHist == null ? "N/A" : `hist ${ind.macdHist > 0 ? "+" : ""}${ind.macdHist.toFixed(4)} (${ind.macdHist > 0 ? "bullish" : "bearish"})`;
  const bbLabel   = ind.bbPct == null ? "N/A" : `${(ind.bbPct * 100).toFixed(0)}% (${ind.bbPct >= 0.8 ? "near upper — watch for rejection" : ind.bbPct <= 0.2 ? "near lower — watch for bounce" : "mid-range"})`;
  const volLabel  = ind.volRatio == null ? "N/A" : `${ind.volRatio.toFixed(2)}× avg (${ind.volRatio >= 2 ? "volume spike — strong conviction" : ind.volRatio >= 1.3 ? "above avg" : ind.volRatio < 0.7 ? "low — weak move" : "normal"})`;
  const ema20rel  = ind.ema20 != null ? (last.close > ind.ema20 ? `ABOVE $${ind.ema20.toFixed(2)} ✓` : `BELOW $${ind.ema20.toFixed(2)} ✗`) : "N/A";
  const ema50rel  = ind.ema50 != null ? (last.close > ind.ema50 ? `ABOVE $${ind.ema50.toFixed(2)} ✓` : `BELOW $${ind.ema50.toFixed(2)} ✗`) : "N/A";
  const ew = detectElliottWaves(candles);
  const ewLabel = ew.pattern !== "none"
    ? `${ew.name ?? (ew.pattern === "impulse" ? "Impulse" : "Corrective")} ${ew.direction} — ${ew.description}${ew.invalidation != null ? ` (invalidated on a break of $${ew.invalidation.toFixed(2)})` : ""}`
    : "No clear pattern detected";

  const prompt = `You are an elite crypto market analyst specializing in reading market maker (MM) and institutional order flow from raw candlestick action. Your job: decode what smart money is doing on this ${intervalLabel} chart of ${coin}/USD and predict the next move with conviction.

CURRENT PRICE: $${last.close.toFixed(2)}

LAST 35 CANDLES (oldest→newest, OHLCV):
${JSON.stringify(recent50)}

PATTERN DETECTED ON LAST 3 CANDLES: ${pattern.name} (${pattern.type})

TECHNICAL SNAPSHOT:
- RSI(14): ${rsiLabel}
- MACD: ${macdLabel}
- Bollinger Band %: ${bbLabel}
- Volume: ${volLabel}
- EMA 20: ${ema20rel}
- EMA 50: ${ema50rel}
- ATR(14): ${ind.atr ? "$" + ind.atr.toFixed(2) : "N/A"}
- Key Resistance: ${ind.resistance.length ? ind.resistance.map(r => "$" + r.toFixed(0)).join(", ") : "none detected"}
- Key Support: ${ind.support.length ? ind.support.map(s => "$" + s.toFixed(0)).join(", ") : "none detected"}
- Wyckoff Phase: ${wyckoff?.phase ?? "Unknown"}${wyckoff?.springs.length ? ` | Springs: ${wyckoff.springs.length}` : ""}${wyckoff?.upthrusts.length ? ` | Upthrusts: ${wyckoff.upthrusts.length}` : ""}
- Elliott Wave: ${ewLabel}
- SMC Order Blocks: ${ict?.orderBlocks.length ? ict.orderBlocks.map(ob => `${ob.type} OB $${ob.low.toFixed(2)}–$${ob.high.toFixed(2)}`).join(", ") : "none"}
- SMC Fair Value Gaps: ${ict?.fvgs.length ? ict.fvgs.map(f => `${f.type} FVG $${f.bottom.toFixed(2)}–$${f.top.toFixed(2)}`).join(", ") : "none"}
- SMC Structure: ${ict?.structure.length ? ict.structure.slice(-3).map(s => `${s.kind.toUpperCase()} ${s.dir}`).join(", ") : "none"}
- Liquidity Pools: ${ict?.liquidityPools.length ? ict.liquidityPools.map(lp => `${lp.type === "buy" ? "BSL" : "SSL"} $${lp.price.toFixed(2)} (×${lp.count})`).join(", ") : "none"}
- Premium/Discount: ${ict?.pd ? `Range $${ict.pd.low.toFixed(2)}–$${ict.pd.high.toFixed(2)}, EQ $${ict.pd.mid.toFixed(2)}, price is in ${last.close > ict.pd.mid ? "PREMIUM (sell bias)" : "DISCOUNT (buy bias)"}` : "N/A"}
- OTE Zone: ${ict?.ote ? `${ict.ote.type} $${ict.ote.bottom.toFixed(2)}–$${ict.ote.top.toFixed(2)} (0.618–0.705 fib)` : "none"}
- Volume Profile (2W): ${volumeProfile ? `POC $${volumeProfile.poc.toFixed(2)}, Value Area $${volumeProfile.val.toFixed(2)}–$${volumeProfile.vah.toFixed(2)}, price is ${last.close > volumeProfile.vah ? "ABOVE value (extended)" : last.close < volumeProfile.val ? "BELOW value (extended)" : "INSIDE value area"}` : "N/A"}
- Session Levels: ${sessionLevels ? `Daily Open $${sessionLevels.dailyOpen.toFixed(2)}, Weekly Open $${sessionLevels.weeklyOpen.toFixed(2)}, Monday H/L $${sessionLevels.mondayHigh.toFixed(2)}/$${sessionLevels.mondayLow.toFixed(2)}, Prev Day H/L $${sessionLevels.prevDayHigh.toFixed(2)}/$${sessionLevels.prevDayLow.toFixed(2)}` : "N/A"}
- Monthly Fractal (daily candles, ${FRACTAL_WINDOW}d window): ${fractalAnalogs ? `${fractalAnalogs.upCount}/${fractalAnalogs.matches.length} similar month-long setups rose over the next ${fractalAnalogs.forwardHorizon} days, avg forward return ${fractalAnalogs.avgForwardReturn >= 0 ? "+" : ""}${fractalAnalogs.avgForwardReturn.toFixed(2)}%` : "N/A"}

ANALYSIS PROCESS — follow these steps in your "thinking" field before finalizing any output:
1. Narrate the last 50 candles as a story: where did volume spike, where were wicks absorbed, where did price stall?
2. Cross-reference the candle story with SMC structure, liquidity pools, and Wyckoff phase — do they agree or conflict?
3. Check Elliott Wave context: are we in an impulse or corrective leg? What does the current wave imply about the next move?
4. Identify the single most important price level right now and why smart money would care about it.
5. Weigh bull vs bear case honestly. Only assign "high" confidence if at least 3 independent signals agree.
6. Commit to a decisive directional call — no hedging. Also commit to exactly ONE mmAction — do not default to "consolidation" unless nothing else genuinely fits.

mmAction definitions — pick exactly ONE that best classifies what MM is doing THIS candle:
- liquidity_grab: wick sweep of a level then reject
- stop_hunt: deliberate push through obvious stops before reversing
- accumulation: range-bound absorption before markup
- distribution: range-bound offloading before markdown
- breakout: decisive structure break with volume
- retest: pullback to a broken level to confirm it
- consolidation: low-conviction chop, no clear intent
- continuation: trend resuming after a pause
- reversal: trend direction change confirmed

Respond ONLY with valid JSON (the "thinking" field is your scratchpad — fill it first, then derive everything else from it):
{
  "thinking": "Step-by-step reasoning through the 6 analysis steps above. 4-6 sentences minimum. This is your chain-of-thought before committing to any output field.",
  "pattern": "the dominant candle pattern or structure name",
  "patternType": "bullish" | "bearish" | "neutral",
  "mmReading": "2-3 sentences: what smart money is doing right now. Cite specific wick behavior and volume.",
  "mmAction": "liquidity_grab" | "stop_hunt" | "accumulation" | "distribution" | "breakout" | "retest" | "consolidation" | "continuation" | "reversal",
  "nextMove": "2-3 sentences: exactly what price does next, specific targets, and what confirms or invalidates.",
  "keyLevels": [
    { "label": "Resistance", "price": <number>, "side": "above" },
    { "label": "Support",    "price": <number>, "side": "below" }
  ],
  "bias": "bullish" | "bearish" | "neutral",
  "confidence": "high" | "medium" | "low",
  "scenario": {
    "headline": "One bold sentence — the single most probable outcome. No hedging.",
    "bullCase": "One sentence: what happens if buyers take control — include specific target price.",
    "bearCase": "One sentence: what happens if sellers take control — include specific target price.",
    "trigger": "One sentence: the exact price, candle close, or volume event that confirms the scenario.",
    "probability": "bulls favored" | "bears favored" | "50/50"
  }
}`;

  // A failed request (AI limit reached, signed out, network) throws so the
  // caller can tell the user why; only an unreadable answer returns null.
  const data = await callOpenAI({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.3,
    max_tokens: 1400,
  });
  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}") as AIRead;
    if (!parsed.mmReading) return null;
    if (!parsed.mmAction) parsed.mmAction = "consolidation";
    if (!Array.isArray(parsed.keyLevels)) parsed.keyLevels = [];
    return parsed;
  } catch {
    return null;
  }
}

// ── Multi-timeframe alignment ─────────────────────────────────────────────────

interface MTFBias { label: string; interval: string; bias: "bullish" | "bearish" | "neutral" }

async function fetchMTFBiases(coin: string): Promise<MTFBias[]> {
  const frames: MTFBias[] = [
    { label: "1H", interval: "1h",  bias: "neutral" },
    { label: "4H", interval: "4h",  bias: "neutral" },
    { label: "1D", interval: "1d",  bias: "neutral" },
    { label: "1W", interval: "1w",  bias: "neutral" },
  ];
  const results = await Promise.allSettled(frames.map(f => coinglass.getCandles(coin, f.interval, 60)));
  return frames.map((f, i) => {
    if (results[i].status !== "fulfilled") return f;
    const candles = (results[i] as PromiseFulfilledResult<CandleDataPoint[]>).value;
    if (candles.length < 50) return f;
    const closes  = candles.map(c => c.close);
    const ema20   = calcEMA(closes, 20);
    const ema50   = calcEMA(closes, 50);
    const e20 = ema20[ema20.length - 1], e50 = ema50[ema50.length - 1];
    const close = closes[closes.length - 1];
    const bias: MTFBias["bias"] =
      close > e20 && e20 > e50 ? "bullish" :
      close < e20 && e20 < e50 ? "bearish" : "neutral";
    return { ...f, bias };
  });
}

/** First "$12,345.67" in a sentence (AI scenario text → its price level). */
function firstPrice(s: string): number | null {
  const m = s.match(/\$\s?([\d,]+(?:\.\d+)?)/);
  const v = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ── Today's read ─────────────────────────────────────────────────────────────
// One line at the top of Live Signals that reconciles the signals:
// "right now" = this chart's chart pattern + Elliott next move + a fresh
// candle pattern; "bigger picture" = the 4H / 1D / 1W trends. When they
// disagree it says so ("short-term down, bigger picture up").

type ReadDir = "up" | "down" | "flat";
interface TodaysRead {
  headline: string;                                  // e.g. "Bounce inside a downtrend"
  line: string;                                      // one-sentence summary
  tone: ReadDir | "mixed";
  why: Array<{ text: string; dir: ReadDir }>;        // one plain sentence per signal
  watch: string;                                     // levels that confirm / change the view
  momentum: string | null;                           // RSI + volume context
  /** One-tap price alerts for the levels above (direction from the current price). */
  alerts: Array<{ price: number; direction: "above" | "below"; why: string }>;
}

/** One plain sentence for what the Elliott count expects. */
function ewWhy(ew: EWResult): string {
  const b = ew.direction === "bullish";
  const proj = (l: string) => ew.projections.find(p => p.label === l)?.price;
  const main = ew.projections.find(p => p.isMain)?.price;
  const $ = (n?: number) => (n == null ? "—" : ewFmt(n));
  const ud = b ? "Up" : "Down";
  if (ew.subtype === "triangle") return T(`why.ewTri${ud}`, { price: $(main) });
  if (ew.subtype === "diagonal") return T(`why.ewDiag${ud}`, { price: $(proj("W2")) });
  if (ew.pattern === "impulse" && ew.complete) return T(`why.ewDone${ud}`, { a: $(proj("A 38.2%")), b: $(proj("A 61.8%")) });
  if (ew.pattern === "impulse" && ew.currentWave === "5") return T(`why.ewW5${ud}`, { price: $(main) });
  if (ew.pattern === "impulse" && ew.currentWave === "4") return T(`why.ewW4${ud}`, { price: $(proj("W5 proj")) });
  const down = ew.direction === "bearish";
  const vars = { a: $(proj("Rev 38.2%")), b: $(proj("Rev 61.8%")), name: ew.name ? ewNameT(ew.name).toLocaleLowerCase(i18next.language) : "" };
  return T(`why.ewAbc${down ? "Down" : "Up"}${ew.name ? "Named" : ""}`, vars);
}

function buildTodaysRead(o: {
  candle: CandlePatternScan | null; chart: ChartPattern | null; ew: EWResult | null; mtf: MTFBias[];
  ind: Indicators | null; price: number | null;
}): TodaysRead | null {
  const $ = (n: number) => ewFmt(n);
  const why: TodaysRead["why"] = [];
  let s = 0, w = 0;
  // A chart pattern carries the most weight (more so once confirmed), then
  // the Elliott count's net call, then a candle pattern from the last 3 candles.
  if (o.chart) {
    const c = o.chart, d = c.bias === "bullish" ? 1 : -1, wt = c.status === "breakout" ? 2 : 1.5;
    s += d * wt; w += wt;
    why.push({ dir: d > 0 ? "up" : "down", text: T(`why.chart${c.status === "breakout" ? "Broke" : "Forming"}${d > 0 ? "Up" : "Down"}`,
      { name: c.name, trigger: $(c.trigger), target: $(c.target) }) });
  }
  if (o.ew && o.ew.pattern !== "none") {
    const up = ewNextUp(o.ew);
    s += up ? 1 : -1; w += 1;
    why.push({ dir: up ? "up" : "down", text: ewWhy(o.ew) });
  }
  if (o.candle && o.candle.pattern.type !== "neutral" && o.candle.candlesAgo <= 3) {
    const k = o.candle, d = k.pattern.type === "bullish" ? 1 : -1;
    s += d; w += 1;
    const record = k.hits !== null ? " " + T("why.candleRecord", { hits: k.hits, samples: k.samples }) : "";
    why.push({ dir: d > 0 ? "up" : "down", text: T(`why.candle${k.candlesAgo === 1 ? "Last" : "Ago"}${d > 0 ? "Bull" : "Bear"}`,
      { name: patName(k.pattern.name), n: k.candlesAgo }) + record });
  }
  const short: ReadDir | null = w === 0 ? null : s / w >= 0.34 ? "up" : s / w <= -0.34 ? "down" : "flat";

  const htf = o.mtf.filter(b => ["4H", "1D", "1W"].includes(b.label));
  let big: ReadDir | null = null;
  if (htf.length) {
    const sc = htf.reduce((a, b) => a + (b.bias === "bullish" ? 1 : b.bias === "bearish" ? -1 : 0), 0) / htf.length;
    big = sc >= 0.5 ? "up" : sc <= -0.5 ? "down" : "flat";
    const all = htf.every(b => b.bias === htf[0].bias);
    why.unshift({ dir: big, text: big === "flat"
      ? T("why.bigMixed", { list: htf.map(b => T(`why.tf${b.bias === "bullish" ? "Up" : b.bias === "bearish" ? "Down" : "Flat"}`, { tf: b.label })).join(", ") })
      : T(`why.big${all ? "All" : "Most"}${big === "up" ? "Up" : "Down"}`, { tfs: htf.map(b => b.label).join(", ") }) });
  }
  if (short === null && big === null) return null;

  // Headline + one-line summary. One short-term signal → softer wording.
  // e.g. "shortTermLeaningUp" — "Short-term leaning up"
  const st = `${w < 1.5 ? "Leaning" : ""}${short === "up" ? "Up" : "Down"}`;
  let headline: string, line: string, tone: TodaysRead["tone"];
  if (short && short !== "flat" && big && big !== "flat") {
    if (short === big) { tone = short; headline = T(`read.leaning${short === "up" ? "Up" : "Down"}`); line = T("read.aligned"); }
    else {
      tone = "mixed";
      headline = T(short === "down" ? "read.dipInUptrend" : "read.bounceInDowntrend");
      line = T(`read.mixedLine${st}`);
    }
  } else if (short && short !== "flat") {
    tone = short; headline = T(`read.shortTerm${st}`);
    line = T(big === null ? "read.bigNotLoaded" : "read.bigDisagree");
  } else if (big && big !== "flat") {
    tone = big; headline = T(`read.trendNoSignal${big === "up" ? "Up" : "Down"}`);
    line = T(short === "flat" ? "read.shortMixed" : "read.nothingStands");
  } else {
    tone = "flat"; headline = T("read.mixedNoEdge");
    line = T("read.mixedLine");
  }

  // What to watch: nearest support/resistance, plus the price that would
  // cancel the strongest short-term signal.
  const sup = o.ind?.support[0], res = o.ind?.resistance[0];
  const cancel = o.chart ? o.chart.invalidation : o.ew && o.ew.pattern !== "none" ? o.ew.invalidation : null;
  const lean: ReadDir = tone === "mixed" ? (big as ReadDir) : tone;
  let watch = "";
  if (sup != null && res != null) {
    watch = T("read.nearest", { sup: $(sup), res: $(res) }) + " ";
    if (tone === "mixed")
      watch += short === "up"
        ? T("read.watchBounce", { res: $(res) })
        : T("read.watchDip", { sup: $(sup) });
    else if (lean === "down") watch += T("read.watchBreakDown", { sup: $(sup) });
    else if (lean === "up") watch += T("read.watchBreakUp", { res: $(res) });
    else watch += T("read.watchEither");
  }
  // Mixed reads already name both outcomes; only clear leans get a cancel level.
  if (cancel != null && (tone === "up" || tone === "down"))
    watch += " " + T(`read.cancel${tone === "down" ? "Above" : "Below"}${o.chart ? "Chart" : "Ew"}`, { price: $(cancel) });

  // Momentum context.
  let momentum: string | null = null;
  const rsi = o.ind?.rsi, vol = o.ind?.volRatio;
  if (rsi != null) {
    const r = Math.round(rsi);
    const rsiKey = r >= 70 ? "Overbought" : r <= 30 ? "Oversold" : r < 45 ? "Weak" : r > 55 ? "Strong" : "Neutral";
    const volKey = vol == null ? "" : vol < 0.6 ? "Light" : vol > 1.5 ? "Heavy" : "";
    momentum = T(`mom.rsi${rsiKey}${volKey}`, { rsi: r, vol: vol?.toFixed(2) ?? "" });
  }
  // Alert suggestions for each level named above; skip any price is already at.
  const alerts: TodaysRead["alerts"] = [];
  const addAlert = (lvl: number | null | undefined, why: string) => {
    if (lvl == null || o.price == null || Math.abs(lvl - o.price) < o.price * 0.0005) return;
    if (alerts.some(a => Math.abs(a.price - lvl) < lvl * 0.0005)) return;
    alerts.push({ price: lvl, direction: lvl > o.price ? "above" : "below", why });
  };
  addAlert(sup, T("read.alertSupport"));
  addAlert(res, T("read.alertResistance"));
  if (tone === "up" || tone === "down") addAlert(cancel, T(o.chart ? "read.alertCancelChart" : "read.alertCancelEw"));

  return { headline, line, tone, why, watch: watch.trim(), momentum, alerts };
}

function getMTFSummary(biases: MTFBias[]): {
  htfBias: "bullish" | "bearish" | "neutral";
  ltfBias: "bullish" | "bearish" | "neutral";
  direction: "long" | "short" | "wait";
  explanation: string;
} {
  const htf = biases.filter(b => ["4H", "1D", "1W"].includes(b.label));
  const ltf = biases.filter(b => ["1H"].includes(b.label));
  const score = (arr: MTFBias[]) =>
    arr.length ? arr.reduce((s, b) => s + (b.bias === "bullish" ? 1 : b.bias === "bearish" ? -1 : 0), 0) / arr.length : 0;
  const toBias = (s: number): MTFBias["bias"] =>
    s >= 0.5 ? "bullish" : s <= -0.5 ? "bearish" : "neutral";

  const htfBias = toBias(score(htf));
  const ltfBias = toBias(score(ltf));

  // "All" only when every timeframe really agrees (a 2-of-3 higher-timeframe
  // majority used to be reported as "all timeframes").
  const allSame = biases.length > 0 && biases.every(b => b.bias === biases[0].bias) ? biases[0].bias : null;
  if (allSame === "bullish" || allSame === "bearish") {
    const up = allSame === "bullish";
    return { htfBias, ltfBias, direction: up ? "long" : "short",
      explanation: T(up ? "mtf.allUp" : "mtf.allDown", { n: biases.length }) };
  }
  if (htfBias === "bullish" && ltfBias === "bullish")
    return { htfBias, ltfBias, direction: "long",
      explanation: T("mtf.mostUp") };
  if (htfBias === "bearish" && ltfBias === "bearish")
    return { htfBias, ltfBias, direction: "short",
      explanation: T("mtf.mostDown") };
  if (htfBias === "bullish" && ltfBias === "bearish")
    return { htfBias, ltfBias, direction: "long",
      explanation: T("mtf.upDipping") };
  if (htfBias === "bearish" && ltfBias === "bullish")
    return { htfBias, ltfBias, direction: "short",
      explanation: T("mtf.downBouncing") };
  if (htfBias === "bullish")
    return { htfBias, ltfBias, direction: "long",
      explanation: T("mtf.leanUp") };
  if (htfBias === "bearish")
    return { htfBias, ltfBias, direction: "short",
      explanation: T("mtf.leanDown") };
  return { htfBias, ltfBias, direction: "wait",
    explanation: T("mtf.noTrend") };
}

// ── Trade Wizard ─────────────────────────────────────────────────────────────

type WizardIntent = "buy" | "sell" | "long" | "short";

interface WizardLevels {
  entry: number;
  stopLoss: number;
  target: number;
  rr: number;
  support: number[];
  resistance: number[];
}

interface WizardRec {
  verdict: "go" | "wait" | "avoid";
  headline: string;
  body: string;
  risk: string | null;
  levels: WizardLevels | null;
}

function getWizardRec(
  intent: WizardIntent,
  aiRead: AIRead,
  mtfBiases: MTFBias[],
  ind: Indicators | null,
  lastPrice: number | null,
): WizardRec {
  const isBull = intent === "buy" || intent === "long";
  const bias = aiRead.bias;
  const aligns    = (isBull && bias === "bullish") || (!isBull && bias === "bearish");
  const conflicts = (isBull && bias === "bearish") || (!isBull && bias === "bullish");

  const mtf = getMTFSummary(mtfBiases);
  const mtfAligns    = (isBull && mtf.direction === "long")  || (!isBull && mtf.direction === "short");
  const mtfConflicts = (isBull && mtf.direction === "short") || (!isBull && mtf.direction === "long");

  const confScore  = aiRead.confidence === "high" ? 1 : aiRead.confidence === "medium" ? 0.6 : 0.3;
  const totalScore = (aligns ? 1 : conflicts ? -1 : 0) * confScore + (mtfAligns ? 0.3 : mtfConflicts ? -0.3 : 0);

  const intentLabel = T(`wiz.intent.${intent}`);
  const intentLower = T(`wiz.intentLower.${intent}`);
  const dirLabel    = T(`wiz.biasWord.${isBull ? "bullish" : "bearish"}`);
  const biasLabel   = T(`wiz.biasWord.${bias}`);
  const confLabel   = T(`wiz.conf.${aiRead.confidence}`, { defaultValue: aiRead.confidence });

  let risk: string | null = null;
  if (ind?.rsi != null) {
    if (isBull  && ind.rsi > 70) risk = T("wiz.riskOverbought", { rsi: ind.rsi.toFixed(0) });
    else if (!isBull && ind.rsi < 30) risk = T("wiz.riskOversold", { rsi: ind.rsi.toFixed(0) });
  }

  // ── Price levels ──────────────────────────────────────────────────────────
  let levels: WizardLevels | null = null;
  if (lastPrice && ind) {
    const atr = ind.atr ?? lastPrice * 0.005;
    // Merge AI key levels with indicator S/R, deduplicated and sorted
    const aiAbove = aiRead.keyLevels.filter(l => l.side === "above").map(l => l.price);
    const aiBelow = aiRead.keyLevels.filter(l => l.side === "below").map(l => l.price);

    const allResistance = [...new Set([...aiAbove, ...ind.resistance])]
      .filter(p => p > lastPrice)
      .sort((a, b) => a - b);
    const allSupport = [...new Set([...aiBelow, ...ind.support])]
      .filter(p => p < lastPrice)
      .sort((a, b) => b - a);

    if (isBull) {
      const entry   = lastPrice;
      const nearSup = allSupport[0] ?? lastPrice - atr * 1.5;
      const stopLoss = nearSup - atr * 0.4;
      const target   = allResistance[0] ?? lastPrice + atr * 3;
      const risk_pts = entry - stopLoss;
      const rr = risk_pts > 0 ? (target - entry) / risk_pts : 0;
      levels = {
        entry, stopLoss, target, rr,
        support: allSupport.slice(0, 2),
        resistance: allResistance.slice(0, 2),
      };
    } else {
      const entry    = lastPrice;
      const nearRes  = allResistance[0] ?? lastPrice + atr * 1.5;
      const stopLoss = nearRes + atr * 0.4;
      const target   = allSupport[0] ?? lastPrice - atr * 3;
      const risk_pts = stopLoss - entry;
      const rr = risk_pts > 0 ? (entry - target) / risk_pts : 0;
      levels = {
        entry, stopLoss, target, rr,
        support: allSupport.slice(0, 2),
        resistance: allResistance.slice(0, 2),
      };
    }
  }

  if (totalScore >= 0.65) {
    return {
      verdict: "go",
      headline: T("wiz.alignedHead", { intent: intentLabel }),
      body: T(mtfAligns ? "wiz.alignedBodyMtf" : "wiz.alignedBody", { conf: T(`wiz.confCap.${aiRead.confidence}`, { defaultValue: aiRead.confidence }), dir: dirLabel, intent: intentLower }),
      risk, levels,
    };
  }
  if (totalScore >= 0.25) {
    return {
      verdict: "go",
      headline: T("wiz.partialHead", { intent: intentLabel }),
      body: T("wiz.partialBody", { dir: dirLabel, conf: confLabel }),
      risk: risk ?? T("wiz.partialRisk"),
      levels,
    };
  }
  if (totalScore > -0.25) {
    return {
      verdict: "wait",
      headline: bias === "neutral" ? T("wiz.noDirection") : T("wiz.waitHead", { intent: intentLabel }),
      body: bias === "neutral"
        ? T("wiz.rangingBody", { intent: intentLower })
        : T(mtfConflicts ? "wiz.waitBodyOpposing" : "wiz.waitBodyMixed", { bias: biasLabel, conf: confLabel }),
      risk, levels,
    };
  }
  return {
    verdict: "avoid",
    headline: T("wiz.avoidHead", { intent: intentLabel }),
    body: T(isBull ? "wiz.avoidBodyBuy" : "wiz.avoidBodySell", { bias: biasLabel }) + (mtfConflicts ? " " + T("wiz.avoidHtf") : ""),
    risk: T("wiz.avoidRisk"),
    levels,
  };
}

// ── Mini SVG candlestick ─────────────────────────────────────────────────────

function MiniCandle({ open, high, low, close }: { open: number; high: number; low: number; close: number }) {
  const bull  = close >= open;
  const range = high - low || 0.001;
  const toY   = (p: number) => 2 + (1 - (p - low) / range) * 28;
  const bodyT = toY(Math.max(open, close));
  const bodyB = toY(Math.min(open, close));
  const bodyH = Math.max(bodyB - bodyT, 2);
  const color = bull ? "#22c55e" : "#ef4444";
  return (
    <svg width="14" height="32" viewBox="0 0 14 32" style={{ display: "block" }}>
      <line x1="7" y1={toY(high)} x2="7" y2={bodyT}   stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <rect x="2" y={bodyT} width="10" height={bodyH}  fill={color} rx="1.5" />
      <line x1="7" y1={bodyT + bodyH} x2="7" y2={toY(low)} stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ── Candle tape row (vertical live feed) ────────────────────────────────────

function CandleTapeRow({ candle, prev1, prev2, isLast, isNew }: {
  candle: CandleDataPoint;
  prev1: CandleDataPoint;
  prev2: CandleDataPoint;
  isLast: boolean;
  isNew: boolean;
}) {
  const pattern = detectPattern([prev2, prev1, candle]);
  const bull = candle.close >= candle.open;
  const time = new Date(Number(candle.time) * 1000);
  const hhmm = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`cw-tape-row cw-tape-row--${pattern.type}${isLast ? ` cw-tape-row--latest cw-tape-row--latest-${bull ? "bull" : "bear"}` : ""}${isNew ? " cw-tape-row--new" : ""}`}>
      <div className="cw-tape-time">{hhmm}</div>
      <div className="cw-tape-candle">
        <MiniCandle open={candle.open} high={candle.high} low={candle.low} close={candle.close} />
      </div>
      <div className="cw-tape-body">
        <div className="cw-tape-name">
          <span className="cw-tape-emoji">{pattern.emoji}</span>
          {patName(pattern.name)}
          {isLast && <span className="cw-tape-now">{T("live")}</span>}
        </div>
        <div className="cw-tape-desc">{patDesc(pattern)}</div>
      </div>
      <div className={`cw-tape-dot cw-tape-dot--${bull ? "bull" : "bear"}`} />
    </div>
  );
}

// ── Indicator pill ────────────────────────────────────────────────────────────

function IndicatorPill({
  label, value, status,
}: { label: string; value: string; status: "bull" | "bear" | "neutral" | "warn"; meter?: number }) {
  return (
    <div className={`cw-pill cw-pill--${status}`}>
      <span className="cw-pill-label">{label}</span>
      <span className="cw-pill-value">{value}</span>
    </div>
  );
}

// Mobile: the same label-over-value stat as the Trade page header
// (.chart-bar-stat), colored by status instead of a pill background.
// meter (0–1): a tiny ring gauge before the value (RSI, BB%, volume);
// Mobile strip spells most indicators out (RSI / MACD / ATR / EMA stay short).
// Label → translation key under candleInsights.stat.
const CW_STAT_NAMES: Record<string, string> = {
  "BB%": "bbPos",
  VOL: "volume",
  EMA20: "ema20",
  EMA50: "ema50",
  Elliott: "elliott",
};
function IndicatorStat({
  label, value, status, meter,
}: { label: string; value: string; status: "bull" | "bear" | "neutral" | "warn"; meter?: number }) {
  const tone = status === "bull" ? " up" : status === "bear" ? " down" : status === "warn" ? " cw-stat-warn" : "";
  return (
    <div className={`chart-bar-stat cw-stat cw-stat--${status}`}>
      <span className="chart-bar-stat-label">{CW_STAT_NAMES[label] ? T(`stat.${CW_STAT_NAMES[label]}`) : label}</span>
      <span className={`chart-bar-stat-value${tone}`}>
        {meter != null && (
          <svg className="cw-stat-ring" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="8" className="cw-stat-ring-track" />
            <circle
              cx="10" cy="10" r="8" className="cw-stat-ring-fill"
              pathLength={100}
              strokeDasharray={`${Math.round(Math.max(0.03, Math.min(1, meter)) * 100)} 100`}
            />
          </svg>
        )}
        {value}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/* ── Live timers (own 1s tick, so the big page doesn't re-render) ───────── */
const COOLDOWN_NOTICE = "__ai-cooldown__";
const fmtMmSs = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
/** "↻ 12s ago" that counts up every second. */
function LiveAgo({ since }: { since: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  return <span className="cw-updated">↻ {t("candleInsights.desk.secondsAgo", { n: Math.max(0, Math.floor((now - since) / 1000)) })}</span>;
}
/** Counts down to `until` every second; renders nothing once it's over. */
function AiCooldown({ until, coin, variant }: { until: number; coin: string; variant: "pill" | "note" }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  const left = until - now;
  if (left <= 0) return null;
  return variant === "pill"
    ? <span className="cw-ai-cooldown" role="timer" aria-live="off">{t("candleInsights.ai.nextIn", { time: fmtMmSs(left) })}</span>
    : <span className="cw-ai-start-note cw-ai-start-note--warn" role="status">{t("candleInsights.ai.cooldown", { coin, time: fmtMmSs(left) })}</span>;
}

export const CandleWatcher: React.FC<Props> = ({ coin, theme, onOpenAuth, onOpenUpgrade, onReady, visible = true, ticker, onOpenCoinPicker }) => {
  const { tier, user, profile } = useAuth();
  // Named tA (not t): this component uses `t` for local timers/counters.
  const { t: tA } = useTranslation();
  /** Chart toolbar / menu strings. */
  const tTb = (k: string, o?: Record<string, unknown>) => tA(`candleInsights.tb.${k}`, o);
  /** Any candleInsights key. */
  const tC = (k: string, o?: Record<string, unknown>) => tA(`candleInsights.${k}`, o);
  /** Date-range preset name (CW_RANGES), e.g. "1 week". */
  const rangeName = (short: string | null) => tTb(`range.${short ?? "default"}`);
  // Re-render "Today's read" alert buttons after one is added/removed.
  const [, setAlertTick] = useState(0);
  useEffect(() => {
    const bump = () => setAlertTick(t => t + 1);
    window.addEventListener(PRICE_ALERTS_EVENT, bump);
    return () => window.removeEventListener(PRICE_ALERTS_EVENT, bump);
  }, []);
  // Clear chips for alerts the server already pushed.
  useEffect(() => { pruneServerTriggered(user?.id); }, [user?.id]);

  // Can this device actually receive a push? iOS app: notification
  // permission. Website: a browser push subscription. "na" = can't tell /
  // not supported (e.g. Android, unsupported browser).
  const [pushState, setPushState] = useState<"on" | "off" | "na">("na");
  const refreshPushState = useCallback(async () => {
    try {
      if (isPushAvailable()) {
        const { receive } = await FirebaseMessaging.checkPermissions();
        setPushState(receive === "granted" ? "on" : "off");
      } else if (isWebPushAvailable()) {
        setPushState((await isWebPushSubscribed()) ? "on" : "off");
      } else setPushState("na");
    } catch { setPushState("na"); }
  }, []);
  useEffect(() => { if (user) refreshPushState(); }, [user?.id, refreshPushState]);
  const turnOnPush = async () => {
    if (!user) { onOpenAuth(); return; }
    if (isPushAvailable()) await completePushPriming(user.id);
    else if (isWebPushAvailable()) await subscribeWebPush(user.id);
    refreshPushState();
  };
  const isPaid = hasAccess(tier, "pro");
  const [intervalIdx, setIntervalIdx] = useState(2);  // default 4h
  // Candle Patterns card tapped → highlight the pattern on the chart.
  // Hidden again when the coin or interval changes.
  const [patternFocus, setPatternFocus] = useState(false);
  // Chart Pattern card tapped → draw the pattern on the chart.
  const [chartPatternFocus, setChartPatternFocus] = useState(false);
  useEffect(() => { setPatternFocus(false); setChartPatternFocus(false); }, [coin, intervalIdx]);
  // Sliding highlight behind the active interval pill — same measure-the-
  // active-item-and-animate-a-transform technique as PriceChart.tsx's own
  // FsSlidingOptions (mobile dock interval/style picker), reimplemented
  // here rather than imported since that component isn't exported and this
  // item also needs a second (countdown) line it doesn't support.
  const ivTrackRef = useRef<HTMLDivElement>(null);
  const ivItemRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const [ivHighlight, setIvHighlight] = useState<{ left: number; width: number } | null>(null);
  const measureIvHighlight = useCallback(() => {
    const el = ivItemRefs.current[intervalIdx];
    if (!el) return;
    setIvHighlight({ left: el.offsetLeft, width: el.offsetWidth });
  }, [intervalIdx]);
  useLayoutEffect(() => {
    measureIvHighlight();
  }, [measureIvHighlight]);
  // On first mount, intervalCountdowns is still all-empty strings (it fills
  // in a moment later, once the countdown tick effect runs) — the pills
  // start one line shorter than their real height, so the layout effect
  // above measures a too-small box. A ResizeObserver re-measures whenever
  // the track's box actually changes size (countdowns appearing, fonts
  // loading), the same fix PriceChart.tsx's own FsSlidingOptions uses for
  // the identical class of bug.
  useEffect(() => {
    const track = ivTrackRef.current;
    if (!track) return;
    const ro = new ResizeObserver(() => measureIvHighlight());
    ro.observe(track);
    return () => ro.disconnect();
  }, [measureIvHighlight]);
  const [heroLogoError, setHeroLogoError] = useState(false);
  const [candles, setCandles] = useState<CandleDataPoint[]>([]);
  const candlesRef = useRef<CandleDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const onReadyFiredRef = useRef(false);
  const [aiRead, setAiRead] = useState<AIRead | null>(null);
  const [mmFeed, setMmFeed] = useState<MMFeedEntry[]>([]);
  // Desktop (≥901px): one-screen terminal layout — signal cards and the
  // live tape move into the right panel as tabs (see signalCardsEl /
  // liveTapeEl). Mobile keeps its stacked layout untouched.
  const [cwDesktop, setCwDesktop] = useState(() => window.matchMedia("(min-width: 901px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const on = () => setCwDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // Desktop "AI" tab remembers which of Read / Plan / Narration was open.
  const lastAiTabRef = useRef<"read" | "plan" | "narration">("read");
  const cwDesktopRef = useRef(cwDesktop);
  cwDesktopRef.current = cwDesktop;
  const [rightTab, setRightTab] = useState<"signals" | "wave" | "narration" | "read" | "plan" | "fractal" | "tape">(
    () => "signals",
  );
  useEffect(() => {
    if (rightTab === "read" || rightTab === "plan" || rightTab === "narration") lastAiTabRef.current = rightTab;
  }, [rightTab]);
  // Switching panel tabs (Overview / AI / Elliott / Live Tape) swaps the
  // panel body's content; when the new tab is shorter the page shrinks
  // and the browser (iOS especially) jumps the scroll, often to the top.
  // Hold the body at least as tall as it was and put the scroll position
  // back, so the page stays exactly where the user tapped.
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const switchRightTab = (next: typeof rightTab) => {
    const body = panelBodyRef.current;
    let scroller: HTMLElement | null = body?.parentElement ?? null;
    while (scroller && scroller !== document.body) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    const scrollEl = scroller && scroller !== document.body ? scroller : null;
    const top = scrollEl ? scrollEl.scrollTop : window.scrollY;
    // Phones only — on desktop the panel body is its own fixed-height
    // scroll area, so its height never moves the page.
    if (body && !cwDesktop) {
      const prevMin = parseFloat(body.style.minHeight) || 0;
      body.style.minHeight = `${Math.max(prevMin, body.offsetHeight)}px`;
    }
    setRightTab(next);
    requestAnimationFrame(() => {
      if (scrollEl) scrollEl.scrollTop = top;
      else window.scrollTo({ top });
    });
  };
  // Back on mobile, the desktop-only tabs don't exist — fall back.
  useEffect(() => {
    // Desktop folds Monthly into Overview.
    if (rightTab === "fractal") setRightTab("signals");
  }, [rightTab]);
  const [aiLoading, setAiLoading] = useState(false);
  // Why "Run AI analysis" produced nothing (cooldown or a failed call),
  // shown under the button instead of silently doing nothing.
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const aiCancelledRef = useRef(false);
  const aiScanIctRef = useRef<ICTResult | null>(null);
  const [scanStep, setScanStep] = useState(-1);
  const [lastCandleTime, setLastCandleTime] = useState<number | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [candleCountdown, setCandleCountdown] = useState<string>("");
  const [dailyCountdown, setDailyCountdown]   = useState<string>("");
  const [intervalCountdowns, setIntervalCountdowns] = useState<string[]>(() => INTERVALS.map(() => ""));
  const [dailyCloseBanner, setDailyCloseBanner] = useState<{
    direction: "bullish" | "bearish";
    open: number; close: number; high: number; low: number;
    changePct: number; dismissed: boolean;
  } | null>(null);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartDblClickWrapRef = useRef<HTMLDivElement>(null);
  const [isChartFullscreen, setIsChartFullscreen] = useState(false);
  const toggleChartFullscreen = useCallback(() => setIsChartFullscreen((v) => !v), []);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef  = useRef<ISeriesApi<"Candlestick", any> | null>(null);
  const divMarkersRef    = useRef<ISeriesMarkersPluginApi<any> | null>(null);
  const patternMapRef    = useRef<Map<number, { comment: string; type: string }>>(new Map());
  const [patternTooltip, setPatternTooltip] = useState<{ comment: string; type: string; x: number; y: number; title?: string } | null>(null);
  const [wyckoff, setWyckoff] = useState<WyckoffResult | null>(null);
  const ictPriceLinesRef = useRef<IPriceLine[]>([]);
  const ictLevelDescriptionsRef = useRef<{ price: number; title: string; desc: string; type: string }[]>([]);
  const forecastSeriesRef    = useRef<ISeriesApi<"Candlestick", any> | null>(null);
  const forecastBullRef      = useRef<ISeriesApi<"Line", any> | null>(null);
  const forecastBearRef      = useRef<ISeriesApi<"Line", any> | null>(null);
  const forecastTargetRef    = useRef<IPriceLine | null>(null);
  const htfLiqLinesRef       = useRef<IPriceLine[]>([]);
  const indRef               = useRef<Indicators | null>(null);
  const macroCtxRef          = useRef<MacroContextData | null>(null);
  const [mtfBiases, setMtfBiases] = useState<MTFBias[]>([]);
  const [weeklyCycle, setWeeklyCycle] = useState<{ candles: CandleDataPoint[]; tema14: number[]; tema21: number[] } | null>(null);
  const [volumeProfile, setVolumeProfile] = useState<VolumeProfileResult | null>(null);
  const volumeProfileRef = useRef<VolumeProfileResult | null>(null);
  const volProfileLinesRef = useRef<IPriceLine[]>([]);
  const [sessionLevels, setSessionLevels] = useState<SessionLevels | null>(null);
  const sessionLevelsRef = useRef<SessionLevels | null>(null);
  const sessionLinesRef = useRef<IPriceLine[]>([]);
  const [fractalAnalogs, setFractalAnalogs] = useState<FractalAnalogsResult | null>(null);
  const fractalAnalogsRef = useRef<FractalAnalogsResult | null>(null);
  const [fractalLoading, setFractalLoading] = useState(false);
  const [selectedFractalIdx, setSelectedFractalIdx] = useState(0);
  const [expandedFractalIdx, setExpandedFractalIdx] = useState<number | null>(null);
  // Mobile/iOS only (desktop always shows the full sheet — see the
  // @media(max-width:640px) rules in CandleWatcher.css): a freshly-opened
  // match starts as a small non-blocking peek bar docked at the bottom
  // instead of a full-screen takeover, so it doesn't feel like a modal
  // popping up over everything. Tapping the bar expands it to the same
  // full detail sheet desktop always shows.
  const [mobilePeekExpanded, setMobilePeekExpanded] = useState(false);
  const [cycleExpanded, setCycleExpanded] = useState(false);
  const [showVolMethodology, setShowVolMethodology] = useState(false);
  const volCone = useMemo(() => {
    if (!weeklyCycle) return null;
    const closes = weeklyCycle.candles.map(c => c.close);
    const m3 = calcVolatilityCone(closes, 13);
    const m6 = calcVolatilityCone(closes, 26);
    return m3 && m6 ? { m3, m6 } : null;
  }, [weeklyCycle]);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("cwSidebarWidth"));
    return saved >= 300 && saved <= 720 ? saved : 440;
  });
  // Desktop starts with the panel open (Overview / AI / Elliott / Live
  // Tape) — new key so everyone gets that default once, even if the old
  // "starts hidden" default was saved; hiding it is remembered from here.
  // Mobile keeps its old saved state.
  const cwPanelKey = window.matchMedia("(min-width: 901px)").matches ? "cwRightPanelCollapsedV3" : "cwRightPanelCollapsed";
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => {
    const saved = localStorage.getItem(cwPanelKey);
    return saved === null ? false : saved === "1";
  });
  useEffect(() => {
    localStorage.setItem(cwPanelKey, rightPanelCollapsed ? "1" : "0");
  }, [rightPanelCollapsed, cwPanelKey]);
  const [feedCollapsed, setFeedCollapsed] = useState(
    () => localStorage.getItem("cwFeedCollapsed") === "1"
  );
  useEffect(() => {
    localStorage.setItem("cwFeedCollapsed", feedCollapsed ? "1" : "0");
  }, [feedCollapsed]);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [showForecast, setShowForecast] = useState(false);
  const [forecastConviction, setForecastConviction] = useState(0);
  const [macroCtx, setMacroCtx] = useState<MacroContextData | null>(null);
  const [predData, setPredData] = useState<PredictionResponse | null>(null);
  const [wizardIntent, setWizardIntent] = useState<WizardIntent | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const volSeriesRef     = useRef<ISeriesApi<"Histogram", any> | null>(null);
  const bbUpperRef       = useRef<ISeriesApi<"Line", any> | null>(null);
  const bbMiddleRef      = useRef<ISeriesApi<"Line", any> | null>(null);
  const bbLowerRef       = useRef<ISeriesApi<"Line", any> | null>(null);
  const ema20Ref         = useRef<ISeriesApi<"Line", any> | null>(null);
  const ema50Ref         = useRef<ISeriesApi<"Line", any> | null>(null);
  const elliottSeriesRef     = useRef<ISeriesApi<"Line", any> | null>(null);
  const elliottProjSeriesRef = useRef<ISeriesApi<"Line", any> | null>(null);
  const elliottTrendSeriesRef = useRef<ISeriesApi<"Line", any>[]>([]);
  const elliottPriceLinesRef = useRef<IPriceLine[]>([]);
  const elliottResultRef     = useRef<EWResult | null>(null);
  const showElliottRef       = useRef(false);
  // Chart toolbar (desktop): style, grid, layers, scale — remembered.
  type CwStyle = "candle" | "hollow" | "line" | "heikinAshi";
  type CwLayers = { ema: boolean; bb: boolean; volume: boolean; ict: boolean; retests: boolean; patterns: boolean; divergence: boolean };
  const CW_LAYERS_ALL_ON: CwLayers = { ema: true, bb: true, volume: true, ict: true, retests: true, patterns: true, divergence: true };
  const [cwPrefs, setCwPrefs] = useState<{ style: CwStyle; grid: boolean; layers: CwLayers; scale: "normal" | "percent" | "log"; autoScale: boolean }>(() => {
    const def = { style: "candle" as CwStyle, grid: true, layers: CW_LAYERS_ALL_ON, scale: "normal" as const, autoScale: true };
    try {
      const saved = JSON.parse(localStorage.getItem("cwChartPrefsV1") ?? "null");
      return saved ? { ...def, ...saved, layers: { ...CW_LAYERS_ALL_ON, ...(saved.layers ?? {}) } } : def;
    } catch { return def; }
  });
  useEffect(() => {
    try { localStorage.setItem("cwChartPrefsV1", JSON.stringify(cwPrefs)); } catch { /* ignore */ }
  }, [cwPrefs]);
  const cwLayersRef = useRef(cwPrefs.layers);
  cwLayersRef.current = cwPrefs.layers;
  const [cwMenu, setCwMenu] = useState<null | "interval" | "style" | "layers" | "range" | "tools" | "indicators">(null);
  // Drawing tools: shown by default on desktop (hiding them is remembered);
  // off by default on phones, where they'd cover the chart.
  const cwDrawDesktop = () => window.matchMedia("(min-width: 901px)").matches;
  const [cwDrawOn, setCwDrawOn] = useState(() => {
    if (!cwDrawDesktop()) return false;
    try { return localStorage.getItem("cwDrawOnV1") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    if (!cwDrawDesktop()) return;
    try { localStorage.setItem("cwDrawOnV1", cwDrawOn ? "1" : "0"); } catch { /* ignore */ }
  }, [cwDrawOn]);
  // Date range (desktop toolbar): kept across interval changes while it
  // fits that candle size; loads as much history as it needs.
  const [cwRange, setCwRange] = useState<{ label: string; secs: number } | null>(null);
  const cwRangeRef = useRef(cwRange);
  cwRangeRef.current = cwRange;
  const cwRangeFits = (secs: number, iv: Interval) => {
    const n = secs / iv.durationSec;
    return n >= 3 && n <= MAX_RANGE_CANDLES;
  };
  const cwLimitFor = (iv: Interval) => {
    const rg = cwRangeRef.current;
    if (!rg || !cwRangeFits(rg.secs, iv)) return iv.limit;
    return Math.min(MAX_RANGE_CANDLES, Math.max(iv.limit, Math.ceil(rg.secs / iv.durationSec) + 10));
  };
  const cwDrawingsRef = useRef<Drawing[]>([]);
  const cwLineSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [showElliott, setShowElliott] = useState(false);
  const [elliottResult, setElliottResult] = useState<EWResult | null>(null);
  const showVolProfileRef    = useRef(false);
  const [showVolProfile, setShowVolProfile] = useState(false);
  const showSessionLevelsRef = useRef(false);
  const [showSessionLevels, setShowSessionLevels] = useState(false);

  // Rounded-candle overlay state — real series colors are made transparent
  // below (both the main candleSeries and the forecast series), with
  // RoundedCandleOverlay painting the visible rounded-corner bodies/wicks on
  // top, same shared pattern PriceChart.tsx uses.
  const [chartGeneration, setChartGeneration] = useState(0);
  const forecastCandlesRef = useRef<{ time: number; open: number; high: number; low: number; close: number }[]>([]);
  const [forecastColors, setForecastColors] = useState({ up: "#7dd3fc", down: "#fca5a5" });

  const interval = INTERVALS[intervalIdx];
  // Live forming candle (Binance kline stream): the last bar grows tick by
  // tick instead of waiting for the next refresh. Series updated directly.
  useLiveKline(coin as string, interval.label === "1M" ? null : interval.value, (c) => {
    const cs = candlesRef.current;
    const last = cs[cs.length - 1];
    if (!candleSeriesRef.current || !last || c.time < last.time) return;
    if (c.time === last.time) cs[cs.length - 1] = { ...last, ...c };
    else cs.push(c);
    candleSeriesRef.current.update({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    cwLineSeriesRef.current?.update({ time: c.time as UTCTimestamp, value: c.close });
    volSeriesRef.current?.update({
      time: c.time as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
    });
  });
  const isDark   = theme === "dark";
  // Shared indicator catalog (indicatorLibrary.ts) — same picker + drawing
  // as every other chart in the app, on top of this page's own layers.
  const [libIndicators, toggleLibIndicator] = useIndicatorSelection("candle-watcher");
  useChartIndicators({
    chart: chartRef.current,
    mainSeries: candleSeriesRef.current,
    getCandles: () => candlesRef.current,
    enabled: libIndicators,
    isDark,
  });

  // ── Build chart ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background:  { type: ColorType.Solid, color: isDark ? "#000000" : "#ffffff" },
        textColor:   isDark ? "#94a3b8" : "#475569",
      },
      grid: {
        vertLines:  { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
        horzLines:  { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: isDark ? "#1e293b" : "#e2e8f0" },
      // lockVisibleTimeRangeOnResize: hiding/showing the side panel stretches
      // the same candles to the new width instead of revealing empty space.
      timeScale: { borderColor: isDark ? "#1e293b" : "#e2e8f0", timeVisible: true, secondsVisible: false, lockVisibleTimeRangeOnResize: true },
      // Phones: a vertical swipe scrolls the page, not the chart (the
      // chart still pans sideways, pinch-zooms, and the price axis
      // drags to stretch). Desktop keeps free vertical panning.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: cwDesktopRef.current },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      width:  chartContainerRef.current.clientWidth,
      // Always the container's real height — a fixed 460 inside a shorter
      // container cut off the lower candles, volume and time axis.
      height: chartContainerRef.current.clientHeight || 460,
    });
    if (!cwDesktopRef.current) {
      // Phones: candles centered between the OHLC legend (top) and the
      // volume bars (bottom) instead of running under either; a few
      // empty bars on the right so the last candle isn't against the axis.
      chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.16, bottom: 0.12 } });
      chart.applyOptions({ timeScale: { rightOffset: 4, barSpacing: 7 } });
    }

    // Transparent — RoundedCandleOverlay (rendered in the JSX below) paints
    // the visible rounded-corner bodies/wicks on its own canvas instead.
    // Series stays mounted (just invisible) so it keeps driving
    // scale/crosshair/autoscale/priceLines, same pattern as PriceChart.tsx.
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "transparent", downColor: "transparent",
      borderUpColor: "transparent", borderDownColor: "transparent",
      wickUpColor: "transparent", wickDownColor: "transparent",
    });

    const volSeries = chart.addSeries(HistogramSeries, {
      color: "#38bdf840",
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const bbUpper  = chart.addSeries(LineSeries, { color: "rgba(99,102,241,0.5)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    const bbMiddle = chart.addSeries(LineSeries, { color: "rgba(99,102,241,0.3)", lineWidth: 1, lineStyle: 0, priceLineVisible: false, lastValueVisible: false });
    const bbLower  = chart.addSeries(LineSeries, { color: "rgba(99,102,241,0.5)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
    const ema20    = chart.addSeries(LineSeries, { color: "#38bdf8", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ema50    = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    // "Line" chart style: close-price line, only visible in that style.
    cwLineSeriesRef.current = chart.addSeries(LineSeries, { color: "#6366f1", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, visible: false });
    const elliott      = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 4, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const elliottProj  = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 3, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    // Triangle / diagonal boundary lines (the two converging lines).
    elliottTrendSeriesRef.current = [0, 1].map(() =>
      chart.addSeries(LineSeries, { color: "rgba(139,92,246,0.7)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false }));

    chartRef.current           = chart;
    elliottSeriesRef.current   = elliott;
    elliottProjSeriesRef.current = elliottProj;
    candleSeriesRef.current = candleSeries;
    divMarkersRef.current   = createSeriesMarkers(candleSeries, []);
    volSeriesRef.current    = volSeries;
    bbUpperRef.current      = bbUpper;
    bbMiddleRef.current     = bbMiddle;
    bbLowerRef.current      = bbLower;
    ema20Ref.current        = ema20;
    ema50Ref.current        = ema50;

    chart.subscribeCrosshairMove(param => {
      if (!param.point) { setPatternTooltip(null); return; }
      if (param.time) {
        const entry = patternMapRef.current.get(param.time as number);
        if (entry) {
          setPatternTooltip({ ...entry, x: param.point.x, y: param.point.y });
          return;
        }
      }
      const cursorPrice = candleSeriesRef.current?.coordinateToPrice(param.point.y);
      if (cursorPrice != null) {
        const match = ictLevelDescriptionsRef.current.find(lvl =>
          Math.abs(lvl.price - cursorPrice) / Math.max(lvl.price, 0.0001) < 0.0015
        );
        if (match) {
          setPatternTooltip({ comment: match.desc, type: match.type, x: param.point.x, y: param.point.y, title: match.title });
          return;
        }
      }
      setPatternTooltip(null);
    });

    const ro = new ResizeObserver(() => {
      const el = chartContainerRef.current;
      if (!el) return;
      // The chart fills its container's height (desktop flex column,
      // phone fixed-height box). Fullscreen sizes itself separately.
      if (!el.closest(".cw-chart-dblclick-wrap--fullscreen") && el.clientHeight > 0) {
        chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      } else {
        chart.applyOptions({ width: el.clientWidth });
      }
      // The rounded-candle painter redraws on visible-range changes only;
      // a resize with the time range locked doesn't fire one — nudge it.
      requestAnimationFrame(() => setChartGeneration((g) => g + 1));
    });
    ro.observe(chartContainerRef.current);

    // Re-feed existing candle data when chart is rebuilt (e.g. theme switch)
    if (candlesRef.current.length > 0) feedChart(candlesRef.current);

    return () => {
      ro.disconnect();
      forecastSeriesRef.current = null;
      forecastTargetRef.current = null;
      setShowForecast(false);
      chart.remove();
      chartRef.current = null;
    };
  }, [isDark]);

  // The ResizeObserver above only ever re-applies width on a size change
  // (this component's own convention, same as PriceChart's main chart) —
  // height was fixed at creation (460) and never meant to track the
  // container, so entering/exiting fullscreen (which does change the
  // container's actual height via CSS) needs its own explicit
  // chart.applyOptions({height}) call instead of relying on that observer.
  useEffect(() => {
    if (!chartRef.current) return;
    const h = chartContainerRef.current?.clientHeight ?? 0;
    chartRef.current.applyOptions({
      height: isChartFullscreen ? window.innerHeight - 64 : (h > 0 ? h : 460),
    });
  }, [isChartFullscreen, cwDesktop]);

  // ── Chart toolbar effects (style / grid / layers / scale) ──────────────
  useEffect(() => {
    const isLine = cwPrefs.style === "line";
    cwLineSeriesRef.current?.applyOptions({ visible: isLine });
    const L = cwPrefs.layers;
    ema20Ref.current?.applyOptions({ visible: L.ema });
    ema50Ref.current?.applyOptions({ visible: L.ema });
    bbUpperRef.current?.applyOptions({ visible: L.bb });
    bbMiddleRef.current?.applyOptions({ visible: L.bb });
    bbLowerRef.current?.applyOptions({ visible: L.bb });
    volSeriesRef.current?.applyOptions({ visible: L.volume });
    const gridColor = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)";
    chartRef.current?.applyOptions({
      grid: {
        vertLines: { color: cwPrefs.grid ? gridColor : "transparent" },
        horzLines: { color: cwPrefs.grid ? gridColor : "transparent" },
      },
    });
    chartRef.current?.priceScale("right").applyOptions({
      mode: cwPrefs.scale === "log" ? PriceScaleMode.Logarithmic : cwPrefs.scale === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal,
      autoScale: cwPrefs.autoScale,
    });
  }, [cwPrefs, isDark, chartGeneration]);
  // Layer changes redraw the price lines + markers (both built in feedChart).
  const cwLayersKey = JSON.stringify(cwPrefs.layers);
  const cwLayersFirstRef = useRef(true);
  useEffect(() => {
    if (cwLayersFirstRef.current) { cwLayersFirstRef.current = false; return; }
    if (candlesRef.current.length) feedChart(candlesRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwLayersKey]);
  // Toolbar menus: a dropdown on desktop; on phones the app's standard
  // bottom sheet (backdrop + title + ✕), above the floating nav.
  const cwMenuWrap = (title: string, cls: string, items: React.ReactNode) =>
    cwDesktop ? (
      <div className={cls}>{items}</div>
    ) : (
      <BottomSheet open onClose={() => setCwMenu(null)} title={<>{title}</>} className="cw-tb-sheet" ariaLabel={title}>
          <div className="interval-sheet-list cw-tb-sheet-list">{items}</div>
      </BottomSheet>
    );
  // Close any open toolbar menu on an outside click.
  useEffect(() => {
    if (!cwMenu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".cw-tb-menu-wrap, .cw-tb-sheet, .ip-sheet")) setCwMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [cwMenu]);
  // Date range presets: zoom to that span, loading more history first if
  // the loaded candles don't reach back far enough.
  const cwApplyRange = (label: string, secs: number | null) => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const zoom = (data: CandleDataPoint[], span: number) => {
      const last = data[data.length - 1].time as number;
      ts.setVisibleRange({ from: Math.max(data[0].time as number, last - span) as UTCTimestamp, to: last as UTCTimestamp });
    };
    if (secs === null) { setCwRange(null); cwRangeRef.current = null; ts.fitContent(); return; }
    const rg = { label, secs };
    setCwRange(rg);
    cwRangeRef.current = rg;
    const data = candlesRef.current;
    const covered = data.length > 0 && (data[data.length - 1].time as number) - (data[0].time as number) >= secs;
    if (covered) { zoom(data, secs); return; }
    const forCoin = coin;
    const forIv = interval;
    coinglass.getCandles(coin, interval.value, cwLimitFor(interval)).then((more) => {
      if (!more.length || forCoin !== coin || forIv !== interval) return;
      setCandles(more);
      candlesRef.current = more;
      feedChart(more);
      requestAnimationFrame(() => zoom(more, secs));
    });
  };

  // Double-click (mouse) / double-tap (touch, including Chrome's own
  // mobile device emulation — real touch-capable contexts don't reliably
  // synthesize a native dblclick from two taps either, same unreliability
  // native iOS has) to enter/exit fullscreen on the candle chart. A
  // capture-phase listener on the WRAPPER (not the chart's own canvas
  // element) so it fires before lightweight-charts' own handlers — this
  // chart's handleScale.axisDoubleClickReset is also wired to double-
  // click, so onDoubleClickCapture here also stops that propagating,
  // otherwise a double-click would both reset zoom AND toggle fullscreen
  // at once. Passive-only for touch (no preventDefault) — it just watches
  // tap timing, so it can't interfere with pan/zoom/scroll gestures.
  useEffect(() => {
    const el = chartDblClickWrapRef.current;
    if (!el) return;
    const isTouchCapable =
      Capacitor.isNativePlatform() ||
      (typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0));
    if (!isTouchCapable) return;

    let startX = 0, startY = 0, lastTapTime = 0;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1 || e.touches.length !== 0) return;
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      if (Math.hypot(endX - startX, endY - startY) > 20) { lastTapTime = 0; return; }
      const now = Date.now();
      if (lastTapTime > 0 && now - lastTapTime < 450) {
        toggleChartFullscreen();
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
  }, [toggleChartFullscreen]);

  // Exit fullscreen with Escape too — standard desktop convention once
  // something covers the whole viewport.
  useEffect(() => {
    if (!isChartFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIsChartFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isChartFullscreen]);

  // FloatingNavBar (.fnb-bar) still paints above this fullscreen overlay no
  // matter how high the overlay's own z-index goes, because .main-panel
  // (an ancestor, not owned by this file) gets `transform: translateX(0)`
  // on mobile widths for its slide-over-nav animation — any transform other
  // than none makes that ancestor the containing block for position:fixed
  // descendants, so this overlay's z-index is only ever compared against
  // .main-panel's own (60), not against FloatingNavBar directly. Dropping
  // the nav bar's z-index below that for the duration (CandleWatcher.css)
  // is simpler and safer than fighting the containing-block trap itself.
  useEffect(() => {
    document.body.classList.toggle("cw-chart-fullscreen-active", isChartFullscreen);
    return () => document.body.classList.remove("cw-chart-fullscreen-active");
  }, [isChartFullscreen]);

  // ── Feed chart data ──────────────────────────────────────────────────────────

  const feedChart = useCallback((data: CandleDataPoint[]) => {
    if (!candleSeriesRef.current || !data.length) return;

    // Clear any active forecast — real data has changed
    if (forecastSeriesRef.current && chartRef.current) {
      if (forecastTargetRef.current) candleSeriesRef.current.removePriceLine(forecastTargetRef.current);
      forecastTargetRef.current = null;
      chartRef.current.removeSeries(forecastSeriesRef.current);
      forecastSeriesRef.current = null;
      setShowForecast(false);
    }

    const cdl: CandlestickData[] = data.map(c => ({
      time: c.time as any,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    candleSeriesRef.current.setData(cdl);
    cwLineSeriesRef.current?.setData(data.map(c => ({ time: c.time as any, value: c.close })));
    setChartGeneration(g => g + 1);

    if (volSeriesRef.current) {
      volSeriesRef.current.setData(data.map(c => ({
        time: c.time as any,
        value: c.volume ?? 0,
        color: c.close >= c.open ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
      })));
    }

    // Bollinger Bands
    if (bbUpperRef.current && data.length >= 20) {
      const period = 20;
      const bbU: {time:any;value:number}[] = [], bbM: {time:any;value:number}[] = [], bbL: {time:any;value:number}[] = [];
      for (let i = period - 1; i < data.length; i++) {
        const slice = data.slice(i - period + 1, i + 1).map(c => c.close);
        const sma = slice.reduce((s, v) => s + v, 0) / period;
        const sd  = Math.sqrt(slice.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
        bbU.push({ time: data[i].time as any, value: sma + 2 * sd });
        bbM.push({ time: data[i].time as any, value: sma });
        bbL.push({ time: data[i].time as any, value: sma - 2 * sd });
      }
      bbUpperRef.current.setData(bbU);
      bbMiddleRef.current?.setData(bbM);
      bbLowerRef.current?.setData(bbL);
    }

    // EMAs
    const closes = data.map(c => c.close);
    const ema20arr  = calcEMA(closes, 20);
    const ema50arr  = calcEMA(closes, 50);
    if (ema20Ref.current) {
      ema20Ref.current.setData(data.map((c, i) => ({ time: c.time as any, value: ema20arr[i] })).filter(p => !isNaN(p.value)));
    }
    if (ema50Ref.current) {
      ema50Ref.current.setData(data.map((c, i) => ({ time: c.time as any, value: ema50arr[i] })).filter(p => !isNaN(p.value)));
    }

    // Pattern risk markers — buyer/seller commentary at S/R only
    // Structure analysis (S/R, patterns, Wyckoff, Smart Money, retests,
    // divergences, Elliott) runs on the most recent candles only — a kept
    // date range can load thousands, and detecting levels across all of
    // them would bury the chart and change their meaning. Lines/EMAs/BB
    // above still use the full history.
    const aData = data.length > CW_ANALYSIS_WINDOW ? data.slice(-CW_ANALYSIS_WINDOW) : data;
    const { supports, resistances } = findSRLevels(aData);
    // Patterns that get a chart marker (comment text: candleInsights.patComment.<key>).
    const PATTERN_COMMENTS = new Set([
      "Bullish Engulfing", "Bearish Engulfing", "Morning Star", "Evening Star",
      "Three White Soldiers", "Three Black Crows", "Bullish Marubozu", "Bearish Marubozu",
      "Bullish Pinbar", "Bearish Pinbar", "Hammer", "Shooting Star",
    ]);
    const newMap = new Map<number, { comment: string; type: string }>();
    const patternMarkers: SeriesMarker<UTCTimestamp>[] = [];
    for (let i = 2; i < aData.length; i++) {
      const pat = detectPattern(aData.slice(i - 2, i + 1));
      if (!PATTERN_COMMENTS.has(pat.name)) continue;
      const comment = T(`patComment.${tKey(pat.name)}`);
      if (!nearSR(aData[i], supports, resistances)) continue;
      newMap.set(aData[i].time, { comment, type: pat.type });
      patternMarkers.push({
        time:     aData[i].time as UTCTimestamp,
        position: pat.type === "bearish" ? "aboveBar" : "belowBar",
        color:    pat.type === "bullish" ? "#22c55e" : "#ef4444",
        shape:    pat.type === "bullish" ? "arrowUp" : "arrowDown",
        size:     1,
      });
    }
    patternMapRef.current = newMap;

    // Wyckoff phase + Spring/Upthrust markers
    const wyk = detectWyckoff(aData);
    setWyckoff(wyk);

    const springMarkers: SeriesMarker<UTCTimestamp>[] = wyk.springs.map(t => {
      newMap.set(t, { comment: T("chart.spring"), type: "bullish" });
      return { time: t as UTCTimestamp, position: "belowBar", color: "#22c55e", shape: "arrowUp", size: 2 };
    });
    const upthrustMarkers: SeriesMarker<UTCTimestamp>[] = wyk.upthrusts.map(t => {
      newMap.set(t, { comment: T("chart.upthrust"), type: "bearish" });
      return { time: t as UTCTimestamp, position: "aboveBar", color: "#f59e0b", shape: "arrowDown", size: 2 };
    });

    // ICT / SMC — clear old price lines, draw OBs + FVGs, add BOS/CHoCH markers
    ictPriceLinesRef.current.forEach(pl => candleSeriesRef.current?.removePriceLine(pl));
    ictPriceLinesRef.current = [];
    ictLevelDescriptionsRef.current = [];

    const ict = detectICT(aData);
    const ictMarkers: SeriesMarker<UTCTimestamp>[] = [];

    // Retest markers
    const retestEvents = detectRetests(aData, ict);
    const retestMarkers: SeriesMarker<UTCTimestamp>[] = retestEvents.map(r => {
      newMap.set(r.time, {
        comment: T(r.type === "bearish" ? "chart.retestBear" : "chart.retestBull", { price: "$" + r.price.toFixed(0) }),
        type: r.type,
      });
      return {
        time:     r.time as UTCTimestamp,
        position: r.type === "bearish" ? "aboveBar" : "belowBar",
        color:    r.type === "bearish" ? "#ef4444" : "#22c55e",
        shape:    r.type === "bearish" ? "arrowDown" : "arrowUp",
        text:     T(r.type === "bearish" ? "chart.retestBearLabel" : "chart.retestBullLabel"),
        size: 2,
      };
    });

    if (candleSeriesRef.current) {
      const addLine = (
        price: number, color: string, lineTitle: string,
        width: 1|2 = 1, style: LineStyle = LineStyle.Dashed,
        tooltipTitle?: string, desc?: string, descType?: string
      ) => {
        // Smart Money layer off: no OB/FVG/liquidity/EQ/OTE lines.
        if (!cwLayersRef.current.ict) return;
        const pl = candleSeriesRef.current!.createPriceLine({
          price, color, lineWidth: width, lineStyle: style,
          axisLabelVisible: !!lineTitle, title: lineTitle,
        });
        ictPriceLinesRef.current.push(pl);
        if (tooltipTitle && desc) ictLevelDescriptionsRef.current.push({ price, title: tooltipTitle, desc, type: descType ?? "neutral" });
      };

      // Order Blocks
      ict.orderBlocks.forEach(ob => {
        const color = ob.type === "bull" ? "rgba(34,197,94,0.7)" : "rgba(239,68,68,0.7)";
        const tt    = T(ob.type === "bull" ? "chart.obBullTitle" : "chart.obBearTitle");
        const desc  = T(ob.type === "bull" ? "chart.obBullDesc" : "chart.obBearDesc");
        const dt = ob.type === "bull" ? "bullish" : "bearish";
        addLine(ob.high, color, ob.type === "bull" ? "Bull OB" : "Bear OB", 1, LineStyle.Dashed, tt, desc, dt);
        addLine(ob.low,  color, "",                                          1, LineStyle.Dashed, tt, desc, dt);
      });

      // Fair Value Gaps
      ict.fvgs.forEach(fvg => {
        const color = fvg.type === "bull" ? "rgba(56,189,248,0.6)" : "rgba(251,146,60,0.6)";
        const tt   = T(fvg.type === "bull" ? "chart.fvgBullTitle" : "chart.fvgBearTitle");
        const desc = T(fvg.type === "bull" ? "chart.fvgBullDesc" : "chart.fvgBearDesc");
        const dt = fvg.type === "bull" ? "bullish" : "bearish";
        addLine(fvg.top,    color, fvg.type === "bull" ? "Bull FVG" : "Bear FVG", 1, LineStyle.Dashed, tt, desc, dt);
        addLine(fvg.bottom, color, "",                                              1, LineStyle.Dashed, tt, desc, dt);
      });

      // Liquidity Pools
      ict.liquidityPools.forEach(lp => {
        const color = lp.type === "buy" ? "rgba(167,139,250,0.8)" : "rgba(251,191,36,0.8)";
        const tt   = T(lp.type === "buy" ? "chart.bslTitle" : "chart.sslTitle");
        const desc = T(lp.type === "buy" ? "chart.bslDesc" : "chart.sslDesc", { count: lp.count });
        const dt = lp.type === "buy" ? "warn" : "bearish";
        addLine(lp.price, color, lp.type === "buy" ? `BSL ×${lp.count}` : `SSL ×${lp.count}`, 1, LineStyle.Dotted, tt, desc, dt);
      });

      // Premium & Discount equilibrium line
      if (ict.pd) {
        addLine(ict.pd.mid, "rgba(148,163,184,0.5)", "EQ 50%", 1, LineStyle.Dashed,
          T("chart.eqTitle"),
          T("chart.eqDesc"),
          "neutral"
        );
      }

      // OTE zone
      if (ict.ote) {
        const color = ict.ote.type === "bull" ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)";
        const dt   = ict.ote.type === "bull" ? "bullish" : "bearish";
        const oteDesc = T(ict.ote.type === "bull" ? "chart.oteBullDesc" : "chart.oteBearDesc");
        addLine(ict.ote.top, color, `OTE ${ict.ote.type === "bull" ? "0.618" : "0.705"}`, 1, LineStyle.Dashed,
          T("chart.oteTitle"), oteDesc, dt
        );
        addLine(ict.ote.bottom, color, `OTE ${ict.ote.type === "bull" ? "0.705" : "0.618"}`, 1, LineStyle.Dashed,
          T("chart.oteTitle"), oteDesc, dt
        );
      }
    }

    ict.structure.forEach(s => {
      const isBOS  = s.kind === "bos";
      const isBull = s.dir  === "bull";
      const label  = isBOS ? (isBull ? "BOS ↑" : "BOS ↓") : (isBull ? "CHoCH ↑" : "CHoCH ↓");
      const comment = T(`chart.${isBOS ? "bos" : "choch"}${isBull ? "Bull" : "Bear"}`);
      newMap.set(s.time, { comment, type: isBull ? "bullish" : "bearish" });
      ictMarkers.push({
        time:     s.time as UTCTimestamp,
        position: isBull ? "aboveBar" : "belowBar",
        color:    isBOS ? (isBull ? "#22c55e" : "#ef4444") : "#f59e0b",
        shape:    "circle",
        text:     label,
        size:     1,
      });
    });

    // Volume Profile (POC/VAH/VAL) — independent of the active interval,
    // fetched separately (see the dedicated effect); redrawn here on every
    // feedChart call using whatever's currently cached in the ref, plus
    // re-triggered directly once that fetch actually resolves.
    volProfileLinesRef.current.forEach(pl => { try { candleSeriesRef.current?.removePriceLine(pl); } catch {} });
    volProfileLinesRef.current = [];
    const vp = volumeProfileRef.current;
    if (showVolProfileRef.current && vp && candleSeriesRef.current) {
      const addVpLine = (price: number, title: string, width: 1 | 2, style: LineStyle) => {
        const pl = candleSeriesRef.current!.createPriceLine({
          price, color: "#eab308", lineWidth: width, lineStyle: style, axisLabelVisible: true, title,
        });
        volProfileLinesRef.current.push(pl);
      };
      addVpLine(vp.poc, "POC", 2, LineStyle.Solid);
      addVpLine(vp.vah, "VAH", 1, LineStyle.Dashed);
      addVpLine(vp.val, "VAL", 1, LineStyle.Dashed);
    }

    // Session reference levels (daily/weekly open, Monday H/L, prev-day H/L)
    sessionLinesRef.current.forEach(pl => { try { candleSeriesRef.current?.removePriceLine(pl); } catch {} });
    sessionLinesRef.current = [];
    const sl = sessionLevelsRef.current;
    if (showSessionLevelsRef.current && sl && candleSeriesRef.current) {
      const addSessionLine = (price: number, title: string, color: string) => {
        const pl = candleSeriesRef.current!.createPriceLine({
          price, color, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title,
        });
        sessionLinesRef.current.push(pl);
      };
      addSessionLine(sl.dailyOpen,   T("chart.dailyOpen"),  "rgba(148,163,184,0.8)");
      addSessionLine(sl.weeklyOpen,  T("chart.weeklyOpen"), "rgba(129,140,248,0.8)");
      addSessionLine(sl.mondayHigh,  "Mon.H",       "rgba(244,63,94,0.7)");
      addSessionLine(sl.mondayLow,   "Mon.L",       "rgba(244,63,94,0.7)");
      addSessionLine(sl.prevDayHigh, "PDH",         "rgba(56,189,248,0.6)");
      addSessionLine(sl.prevDayLow,  "PDL",         "rgba(56,189,248,0.6)");
    }

    // Elliott Wave detection & chart overlay
    const ew = detectElliottWaves(aData);
    setElliottResult(ew);
    elliottResultRef.current = ew;
    const ewVisible = showElliottRef.current;

    if (elliottSeriesRef.current) {
      if (ew.pivots.length >= 2) {
        elliottSeriesRef.current.setData(ew.pivots.map(p => ({ time: p.time as any, value: p.price })));
        elliottSeriesRef.current.applyOptions({ visible: ewVisible });
      } else {
        elliottSeriesRef.current.setData([]);
      }
    }

    // Triangle / diagonal boundary lines
    elliottTrendSeriesRef.current.forEach((s, i) => {
      const line = ew.trendlines?.[i];
      s.setData(line ? line.map(p => ({ time: p.time as any, value: p.value })) : []);
      s.applyOptions({ visible: ewVisible && !!line });
    });

    // Clear old price lines
    elliottPriceLinesRef.current.forEach(pl => { try { elliottSeriesRef.current?.removePriceLine(pl); } catch {} });
    elliottPriceLinesRef.current = [];

    // Projection dashed path
    if (elliottProjSeriesRef.current) {
      if (ew.projectionPath.length >= 2) {
        elliottProjSeriesRef.current.setData(ew.projectionPath.map(p => ({ time: p.time as any, value: p.value })));
      } else {
        elliottProjSeriesRef.current.setData([]);
      }
      elliottProjSeriesRef.current.applyOptions({ visible: ewVisible });
    }

    // Fibonacci target price lines (only when already visible)
    if (ewVisible && ew.projections.length > 0 && elliottSeriesRef.current) {
      ew.projections.forEach(proj => {
        const pl = elliottSeriesRef.current!.createPriceLine({
          price: proj.price,
          color: proj.color,
          lineWidth: proj.isMain ? 4 : 3,
          lineStyle: proj.isMain ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: proj.label,
        });
        elliottPriceLinesRef.current.push(pl);
      });
      if (ew.invalidation != null) {
        const pl = elliottSeriesRef.current.createPriceLine({
          price: ew.invalidation,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: T("chart.invalidation"),
        });
        elliottPriceLinesRef.current.push(pl);
      }
    }

    // Divergence + Elliott markers — all merged and sorted by time
    if (divMarkersRef.current) {
      const divs = detectRSIDivergences(aData);
      const divMarkers: SeriesMarker<UTCTimestamp>[] = divs.map(d => ({
        time: d.time as UTCTimestamp,
        position: d.type === "bull" ? "belowBar" : "aboveBar",
        color:    d.type === "bull" ? "#22c55e"  : "#ef4444",
        shape:    d.type === "bull" ? "arrowUp"  : "arrowDown",
        text:     T(d.type === "bull" ? "chart.bullDiv" : "chart.bearDiv"),
        size: 1,
      }));
      const ewColor = ew.direction === "bullish" ? "#a78bfa" : "#f472b6";
      const ewMarkers: SeriesMarker<UTCTimestamp>[] = showElliottRef.current && ew.pivots.length >= 2
        ? ew.pivots.filter(p => p.label !== "0").map(p => ({
            time: p.time,
            position: (p.pivotType === "high" ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar",
            color: ewColor,
            shape: "circle" as const,
            // Bare label — impulse waves are "1".."5", corrective legs are
            // "A"/"B"/"C"; a "W" prefix on those read as "WA"/"WB"/"WC",
            // which isn't real Elliott notation.
            text: p.label,
            size: 2,
          }))
        : [];
      const L = cwLayersRef.current;
      const allMarkers = [
        ...(L.patterns ? [...patternMarkers, ...springMarkers, ...upthrustMarkers] : []),
        ...(L.divergence ? divMarkers : []),
        ...(L.ict ? ictMarkers : []),
        ...(L.retests ? retestMarkers : []),
        ...ewMarkers,
      ]
        .sort((a, b) => (a.time as number) - (b.time as number));
      divMarkersRef.current.setMarkers(allMarkers);
    }

    chartRef.current?.timeScale().fitContent();
  }, []);

  // ── Forecast helpers ─────────────────────────────────────────────────────────

  const clearForecast = useCallback(() => {
    if (chartRef.current) {
      if (forecastTargetRef.current && candleSeriesRef.current) {
        candleSeriesRef.current.removePriceLine(forecastTargetRef.current);
        forecastTargetRef.current = null;
      }
      if (forecastSeriesRef.current) {
        chartRef.current.removeSeries(forecastSeriesRef.current);
        forecastSeriesRef.current = null;
      }
      forecastCandlesRef.current = [];
      if (forecastBullRef.current) {
        chartRef.current.removeSeries(forecastBullRef.current);
        forecastBullRef.current = null;
      }
      if (forecastBearRef.current) {
        chartRef.current.removeSeries(forecastBearRef.current);
        forecastBearRef.current = null;
      }
    }
    setShowForecast(false);
  }, []);

  const saveChart = useCallback(() => {
    if (!chartRef.current) return;
    const canvas = chartRef.current.takeScreenshot();

    // Rounded-candle overlay(s) — the real CandlestickSeries colors are
    // transparent now (RoundedCandleOverlay paints the visible bodies on its
    // own canvas.drawing-overlay instead), so takeScreenshot() alone would
    // save a candle-less chart. Composite those canvases in before the
    // watermark stamp.
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const roundedCanvases = chartContainerRef.current?.querySelectorAll<HTMLCanvasElement>("canvas.drawing-overlay");
      roundedCanvases?.forEach(c => ctx.drawImage(c, 0, 0, canvas.width, canvas.height));
    }

    // Stamp a small watermark onto the captured canvas
    if (ctx) {
      const stamp = `coinhintz · ${coin}/USD ${interval.label} · ${new Date().toLocaleString()}`;
      ctx.font = '500 11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(148,163,184,0.55)';
      ctx.fillText(stamp, canvas.width - 10, canvas.height - 8);
    }

    const link = document.createElement('a');
    link.download = `${coin}-${interval.label}-${new Date().toISOString().slice(0, 16).replace('T', '_')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();

    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1800);
  }, [coin, interval]);

  const drawForecastNow = useCallback((currentAiRead: AIRead | null = aiRead) => {
    if (!chartRef.current || !candleSeriesRef.current || !candles.length) return;

    const wyk = detectWyckoff(candles);
    const ict = detectICT(candles);
    const { candles: fc, targetPrice, bias, conviction, bullPath, bearPath } = generateForecastCandles(
      candles, currentAiRead, indRef.current, interval.durationSec, 6, wyk, ict, macroCtxRef.current, coin as string
    );
    if (!fc.length) return;
    setForecastConviction(conviction);

    const isBull = bias === "bullish";
    const isBear = bias === "bearish";

    // Forecast candles — clearly distinct from real candles. Real colors
    // below are transparent now; RoundedCandleOverlay (JSX below) paints the
    // rounded bodies using brdUp/brdDn instead (the bias-tinted border
    // colors — the only part of the original black-body/colored-border
    // look that survives the overlay's single fill-color-per-side model).
    const brdUp = isBull ? "#7dd3fc" : "#fca5a5";
    const brdDn = isBear ? "#fca5a5" : "#7dd3fc";

    const series = chartRef.current.addSeries(CandlestickSeries, {
      upColor: "transparent", downColor: "transparent",
      borderUpColor: "transparent", borderDownColor: "transparent",
      wickUpColor:   "transparent", wickDownColor:   "transparent",
    });
    series.setData(fc);
    forecastSeriesRef.current = series;
    forecastCandlesRef.current = fc.map(c => ({
      time: c.time as number, open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    setForecastColors({ up: brdUp, down: brdDn });
    setChartGeneration(g => g + 1);

    // Uncertainty fan — bolder lines
    if (bullPath.length) {
      const bs = chartRef.current.addSeries(LineSeries, {
        color: "rgba(34,197,94,0.85)", lineWidth: 3, lineStyle: LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false,
      });
      bs.setData(bullPath);
      forecastBullRef.current = bs;
    }
    if (bearPath.length) {
      const bs = chartRef.current.addSeries(LineSeries, {
        color: "rgba(239,68,68,0.85)", lineWidth: 3, lineStyle: LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false,
      });
      bs.setData(bearPath);
      forecastBearRef.current = bs;
    }

    // Target price line — thick, solid, prominent
    const targetColor = isBull ? "#38bdf8" : isBear ? "#f87171" : "#94a3b8";
    const lastClose   = candles[candles.length - 1].close;
    const pctMove     = (targetPrice - lastClose) / lastClose * 100;
    const pctLabel    = (pctMove >= 0 ? "+" : "") + pctMove.toFixed(2) + "%";
    const tl = candleSeriesRef.current.createPriceLine({
      price: targetPrice,
      color: targetColor,
      lineWidth: 4,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: T("chart.aiTarget", { pct: pctLabel, price: "$" + targetPrice.toLocaleString("en-US", { maximumFractionDigits: 0 }) }),
    });
    forecastTargetRef.current = tl;

    chartRef.current.timeScale().fitContent();
    setShowForecast(true);
  }, [candles, aiRead, interval, coin]);

  // Auto-draw forecast whenever a new AI read arrives
  useEffect(() => {
    if (!aiRead) return;
    clearForecast();
    const t = setTimeout(() => drawForecastNow(aiRead), 120);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRead]);

  useEffect(() => {
    localStorage.setItem("cwSidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    resizeStartRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }, [sidebarWidth]);

  const handleResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeStartRef.current) return;
    const { startX, startWidth } = resizeStartRef.current;
    const next = Math.min(720, Math.max(300, startWidth + (startX - e.clientX)));
    setSidebarWidth(next);
  }, []);

  const handleResizePointerUp = useCallback(() => {
    resizeStartRef.current = null;
  }, []);

  const toggleForecast = useCallback(() => {
    if (showForecast) { clearForecast(); return; }
    drawForecastNow();
  }, [showForecast, clearForecast, drawForecastNow]);

  // ── Elliott Wave toggle ───────────────────────────────────────────────────────

  const toggleElliott = useCallback(() => {
    const next = !showElliott;
    setShowElliott(next);
    showElliottRef.current = next;

    elliottSeriesRef.current?.applyOptions({ visible: next });
    elliottProjSeriesRef.current?.applyOptions({ visible: next });
    elliottTrendSeriesRef.current.forEach((s, i) => s.applyOptions({ visible: next && !!elliottResultRef.current?.trendlines?.[i] }));

    // Wave-number markers are computed inside feedChart (reading
    // showElliottRef, not this state) — re-run it now so they actually
    // appear/disappear the moment the toggle is clicked, not just on the
    // next candle refresh.
    if (candlesRef.current.length > 0) feedChart(candlesRef.current);

    // Remove old price lines
    elliottPriceLinesRef.current.forEach(pl => { try { elliottSeriesRef.current?.removePriceLine(pl); } catch {} });
    elliottPriceLinesRef.current = [];

    if (next && elliottResultRef.current && elliottSeriesRef.current) {
      // Recreate price lines
      elliottResultRef.current.projections.forEach(proj => {
        const pl = elliottSeriesRef.current!.createPriceLine({
          price: proj.price,
          color: proj.color,
          lineWidth: proj.isMain ? 4 : 3,
          lineStyle: proj.isMain ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: proj.label,
        });
        elliottPriceLinesRef.current.push(pl);
      });
      if (elliottResultRef.current.invalidation != null) {
        const pl = elliottSeriesRef.current.createPriceLine({
          price: elliottResultRef.current.invalidation,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: T("chart.invalidation"),
        });
        elliottPriceLinesRef.current.push(pl);
      }

      // Pan chart to show full wave: first detected pivot → last projection point
      const ew = elliottResultRef.current;
      if (ew.pivots.length >= 2 && chartRef.current) {
        const firstTime = ew.pivots[0].time as number;
        const lastProjTime = ew.projectionPath.length > 0
          ? ew.projectionPath[ew.projectionPath.length - 1].time as number
          : ew.pivots[ew.pivots.length - 1].time as number;
        const span = lastProjTime - firstTime;
        chartRef.current.timeScale().setVisibleRange({
          from: (firstTime - span * 0.08) as UTCTimestamp,
          to:   (lastProjTime + span * 0.05) as UTCTimestamp,
        });
      }
    } else if (!next && chartRef.current) {
      // Restore to show recent candle data
      chartRef.current.timeScale().fitContent();
    }
  }, [showElliott, feedChart]);

  // ── Volume Profile / Session Levels toggles ─────────────────────────────────
  // Off by default — with Elliott, ICT, and the AI forecast all able to be on
  // at once too, leaving these always-on made the chart's price-line column
  // unreadable. feedChart is re-run immediately so the lines actually
  // appear/disappear on click rather than waiting for the next candle refresh.

  const toggleVolProfile = useCallback(() => {
    const next = !showVolProfile;
    setShowVolProfile(next);
    showVolProfileRef.current = next;
    if (candlesRef.current.length > 0) feedChart(candlesRef.current);
  }, [showVolProfile, feedChart]);

  const toggleSessionLevels = useCallback(() => {
    const next = !showSessionLevels;
    setShowSessionLevels(next);
    showSessionLevelsRef.current = next;
    if (candlesRef.current.length > 0) feedChart(candlesRef.current);
  }, [showSessionLevels, feedChart]);

  // ── Fetch candles ────────────────────────────────────────────────────────────

  const triggerAI = useRef(false);
  const suppressAIRef = useRef(false); // true when page returns from background — don't auto-run AI
  // Keyed by coin|interval|candle-open-time — reused whenever the same
  // candle gets re-triggered (manual refresh mid-candle, or flipping
  // coin/interval back and forth) so it doesn't re-spend AI quota for a
  // question it's already answered; a genuinely new candle gets a fresh key.
  const aiCacheRef = useRef<Map<string, { aiRead: AIRead; predData: PredictionResponse | null }>>(new Map());
  // Belt-and-suspenders on top of the candle-keyed cache above: even if
  // something re-fires triggerAI for a coin we just ran AI on (rapid tab
  // switching, a race, future code touching this, or just hitting refresh
  // on the page), never spend AI quota on it again within 5 minutes.
  // Keyed by coin ONLY — not coin|interval and not candle time — so
  // switching intervals (15m/1h/4h/...) on the same coin can't dodge the
  // cooldown, and persisted to localStorage (not just this ref) so a real
  // page reload, which wipes every in-memory ref, still remembers the last
  // call instead of firing again immediately.
  const lastAiCallAtRef = useRef<Map<string, number>>(new Map(
    (() => {
      try {
        const raw = localStorage.getItem("cwLastAiCallAt");
        return raw ? Object.entries(JSON.parse(raw) as Record<string, number>) : [];
      } catch { return []; }
    })()
  ));
  const persistAiCooldown = () => {
    try {
      localStorage.setItem("cwLastAiCallAt", JSON.stringify(Object.fromEntries(lastAiCallAtRef.current)));
    } catch { /* ignore */ }
  };
  const AI_COOLDOWN_MS = 5 * 60 * 1000;

  // Last-known AI read, persisted across reloads — a cooldown skip or a
  // page refresh should show the most recent real analysis instead of a
  // blank "no read yet" state, since the whole point of the cooldown is to
  // avoid re-asking the AI for something it already answered recently.
  // Keyed by coin AND interval (unlike the cooldown timer above, which is
  // deliberately coin-only) — a 1D read is not an accurate stand-in for
  // 15m, so switching intervals must show that interval's own last read,
  // or nothing, never a different interval's analysis mislabeled as
  // current just because something was cached for the coin.
  const loadPersistedAiRead = (c: string, iv: string): AIRead | null => {
    try {
      const raw = localStorage.getItem("cwLastAiRead");
      if (!raw) return null;
      const all = JSON.parse(raw) as Record<string, AIRead>;
      return all[`${c}|${iv}`] ?? null;
    } catch { return null; }
  };
  // MM narration history, kept per coin + interval (last 20) so a reload or
  // an interval switch shows it again instead of an empty "watching" box.
  const loadPersistedMmFeed = (c: string, iv: string): MMFeedEntry[] => {
    try {
      const all = JSON.parse(localStorage.getItem("cwMmFeed") ?? "{}") as Record<string, MMFeedEntry[]>;
      return Array.isArray(all[`${c}|${iv}`]) ? all[`${c}|${iv}`] : [];
    } catch { return []; }
  };
  const savePersistedMmFeed = (c: string, iv: string, feed: MMFeedEntry[]) => {
    try {
      const all = JSON.parse(localStorage.getItem("cwMmFeed") ?? "{}") as Record<string, MMFeedEntry[]>;
      all[`${c}|${iv}`] = feed.slice(-20);
      localStorage.setItem("cwMmFeed", JSON.stringify(all));
    } catch { /* ignore */ }
  };
  const savePersistedAiRead = (c: string, iv: string, read: AIRead) => {
    try {
      const raw = localStorage.getItem("cwLastAiRead");
      const all = raw ? (JSON.parse(raw) as Record<string, AIRead>) : {};
      all[`${c}|${iv}`] = read;
      localStorage.setItem("cwLastAiRead", JSON.stringify(all));
    } catch { /* ignore */ }
  };

  const fetchCandles = useCallback(async (triggerAnalysis = false) => {
    const data = await coinglass.getCandles(coin, interval.value, cwLimitFor(interval));
    if (!data.length) return;
    setCandles(data);
    candlesRef.current = data;
    feedChart(data);
    setRefreshedAt(new Date());

    const newLastTime = data[data.length - 1].time;
    const isNewCandle = lastCandleTime !== null && newLastTime !== lastCandleTime;
    setLastCandleTime(newLastTime);

    if (data.length) setLoadError(false);
    if (triggerAnalysis || (isNewCandle && !suppressAIRef.current)) triggerAI.current = true;
    suppressAIRef.current = false;
  }, [coin, interval, feedChart, lastCandleTime]);

  const [loadError, setLoadError] = useState(false);
  // Manual refresh button's own spin — independent of aiLoading, which only
  // reflects a real AI call being in flight. Inside the 5-minute AI
  // cooldown, fetchCandles(true) still re-fetches live candles/price (that
  // part's never gated) but the AI call itself gets skipped — without this,
  // clicking refresh then would look like nothing happened at all. A
  // minimum visible duration keeps the spin from flashing imperceptibly
  // fast when the underlying fetch resolves instantly.
  const [refreshSpinning, setRefreshSpinning] = useState(false);
  const handleManualRefresh = useCallback(() => {
    if (refreshSpinning) return;
    setRefreshSpinning(true);
    const minSpin = new Promise<void>(resolve => setTimeout(resolve, 650));
    Promise.allSettled([fetchCandles(true), minSpin]).then(() => setRefreshSpinning(false));
  }, [fetchCandles, refreshSpinning]);
  const [retryKey, setRetryKey] = useState(0);

  // Initial load + interval change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    // Show the last real AI read for this exact coin+interval immediately
    // (survives page refresh) instead of blanking to "no read yet" every
    // time — scoped per interval so this never shows a different
    // interval's analysis while a fresh/cached read for the current one
    // hasn't loaded yet. A fresh call only replaces it once the
    // cache/cooldown checks below actually allow one.
    setAiRead(loadPersistedAiRead(coin as string, interval.value));
    setAiNotice(null);
    setMmFeed(loadPersistedMmFeed(coin as string, interval.value));
    setLastCandleTime(null);

    // A kept date range that doesn't fit the new interval is dropped.
    if (cwRangeRef.current && !cwRangeFits(cwRangeRef.current.secs, interval)) {
      cwRangeRef.current = null;
      setCwRange(null);
    }
    coinglass.getCandles(coin, interval.value, cwLimitFor(interval))
      .then(data => {
        if (cancelled) return;
        if (!data.length) {
          setLoadError(true);
          setLoading(false);
          return;
        }
        setCandles(data);
        candlesRef.current = data;
        feedChart(data);
        // Kept date range: show that span on the new interval.
        if (cwRangeRef.current) {
          const secs = cwRangeRef.current.secs;
          requestAnimationFrame(() => {
            const last = data[data.length - 1].time as number;
            chartRef.current?.timeScale().setVisibleRange({ from: Math.max(data[0].time as number, last - secs) as UTCTimestamp, to: last as UTCTimestamp });
          });
        }
        setRefreshedAt(new Date());
        setLastCandleTime(data[data.length - 1].time);
        setLoading(false);
        triggerAI.current = true;
        if (!onReadyFiredRef.current) { onReadyFiredRef.current = true; onReady?.(); }
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [coin, intervalIdx, retryKey]);

  // Auto-refresh — pro+ only. Paused while this section isn't the active
  // one (component stays mounted-but-hidden rather than unmounting, to
  // preserve chart state across nav — see the "visible" prop) so a
  // background tab doesn't keep firing network fetches for a chart no
  // one's looking at.
  useEffect(() => {
    if (!isPaid || !visible) return;
    const id = setInterval(() => fetchCandles(false), interval.refresh);
    return () => clearInterval(id);
  }, [fetchCandles, interval.refresh, isPaid, visible]);

  // Suppress AI auto-trigger when page returns from background (idle/lock screen)
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) suppressAIRef.current = true; };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Resize chart when tab becomes visible again (component stays mounted while hidden)
  useEffect(() => {
    if (!visible || !chartRef.current || !chartContainerRef.current) return;
    requestAnimationFrame(() => {
      if (!chartRef.current || !chartContainerRef.current) return;
      const w = chartContainerRef.current.clientWidth;
      const h = chartContainerRef.current.clientHeight;
      if (w > 0) {
        chartRef.current.resize(w, h > 0 ? h : 460);
        chartRef.current.timeScale().fitContent();
      }
    });
  }, [visible]);

  // Candle close countdown — ticks every second. Paused while hidden, same
  // reasoning as the auto-refresh effect above.
  useEffect(() => {
    if (!visible || !candles.length) return;
    const openTimeSec = Number(candles[candles.length - 1].time);
    const closesAt    = openTimeSec + interval.durationSec;
    const tick = () => setCandleCountdown(fmtCountdown(Math.max(0, closesAt - Math.floor(Date.now() / 1000))));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [candles, interval, visible]);

  // Per-interval tab countdowns — UTC boundary math, ticks every second.
  // Paused while hidden.
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      setIntervalCountdowns(INTERVALS.map(iv => fmtTabBadge(iv, nowSec)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [visible]);

  // Daily close countdown — always UTC midnight. Paused while hidden.
  useEffect(() => {
    if (!visible) return;
    const tick = () => {
      const now      = Date.now();
      const midnight = Math.ceil(now / 86_400_000) * 86_400_000;
      setDailyCountdown(fmtCountdownFull(Math.max(0, Math.floor((midnight - now) / 1000))));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [visible]);

  // Daily close banner — pro+ only. Paused while hidden — this one does a
  // real network fetch every 60s, not just a cheap countdown tick.
  useEffect(() => {
    if (!isPaid || !visible) return;
    const BINANCE_SYM: Record<string, string> = {
      BTC: "BTCUSDT", ETH: "ETHUSDT", XRP: "XRPUSDT", SOL: "SOLUSDT",
      DOGE: "DOGEUSDT", ADA: "ADAUSDT", SUI: "SUIUSDT", BNB: "BNBUSDT",
      NEAR: "NEARUSDT", RENDER: "RENDERUSDT", ZEC: "ZECUSDT",
    };
    const sym = BINANCE_SYM[coin as string] ?? `${coin}USDT`;
    const dismissKey = `daily-banner-dismissed-${coin}`;

    const check = async () => {
      const now = new Date();
      const minsSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (minsSinceMidnight >= 60) { setDailyCloseBanner(null); return; }

      const todayStr = now.toISOString().slice(0, 10);
      if (sessionStorage.getItem(dismissKey) === todayStr) return;

      try {
        const data = await fetchBn(`/api/v3/klines?symbol=${sym}&interval=1d&limit=2`);
        const c = data[0];
        const open = parseFloat(c[1]), high = parseFloat(c[2]);
        const low = parseFloat(c[3]), close = parseFloat(c[4]);
        setDailyCloseBanner({
          direction: close >= open ? "bullish" : "bearish",
          open, high, low, close,
          changePct: ((close - open) / open) * 100,
          dismissed: false,
        });
      } catch { /* ignore */ }
    };

    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, [coin, visible]);

  // MTF biases — pro+ only
  useEffect(() => {
    if (!isPaid) return;
    // Clear first so nothing (Today's read, the MTF panel) shows the
    // previous coin's trends while the new ones load.
    setMtfBiases([]);
    fetchMTFBiases(coin as string).then(setMtfBiases).catch(() => {});
    setWizardIntent(null);
    setPredData(null);
  }, [coin, isPaid]);

  // Weekly TEMA cycle data — fetched once per coin, cached by Binance layer
  useEffect(() => {
    if (!isPaid || !coin) return;
    coinglass.getCandles(coin as string, "1w", 500).then(cs => {
      if (cs.length < 60) return;
      const closes = cs.map(c => c.close);
      setWeeklyCycle({ candles: cs, tema14: calcTEMA(closes, 14), tema21: calcTEMA(closes, 21) });
    }).catch(() => {});
  }, [coin, isPaid]);

  // Volume Profile — fixed 2-week lookback at 1h resolution, independent
  // of whatever interval is active on the main chart (matches how a real
  // "2W" volume profile reference is meant to work).
  useEffect(() => {
    if (!isPaid || !coin) return;
    coinglass.getCandles(coin as string, "1h", 336).then(cs => {
      const vp = detectVolumeProfile(cs);
      volumeProfileRef.current = vp;
      setVolumeProfile(vp);
      if (candlesRef.current.length > 0) feedChart(candlesRef.current);
    }).catch(() => {});
  }, [coin, isPaid, feedChart]);

  // Session reference levels — daily candles, independent of active interval
  useEffect(() => {
    if (!isPaid || !coin) return;
    coinglass.getCandles(coin as string, "1d", 10).then(cs => {
      const sl = computeSessionLevels(cs);
      sessionLevelsRef.current = sl;
      setSessionLevels(sl);
      if (candlesRef.current.length > 0) feedChart(candlesRef.current);
    }).catch(() => {});
  }, [coin, isPaid, feedChart]);

  // Historical fractal/pattern-analog search — always on DAILY candles
  // regardless of what interval is on screen, since this is specifically
  // hunting for month-scale shape repeats (30-day window), not shape-matching
  // whatever short interval the chart happens to be set to. Both the "live"
  // window and the historical search corpus come from this same daily pull.
  // Re-runs on coin change only now — the aggregate result (matches/upCount/
  // avgForwardReturn) feeds the always-visible Fractal Match signal card, not
  // just the Monthly Fractals tab, so it can no longer wait for that tab to
  // be opened first. `cancelled` guards against a slower in-flight fetch for
  // a since-abandoned coin clobbering a newer one.
  useEffect(() => {
    if (!isPaid || !coin) return;
    let cancelled = false;
    setFractalLoading(true);
    // 6000 daily candles (~16y) comfortably exceeds any coin's actual
    // history on Binance (oldest USDT pairs go back to ~2017) — the fetch
    // paginates backward and stops itself the moment it runs out of real
    // data (fetchBinanceKlines's `page.length < MAX_PER_REQ` early-exit in
    // coinglass.ts), so this reaches all the way back to listing for every
    // coin without wasting requests on younger ones.
    coinglass.getCandles(coin as string, "1d", 6000).then(cs => {
      if (cancelled) return;
      const fa = detectFractalAnalogs(cs, cs);
      fractalAnalogsRef.current = fa;
      setFractalAnalogs(fa);
      setSelectedFractalIdx(0);
      setExpandedFractalIdx(null);
    }).catch(() => {
      if (cancelled) return;
      fractalAnalogsRef.current = null;
      setFractalAnalogs(null);
    }).finally(() => { if (!cancelled) setFractalLoading(false); });
    return () => { cancelled = true; };
  }, [coin, isPaid]);

  // Run AI + macro fetch when flagged — pro+ only
  useEffect(() => {
    if (!isPaid || !triggerAI.current || candles.length < 20) return;
    triggerAI.current = false;

    // Same recent window as the chart's structure analysis (a kept date
    // range can load far more history than the AI read should look at).
    const aiCandles = candles.length > CW_ANALYSIS_WINDOW ? candles.slice(-CW_ANALYSIS_WINDOW) : candles;
    const ind     = buildIndicators(aiCandles);
    const pattern = detectPattern(aiCandles);

    const ict = detectICT(aiCandles);
    aiScanIctRef.current = ict;
    aiCancelledRef.current = false;

    const last = candles[candles.length - 1];
    const cacheKey = `${coin}|${interval.value}|${last.time}`;
    const cached = aiCacheRef.current.get(cacheKey);

    const throttleKey = coin as string;
    const inCooldown = !cached && (Date.now() - (lastAiCallAtRef.current.get(throttleKey) ?? 0)) < AI_COOLDOWN_MS;

    // Only show the "Analyzing…" overlay when a real AI call is actually
    // about to go out — a cache hit resolves instantly and a cooldown skip
    // never calls it at all, so putting the full-screen spinner up for
    // either of those (as a flat `setAiLoading(true)` above used to) made
    // every page refresh look like a fresh analysis was running, even when
    // the AI API wasn't being touched at all.
    if (!cached && !inCooldown) setAiLoading(true);
    if (inCooldown) {
      // Shown as a live countdown (AiCooldown), not a frozen time string.
      setAiNotice(COOLDOWN_NOTICE);
    } else {
      setAiNotice(null);
    }

    // Fetch HTF candles for multi-timeframe liquidity pockets
    const HTF_FRAMES = [
      { tf: "12h", label: "12H", limit: 40,  color: "#818cf8" },
      { tf: "1d",  label: "1D",  limit: 30,  color: "#38bdf8" },
      { tf: "3d",  label: "3D",  limit: 20,  color: "#f59e0b" },
      { tf: "1w",  label: "1W",  limit: 20,  color: "#f97316" },
    ];
    const htfFetches = HTF_FRAMES.map(f =>
      coinglass.getCandles(coin as string, f.tf, f.limit)
        .then(c => ({ ...f, pools: detectICT(c).liquidityPools }))
        .catch(() => ({ ...f, pools: [] as LiqPool[] }))
    );

    // Same candle already analyzed (manual refresh mid-candle, or flipping
    // back to a coin/interval we just looked at) — reuse it instead of
    // spending AI quota on an answer that can't have changed. And even on
    // a genuine cache miss, never fire twice within AI_COOLDOWN_MS for the
    // same coin (any interval) — see lastAiCallAtRef above.
    const mmPromise = cached ? Promise.resolve<AIRead | null>(cached.aiRead)
      : inCooldown ? Promise.resolve<AIRead | null>(null)
      : (lastAiCallAtRef.current.set(throttleKey, Date.now()),
         persistAiCooldown(),
         getMMAnalysis(coin as string, interval.label, aiCandles, ind, pattern, wyckoff, ict, sessionLevelsRef.current, volumeProfileRef.current, fractalAnalogsRef.current)
           .then((r) => {
             if (!r) {
               // Nothing usable came back: don't hold the cooldown for it.
               lastAiCallAtRef.current.delete(throttleKey); persistAiCooldown();
               setAiNotice(T("ai.noRead"));
             }
             return r;
           })
           .catch((e: unknown) => {
             lastAiCallAtRef.current.delete(throttleKey); persistAiCooldown();
             const msg = e instanceof Error ? e.message : "";
             setAiNotice(
               /auth/i.test(msg) ? T("ai.signIn")
                 : /limit|quota|429/i.test(msg) ? msg || T("ai.limit")
                 : T("ai.unreachable"),
             );
             return null;
           }));

    Promise.all([
      mmPromise,
      getMacroContext(coin as string).catch(() => null),
      coinglass.getAllBTCData(coin as string).catch(() => null),
      fetchFearGreed().catch(() => null),
      Promise.all(htfFetches),
    ]).then(([res, macro, btcLive, fearGreed, htfResults]) => {
      if (aiCancelledRef.current) return;
      if (res) {
        setAiRead(res);
        if (!cached) savePersistedAiRead(coin as string, interval.value, res);
        setMmFeed(prev => {
          const entry: MMFeedEntry = {
            id: `${coin}-${last.time}`,
            time: Number(last.time),
            price: last.close,
            mmAction: res.mmAction,
            mmReading: res.mmReading,
            bias: res.bias,
            confidence: res.confidence,
          };
          const next = prev.length && prev[prev.length - 1].time === entry.time
            ? [...prev.slice(0, -1), entry]
            : [...prev.slice(-49), entry];
          savePersistedMmFeed(coin as string, interval.value, next);
          return next;
        });
        if (!cached) aiCacheRef.current.set(cacheKey, { aiRead: res, predData: null });
      }
      if (macro) setMacroCtx(macro);

      // Draw HTF liquidity lines on chart
      if (candleSeriesRef.current) {
        // Clear old HTF lines
        htfLiqLinesRef.current.forEach(l => { try { candleSeriesRef.current!.removePriceLine(l); } catch {} });
        htfLiqLinesRef.current = [];
        // Draw new ones
        const drawn = new Set<string>();
        for (const frame of htfResults) {
          for (const pool of frame.pools) {
            const key = `${pool.price.toFixed(0)}-${pool.type}`;
            if (drawn.has(key)) continue;
            drawn.add(key);
            const isBuy = pool.type === "buy";
            const line = candleSeriesRef.current.createPriceLine({
              price: pool.price,
              color: frame.color,
              lineWidth: 1,
              lineStyle: 3, // Dashed
              axisLabelVisible: true,
              title: `${frame.label} ${isBuy ? "BSL" : "SSL"} ×${pool.count}`,
            });
            htfLiqLinesRef.current.push(line);
          }
        }
      }

      setAiLoading(false);
      if (cached) {
        if (cached.predData) setPredData(cached.predData);
      } else if (inCooldown) {
        // skip — within the 5min AI cooldown, leave whatever prediction is already showing
      } else if (btcLive) {
        openai.getPricePrediction(btcLive, fearGreed ?? undefined)
          .then(pred => {
            if (pred?.success) {
              setPredData(pred);
              const entry = aiCacheRef.current.get(cacheKey);
              if (entry) entry.predData = pred;
            }
          })
          .catch(() => {});
      }
    });
  }, [candles]);

  // Cycle scan step while AI is loading
  useEffect(() => {
    if (!aiLoading) { setScanStep(-1); return; }
    setScanStep(0);
    const t = setInterval(() => setScanStep(s => s + 1), 420);
    return () => clearInterval(t);
  }, [aiLoading]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const ind     = candles.length >= 20 ? buildIndicators(candles) : null;
  indRef.current = ind;
  macroCtxRef.current = macroCtx;
  const pattern = candles.length >= 3  ? detectPattern(candles)   : null;
  const patternScan = candles.length >= 4 ? scanCandlePatterns(candles) : null;
  // Classic chart patterns (H&S, double tops, triangles, wedges, flags) on
  // closed candles only — re-run only when a candle closes, not every tick.
  const closedKey = candles.length > 1 ? `${coin}|${intervalIdx}|${candles.length}|${candles[candles.length - 2].time}` : "";
  const chartPatterns = useMemo(
    () => (closedKey ? detectChartPatterns(candles.slice(0, -1) as PBar[]) : []),
    [closedKey], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const chartPattern = chartPatterns[0] ?? null;
  const toggleChartPatternFocus = () => {
    if (chartPatternFocus || !chartPattern) { setChartPatternFocus(false); return; }
    setChartPatternFocus(true);
    const all = candlesRef.current;
    const first = all.findIndex(c => (c.time as number) >= chartPattern.startTime);
    if (first >= 0) chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, first - 15), to: all.length + 6 });
    if (!cwDesktop) chartContainerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const patternTimesKey = patternScan?.times.join(",") ?? "";
  // Stable array per pattern so the highlight doesn't re-measure every tick.
  const patternTimes = useMemo(() => (patternTimesKey ? patternTimesKey.split(",").map(Number) : null), [patternTimesKey]);

  // Tap the card: zoom the chart onto the pattern (with some lead-in) and
  // show the highlight; tap again to hide it.
  const togglePatternFocus = () => {
    if (patternFocus || !patternScan) { setPatternFocus(false); return; }
    setPatternFocus(true);
    const all = candlesRef.current;
    const first = all.findIndex(c => (c.time as number) === patternScan.times[0]);
    if (first >= 0) {
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, first - 40), to: all.length + 4 });
    }
    // Phones: the chart sits above the cards — bring it into view.
    if (!cwDesktop) chartContainerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const rsiStatus = (): "bull" | "bear" | "neutral" | "warn" => {
    if (ind?.rsi == null) return "neutral";
    return ind.rsi >= 70 ? "bear" : ind.rsi <= 30 ? "bull" : ind.rsi >= 55 ? "bull" : "neutral";
  };
  const macdStatus = (): "bull" | "bear" | "neutral" | "warn" => {
    if (ind?.macdHist == null) return "neutral";
    return ind.macdHist > 0 ? "bull" : "bear";
  };
  const bbStatus = (): "bull" | "bear" | "neutral" | "warn" => {
    if (ind?.bbPct == null) return "neutral";
    return ind.bbPct >= 0.75 ? "warn" : ind.bbPct <= 0.25 ? "bull" : "neutral";
  };
  const volStatus = (): "bull" | "bear" | "neutral" | "warn" => {
    if (ind?.volRatio == null) return "neutral";
    return ind.volRatio >= 1.5 ? "warn" : ind.volRatio < 0.7 ? "bear" : "neutral";
  };

  const lastPrice  = candles.length ? candles[candles.length - 1].close : null;
  const secondLast = candles.length >= 2 ? candles[candles.length - 2].close : null;
  // Change over the selected interval's own last candle (not a fixed 24h
  // window) — the hero price row's pill shows the interval's own label
  // (4H/1D/1W/...) precisely so this stays correct as the interval changes.
  const heroPrice  = ticker?.price ?? lastPrice;
  const pctChange  = lastPrice && secondLast ? ((lastPrice - secondLast) / secondLast) * 100 : null;
  const absChange  = lastPrice && secondLast ? lastPrice - secondLast : null;

  const feedCandles = candles.slice(-15);
  const prevFeedLen = useRef(0);
  const isNewRow = (i: number) => i === feedCandles.length - 1 && feedCandles.length > prevFeedLen.current;
  // track length after each render
  useEffect(() => { prevFeedLen.current = feedCandles.length; }, [feedCandles.length]);

  // When this coin's AI cooldown ends (0 = none). Recomputed on every render
  // — the page re-renders after each AI call, which is when it changes.
  const aiCooldownUntil = (lastAiCallAtRef.current.get(coin as string) ?? 0) + AI_COOLDOWN_MS;

  // Desktop right-panel tabs — shared by the tab row and, when the panel
  // is hidden, the slim icon rail.
  const cwPanelTabs = ([

                    { key: "signals", label: tA("candleInsights.tab.overview"), active: rightTab === "signals" || rightTab === "fractal",
                      icon: <path d="M22 12h-4l-3 9L9 3l-3 9H2" /> },
                    { key: "read", label: tA("candleInsights.tab.ai"), active: rightTab === "read" || rightTab === "plan" || rightTab === "narration",
                      icon: <path d="M12 3v7M12 14v7M3 12h7M14 12h7" /> },
                    { key: "wave", label: tA("candleInsights.tab.elliott"), active: rightTab === "wave",
                      icon: <path d="M2 17l4-8 4 6 4-10 4 7 4-5" /> },
                    { key: "tape", label: tA("candleInsights.tab.tape"), active: rightTab === "tape",
                      icon: <><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></> },
  ] as const);

  // Desktop "AI" tab: Read, Trade plan and MM narration stacked in one
  // scroll (no sub-switch), separated by thin dividers.
  const aiGroup = rightTab === "read" || rightTab === "plan" || rightTab === "narration";
  // Phones: the side panel sits under the chart and can't be hidden.
  const panelHidden = cwDesktop && rightPanelCollapsed;
  const aiSec = (key: string, label: string, content: React.ReactNode) =>
    aiGroup ? (
      <section className={`cw-ai-sec cw-ai-sec--${key}`} aria-label={label}>
        {content}
      </section>
    ) : content;

  // Desktop terminal layout: signal cards and the live tape live in the
  // right panel (as tabs) instead of stacking above/below the chart.
  const signalCardsEl = (
    <>
      <div className="cw-signal-cards-head">
        <span className="cw-feed-live-dot" />
        <span className="cw-signal-cards-title">{tA("candleInsights.liveSignals")}</span>
      </div>
      {!loading && (() => {
        const read = buildTodaysRead({ candle: patternScan, chart: chartPattern, ew: elliottResult, mtf: mtfBiases, ind, price: heroPrice || null });
        if (!read) return null;
        return (
          <div className={`cw-read cw-read--${read.tone}`}>
            <span className="cw-read-kicker">{tA("candleInsights.read.kicker")}</span>
            <p className="cw-read-headline">{read.headline}</p>
            <p className="cw-read-line">{read.line}</p>
            {read.why.length > 0 && (
              <>
                <span className="cw-read-sub">{tA("candleInsights.read.why")}</span>
                <ul className="cw-read-why">
                  {read.why.map(c => (
                    <li key={c.text} className={`cw-read-why-item cw-read-why-item--${c.dir}`}>
                      <span className="cw-read-why-dot" aria-hidden="true">{c.dir === "up" ? "▲" : c.dir === "down" ? "▼" : "•"}</span>
                      <span>{c.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {read.watch && (
              <>
                <span className="cw-read-sub">{tA("candleInsights.read.watch")}</span>
                <p className="cw-read-line">{read.watch}</p>
              </>
            )}
            {read.alerts.length > 0 && (
              <div className="cw-read-alerts">
                <span className="cw-read-sub">{tA("cwAlerts.getNotified")}</span>
                <div className="cw-read-alert-row">
                  {read.alerts.map(a => {
                    const set = hasPriceAlert(coin as string, a.price, a.direction);
                    return (
                      <button
                        key={`${a.direction}${a.price}`}
                        type="button"
                        className={`cw-read-alert${set ? " cw-read-alert--set" : ""}`}
                        aria-pressed={set}
                        aria-label={set
                          ? tA(a.direction === "above" ? "cwAlerts.cancelAbove" : "cwAlerts.cancelBelow", { price: ewFmt(a.price) })
                          : tA(a.direction === "above" ? "cwAlerts.alertAbove" : "cwAlerts.alertBelow", { price: ewFmt(a.price) })}
                        onClick={() => {
                          // Alerts are push notifications, which need an account.
                          if (!user) { onOpenAuth(); return; }
                          // Tap again to cancel (removes the server copy too, so no push).
                          if (set) removePriceAlert(coin as string, a.price, a.direction, user?.id);
                          else addPriceAlert(coin as CoinSymbol, a.price, a.direction, user?.id);
                          setAlertTick(t => t + 1);
                        }}
                      >
                        <span aria-hidden="true">{set ? "✓" : "🔔"}</span>
                        {/* Word order per language (Turkish puts the price first). */}
                        {tA(a.direction === "above" ? "cwAlerts.aboveAt" : "cwAlerts.belowAt", { price: ewFmt(a.price) })}
                        <em>{set ? tA("cwAlerts.alertSet") : a.why}</em>
                        {set && <span className="cw-read-alert-x" aria-hidden="true">✕</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="cw-read-alert-hint">
                  {!user
                    ? tA("cwAlerts.hintSignIn")
                    : profile?.notify_price_alerts === false
                      ? tA("cwAlerts.hintProfileOff")
                      : pushState === "off"
                        ? <>{tA("cwAlerts.hintDeviceOff")} <button type="button" className="cw-read-alert-enable" onClick={turnOnPush}>{tA("cwAlerts.turnOn")}</button></>
                        : tA("cwAlerts.hintOn")}
                </p>
              </div>
            )}
            {read.momentum && <p className="cw-read-note">{read.momentum}</p>}
          </div>
        );
      })()}
      <div className="cw-signal-cards">
        {(() => {
          // Tap: show the wave count on the chart (labels, path, targets,
          // invalidation) — same as the Elliott chart toggle, which also
          // zooms onto the wave. Tap again to hide.
          const ewTap = !loading && !!elliottResult && elliottResult.pattern !== "none";
          const onEw = () => {
            toggleElliott();
            if (!showElliott && !cwDesktop) chartContainerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
          };
          return (
        <div
          className={`cw-signal-card${ewTap ? " cw-signal-card--tap" : ""}${ewTap && showElliott ? " cw-signal-card--on" : ""}`}
          style={ewTap ? ({ "--ph-card": elliottResult!.direction === "bullish" ? "#22c55e" : elliottResult!.direction === "bearish" ? "#ef4444" : "#94a3b8" } as React.CSSProperties) : undefined}
          {...(ewTap ? {
            role: "button", tabIndex: 0, "aria-pressed": showElliott,
            onClick: onEw,
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onEw(); } },
          } : {})}
        >
          <span className="cw-signal-card-label">
            {tA("candleInsights.stat.elliott")}
            {ewTap && <span className="cw-signal-card-hint"> · {tA(showElliott ? "candleInsights.card.showing" : "candleInsights.card.tapToShow")}</span>}
          </span>
          {loading ? (
            <div className="cw-signal-skeleton">
              <span className="cw-signal-skeleton-line cw-signal-skeleton-line--wide" />
              <span className="cw-signal-skeleton-line" />
            </div>
          ) : elliottResult && elliottResult.pattern !== "none" ? (
            <>
              <div className="cw-signal-card-main">
                <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true">
                  <polyline className="cw-signal-wave-line" points="2,22 10,6 14,13 22,2 27,11 38,4" fill="none"
                    stroke={elliottResult.direction === "bullish" ? "#22c55e" : elliottResult.direction === "bearish" ? "#ef4444" : "var(--color-text-muted)"}
                    strokeWidth="2" />
                </svg>
                <div>
                  <div className="cw-signal-card-value">
                    {elliottResult.name
                      ? <>{ewNameT(elliottResult.name)} <span className="cw-signal-card-tag--neutral">· {elliottResult.currentWave}</span></>
                      : <>{tA(elliottResult.pattern === "impulse" ? "candleInsights.card.wave" : "candleInsights.card.corr", { wave: elliottResult.currentWave })}</>}
                  </div>
                  <div className={`cw-signal-card-tag cw-signal-card-tag--${elliottResult.direction === "bullish" ? "up" : elliottResult.direction === "bearish" ? "down" : "neutral"}`}>
                    {tA(elliottResult.direction === "bullish" ? "candleInsights.bias.bullish" : elliottResult.direction === "bearish" ? "candleInsights.bias.bearish" : "candleInsights.bias.neutral")}
                  </div>
                </div>
              </div>
              <p className="cw-signal-card-note">{ewDescT(elliottResult)}</p>
            </>
          ) : (
            <p className="cw-signal-card-note">{tA("candleInsights.card.noWave")}</p>
          )}
        </div>
          );
        })()}

        <div
          className={`cw-signal-card${patternScan && !loading ? " cw-signal-card--tap" : ""}${patternFocus && patternScan ? " cw-signal-card--on" : ""}`}
          style={patternScan ? ({ "--ph-card": patternScan.pattern.type === "bullish" ? "#22c55e" : patternScan.pattern.type === "bearish" ? "#ef4444" : "#94a3b8" } as React.CSSProperties) : undefined}
          {...(patternScan && !loading ? {
            role: "button", tabIndex: 0, "aria-pressed": patternFocus,
            onClick: togglePatternFocus,
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePatternFocus(); } },
          } : {})}
        >
          <span className="cw-signal-card-label">
            {tA("candleInsights.card.candlePatterns")}
            {patternScan && !loading && <span className="cw-signal-card-hint"> · {tA(patternFocus ? "candleInsights.card.showing" : "candleInsights.card.tapToShow")}</span>}
          </span>
          {loading ? (
            <div className="cw-signal-skeleton">
              <span className="cw-signal-skeleton-line cw-signal-skeleton-line--wide" />
              <span className="cw-signal-skeleton-line" />
            </div>
          ) : patternScan ? (() => {
            const { pattern: p, candlesAgo, hits, samples, avgMovePct } = patternScan;
            const dir = p.type === "bullish" ? "up" : p.type === "bearish" ? "down" : "neutral";
            const color = dir === "up" ? "#22c55e" : dir === "down" ? "#ef4444" : "var(--color-text-muted)";
            return (
              <>
                <div className="cw-signal-card-main">
                  {/* Mini candle: body + wick in the pattern's colour. */}
                  <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true">
                    <line x1="12" y1="3" x2="12" y2="23" stroke={color} strokeWidth="1.5" opacity="0.6" />
                    <rect x="8" y="8" width="8" height="10" rx="1.5" fill={color} opacity="0.6" />
                    <line x1="28" y1="1" x2="28" y2="25" stroke={color} strokeWidth="1.5" />
                    <rect x="23" y="5" width="10" height="16" rx="1.5" fill={color} />
                  </svg>
                  <div>
                    <div className="cw-signal-card-value">{patName(p.name)}</div>
                    <div className={`cw-signal-card-tag cw-signal-card-tag--${dir}`}>
                      {tA(`candleInsights.bias.${p.type}`)}
                      <span className="cw-signal-card-tag--neutral"> · {candlesAgo === 1 ? tA("candleInsights.card.lastCandle") : tA("candleInsights.card.candlesAgo", { n: candlesAgo })}</span>
                    </div>
                  </div>
                </div>
                <p className="cw-signal-card-note">
                  {hits !== null
                    ? tA(p.type === "bullish" ? "candleInsights.card.workedHigher" : "candleInsights.card.workedLower",
                        { hits, samples, n: HIT_AHEAD, avg: `${avgMovePct! >= 0 ? "+" : ""}${avgMovePct!.toFixed(2)}%` })
                    : avgMovePct !== null
                      ? tA("candleInsights.card.seen", { samples, n: HIT_AHEAD, avg: `${avgMovePct >= 0 ? "+" : ""}${avgMovePct.toFixed(2)}%` })
                      : patDesc(p)}
                </p>
              </>
            );
          })() : (
            <p className="cw-signal-card-note">{tA("candleInsights.card.noPattern", { n: LATEST_WINDOW })}</p>
          )}
        </div>

        {/* Classic chart pattern (H&S, double top/bottom, triangle, wedge, flag). */}
        <div
          className={`cw-signal-card${chartPattern && !loading ? " cw-signal-card--tap" : ""}${chartPatternFocus && chartPattern ? " cw-signal-card--on" : ""}`}
          style={chartPattern ? ({ "--ph-card": chartPattern.bias === "bullish" ? "#22c55e" : "#ef4444" } as React.CSSProperties) : undefined}
          {...(chartPattern && !loading ? {
            role: "button", tabIndex: 0, "aria-pressed": chartPatternFocus,
            onClick: toggleChartPatternFocus,
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleChartPatternFocus(); } },
          } : {})}
        >
          <span className="cw-signal-card-label">
            {tA("candleInsights.card.chartPattern")}
            {chartPattern && !loading && <span className="cw-signal-card-hint"> · {tA(chartPatternFocus ? "candleInsights.card.showing" : "candleInsights.card.tapToShow")}</span>}
          </span>
          {loading ? (
            <div className="cw-signal-skeleton">
              <span className="cw-signal-skeleton-line cw-signal-skeleton-line--wide" />
              <span className="cw-signal-skeleton-line" />
            </div>
          ) : chartPattern ? (
            <>
              <div className="cw-signal-card-main">
                <div>
                  <div className="cw-signal-card-value">{chartPattern.name}</div>
                  <div className={`cw-signal-card-tag cw-signal-card-tag--${chartPattern.bias === "bullish" ? "up" : "down"}`}>
                    {tA(chartPattern.bias === "bullish" ? "candleInsights.bias.bullish" : "candleInsights.bias.bearish")}
                    <span className="cw-signal-card-tag--neutral"> · {tA(chartPattern.status === "breakout" ? "candleInsights.card.confirmed" : "candleInsights.card.forming")}</span>                  </div>
                </div>
              </div>
              <p className="cw-signal-card-note">{chartPattern.what}</p>
              <p className="cw-signal-card-note">{chartPattern.next}</p>
            </>
          ) : (
            <p className="cw-signal-card-note">{tA("candleInsights.card.noChartPattern")}</p>
          )}
        </div>

        <div className="cw-signal-card">
          <span className="cw-signal-card-label">{tA("candleInsights.card.fractal")}</span>
          {loading ? (
            <div className="cw-signal-skeleton">
              <span className="cw-signal-skeleton-line cw-signal-skeleton-line--wide" />
              <span className="cw-signal-skeleton-line" />
            </div>
          ) : (
            <>
              {fractalLoading && (
                <div className="cw-signal-loading">
                  <span className="cw-ai-spinner" />
                  <span>{tA("candleInsights.card.searching")}</span>
                </div>
              )}
              {!fractalLoading && isPaid && fractalAnalogs && fractalAnalogs.matches.length > 0 && (
                <>
                  <div className="cw-signal-card-value">
                    {tA("candleInsights.card.rose", { up: fractalAnalogs.upCount, total: fractalAnalogs.matches.length })}
                  </div>
                  <p className="cw-signal-card-note">
                    {tA("candleInsights.card.avgForward", { avg: `${fractalAnalogs.avgForwardReturn >= 0 ? "+" : ""}${fractalAnalogs.avgForwardReturn.toFixed(2)}%`, days: fractalAnalogs.forwardHorizon })}
                  </p>
                </>
              )}
              {!fractalLoading && (!isPaid || !fractalAnalogs || fractalAnalogs.matches.length === 0) && (
                <p className="cw-signal-card-note">{tA("candleInsights.card.noFractal")}</p>
              )}
            </>
          )}
        </div>

        <div className="cw-signal-card">
          <span className="cw-signal-card-label">{tA("candleInsights.card.sr")}</span>
          {loading ? (
            <div className="cw-signal-skeleton">
              <span className="cw-signal-skeleton-line cw-signal-skeleton-line--bar" />
              <span className="cw-signal-skeleton-line" />
            </div>
          ) : ind && ind.support[0] !== undefined && ind.resistance[0] !== undefined ? (() => {
            const sup = ind.support[0];
            const res = ind.resistance[0];
            const pct = heroPrice ? Math.min(100, Math.max(0, ((heroPrice - sup) / (res - sup)) * 100)) : 50;
            return (
              <>
                <div className="cw-signal-range">
                  <div className="cw-signal-range-track">
                    <div className="cw-signal-range-marker-wrap" style={{ left: `${pct}%` }}>
                      <span className="cw-signal-range-ping" />
                      <span className="cw-signal-range-marker" />
                    </div>
                  </div>
                </div>
                <div className="cw-signal-range-labels">
                  <span className="cw-signal-card-tag cw-signal-card-tag--up">${sup.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                  <span className="cw-signal-card-tag cw-signal-card-tag--down">${res.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                </div>
              </>
            );
          })() : (
            <p className="cw-signal-card-note">{tA("candleInsights.card.noLevels")}</p>
          )}
        </div>

        <div className="cw-signal-card">
          <span className="cw-signal-card-label">{tA("candleInsights.card.dailyClose")}</span>
          {loading ? (
            <div className="cw-signal-skeleton">
              <span className="cw-signal-skeleton-line cw-signal-skeleton-line--wide" />
              <span className="cw-signal-skeleton-line" />
            </div>
          ) : (
            <>
              <div className="cw-signal-card-value cw-signal-card-value--mono cw-signal-countdown">{dailyCountdown || "—"}</div>
              {ticker && (
                <p className="cw-signal-card-note">
                  H <strong className="cw-signal-card-tag--up">${ticker.high.toLocaleString("en-US", { maximumFractionDigits: 0 })}</strong>
                  {" · "}
                  L <strong className="cw-signal-card-tag--down">${ticker.low.toLocaleString("en-US", { maximumFractionDigits: 0 })}</strong>
                </p>
              )}
            </>
          )}
        </div>

        <div className="cw-signal-card">
          <span className="cw-signal-card-label">{tA("candleInsights.card.momentum")}</span>
          {loading ? (
            <div className="cw-signal-skeleton">
              <span className="cw-signal-skeleton-line cw-signal-skeleton-line--bar" />
              <span className="cw-signal-skeleton-line" />
            </div>
          ) : ind && ind.rsi !== null ? (
            <>
              <div className="cw-signal-card-main">
                <div className="cw-signal-bar-track">
                  <div className={`cw-signal-bar-fill cw-signal-bar-fill--${rsiStatus()}`} style={{ width: `${Math.min(100, Math.max(0, ind.rsi))}%` }} />
                </div>
                <span className="cw-signal-card-value">RSI {ind.rsi.toFixed(0)}</span>
              </div>
              {ind.volRatio !== null && (
                <p className="cw-signal-card-note">{tA("candleInsights.card.volume", { vol: ind.volRatio.toFixed(2) })}</p>
              )}
            </>
          ) : (
            <p className="cw-signal-card-note">{tA("candleInsights.card.noMomentum")}</p>
          )}
        </div>
      </div>
    </>
  );
  // Mobile "Show Tools" sheet row — same markup as the Trade page's.
  const cwToolRow = (label: string, sub: string | null, on: boolean, onClick: () => void, icon: React.ReactNode, key?: string) => (
    <button key={key} type="button" className="date-range-sheet-item cts-row" role="switch" aria-checked={on} onClick={onClick}>
      <span className="cts-row-icon">{icon}</span>
      <span className="cts-row-text">
        <span className="date-range-sheet-label">{label}</span>
        {sub && <span className="date-range-sheet-sub">{sub}</span>}
      </span>
      <span className={`cts-switch${on ? " cts-switch--on" : ""}`} aria-hidden="true"><i /></span>
    </button>
  );
  const Pill = cwDesktop ? IndicatorPill : IndicatorStat;
  const pillsEl = (
    <>
      {ind && (
        <div className={cwDesktop ? "cw-pills" : "chart-bar-stats cw-pills-stats"}>
          <Pill
            label="RSI"
            value={ind.rsi != null ? ind.rsi.toFixed(1) : "—"}
            status={rsiStatus()}
            meter={ind.rsi != null ? ind.rsi / 100 : undefined}
          />
          <Pill
            label="Stoch RSI"
            value={ind.stochK != null ? ind.stochK.toFixed(0) : "—"}
            status={ind.stochK == null ? "neutral"
              : ind.stochK >= 80 ? "warn"
              : ind.stochK <= 20 ? "bull"
              : ind.stochD != null && ind.stochK > ind.stochD ? "bull"
              : ind.stochD != null && ind.stochK < ind.stochD ? "bear" : "neutral"}
            meter={ind.stochK != null ? ind.stochK / 100 : undefined}
          />
          <Pill
            label="MACD"
            value={ind.macdHist != null ? (ind.macdHist > 0 ? "+" : "") + ind.macdHist.toFixed(3) : "—"}
            status={macdStatus()}
          />
          <Pill
            label="BB%"
            value={ind.bbPct != null ? (ind.bbPct * 100).toFixed(0) + "%" : "—"}
            status={bbStatus()}
            meter={ind.bbPct != null ? ind.bbPct : undefined}
          />
          <Pill
            label="VOL"
            value={ind.volRatio != null ? ind.volRatio.toFixed(2) + "×" : "—"}
            status={volStatus()}
            meter={ind.volRatio != null ? ind.volRatio / 3 : undefined}
          />
          <Pill
            label="EMA20"
            value={ind.ema20 != null && lastPrice != null
              ? lastPrice > ind.ema20 ? tA("candleInsights.pill.above") : tA("candleInsights.pill.below")
              : "—"}
            status={ind.ema20 != null && lastPrice != null ? (lastPrice > ind.ema20 ? "bull" : "bear") : "neutral"}
          />
          <Pill
            label="EMA50"
            value={ind.ema50 != null && lastPrice != null
              ? lastPrice > ind.ema50 ? tA("candleInsights.pill.above") : tA("candleInsights.pill.below")
              : "—"}
            status={ind.ema50 != null && lastPrice != null ? (lastPrice > ind.ema50 ? "bull" : "bear") : "neutral"}
          />
          <Pill
            label="ATR"
            value={ind.atr != null ? "$" + ind.atr.toFixed(0) : "—"}
            status="neutral"
          />
          {wyckoff && (
            <Pill
              label="Wyckoff"
              value={wyPhase(wyckoff.phase)}
              status={
                wyckoff.phase === "Accumulation" || wyckoff.phase === "Re-Accumulation" || wyckoff.phase === "Markup" ? "bull" :
                wyckoff.phase === "Distribution" || wyckoff.phase === "Markdown" ? "bear" : "neutral"
              }
            />
          )}
          {elliottResult && elliottResult.pattern !== "none" && (
            <Pill
              label="Elliott"
              value={`${elliottResult.pattern === "impulse" ? "W" : tA("candleInsights.pill.corr")} ${elliottResult.currentWave}`}
              status={elliottResult.direction === "bullish" ? "bull" : elliottResult.direction === "bearish" ? "bear" : "neutral"}
            />
          )}
        </div>
      )}
    </>
  );
  const liveTapeEl = (
    <>
      {feedCandles.length >= 3 && (
        <div className={`cw-feed${feedCollapsed ? " cw-feed--collapsed" : ""}`}>
          <button
            type="button"
            className="cw-feed-header"
            onClick={() => setFeedCollapsed(v => !v)}
            aria-expanded={!feedCollapsed}
            title={tA(feedCollapsed ? "candleInsights.tape.expandTitle" : "candleInsights.tape.collapseTitle")}
          >
            <span className="cw-feed-label">
              <span className="cw-feed-live-dot" />
              {tA("candleInsights.tab.tape")}
            </span>
            <div className="cw-feed-header-right">
              <span className="cw-feed-sub">{tA("candleInsights.tape.candles", { n: feedCandles.length })}</span>
              {candleCountdown && (
                <div className="cw-feed-candle-close">
                  <span className="cw-feed-candle-close-label">{tA("candleInsights.tape.closesIn")}</span>
                  <span className="cw-feed-candle-close-value">{candleCountdown}</span>
                </div>
              )}
              <span className="cw-feed-collapse-label">{tA(feedCollapsed ? "candleInsights.tape.expand" : "candleInsights.tape.collapse")}</span>
              <span className="cw-feed-collapse-tri" />
            </div>
          </button>
          {!feedCollapsed && (
            <div className="cw-tape">
              {[...feedCandles].reverse().map((c, i) => {
                const origIdx = feedCandles.length - 1 - i;
                return (
                  <CandleTapeRow
                    key={c.time}
                    candle={c}
                    prev1={feedCandles[Math.max(0, origIdx - 1)]}
                    prev2={feedCandles[Math.max(0, origIdx - 2)]}
                    isLast={origIdx === feedCandles.length - 1}
                    isNew={isNewRow(origIdx)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <BlurGate autoAuth requiredTier="pro" featureName={tA("candleInsights.title")} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} previewSrc="/previews/cw-preview.jpg" className="bg-root--top">
      <div className="cw-page">

        {/* ── AI Scan Overlay ── */}
        {aiLoading && (() => {
          const scanIct = aiScanIctRef.current;
          const scanInd = ind;
          const lastClose = candles[candles.length - 1]?.close ?? 0;
          const bsl = scanIct?.liquidityPools.filter(l => l.type === "buy") ?? [];
          const ssl = scanIct?.liquidityPools.filter(l => l.type === "sell") ?? [];
          type ScanRow = { label: string; value: string; color?: string };
          const sc = (k: string, o?: Record<string, unknown>) => tA(`candleInsights.scan.${k}`, o);
          const rows: ScanRow[] = [
            { label: "RSI (14)", value: scanInd?.rsi != null ? (scanInd.rsi >= 70 ? sc("rsiOverbought", { v: scanInd.rsi.toFixed(1) }) : scanInd.rsi <= 30 ? sc("rsiOversold", { v: scanInd.rsi.toFixed(1) }) : scanInd.rsi.toFixed(1)) : "—", color: scanInd?.rsi != null ? (scanInd.rsi >= 70 ? "#ef4444" : scanInd.rsi <= 30 ? "#22c55e" : "#818cf8") : undefined },
            { label: sc("macdHist"), value: scanInd?.macdHist != null ? `${scanInd.macdHist > 0 ? "+" : ""}${scanInd.macdHist.toFixed(4)}` : "—", color: scanInd?.macdHist != null ? (scanInd.macdHist > 0 ? "#22c55e" : "#ef4444") : undefined },
            { label: "Bollinger %", value: scanInd?.bbPct != null ? (scanInd.bbPct >= 0.8 ? sc("bbUpper", { v: (scanInd.bbPct * 100).toFixed(0) }) : scanInd.bbPct <= 0.2 ? sc("bbLower", { v: (scanInd.bbPct * 100).toFixed(0) }) : `${(scanInd.bbPct * 100).toFixed(0)}%`) : "—", color: scanInd?.bbPct != null ? (scanInd.bbPct >= 0.8 ? "#ef4444" : scanInd.bbPct <= 0.2 ? "#22c55e" : "#818cf8") : undefined },
            { label: sc("volRatio"), value: scanInd?.volRatio != null ? sc("volRatioVal", { v: scanInd.volRatio.toFixed(2) }) : "—", color: scanInd?.volRatio != null ? (scanInd.volRatio >= 1.5 ? "#818cf8" : "#6b7280") : undefined },
            { label: "EMA 20", value: scanInd?.ema20 != null ? sc(lastClose > scanInd.ema20 ? "priceAbove" : "priceBelow", { price: `$${scanInd.ema20.toFixed(2)}` }) : "—", color: scanInd?.ema20 != null ? (lastClose > scanInd.ema20 ? "#22c55e" : "#ef4444") : undefined },
            { label: "EMA 50", value: scanInd?.ema50 != null ? sc(lastClose > scanInd.ema50 ? "priceAbove" : "priceBelow", { price: `$${scanInd.ema50.toFixed(2)}` }) : "—", color: scanInd?.ema50 != null ? (lastClose > scanInd.ema50 ? "#22c55e" : "#ef4444") : undefined },
            { label: "ATR (14)", value: scanInd?.atr != null ? sc("atrVal", { price: `$${scanInd.atr.toFixed(2)}` }) : "—", color: "#f59e0b" },
            { label: tA("candleInsights.stat.elliott"), value: (() => { const ew = detectElliottWaves(candles); return ew.pattern !== "none" ? ewDescT(ew) : sc("noPattern"); })(), color: "#818cf8" },
            { label: sc("wyckoffPhase"), value: wyPhase(wyckoff?.phase ?? "Ranging"), color: "#38bdf8" },
            { label: sc("orderBlocks"), value: scanIct?.orderBlocks.length ? sc("detected", { n: scanIct.orderBlocks.length }) : sc("noneFound"), color: scanIct?.orderBlocks.length ? "#f59e0b" : undefined },
            { label: sc("fvgs"), value: scanIct?.fvgs.length ? sc("openGaps", { n: scanIct.fvgs.length }) : sc("noneOpen"), color: scanIct?.fvgs.length ? "#38bdf8" : undefined },
            { label: sc("structure"), value: scanIct?.structure.length ? scanIct.structure.slice(-3).map(s => `${s.kind.toUpperCase()} ${s.dir}`).join(" · ") : "—", color: "#a78bfa" },
            { label: sc("bsl"), value: bsl.length ? bsl.map(l => `$${l.price.toLocaleString(undefined, { maximumFractionDigits: 0 })} ×${l.count}`).join(" · ") : sc("noneDetected"), color: bsl.length ? "#4ade80" : undefined },
            { label: sc("ssl"), value: ssl.length ? ssl.map(l => `$${l.price.toLocaleString(undefined, { maximumFractionDigits: 0 })} ×${l.count}`).join(" · ") : sc("noneDetected"), color: ssl.length ? "#ef4444" : undefined },
            { label: sc("ote"), value: scanIct?.ote ? `$${scanIct.ote.bottom.toFixed(0)} – $${scanIct.ote.top.toFixed(0)} (0.618–0.705)` : sc("notIdentified"), color: scanIct?.ote ? "#818cf8" : undefined },
            { label: sc("pd"), value: scanIct?.pd ? sc(lastClose > scanIct.pd.mid ? "premium" : "discount", { price: `$${scanIct.pd.mid.toFixed(0)}` }) : "—", color: scanIct?.pd ? (lastClose > scanIct.pd.mid ? "#ef4444" : "#22c55e") : undefined },
            { label: sc("volProfile"), value: volumeProfile ? `POC $${volumeProfile.poc.toFixed(0)} · VA $${volumeProfile.val.toFixed(0)}–$${volumeProfile.vah.toFixed(0)}` : sc("calculating"), color: "#eab308" },
            { label: sc("sessionLevels"), value: sessionLevels ? sc("sessionVal", { high: `$${sessionLevels.mondayHigh.toFixed(0)}`, open: `$${sessionLevels.dailyOpen.toFixed(0)}` }) : sc("calculating"), color: "#f43f5e" },
          ];
          const active = ((scanStep % rows.length) + rows.length) % rows.length;
          const current = rows[active];
          return (
            <div className="cw-ai-overlay">
              <div className="cw-ai-overlay-card">
                <div className="cw-ai-overlay-ring-wrap">
                  <div className="cw-ai-overlay-ring" />
                  <span className="cw-ai-overlay-star">✦</span>
                </div>
                <div className="cw-ai-overlay-heading">{sc("analyzing", { pair: `${coin}/${interval.label}` })}</div>
                <div className="cw-ai-overlay-sub">{sc("processing", { n: rows.length })}</div>

                <div className="cw-ai-overlay-stage">
                  <div key={`${active}-label`} className="cw-ai-overlay-stage-label">{current.label}</div>
                  <div key={`${active}-value`} className="cw-ai-overlay-stage-value" style={current.color ? { color: current.color } : undefined}>{current.value}</div>
                </div>

                <div className="cw-ai-overlay-chips">
                  {rows.map((r, i) => (
                    <span key={r.label} className={`cw-ai-overlay-chip${i === active ? " cw-ai-overlay-chip--active" : i < active ? " cw-ai-overlay-chip--done" : ""}`}>{r.label}</span>
                  ))}
                </div>

                <div className="cw-ai-overlay-bar">
                  <div className="cw-ai-overlay-bar-fill" style={{ width: `${((active + 1) / rows.length) * 100}%` }} />
                </div>

                <button
                  className="cw-ai-overlay-close"
                  onClick={() => { aiCancelledRef.current = true; setAiLoading(false); }}
                  aria-label={sc("cancel")}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })()}

        {/* ── Monthly Fractal Detail Modal ── */}
        {expandedFractalIdx !== null && fractalAnalogs && fractalAnalogs.matches[expandedFractalIdx] && (() => {
          const fa = fractalAnalogs;
          const m = fa.matches[expandedFractalIdx];
          const fmtFull = (t: UTCTimestamp) => new Date(Number(t) * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
          const fr = (k: string, o?: Record<string, unknown>) => tA(`candleInsights.fractal.${k}`, o);
          const rangeTxt = fr("range", { from: fmtFull(m.startTime), to: fmtFull(m.time), win: fa.windowSize, fwd: fa.forwardHorizon, end: fmtFull(m.forwardEndTime) });

          const panMainChartTo = (match: FractalMatch) => {
            if (!chartRef.current) return;
            const span = fa.windowSize * 86_400;
            chartRef.current.timeScale().setVisibleRange({
              from: (Number(match.time) - span) as UTCTimestamp,
              to: (Number(match.time) + fa.forwardHorizon * 86_400) as UTCTimestamp,
            });
          };

          const W = 760, H = 320;
          const total = fa.windowSize + fa.forwardHorizon;
          const allVals = [...fa.currentPath, ...m.path];
          const minV = Math.min(...allVals), maxV = Math.max(...allVals);
          const pad = (maxV - minV) * 0.08 || 0.01;
          const yOf = (v: number) => H - ((v - (minV - pad)) / ((maxV + pad) - (minV - pad))) * H;
          const xOf = (i: number) => (i / (total - 1)) * W;
          const todayX = xOf(fa.windowSize - 1);

          const lineD = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`).join(" ");
          const areaD = (vals: number[]) => `${lineD(vals)} L${xOf(vals.length - 1).toFixed(2)},${H} L${xOf(0).toFixed(2)},${H} Z`;

          const nowD = lineD(fa.currentPath);
          const nowAreaD = areaD(fa.currentPath);
          const pastFullD = lineD(m.path);
          const pastPastD = lineD(m.path.slice(0, fa.windowSize));
          const pastAreaD = areaD(m.path.slice(0, fa.windowSize));

          const winPath = m.path.slice(0, fa.windowSize);
          const windowMove = winPath[winPath.length - 1] * 100;
          const { maxDrawdown: winDD, maxRally: winRally } = maxDrawdownRally(winPath);

          const fwd = m.forwardPath;
          let peakVal = fwd[0], peakDay = 0, troughVal = fwd[0], troughDay = 0;
          for (let d = 1; d < fwd.length; d++) {
            if (fwd[d] > peakVal) { peakVal = fwd[d]; peakDay = d; }
            if (fwd[d] < troughVal) { troughVal = fwd[d]; troughDay = d; }
          }
          const fmtDay = (offsetDays: number) => new Date((Number(m.time) + offsetDays * 86_400) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });

          // Redraws the chart straight from the same path data as the SVG
          // above (rather than rasterizing the live <svg> node) — avoids
          // cross-browser/WKWebView quirks with foreignObject-free SVG
          // rasterization, and keeps the exported image independent of
          // whatever the DOM happens to be doing at click time.
          const handleSaveChart = async () => {
            const scale = 2;
            const padX = 28, padTop = 86, axisH = 22, legendH = 48, bottomPad = 18;
            const totalW = W + padX * 2;
            const totalH = padTop + H + axisH + legendH + bottomPad;

            const canvas = document.createElement("canvas");
            canvas.width = totalW * scale;
            canvas.height = totalH * scale;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.scale(scale, scale);

            ctx.fillStyle = "#0b0f19";
            ctx.fillRect(0, 0, totalW, totalH);

            ctx.textBaseline = "alphabetic";
            ctx.textAlign = "left";
            ctx.fillStyle = "#e5e7eb";
            ctx.font = "bold 19px -apple-system, system-ui, sans-serif";
            ctx.fillText(fr("imgTitle", { coin }), padX, 32);
            ctx.fillStyle = "#a78bfa";
            ctx.font = "bold 12px -apple-system, system-ui, sans-serif";
            ctx.fillText(fr("match", { pct: m.similarity }), padX, 51);
            ctx.fillStyle = "#94a3b8";
            ctx.font = "12.5px -apple-system, system-ui, sans-serif";
            ctx.fillText(rangeTxt, padX, 70);

            ctx.save();
            ctx.translate(padX, padTop);

            ctx.strokeStyle = "rgba(255,255,255,0.18)";
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(todayX, 0);
            ctx.lineTo(todayX, H);
            ctx.stroke();
            ctx.setLineDash([]);

            const pathOf = (vals: number[]) => {
              ctx.beginPath();
              vals.forEach((v, i) => {
                const x = xOf(i), y = yOf(v);
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
              });
            };
            const drawArea = (vals: number[], top: string, bottom: string) => {
              pathOf(vals);
              ctx.lineTo(xOf(vals.length - 1), H);
              ctx.lineTo(xOf(0), H);
              ctx.closePath();
              const grad = ctx.createLinearGradient(0, 0, 0, H);
              grad.addColorStop(0, top);
              grad.addColorStop(1, bottom);
              ctx.fillStyle = grad;
              ctx.fill();
            };
            const drawLine = (vals: number[], color: string, width: number, opacity: number, dash?: number[]) => {
              pathOf(vals);
              ctx.strokeStyle = color;
              ctx.globalAlpha = opacity;
              ctx.lineWidth = width;
              ctx.lineCap = "round";
              ctx.lineJoin = "round";
              ctx.setLineDash(dash ?? []);
              ctx.stroke();
              ctx.globalAlpha = 1;
              ctx.setLineDash([]);
            };

            drawArea(m.path.slice(0, fa.windowSize), "rgba(249,115,22,0.22)", "rgba(249,115,22,0)");
            drawArea(fa.currentPath, "rgba(56,189,248,0.28)", "rgba(56,189,248,0)");
            drawLine(m.path, "#f97316", 2, 0.55, [6, 4]);
            drawLine(m.path.slice(0, fa.windowSize), "#f97316", 3, 1);
            drawLine(fa.currentPath, "#38bdf8", 3.5, 1);

            ctx.restore();

            ctx.font = "11px -apple-system, system-ui, sans-serif";
            ctx.fillStyle = "#64748b";
            ctx.textAlign = "left";
            ctx.fillText(fmtFull(m.startTime), padX, padTop + H + 16);
            ctx.textAlign = "center";
            ctx.fillStyle = "#94a3b8";
            ctx.fillText(fr("today", { date: fmtFull(m.time) }), padX + todayX, padTop + H + 16);
            ctx.textAlign = "right";
            ctx.fillStyle = "#64748b";
            ctx.fillText(fmtFull(m.forwardEndTime), padX + W, padTop + H + 16);
            ctx.textAlign = "left";

            const legendY1 = padTop + H + axisH + 14;
            ctx.fillStyle = "#38bdf8";
            ctx.beginPath(); ctx.arc(padX + 4, legendY1 - 4, 4, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#94a3b8";
            ctx.font = "12px -apple-system, system-ui, sans-serif";
            ctx.fillText(fr("legendNow", { from: fmtFull(fa.currentStart), to: fmtFull(fa.currentEnd) }), padX + 14, legendY1);

            const legendY2 = legendY1 + 20;
            ctx.fillStyle = "#f97316";
            ctx.beginPath(); ctx.arc(padX + 4, legendY2 - 4, 4, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#94a3b8";
            ctx.fillText(fr("legendFractalPct", { pct: m.similarity, from: fmtFull(m.startTime), to: fmtFull(m.forwardEndTime) }), padX + 14, legendY2);

            const dataUrl = canvas.toDataURL("image/png");
            const filename = `${coin}-monthly-fractal-${new Date(Number(m.time) * 1000).toISOString().slice(0, 10)}.png`;

            if (Capacitor.isNativePlatform()) {
              // Same reason as PriceChart's screenshot button: <a download>
              // is a no-op in a WKWebView, so write to the app's cache dir
              // and hand it to the native share sheet, where "Save Image"
              // drops it straight into Photos.
              try {
                const base64 = dataUrl.split(",")[1];
                const written = await Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Cache });
                await Share.share({ url: written.uri, dialogTitle: fr("saveDialog") });
              } catch (err) {
                console.error("Fractal chart save failed:", err);
              }
              return;
            }

            const link = document.createElement("a");
            link.href = dataUrl;
            link.download = filename;
            link.click();
          };

          // Collapsed (mobile/iOS peek) state renders as its own small fixed
          // bar, not the full backdrop with its class toggled — WKWebView has
          // a known repaint bug where a fixed, backdrop-filter:blur element
          // that flips to a transparent/no-blur state on the SAME layer can
          // get stuck painted solid instead of showing the page through it.
          // A fresh, separate element on each state never hits that path.
          if (!mobilePeekExpanded) {
            return (
              <div className="cw-fractal-peek-standalone">
                <button type="button" className="cw-fractal-peek-bar" onClick={() => setMobilePeekExpanded(true)}>
                  <span className="cw-fractal-peek-icon">◎</span>
                  <span className="cw-fractal-peek-text">
                    <span className="cw-fractal-peek-title">{fr("title")} · #{expandedFractalIdx + 1}</span>
                    <span className="cw-fractal-peek-sub">{fr("peekSub", { pct: m.similarity, ret: `${m.forwardReturn >= 0 ? "+" : ""}${m.forwardReturn.toFixed(1)}%`, days: fa.forwardHorizon })}</span>
                  </span>
                  <span className="cw-fractal-peek-chevron">⌃</span>
                </button>
              </div>
            );
          }

          return (
            <div
              className="cw-fractal-modal-backdrop"
              onMouseDown={(e) => { if (e.target === e.currentTarget) setExpandedFractalIdx(null); }}
            >
              <div className="cw-fractal-modal-card">
                <div className="cw-fractal-modal-full-content">
                <div className="cw-fractal-modal-header">
                  <span className="cw-fractal-modal-title"><span className="cw-fractal-modal-title-icon">◎</span> {fr("title")} <span className="cw-fractal-modal-title-sim">{fr("match", { pct: m.similarity })}</span></span>
                  <div className="cw-fractal-modal-header-actions">
                    <button className="cw-fractal-modal-collapse-btn" onClick={() => setMobilePeekExpanded(false)} aria-label={fr("collapseAria")} title={tA("candleInsights.tape.collapse")}>
                      <span className="cw-fractal-modal-collapse-tri" />
                    </button>
                    <button className="cw-fractal-modal-close" onClick={() => setExpandedFractalIdx(null)} aria-label={tA("candleInsights.close")}>✕</button>
                  </div>
                </div>
                <p className="cw-fractal-modal-range">
                  {rangeTxt}
                </p>

                <div className="cw-fractal-modal-chart-wrap">
                  <button className="cw-fractal-modal-save-btn" onClick={handleSaveChart} title={fr("saveTitle")}>
                    ⬇ {fr("save")}
                  </button>
                  <svg className="cw-fractal-modal-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="cwFractalNowFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.28" />
                        <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
                      </linearGradient>
                      <linearGradient id="cwFractalPastFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f97316" stopOpacity="0.22" />
                        <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <line x1={todayX} y1="0" x2={todayX} y2={H} className="cw-fractal-overlay-todayline" />
                    <path d={pastAreaD} fill="url(#cwFractalPastFill)" stroke="none" />
                    <path d={nowAreaD} fill="url(#cwFractalNowFill)" stroke="none" />
                    <path d={pastFullD} fill="none" stroke="#f97316" strokeWidth="2" strokeOpacity="0.55" strokeDasharray="6 4" strokeLinecap="round" />
                    <path d={pastPastD} fill="none" stroke="#f97316" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    <path d={nowD} fill="none" stroke="#38bdf8" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="cw-fractal-overlay-axis">
                  <span>{fmtFull(m.startTime)}</span>
                  <span className="cw-fractal-overlay-axis-today">{fr("today", { date: fmtFull(m.time) })}</span>
                  <span>{fmtFull(m.forwardEndTime)}</span>
                </div>
                <div className="cw-fractal-overlay-legend">
                  <span><span className="cw-fractal-overlay-dot" style={{ background: "#38bdf8" }} /> {fr("legendNow", { from: fmtFull(fa.currentStart), to: fmtFull(fa.currentEnd) })}</span>
                  <span><span className="cw-fractal-overlay-dot" style={{ background: "#f97316" }} /> {fr("legendFractal", { from: fmtFull(m.startTime), to: fmtFull(m.forwardEndTime) })}</span>
                </div>

                <div className="cw-fractal-rows">
                  <div className="cw-fractal-rows-heading">{fr("thisWindow", { n: fa.windowSize })}</div>
                  <div className="cw-fractal-row">
                    <span className="cw-fractal-row-label">{fr("windowMove")}</span>
                    <span className={`cw-fractal-row-val${windowMove >= 0 ? " up" : " down"}`}>{windowMove >= 0 ? "+" : ""}{windowMove.toFixed(2)}%</span>
                  </div>
                  <div className="cw-fractal-row">
                    <span className="cw-fractal-row-label">{fr("maxRally")}</span>
                    <span className="cw-fractal-row-val up">+{(winRally * 100).toFixed(2)}%</span>
                  </div>
                  <div className="cw-fractal-row cw-fractal-row--last">
                    <span className="cw-fractal-row-label">{fr("maxDrawdown")}</span>
                    <span className="cw-fractal-row-val down">{(winDD * 100).toFixed(2)}%</span>
                  </div>

                  <div className="cw-fractal-rows-heading">{fr("after", { n: fa.forwardHorizon })}</div>
                  <div className="cw-fractal-row">
                    <span className="cw-fractal-row-label">{fr("fwdMove")}</span>
                    <span className={`cw-fractal-row-val${m.forwardReturn >= 0 ? " up" : " down"}`}>{m.forwardReturn >= 0 ? "+" : ""}{m.forwardReturn.toFixed(2)}%</span>
                  </div>
                  <div className="cw-fractal-row">
                    <span className="cw-fractal-row-label">{fr("fwdPeak")}</span>
                    <span className="cw-fractal-row-val-wrap">
                      <span className="cw-fractal-row-val up">+{(peakVal * 100).toFixed(2)}%</span>
                      <span className="cw-fractal-row-sub">{fmtDay(peakDay)}</span>
                    </span>
                  </div>
                  <div className="cw-fractal-row cw-fractal-row--last">
                    <span className="cw-fractal-row-label">{fr("fwdTrough")}</span>
                    <span className="cw-fractal-row-val-wrap">
                      <span className="cw-fractal-row-val down">{(troughVal * 100).toFixed(2)}%</span>
                      <span className="cw-fractal-row-sub">{fmtDay(troughDay)}</span>
                    </span>
                  </div>
                </div>

                <div className="cw-fractal-modal-footer">
                  <p className="cw-elliott-hint">
                    {fr("footer")}
                  </p>
                  <button
                    type="button"
                    className="cw-fractal-modal-chart-btn"
                    onClick={() => { panMainChartTo(m); setExpandedFractalIdx(null); }}
                  >
                    {fr("viewOnChart")}
                  </button>
                </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Daily close banner ── */}
        {dailyCloseBanner && !dailyCloseBanner.dismissed && (() => {
          const b = dailyCloseBanner;
          const up = b.direction === "bullish";
          const fmt = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
          const rangePct = b.low > 0 ? ((b.high - b.low) / b.low) * 100 : 0;
          return (
            <div className={`cw-daily-banner cw-daily-banner--${b.direction}`}>
              <span className="cw-db-icon" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  {up ? <><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></> : <><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></>}
                </svg>
              </span>
              <div className="cw-db-main">
                <div className="cw-db-title">
                  <span className="cw-db-eyebrow">{tA("candleInsights.banner.dailyClose")}</span>
                  <span className="cw-db-dir">{tA(up ? "candleInsights.bias.bullish" : "candleInsights.bias.bearish")}</span>
                  <span className="cw-db-pct">{b.changePct >= 0 ? "+" : ""}{b.changePct.toFixed(2)}%</span>
                </div>
                <p className="cw-db-insight">{dailyCloseInsight(b.open, b.high, b.low, b.close, b.changePct)}</p>
              </div>
              <div className="cw-db-stats">
                <div className="cw-db-stat"><span>{tA("candleInsights.banner.open")}</span><strong>{fmt(b.open)}</strong></div>
                <div className="cw-db-stat"><span>{tA("candleInsights.banner.high")}</span><strong className="up">{fmt(b.high)}</strong></div>
                <div className="cw-db-stat"><span>{tA("candleInsights.banner.low")}</span><strong className="down">{fmt(b.low)}</strong></div>
                <div className="cw-db-stat"><span>{tA("candleInsights.banner.close")}</span><strong>{fmt(b.close)}</strong></div>
                <div className="cw-db-stat"><span>{tA("candleInsights.banner.range")}</span><strong>{rangePct.toFixed(2)}%</strong></div>
              </div>
              <button
                type="button"
                className="cw-db-close"
                aria-label={tA("candleInsights.banner.dismiss")}
                onClick={() => {
                  const todayStr = new Date().toISOString().slice(0, 10);
                  sessionStorage.setItem(`daily-banner-dismissed-${coin}`, todayStr);
                  setDailyCloseBanner(prev => prev ? { ...prev, dismissed: true } : null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          );
        })()}

        {/* Signal cards — a full-width, single-row briefing strip above the
            2-column chart/AI-panel grid below (not inside .cw-left, which
            is narrower than the full page once the sidebar grid column is
            back) — all reusing real state already computed elsewhere in
            this component (elliottResult, fractalAnalogs,
            ind.support/resistance/rsi/volRatio) rather than duplicating
            any of that logic. */}
        {/* Mobile: signal cards above the grid. Desktop: a right-panel tab. */}

        {/* ── Main grid ── */}
        <div
          className={`cw-grid${panelHidden ? " cw-grid--panel-collapsed" : ""}`}
          style={{ "--cw-sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
        >

          {/* Left: chart + indicators */}
          <div className="cw-left">
            {/* ── Header + interval pills: same row, two columns ── */}
            <div className="cw-left-top-row">
              <div className="cw-header">
                <div className="cw-header-left">
                  <div className="cw-id-row">
                    {!heroLogoError ? (
                      <img
                        className="cw-coin-icon"
                        src={`https://assets.coincap.io/assets/icons/${(coin as string).toLowerCase()}@2x.png`}
                        alt=""
                        loading="lazy"
                        onError={() => setHeroLogoError(true)}
                      />
                    ) : (
                      <span
                        className="cw-coin-icon cw-coin-icon--fallback"
                        style={{ background: COIN_COLORS[coin as string] ?? "var(--color-primary)" }}
                      >
                        {COIN_GLYPHS[coin as string] ?? (coin as string)[0]}
                      </span>
                    )}
                    <span className="cw-coin">{coin}/USD</span>
                  </div>
                  <div className="cw-price-row">
                    {heroPrice && (
                      <span className="cw-price">
                        ${heroPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    )}
                    {pctChange !== null && (
                      <span className={`cw-change ${pctChange >= 0 ? "cw-change--up" : "cw-change--down"}`}>
                        {pctChange >= 0 ? "▲" : "▼"} {Math.abs(pctChange).toFixed(2)}%
                        {absChange !== null && (
                          <span className="cw-change-abs">
                            (${Math.abs(absChange).toLocaleString("en-US", { maximumFractionDigits: 4 })})
                          </span>
                        )}
                      </span>
                    )}
                    <span className="cw-interval-pill">{interval.label.toUpperCase()}</span>
                  </div>
                </div>
              </div>

              <div className="cw-interval-tabs" ref={ivTrackRef}>
                {ivHighlight && (
                  <span
                    className="cw-iv-highlight"
                    style={{ transform: `translateX(${ivHighlight.left}px)`, width: ivHighlight.width }}
                  />
                )}
                {INTERVALS.map((iv, i) => (
                  <button
                    key={iv.label}
                    ref={(el) => { ivItemRefs.current[i] = el; }}
                    className={`cw-iv-tab${i === intervalIdx ? " cw-iv-tab--active" : ""}`}
                    onClick={() => setIntervalIdx(i)}
                  >
                    <span className="cw-iv-tab-label">{iv.label}</span>
                    {intervalCountdowns[i] && (
                      <span className="cw-iv-tab-countdown">{intervalCountdowns[i]}</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Desktop chart toolbar (TradingView-style): range, style,
                  grid, layers, drawing, price scale, save/reset/fullscreen. */}
              {cwDesktop && (
                <div className="cw-tb">
                  {/* Interval (the big pill track is hidden on desktop). */}
                  <div className="cw-tb-menu-wrap">
                    <button type="button" className={`cw-tb-btn cw-tb-txt cw-tb-iv${cwMenu === "interval" ? " cw-tb-btn--on" : ""}`} onClick={() => setCwMenu(cwMenu === "interval" ? null : "interval")} title={tTb("interval")}>
                      {INTERVALS[intervalIdx]?.label}
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                    </button>
                    {cwMenu === "interval" && cwMenuWrap(tTb("interval"), "cw-tb-menu", (<>
                        {INTERVALS.map((iv, i) => (
                          <button key={iv.label} type="button" className={`cw-tb-menu-item${i === intervalIdx ? " active" : ""}`} onClick={() => { setIntervalIdx(i); setCwMenu(null); }}>
                            <b className="cw-tb-iv-label">{iv.label}</b>
                            {intervalCountdowns[i] && <span className="cw-tb-iv-countdown">{tTb("closesIn", { time: intervalCountdowns[i] })}</span>}
                            {i === intervalIdx && <span className="cw-tb-check">✓</span>}
                          </button>
                        ))}
                      </>))}
                  </div>
                  <span className="cw-tb-sep" />
                  <div className="cw-tb-menu-wrap">
                    <button type="button" className={`cw-tb-btn${cwMenu === "range" ? " cw-tb-btn--on" : ""}`} onClick={() => setCwMenu(cwMenu === "range" ? null : "range")} title={tTb("dateRange")}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>
                      {cwRange && <span className="cw-tb-range-label">{cwRange.label}</span>}
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                    </button>
                    {cwMenu === "range" && cwMenuWrap(tTb("dateRange"), "cw-tb-menu", (<>
                        {([["1D", "1 day", 86400], ["1W", "1 week", 7 * 86400], ["1M", "1 month", 30 * 86400], ["3M", "3 months", 90 * 86400], ["1Y", "1 year", 365 * 86400], [null, "Default view", null]] as const).map(([short, l, secs]) => {
                          const fits = secs === null || cwRangeFits(secs, interval);
                          const on = secs === null ? !cwRange : cwRange?.secs === secs;
                          return (
                            <button
                              key={l}
                              type="button"
                              className={`cw-tb-menu-item${on ? " active" : ""}${fits ? "" : " cw-tb-menu-item--off"}`}
                              disabled={!fits}
                              title={fits ? undefined : tTb("tooMany", { iv: interval.label, range: rangeName(short) })}
                              onClick={() => { cwApplyRange(short ?? "", secs); setCwMenu(null); }}
                            >
                              {rangeName(short)}
                              {on && <span className="cw-tb-check">✓</span>}
                            </button>
                          );
                        })}
                      </>))}
                  </div>
                  <span className="cw-tb-sep" />
                  <div className="cw-tb-menu-wrap">
                    <button type="button" className={`cw-tb-btn${cwMenu === "style" ? " cw-tb-btn--on" : ""}`} onClick={() => setCwMenu(cwMenu === "style" ? null : "style")} title={tTb("chartStyle")}>
                      {cwPrefs.style === "line" ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /></svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="7" y1="3" x2="7" y2="8" /><rect x="4" y="8" width="6" height="8" fill={cwPrefs.style === "hollow" ? "none" : "currentColor"} /><line x1="7" y1="16" x2="7" y2="21" /><line x1="17" y1="5" x2="17" y2="10" /><rect x="14" y="10" width="6" height="6" fill={cwPrefs.style === "hollow" ? "none" : "currentColor"} /><line x1="17" y1="16" x2="17" y2="19" /></svg>
                      )}
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                    </button>
                    {cwMenu === "style" && cwMenuWrap(tTb("chartStyle"), "cw-tb-menu", (<>
                        {(["candle", "hollow", "line", "heikinAshi"] as const).map((k) => (
                          <button key={k} type="button" className={`cw-tb-menu-item${cwPrefs.style === k ? " active" : ""}`} onClick={() => { setCwPrefs((p) => ({ ...p, style: k })); setCwMenu(null); }}>
                            {tTb(`style.${k}`)}{cwPrefs.style === k && <span className="cw-tb-check">✓</span>}
                          </button>
                        ))}
                      </>))}
                  </div>
                  <button type="button" className={`cw-tb-btn${cwPrefs.grid ? " cw-tb-btn--on" : ""}`} onClick={() => setCwPrefs((p) => ({ ...p, grid: !p.grid }))} title={tTb("grid")} aria-pressed={cwPrefs.grid}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></svg>
                  </button>
                  <div className="cw-tb-menu-wrap">
                    <button type="button" className={`cw-tb-btn cw-tb-fx${cwMenu === "layers" ? " cw-tb-btn--on" : ""}`} onClick={() => setCwMenu(cwMenu === "layers" ? null : "layers")} title={tTb("layers")}>
                      <span>ƒx</span>
                    </button>
                    {cwMenu === "layers" && cwMenuWrap(tTb("layers"), "cw-tb-menu cw-tb-menu--layers", (<>
                        {([
                          ["ema", "#38bdf8"],
                          ["bb", "#6366f1"],
                          ["volume", "#94a3b8"],
                          ["ict", "#ef4444"],
                          ["retests", "#22c55e"],
                          ["patterns", "#f59e0b"],
                          ["divergence", "#a855f7"],
                        ] as const).map(([k, c]) => (
                          <button key={k} type="button" className={`cw-tb-menu-item cw-tb-layer${cwPrefs.layers[k] ? " active" : ""}`} onClick={() => setCwPrefs((p) => ({ ...p, layers: { ...p.layers, [k]: !p.layers[k] } }))}>
                            <span className="cw-tb-layer-dot" style={{ background: c }} />
                            {tTb(`layer.${k}`)}
                            <span className={`cw-tb-switch${cwPrefs.layers[k] ? " on" : ""}`}><i /></span>
                          </button>
                        ))}
                        <button type="button" className="cw-tb-menu-item cw-tb-menu-all" onClick={() => setCwMenu("indicators")}>
                          {libIndicators.length ? tTb("allIndicatorsOn", { n: libIndicators.length }) : tTb("allIndicators")} ›
                        </button>
                      </>))}
                  </div>
                  <button type="button" className={`cw-tb-btn${cwDrawOn ? " cw-tb-btn--on" : ""}`} onClick={() => setCwDrawOn((v) => !v)} title={tTb("drawing")} aria-pressed={cwDrawOn}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>
                  </button>
                  <span className="cw-tb-sep" />
                  <button type="button" className={`cw-tb-btn cw-tb-txt${cwPrefs.scale === "percent" ? " cw-tb-btn--on" : ""}`} onClick={() => setCwPrefs((p) => ({ ...p, scale: p.scale === "percent" ? "normal" : "percent" }))} title={tTb("percent")}>%</button>
                  <button type="button" className={`cw-tb-btn cw-tb-txt${cwPrefs.scale === "log" ? " cw-tb-btn--on" : ""}`} onClick={() => setCwPrefs((p) => ({ ...p, scale: p.scale === "log" ? "normal" : "log" }))} title={tTb("log")}>log</button>
                  <button type="button" className={`cw-tb-btn cw-tb-txt${cwPrefs.autoScale ? " cw-tb-btn--on" : ""}`} onClick={() => setCwPrefs((p) => ({ ...p, autoScale: !p.autoScale }))} title={tTb("autoFit")}>{tTb("auto")}</button>
                  <span className="cw-tb-sep" />
                  <button type="button" className={`cw-tb-btn${justSaved ? " cw-tb-btn--on" : ""}`} onClick={saveChart} title={tTb("savePng")}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                  </button>
                  <button type="button" className="cw-tb-btn" onClick={() => { chartRef.current?.timeScale().fitContent(); setCwPrefs((p) => ({ ...p, autoScale: true })); }} title={tTb("resetView")}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
                  </button>
                  <button type="button" className="cw-tb-btn" onClick={toggleChartFullscreen} title={tTb("fullscreen")}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
                  </button>
                </div>
              )}
              {cwDesktop && pillsEl}
              {/* Chevron, not an icon-button or switch — sits right after
                  the interval pills instead of floating alone in its own
                  row above the grid. Always rendered (unlike .cw-right,
                  which unmounts entirely when collapsed) since this is the
                  only way back in once it's hidden. Points away from the
                  panel it reveals/hides, same direction convention as a
                  splitter's own collapse arrow. */}
            </div>

            {/* 24h High/Low/Vol — real ticker data (App.tsx's coinTickers Map,
                fetchCoin24hTickers), not derived from candles like lastPrice
                above (that tracks whatever interval is selected, not a fixed
                24h window). Same data PriceChart.tsx's own chart-hero stat row
                shows. */}
            {ticker && (
              <div className="cw-ticker-stats">
                <span className="cw-ticker-stats-label">24H</span>
                <span className="cw-ticker-sep">|</span>
                <span className="cw-ticker-stat">
                  {tA("candleInsights.banner.high")} <strong className="cw-ticker-stat-up">${ticker.high.toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong>
                </span>
                <span className="cw-ticker-stat">
                  {tA("candleInsights.banner.low")} <strong className="cw-ticker-stat-down">${ticker.low.toLocaleString("en-US", { maximumFractionDigits: 2 })}</strong>
                </span>
                {ticker.quoteVolume !== undefined && (
                  <>
                    <span className="cw-ticker-sep">|</span>
                    <span className="cw-ticker-stat">
                      {tTb("vol24")} <strong>{ticker.quoteVolume >= 1e9 ? `$${(ticker.quoteVolume / 1e9).toFixed(2)}B` : `$${(ticker.quoteVolume / 1e6).toFixed(2)}M`}</strong>
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Mobile: same bars as the Trade page chart — interval
                toolbar (quick intervals · Show Tools · fullscreen) above,
                Date Range · clock · % log auto below. Indicator pills
                sit above the toolbar. */}
            {!cwDesktop && pillsEl}
            {!cwDesktop && (
              <div className="chart-bar-toolbar chart-bar-toolbar--actions cw-mbar">
                <div className="chart-quick-interval-pills">
                  {CW_QUICK_IVS.map((label) => {
                    const i = INTERVALS.findIndex((iv) => iv.label === label);
                    return (
                      <button key={label} type="button" className={`interval-pill${i === intervalIdx ? " interval-pill--active" : ""}`} onClick={() => setIntervalIdx(i)}>
                        {cwIvShort(label)}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={`interval-pill interval-pill--more${!CW_QUICK_IVS.includes(INTERVALS[intervalIdx]?.label) ? " interval-pill--active" : ""}`}
                    onClick={() => setCwMenu("interval")}
                    title={tTb("interval")}
                    aria-label={tTb("interval")}
                  >
                    {!CW_QUICK_IVS.includes(INTERVALS[intervalIdx]?.label) && <span className="cw-mbar-iv-cur">{cwIvShort(INTERVALS[intervalIdx]?.label ?? "")}</span>}
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                </div>
                <span className="chart-bar-toolbar-spacer" />
                <div className="chart-hero-icon-row">
                  <button type="button" className={`chart-depth-btn chart-show-tools-btn${cwMenu === "tools" ? " chart-depth-btn--active" : ""}`} onClick={() => setCwMenu("tools")}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="4" y1="6" x2="14" y2="6" /><circle cx="17" cy="6" r="2.5" /><line x1="20" y1="6" x2="20" y2="6" />
                      <line x1="10" y1="12" x2="20" y2="12" /><circle cx="7" cy="12" r="2.5" />
                      <line x1="4" y1="18" x2="13" y2="18" /><circle cx="16" cy="18" r="2.5" />
                    </svg>
                    <span className="chart-tool-label">{tTb("showTools")}</span>
                  </button>
                </div>
                <span className="chart-tool-pinned ctb-actions">
                  <button type="button" className="chart-depth-btn" onClick={() => { chartRef.current?.timeScale().fitContent(); setCwPrefs((p) => ({ ...p, autoScale: true })); }} title={tTb("resetView")} aria-label={tTb("resetView")}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
                    <span className="chart-tool-label">{tTb("reset")}</span>
                  </button>
                  <button type="button" className="chart-depth-btn ctb-full" onClick={toggleChartFullscreen} title={tTb("fullChart")} aria-label={tTb("fullChart")}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
                  </button>
                </span>
              </div>
            )}

            <div
              ref={chartDblClickWrapRef}
              className={`cw-chart-dblclick-wrap${isChartFullscreen ? " cw-chart-dblclick-wrap--fullscreen" : ""}`}
              onDoubleClickCapture={(e) => { e.stopPropagation(); toggleChartFullscreen(); }}
            >
            {isChartFullscreen && (
              <button
                type="button"
                className="cw-chart-fullscreen-exit"
                onClick={() => setIsChartFullscreen(false)}
                aria-label={tTb("closeFullscreen")}
                title={tTb("closeFullscreenEsc")}
              >
                {tA("candleInsights.close")}
              </button>
            )}
            <div className={`cw-chart-wrap${cwDrawOn ? " cw-chart-wrap--draw" : ""}`} ref={chartContainerRef}>
              {/* Desktop: coin / OHLC / sell–buy overlay on the chart itself
                  (same design as the Trade page's full chart), replacing
                  the header block above it. */}
              {candles.length > 0 && heroPrice != null && (() => {
                const last = candles[candles.length - 1];
                const up = (absChange ?? 0) >= 0;
                const fmt = (v: number) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 6 : 2 });
                const name = COINS.find((c) => c.symbol === coin)?.name ?? coin;
                return (
                  <div className="chart-tv-ohlc-overlay cw-ohlc-overlay">
                    <div className="chart-tv-ohlc-row">
                      {/* Coin icon + title: tap to switch coin. */}
                      <span
                        className="chart-tv-ohlc-pick chart-coin-pick"
                        role="button"
                        tabIndex={0}
                        aria-label={tTb("switchCoin")}
                        onClick={(e) => onOpenCoinPicker?.(e.currentTarget)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenCoinPicker?.(e.currentTarget); } }}
                      >
                        <span className="chart-tv-ohlc-icon" style={{ background: COIN_COLORS[coin as string] ?? "var(--color-primary)" }}>
                          {COIN_GLYPHS[coin as string] ?? (coin as string)[0]}
                        </span>
                        <span className="chart-tv-ohlc-title">
                          {tTb("ohlcTitle", { name, iv: interval.label.toUpperCase() })}
                        </span>
                        <span className="chart-coin-pick-chev" aria-hidden="true">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                        </span>
                      </span>
                      <span className={`chart-tv-ohlc-dot${up ? " up" : " down"}`} />
                      <span className="chart-tv-ohlc-values">
                        O<b>{fmt(last.open)}</b>{" "}
                        H<b>{fmt(last.high)}</b>{" "}
                        L<b>{fmt(last.low)}</b>{" "}
                        <span className={up ? "chart-tv-ohlc-up" : "chart-tv-ohlc-down"}>
                          C<b>{fmt(heroPrice)}</b>{" "}
                          {absChange !== null && pctChange !== null && (
                            <>{up ? "+" : ""}{absChange.toFixed(2)} ({up ? "+" : ""}{pctChange.toFixed(2)}%)</>
                          )}
                        </span>
                      </span>
                    </div>
                    <div className="chart-tv-ticket-row">
                      <button type="button" className="chart-tv-sell-box" onClick={() => document.querySelector<HTMLButtonElement>(".ta-trigger")?.click()}>
                        <span className="chart-tv-ticket-price">{fmt(heroPrice)}</span>
                        <span className="chart-tv-ticket-label">{tTb("sell")}</span>
                      </button>
                      <span className="chart-tv-ticket-mid">0.00</span>
                      <button type="button" className="chart-tv-buy-box" onClick={() => document.querySelector<HTMLButtonElement>(".ta-trigger")?.click()}>
                        <span className="chart-tv-ticket-price">{fmt(heroPrice)}</span>
                        <span className="chart-tv-ticket-label">{tTb("buy")}</span>
                      </button>
                    </div>
                  </div>
                );
              })()}
              <RoundedCandleOverlay
                chartRef={chartRef}
                seriesRef={candleSeriesRef}
                candlesRef={candlesRef}
                upColor="#22c55e"
                downColor="#ef4444"
                style={cwPrefs.style === "hollow" ? "hollow" : cwPrefs.style === "heikinAshi" ? "heikinAshi" : "candle"}
                generation={chartGeneration}
                visible={cwPrefs.style !== "line"}
              />
              <PatternHighlight
                chartRef={chartRef}
                seriesRef={candleSeriesRef}
                candlesRef={candlesRef as React.MutableRefObject<any[]>}
                times={patternFocus ? patternTimes : null}
                name={patternScan ? patName(patternScan.pattern.name) : ""}
                type={patternScan?.pattern.type ?? "neutral"}
                desc={patternScan ? patDesc(patternScan.pattern) : ""}
                onClose={() => setPatternFocus(false)}
              />
              <ChartPatternOverlay
                chartRef={chartRef}
                seriesRef={candleSeriesRef}
                pattern={chartPatternFocus ? chartPattern : null}
                onClose={() => setChartPatternFocus(false)}
              />
              {/* Drawing tools (same rail as the Trade chart), desktop. */}
              <ChartDrawingTools
                chartRef={chartRef}
                seriesRef={candleSeriesRef}
                containerRef={chartContainerRef}
                candlesRef={candlesRef}
                visible={cwDrawOn && !isChartFullscreen}
                persistRef={cwDrawingsRef}
                topOffset={cwDesktop ? 98 : 86}
                contained
              />
              <RoundedCandleOverlay
                chartRef={chartRef}
                seriesRef={forecastSeriesRef}
                candlesRef={forecastCandlesRef}
                upColor={forecastColors.up}
                downColor={forecastColors.down}
                style="candle"
                generation={chartGeneration}
                visible={showForecast}
              />
              {loading && !loadError && <div className="cw-chart-loader">{tTb("loading")}</div>}
              {loadError && (
                <div className="cw-chart-error">
                  <span className="cw-chart-error-icon">⚠</span>
                  <span>{tTb("loadFailed")}</span>
                  <button className="cw-chart-retry-btn" onClick={() => setRetryKey(k => k + 1)}>
                    {tTb("retry")}
                  </button>
                </div>
              )}
              {/* Forecast badge hidden: it overlapped the coin name overlay
                  at the top-left. The forecast candles still draw. */}
              {SHOW_FORECAST_BADGE && showForecast && aiRead && (
                <div className={`cw-forecast-badge${aiRead.bias === "bearish" ? " cw-forecast-badge--bear" : ""}`}>
                  <span className="cw-forecast-badge-dot" />
                  {(() => {
                    const a = Math.abs(forecastConviction);
                    const label = a > 0.65 ? "STRONG" : a > 0.35 ? "MODERATE" : "WEAK";
                    return `FORECAST · ${aiRead.bias.toUpperCase()} · ${label}`;
                  })()}
                </div>
              )}
              <button
                className={`cw-save-btn${justSaved ? " cw-save-btn--saved" : ""}`}
                onClick={saveChart}
                title={tTb("savePng")}
              >
                {justSaved ? `✓ ${tTb("saved")}` : `↓ ${tA("candleInsights.fractal.save")}`}
              </button>
              <button
                className="cw-reset-view-btn"
                onClick={() => {
                  chartRef.current?.timeScale().fitContent();
                  chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
                }}
                title={tTb("resetView")}
              >
                {tTb("reset")}
              </button>
              {patternTooltip && (
                patternTooltip.title
                  ? (
                    <div
                      className={`cw-ict-tooltip cw-ict-tooltip--${patternTooltip.type}`}
                      style={{ left: patternTooltip.x + 14, top: patternTooltip.y - 20 }}
                    >
                      <div className="cw-ict-tooltip-title">{patternTooltip.title}</div>
                      <div className="cw-ict-tooltip-desc">{patternTooltip.comment}</div>
                    </div>
                  ) : (
                    <div
                      className={`cw-pattern-tooltip cw-pattern-tooltip--${patternTooltip.type}`}
                      style={{ left: patternTooltip.x + 12, top: patternTooltip.y - 16 }}
                    >
                      {patternTooltip.comment}
                    </div>
                  )
              )}
            </div>
            </div>

            {!cwDesktop && (
              <div className="chart-range-bar chart-range-bar--mobile cw-mrange">
                <button type="button" className="chart-range-select" onClick={() => setCwMenu("range")}>
                  <span>{cwRange ? (CW_RANGES.some((r) => r[0] === cwRange.label) ? rangeName(cwRange.label) : cwRange.label) : tTb("dateRangeBtn")}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                <span className="chart-range-spacer" />
                <RangeBarClock />
                <span className="chart-range-divider" />
                <button type="button" className={`chart-range-btn chart-range-btn--scale${cwPrefs.scale === "percent" ? " active" : ""}`} aria-pressed={cwPrefs.scale === "percent"} onClick={() => setCwPrefs((p) => ({ ...p, scale: p.scale === "percent" ? "normal" : "percent" }))}>%</button>
                <button type="button" className={`chart-range-btn chart-range-btn--scale${cwPrefs.scale === "log" ? " active" : ""}`} aria-pressed={cwPrefs.scale === "log"} onClick={() => setCwPrefs((p) => ({ ...p, scale: p.scale === "log" ? "normal" : "log" }))}>log</button>
                <button type="button" className={`chart-range-btn chart-range-btn--scale${cwPrefs.autoScale ? " active" : ""}`} aria-pressed={cwPrefs.autoScale} onClick={() => setCwPrefs((p) => ({ ...p, autoScale: !p.autoScale }))}>{tTb("auto")}</button>
              </div>
            )}
            {!cwDesktop && cwMenu === "interval" && (
              <BottomSheet open onClose={() => setCwMenu(null)} title={<>{tTb("interval")}</>} className="cw-tb-sheet" ariaLabel={tTb("interval")}>
                <div className="interval-sheet-list cw-tb-sheet-list">
                  {INTERVALS.map((iv, i) => (
                    <button key={iv.label} type="button" className={`cw-tb-menu-item${i === intervalIdx ? " active" : ""}`} onClick={() => { setIntervalIdx(i); setCwMenu(null); }}>
                      <b className="cw-tb-iv-label">{iv.label}</b>
                      {intervalCountdowns[i] && <span className="cw-tb-iv-countdown">{tTb("closesIn", { time: intervalCountdowns[i] })}</span>}
                      {i === intervalIdx && <span className="cw-tb-check">✓</span>}
                    </button>
                  ))}
                </div>
              </BottomSheet>
            )}
            {!cwDesktop && cwMenu === "range" && (
              <BottomSheet open onClose={() => setCwMenu(null)} title={<>{tTb("dateRange")}</>} className="cw-tb-sheet" ariaLabel={tTb("dateRange")}>
                <div className="date-range-sheet-list">
                  {CW_RANGES.map(([short, l, secs]) => {
                    const fits = secs === null || cwRangeFits(secs, interval);
                    const on = secs === null ? !cwRange : cwRange?.secs === secs;
                    return (
                      <button
                        key={l}
                        type="button"
                        className={`date-range-sheet-item${on ? " active" : ""}${fits ? "" : " cw-tb-menu-item--off"}`}
                        disabled={!fits}
                        onClick={() => { cwApplyRange(short ?? "", secs); setCwMenu(null); }}
                      >
                        <span className="date-range-sheet-label">{rangeName(short)}</span>
                        <span className="date-range-sheet-sub">{fits ? (secs === null ? tTb("latestAutoFit") : tTb("rangeOf", { range: rangeName(short), iv: interval.label })) : tTb("tooManyShort", { iv: interval.label })}</span>
                        {on && <span className="chart-style-check">✓</span>}
                      </button>
                    );
                  })}
                </div>
              </BottomSheet>
            )}
            <IndicatorPicker
              open={cwMenu === "indicators"}
              onClose={() => setCwMenu(null)}
              enabled={libIndicators}
              onToggle={toggleLibIndicator}
              isPaid={isPaid}
              onUpgrade={() => { setCwMenu(null); onOpenUpgrade(); }}
              builtIn={CW_LAYERS.map(([k, , c]): PickerItem => ({
                id: `cw-${k}`,
                name: tTb(`layer.${k}`),
                category: k === "ema" ? "Moving Averages" : k === "bb" ? "Volatility" : k === "volume" ? "Volume" : "Smart Money",
                description: tTb(`layerDesc.${k}`),
                checked: cwPrefs.layers[k],
                onToggle: () => setCwPrefs((p) => ({ ...p, layers: { ...p.layers, [k]: !p.layers[k] } })),
                color: c,
              }))}
            />
            {!cwDesktop && cwMenu === "tools" && (
              <BottomSheet open onClose={() => setCwMenu(null)} title={<>{tTb("chartTools")}</>} className="cw-tb-sheet cts-sheet" ariaLabel={tTb("chartTools")}>
                <div className="interval-sheet-list date-range-sheet-list">
                  <div className="cts-section-label">{tTb("chartStyle")}</div>
                  <div className="cts-styles">
                    {([["candle", tTb("style.candle")], ["hollow", tTb("style.hollowShort")], ["line", tTb("style.line")], ["heikinAshi", tTb("style.heikinAshi")]] as const).map(([k, l]) => (
                      <button key={k} type="button" className={`cts-style${cwPrefs.style === k ? " active" : ""}`} onClick={() => setCwPrefs((p) => ({ ...p, style: k }))}>
                        {k === "line" ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="7" y1="3" x2="7" y2="8" /><rect x="4" y="8" width="6" height="8" fill={k === "hollow" ? "none" : "currentColor"} /><line x1="7" y1="16" x2="7" y2="21" /><line x1="17" y1="5" x2="17" y2="10" /><rect x="14" y="10" width="6" height="6" fill={k === "hollow" ? "none" : "currentColor"} /><line x1="17" y1="16" x2="17" y2="19" /></svg>
                        )}
                        <span>{l}</span>
                      </button>
                    ))}
                  </div>
                  {cwToolRow(tTb("grid"), tTb("gridSub"), cwPrefs.grid, () => setCwPrefs((p) => ({ ...p, grid: !p.grid })),
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="1" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></svg>)}
                  {cwToolRow(tTb("drawing"), tTb("drawingSub"), cwDrawOn, () => { setCwDrawOn((v) => !v); setCwMenu(null); },
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /><path d="M2 2l7.586 7.586" /><circle cx="11" cy="11" r="2" /></svg>)}
                  <button type="button" className="date-range-sheet-item cts-row" onClick={() => setCwMenu("indicators")}>
                    <span className="cts-row-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></svg></span>
                    <span className="cts-row-text">
                      <span className="date-range-sheet-label">{tTb("indicators")}</span>
                      <span className="date-range-sheet-sub">{(() => { const on = [...CW_LAYERS.filter(([k]) => cwPrefs.layers[k]).map(([k]) => tTb(`layer.${k}`)), ...libIndicators.map((id) => getIndicatorDef(id)?.name ?? id)]; return on.length ? tTb("nOn", { n: on.length, list: `${on.slice(0, 2).join(", ")}${on.length > 2 ? "…" : ""}` }) : tTb("noneOn"); })()}</span>
                    </span>
                    <span className="cts-row-chev">›</span>
                  </button>
                  <div className="cts-section-label">{tTb("chart")}</div>
                  <button type="button" className="date-range-sheet-item cts-row" onClick={() => { saveChart(); setCwMenu(null); }}>
                    <span className="cts-row-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg></span>
                    <span className="cts-row-text"><span className="date-range-sheet-label">{tTb("saveImage")}</span><span className="date-range-sheet-sub">{tTb("saveImageSub")}</span></span>
                  </button>
                </div>
              </BottomSheet>
            )}

            {/* Mobile: live tape under the chart. Desktop: a right-panel tab. */}
          </div>

          {/* Fully hidden when collapsed — the header's toggle button
              (cw-panel-toggle-btn) is the only way back in, since nothing
              of the panel remains in the grid to click. */}
          {/* Desktop, panel hidden: slim icon rail — click an icon to reopen
              straight on that tab. */}
          {panelHidden && (
            <div className="cw-rail" role="toolbar" aria-label={tTb("openPanel")}>
              {cwPanelTabs.map((tb) => (
                <button
                  key={tb.key}
                  type="button"
                  className={`cw-rail-btn${tb.active ? " cw-rail-btn--active" : ""}`}
                  onClick={() => {
                    switchRightTab(tb.key === "read" ? lastAiTabRef.current : tb.key);
                    setRightPanelCollapsed(false);
                  }}
                  title={tb.label}
                  aria-label={tb.label}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{tb.icon}</svg>
                  <span className="cw-rail-label">{tb.label}</span>
                </button>
              ))}
            </div>
          )}
          {!panelHidden && (
            <>
          {/* Drag handle to resize the sidebar */}
          <div
            className="cw-resize-handle"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
            title={tTb("dragResize")}
          >
            <span className="cw-resize-handle-grip" />
          </div>

          {/* Right: AI analysis */}
          <div className="cw-right">
          <div className={`cw-right-panel${aiGroup && !aiRead && !aiLoading ? " cw-right-panel--ai-hero" : ""}`}>
            <div className="cw-right-tabs">
                <>
                  {cwPanelTabs.map((tb) => (
                    <button
                      key={tb.key}
                      className={`cw-right-tab${tb.active ? " cw-right-tab--active" : ""}`}
                      onClick={() => {
                        // Clicking the open tab hides the panel (to the icon rail).
                        if (tb.active) { if (cwDesktop) setRightPanelCollapsed(true); return; }
                        // AI keeps whichever of Read/Plan/Narration was last open.
                        switchRightTab(tb.key === "read" ? lastAiTabRef.current : tb.key);
                      }}
                      title={tb.active && cwDesktop ? tA("candleInsights.tb.hidePanel") : tb.label}
                    >
                      <span className="cw-right-tab-icon">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{tb.icon}</svg>
                      </span>
                      <span>{tb.label}</span>
                    </button>
                  ))}
                </>
            </div>

            <div className="cw-right-panel-body" ref={panelBodyRef}>
            {rightTab === "signals" && <div className="cw-panel-signals">{signalCardsEl}</div>}
            {rightTab === "tape" && <div className="cw-panel-tape">{liveTapeEl}</div>}

            {rightTab === "wave" && (
              <>
            {/* ── Volume Profile / Session Levels toggles — off by default ── */}
            <div className="cw-ai-card cw-overlay-toggles-card">
              <div className="cw-ai-header">
                <span className="cw-ai-badge cw-ew-badge">▤ {tC("wave.overlays")}</span>
              </div>
              <button
                className={`cw-elliott-btn${showVolProfile ? " cw-elliott-btn--active" : ""}`}
                onClick={toggleVolProfile}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18M7 16v3M11 10v9M15 13v6M19 7v12" /></svg>
                {showVolProfile ? `✕ ${tC("wave.hideVp")}` : tC("wave.showVp")}
              </button>
              <button
                className={`cw-elliott-btn${showSessionLevels ? " cw-elliott-btn--active" : ""}`}
                onClick={toggleSessionLevels}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
                {showSessionLevels ? `✕ ${tC("wave.hideSession")}` : tC("wave.showSession")}
              </button>
            </div>

            {/* ── Elliott Wave card ── */}
            {elliottResult && (() => {
              const hasPattern = elliottResult.pattern !== "none";
              return (
                <div className="cw-ai-card cw-ew-card">
                  <div className="cw-ai-header">
                    <span className="cw-ai-badge cw-ew-badge">〜 {tC("stat.elliott")}</span>
                    {hasPattern && (
                      <span className={`cw-elliott-btn-badge`}>{elliottResult.name ? `${ewNameT(elliottResult.name)} · ` : ""}{tC("card.wave", { wave: elliottResult.currentWave })}</span>
                    )}
                  </div>
                  <button
                    className={`cw-elliott-btn${showElliott && hasPattern ? " cw-elliott-btn--active" : ""}${!hasPattern ? " cw-elliott-btn--unavailable" : ""}`}
                    onClick={hasPattern ? toggleElliott : undefined}
                    title={!hasPattern ? tC("wave.noPatternTip") : undefined}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 17 8 11 13 16 22 7"/></svg>
                    {showElliott && hasPattern ? `✕ ${tC("wave.hideEw")}` : tC("wave.showOnChart")}
                    {!hasPattern && <span className="cw-elliott-btn-badge cw-elliott-btn-badge--none">{tC("wave.noPattern")}</span>}
                  </button>
                  <p className="cw-elliott-hint">
                    {tC("wave.bestOnPre")}<strong>{tC("wave.bestOnTfs")}</strong>{tC("wave.bestOnPost")}
                  </p>

              {/* ── Elliott Wave Analysis Narrative ── */}
              {elliottResult && elliottResult.pattern !== "none" && (() => {
                const ew = elliottResult;
                const fmt = (p: number) => "$" + p.toLocaleString(undefined, { maximumFractionDigits: 0 });
                // Plain-language rows + "what's happening" / "what's next".
                const { rows: waveRows, what: situation, next: outlook } = ewKidStory(ew);

                return (
                  <div className="cw-ew-analysis">
                    <div className="cw-ew-analysis-header">
                      {tC("wave.analysis")}
                      {/* The NEXT move the text describes (not the past
                          trend) — a finished 5 waves down expects a move up. */}
                      {(() => {
                        const nextUp = ewNextUp(ew);
                        return (
                          <span className={`cw-ew-dir cw-ew-dir--${nextUp ? "bullish" : "bearish"}`}>
                            {nextUp ? "▲" : "▼"} {tC("wave.next", { label: ewNextLabel(ew) }).toLocaleUpperCase(i18next.language)}
                          </span>
                        );
                      })()}
                    </div>

                    {/* Wave history */}
                    <div className="cw-ew-waves">
                      {waveRows.map(r => (
                        <div key={r.label} className="cw-ew-wave-row">
                          <span className="cw-ew-wave-lbl">{r.label}</span>
                          <span className="cw-ew-wave-desc">{r.desc}</span>
                          <span className={`cw-ew-wave-pct cw-ew-wave-pct--${r.up ? "up" : "down"}`}>{r.up ? "▲" : "▼"} {r.pct}</span>
                          <span className="cw-ew-wave-price">{fmt(r.price)}</span>
                        </div>
                      ))}
                    </div>

                    {/* Current situation */}
                    {situation && <p className="cw-ew-situation">{situation}</p>}

                    {/* Outlook + targets */}
                    {outlook && (
                      <div className="cw-ew-outlook">
                        <div className="cw-ew-outlook-title">↳ {tC("wave.whatNext")}</div>
                        <p className="cw-ew-outlook-text">{outlook}</p>
                        {ew.projections.length > 0 && (
                          <div className="cw-ew-targets">
                            {ew.projections.map(p => (
                              <div key={p.label} className={`cw-ew-target-row${p.isMain ? " cw-ew-target-row--main" : ""}`}>
                                <span className="cw-ew-target-lbl">{ewTargetName(p.label)}</span>
                                <span className="cw-ew-target-price" style={{ color: p.color }}>{fmt(p.price)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ── MTF Alignment ── */}
              {mtfBiases.length > 0 && (() => {
                const mtf = getMTFSummary(mtfBiases);
                return (
                  <div className="cw-mtf-panel">
                    <div className="cw-mtf-header">
                      <span className="cw-mtf-label">{tC("wave.tfAlign")}</span>
                      <span className={`cw-mtf-direction cw-mtf-direction--${mtf.direction}`}>
                        {mtf.direction === "long" ? `▲ ${tC("wave.longBias")}` : mtf.direction === "short" ? `▼ ${tC("wave.shortBias")}` : `◆ ${tC("wave.wait")}`}
                      </span>
                    </div>
                    <div className="cw-mtf-chips">
                      {mtfBiases.map(b => (
                        <div key={b.label} className={`cw-mtf-chip cw-mtf-chip--${b.bias}`}>
                          <span className="cw-mtf-chip-tf">{b.label}</span>
                          <span className="cw-mtf-chip-arrow">{b.bias === "bullish" ? "↑" : b.bias === "bearish" ? "↓" : "→"}</span>
                        </div>
                      ))}
                    </div>
                    <p className="cw-mtf-explanation">{mtf.explanation}</p>
                  </div>
                );
              })()}

              {/* ── Weekly TEMA Cycle ── */}
              {weeklyCycle && (() => {
                const { candles: wc, tema14, tema21 } = weeklyCycle;
                const warmup = 63;
                const startIdx = Math.max(warmup, wc.length - 420);
                const slice = wc.slice(startIdx);
                const t14 = tema14.slice(startIdx);
                const t21 = tema21.slice(startIdx);
                const sN = slice.length;
                const closes = slice.map(c => c.close);

                const W = 400, H = 96;
                const logVals = [...closes, ...t14, ...t21].map(Math.log);
                const logMin = Math.min(...logVals) - 0.05;
                const logMax = Math.max(...logVals) + 0.05;
                const xOf = (i: number) => ((i / (sN - 1)) * W).toFixed(2);
                const yOf = (p: number) => (H - ((Math.log(p) - logMin) / (logMax - logMin)) * H).toFixed(2);

                const priceD  = slice.map((c, i) => `${i===0?'M':'L'}${xOf(i)},${yOf(c.close)}`).join(' ');
                const t14D    = t14.map((t, i)   => `${i===0?'M':'L'}${xOf(i)},${yOf(t)}`).join(' ');
                const t21D    = t21.map((t, i)   => `${i===0?'M':'L'}${xOf(i)},${yOf(t)}`).join(' ');

                // Orange zones: ≥3 consecutive weeks where close < TEMA-14
                const zones: { x1: string; x2: string }[] = [];
                let zs: number | null = null;
                for (let i = 0; i < sN; i++) {
                  const below = closes[i] < t14[i];
                  if (below && zs === null) zs = i;
                  if (!below && zs !== null) {
                    if (i - zs >= 3) zones.push({ x1: xOf(zs), x2: xOf(i) });
                    zs = null;
                  }
                }
                if (zs !== null && sN - zs >= 3) zones.push({ x1: xOf(zs), x2: xOf(sN - 1) });

                // Cycle phase
                const lastClose = closes[sN - 1];
                const lt14 = t14[sN - 1];
                const lt21 = t21[sN - 1];
                const pctFromT14 = ((lastClose / lt14) - 1) * 100;
                const aboveT14 = lastClose >= lt14;
                const phase = aboveT14
                  ? (lt14 >= lt21 ? "Bull Run" : "Recovery")
                  : (lt14 >= lt21 ? "Mid-Cycle Correction" : "Bear Market");
                const phaseColor = aboveT14 ? "#22c55e" : lt14 >= lt21 ? "#f97316" : "#ef4444";

                return (
                  <div
                    className={`cw-cycle-panel${cycleExpanded ? " cw-cycle-panel--expanded" : ""}`}
                    onDoubleClick={() => setCycleExpanded(v => !v)}
                    title={tC("cycle.dblClick")}
                  >
                    <div className="cw-cycle-header">
                      <span className="cw-cycle-title">{tC("cycle.title")}</span>
                      <span className="cw-cycle-phase" style={{ color: phaseColor }}>
                        {tC(`cycle.phase.${tKey(phase)}`)}
                      </span>
                    </div>
                    <svg
                      className="cw-cycle-chart"
                      viewBox={`0 0 ${W} ${H}`}
                      preserveAspectRatio="none"
                    >
                      {zones.map((z, i) => (
                        <rect key={i} x={z.x1} y="0"
                          width={(parseFloat(z.x2) - parseFloat(z.x1)).toFixed(2)}
                          height={H} fill="rgba(249,115,22,0.18)" />
                      ))}
                      <path d={priceD} fill="none" stroke="rgba(148,163,184,0.45)" strokeWidth="1" />
                      <path d={t21D}  fill="none" stroke="#818cf8" strokeWidth="1.5" />
                      <path d={t14D}  fill="none" stroke="#34d399" strokeWidth="1.5" />
                      {/* Current price dot */}
                      <circle
                        cx={xOf(sN - 1)} cy={yOf(lastClose)} r="2.5"
                        fill={phaseColor} />
                    </svg>
                    <div className="cw-cycle-footer">
                      <span className="cw-cycle-legend">
                        <span className="cw-cycle-dot" style={{ background: "#34d399" }} /> TEMA-14
                        <span className="cw-cycle-dot" style={{ background: "#818cf8" }} /> TEMA-21
                      </span>
                      <span className="cw-cycle-dist" style={{ color: phaseColor }}>
                        {tC("cycle.vsTema", { pct: `${pctFromT14 >= 0 ? "+" : ""}${pctFromT14.toFixed(1)}%` })}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })()}
            {!elliottResult && (
              <div className="cw-ai-card cw-ai-empty">
                <p>{tC("wave.noSignal")}</p>
              </div>
            )}

            {weeklyCycle && volCone && (() => {
              const currentPrice = weeklyCycle.candles[weeklyCycle.candles.length - 1]?.close ?? 0;
              const fmtP = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
              const halving = getHalvingCyclePhase();
              const wc = weeklyCycle;
              const lt14 = wc.tema14[wc.tema14.length - 1];
              const lt21 = wc.tema21[wc.tema21.length - 1];
              const aboveT14 = currentPrice >= lt14;
              const cyclePhase = aboveT14
                ? (lt14 >= lt21 ? "Bull Run" : "Recovery")
                : (lt14 >= lt21 ? "Mid-Cycle Correction" : "Bear Market");
              const cyclePhaseTone = cyclePhase === "Bull Run" ? "bull" : cyclePhase === "Bear Market" ? "bear" : "neutral";
              const halvingTone = halving.phase.startsWith("Early") || halving.phase.startsWith("Peak") ? "bull"
                : halving.phase.startsWith("Bear") ? "bear" : "neutral";

              const HORIZONS = [
                { key: "m3" as const, label: tC("vol.m3") },
                { key: "m6" as const, label: tC("vol.m6") },
              ];
              // Log-space half-spread recovered from the already-computed low/high,
              // used only to size each row's bar relative to the widest (6mo) one —
              // makes the two rows visually fan out into a cone as the horizon grows.
              const spreads = HORIZONS.map(({ key }) => Math.log(volCone[key].high / volCone[key].low) / 2);
              const maxSpread = Math.max(...spreads);

              return (
                <div className="cw-ai-card cw-vol-cone">
                  <div className="cw-ai-section-label">{tC("vol.title")}</div>
                  <p className="cw-ai-text">
                    {tC("vol.intro")}
                  </p>
                  <button
                    className="cw-vol-cone-methodology-toggle"
                    onClick={() => setShowVolMethodology(v => !v)}
                  >
                    {showVolMethodology ? `▾ ${tC("vol.hideMethod")}` : `▸ ${tC("vol.howCalc")}`}
                  </button>
                  {showVolMethodology && (
                    <div className="cw-vol-cone-methodology">
                      <div className="cw-vol-cone-methodology-row">
                        <span>{tC("vol.data")}</span>
                        <span>{tC("vol.dataVal")}</span>
                      </div>
                      <div className="cw-vol-cone-methodology-row">
                        <span>{tC("vol.sigma")}</span>
                        <span>{tC("vol.sigmaVal", { pct: (volCone.m3.weeklySigma * 100).toFixed(2) })}</span>
                      </div>
                      <div className="cw-vol-cone-methodology-row">
                        <span>{tC("vol.formula")}</span>
                        <span>{tC("vol.formulaVal")}</span>
                      </div>
                      <div className="cw-vol-cone-methodology-row">
                        <span>{tC("vol.confidence")}</span>
                        <span>{tC("vol.confidenceVal")}</span>
                      </div>
                      <div className="cw-vol-cone-methodology-row">
                        <span>{tC("vol.trend")}</span>
                        <span>{tC("vol.trendVal")}</span>
                      </div>
                      <div className="cw-vol-cone-methodology-row">
                        <span>{tC("vol.likelihood")}</span>
                        <span>{tC("vol.likelihoodVal")}</span>
                      </div>
                    </div>
                  )}
                  <div className="cw-vol-cone-rows">
                    {HORIZONS.map(({ key, label }, i) => {
                      const r = volCone[key];
                      const widthPct = 88 * (spreads[i] / maxSpread);
                      const upPct = r.upProb * 100;
                      const leansUp = upPct >= 50;
                      return (
                        <div key={key} className="cw-vol-cone-row">
                          <span className="cw-vol-cone-row-label">{label}</span>
                          <div className="cw-vol-cone-bar-wrap">
                            <div className="cw-vol-cone-bar" style={{ width: `${widthPct}%` }}>
                              <span className="cw-vol-cone-low">{fmtP(r.low)}</span>
                              <span className="cw-vol-cone-high">{fmtP(r.high)}</span>
                            </div>
                            <div className="cw-vol-cone-center-tick" title={tC("vol.current", { price: fmtP(currentPrice) })} />
                          </div>
                          <span
                            className={`cw-vol-cone-prob cw-vol-cone-prob--${leansUp ? "up" : "down"}`}
                            title={tC(`vol.${leansUp ? "higherTip" : "lowerTip"}_${key}`, { pct: (leansUp ? upPct : 100 - upPct).toFixed(0) })}
                          >
                            {leansUp ? "▲" : "▼"} {(leansUp ? upPct : 100 - upPct).toFixed(0)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="cw-ai-text cw-vol-cone-prob-note">
                    {tC("vol.probNote")}
                  </p>
                  <p className="cw-range-footer">
                    <span className="cw-range-dot" /> {tC("vol.now")} <strong>{fmtP(currentPrice)}</strong>
                  </p>
                  <div className="cw-macro-chips">
                    <div className={`cw-macro-chip cw-macro-chip--${cyclePhaseTone}`}>
                      <span className="cw-macro-chip-key">{tC("vol.cyclePhase")}</span>
                      <span className="cw-macro-chip-val">{tC(`cycle.phase.${tKey(cyclePhase)}`)}</span>
                    </div>
                    <div className={`cw-macro-chip cw-macro-chip--${halvingTone}`}>
                      <span className="cw-macro-chip-key">{tC("vol.halvingCycle")}</span>
                      <span className="cw-macro-chip-val">{tC("vol.halvingVal", { phase: tC(`halving.${tKey(halving.phase)}`), days: halving.daysSinceLast })}</span>
                    </div>
                  </div>
                  <p className="cw-disclaimer">{tC("vol.disclaimer")}</p>
                </div>
              );
            })()}
              </>
            )}

            {(rightTab === "narration" || aiGroup) && aiSec("narr", tC("desk.narrAria"), <MMNarrationFeed entries={mmFeed} loading={aiLoading} />)}

            {(rightTab === "read" || aiGroup) && aiSec("read", tC("desk.readAria"), (
            <div className="cw-ai-card">
              {/* Desktop: no header until there's a read (the Read switch
                  above already names the view; the timer tracks chart data,
                  not the AI, so it misled next to an empty state). */}
              {(aiRead || aiLoading) && (
              <div className="cw-ai-header">
                <span className="cw-desk-title">{tC("desk.title")}</span>
                <div className="cw-ai-header-refresh">
                  {/* Live: next-AI-read countdown (while the cooldown runs)
                      and the "updated … ago" counter, both ticking every second. */}
                  <AiCooldown until={aiCooldownUntil} coin={coin as string} variant="pill" />
                  {refreshedAt && <LiveAgo since={refreshedAt.getTime()} />}
                  <button
                    className={`cw-refresh-btn${refreshSpinning ? " cw-refresh-btn--spinning" : ""}`}
                    onClick={handleManualRefresh}
                    title={tC("desk.refreshTip")}
                  >
                    ↻
                  </button>
                </div>
              </div>
              )}

              {aiLoading && (
                <div className="cw-ai-loading">
                  <div className="cw-ai-spinner" />
                  <span>{tC("desk.reading")}</span>
                </div>
              )}

              {!aiLoading && aiRead && (
                <>
                  {/* ── Pro desk layout ── */}
                  {(() => {
                    const now = heroPrice || null;
                    const dist = (p: number) => (now ? ((p - now) / now) * 100 : null);
                    const pct = (p: number) => { const d = dist(p); return d == null ? "" : `${d >= 0 ? "+" : ""}${d.toFixed(2)}%`; };
                    const sc = aiRead.scenario;
                    const bullT = sc ? firstPrice(sc.bullCase) : null;
                    const bearT = sc ? firstPrice(sc.bearCase) : null;
                    const trigT = sc ? firstPrice(sc.trigger) : null;
                    const side = aiRead.bias === "bullish" ? "long" : aiRead.bias === "bearish" ? "short" : "flat";
                    const confN = aiRead.confidence === "high" ? 3 : aiRead.confidence === "medium" ? 2 : 1;

                    // Ladder: every level, merged when within 0.05%, sorted high → low.
                    type Rung = { label: string; price: number; kind: "res" | "sup" | "bull" | "bear" | "trig" | "ai" };
                    const raw: Rung[] = [
                      ...(bullT ? [{ label: tC("desk.bullTarget"), price: bullT, kind: "bull" as const }] : []),
                      ...(bearT ? [{ label: tC("desk.bearTarget"), price: bearT, kind: "bear" as const }] : []),
                      ...(trigT ? [{ label: tC("desk.trigger"), price: trigT, kind: "trig" as const }] : []),
                      ...aiRead.keyLevels.map(l => ({ label: l.label, price: l.price, kind: "ai" as const })),
                      ...(ind ? ind.resistance.slice(0, 2).map((r, i) => ({ label: `R${i + 1}`, price: r, kind: "res" as const })) : []),
                      ...(ind ? ind.support.slice(0, 2).map((s, i) => ({ label: `S${i + 1}`, price: s, kind: "sup" as const })) : []),
                    ];
                    const rungs: Rung[] = [];
                    for (const r of raw.sort((a, b) => b.price - a.price)) {
                      const m = rungs.find(x => Math.abs(x.price - r.price) <= r.price * 0.0005);
                      if (m) { if (!m.label.includes(r.label)) m.label += ` · ${r.label}`; if (r.kind !== "ai" && (m.kind === "ai" || m.kind === "res" || m.kind === "sup")) m.kind = r.kind; }
                      else rungs.push({ ...r });
                    }

                    // Reward/risk for the bias: to the target vs. to the nearest level against it.
                    let rr: { target: number; stop: number; ratio: number } | null = null;
                    if (now && side !== "flat") {
                      const target = side === "short" ? (bearT ?? ind?.support[0]) : (bullT ?? ind?.resistance[0]);
                      const against = rungs.map(r => r.price).filter(p => (side === "short" ? p > now : p < now));
                      const stop = against.length ? (side === "short" ? Math.min(...against) : Math.max(...against)) : null;
                      if (target != null && stop != null) {
                        const reward = side === "short" ? now - target : target - now;
                        const risk = side === "short" ? stop - now : now - stop;
                        if (reward > 0 && risk > 0) rr = { target, stop, ratio: reward / risk };
                      }
                    }
                    const nowIdx = now ? rungs.findIndex(r => r.price < now) : -1;
                    const mm = tC(`desk.mm.${aiRead.mmAction}`, { defaultValue: aiRead.mmAction.replace(/_/g, " ") });

                    return (
                      <div className={`cw-desk cw-desk--${side}`}>
                        {/* Signal header */}
                        <div className="cw-desk-signal">
                          <div className="cw-desk-bias">
                            <span className="cw-desk-bias-arrow">{side === "long" ? "▲" : side === "short" ? "▼" : "◆"}</span>
                            <span className="cw-desk-bias-word">{side === "long" ? tC("wave.longBias") : side === "short" ? tC("wave.shortBias") : tC("desk.noEdge")}</span>
                            <span className="cw-desk-tf">{coin} · {interval.label}</span>
                          </div>
                          <div className="cw-desk-conf" title={tC(`desk.confTip.${aiRead.confidence}`, { defaultValue: `${aiRead.confidence} confidence` })}>
                            <span className="cw-desk-conf-label">{tC("desk.conf")}</span>
                            <span className="cw-desk-conf-bars">{[1, 2, 3].map(n => <i key={n} className={n <= confN ? "on" : ""} />)}</span>
                            <span className="cw-desk-conf-word">{tC(`desk.confWord.${aiRead.confidence}`, { defaultValue: aiRead.confidence.toUpperCase() })}</span>
                          </div>
                        </div>
                        <div className="cw-desk-chips">
                          <span className="cw-desk-chip">MM · {mm.toLocaleUpperCase(i18next.language)}</span>
                          {sc && <span className={`cw-desk-chip cw-desk-chip--${sc.probability === "bulls favored" ? "long" : sc.probability === "bears favored" ? "short" : "flat"}`}>{sc.probability === "bulls favored" ? tC("desk.bullsFavored") : sc.probability === "bears favored" ? tC("desk.bearsFavored") : sc.probability.toUpperCase()}</span>}
                          {pattern && pattern.type !== "neutral" && <span className={`cw-desk-chip cw-desk-chip--${pattern.type === "bullish" ? "long" : "short"}`}>{patName(pattern.name).toLocaleUpperCase(i18next.language)}</span>}
                        </div>

                        {/* Counter-trend flag: this chart's AI read vs the higher-timeframe trend. */}
                        {mtfBiases.length > 0 && (() => {
                          const htf = getMTFSummary(mtfBiases).htfBias;
                          const against = (side === "long" && htf === "bearish") || (side === "short" && htf === "bullish");
                          if (!against) return null;
                          return (
                            <div className="cw-desk-warn">
                              ⚠ {tC(side === "long" ? "desk.counterLong" : "desk.counterShort", { iv: interval.label })}
                            </div>
                          );
                        })()}

                        {/* Thesis */}
                        {sc && <p className="cw-desk-thesis">{sc.headline}</p>}

                        {/* Scenarios */}
                        {sc && (
                          <div className="cw-desk-table">
                            <div className="cw-desk-th"><span>{tC("desk.scenario")}</span><span>{tC("desk.level")}</span><span>Δ</span></div>
                            {([
                              ["bull", `▲ ${tC("desk.bull")}`, sc.bullCase, bullT],
                              ["bear", `▼ ${tC("desk.bear")}`, sc.bearCase, bearT],
                              ["trig", `⚡ ${tC("desk.trigger")}`, sc.trigger, trigT],
                            ] as const).map(([k, name, text, lvl]) => (
                              <div key={k} className={`cw-desk-tr cw-desk-tr--${k}`}>
                                <div className="cw-desk-td-main">
                                  <span className="cw-desk-td-name">{name}</span>
                                  <span className="cw-desk-td-text">{text}</span>
                                </div>
                                <span className="cw-desk-td-num">{lvl != null ? ewFmt(lvl) : "—"}</span>
                                <span className={`cw-desk-td-num cw-desk-td-pct${lvl != null && now ? (lvl > now ? " up" : " down") : ""}`}>{lvl != null ? pct(lvl) : ""}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Reward / risk */}
                        {rr && (
                          <div className="cw-desk-rr">
                            <div><span>{tC("desk.target")}</span><b>{ewFmt(rr.target)}</b><em>{pct(rr.target)}</em></div>
                            <div><span>{tC("desk.nearestAgainst")}</span><b>{ewFmt(rr.stop)}</b><em>{pct(rr.stop)}</em></div>
                            <div className={`cw-desk-rr-ratio${rr.ratio >= 2 ? " good" : rr.ratio < 1 ? " poor" : ""}`}><span>{tC("desk.rewardRisk")}</span><b>{rr.ratio.toFixed(1)} : 1</b><em>{tC(rr.ratio >= 2 ? "desk.favorable" : rr.ratio < 1 ? "desk.unfavorable" : "desk.fair")}</em></div>
                          </div>
                        )}

                        {/* Price ladder */}
                        {rungs.length > 0 && (
                          <div className="cw-desk-ladder">
                            <div className="cw-desk-sub">{tC("desk.ladder")}</div>
                            {rungs.map((r, i) => (
                              <Fragment key={`${r.label}${r.price}`}>
                                {i === nowIdx && now && (
                                  <div className="cw-desk-rung cw-desk-rung--now"><span>▶ {tC("desk.now")}</span><b>{ewFmt(now)}</b><em /></div>
                                )}
                                <div className={`cw-desk-rung cw-desk-rung--${r.kind}${now ? (r.price > now ? " above" : " below") : ""}`}>
                                  <span>{r.label}</span><b>{ewFmt(r.price)}</b><em>{pct(r.price)}</em>
                                </div>
                              </Fragment>
                            ))}
                            {nowIdx === -1 && now && (
                              <div className="cw-desk-rung cw-desk-rung--now"><span>▶ {tC("desk.now")}</span><b>{ewFmt(now)}</b><em /></div>
                            )}
                          </div>
                        )}

                        {/* Derivatives / market data */}
                        {macroCtx && (
                          <div className="cw-desk-stats">
                            {macroCtx.fundingRate != null && (
                              <div className={macroCtx.fundingRate > 0.0001 ? "short" : macroCtx.fundingRate < -0.0001 ? "long" : ""}>
                                <span>{tC("desk.funding")}</span><b>{macroCtx.fundingRate >= 0 ? "+" : ""}{(macroCtx.fundingRate * 100).toFixed(4)}%</b>
                              </div>
                            )}
                            {macroCtx.oiDelta != null && (
                              <div className={macroCtx.oiDelta > 0 ? "long" : "short"}>
                                <span>OI Δ</span><b>{macroCtx.oiDelta >= 0 ? "+" : ""}{macroCtx.oiDelta.toFixed(2)}%</b>
                              </div>
                            )}
                            {macroCtx.btcDominance != null && (
                              <div><span>BTC Dom</span><b>{macroCtx.btcDominance.toFixed(1)}%</b></div>
                            )}
                            {macroCtx.marketStructure != null && (
                              <div className={macroCtx.marketStructure === "uptrend" ? "long" : macroCtx.marketStructure === "downtrend" ? "short" : ""}>
                                <span>{tC("desk.dailyStructure")}</span><b>{macroCtx.marketStructure === "uptrend" ? `↑ ${tC("desk.up")}` : macroCtx.marketStructure === "downtrend" ? `↓ ${tC("desk.down")}` : `→ ${tC("desk.range")}`}</b>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Desk notes */}
                        <div className="cw-desk-notes">
                          <div><span>{tC("desk.smartMoney")}</span><p>{aiRead.mmReading}</p></div>
                          <div><span>{tC("desk.nextMove")}</span><p>{aiRead.nextMove}</p></div>
                        </div>

                        <button
                          type="button"
                          className={`cw-desk-plot${showForecast ? " on" : ""}`}
                          onClick={toggleForecast}
                        >
                          {showForecast ? `✕ ${tC("desk.hideProj")}` : `✦ ${tC("desk.plotProj")}`}
                        </button>
                      </div>
                    );
                  })()}

                  <p className="cw-disclaimer">{tC("desk.disclaimer")}</p>
                </>
              )}

              {!aiLoading && !aiRead && !loading && (
                <div className="cw-ai-start">
                  <span className="cw-ai-start-orb" aria-hidden="true"><span>✦</span></span>
                  <div className="cw-ai-start-title">{tC("start.title", { coin, iv: interval.label })}</div>
                  <p className="cw-ai-start-text">
                    {tC("start.text")}
                  </p>
                  <div className="cw-ai-start-grid" aria-hidden="true">
                    {([
                      [tC("start.bias"), <path key="a" d="M3 17l6-6 4 4 8-8M15 7h6v6" />],
                      [tC("start.levels"), <path key="b" d="M3 6h18M3 12h18M3 18h18" />],
                      [tC("desk.nextMove"), <path key="c" d="M5 12h14M13 6l6 6-6 6" />],
                      [tC("start.plan"), <path key="d" d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />],
                    ] as const).map(([label, icon]) => (
                      <div className="cw-ai-start-tile" key={label}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
                        <span className="cw-ai-start-tile-label">{label}</span>
                        <span className="cw-ai-start-tile-skel" />
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={`cw-ai-start-btn${refreshSpinning ? " cw-ai-start-btn--busy" : ""}`}
                    onClick={handleManualRefresh}
                    disabled={refreshSpinning}
                  >
                    {refreshSpinning ? tC("start.starting") : `✦ ${tC("start.run")}`}
                  </button>
                  {aiNotice === COOLDOWN_NOTICE
                    ? (aiCooldownUntil > Date.now()
                        ? <AiCooldown until={aiCooldownUntil} coin={coin as string} variant="note" />
                        : <span className="cw-ai-start-note">{tC("start.uses")}</span>)
                    : aiNotice
                      ? <span className="cw-ai-start-note cw-ai-start-note--warn" role="status">{aiNotice}</span>
                      : <span className="cw-ai-start-note">{tC("start.uses")}</span>}
                </div>
              )}
            </div>
            ))}

            {(rightTab === "plan" || (aiGroup && (aiRead || aiLoading))) && aiSec("plan", tC("start.plan"), (
            <div className="cw-ai-card">
              {aiLoading && (
                <div className="cw-ai-loading">
                  <div className="cw-ai-spinner" />
                  <span>{tC("desk.reading")}</span>
                </div>
              )}

              {!aiLoading && aiRead && (
                <>
                  {/* ── Trade Wizard ── */}
                  {/* ── Position check (trade wizard) ── */}
                  <div className="cw-desk cw-pos">
                    <div className="cw-pos-head">
                      <span className="cw-desk-sub">{tC("pos.title")}</span>
                      <span className="cw-desk-tf">{coin} · {interval.label}</span>
                    </div>
                    <div className="cw-pos-seg" role="tablist" aria-label={tC("pos.aria")}>
                      {(["buy", "sell", "long", "short"] as WizardIntent[]).map(i => (
                        <button
                          key={i}
                          type="button"
                          role="tab"
                          aria-selected={wizardIntent === i}
                          className={`cw-pos-seg-btn cw-pos-seg-btn--${i === "buy" || i === "long" ? "up" : "down"}${wizardIntent === i ? " on" : ""}`}
                          onClick={() => setWizardIntent(wizardIntent === i ? null : i)}
                        >
                          {i === "buy" ? "↑ " : i === "sell" ? "↓ " : i === "long" ? "▲ " : "▼ "}{tC(`wiz.intent.${i}`)}
                        </button>
                      ))}
                    </div>
                    {wizardIntent === null ? (
                      <p className="cw-pos-hint">{tC("pos.hint")}</p>
                    ) : (() => {
                      const rec = getWizardRec(wizardIntent, aiRead, mtfBiases, ind, lastPrice);
                      const sgn = (from: number, to: number) => { const d = ((to - from) / from) * 100; return `${d >= 0 ? "+" : ""}${d.toFixed(2)}%`; };
                      return (
                        <div className={`cw-pos-rec cw-pos-rec--${rec.verdict}`}>
                          <div className="cw-pos-verdict">
                            <span className="cw-pos-verdict-badge">{tC(`pos.verdict.${rec.verdict}`)}</span>
                            <span className="cw-pos-verdict-line">{rec.headline}</span>
                          </div>
                          <p className="cw-pos-body">{rec.body}</p>

                          {rec.levels && (
                            <>
                              <div className="cw-desk-rr cw-pos-grid">
                                <div><span>{tC("pos.entry")}</span><b>{ewFmt(rec.levels.entry)}</b><em>{tC("pos.market")}</em></div>
                                <div className="sl"><span>{tC("pos.stop")}</span><b>{ewFmt(rec.levels.stopLoss)}</b><em>{sgn(rec.levels.entry, rec.levels.stopLoss)}</em></div>
                                <div className="tp"><span>{tC("desk.target")}</span><b>{ewFmt(rec.levels.target)}</b><em>{sgn(rec.levels.entry, rec.levels.target)}</em></div>
                                <div className={`cw-desk-rr-ratio${rec.levels.rr >= 2 ? " good" : rec.levels.rr < 1 ? " poor" : ""}`}>
                                  <span>R : R</span><b>{rec.levels.rr.toFixed(1)} : 1</b><em>{tC(rec.levels.rr >= 2 ? "desk.favorable" : rec.levels.rr >= 1 ? "pos.acceptable" : "pos.tight")}</em>
                                </div>
                              </div>
                              {(rec.levels.resistance.length > 0 || rec.levels.support.length > 0) && lastPrice != null && (
                                <div className="cw-desk-ladder">
                                  {rec.levels.resistance.map((r, i) => (
                                    <div key={"r" + i} className="cw-desk-rung above"><span>R{i + 1}</span><b>{ewFmt(r)}</b><em>{sgn(lastPrice, r)}</em></div>
                                  ))}
                                  <div className="cw-desk-rung cw-desk-rung--now"><span>▶ {tC("desk.now")}</span><b>{ewFmt(lastPrice)}</b><em /></div>
                                  {rec.levels.support.map((s, i) => (
                                    <div key={"s" + i} className="cw-desk-rung below"><span>S{i + 1}</span><b>{ewFmt(s)}</b><em>{sgn(lastPrice, s)}</em></div>
                                  ))}
                                </div>
                              )}
                            </>
                          )}

                          {rec.risk && <div className="cw-desk-warn">⚠ {rec.risk}</div>}
                        </div>
                      );
                    })()}
                  </div>

                  {/* ── Our Take ─────────────────────────────────────────── */}
                  {predData?.ourTake && (
                    <div className={`cw-desk cw-view cw-view--${predData.ourTakeAction ?? "watch"}`}>
                      <div className="cw-pos-head">
                        <span className="cw-desk-sub">{tC("view.title")}</span>
                        {predData.ourTakeAction && (
                          <span className={`cw-view-action cw-view-action--${predData.ourTakeAction}`}>
                            {tC(`view.action.${predData.ourTakeAction}`, { defaultValue: predData.ourTakeAction.toUpperCase() })}
                          </span>
                        )}
                      </div>
                      <p className="cw-view-text">{predData.ourTake}</p>

                      {/* Elliott Wave addendum */}
                      {elliottResult && elliottResult.pattern !== "none" && (() => {
                        const ew = elliottResult;
                        const fmt = (p: number) => "$" + p.toLocaleString(undefined, { maximumFractionDigits: 0 });
                        const lastPrice = candles[candles.length - 1]?.close ?? 0;
                        const mainProj = ew.projections.find(p => p.isMain);
                        const allProj  = ew.projections;

                        // Direction of next move
                        let nextDir = "";
                        let nextSummary = "";
                        let actionHint = "";

                        const mainTxt = (fallback: string) => mainProj ? fmt(mainProj.price) : fallback;
                        if (ew.pattern === "impulse" && ew.complete) {
                          const isBull = ew.direction === "bullish";
                          nextDir = isBull ? "down" : "up";
                          nextSummary = ew.subtype === "diagonal"
                            ? tC(isBull ? "view.diagDoneBull" : "view.diagDoneBear", { name: ew.name ? ewNameT(ew.name) : "" })
                            : tC(isBull ? "view.impDoneBull" : "view.impDoneBear");
                          actionHint = tC(isBull ? "view.impDoneHintBull" : "view.impDoneHintBear", { price: mainTxt(tC("view.resistanceWord")) });
                        } else if (ew.pattern === "impulse" && ew.currentWave === "5") {
                          const isBull = ew.direction === "bullish";
                          nextDir = isBull ? "up" : "down";
                          nextSummary = tC(isBull ? "view.w5SummaryBull" : "view.w5SummaryBear");
                          actionHint = tC(isBull ? "view.w5HintBull" : "view.w5HintBear", { price: mainTxt(tC("view.targetWord")) });
                        } else if (ew.pattern === "impulse" && ew.currentWave === "4") {
                          const isBull = ew.direction === "bullish";
                          const t382 = ew.projections.find(p => p.label.includes("38.2"));
                          const t618 = ew.projections.find(p => p.label.includes("61.8"));
                          nextDir = isBull ? "down" : "up";
                          nextSummary = tC(isBull ? "view.w4SummaryBull" : "view.w4SummaryBear");
                          const fb = tC(isBull ? "view.supportWord" : "view.resistanceWord");
                          actionHint = tC(isBull ? "view.w4HintBull" : "view.w4HintBear", { a: t382 ? fmt(t382.price) : fb, b: t618 ? fmt(t618.price) : fb });
                        } else if (ew.subtype === "triangle") {
                          // Triangle direction = breakout direction (not a reversal).
                          const up = ew.direction === "bullish";
                          nextDir = up ? "up" : "down";
                          nextSummary = tC(up ? "view.triSummaryUp" : "view.triSummaryDown");
                          actionHint = tC(up ? "view.triHintUp" : "view.triHintDown", { price: mainTxt("—") });
                        } else if (ew.pattern === "corrective") {
                          const isBear = ew.direction === "bearish";
                          nextDir = isBear ? "up" : "down";
                          nextSummary = tC(isBear ? "view.corrSummaryBear" : "view.corrSummaryBull", { name: ew.name ? ewNameT(ew.name) : "A-B-C" });
                          actionHint = tC(isBear ? "view.corrHintBear" : "view.corrHintBull", { price: mainTxt("—") });
                        }

                        if (!nextSummary) return null;
                        // Same net direction as Today's read / the Elliott tab
                        // (a wave-4 bounce in a bearish count reads "small
                        // bounce, then down", not "UP").
                        nextDir = ewNextUp(ew) ? "up" : "down";

                        // Levels as a ladder with the current price slotted in.
                        const rungs = [...allProj].sort((a, b) => b.price - a.price);
                        const nowAt = lastPrice > 0 ? rungs.findIndex(p => p.price < lastPrice) : -1;
                        const pctTo = (p: number) => { const d = lastPrice > 0 ? ((p - lastPrice) / lastPrice) * 100 : 0; return `${d >= 0 ? "+" : ""}${d.toFixed(2)}%`; };
                        const nowRow = lastPrice > 0 ? <div className="cw-desk-rung cw-desk-rung--now"><span>▶ {tC("desk.now")}</span><b>{ewFmt(lastPrice)}</b><em /></div> : null;

                        return (
                          <div className="cw-view-ew">
                            <div className="cw-view-ew-head">
                              <span className="cw-desk-sub">Elliott · {ew.name ? `${ewNameT(ew.name)} · ` : ""}{tC("view.waveN", { wave: ew.currentWave })}</span>
                              <span className={`cw-view-ew-dir cw-view-ew-dir--${nextDir}`}>
                                {nextDir === "up" ? "▲" : "▼"} {ewNextLabel(ew).toLocaleUpperCase(i18next.language)}
                              </span>
                            </div>
                            <p className="cw-view-ew-summary">{nextSummary}</p>
                            {rungs.length > 0 && (
                              <div className="cw-desk-ladder">
                                {rungs.map((p, i) => (
                                  <Fragment key={p.label}>
                                    {i === nowAt && nowRow}
                                    <div className={`cw-desk-rung${p.isMain ? " cw-desk-rung--main" : ""}${lastPrice > 0 ? (p.price > lastPrice ? " above" : " below") : ""}`}>
                                      <span>{p.label}{p.isMain ? ` · ${tC("view.main")}` : ""}</span><b>{ewFmt(p.price)}</b><em>{pctTo(p.price)}</em>
                                    </div>
                                  </Fragment>
                                ))}
                                {nowAt === -1 && nowRow}
                              </div>
                            )}
                            <p className="cw-view-ew-hint">{actionHint}</p>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* ── Price Range Forecast ──────────────────────────────── */}
                  {predData?.timeframes && (() => {
                    const TF = ["8h", "12h", "16h", "24h"] as const;
                    const currentPrice = candles[candles.length - 1]?.close ?? 0;
                    // One shared scale across all horizons so the bands are
                    // comparable (wider band = more uncertainty further out).
                    const all = TF.flatMap(tf => [predData.timeframes![tf].low, predData.timeframes![tf].high]).concat(currentPrice > 0 ? [currentPrice] : []);
                    const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
                    const x = (p: number) => ((p - lo) / span) * 100;
                    const sgn = (p: number) => { const d = currentPrice > 0 ? ((p - currentPrice) / currentPrice) * 100 : 0; return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`; };
                    return (
                      <div className="cw-desk cw-band">
                        <div className="cw-pos-head">
                          <span className="cw-desk-sub">{tC("band.title")}</span>
                          {currentPrice > 0 && <span className="cw-desk-tf">{tC("band.now", { price: ewFmt(currentPrice) })}</span>}
                        </div>
                        <div className="cw-band-th"><span>{tC("band.horizon")}</span><span /><span>{tC("banner.low")}</span><span>{tC("banner.high")}</span></div>
                        {TF.map(tf => {
                          const r = predData.timeframes![tf];
                          const out = currentPrice > 0 && (currentPrice < r.low || currentPrice > r.high);
                          return (
                            <div key={tf} className="cw-band-row">
                              <span className="cw-band-tf">{tf.toUpperCase()}</span>
                              <div className="cw-band-track">
                                <i className="cw-band-fill" style={{ left: `${x(r.low)}%`, width: `${x(r.high) - x(r.low)}%` }} />
                                {currentPrice > 0 && <i className={`cw-band-now${out ? " out" : ""}`} style={{ left: `${x(currentPrice)}%` }} />}
                              </div>
                              <span className="cw-band-num down"><b>{ewFmt(r.low)}</b><em>{sgn(r.low)}</em></span>
                              <span className="cw-band-num up"><b>{ewFmt(r.high)}</b><em>{sgn(r.high)}</em></span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </>
              )}

              {!aiLoading && !aiRead && !loading && (
                <div className="cw-ai-empty">
                  <p>{tC("start.runForPlan")}</p>
                </div>
              )}
            </div>
            ))}

            {(rightTab === "fractal" || rightTab === "signals") && (() => {
              const fa = fractalAnalogs;
              const activeIdx = fa ? Math.min(selectedFractalIdx, fa.matches.length - 1) : 0;
              const active = fa?.matches[activeIdx];

              return (
                <div className="cw-ai-card">
                  <div className="cw-ai-header">
                    <span className="cw-ai-badge">◎ {tC("fractal.listTitle")}</span>
                  </div>
                  <p className="cw-elliott-hint">
                    {tC("fractal.intro", { win: FRACTAL_WINDOW, k: FRACTAL_TOP_K, fwd: FRACTAL_HORIZON })}
                  </p>

                  {fractalLoading && (
                    <div className="cw-ai-loading">
                      <div className="cw-ai-spinner" />
                      <span>{tC("card.searching")}</span>
                    </div>
                  )}

                  {!fractalLoading && !fa && (
                    <div className="cw-ai-empty">
                      <p>{tC("fractal.notEnough", { n: FRACTAL_MIN_HISTORY })}</p>
                    </div>
                  )}

                  {!fractalLoading && fa && active && (() => {
                    const W = 280, H = 130;
                    const total = fa.windowSize + fa.forwardHorizon;
                    const allVals = [...fa.currentPath, ...active.path];
                    const minV = Math.min(...allVals), maxV = Math.max(...allVals);
                    const pad = (maxV - minV) * 0.08 || 0.01;
                    const yOf = (v: number) => H - ((v - (minV - pad)) / ((maxV + pad) - (minV - pad))) * H;
                    const xOf = (i: number) => (i / (total - 1)) * W;
                    const todayX = xOf(fa.windowSize - 1);

                    const nowD = fa.currentPath.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`).join(" ");
                    const pastFullD = active.path.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`).join(" ");
                    const pastPastD = active.path.slice(0, fa.windowSize).map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`).join(" ");

                    const fmt = (t: UTCTimestamp) => new Date(Number(t) * 1000).toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });

                    return (
                      <button
                        type="button"
                        className="cw-fractal-overlay cw-fractal-overlay--clickable"
                        onClick={() => { setExpandedFractalIdx(activeIdx); setMobilePeekExpanded(true); }}
                        title={tC("fractal.expandTip")}
                      >
                        <span className="cw-fractal-overlay-expand">⤢ {tC("tape.expand")}</span>
                        <svg className="cw-fractal-overlay-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                          <line x1={todayX} y1="0" x2={todayX} y2={H} className="cw-fractal-overlay-todayline" />
                          {/* Full fractal path (past window + what happened after), faint */}
                          <path d={pastFullD} fill="none" stroke="#f97316" strokeWidth="1.25" strokeOpacity="0.55" strokeDasharray="3 2" />
                          {/* Fractal's own window portion, solid — this is the part being compared to "now" */}
                          <path d={pastPastD} fill="none" stroke="#f97316" strokeWidth="1.75" />
                          {/* Live window, always solid + on top */}
                          <path d={nowD} fill="none" stroke="#38bdf8" strokeWidth="2" />
                        </svg>
                        <div className="cw-fractal-overlay-axis">
                          <span>{fmt(active.startTime)}</span>
                          <span className="cw-fractal-overlay-axis-today">{tC("fractal.today", { date: fmt(active.time) })}</span>
                          <span>{fmt(active.forwardEndTime)}</span>
                        </div>
                        <div className="cw-fractal-overlay-legend">
                          <span><span className="cw-fractal-overlay-dot" style={{ background: "#38bdf8" }} /> {tC("fractal.legendNow", { from: fmt(fa.currentStart), to: fmt(fa.currentEnd) })}</span>
                          <span><span className="cw-fractal-overlay-dot" style={{ background: "#f97316" }} /> {tC("fractal.legendFractalPct", { pct: active.similarity, from: fmt(active.startTime), to: fmt(active.forwardEndTime) })}</span>
                        </div>
                      </button>
                    );
                  })()}

                  {!fractalLoading && fa && (
                    <>
                      <div className={`cw-fractal-summary cw-fractal-summary--${fa.avgForwardReturn >= 0 ? "up" : "down"}`}>
                        <span className="cw-fractal-summary-text">
                          {tC("fractal.summary", { n: fa.matches.length, up: fa.upCount, days: fa.forwardHorizon })}
                        </span>
                        <span className="cw-fractal-summary-val">
                          {tC("fractal.avg", { avg: `${fa.avgForwardReturn >= 0 ? "+" : ""}${fa.avgForwardReturn.toFixed(2)}%` })}
                        </span>
                      </div>

                      {fa.matches.map((m, i) => {
                        const fmtFull = (t: UTCTimestamp) => new Date(Number(t) * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
                        const fmtShort = (t: UTCTimestamp) => new Date(Number(t) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
                        const daysAgo = Math.round((Date.now() / 1000 - Number(m.time)) / 86_400);
                        const agoLabel = daysAgo < 1 ? tC("fractal.agoToday")
                          : daysAgo < 60 ? tC("fractal.agoD", { n: daysAgo })
                          : daysAgo < 730 ? tC("fractal.agoMo", { n: Math.round(daysAgo / 30) })
                          : tC("fractal.agoY", { n: (daysAgo / 365).toFixed(1) });
                        return (
                          <button
                            key={i}
                            type="button"
                            className={`cw-fractal-match${i === activeIdx ? " cw-fractal-match--active" : ""}`}
                            onClick={() => {
                              setSelectedFractalIdx(i);
                              setExpandedFractalIdx(i);
                              setMobilePeekExpanded(true);
                              if (!chartRef.current) return;
                              const span = fa.windowSize * 86_400;
                              chartRef.current.timeScale().setVisibleRange({
                                from: (Number(m.time) - span) as UTCTimestamp,
                                to: (Number(m.time) + fa.forwardHorizon * 86_400) as UTCTimestamp,
                              });
                            }}
                          >
                            <span className="cw-fractal-match-main">
                              <span className="cw-fractal-match-range">
                                {fmtFull(m.startTime)} – {fmtFull(m.time)}
                                <span className="cw-fractal-match-len"> ({fa.windowSize}d)</span>
                              </span>
                              <span className="cw-fractal-match-ago">{agoLabel} · {tC("fractal.nOf", { i: i + 1, n: fa.matches.length })}</span>
                            </span>
                            <span className="cw-fractal-match-side">
                              <span className="cw-fractal-match-sim">{tC("fractal.match", { pct: m.similarity })}</span>
                              <span className={`cw-fractal-match-ret${m.forwardReturn >= 0 ? " up" : " down"}`}>
                                {m.forwardReturn >= 0 ? "▲" : "▼"} {tC("fractal.retAfter", { pct: `${Math.abs(m.forwardReturn).toFixed(2)}%`, days: fa.forwardHorizon, from: fmtShort(m.time), to: fmtShort(m.forwardEndTime) })}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })()}

            </div>
          </div>

          </div>
            </>
          )}
        </div>

      </div>
    </BlurGate>
  );
};
