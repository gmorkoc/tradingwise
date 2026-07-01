import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, IChartApi, ISeriesApi, IPriceLine, CandlestickData, ColorType, LineStyle, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers, ISeriesMarkersPluginApi, SeriesMarker, UTCTimestamp } from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol, getMacroContext, MacroContextData } from "../services/coinglass";
import { openai, callOpenAI, PredictionResponse } from "../services/openai";
import { fetchFearGreed } from "../services/feargreed";
import { BlurGate } from "./MembershipGate";
import { useAuth } from "../contexts/AuthContext";
import { hasAccess } from "../services/supabase";
import "../styles/CandleWatcher.css";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  coin: CoinSymbol | string;
  theme: "dark" | "light";
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  onReady?: () => void;
  refreshTrigger?: number;
  visible?: boolean;
}

type Interval = { label: string; value: string; refresh: number; limit: number; durationSec: number };

interface Indicators {
  rsi: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbPct: number | null;          // 0–1 where price sits in band
  bbUpper: number | null;
  bbLower: number | null;
  volRatio: number | null;       // current vol / 20-period avg
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

const INTERVALS: Interval[] = [
  { label: "1m",  value: "1m",  refresh: 30_000,   limit: 100, durationSec: 60      },
  { label: "5m",  value: "5m",  refresh: 60_000,   limit: 100, durationSec: 300     },
  { label: "15m", value: "15m", refresh: 60_000,   limit: 100, durationSec: 900     },
  { label: "30m", value: "30m", refresh: 120_000,  limit: 100, durationSec: 1_800   },
  { label: "1h",  value: "1h",  refresh: 300_000,  limit: 100, durationSec: 3_600   },
  { label: "2h",  value: "2h",  refresh: 300_000,  limit: 100, durationSec: 7_200   },
  { label: "4h",  value: "4h",  refresh: 600_000,  limit: 100, durationSec: 14_400  },
  { label: "8h",  value: "8h",  refresh: 900_000,  limit: 100, durationSec: 28_800  },
  { label: "1d",  value: "1d",  refresh: 1800_000, limit: 100, durationSec: 86_400  },
  { label: "1w",  value: "1w",  refresh: 3600_000, limit: 100, durationSec: 604_800 },
  { label: "1M",  value: "1d",  refresh: 3600_000, limit: 30,  durationSec: 86_400  },
];

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "closing…";
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) { const m = Math.floor(sec / 60); const s = sec % 60; return `${m}m ${String(s).padStart(2,"0")}s`; }
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2,"0")}m`;
}

function fmtCountdownFull(sec: number): string {
  if (sec <= 0) return "closing…";
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

  if (bull) {
    if (bodyPct > 0.7)  return `Dominant bull session — buyers controlled ${(bodyPct*100).toFixed(0)}% of the range with minimal rejection. Strong momentum candle.`;
    if (upperWick > 0.4) return `Bulls made progress but faced late selling at the highs. Upper wick signals overhead supply — watch for retest.`;
    if (lowerWick > 0.4) return `Intraday sell-off was fully absorbed and reversed. Demand zone confirmed at the lows — bullish structure intact.`;
    if (mag > 3) return `Strong bullish close at +${pct.toFixed(2)}% — buyers in full control. Continuation likely if volume holds.`;
    return `Modest bullish close at +${pct.toFixed(2)}%. Structure favors bulls but momentum is measured — await confirmation.`;
  } else {
    if (bodyPct > 0.7)  return `Dominant bear session — sellers controlled ${(bodyPct*100).toFixed(0)}% of the range. Distribution pressure likely ongoing.`;
    if (lowerWick > 0.4) return `Bears pushed lower but buyers defended the lows. Lower wick hints at support — potential reversal zone forming.`;
    if (upperWick > 0.4) return `Early buying was rejected hard. Upper wick confirms supply overhead — bearish bias carries into next session.`;
    if (mag > 3) return `Heavy bearish close at ${pct.toFixed(2)}% — sellers dominant. Risk-off bias until key support is reclaimed.`;
    return `Mild bearish close at ${pct.toFixed(2)}%. Bears have the edge but conviction is low — watch for early-session direction.`;
  }
}

// ── Indicator math ────────────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => NaN);
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

function calcRSI(candles: CandleDataPoint[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcRSIArray(candles: CandleDataPoint[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  result[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return result;
}

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

function calcMACD(candles: CandleDataPoint[]): { line: number | null; signal: number | null; hist: number | null } {
  if (candles.length < 35) return { line: null, signal: null, hist: null };
  const closes = candles.map(c => c.close);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdArr = closes.map((_, i) => isNaN(ema12[i]) || isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]);
  const validMacd = macdArr.filter(v => !isNaN(v));
  if (validMacd.length < 9) return { line: null, signal: null, hist: null };
  const signalArr = calcEMA(validMacd, 9);
  const line = validMacd[validMacd.length - 1];
  const signal = signalArr[signalArr.length - 1];
  return { line, signal, hist: line - signal };
}

function calcBB(candles: CandleDataPoint[], period = 20): { upper: number; middle: number; lower: number; pct: number } | null {
  if (candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const sma = closes.reduce((s, v) => s + v, 0) / period;
  const sd = Math.sqrt(closes.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
  const upper = sma + 2 * sd, lower = sma - 2 * sd;
  const last = candles[candles.length - 1].close;
  const pct = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  return { upper, middle: sma, lower, pct };
}

function calcATR(candles: CandleDataPoint[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const emaTR = calcEMA(trs, period);
  const last = emaTR[emaTR.length - 1];
  return isNaN(last) ? null : last;
}

function calcVolRatio(candles: CandleDataPoint[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  const avg = recent.slice(0, period).reduce((s, c) => s + (c.volume ?? 0), 0) / period;
  const cur = recent[recent.length - 1].volume ?? 0;
  return avg === 0 ? null : cur / avg;
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

function buildIndicators(candles: CandleDataPoint[]): Indicators {
  const closes = candles.map(c => c.close);
  const ema20arr  = calcEMA(closes, 20);
  const ema50arr  = calcEMA(closes, 50);
  const ema200arr = calcEMA(closes, 200);
  const bb = calcBB(candles);
  const macd = calcMACD(candles);
  const { support, resistance } = calcSR(candles);
  return {
    rsi:        calcRSI(candles),
    macdLine:   macd.line,
    macdSignal: macd.signal,
    macdHist:   macd.hist,
    bbPct:      bb?.pct ?? null,
    bbUpper:    bb?.upper ?? null,
    bbLower:    bb?.lower ?? null,
    volRatio:   calcVolRatio(candles),
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
interface EWResult { pattern: "impulse" | "corrective" | "none"; direction: "bullish" | "bearish" | "unknown"; pivots: EWPivot[]; currentWave: string; description: string; complete: boolean; projections: EWProjection[]; projectionPath: Array<{ time: UTCTimestamp; value: number }> }

function detectElliottWaves(candles: CandleDataPoint[]): EWResult {
  const empty: EWResult = { pattern: "none", direction: "unknown", pivots: [], currentWave: "—", description: "Insufficient data", complete: false, projections: [], projectionPath: [] };
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

  const toEW = (p: Pivot, label: string): EWPivot => ({ time: p.time, price: p.price, label, pivotType: p.type });

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

  // Scan last 14 pivots for best-scoring complete 5-wave
  const SCORE_THRESHOLD = 1.8;
  let bestBullIdx = -1, bestBullScore = Infinity;
  let bestBearIdx = -1, bestBearScore = Infinity;

  for (let s = Math.max(0, filt.length - 14); s <= filt.length - 6; s++) {
    const ps = filt.slice(s, s + 6);
    if (validBull(ps)) { const sc = scoreBull(ps); if (sc < bestBullScore) { bestBullScore = sc; bestBullIdx = s; } }
    if (validBear(ps)) { const sc = scoreBear(ps); if (sc < bestBearScore) { bestBearScore = sc; bestBearIdx = s; } }
  }

  if (bestBullIdx >= 0 && bestBullScore < SCORE_THRESHOLD && (bestBearIdx < 0 || bestBullScore <= bestBearScore)) {
    const [p0,p1,p2,p3,p4,p5] = filt.slice(bestBullIdx, bestBullIdx + 6);
    const total = p5.price - p0.price;
    const avgDur = Math.round((p5.time - p0.time) / 5);
    const aT = p5.price - total*0.618, bT = aT + (p5.price-aT)*0.5, cT = aT - (p5.price-aT)*0.618;
    return { pattern:"impulse", direction:"bullish", complete:true, currentWave:"5",
      description:`Bullish 5-wave complete — correction expected (score ${bestBullScore.toFixed(2)})`,
      pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4"),toEW(p5,"5")],
      projections:[
        { label:"A 38.2%", price: p5.price-total*0.382, color:"#fcd34d", isMain:false },
        { label:"A 61.8%", price: p5.price-total*0.618, color:"#f97316", isMain:true },
        { label:"C = A",   price: p5.price-total*1.0,   color:"#ef4444", isMain:false },
      ],
      projectionPath:[
        { time: now, value: nowPrice },
        { time: (now+avgDur) as UTCTimestamp, value: aT },
        { time: (now+Math.round(avgDur*1.6)) as UTCTimestamp, value: bT },
        { time: (now+Math.round(avgDur*2.6)) as UTCTimestamp, value: cT },
      ] };
  }

  if (bestBearIdx >= 0 && bestBearScore < SCORE_THRESHOLD) {
    const [p0,p1,p2,p3,p4,p5] = filt.slice(bestBearIdx, bestBearIdx + 6);
    const total = p0.price - p5.price;
    const avgDur = Math.round((p5.time - p0.time) / 5);
    const aT = p5.price+total*0.618, bT = aT-(aT-p5.price)*0.5, cT = aT+(aT-p5.price)*0.618;
    return { pattern:"impulse", direction:"bearish", complete:true, currentWave:"5",
      description:`Bearish 5-wave complete — correction expected (score ${bestBearScore.toFixed(2)})`,
      pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4"),toEW(p5,"5")],
      projections:[
        { label:"A 38.2%", price: p5.price+total*0.382, color:"#86efac", isMain:false },
        { label:"A 61.8%", price: p5.price+total*0.618, color:"#22c55e", isMain:true },
        { label:"C = A",   price: p5.price+total*1.0,   color:"#16a34a", isMain:false },
      ],
      projectionPath:[
        { time: now, value: nowPrice },
        { time: (now+avgDur) as UTCTimestamp, value: aT },
        { time: (now+Math.round(avgDur*1.6)) as UTCTimestamp, value: bT },
        { time: (now+Math.round(avgDur*2.6)) as UTCTimestamp, value: cT },
      ] };
  }

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
        return { pattern:"impulse", direction:"bullish", complete:false, currentWave:"5",
          description:"Wave 4 complete — wave 5 forming",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4")],
          projections:[
            { label:"W5 min (0.618)",  price:t618, color:"#c4b5fd", isMain:false },
            { label:"W5 equal (1.0)",  price:t100, color:"#a78bfa", isMain:false },
            { label:"W5 target (1.618)", price:t162, color:"#7c3aed", isMain:true },
            { label:"W5 ext (2.618)",  price:t262, color:"#ddd6fe", isMain:false },
          ],
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: t162 },
          ] };
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
        return { pattern:"impulse", direction:"bearish", complete:false, currentWave:"5",
          description:"Wave 4 complete — wave 5 forming",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3"),toEW(p4,"4")],
          projections:[
            { label:"W5 min (0.618)",  price:t618, color:"#c4b5fd", isMain:false },
            { label:"W5 equal (1.0)",  price:t100, color:"#a78bfa", isMain:false },
            { label:"W5 target (1.618)", price:t162, color:"#7c3aed", isMain:true },
            { label:"W5 ext (2.618)",  price:t262, color:"#ddd6fe", isMain:false },
          ],
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: t162 },
          ] };
      }
    }
  }

  // In-progress: wave 3 complete → wave 4 retracing (4 pivots)
  if (filt.length >= 4) {
    const [p0,p1,p2,p3] = filt.slice(-4);
    // Bullish
    if (p0.type==="low"&&p1.type==="high"&&p2.type==="low"&&p3.type==="high") {
      const w1=p1.price-p0.price, w3=p3.price-p2.price;
      const r2=(p1.price-p2.price)/w1;
      if (p2.price>p0.price && p3.price>p1.price && r2>=0.2 && r2<=0.99 && w3>=w1*0.8) {
        const avgDur = Math.round((p3.time-p0.time)/3);
        const t382=p3.price-w3*0.382, t5=p3.price-w3*0.5, t618=p3.price-w3*0.618;
        const w5proj = t382 + w1;
        return { pattern:"impulse", direction:"bullish", complete:false, currentWave:"4",
          description:"Wave 3 complete — wave 4 retracement expected",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3")],
          projections:[
            { label:"W4 38.2%", price:t382,   color:"#fbbf24", isMain:false },
            { label:"W4 50%",   price:t5,     color:"#f59e0b", isMain:true },
            { label:"W4 61.8%", price:t618,   color:"#d97706", isMain:false },
            { label:"W5 proj",  price:w5proj, color:"#a78bfa", isMain:false },
          ],
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: t382 },
            { time: (now+Math.round(avgDur*2)) as UTCTimestamp, value: w5proj },
          ] };
      }
    }
    // Bearish
    if (p0.type==="high"&&p1.type==="low"&&p2.type==="high"&&p3.type==="low") {
      const w1=p0.price-p1.price, w3=p2.price-p3.price;
      const r2=(p2.price-p1.price)/w1;
      if (p2.price<p0.price && p3.price<p1.price && r2>=0.2 && r2<=0.99 && w3>=w1*0.8) {
        const avgDur = Math.round((p3.time-p0.time)/3);
        const t382=p3.price+w3*0.382, t5=p3.price+w3*0.5, t618=p3.price+w3*0.618;
        const w5proj = t382 - w1;
        return { pattern:"impulse", direction:"bearish", complete:false, currentWave:"4",
          description:"Wave 3 complete — wave 4 retracement expected",
          pivots:[toEW(p0,"0"),toEW(p1,"1"),toEW(p2,"2"),toEW(p3,"3")],
          projections:[
            { label:"W4 38.2%", price:t382,   color:"#fbbf24", isMain:false },
            { label:"W4 50%",   price:t5,     color:"#f59e0b", isMain:true },
            { label:"W4 61.8%", price:t618,   color:"#d97706", isMain:false },
            { label:"W5 proj",  price:w5proj, color:"#a78bfa", isMain:false },
          ],
          projectionPath:[
            { time: now, value: nowPrice },
            { time: (now+avgDur) as UTCTimestamp, value: t382 },
            { time: (now+Math.round(avgDur*2)) as UTCTimestamp, value: w5proj },
          ] };
      }
    }

    // A-B-C corrective
    const [q0,qa,qb,qc] = filt.slice(-4);
    if (q0.type==="high"&&qa.type==="low"&&qb.type==="high"&&qc.type==="low" && qb.price<q0.price && qc.price<qa.price) {
      const drop=q0.price-qc.price, avgDur=Math.round((qc.time-q0.time)/3);
      return { pattern:"corrective", direction:"bearish", complete:true, currentWave:"C",
        description:"Bearish A-B-C complete — expect bullish reversal",
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
        ] };
    }
    if (q0.type==="low"&&qa.type==="high"&&qb.type==="low"&&qc.type==="high" && qb.price>q0.price && qc.price>qa.price) {
      const rise=qc.price-q0.price, avgDur=Math.round((qc.time-q0.time)/3);
      return { pattern:"corrective", direction:"bullish", complete:true, currentWave:"C",
        description:"Bullish A-B-C complete — expect bearish reversal",
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
        ] };
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

// ── AI Analysis ───────────────────────────────────────────────────────────────

async function getMMAnalysis(
  coin: string,
  intervalLabel: string,
  candles: CandleDataPoint[],
  ind: Indicators,
  pattern: Pattern,
  wyckoff?: WyckoffResult | null,
  ict?: ICTResult | null,
): Promise<AIRead | null> {
  const last = candles[candles.length - 1];
  const recent50 = candles.slice(-50).map(c => ({
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
    ? `${ew.pattern === "impulse" ? "Impulse" : "Corrective"} ${ew.direction} — ${ew.description}`
    : "No clear pattern detected";

  const prompt = `You are an elite crypto market analyst specializing in reading market maker (MM) and institutional order flow from raw candlestick action. Your job: decode what smart money is doing on this ${intervalLabel} chart of ${coin}/USD and predict the next move with conviction.

