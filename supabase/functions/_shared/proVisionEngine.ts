// ProVision engine — SERVER ONLY (runs in the provision-compute edge
// function). Moved out of the app bundle so the signal logic can't be
// copied or unlocked client-side; the app only receives results after the
// server checks the user's access (see claim_provision_coin).
//
// Volume pressure uses REAL taker-buy volume when the candles come from
// Binance (kline field 9: volume bought by market orders), and falls back to
// an estimate (green candle = buying, red = selling) when they don't.

export interface PvCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  takerBuyVolume?: number;
}

export type Bias = "bull" | "bear" | "neutral";

export interface PvTile {
  key: "ma" | "dmi" | "ichimoku" | "rsi" | "stoch" | "macd";
  label: string;
  value: string;
  bias: Bias;
  detail: string;
}

export interface PvSignal {
  index: number;
  time: number;
  side: "buy" | "sell";
  price: number;
  invalidation: number;
  agree: number;
  worked: boolean | null;
  pnlPct: number | null;
  exitTime?: number;
  exitPrice?: number;
}

export const PV_RIBBON_LENGTHS = [8, 13, 18, 23, 28, 34, 40, 47, 55];
export const PV_FEE_PCT = 0.1;

export interface PvStats {
  total: number;
  worked: number;
  failed: number;
  open: number;
  winRate: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  perTradePct: number | null;
  trades: number;
}

export interface PvResult {
  trend: Bias[];
  bullStrength: number;
  tiles: PvTile[];
  volume: { buyPct: number; sellPct: number; bias: Bias; real: boolean; buyVol: number; sellVol: number };
  verdict: { bias: Bias; agree: number; total: number };
  checks: Bias[];
  checkStrength: number[];
  checkSeries: number[][];
  checkReadout: { big: string; unit: string }[];
  scoreSeries: number[];
  signals: PvSignal[];
  stats: PvStats;
  zone: { from: number; side: "buy" | "sell"; entry: number; invalidation: number; deltaVolPct: number; real: boolean } | null;
  regime: { kind: "trend" | "range"; chop: number; adx: number };
  rangeBox: { from: number; top: number; bottom: number } | null;
  rangeSignals: PvSignal[];
  rangeStats: PvStats;
  spikes: { time: number; up: boolean; size: number; volX: number }[];
  spikeGuard: { barsLeft: number; up: boolean } | null;
  barSec: number;
  liquidity: { thin: boolean; quoteVol24h: number };
  signalSource?: string;
  ribbon: { lines: number[][]; bull: boolean[] };
  flips: { time: number; side: "buy" | "sell" }[];
}

export function mergeHigherTimeframe(local: PvResult, htf: PvResult, htfBarSec: number, label: string): PvResult {
  const shift = Math.max(0, htfBarSec - local.barSec);
  const at = (t: number) => t + shift;
  return {
    ...local,
    tiles: htf.tiles,
    verdict: htf.verdict,
    checks: htf.checks,
    checkStrength: htf.checkStrength,
    checkSeries: htf.checkSeries,
    checkReadout: htf.checkReadout,
    scoreSeries: htf.scoreSeries,
    volume: htf.volume,
    bullStrength: htf.bullStrength,
    stats: htf.stats,
    signals: htf.signals.map((s) => ({ ...s, time: at(s.time), ...(s.exitTime ? { exitTime: at(s.exitTime) } : {}) })),
    zone: htf.zone ? { ...htf.zone, from: at(htf.zone.from) } : null,
    signalSource: label,
  };
}

export interface PvOptions {
  chopFilter?: boolean;
  spikeGuard?: boolean;
  minAdx?: number;
  stopCapAtr?: number;
  targetR?: number;
  htfK?: number;
  rangeBlock?: boolean;
  minVolX?: number;
  maxBars?: number;
  exitMode?: "target" | "trail";
  trailAtr?: number;
  minAgree?: number;
  rangeLookback?: number;
  rangeEdge?: number;
  rangeTarget?: "mid" | "far";
  emaAlign?: boolean;
  confirmBars?: number;
  spikeMode?: "any" | "against";
}

