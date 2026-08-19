import { CandleDataPoint } from "../services/coinglass";

/* ── Synthetic liquidation-heatmap simulation ──────────────────────────────
 * There's no real order-book liquidation feed here — this estimates where
 * leveraged longs/shorts would be sitting based on price distance and a
 * fixed set of leverage tiers, the same approach the Liquidation Heatmap
 * page uses. Shared so other features (e.g. zone AI analysis) can reuse the
 * exact same cluster math instead of re-deriving it. */

export const PRICE_ROWS = 700;
const DECAY = 0.968; // slow decay → long persistent bands like CoinGlass
const BLUR_R = 1;    // minimal blur → thin CoinGlass-style lines

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

  for (let col = 0; col < cols; col++) {
    const c   = candles[col];
    const mid = (c.open + c.close) / 2;
    const vol = Math.max((c.high - c.low) / pRange, 0.002);

    for (let r = 0; r < PRICE_ROWS; r++) acc[r] *= DECAY;

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
}
export interface LiqAnalysis {
  longClusters: ClusterInfo[]; shortClusters: ClusterInfo[];
  dominantSide: "long" | "short" | "balanced";
  currentPrice: number; summary: string;
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

  const THRESHOLD = 0.20;
  const bands: { rowStart: number; rowEnd: number; peakHeat: number }[] = [];
  let open = false, start = 0, peak = 0;
  for (let r = 0; r < PRICE_ROWS; r++) {
    const v = lastCol[r] / maxVal;
    if (v >= THRESHOLD) {
      if (!open) { open = true; start = r; peak = 0; }
      if (lastCol[r] > peak) peak = lastCol[r];
    } else if (open) {
      bands.push({ rowStart: start, rowEnd: r - 1, peakHeat: peak });
      open = false;
    }
  }
  if (open) bands.push({ rowStart: start, rowEnd: PRICE_ROWS - 1, peakHeat: peak });

  const toInfo = (b: typeof bands[0]): ClusterInfo => {
    const center   = rowToPrice(Math.round((b.rowStart + b.rowEnd) / 2));
    const strength = b.peakHeat / maxVal;
    return {
      priceLo: rowToPrice(b.rowStart), priceHi: rowToPrice(b.rowEnd),
      priceCenter: center, strength,
      label: strength >= 0.65 ? "extreme" : strength >= 0.38 ? "high" : "moderate",
      distancePct: ((center - currentPrice) / currentPrice) * 100,
    };
  };

  const all           = bands.map(toInfo);
  const longClusters  = all.filter(c => c.priceCenter < currentPrice * 0.9998).sort((a, b) => b.strength - a.strength).slice(0, 3);
  const shortClusters = all.filter(c => c.priceCenter > currentPrice * 1.0002).sort((a, b) => b.strength - a.strength).slice(0, 3);

  const ls = longClusters.reduce((s, c) => s + c.strength, 0);
  const ss = shortClusters.reduce((s, c) => s + c.strength, 0);
  const sr = (ls + ss) > 0 ? ss / (ls + ss) : 0.5;
  const dominantSide: LiqAnalysis["dominantSide"] = sr > 0.56 ? "short" : sr < 0.44 ? "long" : "balanced";

  const fmt = (p: number) => p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const tS  = shortClusters[0], tL = longClusters[0];
  let summary = "";
  if (dominantSide === "short" && tS) summary = `Short-side liquidation pressure is dominant. Breaking above $${fmt(tS.priceCenter)} could trigger a cascade.`;
  else if (dominantSide === "long" && tL) summary = `Long-side liquidation pressure is dominant. A drop below $${fmt(tL.priceCenter)} could trigger cascading liquidations.`;
  else if (tS && tL) summary = `Balanced pressure. Key magnets: $${fmt(tL.priceCenter)} below and $${fmt(tS.priceCenter)} above.`;

  return { longClusters, shortClusters, dominantSide, currentPrice, summary };
}