CURRENT PRICE: $${last.close.toFixed(2)}

LAST 50 CANDLES (oldest→newest, OHLCV):
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

ANALYSIS PROCESS — follow these steps in your "thinking" field before finalizing any output:
1. Narrate the last 50 candles as a story: where did volume spike, where were wicks absorbed, where did price stall?
2. Cross-reference the candle story with SMC structure, liquidity pools, and Wyckoff phase — do they agree or conflict?
3. Check Elliott Wave context: are we in an impulse or corrective leg? What does the current wave imply about the next move?
4. Identify the single most important price level right now and why smart money would care about it.
5. Weigh bull vs bear case honestly. Only assign "high" confidence if at least 3 independent signals agree.
6. Commit to a decisive directional call — no hedging.

Respond ONLY with valid JSON (the "thinking" field is your scratchpad — fill it first, then derive everything else from it):
{
  "thinking": "Step-by-step reasoning through the 6 analysis steps above. 4-6 sentences minimum. This is your chain-of-thought before committing to any output field.",
  "pattern": "the dominant candle pattern or structure name",
  "patternType": "bullish" | "bearish" | "neutral",
  "mmReading": "2-3 sentences: what smart money is doing right now. Cite specific wick behavior and volume.",
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

  try {
    const data = await callOpenAI({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 2000,
    });
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}") as AIRead;
    if (!parsed.mmReading) return null;
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

  if (htfBias === "bullish" && ltfBias === "bullish")
    return { htfBias, ltfBias, direction: "long",
      explanation: "All timeframes bullish — strong buy setup. The trend is clear at every level. Enter longs, trail your stop." };
  if (htfBias === "bearish" && ltfBias === "bearish")
    return { htfBias, ltfBias, direction: "short",
      explanation: "All timeframes bearish — strong sell setup. Trend is clear on every level. Short rallies, avoid longs." };
  if (htfBias === "bullish" && ltfBias === "bearish")
    return { htfBias, ltfBias, direction: "long",
      explanation: "HTF uptrend + LTF pullback = buy-the-dip setup. Don't short — wait for the lower timeframe to turn bullish for your entry." };
  if (htfBias === "bearish" && ltfBias === "bullish")
    return { htfBias, ltfBias, direction: "short",
      explanation: "HTF downtrend + LTF bounce = counter-trend rally. This 1H bounce is a shorting opportunity, not a buy. The 4H+ structure wins." };
  if (htfBias === "bullish")
    return { htfBias, ltfBias, direction: "long",
      explanation: "HTF structure is bullish. Lower timeframes are mixed — wait for the 1H to turn bullish before entering a long." };
  if (htfBias === "bearish")
    return { htfBias, ltfBias, direction: "short",
      explanation: "HTF structure is bearish. Lower timeframes are mixed — wait for the 1H to confirm the sell before entering a short." };
  return { htfBias, ltfBias, direction: "wait",
    explanation: "No clear trend across timeframes. Choppy market — reduce size or stay flat until higher timeframes align." };
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

  const intentLabel = { buy: "Buy", sell: "Sell", long: "Long", short: "Short" }[intent];
  const dirLabel    = isBull ? "bullish" : "bearish";

  let risk: string | null = null;
  if (ind?.rsi != null) {
    if (isBull  && ind.rsi > 70) risk = `RSI ${ind.rsi.toFixed(0)} — overbought. Consider waiting for a pullback entry.`;
    else if (!isBull && ind.rsi < 30) risk = `RSI ${ind.rsi.toFixed(0)} — oversold. Watch for a bounce before entering.`;
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
      headline: `${intentLabel} conditions aligned`,
      body: `${aiRead.confidence.charAt(0).toUpperCase() + aiRead.confidence.slice(1)} conviction ${dirLabel} signal${mtfAligns ? " with full MTF support" : ""}. Setup favors a ${intentLabel.toLowerCase()} entry.`,
      risk, levels,
    };
  }
  if (totalScore >= 0.25) {
    return {
      verdict: "go",
      headline: `${intentLabel} — partial setup`,
      body: `Bias leans ${dirLabel} (${aiRead.confidence} confidence) but not all timeframes agree. Consider reduced size and wait for a cleaner trigger.`,
      risk: risk ?? "Mixed alignment — manage position size carefully.",
      levels,
    };
  }
  if (totalScore > -0.25) {
    return {
      verdict: "wait",
      headline: bias === "neutral" ? "No clear direction yet" : `${intentLabel} — wait for confirmation`,
      body: bias === "neutral"
        ? `Market is ranging. No clear signal for a ${intentLabel.toLowerCase()} here. Wait for a breakout or clearer structure.`
        : `Bias is ${bias} (${aiRead.confidence} confidence) but ${mtfConflicts ? "HTF structure is opposing" : "timeframes are mixed"}. A confirmed trigger will improve risk/reward.`,
      risk, levels,
    };
  }
  return {
    verdict: "avoid",
    headline: `${intentLabel} goes against the trend`,
    body: `Current signal shows ${bias} conditions — ${isBull ? "buying or longing" : "selling or shorting"} here puts you against the dominant flow.${mtfConflicts ? " HTF structure confirms the opposing direction." : ""}`,
    risk: "Counter-trend trades need very tight stops and a clear invalidation level.",
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
          {pattern.name}
          {isLast && <span className="cw-tape-now">LIVE</span>}
        </div>
        <div className="cw-tape-desc">{pattern.desc}</div>
      </div>
      <div className={`cw-tape-dot cw-tape-dot--${bull ? "bull" : "bear"}`} />
    </div>
  );
}

