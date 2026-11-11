// Alt Analysis forecast — computed in code, not by the AI.
//
// 13 live signals each score -1 (bearish) … +1 (bullish), weighted by the
// prediction horizon. The weighted score tilts the expected move; the
// bear/base/bull range comes from the coin's own recent daily volatility
// (±1σ over the horizon ≈ "about 2 in 3" odds). Levels come from swing
// highs/lows on the daily chart. The AI only explains these numbers.

import { coinglass, type CandleDataPoint } from "../services/coinglass";

export type Timeframe = "1W" | "1M" | "3M" | "6M" | "1Y" | "ALL";
export type Verdict = "bull" | "bear" | "neutral";
export type SignalKey =
  | "rsi" | "macd" | "ma" | "structure" | "momentum" | "volume" | "btc"
  | "funding" | "oi" | "longShort" | "vsBtc" | "drawdown" | "cycle";

export interface AltSignal {
  key: SignalKey;
  /** Short number shown on screen ("38.2", "+4.1%"), or "" when `stateKey` says it all. */
  value: string;
  /** i18n suffix (altAnalysis2.st.<stateKey>) for a word state, e.g. "belowBoth". */
  stateKey?: string;
  verdict: Verdict;
  score: number;
  weight: number;
  /** Plain-English line for the AI prompt. */
  detail: string;
}

export interface AltForecast {
  signals: AltSignal[];
  /** Missing inputs (shown greyed out). */
  unavailable: SignalKey[];
  score: number;
  direction: "bullish" | "bearish" | "neutral";
  confidence: "high" | "medium" | "low";
  agree: number;
  against: number;
  horizonDays: number;
  base: number; bear: number; bull: number;
  baseChg: number; bearChg: number; bullChg: number;
  entryLo: number; entryHi: number; stop: number;
  supports: number[];
  resistances: number[];
}

export interface ForecastInput {
  price: number;
  tf: Timeframe;
  /** Candles of the chart's timeframe (indicators read the same chart the user sees). */
  tfCandles: CandleDataPoint[];
  /** ~1 year of daily candles: volatility, levels, drawdown, vs-BTC. */
  daily: CandleDataPoint[];
  btcDailyCloses: number[];
  /** Average 8h funding across exchanges (decimal, 0.0001 = 0.01%). */
  funding: number | null;
  fundingVenues: number;
  oiChange7d: number | null;
  longShort: number | null;
  longShortAvg30: number | null;
  marketCapB: number;
}

