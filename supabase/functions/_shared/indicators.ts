// Ported twin of src/services/indicators.ts — Deno edge functions in this
// repo never import from src/ (only from supabase/functions/_shared/), so
// this is a deliberate copy, not a shared import. Keep the two in sync by
// hand when either changes; they're small, pure, rarely-changing arithmetic.
export interface CandleDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function calcEMA(values: number[], period: number): number[] {
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

export function calcRSI(candles: CandleDataPoint[], period = 14): number | null {
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

export function calcRSIArray(candles: CandleDataPoint[], period = 14): (number | null)[] {
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

export function calcMACD(candles: CandleDataPoint[]): { line: number | null; signal: number | null; hist: number | null } {
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

export function calcMACDSeries(candles: CandleDataPoint[]): { line: (number | null)[]; signal: (number | null)[] } {
  const closes = candles.map(c => c.close);
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdArr = closes.map((_, i) => isNaN(ema12[i]) || isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]);
  const validIdx = macdArr.map((v, i) => (isNaN(v) ? -1 : i)).filter(i => i >= 0);
  const validMacd = validIdx.map(i => macdArr[i]);
  const signalValid = calcEMA(validMacd, 9);
  const line: (number | null)[] = new Array(candles.length).fill(null);
  const signal: (number | null)[] = new Array(candles.length).fill(null);
  validIdx.forEach((origIdx, k) => {
    line[origIdx] = validMacd[k];
    signal[origIdx] = isNaN(signalValid[k]) ? null : signalValid[k];
  });
  return { line, signal };
}

export function calcTEMA(values: number[], period: number): number[] {
  const ema = (vs: number[]): number[] => {
    const k = 2 / (period + 1);
    const out = [vs[0]];
    for (let i = 1; i < vs.length; i++) out.push(vs[i] * k + out[i - 1] * (1 - k));
    return out;
  };
  const e1 = ema(values), e2 = ema(e1), e3 = ema(e2);
  return values.map((_, i) => 3 * e1[i] - 3 * e2[i] + e3[i]);
}

export function calcBB(candles: CandleDataPoint[], period = 20): { upper: number; middle: number; lower: number; pct: number } | null {
  if (candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const sma = closes.reduce((s, v) => s + v, 0) / period;
  const sd = Math.sqrt(closes.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
  const upper = sma + 2 * sd, lower = sma - 2 * sd;
  const last = candles[candles.length - 1].close;
  const pct = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  return { upper, middle: sma, lower, pct };
}

export function calcBBPctSeries(candles: CandleDataPoint[], period = 20): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const bb = calcBB(window, period);
    result[i] = bb?.pct ?? null;
  }
  return result;
}

export function calcATR(candles: CandleDataPoint[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const emaTR = calcEMA(trs, period);
  const last = emaTR[emaTR.length - 1];
  return isNaN(last) ? null : last;
}

export function calcVolRatio(candles: CandleDataPoint[], period = 20): number | null {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  const avg = recent.slice(0, period).reduce((s, c) => s + (c.volume ?? 0), 0) / period;
  const cur = recent[recent.length - 1].volume ?? 0;
  return avg === 0 ? null : cur / avg;
}
