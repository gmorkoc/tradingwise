import { CandleDataPoint } from "../services/coinglass";

/* ── Synthetic liquidation-heatmap simulation ──────────────────────────────
 * There's no real order-book liquidation feed here — this estimates where
 * leveraged longs/shorts would be sitting based on price distance and a
 * fixed set of leverage tiers, the same approach the Liquidation Heatmap
 * page uses. Shared so other features (e.g. zone AI analysis) can reuse the
 * exact same cluster math instead of re-deriving it. */

export const PRICE_ROWS = 400;
// Levels build up as more positions open there and persist until price
// trades through them (then they're cleared — "liquidated"). That gives
// bands that brighten left→right and end exactly where price crossed them.
// Positions get closed over time: fade with a real-time half-life (not per
// candle), so a 3-month view doesn't let stale far-away levels dominate.
const HALF_LIFE_SEC = 14 * 86400;
const BLUR_R: number = 2;    // soft few-row bands instead of hairlines

export const LEVERAGES_ALL = [10, 25, 50, 100, 125, 200] as const;
export type Lev = typeof LEVERAGES_ALL[number];
const LEV_WEIGHTS: Record<Lev, number> = { 10: 0.35, 25: 0.55, 50: 1.0, 100: 0.80, 125: 0.60, 200: 0.30 };

function makeGaussKernel(r: number) {
  const k: number[] = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (r * r * 0.5)); k.push(w); s += w; }
  return k.map(w => w / s);
}
const GAUSS = makeGaussKernel(BLUR_R);

function blurCol(col: Float32Array): Float32Array {
  if (BLUR_R === 0) return col.slice();
  const out = new Float32Array(PRICE_ROWS);
  for (let r = 0; r < PRICE_ROWS; r++) {
    let v = 0;
    for (let k = -BLUR_R; k <= BLUR_R; k++) {
      const ri = r + k;
      if (ri >= 0 && ri < PRICE_ROWS) v += col[ri] * GAUSS[k + BLUR_R];
    }
    out[r] = v;
  }
  return out;
}

export function buildMatrix(candles: CandleDataPoint[], activeLevs: Lev[]) {
  const prices  = candles.flatMap(c => [c.high, c.low]);
  const pMin    = Math.min(...prices) * 0.980;
  const pMax    = Math.max(...prices) * 1.020;
  const pRange  = pMax - pMin;
  const cols    = candles.length;

  const matrix = new Float32Array(cols * PRICE_ROWS);
  const acc    = new Float32Array(PRICE_ROWS);

  const toRow = (p: number) =>
    Math.max(0, Math.min(PRICE_ROWS - 1, Math.round(((p - pMin) / pRange) * (PRICE_ROWS - 1))));

  const addHeat = (row: number, w: number) => {
    if (row >= 0 && row < PRICE_ROWS) acc[row] += w;
  };

  // Weight new positions by traded volume (relative to the typical candle),
  // falling back to candle size when volume isn't available.
  const vols = candles.map(c => c.volume ?? 0).filter(v => v > 0).sort((a, b) => a - b);
  const medVol = vols.length ? vols[Math.floor(vols.length / 2)] : 0;
  const span   = cols > 1 ? Math.max(1, candles[1].time - candles[0].time) : 3600;
  const DECAY  = Math.pow(0.5, span / HALF_LIFE_SEC);

  for (let col = 0; col < cols; col++) {
    const c   = candles[col];
    const mid = (c.open + c.close) / 2;
    const vol = medVol > 0 && c.volume
      ? Math.min(c.volume / medVol, 6) * 0.01
      : Math.max((c.high - c.low) / pRange, 0.002);

    for (let r = 0; r < PRICE_ROWS; r++) acc[r] *= DECAY;

    // Price traded through these rows this candle → the positions whose
    // liquidation price sat there are now liquidated: clear them (before
    // adding this candle's new positions).
    const lo = toRow(c.low), hi = toRow(c.high);
    for (let r = lo; r <= hi; r++) acc[r] = 0;

    for (const lev of activeLevs) {
      const w = LEV_WEIGHTS[lev] * vol * 28;
      addHeat(toRow(c.high * (1 - 1 / lev)), w * 1.2);
      addHeat(toRow(mid   * (1 - 1 / lev)), w * 0.8);
      addHeat(toRow(c.low  * (1 + 1 / lev)), w * 1.2);
      addHeat(toRow(mid    * (1 + 1 / lev)), w * 0.8);
      addHeat(toRow(mid * (1 - 0.5 / lev)), w * 0.3);
      addHeat(toRow(mid * (1 + 0.5 / lev)), w * 0.3);
    }

    const blurred = blurCol(acc);
    const base = col * PRICE_ROWS;
    for (let r = 0; r < PRICE_ROWS; r++) matrix[base + r] = blurred[r];
  }

  let maxVal = 0;
  for (const v of matrix) if (v > maxVal) maxVal = v;
  return { matrix, pMin, pMax, maxVal, cols };
}