const HORIZON_DAYS: Record<Timeframe, number> = { "1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "ALL": 730 };

// Per-horizon weights: short horizons follow the chart and positioning,
// long horizons lean on the cycle, drawdown and relative strength.
const WEIGHTS: Record<"short" | "mid" | "long", Record<SignalKey, number>> = {
  short: { rsi: 1, macd: 1, ma: 1, structure: 0.9, momentum: 0.9, volume: 0.6, btc: 0.9, funding: 0.8, oi: 0.7, longShort: 0.6, vsBtc: 0.5, drawdown: 0.2, cycle: 0.3 },
  mid:   { rsi: 0.7, macd: 0.8, ma: 0.9, structure: 0.8, momentum: 0.6, volume: 0.5, btc: 0.9, funding: 0.5, oi: 0.5, longShort: 0.4, vsBtc: 0.7, drawdown: 0.5, cycle: 0.8 },
  long:  { rsi: 0.4, macd: 0.5, ma: 0.7, structure: 0.6, momentum: 0.3, volume: 0.3, btc: 0.8, funding: 0.3, oi: 0.3, longShort: 0.3, vsBtc: 0.8, drawdown: 0.8, cycle: 1.2 },
};
const horizonClass = (tf: Timeframe) => (tf === "1W" || tf === "1M" ? "short" : tf === "3M" ? "mid" : "long");

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const verdictOf = (s: number): Verdict => (s > 0.15 ? "bull" : s < -0.15 ? "bear" : "neutral");

export function fmtUsd(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toPrecision(4)}`;
}

export function cyclePhase(now = new Date()): { key: "cycleEarly" | "cyclePeak" | "cycleBear" | "cycleAccum"; months: number; score: number; label: string } {
  const last = new Date("2024-04-19").getTime();
  const days = (now.getTime() - last) / 86_400_000;
  const pos = days / (4 * 365.25);
  const months = Math.floor(days / 30.44);
  if (pos < 0.25) return { key: "cycleEarly", months, score: 0.6, label: "early bull phase" };
  if (pos < 0.5) return { key: "cyclePeak", months, score: 0.2, label: "peak bull phase (blow-off risk)" };
  if (pos < 0.75) return { key: "cycleBear", months, score: -0.6, label: "bear market phase" };
  return { key: "cycleAccum", months, score: 0.6, label: "accumulation / bottoming phase" };
}

/** Swing highs/lows (a bar higher/lower than `k` bars either side). */
function pivots(cs: CandleDataPoint[], k = 3) {
  const highs: number[] = [], lows: number[] = [];
  for (let i = k; i < cs.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (cs[i].high <= cs[i - j].high || cs[i].high <= cs[i + j].high) hi = false;
      if (cs[i].low >= cs[i - j].low || cs[i].low >= cs[i + j].low) lo = false;
    }
    if (hi) highs.push(cs[i].high);
    if (lo) lows.push(cs[i].low);
  }
  return { highs, lows };
}

/** Nearest two distinct levels (≥2% apart) on one side of price. */
function nearest(levels: number[], price: number, side: "below" | "above"): number[] {
  const side_ = levels.filter((l) => (side === "below" ? l < price * 0.995 : l > price * 1.005));
  side_.sort((a, b) => (side === "below" ? b - a : a - b));
  const out: number[] = [];
  for (const l of side_) {
    if (out.every((o) => Math.abs(o - l) / o > 0.02)) out.push(l);
    if (out.length === 2) break;
  }
  return out;
}

export function computeAltForecast(inp: ForecastInput): AltForecast | null {
  const { price, tf, tfCandles, daily } = inp;
  if (!(price > 0) || tfCandles.length < 10) return null;

  const W = WEIGHTS[horizonClass(tf)];
  const signals: AltSignal[] = [];
  const unavailable: SignalKey[] = [];
  const add = (key: SignalKey, score: number, value: string, detail: string, stateKey?: string) => {
    const s = clamp(score, -1, 1);
    signals.push({ key, score: s, verdict: verdictOf(s), weight: W[key], value, detail, stateKey });
  };

  const closes = tfCandles.map((c) => c.close);
  const highs = tfCandles.map((c) => c.high);
  const lows = tfCandles.map((c) => c.low);

  // 1. RSI — extremes are contrarian, the middle follows the trend.
  const rsi = coinglass.calculateRSI(closes);
  const rsiScore = rsi < 30 ? 0.8 : rsi > 70 ? -0.6 : rsi < 45 ? -0.4 : rsi > 55 ? 0.4 : 0;
  add("rsi", rsiScore, rsi.toFixed(1), `RSI(14) ${rsi.toFixed(1)}${rsi < 30 ? " — oversold" : rsi > 70 ? " — overbought" : ""}`);

  // 2. MACD histogram, scaled by price so it's comparable across coins.
  const macd = coinglass.calculateMACD(closes);
  const macdRel = (macd.histogram / price) * 100;
  add("macd", clamp(macdRel * 4, -1, 1), macd.histogram >= 0 ? "▲" : "▼",
    `MACD histogram ${macd.histogram >= 0 ? "positive (bullish)" : "negative (bearish)"}`);

  // 3. MA20 / MA50 on the chart's candles.
  const ma20 = avg(closes.slice(-20));
  const ma50 = avg(closes.slice(-50));
  const maState = price > ma20 && price > ma50 ? "aboveBoth" : price < ma20 && price < ma50 ? "belowBoth" : "between";
  add("ma", maState === "aboveBoth" ? 0.8 : maState === "belowBoth" ? -0.8 : 0, "",
    `Price ${maState === "aboveBoth" ? "above" : maState === "belowBoth" ? "below" : "between"} MA20 (${fmtUsd(ma20)}) and MA50 (${fmtUsd(ma50)})`, maState);

  // 4. Structure: last 10 vs prior 10 bars.
  if (tfCandles.length >= 20) {
    const rH = Math.max(...highs.slice(-10)), pH = Math.max(...highs.slice(-20, -10));
    const rL = Math.min(...lows.slice(-10)), pL = Math.min(...lows.slice(-20, -10));
    const st = rH > pH && rL > pL ? "higherHighs" : rH < pH && rL < pL ? "lowerLows" : "rangebound";
    add("structure", st === "higherHighs" ? 0.8 : st === "lowerLows" ? -0.8 : 0, "",
      st === "higherHighs" ? "Higher highs and higher lows" : st === "lowerLows" ? "Lower highs and lower lows" : "Mixed / range-bound structure", st);
  } else unavailable.push("structure");

  // 5. Momentum: last 5 closes vs the 5 before.
  const mom = ((avg(closes.slice(-5)) - avg(closes.slice(-10, -5))) / avg(closes.slice(-10, -5))) * 100;
  add("momentum", clamp(mom / 6, -1, 1), pct(mom), `Momentum (last 5 vs prior 5 candles) ${pct(mom)}`);

  // 6. Volume confirming (or not) the price move.
  const vols = tfCandles.map((c) => c.volume ?? 0);
  const vPrev = avg(vols.slice(-10, -5));
  if (vols.some((v) => v > 0) && vPrev > 0) {
    const vChg = ((avg(vols.slice(-5)) - vPrev) / vPrev) * 100;
    const s = vChg > 10 ? (mom >= 0 ? 0.5 : -0.5) : vChg < -10 ? (mom >= 0 ? -0.2 : 0.2) : 0;
    const why = vChg > 10
      ? (mom >= 0 ? "buyers stepping in (confirms the rise)" : "heavy selling (confirms the drop)")
      : vChg < -10
      ? (mom >= 0 ? "rise on thinning volume (weak)" : "selling pressure fading")
      : "no clear confirmation";
    add("volume", s, pct(vChg, 0), `Volume ${pct(vChg, 0)} while price ${mom >= 0 ? "rises" : "falls"} — ${why}`);
  } else unavailable.push("volume");

  // 7. BTC macro (daily).
  const b = inp.btcDailyCloses;
  if (b.length >= 50) {
    const bp = b[b.length - 1], b20 = avg(b.slice(-20)), b50 = avg(b.slice(-50));
    const st = bp > b20 && bp > b50 ? "aboveBoth" : bp < b20 && bp < b50 ? "belowBoth" : "between";
    add("btc", st === "aboveBoth" ? 0.7 : st === "belowBoth" ? -0.7 : 0, "",
      `BTC ${st === "aboveBoth" ? "above" : st === "belowBoth" ? "below" : "between"} its 20 and 50-day averages`, st);
  } else unavailable.push("btc");

  // 8. Funding — crowded longs are a contrarian bearish sign.
  if (inp.funding !== null) {
    const f = inp.funding;
    const s = f > 0.0003 ? -0.8 : f > 0.00015 ? -0.4 : f < -0.0001 ? 0.6 : f < 0 ? 0.2 : 0;
    add("funding", s, `${f >= 0 ? "+" : ""}${(f * 100).toFixed(4)}%`,
      `Average 8h funding ${(f * 100).toFixed(4)}% across ${inp.fundingVenues} exchange${inp.fundingVenues === 1 ? "" : "s"}${s < 0 ? " — longs crowded" : s > 0 ? " — shorts paying, squeeze risk" : " — neutral"}`);
  } else unavailable.push("funding");

  // Daily-based signals.
  const dCloses = daily.map((c) => c.close);
  const chg7d = dCloses.length > 8 ? ((price - dCloses[dCloses.length - 8]) / dCloses[dCloses.length - 8]) * 100 : null;

  // 9. Open interest vs price (7d).
  if (inp.oiChange7d !== null && chg7d !== null) {
    const oi = inp.oiChange7d;
    const s = oi > 5 ? (chg7d >= 0 ? 0.5 : -0.6) : oi < -5 ? (chg7d >= 0 ? -0.2 : 0.3) : 0;
    const why = oi > 5
      ? (chg7d >= 0 ? "new positions backing the rise" : "new shorts piling in")
      : oi < -5
      ? (chg7d >= 0 ? "rally driven by positions closing (short covering)" : "leverage flushed out — longs capitulating")
      : "no strong positioning change";
    add("oi", s, pct(oi, 0), `Open interest ${pct(oi, 0)} over 7 days while price ${pct(chg7d)} — ${why}`);
  } else unavailable.push("oi");

  // 10. Long/short account ratio vs its own 30-day norm — rising crowding
  // on one side is contrarian.
  if (inp.longShort !== null) {
    const r = inp.longShort;
    const rel = inp.longShortAvg30 ? r / inp.longShortAvg30 : 1;
    const s = rel > 1.25 ? -0.7 : rel > 1.1 ? -0.35 : rel < 0.75 ? 0.7 : rel < 0.9 ? 0.35 : 0;
    add("longShort", s, r.toFixed(2),
      `Long/short account ratio ${r.toFixed(2)}${inp.longShortAvg30 ? ` vs 30-day average ${inp.longShortAvg30.toFixed(2)}` : ""}${s < 0 ? " — retail getting more crowded long" : s > 0 ? " — retail leaning short vs normal" : " — normal positioning"}`);
  } else unavailable.push("longShort");

  // 11. Relative strength vs BTC (30d).
  if (dCloses.length > 31 && b.length > 31) {
    const coin30 = price / dCloses[dCloses.length - 31] - 1;
    const btc30 = b[b.length - 1] / b[b.length - 31] - 1;
    const rel = (coin30 - btc30) * 100;
    add("vsBtc", clamp(rel / 15, -1, 1), pct(rel), `30-day performance vs BTC ${pct(rel)} (${rel >= 0 ? "outperforming" : "underperforming"})`);
  } else unavailable.push("vsBtc");

  // 12. Drawdown from the 1-year high — deep drawdowns have priced much in.
  if (daily.length >= 60) {
    const hi = Math.max(...daily.map((c) => c.high));
    const dd = ((price - hi) / hi) * 100;
    const s = dd < -65 ? 0.8 : dd < -45 ? 0.4 : dd > -8 ? -0.3 : 0;
    add("drawdown", s, pct(dd, 0), `Price ${Math.abs(dd).toFixed(0)}% below its 1-year high (${fmtUsd(hi)})${dd < -45 ? " — much of a cycle drawdown already happened" : ""}`);
  } else unavailable.push("drawdown");

  // 13. Halving cycle.
  const cyc = cyclePhase();
  add("cycle", cyc.score, `${cyc.months}mo`, `4-year cycle: ${cyc.label}, ${cyc.months} months after the April 2024 halving`, cyc.key);

  // ── Score ────────────────────────────────────────────────────────────────
  const wSum = signals.reduce((s, x) => s + x.weight, 0);
  const score = wSum ? signals.reduce((s, x) => s + x.weight * x.score, 0) / wSum : 0;
  const direction = score > 0.12 ? "bullish" : score < -0.12 ? "bearish" : "neutral";
  const want: Verdict = direction === "bullish" ? "bull" : direction === "bearish" ? "bear" : "neutral";
  const agree = direction === "neutral"
    ? signals.filter((s) => s.verdict === "neutral").length
    : signals.filter((s) => s.verdict === want).length;
  const against = direction === "neutral" ? 0 : signals.filter((s) => s.verdict !== "neutral" && s.verdict !== want).length;
  const agreeRatio = agree + against ? agree / (agree + against) : 0;
  const confidence = direction !== "neutral" && Math.abs(score) >= 0.35 && agreeRatio >= 0.7 ? "high"
    : direction !== "neutral" && Math.abs(score) >= 0.18 && agreeRatio >= 0.55 ? "medium" : "low";

  // ── Range from the coin's own daily volatility ──────────────────────────
  const rets: number[] = [];
  const recent = dCloses.slice(-91);
  for (let i = 1; i < recent.length; i++) if (recent[i - 1] > 0) rets.push(Math.log(recent[i] / recent[i - 1]));
  const mu0 = avg(rets);
  const sdDaily = rets.length >= 20 ? Math.sqrt(avg(rets.map((r) => (r - mu0) ** 2))) : 0.04;
  const H = HORIZON_DAYS[tf];
  const sigmaH = clamp(sdDaily * Math.sqrt(H), 0.03, 1.1);
  const drift = score * 0.5 * sigmaH;
  const base = price * Math.exp(drift);
  const bear = price * Math.exp(drift - sigmaH);
  const bull = price * Math.exp(drift + sigmaH);
  const ch = (x: number) => ((x - price) / price) * 100;

  // ── Levels ──────────────────────────────────────────────────────────────
  const lvlSrc = daily.length >= 30 ? daily.slice(-180) : tfCandles;
  const { highs: ph, lows: pl } = pivots(lvlSrc);
  const atr = avg(lvlSrc.slice(-14).map((c) => c.high - c.low)) || price * sdDaily;
  let supports = nearest(pl, price, "below");
  let resistances = nearest(ph, price, "above");
  if (supports.length < 2) supports = [...supports, price - atr * (supports.length ? 3 : 1.5), price - atr * 3].slice(0, 2);
  if (resistances.length < 2) resistances = [...resistances, price + atr * (resistances.length ? 3 : 1.5), price + atr * 3].slice(0, 2);

  let entryLo: number, entryHi: number, stop: number;
  if (direction === "bullish") {
    entryLo = Math.max(supports[0], price - atr); entryHi = price; stop = supports[0] - atr * 0.75;
  } else if (direction === "bearish") {
    entryLo = price; entryHi = Math.min(resistances[0], price + atr); stop = resistances[0] + atr * 0.75;
  } else {
    entryLo = supports[0]; entryHi = resistances[0]; stop = supports[0] - atr * 0.75;
  }

  return {
    signals, unavailable, score, direction, confidence, agree, against, horizonDays: H,
    base, bear, bull, baseChg: ch(base), bearChg: ch(bear), bullChg: ch(bull),
    entryLo, entryHi, stop, supports, resistances,
  };
}
