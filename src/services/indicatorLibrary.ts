// Shared indicator catalog for every chart in the app (Trade / Chart /
// Advance chart via PriceChart, Inside the Candle via CandleWatcher).
//
// The math comes from `indicatorts` (zero-dependency, typed); this file
// only maps each indicator to what a chart needs: a category, whether it
// draws over the price ("overlay") or in its own panel under it ("pane"),
// and the lines to plot. Rendering lives in useChartIndicators.ts and the
// picker UI in IndicatorPicker.tsx.
import {
  sma, ema, dema, tema, trima, rma, vwma, psar, ichimokuCloud, dc, ce, ab, kc, vwap,
  aroon, vortex, mi, bop, qstick, cfo, apo, stoch, kdj, willr, cci, roc, ao, ppo, trix,
  rsi, macd, atr, bb, bbw, ui, mstd, po, obv, ad, cmf, cmo, mfi, fi, emv, nvi, vpt, pvo,
} from "indicatorts";

export interface IndCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type IndCategory =
  | "Moving Averages"
  | "Trend"
  | "Momentum"
  | "Oscillators"
  | "Volatility"
  | "Volume"
  | "Levels & Zones"
  | "Smart Money"
  | "My indicators";

export const IND_CATEGORIES: { key: IndCategory; blurb: string; question: string; about: string }[] = [
  {
    key: "Moving Averages", blurb: "SMA, EMA, DEMA, TEMA, VWMA…",
    question: "What are moving averages?",
    about: "Smooth out price to show the underlying trend. Price above a rising average leans bullish, below a falling one bearish. Faster averages (EMA 9/20) react quickly to turns; slower ones (100/200) act as long-term support and resistance. Crossovers between a fast and slow average are classic trend-change signals.",
  },
  {
    key: "Trend", blurb: "Ichimoku, Parabolic SAR, Aroon, Vortex…",
    question: "What do trend indicators show?",
    about: "Tell you which way the market is heading and how strong that move is. Use them to stay with the trend, spot when it's weakening, and place trailing stops — e.g. Parabolic SAR dots flip sides when the trend turns, and Ichimoku's cloud shows trend, momentum and support in one view.",
  },
  {
    key: "Momentum", blurb: "RSI, MACD, Stochastic, ROC…",
    question: "What is momentum?",
    about: "Measure how fast price is moving and whether that push is speeding up or fading. They flag overbought and oversold conditions, and divergences — price making a new high while momentum doesn't — often warn of a reversal before it shows up in price.",
  },
  {
    key: "Oscillators", blurb: "CCI, Williams %R, Awesome, PPO…",
    question: "How do oscillators work?",
    about: "Swing between fixed levels or around zero, each in its own panel. Extreme readings point to stretched moves likely to snap back; crossing the zero line confirms a shift in direction. Best in ranging markets, and as confirmation alongside a trend tool.",
  },
  {
    key: "Volatility", blurb: "Bollinger, Keltner, ATR, Donchian…",
    question: "What does volatility tell you?",
    about: "Show how much price is moving, not which way. Bands and channels widen in wild markets and tighten before big moves (a 'squeeze'). ATR-based tools help size stops and positions so a normal wiggle doesn't knock you out of a trade.",
  },
  {
    key: "Volume", blurb: "OBV, VWAP, MFI, Chaikin…",
    question: "Why does volume matter?",
    about: "Look at the money behind each move. Rising price on rising volume is a move with conviction; price rising on falling volume is suspect. VWAP marks the average price paid today — a fair-value line many traders buy and sell around.",
  },
  {
    key: "Levels & Zones", blurb: "Support / resistance, Fibonacci, gaps…",
    question: "What are levels & zones?",
    about: "Draw the prices that matter on the chart: support and resistance, Fibonacci retracements, the day's high and low, and CME gaps. These are where price often reacts — useful for entries, targets and stop placement.",
  },
  {
    key: "Smart Money", blurb: "Order blocks, FVGs, retests, patterns…",
    question: "What is Smart Money?",
    about: "Concepts used to track where large players likely bought or sold: order blocks, fair-value gaps, breaks of structure and retests, plus candlestick patterns and Wyckoff phases. They highlight zones price tends to revisit before continuing.",
  },
];