export interface ClusterInfo {
  priceLo: number; priceHi: number; priceCenter: number;
  strength: number; label: "extreme" | "high" | "moderate"; distancePct: number;
  /** Fraction of all still-open liquidation levels that sit in this zone.
   *  Every contract has a long and a short side, so all levels together
   *  ≙ 2 × open interest: est. $ here = share × 2 × OI. */
  share: number;
}
export interface LiqAnalysis {
  longClusters: ClusterInfo[]; shortClusters: ClusterInfo[];
  /** Closest meaningful zone below / above price (not just among the top 3). */
  nearLong: ClusterInfo | null; nearShort: ClusterInfo | null;
  dominantSide: "long" | "short" | "balanced";
  currentPrice: number;
  /** English summary sentence (kept for callers that don't translate). */
  summary: string;
  /** Language-agnostic form of `summary`: which sentence applies (null = none)
   *  plus the key prices it mentions, so the UI can render a translation. */
  summaryKey: "shortDominant" | "longDominant" | "balanced" | null;
  summaryAbove: number | null;
  summaryBelow: number | null;
}

export function analyseLiquidations(candles: CandleDataPoint[], activeLevs: Lev[]): LiqAnalysis | null {
  if (candles.length < 3) return null;
  const { matrix, pMin, pMax, maxVal, cols } = buildMatrix(candles, activeLevs);
  if (maxVal === 0) return null;

  const lastCol = new Float32Array(PRICE_ROWS);
  const base    = (cols - 1) * PRICE_ROWS;
  for (let r = 0; r < PRICE_ROWS; r++) lastCol[r] = matrix[base + r];

  const currentPrice = candles[candles.length - 1].close;
  const cellSize     = (pMax - pMin) / PRICE_ROWS;
  const rowToPrice   = (r: number) => pMin + (r + 0.5) * cellSize;

  // Strength is measured against the strong levels of *today's* column (98th
  // percentile of non-empty rows), the same way the chart scales colour —
  // not against one all-time spike, which made every nearby band look weak.
  const nz = Array.from(lastCol).filter(v => v > 0).sort((a, b) => a - b);
  if (!nz.length) return null;
  const ref = nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.98))] || nz[nz.length - 1];

  // Zones = local peaks, widened while the level stays ≥ 70% of the peak.
  const MIN_STRENGTH = 0.15, PEAK_R = 3;
  const bands: { rowStart: number; rowEnd: number; peakHeat: number }[] = [];
  for (let r = 0; r < PRICE_ROWS; r++) {
    const v = lastCol[r];
    if (v / ref < MIN_STRENGTH) continue;
    let isPeak = true;
    for (let k = -PEAK_R; k <= PEAK_R && isPeak; k++) {
      const j = r + k;
      if (k !== 0 && j >= 0 && j < PRICE_ROWS && (lastCol[j] > v || (lastCol[j] === v && k < 0))) isPeak = false;
    }
    if (!isPeak) continue;
    // …but never wider than ~0.4% of price either side, so a dense plateau
    // isn't reported as one giant zone.
    const maxHalf = Math.max(1, Math.ceil((currentPrice * 0.002) / cellSize));
    let s = r, e = r;
    while (s > 0 && r - s < maxHalf && lastCol[s - 1] >= v * 0.7) s--;
    while (e < PRICE_ROWS - 1 && e - r < maxHalf && lastCol[e + 1] >= v * 0.7) e++;
    const prev = bands[bands.length - 1];
    if (prev && s <= prev.rowEnd) { prev.rowEnd = Math.max(prev.rowEnd, e); prev.peakHeat = Math.max(prev.peakHeat, v); }
    else bands.push({ rowStart: s, rowEnd: e, peakHeat: v });
  }

  let lastSum = 0;
  for (let r = 0; r < PRICE_ROWS; r++) lastSum += lastCol[r];

  const toInfo = (b: typeof bands[0]): ClusterInfo => {
    const center   = rowToPrice(Math.round((b.rowStart + b.rowEnd) / 2));
    const strength = Math.min(1, b.peakHeat / ref);
    let bandSum = 0;
    for (let r = b.rowStart; r <= b.rowEnd; r++) bandSum += lastCol[r];
    return {
      priceLo: rowToPrice(b.rowStart), priceHi: rowToPrice(b.rowEnd),
      priceCenter: center, strength, share: lastSum > 0 ? bandSum / lastSum : 0,
      label: strength >= 0.65 ? "extreme" : strength >= 0.38 ? "high" : "moderate",
      distancePct: ((center - currentPrice) / currentPrice) * 100,
    };
  };

  const all           = bands.map(toInfo);
  const below         = all.filter(c => c.priceCenter < currentPrice * 0.9998);
  const above         = all.filter(c => c.priceCenter > currentPrice * 1.0002);
  const longClusters  = [...below].sort((a, b) => b.strength - a.strength).slice(0, 3);
  const shortClusters = [...above].sort((a, b) => b.strength - a.strength).slice(0, 3);
  // Nearest zone that's at least "moderate+" (a real band, not a faint line).
  const closest = (xs: ClusterInfo[]) => {
    const strong = xs.filter(c => c.strength >= 0.35);
    const pool = strong.length ? strong : xs;
    return pool.length ? pool.reduce((a, b) => (Math.abs(b.distancePct) < Math.abs(a.distancePct) ? b : a)) : null;
  };
  const nearLong = closest(below), nearShort = closest(above);

  const ls = longClusters.reduce((s, c) => s + c.strength, 0);
  const ss = shortClusters.reduce((s, c) => s + c.strength, 0);
  const sr = (ls + ss) > 0 ? ss / (ls + ss) : 0.5;
  const dominantSide: LiqAnalysis["dominantSide"] = sr > 0.56 ? "short" : sr < 0.44 ? "long" : "balanced";

  const fmt = (p: number) => p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const tS  = shortClusters[0], tL = longClusters[0];
  let summary = "";
  let summaryKey: LiqAnalysis["summaryKey"] = null;
  if (dominantSide === "short" && tS) {
    summaryKey = "shortDominant";
    summary = `Short-side liquidation pressure is dominant. Breaking above $${fmt(tS.priceCenter)} could trigger a cascade.`;
  } else if (dominantSide === "long" && tL) {
    summaryKey = "longDominant";
    summary = `Long-side liquidation pressure is dominant. A drop below $${fmt(tL.priceCenter)} could trigger cascading liquidations.`;
  } else if (tS && tL) {
    summaryKey = "balanced";
    summary = `Balanced pressure. Key magnets: $${fmt(tL.priceCenter)} below and $${fmt(tS.priceCenter)} above.`;
  }
  const summaryAbove = tS ? tS.priceCenter : null;
  const summaryBelow = tL ? tL.priceCenter : null;

  return { longClusters, shortClusters, nearLong, nearShort, dominantSide, currentPrice, summary, summaryKey, summaryAbove, summaryBelow };
}