const MIN_AGREE = 5;
const N_CHECKS = 7;
const CHOP_RANGE = 58;
const ADX_RANGE = 20;
const SPIKE_RANGE_X = 3;
const SPIKE_VOL_X = 3.5;
const SPIKE_COOLDOWN = 5;

function ema(vals: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let prev = vals[0] ?? 0;
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function hiLo(c: PvCandle[], from: number, to: number) {
  let hi = -Infinity, lo = Infinity;
  for (let j = Math.max(0, from); j <= to; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
  return { hi, lo };
}

function split(b: PvCandle): { buy: number; sell: number; real: boolean } {
  const v = b.volume ?? 0;
  const t = b.takerBuyVolume;
  if (v > 0 && t !== undefined && Number.isFinite(t) && t >= 0 && t <= v * 1.0001) {
    return { buy: t, sell: Math.max(0, v - t), real: true };
  }
  const w = v > 0 ? v : 1;
  return b.close >= b.open ? { buy: w, sell: 0, real: false } : { buy: 0, sell: w, real: false };
}

export function computeProVision(c: PvCandle[], opts: PvOptions = {}): PvResult | null {
  const useChop = opts.chopFilter === true;
  const useSpike = opts.spikeGuard !== false;
  const n = c.length;
  if (n < 60) return null;
  const close = c.map((b) => b.close);
  const last = n - 1;

  const tr = c.map((b, i) => i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - c[i - 1].close), Math.abs(b.low - c[i - 1].close)));
  const atr = ema(tr, 14);
  const e20 = ema(close, 20);
  const e200 = ema(close, Math.min(200, Math.max(50, Math.floor(n * 0.6))));

  const pdm: number[] = [0], ndm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const sp = ema(pdm, 14), sn = ema(ndm, 14);
  const pdi = sp.map((v, i) => (atr[i] ? (100 * v) / atr[i] : 0));
  const ndi = sn.map((v, i) => (atr[i] ? (100 * v) / atr[i] : 0));
  const adxArr = ema(pdi.map((p, i) => (p + ndi[i] ? (100 * Math.abs(p - ndi[i])) / (p + ndi[i]) : 0)), 14);

  const chopArr: number[] = c.map((_, i) => {
    if (i < 14) return 50;
    let sumTr = 0;
    for (let j = i - 13; j <= i; j++) sumTr += tr[j];
    const { hi, lo } = hiLo(c, i - 13, i);
    return hi > lo ? (100 * Math.log10(sumTr / (hi - lo))) / Math.log10(14) : 50;
  });
  const rangeRaw = (i: number) => chopArr[i] > CHOP_RANGE && adxArr[i] < ADX_RANGE + 5;
  const isRange = (i: number) => useChop && rangeRaw(i);

  const vols = c.map((b) => b.volume ?? 0);
  const spikeAt: boolean[] = c.map((b, i) => {
    if (i < 21 || !atr[i - 1]) return false;
    const range = b.high - b.low;
    let avgV = 0;
    for (let j = i - 20; j < i; j++) avgV += vols[j];
    avgV /= 20;
    const body = Math.abs(b.close - b.open);
    return range >= SPIKE_RANGE_X * atr[i - 1] || (avgV > 0 && vols[i] >= SPIKE_VOL_X * avgV && body >= 1.5 * atr[i - 1]);
  });
  const gaps = c.slice(-50).map((b, i, a) => (i ? b.time - a[i - 1].time : 0)).filter((g) => g > 0).sort((a, b) => a - b);
  const barSec = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3600;
  const intraday = barSec < 4 * 3600;
  const bars24h = Math.max(1, Math.round(86400 / barSec));
  let quoteVol24h = 0;
  for (let i = Math.max(0, n - bars24h); i < n; i++) quoteVol24h += (c[i].volume ?? 0) * c[i].close;
  const thin = quoteVol24h > 0 && quoteVol24h < 10_000_000;
  opts = {
    exitMode: barSec <= 300 ? "target" : "trail",
    trailAtr: 3,
    maxBars: barSec <= 300 ? 20 : 60,
    htfK: 4,
    confirmBars: intraday ? 3 : 2,
    minAdx: intraday ? 20 : 0,
    rangeBlock: intraday,
    minAgree: MIN_AGREE,
    ...opts,
  };
  const spikeMode = opts.spikeMode ?? "against";
  const spikeRecent = (i: number, side: "buy" | "sell") => {
    if (!useSpike) return false;
    for (let j = Math.max(0, i - SPIKE_COOLDOWN + 1); j <= i; j++) {
      if (!spikeAt[j]) continue;
      if (spikeMode === "any") return true;
      const up = c[j].close >= c[j].open;
      if ((side === "buy" && !up) || (side === "sell" && up)) return true;
    }
    return false;
  };
  const e50 = ema(close, 50);

  const trend: Bias[] = c.map((_, i) => {
    if (i < 3 || !atr[i] || isRange(i)) return "neutral";
    const s = (e20[i] - e20[i - 3]) / atr[i];
    return s > 0.25 ? "bull" : s < -0.25 ? "bear" : "neutral";
  });

  const rsiArr: number[] = [50];
  let g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const d = close[i] - close[i - 1];
    const gi = Math.max(d, 0), li = Math.max(-d, 0);
    if (i <= 14) { g += gi / 14; l += li / 14; } else { g = (g * 13 + gi) / 14; l = (l * 13 + li) / 14; }
    rsiArr.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  }

  const rawK: number[] = [];
  for (let i = 0; i < n; i++) {
    const { hi, lo } = hiLo(c, i - 13, i);
    rawK.push(hi === lo ? 50 : ((close[i] - lo) / (hi - lo)) * 100);
  }
  const avg3 = (a: number[], i: number) => (a[i] + a[Math.max(0, i - 1)] + a[Math.max(0, i - 2)]) / 3;
  const kArr = rawK.map((_, i) => avg3(rawK, i));
  const dArr = kArr.map((_, i) => avg3(kArr, i));

  const e12 = ema(close, 12), e26 = ema(close, 26);
  const macd = e12.map((v, i) => v - e26[i]);
  const sig = ema(macd, 9);
  const hist = macd.map((v, i) => v - sig[i]);

  const mid = (from: number, to: number) => { const { hi, lo } = hiLo(c, from, to); return (hi + lo) / 2; };
  const cloudAt = (i: number) => {
    const k = Math.max(0, i - 26);
    const a = (mid(k - 8, k) + mid(k - 25, k)) / 2, b = mid(k - 51, k);
    return { top: Math.max(a, b), bot: Math.min(a, b) };
  };

  const sp20: { buy: number; sell: number }[] = [];
  let anyReal = false; let rb = 0, rs = 0;
  const parts = c.map((b) => { const s = split(b); if (s.real) anyReal = true; return s; });
  for (let i = 0; i < n; i++) {
    rb += parts[i].buy; rs += parts[i].sell;
    if (i >= 20) { rb -= parts[i - 20].buy; rs -= parts[i - 20].sell; }
    sp20.push({ buy: rb, sell: rs });
  }

  const biasesAt = (i: number): Bias[] => {
    const px = close[i];
    const ma: Bias = px > e20[i] && e20[i] > e200[i] ? "bull" : px < e20[i] && e20[i] < e200[i] ? "bear" : "neutral";
    const dmi: Bias = adxArr[i] < 18 ? "neutral" : pdi[i] > ndi[i] ? "bull" : "bear";
    const cl = cloudAt(i);
    const ichi: Bias = px > cl.top ? "bull" : px < cl.bot ? "bear" : "neutral";
    const r = rsiArr[i];
    const rsi: Bias = r > 55 ? "bull" : r < 45 ? "bear" : "neutral";
    const k = kArr[i];
    const st: Bias = k >= 80 || k <= 20 ? "neutral" : k > dArr[i] ? "bull" : "bear";
    const md: Bias = hist[i] > 0 ? "bull" : hist[i] < 0 ? "bear" : "neutral";
    const t = sp20[i].buy + sp20[i].sell;
    const bp = t ? sp20[i].buy / t : 0.5;
    const vol: Bias = bp >= 0.55 ? "bull" : bp <= 0.45 ? "bear" : "neutral";
    return [ma, dmi, ichi, rsi, st, md, vol];
  };

  const [maB, dmiB, ichiB, rsiB, stB, macdB, volB] = biasesAt(last);
  const adx = adxArr[last], rsi = rsiArr[last], kS = kArr[last];
  const histNow = hist[last], histPrev = hist[last - 1];
  const tiles: PvTile[] = [
    {
      key: "ma", label: "MA 20/200", bias: maB,
      value: maB === "bull" ? "Strong ↑" : maB === "bear" ? "Strong ↓" : "Mixed",
      detail: "Price compared with the 20 and 200 moving averages. Price above a rising 20 that's above the 200 is a strong uptrend; the reverse is a strong downtrend.",
    },
    {
      key: "dmi", label: "DMI", bias: dmiB,
      value: dmiB === "neutral" ? "No trend" : `${adx > 25 ? "Strong" : "Weak"} ${dmiB === "bull" ? "↑" : "↓"}`,
      detail: `Directional movement: which side is pushing harder (+DI ${pdi[last].toFixed(0)} vs −DI ${ndi[last].toFixed(0)}) and how strong the trend is (ADX ${adx.toFixed(0)}; above 25 is a strong trend).`,
    },
    {
      key: "ichimoku", label: "Ichimoku", bias: ichiB,
      value: ichiB === "bull" ? "Above cloud" : ichiB === "bear" ? "Below cloud" : "In cloud",
      detail: "Ichimoku cloud: price above the cloud favours buyers, below it favours sellers, inside it means no clear trend.",
    },
    {
      key: "rsi", label: `RSI ${rsi.toFixed(0)}`, bias: rsiB,
      value: rsi >= 70 ? "Overbought" : rsi <= 30 ? "Oversold" : rsiB === "bull" ? "Bullish" : rsiB === "bear" ? "Bearish" : "Neutral",
      detail: "Relative Strength Index (14): above 55 leans bullish, below 45 bearish. Above 70 is overbought, below 30 oversold — stretched, often near a turn.",
    },
    {
      key: "stoch", label: "Stochastic", bias: stB,
      value: kS >= 80 ? "Overbought" : kS <= 20 ? "Oversold" : stB === "bull" ? "Rising" : "Falling",
      detail: `Stochastic (14,3): where the close sits in the recent range (${kS.toFixed(0)}/100). Above 80 overbought, below 20 oversold; otherwise its direction shows momentum.`,
    },
    {
      key: "macd", label: "MACD", bias: macdB,
      value: `${Math.abs(histNow) >= Math.abs(histPrev) ? "Strong" : "Fading"} ${macdB === "bull" ? "↑" : "↓"}`,
      detail: "MACD (12,26,9): above its signal line is bullish momentum, below is bearish. A growing gap means momentum is strengthening; shrinking means it's fading.",
    },
  ];

  const vt = sp20[last].buy + sp20[last].sell;
  const buyPct = vt ? Math.round((sp20[last].buy / vt) * 100) : 50;

  const all = [maB, dmiB, ichiB, rsiB, stB, macdB, volB];
  const bulls = all.filter((b) => b === "bull").length, bears = all.filter((b) => b === "bear").length;
  const verdictBias: Bias = bulls > bears && bulls >= 4 ? "bull" : bears > bulls && bears >= 4 ? "bear" : "neutral";
  const bullStrength = Math.round(((bulls + (N_CHECKS - bulls - bears) * 0.5) / N_CHECKS) * 100);

  const signals: PvSignal[] = [];
  const confirm = Math.max(2, opts.confirmBars ?? 2);
  const maxBars = opts.maxBars ?? 20;
  const htfK = opts.htfK ?? 0;
  const eHtf = htfK > 1 ? ema(close, Math.round(20 * htfK)) : null;
  const vol50 = (i: number) => {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - 50); j < i; j++) { s += vols[j]; k++; }
    return k ? s / k : 0;
  };
  for (let i = 52; i < n && !thin; i++) {
    const cur = trend[i];
    if (cur === "neutral") continue;
    let held = true;
    for (let j = i - confirm + 1; j <= i; j++) if (trend[j] !== cur) { held = false; break; }
    if (!held || trend[i - confirm] === cur) continue;
    const side = cur === "bull" ? "buy" : "sell";
    const lastSig = signals[signals.length - 1];
    if (lastSig && (lastSig.side === side || i - lastSig.index < 5)) continue;
    if (isRange(i) || spikeRecent(i, side)) continue;
    if (opts.minAdx && adxArr[i] < opts.minAdx) continue;
    if (opts.emaAlign && (side === "buy" ? !(close[i] > e50[i] && e20[i] > e50[i]) : !(close[i] < e50[i] && e20[i] < e50[i]))) continue;
    if (opts.rangeBlock && rangeRaw(i)) continue;
    if (eHtf && i > htfK) {
      const slope = eHtf[i] - eHtf[i - Math.round(htfK)];
      if (side === "buy" ? !(close[i] > eHtf[i] && slope > 0) : !(close[i] < eHtf[i] && slope < 0)) continue;
    }
    if (opts.minVolX) {
      const v3 = (vols[i] + vols[i - 1] + vols[i - 2]) / 3;
      const base = vol50(i);
      if (base > 0 && v3 < opts.minVolX * base) continue;
    }
    const bi = biasesAt(i);
    const agree = bi.filter((b) => b === cur).length;
    if (agree < (opts.minAgree ?? MIN_AGREE)) continue;
    const entry = c[i].close;
    const dir = side === "buy" ? 1 : -1;
    const { hi, lo } = hiLo(c, i - 10, i);
    let inval = side === "sell" ? hi : lo;
    if (opts.stopCapAtr) {
      const maxD = opts.stopCapAtr * atr[i], minD = 0.5 * atr[i];
      const d = Math.min(maxD, Math.max(minD, Math.abs(inval - entry)));
      inval = entry - dir * d;
    }
    const risk = Math.abs(entry - inval);
    const tgtDist = opts.targetR ? opts.targetR * risk : atr[i];
    let worked: boolean | null = null;
    let pnlPct: number | null = null;
    let exitJ = -1, exitPrice: number | null = null;
    if (opts.exitMode === "trail") {
      const tA = (opts.trailAtr ?? 2) * atr[i];
      let stop = inval, best = entry, exitPx: number | null = null;
      for (let j = i + 1; j <= Math.min(last, i + maxBars); j++) {
        if (side === "sell" ? c[j].high > stop : c[j].low < stop) { exitPx = stop; exitJ = j; break; }
        best = side === "sell" ? Math.min(best, c[j].close) : Math.max(best, c[j].close);
        const trailStop = best - dir * tA;
        stop = side === "sell" ? Math.min(stop, trailStop) : Math.max(stop, trailStop);
        const opp = side === "sell" ? "bull" : "bear";
        if (trend[j] === opp) { exitPx = c[j].close; exitJ = j; break; }
      }
      if (exitPx === null && last - i > maxBars) { exitPx = c[i + maxBars].close; exitJ = i + maxBars; }
      if (exitPx !== null) {
        exitPrice = exitPx;
        pnlPct = ((exitPx - entry) * dir / entry) * 100;
        worked = pnlPct > PV_FEE_PCT;
      }
    } else
    for (let j = i + 1; j <= Math.min(last, i + maxBars); j++) {
      if (side === "sell" ? c[j].high > inval : c[j].low < inval) {
        worked = false; pnlPct = ((inval - entry) * dir / entry) * 100; exitJ = j; exitPrice = inval; break;
      }
      if (side === "sell" ? entry - c[j].low >= tgtDist : c[j].high - entry >= tgtDist) {
        worked = true; pnlPct = (tgtDist / entry) * 100; exitJ = j; exitPrice = entry + dir * tgtDist; break;
      }
    }
    if (worked === null && last - i > maxBars) {
      const exit = c[i + maxBars].close;
      pnlPct = ((exit - entry) * dir / entry) * 100;
      worked = pnlPct > PV_FEE_PCT;
      exitJ = i + maxBars; exitPrice = exit;
    }
    if (pnlPct !== null) pnlPct -= PV_FEE_PCT;
    signals.push({
      index: i, time: c[i].time, side, price: entry, invalidation: inval, agree, worked, pnlPct,
      ...(exitJ >= 0 && exitPrice !== null ? { exitTime: c[exitJ].time, exitPrice } : {}),
    });
  }

  const lb = opts.rangeLookback ?? 50;
  const edge = opts.rangeEdge ?? 0.2;
  const rangeOn = barSec >= 3600;
  const rangeSignals: PvSignal[] = [];
  for (let i = Math.max(lb + 1, 52); i < n && !thin && rangeOn; i++) {
    if (!rangeRaw(i)) continue;
    const { hi: top, lo: bot } = hiLo(c, i - lb, i - 1);
    const h = top - bot;
    if (h <= 0 || h < 1.5 * atr[i]) continue;
    const lastR = rangeSignals[rangeSignals.length - 1];
    if (lastR && i - lastR.index < 5) continue;
    let side: "buy" | "sell" | null = null;
    if (c[i].low <= bot + edge * h && c[i].close > bot + edge * h * 0.5 && c[i].close > c[i].open && rsiArr[i] < 45) side = "buy";
    else if (c[i].high >= top - edge * h && c[i].close < top - edge * h * 0.5 && c[i].close < c[i].open && rsiArr[i] > 55) side = "sell";
    if (!side) continue;
    const entry = c[i].close, dir = side === "buy" ? 1 : -1;
    const stop = side === "buy" ? bot - 0.5 * atr[i] : top + 0.5 * atr[i];
    const target = (opts.rangeTarget ?? "mid") === "mid" ? (top + bot) / 2 : side === "buy" ? top : bot;
    if ((target - entry) * dir <= 0) continue;
    let worked: boolean | null = null, pnlPct: number | null = null;
    for (let j = i + 1; j <= Math.min(last, i + lb); j++) {
      if (side === "buy" ? c[j].low < stop : c[j].high > stop) { worked = false; pnlPct = ((stop - entry) * dir / entry) * 100; break; }
      if (side === "buy" ? c[j].high >= target : c[j].low <= target) { worked = true; pnlPct = ((target - entry) * dir / entry) * 100; break; }
    }
    if (worked === null && last - i > lb) {
      pnlPct = ((c[i + lb].close - entry) * dir / entry) * 100;
      worked = pnlPct > PV_FEE_PCT;
    }
    if (pnlPct !== null) pnlPct -= PV_FEE_PCT;
    rangeSignals.push({ index: i, time: c[i].time, side, price: entry, invalidation: stop, agree: 0, worked, pnlPct });
  }
  const statsOf = (list: PvSignal[]): PvStats => {
    const res = list.filter((s) => s.worked !== null);
    const w = res.filter((s) => s.worked).length;
    const cl = list.filter((s) => s.pnlPct !== null).map((s) => s.pnlPct as number);
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      total: list.length, worked: w, failed: res.length - w, open: list.length - res.length,
      winRate: res.length ? Math.round((w / res.length) * 100) : null,
      avgWinPct: avg(cl.filter((p) => p > 0)), avgLossPct: avg(cl.filter((p) => p <= 0)),
      perTradePct: avg(cl), trades: cl.length,
    };
  };
  const rangeStats = statsOf(rangeSignals);
  let rangeBox: PvResult["rangeBox"] = null;
  if (rangeRaw(last)) {
    const { hi: top, lo: bot } = hiLo(c, last - lb, last);
    let from = last;
    while (from > 0 && rangeRaw(from - 1) && last - from < 200) from--;
    rangeBox = { from: c[Math.max(from, last - lb)].time, top, bottom: bot };
  }

  const resolved = signals.filter((s) => s.worked !== null);
  const workedN = resolved.filter((s) => s.worked).length;
  const closed = signals.filter((s) => s.pnlPct !== null).map((s) => s.pnlPct as number);
  const wins = closed.filter((p) => p > 0), losses = closed.filter((p) => p <= 0);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const stats: PvStats = {
    total: signals.length,
    worked: workedN,
    failed: resolved.length - workedN,
    open: signals.length - resolved.length,
    winRate: resolved.length ? Math.round((workedN / resolved.length) * 100) : null,
    avgWinPct: mean(wins),
    avgLossPct: mean(losses),
    perTradePct: mean(closed),
    trades: closed.length,
  };

  let zone: PvResult["zone"] = null;
  const ls = signals[signals.length - 1];
  if (ls) {
    let broken = false; let zb = 0, zs = 0, zReal = false;
    for (let j = ls.index; j <= last; j++) {
      if (j > ls.index && (ls.side === "sell" ? c[j].high > ls.invalidation : c[j].low < ls.invalidation)) { broken = true; break; }
      zb += parts[j].buy; zs += parts[j].sell; if (parts[j].real) zReal = true;
    }
    if (!broken) {
      zone = {
        from: ls.time, side: ls.side, entry: ls.price, invalidation: ls.invalidation,
        deltaVolPct: zb + zs ? ((zb - zs) / (zb + zs)) * 100 : 0, real: zReal,
      };
    }
  }

  const regime: PvResult["regime"] = {
    kind: rangeRaw(last) ? "range" : "trend",
    chop: chopArr[last],
    adx: adxArr[last],
  };
  const spikes: PvResult["spikes"] = [];
  let avgV = 0;
  for (let i = Math.max(21, n - 200); i < n; i++) {
    if (!spikeAt[i]) continue;
    avgV = 0;
    for (let j = i - 20; j < i; j++) avgV += vols[j];
    avgV /= 20;
    spikes.push({
      time: c[i].time,
      up: c[i].close >= c[i].open,
      size: (c[i].high - c[i].low) / (atr[i - 1] || 1),
      volX: avgV ? vols[i] / avgV : 0,
    });
  }
  let spikeGuard: PvResult["spikeGuard"] = null;
  if (useSpike) {
    for (let j = last; j >= Math.max(0, last - SPIKE_COOLDOWN + 1); j--) {
      if (spikeAt[j]) { spikeGuard = { barsLeft: SPIKE_COOLDOWN - (last - j) - 1, up: c[j].close >= c[j].open }; break; }
    }
  }

  const ribbonLines = PV_RIBBON_LENGTHS.map((len) => ema(close, len));
  const fastL = ribbonLines[0], slowL = ribbonLines[ribbonLines.length - 1];
  const ribbon = { lines: ribbonLines, bull: close.map((_, i) => fastL[i] >= slowL[i]) };
  const flips: PvResult["flips"] = [];
  for (let i = 20; i < n; i++) {
    const b = ribbon.bull[i];
    if (b === ribbon.bull[i - 1]) continue;
    if (i + 1 < n && ribbon.bull[i + 1] !== b) continue;
    const prevF = flips[flips.length - 1];
    if (prevF && (c.findIndex((x) => x.time === prevF.time) > i - 4)) continue;
    flips.push({ time: c[i].time, side: b ? "buy" : "sell" });
  }

  return {
    barSec,
    ribbon,
    flips: flips.slice(-20),
    liquidity: { thin, quoteVol24h },
    rangeBox, rangeSignals: rangeSignals.slice(-12), rangeStats,
    regime, spikes: spikes.slice(-8), spikeGuard,
    trend, bullStrength, tiles,
    volume: { buyPct, sellPct: 100 - buyPct, bias: volB, real: anyReal, buyVol: sp20[last].buy, sellVol: sp20[last].sell },
    checks: all,
    scoreSeries: (() => {
      const out: number[] = [];
      for (let i = Math.max(52, n - 30); i < n; i++) {
        const bs = biasesAt(i);
        const bu = bs.filter((x) => x === "bull").length, be = bs.filter((x) => x === "bear").length;
        out.push(Math.round(((bu + (N_CHECKS - bu - be) * 0.5) / N_CHECKS) * 100));
      }
      return out;
    })(),
    checkSeries: (() => {
      const from = Math.max(0, n - 30);
      const idx = Array.from({ length: n - from }, (_, k) => from + k);
      return [
        idx.map((i) => (atr[i] ? (close[i] - e20[i]) / atr[i] : 0)),
        idx.map((i) => pdi[i] - ndi[i]),
        idx.map((i) => { const cl = cloudAt(i); const mid = (cl.top + cl.bot) / 2; return atr[i] ? (close[i] - mid) / atr[i] : 0; }),
        idx.map((i) => rsiArr[i]),
        idx.map((i) => kArr[i]),
        idx.map((i) => hist[i]),
        idx.map((i) => { const t = sp20[i].buy + sp20[i].sell; return t ? (sp20[i].buy / t) * 100 : 50; }),
      ];
    })(),
    checkReadout: (() => {
      const px = close[last];
      const pct = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
      const cl = cloudAt(last);
      const toCloud = px > cl.top ? ((px - cl.top) / px) * 100 : px < cl.bot ? ((px - cl.bot) / px) * 100 : 0;
      return [
        { big: pct(((px - e20[last]) / e20[last]) * 100), unit: "vs MA20" },
        { big: adx.toFixed(0), unit: "ADX" },
        { big: toCloud === 0 ? "0%" : pct(toCloud), unit: toCloud === 0 ? "in cloud" : "to cloud" },
        { big: rsi.toFixed(0), unit: "RSI" },
        { big: kArr[last].toFixed(0), unit: "%K" },
        { big: `${histNow >= 0 ? "+" : "−"}${Math.abs(atr[last] ? histNow / atr[last] : 0).toFixed(2)}`, unit: "MACD" },
        { big: `${Math.max(buyPct, 100 - buyPct)}%`, unit: buyPct >= 50 ? "buyers" : "sellers" },
      ];
    })(),
    checkStrength: (() => {
      const cl = (v: number) => Math.max(0.04, Math.min(0.96, v));
      const px = close[last];
      const maS = px > e20[last] && e20[last] > e200[last] ? 0.88 : px < e20[last] && e20[last] < e200[last] ? 0.12 : px > e200[last] ? 0.62 : 0.38;
      const dmiS = 0.5 + Math.sign(pdi[last] - ndi[last]) * Math.min(adx, 50) / 100;
      const cl2 = cloudAt(last);
      const ichiS = px > cl2.top ? 0.85 : px < cl2.bot ? 0.15 : 0.5;
      const stS = 0.5 + Math.max(-0.4, Math.min(0.4, (kArr[last] - dArr[last]) / 25));
      const macdS = 0.5 + Math.max(-0.42, Math.min(0.42, (atr[last] ? histNow / atr[last] : 0) * 0.8));
      return [maS, dmiS, ichiS, rsi / 100, stS, macdS, buyPct / 100].map(cl);
    })(),
    verdict: { bias: verdictBias, agree: verdictBias === "bull" ? bulls : verdictBias === "bear" ? bears : Math.max(bulls, bears), total: N_CHECKS },
    signals: signals.slice(-12),
    stats,
    zone,
  };
}