export interface IndLine {
  name: string;
  color: string;
  values: number[];
  /** "histogram" bars colored green/red by sign; "dots" = markers-only line. */
  style?: "line" | "dashed" | "histogram" | "dots";
  /** Values beyond the last candle (Ichimoku's projected cloud). */
  future?: number;
  /** Optional per-candle colors (AI indicators: "green when above, red when below"). */
  colors?: (string | undefined)[];
}

export interface IndicatorDef {
  id: string;
  name: string;
  category: IndCategory;
  kind: "overlay" | "pane";
  description: string;
  /** Candles to skip at the start while the indicator warms up. */
  warmup: number;
  /** Horizontal guide levels for pane indicators (e.g. 70 / 30). */
  levels?: number[];
  needsVolume?: boolean;
  compute: (c: Cols) => IndLine[];
}

interface Cols {
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export function toCols(candles: IndCandle[]): Cols {
  return {
    o: candles.map((x) => x.open),
    h: candles.map((x) => x.high),
    l: candles.map((x) => x.low),
    c: candles.map((x) => x.close),
    v: candles.map((x) => x.volume ?? 0),
  };
}

// Palette — distinct from the existing EMA/MA colors on the charts.
const C = {
  blue: "#3b82f6", cyan: "#06b6d4", teal: "#14b8a6", green: "#22c55e", lime: "#84cc16",
  amber: "#f59e0b", orange: "#f97316", red: "#ef4444", pink: "#ec4899", purple: "#a855f7",
  violet: "#8b5cf6", indigo: "#6366f1", slate: "#94a3b8", yellow: "#eab308",
};

const maDef = (id: string, name: string, period: number, color: string, fn: (c: Cols) => number[], description: string): IndicatorDef => ({
  id, name, category: "Moving Averages", kind: "overlay", description, warmup: period,
  compute: (c) => [{ name, color, values: fn(c) }],
});

// Stochastic RSI (14, 14, 3, 3) — not in the library, built on its RSI.
function stochRsi(closes: number[]): { k: number[]; d: number[] } {
  const r = rsi(closes, { period: 14 });
  const raw = r.map((_, i) => {
    if (i < 13) return NaN;
    const win = r.slice(i - 13, i + 1);
    const lo = Math.min(...win);
    const hi = Math.max(...win);
    return hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
  });
  const avg3 = (a: number[]) => a.map((_, i) => (i < 2 ? NaN : (a[i] + a[i - 1] + a[i - 2]) / 3));
  const k = avg3(raw);
  return { k, d: avg3(k) };
}

export const INDICATORS: IndicatorDef[] = [
  // ── Moving Averages (over the price) ─────────────────────────────────
  maDef("sma9", "SMA 9", 9, C.cyan, (c) => sma(c.c, { period: 9 }), "Simple average of the last 9 closes — very short-term trend."),
  maDef("sma100", "SMA 100", 100, C.teal, (c) => sma(c.c, { period: 100 }), "Simple average of the last 100 closes — long-term trend."),
  maDef("ema9", "EMA 9", 9, C.lime, (c) => ema(c.c, { period: 9 }), "Exponential average weighting recent closes — fast trend line."),
  maDef("ema100", "EMA 100", 100, C.amber, (c) => ema(c.c, { period: 100 }), "Exponential 100 — a common long-term dynamic support/resistance."),
  maDef("dema20", "DEMA 20", 20, C.pink, (c) => dema(c.c, { period: 20 }), "Double EMA — less lag than a plain EMA."),
  maDef("tema20", "TEMA 20", 20, C.violet, (c) => tema(c.c, { period: 20 }), "Triple EMA — even less lag, reacts quickly to turns."),
  maDef("trima20", "TRIMA 20", 20, C.indigo, (c) => trima(c.c, { period: 20 }), "Triangular average — extra-smooth, weights the middle of the window."),
  maDef("rma14", "RMA 14 (Wilder)", 14, C.orange, (c) => rma(c.c, { period: 14 }), "Wilder's smoothing — the average RSI and ATR are built on."),
  {
    id: "vwma20", name: "VWMA 20", category: "Moving Averages", kind: "overlay", warmup: 20, needsVolume: true,
    description: "Volume-weighted average — heavier-volume candles count more.",
    compute: (c) => [{ name: "VWMA 20", color: C.blue, values: vwma(c.c, c.v, { period: 20 }) }],
  },

  // ── Trend ────────────────────────────────────────────────────────────
  {
    id: "ichimoku", name: "Ichimoku Cloud", category: "Trend", kind: "overlay", warmup: 52,
    description: "Conversion, base and the leading cloud — trend, momentum and support in one view.",
    compute: (c) => {
      const r = ichimokuCloud(c.h, c.l, c.c);
      const n = c.c.length;
      // The library pads the forward-shifted cloud with zeros — not prices.
      const gap = (a: number[]) => a.map((v) => (v === 0 ? NaN : v));
      r.ssa = gap(r.ssa);
      r.ssb = gap(r.ssb);
      r.tenkan = gap(r.tenkan);
      r.kijun = gap(r.kijun);
      return [
        { name: "Conversion", color: C.blue, values: r.tenkan.slice(0, n) },
        { name: "Base", color: C.red, values: r.kijun.slice(0, n) },
        { name: "Lead A", color: C.green, values: r.ssa, style: "dashed", future: r.ssa.length - n },
        { name: "Lead B", color: C.orange, values: r.ssb, style: "dashed", future: r.ssb.length - n },
      ];
    },
  },
  {
    id: "psar", name: "Parabolic SAR", category: "Trend", kind: "overlay", warmup: 2,
    description: "Dots under price in uptrends, above in downtrends — a trailing stop guide.",
    compute: (c) => [{ name: "SAR", color: C.purple, values: psar(c.h, c.l, c.c).psarResult, style: "dots" }],
  },
  {
    id: "aroon", name: "Aroon", category: "Trend", kind: "pane", warmup: 25, levels: [70, 30],
    description: "How recently price made a 25-bar high vs low — trend strength and changes.",
    compute: (c) => { const r = aroon(c.h, c.l); return [{ name: "Up", color: C.green, values: r.up }, { name: "Down", color: C.red, values: r.down }]; },
  },
  {
    id: "vortex", name: "Vortex", category: "Trend", kind: "pane", warmup: 14, levels: [1],
    description: "+VI above −VI = uptrend; crossovers flag trend changes.",
    compute: (c) => { const r = vortex(c.h, c.l, c.c); return [{ name: "+VI", color: C.green, values: r.plus }, { name: "−VI", color: C.red, values: r.minus }]; },
  },
  {
    id: "massindex", name: "Mass Index", category: "Trend", kind: "pane", warmup: 40, levels: [27, 26.5],
    description: "Range expansion — a bulge above 27 then back under 26.5 warns of a reversal.",
    compute: (c) => [{ name: "Mass Index", color: C.violet, values: mi(c.h, c.l) }],
  },
  {
    id: "bop", name: "Balance of Power", category: "Trend", kind: "pane", warmup: 1, levels: [0],
    description: "Buyers vs sellers inside each candle (close vs open over the range).",
    compute: (c) => [{ name: "BOP", color: C.teal, values: bop(c.o, c.h, c.l, c.c), style: "histogram" }],
  },
  {
    id: "qstick", name: "Qstick", category: "Trend", kind: "pane", warmup: 14, levels: [0],
    description: "Average candle body — positive means mostly green candles.",
    compute: (c) => [{ name: "Qstick", color: C.cyan, values: qstick(c.o, c.c) }],
  },
  {
    id: "cfo", name: "Chande Forecast", category: "Trend", kind: "pane", warmup: 4, levels: [0],
    description: "Percent gap between price and its linear-regression forecast.",
    compute: (c) => [{ name: "CFO", color: C.indigo, values: cfo(c.c) }],
  },
  {
    id: "apo", name: "Absolute Price Osc", category: "Trend", kind: "pane", warmup: 30, levels: [0],
    description: "Fast EMA minus slow EMA in price terms — trend direction and strength.",
    compute: (c) => [{ name: "APO", color: C.blue, values: apo(c.c) }],
  },

  // ── Momentum ─────────────────────────────────────────────────────────
  {
    id: "rsi", name: "RSI (14)", category: "Momentum", kind: "pane", warmup: 14, levels: [70, 30],
    description: "Relative Strength Index — over 70 overbought, under 30 oversold.",
    compute: (c) => [{ name: "RSI", color: C.violet, values: rsi(c.c) }],
  },
  {
    id: "stochrsi", name: "Stoch RSI", category: "Momentum", kind: "pane", warmup: 32, levels: [80, 20],
    description: "Stochastic of RSI (14,14,3,3) — fast overbought / oversold turns.",
    compute: (c) => { const r = stochRsi(c.c); return [{ name: "%K", color: C.blue, values: r.k }, { name: "%D", color: C.orange, values: r.d }]; },
  },
  {
    id: "macd", name: "MACD (12, 26, 9)", category: "Momentum", kind: "pane", warmup: 35, levels: [0],
    description: "Moving Average Convergence Divergence — line vs signal crossovers.",
    compute: (c) => {
      const r = macd(c.c);
      return [
        { name: "Hist", color: C.slate, values: r.macdLine.map((v, i) => v - r.signalLine[i]), style: "histogram" },
        { name: "MACD", color: C.blue, values: r.macdLine },
        { name: "Signal", color: C.orange, values: r.signalLine },
      ];
    },
  },
  {
    id: "stoch", name: "Stochastic", category: "Momentum", kind: "pane", warmup: 17, levels: [80, 20],
    description: "Close vs the 14-bar range (%K) and its average (%D).",
    compute: (c) => { const r = stoch(c.h, c.l, c.c); return [{ name: "%K", color: C.blue, values: r.k }, { name: "%D", color: C.orange, values: r.d }]; },
  },
  {
    id: "kdj", name: "KDJ", category: "Momentum", kind: "pane", warmup: 15, levels: [80, 20],
    description: "Stochastic with a J line that leads turns — popular in crypto.",
    compute: (c) => { const r = kdj(c.h, c.l, c.c); return [{ name: "K", color: C.blue, values: r.k }, { name: "D", color: C.orange, values: r.d }, { name: "J", color: C.purple, values: r.j }]; },
  },
  {
    id: "roc", name: "Rate of Change", category: "Momentum", kind: "pane", warmup: 12, levels: [0],
    description: "Percent change vs 12 candles ago — momentum speed.",
    compute: (c) => [{ name: "ROC", color: C.teal, values: roc(c.c, { period: 12 }) }],
  },
  {
    id: "trix", name: "TRIX", category: "Momentum", kind: "pane", warmup: 45, levels: [0],
    description: "Rate of change of a triple-smoothed EMA — filters out noise.",
    compute: (c) => [{ name: "TRIX", color: C.pink, values: trix(c.c, { period: 15 }) }],
  },

  // ── Oscillators ──────────────────────────────────────────────────────
  {
    id: "cci", name: "CCI (20)", category: "Oscillators", kind: "pane", warmup: 20, levels: [100, -100],
    description: "Commodity Channel Index — beyond ±100 is a strong move.",
    compute: (c) => [{ name: "CCI", color: C.amber, values: cci(c.h, c.l, c.c) }],
  },
  {
    id: "willr", name: "Williams %R", category: "Oscillators", kind: "pane", warmup: 14, levels: [-20, -80],
    description: "Close vs 14-bar high — above −20 overbought, below −80 oversold.",
    compute: (c) => [{ name: "%R", color: C.cyan, values: willr(c.h, c.l, c.c) }],
  },
  {
    id: "ao", name: "Awesome Oscillator", category: "Oscillators", kind: "pane", warmup: 34, levels: [0],
    description: "5 vs 34-bar midpoint average — momentum histogram.",
    compute: (c) => [{ name: "AO", color: C.green, values: ao(c.h, c.l), style: "histogram" }],
  },
  {
    id: "ppo", name: "PPO", category: "Oscillators", kind: "pane", warmup: 35, levels: [0],
    description: "Percentage Price Oscillator — MACD in percent, comparable across coins.",
    compute: (c) => {
      const r = ppo(c.c);
      return [
        { name: "Hist", color: C.slate, values: r.histogram, style: "histogram" },
        { name: "PPO", color: C.blue, values: r.ppoResult },
        { name: "Signal", color: C.orange, values: r.signal },
      ];
    },
  },
  {
    id: "po", name: "Projection Oscillator", category: "Oscillators", kind: "pane", warmup: 17, levels: [80, 20],
    description: "Where price sits inside its regression-projected band.",
    compute: (c) => { const r = po(c.h, c.l, c.c); return [{ name: "PO", color: C.blue, values: r.poResult }, { name: "Signal", color: C.orange, values: r.spoResult }]; },
  },

  // ── Volatility ───────────────────────────────────────────────────────
  {
    id: "keltner", name: "Keltner Channel", category: "Volatility", kind: "overlay", warmup: 20,
    description: "EMA with ATR-based bands — breakouts and trend-riding.",
    compute: (c) => { const r = kc(c.h, c.l, c.c); return [{ name: "KC Upper", color: C.teal, values: r.upper }, { name: "KC Mid", color: C.slate, values: r.middle, style: "dashed" }, { name: "KC Lower", color: C.teal, values: r.lower }]; },
  },
  {
    id: "donchian", name: "Donchian Channel", category: "Volatility", kind: "overlay", warmup: 20,
    description: "Highest and lowest close of 20 candles — classic breakout channel.",
    compute: (c) => { const r = dc(c.c, { period: 20 }); return [{ name: "DC Upper", color: C.blue, values: r.upper }, { name: "DC Mid", color: C.slate, values: r.middle, style: "dashed" }, { name: "DC Lower", color: C.blue, values: r.lower }]; },
  },
  {
    id: "accbands", name: "Acceleration Bands", category: "Volatility", kind: "overlay", warmup: 20,
    description: "Bands that widen with momentum — closes outside hint at acceleration.",
    compute: (c) => { const r = ab(c.h, c.l, c.c); return [{ name: "AB Upper", color: C.purple, values: r.upper }, { name: "AB Mid", color: C.slate, values: r.middle, style: "dashed" }, { name: "AB Lower", color: C.purple, values: r.lower }]; },
  },
  {
    id: "chandelier", name: "Chandelier Exit", category: "Volatility", kind: "overlay", warmup: 22,
    description: "ATR trailing stops for longs and shorts.",
    compute: (c) => { const r = ce(c.h, c.l, c.c); return [{ name: "Long stop", color: C.green, values: r.long, style: "dashed" }, { name: "Short stop", color: C.red, values: r.short, style: "dashed" }]; },
  },
  {
    id: "atr", name: "ATR (14)", category: "Volatility", kind: "pane", warmup: 14,
    description: "Average True Range — how much price typically moves per candle.",
    compute: (c) => [{ name: "ATR", color: C.orange, values: atr(c.h, c.l, c.c).atrLine }],
  },
  {
    id: "bbw", name: "Bollinger Width", category: "Volatility", kind: "pane", warmup: 20,
    description: "Band width — low readings mean a squeeze before a bigger move.",
    compute: (c) => [{ name: "BB Width", color: C.pink, values: bbw(bb(c.c)).width }],
  },
  {
    id: "ulcer", name: "Ulcer Index", category: "Volatility", kind: "pane", warmup: 28,
    description: "Downside volatility — depth and length of drawdowns.",
    compute: (c) => [{ name: "Ulcer", color: C.red, values: ui(c.c) }],
  },
  {
    id: "stddev", name: "Standard Deviation", category: "Volatility", kind: "pane", warmup: 20,
    description: "20-candle standard deviation of closes — raw volatility.",
    compute: (c) => [{ name: "StdDev", color: C.indigo, values: mstd(c.c, { period: 20 }) }],
  },

  // ── Volume ───────────────────────────────────────────────────────────
  {
    id: "vwap", name: "VWAP", category: "Volume", kind: "overlay", warmup: 14, needsVolume: true,
    description: "Volume-weighted average price — the fair-value line traders watch.",
    compute: (c) => [{ name: "VWAP", color: C.yellow, values: vwap(c.c, c.v) }],
  },
  {
    id: "obv", name: "On-Balance Volume", category: "Volume", kind: "pane", warmup: 1, needsVolume: true,
    description: "Running volume total — rising OBV confirms buying pressure.",
    compute: (c) => [{ name: "OBV", color: C.blue, values: obv(c.c, c.v) }],
  },
  {
    id: "mfi", name: "Money Flow Index", category: "Volume", kind: "pane", warmup: 14, levels: [80, 20], needsVolume: true,
    description: "Volume-weighted RSI — over 80 overbought, under 20 oversold.",
    compute: (c) => [{ name: "MFI", color: C.green, values: mfi(c.h, c.l, c.c, c.v) }],
  },
  {
    id: "cmf", name: "Chaikin Money Flow", category: "Volume", kind: "pane", warmup: 20, levels: [0], needsVolume: true,
    description: "Buying vs selling pressure over 20 candles.",
    compute: (c) => [{ name: "CMF", color: C.teal, values: cmf(c.h, c.l, c.c, c.v), style: "histogram" }],
  },
  {
    id: "chaikinosc", name: "Chaikin Oscillator", category: "Volume", kind: "pane", warmup: 10, levels: [0], needsVolume: true,
    description: "Momentum of the accumulation/distribution line.",
    compute: (c) => [{ name: "Chaikin", color: C.amber, values: cmo(c.h, c.l, c.c, c.v).cmoResult }],
  },
  {
    id: "adl", name: "Accumulation / Distribution", category: "Volume", kind: "pane", warmup: 1, needsVolume: true,
    description: "Volume flowing in (closes near highs) vs out (closes near lows).",
    compute: (c) => [{ name: "A/D", color: C.purple, values: ad(c.h, c.l, c.c, c.v) }],
  },
  {
    id: "force", name: "Force Index", category: "Volume", kind: "pane", warmup: 13, levels: [0], needsVolume: true,
    description: "Price change × volume — strength behind moves.",
    compute: (c) => [{ name: "Force", color: C.red, values: fi(c.c, c.v) }],
  },
  {
    id: "emv", name: "Ease of Movement", category: "Volume", kind: "pane", warmup: 14, levels: [0], needsVolume: true,
    description: "How easily price moves for the volume traded.",
    compute: (c) => [{ name: "EMV", color: C.cyan, values: emv(c.h, c.l, c.v) }],
  },
  {
    id: "vpt", name: "Volume Price Trend", category: "Volume", kind: "pane", warmup: 1, needsVolume: true,
    description: "Cumulative volume scaled by percent price change.",
    compute: (c) => [{ name: "VPT", color: C.indigo, values: vpt(c.c, c.v) }],
  },
  {
    id: "nvi", name: "Negative Volume Index", category: "Volume", kind: "pane", warmup: 2, needsVolume: true,
    description: "Tracks price on quieter days — where 'smart money' tends to act.",
    compute: (c) => [{ name: "NVI", color: C.slate, values: nvi(c.c, c.v) }],
  },
  {
    id: "pvo", name: "Percentage Volume Osc", category: "Volume", kind: "pane", warmup: 35, levels: [0], needsVolume: true,
    description: "Volume momentum — fast vs slow volume EMA in percent.",
    compute: (c) => {
      const r = pvo(c.v);
      return [
        { name: "Hist", color: C.slate, values: r.histogram, style: "histogram" },
        { name: "PVO", color: C.blue, values: r.pvoResult },
        { name: "Signal", color: C.orange, values: r.signal },
      ];
    },
  },
];

export const INDICATOR_BY_ID: Record<string, IndicatorDef> = Object.fromEntries(INDICATORS.map((d) => [d.id, d]));