// ── Indicator pill ────────────────────────────────────────────────────────────

function IndicatorPill({
  label, value, status,
}: { label: string; value: string; status: "bull" | "bear" | "neutral" | "warn" }) {
  return (
    <div className={`cw-pill cw-pill--${status}`}>
      <span className="cw-pill-label">{label}</span>
      <span className="cw-pill-value">{value}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export const CandleWatcher: React.FC<Props> = ({ coin, theme, onOpenAuth, onOpenUpgrade, onReady, visible = true }) => {
  const { tier } = useAuth();
  const isElite = hasAccess(tier, "elite");
  const [intervalIdx, setIntervalIdx] = useState(6);  // default 4h
  const [candles, setCandles] = useState<CandleDataPoint[]>([]);
  const candlesRef = useRef<CandleDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const onReadyFiredRef = useRef(false);
  const [aiRead, setAiRead] = useState<AIRead | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const aiCancelledRef = useRef(false);
  const aiScanIctRef = useRef<ICTResult | null>(null);
  const [scanStep, setScanStep] = useState(-1);
  const [lastCandleTime, setLastCandleTime] = useState<number | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [candleCountdown, setCandleCountdown] = useState<string>("");
  const [dailyCountdown, setDailyCountdown]   = useState<string>("");
  const [dailyCloseBanner, setDailyCloseBanner] = useState<{
    direction: "bullish" | "bearish";
    open: number; close: number; high: number; low: number;
    changePct: number; dismissed: boolean;
  } | null>(null);

  const chartContainerRef = useRef<HTMLDivElement>(null);
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
  const [showForecast, setShowForecast] = useState(false);
  const [forecastConviction, setForecastConviction] = useState(0);
  const [macroCtx, setMacroCtx] = useState<MacroContextData | null>(null);
  const [predData, setPredData] = useState<PredictionResponse | null>(null);
  const [predLoading, setPredLoading] = useState(false);
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
  const elliottPriceLinesRef = useRef<IPriceLine[]>([]);
  const elliottResultRef     = useRef<EWResult | null>(null);
  const showElliottRef       = useRef(false);
  const [showElliott, setShowElliott] = useState(false);
  const [elliottResult, setElliottResult] = useState<EWResult | null>(null);

  const interval = INTERVALS[intervalIdx];
  const isDark   = theme === "dark";

  // ── Build chart ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background:  { type: ColorType.Solid, color: isDark ? "#0f1117" : "#ffffff" },
        textColor:   isDark ? "#94a3b8" : "#475569",
      },
      grid: {
        vertLines:  { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
        horzLines:  { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: isDark ? "#1e293b" : "#e2e8f0" },
      timeScale: { borderColor: isDark ? "#1e293b" : "#e2e8f0", timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      width:  chartContainerRef.current.clientWidth,
      height: 460,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e", downColor: "#ef4444",
      borderUpColor: "#22c55e", borderDownColor: "#ef4444",
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
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
    const elliott      = chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, lineStyle: 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const elliottProj  = chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

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
      if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth });
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
    const { supports, resistances } = findSRLevels(data);
    const PATTERN_COMMENTS: Record<string, string> = {
      "Bullish Engulfing":    "Buyers overwhelmed sellers",
      "Bearish Engulfing":    "Sellers took full control",
      "Morning Star":         "Sellers exhausted — buyers stepped in",
      "Evening Star":         "Buyers exhausted — sellers took over",
      "Three White Soldiers": "Sustained institutional buying",
      "Three Black Crows":    "Relentless seller pressure",
      "Bullish Marubozu":     "Buyers in control open to close",
      "Bearish Marubozu":     "Sellers in control open to close",
      "Bullish Pinbar":       "Lows hunted — buyers snapped back",
      "Bearish Pinbar":       "Highs hunted — sellers dumped",
      "Hammer":               "Sellers rejected — buyers reclaimed",
      "Shooting Star":        "Buyers rejected at highs",
    };
    const newMap = new Map<number, { comment: string; type: string }>();
    const patternMarkers: SeriesMarker<UTCTimestamp>[] = [];
    for (let i = 2; i < data.length; i++) {
      const pat = detectPattern(data.slice(i - 2, i + 1));
      const comment = PATTERN_COMMENTS[pat.name];
      if (!comment) continue;
      if (!nearSR(data[i], supports, resistances)) continue;
      newMap.set(data[i].time, { comment, type: pat.type });
      patternMarkers.push({
        time:     data[i].time as UTCTimestamp,
        position: pat.type === "bearish" ? "aboveBar" : "belowBar",
        color:    pat.type === "bullish" ? "#22c55e" : "#ef4444",
        shape:    pat.type === "bullish" ? "arrowUp" : "arrowDown",
        size:     1,
      });
    }
    patternMapRef.current = newMap;

    // Wyckoff phase + Spring/Upthrust markers
    const wyk = detectWyckoff(data);
    setWyckoff(wyk);

    const springMarkers: SeriesMarker<UTCTimestamp>[] = wyk.springs.map(t => {
      newMap.set(t, { comment: "Wyckoff Spring — buyers absorbed the liquidity grab", type: "bullish" });
      return { time: t as UTCTimestamp, position: "belowBar", color: "#22c55e", shape: "arrowUp", size: 2 };
    });
    const upthrustMarkers: SeriesMarker<UTCTimestamp>[] = wyk.upthrusts.map(t => {
      newMap.set(t, { comment: "Wyckoff Upthrust — sellers failed to hold the breakout", type: "bearish" });
      return { time: t as UTCTimestamp, position: "aboveBar", color: "#f59e0b", shape: "arrowDown", size: 2 };
    });

    // ICT / SMC — clear old price lines, draw OBs + FVGs, add BOS/CHoCH markers
    ictPriceLinesRef.current.forEach(pl => candleSeriesRef.current?.removePriceLine(pl));
    ictPriceLinesRef.current = [];
    ictLevelDescriptionsRef.current = [];

    const ict = detectICT(data);
    const ictMarkers: SeriesMarker<UTCTimestamp>[] = [];

    // Retest markers
    const retestEvents = detectRetests(data, ict);
    const retestMarkers: SeriesMarker<UTCTimestamp>[] = retestEvents.map(r => {
      newMap.set(r.time, {
        comment: r.type === "bearish"
          ? `Bearish Retest — price broke below $${r.price.toFixed(0)} and is retesting it as resistance. Former support flipped — sellers are defending this level.`
          : `Bullish Retest — price broke above $${r.price.toFixed(0)} and is retesting it as support. Former resistance flipped — buyers are defending this level.`,
        type: r.type,
      });
      return {
        time:     r.time as UTCTimestamp,
        position: r.type === "bearish" ? "aboveBar" : "belowBar",
        color:    r.type === "bearish" ? "#ef4444" : "#22c55e",
        shape:    r.type === "bearish" ? "arrowDown" : "arrowUp",
        text:     r.type === "bearish" ? "Bearish Retest" : "Bull Retest",
        size: 2,
      };
    });

    if (candleSeriesRef.current) {
      const addLine = (
        price: number, color: string, lineTitle: string,
        width: 1|2 = 1, style: LineStyle = LineStyle.Dashed,
        tooltipTitle?: string, desc?: string, descType?: string
      ) => {
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
        const tt    = ob.type === "bull" ? "Bullish Order Block" : "Bearish Order Block";
        const desc  = ob.type === "bull"
          ? "The last red candle before a strong up-move — institutions placed buy orders here. If price comes back, it often bounces as smart money defends their longs."
          : "The last green candle before a strong down-move — institutions placed sell orders here. If price comes back, expect resistance as smart money defends their shorts.";
        const dt = ob.type === "bull" ? "bullish" : "bearish";
        addLine(ob.high, color, ob.type === "bull" ? "Bull OB" : "Bear OB", 1, LineStyle.Dashed, tt, desc, dt);
        addLine(ob.low,  color, "",                                          1, LineStyle.Dashed, tt, desc, dt);
      });

      // Fair Value Gaps
      ict.fvgs.forEach(fvg => {
        const color = fvg.type === "bull" ? "rgba(56,189,248,0.6)" : "rgba(251,146,60,0.6)";
        const tt   = fvg.type === "bull" ? "Bullish Fair Value Gap" : "Bearish Fair Value Gap";
        const desc = fvg.type === "bull"
          ? "A price gap left by a fast up-move. The market skipped over this zone — price often comes back to 'fill' it before continuing higher."
          : "A price gap left by a fast down-move. The market skipped over this zone — price often comes back to 'fill' it before continuing lower.";
        const dt = fvg.type === "bull" ? "bullish" : "bearish";
        addLine(fvg.top,    color, fvg.type === "bull" ? "Bull FVG" : "Bear FVG", 1, LineStyle.Dashed, tt, desc, dt);
        addLine(fvg.bottom, color, "",                                              1, LineStyle.Dashed, tt, desc, dt);
      });

      // Liquidity Pools
      ict.liquidityPools.forEach(lp => {
        const color = lp.type === "buy" ? "rgba(167,139,250,0.8)" : "rgba(251,191,36,0.8)";
        const tt   = lp.type === "buy" ? "Buy-Side Liquidity (BSL)" : "Sell-Side Liquidity (SSL)";
        const desc = lp.type === "buy"
          ? `${lp.count} equal highs stacked here — stop-loss orders from short sellers sit just above. Smart money often pushes price above this level to trigger those stops, then reverses down.`
          : `${lp.count} equal lows stacked here — stop-loss orders from buyers sit just below. Smart money often pushes price below this level to trigger those stops, then reverses up.`;
        const dt = lp.type === "buy" ? "warn" : "bearish";
        addLine(lp.price, color, lp.type === "buy" ? `BSL ×${lp.count}` : `SSL ×${lp.count}`, 1, LineStyle.Dotted, tt, desc, dt);
      });

      // Premium & Discount equilibrium line
      if (ict.pd) {
        addLine(ict.pd.mid, "rgba(148,163,184,0.5)", "EQ 50%", 1, LineStyle.Dashed,
          "Equilibrium (50%)",
          "The midpoint of the recent price range. Above this line = expensive/premium zone, where smart money prefers to sell. Below this line = cheap/discount zone, where smart money prefers to buy.",
          "neutral"
        );
      }

      // OTE zone
      if (ict.ote) {
        const color = ict.ote.type === "bull" ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)";
        const dt   = ict.ote.type === "bull" ? "bullish" : "bearish";
        addLine(ict.ote.top, color, `OTE ${ict.ote.type === "bull" ? "0.618" : "0.705"}`, 1, LineStyle.Dashed,
          "Optimal Trade Entry Zone",
          ict.ote.type === "bull"
            ? "ICT's 0.618–0.705 Fibonacci retracement zone. After a strong up-move, institutions wait for price to pull back into this zone to enter long at a better price."
            : "ICT's 0.618–0.705 Fibonacci retracement zone. After a strong down-move, institutions wait for price to pull back into this zone to enter short at a better price.",
          dt
        );
        addLine(ict.ote.bottom, color, `OTE ${ict.ote.type === "bull" ? "0.705" : "0.618"}`, 1, LineStyle.Dashed,
          "Optimal Trade Entry Zone",
          ict.ote.type === "bull"
            ? "ICT's 0.618–0.705 Fibonacci retracement zone. After a strong up-move, institutions wait for price to pull back into this zone to enter long at a better price."
            : "ICT's 0.618–0.705 Fibonacci retracement zone. After a strong down-move, institutions wait for price to pull back into this zone to enter short at a better price.",
          dt
        );
      }
    }

    ict.structure.forEach(s => {
      const isBOS  = s.kind === "bos";
      const isBull = s.dir  === "bull";
      const label  = isBOS ? (isBull ? "BOS ↑" : "BOS ↓") : (isBull ? "CHoCH ↑" : "CHoCH ↓");
      const comment = isBOS
        ? (isBull ? "Break of Structure — buyers took out prior swing high" : "Break of Structure — sellers took out prior swing low")
        : (isBull ? "Change of Character — first bullish BOS, trend may be shifting" : "Change of Character — first bearish BOS, trend may be shifting");
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

    // Elliott Wave detection & chart overlay
    const ew = detectElliottWaves(data);
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
    }

    // Divergence + Elliott markers — all merged and sorted by time
    if (divMarkersRef.current) {
      const divs = detectRSIDivergences(data);
      const divMarkers: SeriesMarker<UTCTimestamp>[] = divs.map(d => ({
        time: d.time as UTCTimestamp,
        position: d.type === "bull" ? "belowBar" : "aboveBar",
        color:    d.type === "bull" ? "#22c55e"  : "#ef4444",
        shape:    d.type === "bull" ? "arrowUp"  : "arrowDown",
        text:     d.type === "bull" ? "Bull Div" : "Bear Div",
        size: 1,
      }));
      const ewColor = ew.direction === "bullish" ? "#a78bfa" : "#f472b6";
      const ewMarkers: SeriesMarker<UTCTimestamp>[] = showElliott && ew.pivots.length >= 2
        ? ew.pivots.filter(p => p.label !== "0").map(p => ({
            time: p.time,
            position: (p.pivotType === "high" ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar",
            color: ewColor,
            shape: "circle" as const,
            text: `W${p.label}`,
            size: 1,
          }))
        : [];
      const allMarkers = [...patternMarkers, ...divMarkers, ...springMarkers, ...upthrustMarkers, ...ictMarkers, ...retestMarkers, ...ewMarkers]
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

    // Stamp a small watermark onto the captured canvas
    const ctx = canvas.getContext('2d');
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

    // Black forecast candles — clearly distinct from real candles
    const upColor = "#000000";
    const dnColor = "#000000";
    const brdUp   = isBull ? "#7dd3fc" : "#fca5a5";
    const brdDn   = isBear ? "#fca5a5" : "#7dd3fc";

    const series = chartRef.current.addSeries(CandlestickSeries, {
      upColor, downColor: dnColor,
      borderUpColor: brdUp, borderDownColor: brdDn,
      wickUpColor:   brdUp, wickDownColor:   brdDn,
    });
    series.setData(fc);
    forecastSeriesRef.current = series;

    // Uncertainty fan — bolder lines
    if (bullPath.length) {
      const bs = chartRef.current.addSeries(LineSeries, {
        color: "rgba(34,197,94,0.45)", lineWidth: 1, lineStyle: LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: false,
      });
      bs.setData(bullPath);
      forecastBullRef.current = bs;
    }
    if (bearPath.length) {
      const bs = chartRef.current.addSeries(LineSeries, {
        color: "rgba(239,68,68,0.45)", lineWidth: 1, lineStyle: LineStyle.Dashed,
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
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `AI Target ${pctLabel}  $${targetPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
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
  }, [showElliott]);

  // ── Fetch candles ────────────────────────────────────────────────────────────

  const triggerAI = useRef(false);
  const suppressAIRef = useRef(false); // true when page returns from background — don't auto-run AI

  const fetchCandles = useCallback(async (triggerAnalysis = false) => {
    const data = await coinglass.getCandles(coin, interval.value, interval.limit);
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
  const [retryKey, setRetryKey] = useState(0);

  // Initial load + interval change
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setAiRead(null);
    setLastCandleTime(null);

    coinglass.getCandles(coin, interval.value, interval.limit)
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

  // Auto-refresh — elite only
  useEffect(() => {
    if (!isElite) return;
    const id = setInterval(() => fetchCandles(false), interval.refresh);
    return () => clearInterval(id);
  }, [fetchCandles, interval.refresh, isElite]);

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
      if (w > 0) {
        chartRef.current.resize(w, 460);
        chartRef.current.timeScale().fitContent();
      }
    });
  }, [visible]);

  // Candle close countdown — ticks every second
  useEffect(() => {
    if (!candles.length) return;
    const openTimeSec = Number(candles[candles.length - 1].time);
    const closesAt    = openTimeSec + interval.durationSec;
    const tick = () => setCandleCountdown(fmtCountdown(Math.max(0, closesAt - Math.floor(Date.now() / 1000))));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [candles, interval]);

  // Daily close countdown — always UTC midnight
  useEffect(() => {
    const tick = () => {
      const now      = Date.now();
      const midnight = Math.ceil(now / 86_400_000) * 86_400_000;
      setDailyCountdown(fmtCountdownFull(Math.max(0, Math.floor((midnight - now) / 1000))));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Daily close banner — elite only
  useEffect(() => {
    if (!isElite) return;
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
        const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1d&limit=2`);
        const data = await res.json();
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
  }, [coin]);

  // MTF biases — elite only
  useEffect(() => {
    if (!isElite) return;
    fetchMTFBiases(coin as string).then(setMtfBiases).catch(() => {});
    setWizardIntent(null);
    setPredData(null);
  }, [coin, isElite]);

  // Run AI + macro fetch when flagged — elite only
  useEffect(() => {
    if (!isElite || !triggerAI.current || candles.length < 20) return;
    triggerAI.current = false;

    const ind     = buildIndicators(candles);
    const pattern = detectPattern(candles);

    const ict = detectICT(candles);
    aiScanIctRef.current = ict;
    aiCancelledRef.current = false;
    setAiLoading(true);

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

    Promise.all([
      getMMAnalysis(coin as string, interval.label, candles, ind, pattern, wyckoff, ict),
      getMacroContext(coin as string).catch(() => null),
      coinglass.getAllBTCData(coin as string).catch(() => null),
      fetchFearGreed().catch(() => null),
      Promise.all(htfFetches),
    ]).then(([res, macro, btcLive, fearGreed, htfResults]) => {
      if (aiCancelledRef.current) return;
      if (res)   setAiRead(res);
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
      if (btcLive) {
        setPredLoading(true);
        openai.getPricePrediction(btcLive, fearGreed ?? undefined)
          .then(pred => { if (pred?.success) setPredData(pred); })
          .catch(() => {})
          .finally(() => setPredLoading(false));
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
  const pctChange  = lastPrice && secondLast ? ((lastPrice - secondLast) / secondLast) * 100 : null;

  const feedCandles = candles.slice(-15);
  const prevFeedLen = useRef(0);
  const isNewRow = (i: number) => i === feedCandles.length - 1 && feedCandles.length > prevFeedLen.current;
  // track length after each render
  useEffect(() => { prevFeedLen.current = feedCandles.length; }, [feedCandles.length]);

  const secondsAgo = refreshedAt ? Math.floor((Date.now() - refreshedAt.getTime()) / 1000) : null;

  return (
    <BlurGate requiredTier="elite" featureName="Candle AI" onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} previewSrc="/previews/cw-preview.jpg" className="bg-root--top">
      <div className="cw-page">

        {/* ── AI Scan Overlay ── */}
        {aiLoading && (() => {
          const scanIct = aiScanIctRef.current;
          const scanInd = ind;
          const lastClose = candles[candles.length - 1]?.close ?? 0;
          const bsl = scanIct?.liquidityPools.filter(l => l.type === "buy") ?? [];
          const ssl = scanIct?.liquidityPools.filter(l => l.type === "sell") ?? [];
          type ScanRow = { label: string; value: string; color?: string };
          const rows: ScanRow[] = [
            { label: "RSI (14)", value: scanInd?.rsi != null ? `${scanInd.rsi.toFixed(1)}${scanInd.rsi >= 70 ? " — overbought" : scanInd.rsi <= 30 ? " — oversold" : ""}` : "—", color: scanInd?.rsi != null ? (scanInd.rsi >= 70 ? "#ef4444" : scanInd.rsi <= 30 ? "#22c55e" : "#818cf8") : undefined },
            { label: "MACD Histogram", value: scanInd?.macdHist != null ? `${scanInd.macdHist > 0 ? "+" : ""}${scanInd.macdHist.toFixed(4)}` : "—", color: scanInd?.macdHist != null ? (scanInd.macdHist > 0 ? "#22c55e" : "#ef4444") : undefined },
            { label: "Bollinger %", value: scanInd?.bbPct != null ? `${(scanInd.bbPct * 100).toFixed(0)}%${scanInd.bbPct >= 0.8 ? " — upper band" : scanInd.bbPct <= 0.2 ? " — lower band" : ""}` : "—", color: scanInd?.bbPct != null ? (scanInd.bbPct >= 0.8 ? "#ef4444" : scanInd.bbPct <= 0.2 ? "#22c55e" : "#818cf8") : undefined },
            { label: "Volume Ratio", value: scanInd?.volRatio != null ? `${scanInd.volRatio.toFixed(2)}× average` : "—", color: scanInd?.volRatio != null ? (scanInd.volRatio >= 1.5 ? "#818cf8" : "#6b7280") : undefined },
            { label: "EMA 20", value: scanInd?.ema20 != null ? `$${scanInd.ema20.toFixed(2)} — price ${lastClose > scanInd.ema20 ? "above ↑" : "below ↓"}` : "—", color: scanInd?.ema20 != null ? (lastClose > scanInd.ema20 ? "#22c55e" : "#ef4444") : undefined },
            { label: "EMA 50", value: scanInd?.ema50 != null ? `$${scanInd.ema50.toFixed(2)} — price ${lastClose > scanInd.ema50 ? "above ↑" : "below ↓"}` : "—", color: scanInd?.ema50 != null ? (lastClose > scanInd.ema50 ? "#22c55e" : "#ef4444") : undefined },
            { label: "ATR (14)", value: scanInd?.atr != null ? `$${scanInd.atr.toFixed(2)} volatility` : "—", color: "#f59e0b" },
            { label: "Elliott Wave", value: (() => { const ew = detectElliottWaves(candles); return ew.pattern !== "none" ? ew.description : "No clear pattern"; })(), color: "#818cf8" },
            { label: "Wyckoff Phase", value: wyckoff?.phase ?? "Ranging", color: "#38bdf8" },
            { label: "SMC Order Blocks", value: scanIct?.orderBlocks.length ? `${scanIct.orderBlocks.length} detected` : "None found", color: scanIct?.orderBlocks.length ? "#f59e0b" : undefined },
            { label: "Fair Value Gaps", value: scanIct?.fvgs.length ? `${scanIct.fvgs.length} open gaps` : "None open", color: scanIct?.fvgs.length ? "#38bdf8" : undefined },
            { label: "SMC Structure", value: scanIct?.structure.length ? scanIct.structure.slice(-3).map(s => `${s.kind.toUpperCase()} ${s.dir}`).join(" · ") : "—", color: "#a78bfa" },
            { label: "Buy-Side Liquidity", value: bsl.length ? bsl.map(l => `$${l.price.toLocaleString(undefined, { maximumFractionDigits: 0 })} ×${l.count}`).join(" · ") : "None detected", color: bsl.length ? "#4ade80" : undefined },
            { label: "Sell-Side Liquidity", value: ssl.length ? ssl.map(l => `$${l.price.toLocaleString(undefined, { maximumFractionDigits: 0 })} ×${l.count}`).join(" · ") : "None detected", color: ssl.length ? "#ef4444" : undefined },
            { label: "OTE Zone", value: scanIct?.ote ? `$${scanIct.ote.bottom.toFixed(0)} – $${scanIct.ote.top.toFixed(0)} (0.618–0.705)` : "Not identified", color: scanIct?.ote ? "#818cf8" : undefined },
            { label: "Premium / Discount", value: scanIct?.pd ? (lastClose > scanIct.pd.mid ? `PREMIUM — sell bias (EQ $${scanIct.pd.mid.toFixed(0)})` : `DISCOUNT — buy bias (EQ $${scanIct.pd.mid.toFixed(0)})`) : "—", color: scanIct?.pd ? (lastClose > scanIct.pd.mid ? "#ef4444" : "#22c55e") : undefined },
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
                <div className="cw-ai-overlay-heading">Analyzing {coin}/{interval.label}</div>
                <div className="cw-ai-overlay-sub">Processing {rows.length} factors for AI prediction</div>

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
                  aria-label="Cancel prediction"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })()}

        {/* ── Header ── */}
        <div className="cw-header">
          <div className="cw-header-left">
            <span className="cw-coin">{coin}/USD</span>
            {lastPrice && (
              <span className="cw-price">
                ${lastPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}
            {pctChange !== null && (
              <span className={`cw-change ${pctChange >= 0 ? "cw-change--up" : "cw-change--down"}`}>
                {pctChange >= 0 ? "▲" : "▼"} {Math.abs(pctChange).toFixed(2)}%
              </span>
            )}
          </div>

          <div className="cw-header-right">
            {dailyCountdown && (
              <div className="cw-candle-close cw-candle-close--daily">
                <span className="cw-candle-close-label">daily close</span>
                <span className="cw-candle-close-value">{dailyCountdown}</span>
              </div>
            )}
            {secondsAgo !== null && (
              <span className="cw-updated">↻ {secondsAgo}s ago</span>
            )}
            <button
              className="cw-refresh-btn"
              onClick={() => fetchCandles(true)}
              title="Refresh + re-analyze"
            >
              ↻
            </button>
          </div>
        </div>

        {/* ── Daily close banner ── */}
        {dailyCloseBanner && !dailyCloseBanner.dismissed && (
          <div className={`cw-daily-banner cw-daily-banner--${dailyCloseBanner.direction}`}>
            <div className="cw-daily-banner-icon">
              {dailyCloseBanner.direction === "bullish" ? "📈" : "📉"}
            </div>
            <div className="cw-daily-banner-body">
              <div className="cw-daily-banner-title">
                Daily Close &nbsp;·&nbsp;
                <span className={`cw-daily-banner-dir cw-daily-banner-dir--${dailyCloseBanner.direction}`}>
                  {dailyCloseBanner.direction === "bullish" ? "Bullish" : "Bearish"}
                </span>
                <span className={`cw-daily-banner-pct cw-daily-banner-pct--${dailyCloseBanner.direction}`}>
                  {dailyCloseBanner.changePct >= 0 ? "+" : ""}{dailyCloseBanner.changePct.toFixed(2)}%
                </span>
              </div>
              <div className="cw-daily-banner-stats">
                <span>O <strong>${dailyCloseBanner.open.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span>
                <span>H <strong>${dailyCloseBanner.high.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span>
                <span>L <strong>${dailyCloseBanner.low.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span>
                <span>C <strong>${dailyCloseBanner.close.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></span>
              </div>
              <div className="cw-daily-banner-insight">
                {dailyCloseInsight(dailyCloseBanner.open, dailyCloseBanner.high, dailyCloseBanner.low, dailyCloseBanner.close, dailyCloseBanner.changePct)}
              </div>
            </div>
            <button
              className="cw-daily-banner-close"
              onClick={() => {
                const todayStr = new Date().toISOString().slice(0, 10);
                sessionStorage.setItem(`daily-banner-dismissed-${coin}`, todayStr);
                setDailyCloseBanner(prev => prev ? { ...prev, dismissed: true } : null);
              }}
            >✕</button>
          </div>
        )}

        {/* ── Main grid ── */}
        <div className="cw-grid">

          {/* Left: chart + indicators */}
          <div className="cw-left">
            <div className="cw-interval-tabs">
              {INTERVALS.map((iv, i) => (
                <button
                  key={iv.label}
                  className={`cw-iv-tab${i === intervalIdx ? " cw-iv-tab--active" : ""}`}
                  onClick={() => setIntervalIdx(i)}
                >
                  {iv.label}
                </button>
              ))}
            </div>
            <div className="cw-chart-wrap" ref={chartContainerRef}>
              {loading && !loadError && <div className="cw-chart-loader">Loading candles…</div>}
              {loadError && (
                <div className="cw-chart-error">
                  <span className="cw-chart-error-icon">⚠</span>
                  <span>Failed to load chart data</span>
                  <button className="cw-chart-retry-btn" onClick={() => setRetryKey(k => k + 1)}>
                    Retry
                  </button>
                </div>
              )}
              {showForecast && aiRead && (
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
                title="Save chart as PNG"
              >
                {justSaved ? "✓ Saved" : "↓ Save"}
              </button>
              <button
                className="cw-reset-view-btn"
                onClick={() => {
                  chartRef.current?.timeScale().fitContent();
                  chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
                }}
                title="Reset view"
              >
                Reset
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

            {/* Indicator pills */}
            {ind && (
              <div className="cw-pills">
                <IndicatorPill
                  label="RSI"
                  value={ind.rsi != null ? ind.rsi.toFixed(1) : "—"}
                  status={rsiStatus()}
                />
                <IndicatorPill
                  label="MACD"
                  value={ind.macdHist != null ? (ind.macdHist > 0 ? "+" : "") + ind.macdHist.toFixed(3) : "—"}
                  status={macdStatus()}
                />
                <IndicatorPill
                  label="BB%"
                  value={ind.bbPct != null ? (ind.bbPct * 100).toFixed(0) + "%" : "—"}
                  status={bbStatus()}
                />
                <IndicatorPill
                  label="VOL"
                  value={ind.volRatio != null ? ind.volRatio.toFixed(2) + "×" : "—"}
                  status={volStatus()}
                />
                <IndicatorPill
                  label="EMA20"
                  value={ind.ema20 != null && lastPrice != null
                    ? lastPrice > ind.ema20 ? "↑ Above" : "↓ Below"
                    : "—"}
                  status={ind.ema20 != null && lastPrice != null ? (lastPrice > ind.ema20 ? "bull" : "bear") : "neutral"}
                />
                <IndicatorPill
                  label="EMA50"
                  value={ind.ema50 != null && lastPrice != null
                    ? lastPrice > ind.ema50 ? "↑ Above" : "↓ Below"
                    : "—"}
                  status={ind.ema50 != null && lastPrice != null ? (lastPrice > ind.ema50 ? "bull" : "bear") : "neutral"}
                />
                <IndicatorPill
                  label="ATR"
                  value={ind.atr != null ? "$" + ind.atr.toFixed(0) : "—"}
                  status="neutral"
                />
                {wyckoff && (
                  <IndicatorPill
                    label="Wyckoff"
                    value={wyckoff.phase}
                    status={
                      wyckoff.phase === "Accumulation" || wyckoff.phase === "Re-Accumulation" || wyckoff.phase === "Markup" ? "bull" :
                      wyckoff.phase === "Distribution" || wyckoff.phase === "Markdown" ? "bear" : "neutral"
                    }
                  />
                )}
                {elliottResult && elliottResult.pattern !== "none" && (
                  <IndicatorPill
                    label="Elliott"
                    value={`${elliottResult.pattern === "impulse" ? "W" : "Corr"} ${elliottResult.currentWave}`}
                    status={elliottResult.direction === "bullish" ? "bull" : elliottResult.direction === "bearish" ? "bear" : "neutral"}
                  />
                )}
              </div>
            )}

            {/* Live candle tape — same width as chart */}
            {feedCandles.length >= 3 && (
              <div className="cw-feed">
                <div className="cw-feed-header">
                  <span className="cw-feed-label">
                    <span className="cw-feed-live-dot" />
                    Live Tape
                  </span>
                  <div className="cw-feed-header-right">
                    <span className="cw-feed-sub">{feedCandles.length} candles</span>
                    {candleCountdown && (
                      <div className="cw-feed-candle-close">
                        <span className="cw-feed-candle-close-label">closes in</span>
                        <span className="cw-feed-candle-close-value">{candleCountdown}</span>
                      </div>
                    )}
                  </div>
                </div>
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
              </div>
            )}
          </div>

          {/* Right: AI analysis */}
          <div className="cw-right">

            {/* ── Elliott Wave card ── */}
            {elliottResult && (() => {
              const hasPattern = elliottResult.pattern !== "none";
              return (
                <div className="cw-ai-card cw-ew-card">
                  <div className="cw-ai-header">
                    <span className="cw-ai-badge cw-ew-badge">〜 Elliott Wave</span>
                    {hasPattern && (
                      <span className={`cw-elliott-btn-badge`}>Wave {elliottResult.currentWave}</span>
                    )}
                  </div>
                  <button
                    className={`cw-elliott-btn${showElliott && hasPattern ? " cw-elliott-btn--active" : ""}${!hasPattern ? " cw-elliott-btn--unavailable" : ""}`}
                    onClick={hasPattern ? toggleElliott : undefined}
                    title={!hasPattern ? "No wave pattern detected — try 4H, Daily or Weekly" : undefined}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 17 8 11 13 16 22 7"/></svg>
                    {showElliott && hasPattern ? "✕ Hide Elliott Wave" : "Show on Chart"}
                    {!hasPattern && <span className="cw-elliott-btn-badge cw-elliott-btn-badge--none">No pattern</span>}
                  </button>
                  <p className="cw-elliott-hint">
                    Best on <strong>4H · Daily · Weekly</strong> — noisy below 1H
                  </p>

              {/* ── Elliott Wave Analysis Narrative ── */}
              {elliottResult && elliottResult.pattern !== "none" && (() => {
                const ew = elliottResult;
                const fmt = (p: number) => "$" + p.toLocaleString(undefined, { maximumFractionDigits: 0 });
                const pct = (a: number, b: number) => Math.abs((b - a) / a * 100).toFixed(1) + "%";

                // Build wave rows from pivot pairs
                const waveRows = ew.pivots.slice(1).map((p, i) => {
                  const prev = ew.pivots[i];
                  const up = p.price > prev.price;
                  const waveDescriptions: Record<string, string> = {
                    "1": "Impulse — first push",
                    "2": `Retraced ${pct(p.price, prev.price)} of W1`,
                    "3": `Extended impulse — ${up ? "+" : "-"}${pct(prev.price, p.price)} move`,
                    "4": `Consolidation — retraced ${pct(p.price, prev.price)} of W3`,
                    "5": "Final push — impulse complete",
                    "A": "Correction wave A",
                    "B": `Rebound — recovered ${pct(prev.price, p.price)}`,
                    "C": `Wave C — final correction leg`,
                  };
                  return { label: p.label, up, pct: pct(prev.price, p.price), price: p.price, desc: waveDescriptions[p.label] ?? "" };
                });

                // Situation + outlook text
                let situation = "";
                let outlook = "";
                if (ew.pattern === "impulse" && ew.complete) {
                  const last = ew.pivots[ew.pivots.length - 1];
                  situation = `5-wave ${ew.direction} impulse completed its full structure at ${fmt(last.price)}. Classic Elliott theory says this exhausts the trend — a corrective A-B-C move typically follows before the next impulse.`;
                  const mainProj = ew.projections.find(p => p.isMain);
                  const cProj = ew.projections.find(p => p.label.startsWith("C"));
                  outlook = `Watch for a Wave A ${ew.direction === "bullish" ? "pullback" : "bounce"} toward ${mainProj ? fmt(mainProj.price) : "—"}. If that level holds, expect a Wave B rebound before Wave C targets ${cProj ? fmt(cProj.price) : "—"}. A break of Wave C = A signals trend continuation.`;
                } else if (ew.pattern === "impulse" && ew.currentWave === "5") {
                  const w4 = ew.pivots[4];
                  const mainProj = ew.projections.find(p => p.isMain);
                  const minProj = ew.projections.find(p => p.label.includes("min"));
                  situation = `Waves 1–4 are complete. Wave 4 ${ew.direction === "bullish" ? "dipped" : "peaked"} at ${fmt(w4.price)}, respecting the no-overlap rule. Wave 5 — the final impulse leg — is now forming.`;
                  outlook = `Minimum Wave 5 target (0.618× W1) is ${minProj ? fmt(minProj.price) : "—"}. The classic target (1.618× W1) sits at ${mainProj ? fmt(mainProj.price) : "—"}. Look for ${ew.direction === "bullish" ? "bullish" : "bearish"} momentum confirmation before entries — Wave 5s can be extended or truncated.`;
                } else if (ew.pattern === "impulse" && ew.currentWave === "4") {
                  const w3 = ew.pivots[ew.pivots.length - 1];
                  const t382 = ew.projections.find(p => p.label.includes("38.2"));
                  const t618 = ew.projections.find(p => p.label.includes("61.8"));
                  const w5proj = ew.projections.find(p => p.label.includes("W5"));
                  situation = `Wave 3 peaked at ${fmt(w3.price)} — the strongest wave of the sequence. Wave 4 correction is now underway. It must NOT enter Wave 1 territory.`;
                  outlook = `Key Wave 4 support: ${t382 ? fmt(t382.price) : "—"} (38.2%) to ${t618 ? fmt(t618.price) : "—"} (61.8%). Once Wave 4 completes, expect Wave 5 to target ${w5proj ? fmt(w5proj.price) : "—"}. A shallow Wave 4 (38.2%) often signals a strong Wave 5.`;
                } else if (ew.pattern === "corrective") {
                  const pc = ew.pivots[ew.pivots.length - 1];
                  const mainProj = ew.projections.find(p => p.isMain);
                  const full = ew.projections.find(p => p.label.includes("100"));
                  situation = `A-B-C ${ew.direction} correction completed at ${fmt(pc.price)}. Three-wave corrections exhaust counter-trend moves — a reversal back into the primary trend is expected.`;
                  outlook = `Primary reversal target: ${mainProj ? fmt(mainProj.price) : "—"} (61.8% recovery). Full recovery to ${full ? fmt(full.price) : "—"} (100%) would signal a fresh impulse is underway. Watch for a strong ${ew.direction === "bearish" ? "bullish" : "bearish"} candle to confirm the reversal.`;
                }

                return (
                  <div className="cw-ew-analysis">
                    <div className="cw-ew-analysis-header">
                      Elliott Wave Analysis
                      <span className={`cw-ew-dir cw-ew-dir--${ew.direction}`}>
                        {ew.direction === "bullish" ? "▲ BULLISH" : ew.direction === "bearish" ? "▼ BEARISH" : "◆ NEUTRAL"}
                      </span>
                    </div>

                    {/* Wave history */}
                    <div className="cw-ew-waves">
                      {waveRows.map(r => (
                        <div key={r.label} className="cw-ew-wave-row">
                          <span className="cw-ew-wave-lbl">W{r.label}</span>
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
                        <div className="cw-ew-outlook-title">↳ Next Move</div>
                        <p className="cw-ew-outlook-text">{outlook}</p>
                        {ew.projections.length > 0 && (
                          <div className="cw-ew-targets">
                            {ew.projections.map(p => (
                              <div key={p.label} className={`cw-ew-target-row${p.isMain ? " cw-ew-target-row--main" : ""}`}>
                                <span className="cw-ew-target-lbl">{p.label}</span>
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
                      <span className="cw-mtf-label">Timeframe Alignment</span>
                      <span className={`cw-mtf-direction cw-mtf-direction--${mtf.direction}`}>
                        {mtf.direction === "long" ? "▲ LONG BIAS" : mtf.direction === "short" ? "▼ SHORT BIAS" : "◆ WAIT"}
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
            </div>
          );
        })()}

            {/* ── AI READ card ── */}
            <div className="cw-ai-card">
              <div className="cw-ai-header">
                <span className="cw-ai-badge">✦ AI READ</span>
                {pattern && (
                  <span className={`cw-pattern-tag cw-pattern-tag--${pattern.type}`}>
                    {pattern.emoji} {pattern.name}
                  </span>
                )}
              </div>

              {!aiLoading && aiRead && (
                <button
                  className={`cw-forecast-btn${showForecast ? ` cw-forecast-btn--active${aiRead.bias === "bearish" ? " cw-forecast-btn--bear" : ""}` : ""}`}
                  onClick={toggleForecast}
                >
                  {showForecast ? "✕ Hide Prediction" : "✦ Predict Next Move on Chart"}
                  {showForecast && (
                    <span className="cw-forecast-btn-bias">{aiRead.bias.toUpperCase()}</span>
                  )}
                </button>
              )}

              {aiLoading && (
                <div className="cw-ai-loading">
                  <div className="cw-ai-spinner" />
                  <span>Reading market structure…</span>
                </div>
              )}

              {!aiLoading && aiRead && (
                <>
                  <div className={`cw-bias-bar cw-bias-bar--${aiRead.bias}`}>
                    <span className="cw-bias-label">
                      {aiRead.bias === "bullish" ? "▲ BULLISH BIAS" : aiRead.bias === "bearish" ? "▼ BEARISH BIAS" : "◆ NEUTRAL"}
                      <span className="cw-bias-interval"> · {interval.label}</span>
                    </span>
                    <span className={`cw-confidence cw-confidence--${aiRead.confidence}`}>
                      {aiRead.confidence.toUpperCase()} CONF
                    </span>
                  </div>

                  {/* Conflict notice — only for sub-MTF intervals (not 1h/4h/1d/1w which are already in the MTF panel) */}
                  {mtfBiases.length > 0 && !["1h","4h","1d","1w"].includes(interval.value) && (() => {
                    const mtf = getMTFSummary(mtfBiases);
                    const aiBull = aiRead.bias === "bullish";
                    const aiBear = aiRead.bias === "bearish";
                    const conflicts = (aiBull && mtf.direction === "short") || (aiBear && mtf.direction === "long");
                    if (!conflicts) return null;
                    const htfDir = mtf.direction === "long" ? "bullish" : "bearish";
                    const isCTRBull = aiBull && mtf.direction === "short";
                    return (
                      <div className="cw-bias-conflict">
                        <div className="cw-bias-conflict-header">
                          <span className="cw-bias-conflict-icon">⚠</span>
                          <span className="cw-bias-conflict-title">Why you're seeing conflicting signals</span>
                        </div>
                        <div className="cw-bias-conflict-rows">
                          <div className="cw-bias-conflict-row">
                            <span className="cw-bias-conflict-source">{interval.label} AI</span>
                            <span className="cw-bias-conflict-read">
                              Reads <strong>{aiRead.bias}</strong> — based on candlestick patterns and momentum on your current {interval.label} chart
                            </span>
                          </div>
                          <div className="cw-bias-conflict-row">
                            <span className="cw-bias-conflict-source">HTF Trend</span>
                            <span className="cw-bias-conflict-read">
                              Reads <strong>{htfDir}</strong> — based on EMA20/50 structure across 1H · 4H · 1D · 1W
                            </span>
                          </div>
                        </div>
                        <p className="cw-bias-conflict-note">
                          Both are technically correct. A {isCTRBull ? "bullish bounce" : "bearish pullback"} can form
                          inside a larger {htfDir} trend — this is called a <strong>counter-trend move</strong>.{" "}
                          {isCTRBull
                            ? "The bounce may be short-lived before sellers reassert control."
                            : "The dip may be temporary before buyers step back in."}
                          {" "}Trade with tighter stops and reduced size.
                        </p>
                      </div>
                    );
                  })()}


                  {/* ── Macro Context ── */}
                  {macroCtx && (
                    <div className="cw-macro-panel">
                      <div className="cw-macro-panel-label">Macro Context</div>
                      <div className="cw-macro-chips">
                        {macroCtx.btcDominance != null && (
                          <div className="cw-macro-chip">
                            <span className="cw-macro-chip-key">BTC Dom</span>
                            <span className="cw-macro-chip-val">{macroCtx.btcDominance.toFixed(1)}%</span>
                          </div>
                        )}
                        {macroCtx.fundingRate != null && (
                          <div className={`cw-macro-chip cw-macro-chip--${macroCtx.fundingRate > 0.0001 ? "bear" : macroCtx.fundingRate < -0.0001 ? "bull" : "neutral"}`}>
                            <span className="cw-macro-chip-key">Funding 8h</span>
                            <span className="cw-macro-chip-val">
                              {macroCtx.fundingRate >= 0 ? "+" : ""}{(macroCtx.fundingRate * 100).toFixed(4)}%
                            </span>
                          </div>
                        )}
                        {macroCtx.oiDelta != null && (
                          <div className={`cw-macro-chip cw-macro-chip--${macroCtx.oiDelta > 0 ? "bull" : "bear"}`}>
                            <span className="cw-macro-chip-key">OI Change</span>
                            <span className="cw-macro-chip-val">
                              {macroCtx.oiDelta >= 0 ? "+" : ""}{macroCtx.oiDelta.toFixed(2)}%
                            </span>
                          </div>
                        )}
                        {macroCtx.marketStructure != null && (
                          <div className={`cw-macro-chip cw-macro-chip--${macroCtx.marketStructure === "uptrend" ? "bull" : macroCtx.marketStructure === "downtrend" ? "bear" : "neutral"}`}>
                            <span className="cw-macro-chip-key">Daily MTF</span>
                            <span className="cw-macro-chip-val">
                              {macroCtx.marketStructure === "uptrend" ? "↑ Uptrend" : macroCtx.marketStructure === "downtrend" ? "↓ Downtrend" : "→ Ranging"}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}


                  {/* ── Trade Wizard ── */}
                  <div className="cw-wizard">
                    {wizardIntent === null ? (
                      <>
                        <div className="cw-wizard-prompt">What's your play?</div>
                        <div className="cw-wizard-intents">
                          {(["buy", "sell", "long", "short"] as WizardIntent[]).map(i => (
                            <button key={i} className="cw-wizard-intent-btn" onClick={() => setWizardIntent(i)}>
                              <span className="cw-wizard-intent-icon">{i === "buy" ? "↑" : i === "sell" ? "↓" : i === "long" ? "▲" : "▼"}</span>
                              <span>{i === "buy" ? "Buy" : i === "sell" ? "Sell" : i === "long" ? "Long" : "Short"}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (() => {
                      const rec = getWizardRec(wizardIntent, aiRead, mtfBiases, ind, lastPrice);
                      const fmt = (p: number) => "$" + p.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
                      const pct = (a: number, b: number) => ((Math.abs(a - b) / b) * 100).toFixed(1) + "%";
                      return (
                        <div className={`cw-wizard-rec cw-wizard-rec--${rec.verdict}`}>
                          <div className="cw-wizard-rec-header">
                            <span className="cw-wizard-rec-verdict">
                              {rec.verdict === "go" ? "✅ GO" : rec.verdict === "wait" ? "⏸ WAIT" : "🚫 AVOID"}
                            </span>
                            <span className="cw-wizard-rec-headline">{rec.headline}</span>
                            <button className="cw-wizard-reset-btn" onClick={() => setWizardIntent(null)} title="Change intent">✕</button>
                          </div>
                          <p className="cw-wizard-rec-body">{rec.body}</p>

                          {rec.levels && (
                            <div className="cw-wizard-levels">
                              <div className="cw-wizard-levels-header">
                                <span className="cw-wizard-levels-label">Price levels</span>
                                <span className="cw-wizard-levels-interval">based on {interval.label} chart</span>
                              </div>
                              <div className="cw-wizard-level cw-wizard-level--entry">
                                <span className="cw-wizard-level-tag">Entry</span>
                                <span className="cw-wizard-level-price">{fmt(rec.levels.entry)}</span>
                                <span className="cw-wizard-level-sub">market price</span>
                              </div>
                              <div className="cw-wizard-level cw-wizard-level--sl">
                                <span className="cw-wizard-level-tag">Stop Loss</span>
                                <span className="cw-wizard-level-price">{fmt(rec.levels.stopLoss)}</span>
                                <span className="cw-wizard-level-sub cw-wizard-level-sub--sl">
                                  -{pct(rec.levels.entry, rec.levels.stopLoss)}
                                </span>
                              </div>
                              <div className="cw-wizard-level cw-wizard-level--tp">
                                <span className="cw-wizard-level-tag">Target</span>
                                <span className="cw-wizard-level-price">{fmt(rec.levels.target)}</span>
                                <span className="cw-wizard-level-sub cw-wizard-level-sub--tp">
                                  +{pct(rec.levels.entry, rec.levels.target)}
                                </span>
                              </div>
                              <div className="cw-wizard-level cw-wizard-level--rr">
                                <span className="cw-wizard-level-tag">R/R</span>
                                <span className={`cw-wizard-level-price cw-wizard-level-rr-val${rec.levels.rr >= 2 ? "--good" : rec.levels.rr >= 1 ? "--ok" : "--bad"}`}>
                                  {rec.levels.rr.toFixed(1)}:1
                                </span>
                                <span className="cw-wizard-level-sub">{rec.levels.rr >= 2 ? "favorable" : rec.levels.rr >= 1 ? "acceptable" : "tight"}</span>
                              </div>

                              {/* Key S/R levels */}
                              {(rec.levels.resistance.length > 0 || rec.levels.support.length > 0) && (
                                <div className="cw-wizard-sr">
                                  {rec.levels.resistance.map((r, i) => (
                                    <div key={"r" + i} className="cw-wizard-sr-row cw-wizard-sr-row--r">
                                      <span className="cw-wizard-sr-tag">R{i + 1}</span>
                                      <span className="cw-wizard-sr-price">{fmt(r)}</span>
                                      <span className="cw-wizard-sr-pct">+{pct(lastPrice!, r)}</span>
                                    </div>
                                  ))}
                                  {rec.levels.support.map((s, i) => (
                                    <div key={"s" + i} className="cw-wizard-sr-row cw-wizard-sr-row--s">
                                      <span className="cw-wizard-sr-tag">S{i + 1}</span>
                                      <span className="cw-wizard-sr-price">{fmt(s)}</span>
                                      <span className="cw-wizard-sr-pct">-{pct(lastPrice!, s)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {rec.risk && <div className="cw-wizard-rec-risk">⚠ {rec.risk}</div>}
                        </div>
                      );
                    })()}
                  </div>


                  {/* ── Likely Scenario ── */}
                  {aiRead.scenario && (
                    <div className="cw-scenario">
                      <div className="cw-scenario-headline">{aiRead.scenario.headline}</div>
                      <div className="cw-scenario-rows">
                        <div className="cw-scenario-row cw-scenario-row--bull">
                          <span className="cw-scenario-side">▲ Bull case</span>
                          <span className="cw-scenario-text">{aiRead.scenario.bullCase}</span>
                        </div>
                        <div className="cw-scenario-row cw-scenario-row--bear">
                          <span className="cw-scenario-side">▼ Bear case</span>
                          <span className="cw-scenario-text">{aiRead.scenario.bearCase}</span>
                        </div>
                        <div className="cw-scenario-row cw-scenario-row--trigger">
                          <span className="cw-scenario-side">⚡ Watch for</span>
                          <span className="cw-scenario-text">{aiRead.scenario.trigger}</span>
                        </div>
                      </div>
                      <div className={`cw-scenario-prob cw-scenario-prob--${aiRead.scenario.probability === "bulls favored" ? "bull" : aiRead.scenario.probability === "bears favored" ? "bear" : "neutral"}`}>
                        {aiRead.scenario.probability}
                      </div>
                    </div>
                  )}


                  <div className="cw-ai-section">
                    <div className="cw-ai-section-label">What smart money is doing</div>
                    <p className="cw-ai-text">{aiRead.mmReading}</p>
                    <div className="cw-ai-section-label">Next move</div>
                    <p className="cw-ai-text">{aiRead.nextMove}</p>
                  </div>

                  {(aiRead.keyLevels.length > 0 || (ind && (ind.resistance.length > 0 || ind.support.length > 0))) && (
                    <div className="cw-ai-section">
                      {aiRead.keyLevels.length > 0 && (
                        <div className="cw-levels">
                          <div className="cw-ai-section-label">Key levels</div>
                          {aiRead.keyLevels.map((lv, i) => (
                            <div key={i} className={`cw-level-row cw-level-row--${lv.side}`}>
                              <span className="cw-level-label">{lv.label}</span>
                              <span className="cw-level-price">${lv.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                            </div>
                          ))}
                        </div>
                      )}

                  {/* S/R from indicators */}
                  {ind && (ind.resistance.length > 0 || ind.support.length > 0) && (
                    <div className="cw-levels">
                      <div className="cw-ai-section-label">Chart levels</div>
                      {ind.resistance.slice(0, 2).map((r, i) => (
                        <div key={"r" + i} className="cw-level-row cw-level-row--above">
                          <div className="cw-level-tag">
                            <span className="cw-level-label">R{i + 1}</span>
                            <span className="cw-level-sublabel">{i === 0 ? "nearest resistance" : "2nd resistance"}</span>
                          </div>
                          <span className="cw-level-price">${r.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                        </div>
                      ))}
                      {ind.support.slice(0, 2).map((s, i) => (
                        <div key={"s" + i} className="cw-level-row cw-level-row--below">
                          <div className="cw-level-tag">
                            <span className="cw-level-label">S{i + 1}</span>
                            <span className="cw-level-sublabel">{i === 0 ? "nearest support" : "2nd support"}</span>
                          </div>
                          <span className="cw-level-price">${s.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                        </div>
                      ))}
                    </div>
                  )}
                    </div>
                  )}

                  {/* ── Our Take ─────────────────────────────────────────── */}
                  {predData?.ourTake && (
                    <div className={`cw-our-take cw-our-take--${predData.ourTakeAction ?? "watch"}`}>
                      <div className="cw-our-take-header">
                        <span className="cw-our-take-eyebrow">✦ Our Take</span>
                        {predData.ourTakeAction && (
                          <span className={`cw-our-take-action cw-our-take-action--${predData.ourTakeAction}`}>
                            {predData.ourTakeAction.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <p className="cw-our-take-text">{predData.ourTake}</p>

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

                        if (ew.pattern === "impulse" && ew.complete) {
                          const isBull = ew.direction === "bullish";
                          nextDir = isBull ? "down" : "up";
                          nextSummary = `5-wave ${ew.direction} impulse is done. Expect a counter-trend A-B-C ${isBull ? "correction" : "bounce"}.`;
                          actionHint = isBull
                            ? `Look for short entries if price bounces into ${mainProj ? fmt(mainProj.price) : "resistance"} — that's where the correction could stall.`
                            : `Look for long entries near current levels — the bounce targets ${mainProj ? fmt(mainProj.price) : "resistance"}.`;
                        } else if (ew.pattern === "impulse" && ew.currentWave === "5") {
                          const isBull = ew.direction === "bullish";
                          nextDir = isBull ? "up" : "down";
                          nextSummary = `Wave 4 complete. Wave 5 — the final ${ew.direction} leg — is launching now.`;
                          actionHint = isBull
                            ? `Ride the wave toward ${mainProj ? fmt(mainProj.price) : "target"}. Tighten stops if price stalls near there — wave 5s often end abruptly.`
                            : `Bearish momentum likely continues to ${mainProj ? fmt(mainProj.price) : "target"}. Avoid longs until wave 5 completes.`;
                        } else if (ew.pattern === "impulse" && ew.currentWave === "4") {
                          const isBull = ew.direction === "bullish";
                          const t382 = ew.projections.find(p => p.label.includes("38.2"));
                          const t618 = ew.projections.find(p => p.label.includes("61.8"));
                          nextDir = isBull ? "down" : "up";
                          nextSummary = `Wave 3 finished. Wave 4 pullback in progress — ${isBull ? "dip" : "pop"} expected before the final Wave 5 push.`;
                          actionHint = isBull
                            ? `Watch ${t382 ? fmt(t382.price) : "support"}–${t618 ? fmt(t618.price) : "support"} for a Wave 4 low — that zone is a high-probability long entry for the Wave 5 rally.`
                            : `Watch ${t382 ? fmt(t382.price) : "resistance"}–${t618 ? fmt(t618.price) : "resistance"} for the Wave 4 peak — a rejection there sets up the Wave 5 drop.`;
                        } else if (ew.pattern === "corrective") {
                          const isBear = ew.direction === "bearish";
                          nextDir = isBear ? "up" : "down";
                          nextSummary = `A-B-C ${ew.direction} correction complete. Counter-trend reversal expected.`;
                          actionHint = isBear
                            ? `A-B-C correction is done — new ${isBear ? "bullish" : "bearish"} impulse likely starting. ${mainProj ? fmt(mainProj.price) : "—"} is the first target.`
                            : `Correction finished — price should reverse. First target: ${mainProj ? fmt(mainProj.price) : "—"}.`;
                        }

                        if (!nextSummary) return null;

                        return (
                          <div className="cw-our-take-ew">
                            <div className="cw-our-take-ew-header">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 17 8 11 13 16 22 7"/></svg>
                              Elliott Wave · Wave {ew.currentWave}
                              <span className={`cw-our-take-ew-dir cw-our-take-ew-dir--${nextDir}`}>
                                {nextDir === "up" ? "▲ UP" : "▼ DOWN"}
                              </span>
                            </div>
                            <p className="cw-our-take-ew-summary">{nextSummary}</p>
                            {allProj.length > 0 && (
                              <div className="cw-our-take-ew-levels">
                                {allProj.map(p => {
                                  const dist = lastPrice > 0 ? ((p.price - lastPrice) / lastPrice * 100) : 0;
                                  return (
                                    <div key={p.label} className={`cw-our-take-ew-level${p.isMain ? " cw-our-take-ew-level--main" : ""}`}>
                                      <span className="cw-our-take-ew-level-lbl">{p.label}</span>
                                      <span className="cw-our-take-ew-level-price" style={{ color: p.color }}>{fmt(p.price)}</span>
                                      <span className={`cw-our-take-ew-level-dist${dist >= 0 ? " up" : " dn"}`}>
                                        {dist >= 0 ? "+" : ""}{dist.toFixed(1)}%
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            <p className="cw-our-take-ew-hint">{actionHint}</p>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* ── Price Range Forecast ──────────────────────────────── */}
                  {predData?.timeframes && (() => {
                    const TF = ["8h", "12h", "16h", "24h"] as const;
                    const currentPrice = candles[candles.length - 1]?.close ?? 0;
                    const fmtP = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
                    return (
                      <div className="cw-ai-section cw-range-forecast">
                        <div className="cw-ai-section-label">Price Range Forecast</div>
                        <div className="cw-range-rows">
                          {TF.map(tf => {
                            const r = predData.timeframes![tf];
                            const span = r.high - r.low;
                            const cpTop = currentPrice > 0 && span > 0
                              ? Math.max(1, Math.min(99, ((r.high - currentPrice) / span) * 100))
                              : null;
                            const outOfRange = currentPrice > 0 && (currentPrice < r.low || currentPrice > r.high);
                            return (
                              <div key={tf} className="cw-range-row">
                                <span className="cw-range-tf">{tf.toUpperCase()}</span>
                                <div className="cw-range-track">
                                  <div className="cw-range-fill" />
                                  {cpTop !== null && (
                                    <div className={`cw-range-needle${outOfRange ? " cw-range-needle--out" : ""}`}
                                      style={{ top: `${cpTop}%` }}
                                      title={`Current: ${fmtP(currentPrice)}`} />
                                  )}
                                </div>
                                <div className="cw-range-vals">
                                  <span className="cw-range-hi">{fmtP(r.high)}</span>
                                  <span className="cw-range-lo">{fmtP(r.low)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {currentPrice > 0 && (
                          <p className="cw-range-footer">
                            <span className="cw-range-dot" /> Current: <strong>${currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}</strong>
                          </p>
                        )}
                      </div>
                    );
                  })()}

                  {/* ── Intelligence Cards ────────────────────────────────── */}
                  {predData && (predData.priceDrivers || predData.whoIsBuying || predData.whoIsSelling || predData.marketContext || predData.keyRisks) && (
                    <div className="cw-ai-section">
                      <div className="cw-ai-section-label">Market Intelligence</div>
                      <div className="cw-intel-grid">
                        {predData.priceDrivers && (
                          <div className="cw-intel-card">
                            <div className="cw-intel-card-label">Price Drivers</div>
                            <p className="cw-intel-card-text">{predData.priceDrivers}</p>
                          </div>
                        )}
                        {predData.whoIsBuying && (
                          <div className="cw-intel-card cw-intel-card--bull">
                            <div className="cw-intel-card-label">Who's Buying</div>
                            <p className="cw-intel-card-text">{predData.whoIsBuying}</p>
                          </div>
                        )}
                        {predData.whoIsSelling && (
                          <div className="cw-intel-card cw-intel-card--bear">
                            <div className="cw-intel-card-label">Who's Selling</div>
                            <p className="cw-intel-card-text">{predData.whoIsSelling}</p>
                          </div>
                        )}
                        {predData.marketContext && (
                          <div className="cw-intel-card">
                            <div className="cw-intel-card-label">Macro & News</div>
                            <p className="cw-intel-card-text">{predData.marketContext}</p>
                          </div>
                        )}
                        {predData.keyRisks && (
                          <div className="cw-intel-card cw-intel-card--risk">
                            <div className="cw-intel-card-label">Key Risks</div>
                            <p className="cw-intel-card-text">{predData.keyRisks}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {predLoading && !predData && (
                    <div className="cw-intel-loading">
                      <div className="cw-ai-spinner" />
                      <span>Fetching market intelligence…</span>
                    </div>
                  )}

                  <p className="cw-disclaimer">Not financial advice. Trade at your own risk.</p>
                </>
              )}

              {!aiLoading && !aiRead && !loading && (
                <div className="cw-ai-empty">
                  <p>Click ↻ to run AI analysis</p>
                </div>
              )}
            </div>

          </div>
        </div>

      </div>
    </BlurGate>
  );
};
