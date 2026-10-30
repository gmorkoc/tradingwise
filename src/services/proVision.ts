// ProVision — client side. The signal engine itself runs ONLY on the server
// (supabase/functions/provision-compute + _shared/proVisionEngine.ts), after
// the server checks the user's access. This file has the result types, the
// call to that function, and the EMA ribbon (a standard indicator the app
// draws itself to keep responses small).
import { supabase } from "./supabase";

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

/** EMA lengths of the painted ribbon (fast → slow). */
export const PV_RIBBON_LENGTHS = [8, 13, 18, 23, 28, 34, 40, 47, 55];

/** Round-trip trading fee assumed in the simulated trade results. */
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
  /** Per-candle trend colour key, aligned with the chart's candles. */
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
  /** EMA fan aligned with the chart's candles (drawn by the app). */
  ribbon: { lines: number[][]; bull: boolean[] };
  flips: { time: number; side: "buy" | "sell" }[];
}

export interface PvMtfRow { label: string; bias: Bias | null; checks: Bias[]; strength: number | null }

/** Most candles sent per request (the server's cap). */
const MAX_SEND = 1500;

const wire = (cs: PvCandle[]) => cs.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume ?? -1, b.takerBuyVolume ?? -1]);

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

/** The painted EMA ribbon over the chart's candles. */
export function computeRibbon(cs: PvCandle[]): PvResult["ribbon"] {
  const close = cs.map((b) => b.close);
  const lines = PV_RIBBON_LENGTHS.map((len) => ema(close, len));
  const fast = lines[0] ?? [], slow = lines[lines.length - 1] ?? [];
  return { lines, bull: close.map((_, i) => fast[i] >= slow[i]) };
}

export class ProVisionLockedError extends Error {
  constructor(public reason: "signin" | "locked", message: string) { super(message); }
}

async function call(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("provision-compute", { body });
  if (error) {
    // FunctionsHttpError carries the response — surface 401/403 as "locked".
    const res = (error as { context?: Response }).context;
    if (res && (res.status === 401 || res.status === 403)) {
      let msg = "ProVision is locked";
      try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
      throw new ProVisionLockedError(res.status === 401 ? "signin" : "locked", msg);
    }
    throw error;
  }
  return data as { result?: (Omit<PvResult, "trend" | "ribbon"> & { trend: string }) | null; mtf?: PvMtfRow[] };
}

const TREND_DECODE: Record<string, Bias> = { b: "bull", r: "bear", n: "neutral" };

/**
 * ProVision for the chart's candles (computed on the server). `htf` = 15m
 * candles for short charts, whose signals come from 15m. Results are lined
 * up with `candles` (older bars beyond the cap just get no trend colour).
 */
export async function fetchProVision(coin: string, candles: PvCandle[], htf?: { candles: PvCandle[]; shortSec: number }): Promise<PvResult | null> {
  const sent = candles.slice(-MAX_SEND);
  const offset = candles.length - sent.length;
  const data = await call({
    coin,
    main: wire(sent),
    ...(htf ? { htf: wire(htf.candles.slice(-MAX_SEND)), shortSec: htf.shortSec } : {}),
  });
  const r = data.result;
  if (!r) return null;
  const trend: Bias[] = new Array(offset).fill("neutral");
  for (const ch of r.trend) trend.push(TREND_DECODE[ch] ?? "neutral");
  const shift = (s: PvSignal) => ({ ...s, index: s.index + offset });
  return {
    ...r,
    trend,
    signals: r.signals.map(shift),
    rangeSignals: r.rangeSignals.map(shift),
    ribbon: computeRibbon(candles),
  };
}

/** Verdicts for several timeframes at once (the Timeframes row). */
export async function fetchProVisionMtf(coin: string, sets: { label: string; candles: PvCandle[] }[]): Promise<PvMtfRow[]> {
  const data = await call({ coin, mtf: sets.map((s) => ({ label: s.label, candles: wire(s.candles.slice(-MAX_SEND)) })) });
  return data.mtf ?? [];
}
