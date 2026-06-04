import React, { useEffect, useMemo, useRef, useState } from "react";
import { coinglass, CandleDataPoint, CoinSymbol, HeatmapRange } from "../services/coinglass";
import { openaiLiq, LiqAIResponse } from "../services/openai";
import { useAIQuota } from "../hooks/useAIQuota";
import { AIQuotaWall } from "./AIQuotaWall";
import "../styles/LiquidationHeatmap.css";

/* ── Constants ─────────────────────────────────────────────────────────────── */
const PRICE_ROWS  = 700;
const CANVAS_H    = 480;
const PAD_RIGHT   = 90;   // price axis
const TOTAL_PAD_R = PAD_RIGHT;
const PAD_BOTTOM  = 30;
const DECAY       = 0.93;   // faster decay → finer, less persistent bands
const BLUR_R      = 1;      // minimal blur → thin CoinGlass-style lines

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/* ── Color palettes ─────────────────────────────────────────────────────────── */
type ColorStop = [number, [number, number, number]];

const PALETTES: { stops: ColorStop[]; css: string }[] = [
  {
    // CoinGlass-style: near-black → deep purple → violet → magenta → hot pink → white
    css: "linear-gradient(135deg,#08060f 0%,#2a006a 30%,#7700cc 55%,#dd00aa 75%,#ff44cc 90%,#ffffff 100%)",
    stops: [
      [0.00, [  8,   6,  15]],
      [0.05, [ 14,   8,  35]],
      [0.14, [ 30,   0,  80]],
      [0.28, [ 70,   0, 160]],
      [0.44, [140,   0, 200]],
      [0.58, [200,   0, 160]],
      [0.70, [230,  30, 130]],
      [0.82, [255,  80, 180]],
      [0.92, [255, 160, 210]],
      [1.00, [255, 230, 245]],
    ],
  },
  {
    css: "linear-gradient(135deg,#04030f 0%,#8C0000 40%,#FF6000 70%,#FFD000 100%)",
    stops: [
      [0.00, [  4,   3,  15]],
      [0.15, [ 40,   0,   0]],
      [0.35, [140,  10,   0]],
      [0.58, [220,  60,   0]],
      [0.80, [255, 150,   0]],
      [1.00, [255, 235,   0]],
    ],
  },
  {
    css: "linear-gradient(135deg,#05050f 0%,#0050C0 50%,#C0E8FF 100%)",
    stops: [
      [0.00, [  5,   5,  15]],
      [0.20, [  0,  20, 100]],
      [0.45, [  0,  80, 200]],
      [0.70, [  0, 180, 230]],
      [0.88, [100, 220, 255]],
      [1.00, [210, 245, 255]],
    ],
  },
  {
    css: "linear-gradient(135deg,#080808 0%,#888 50%,#f0f0f0 100%)",
    stops: [
      [0.00, [  8,   8,   8]],
      [0.30, [ 50,  50,  50]],
      [0.60, [120, 120, 120]],
      [0.85, [190, 190, 190]],
      [1.00, [240, 240, 240]],
    ],
  },
];

/* ── Range definitions ──────────────────────────────────────────────────────── */
const RANGES: { key: HeatmapRange; label: string }[] = [
  { key: "12h", label: "12H" },
  { key: "1d",  label: "1D"  },
  { key: "2d",  label: "2D"  },
  { key: "3d",  label: "3D"  },
  { key: "1w",  label: "1W"  },
  { key: "1m",  label: "1M"  },
  { key: "3m",  label: "3M"  },
];

const LEVERAGES_ALL = [10, 25, 50, 100, 125, 200] as const;
type Lev = typeof LEVERAGES_ALL[number];
const LEV_WEIGHTS: Record<Lev, number> = { 10: 0.35, 25: 0.55, 50: 1.0, 100: 0.80, 125: 0.60, 200: 0.30 };

interface Props {
  coin: CoinSymbol;
  theme?: "dark" | "light";
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
}

interface TooltipData {
  x: number; y: number;
  dateStr: string; price: number; heatVal: number; liqUSD: number;
}

interface RenderStore {
  pMin: number; pMax: number; maxVal: number;
  matrix: Float32Array;
  visibleCandles: CandleDataPoint[];
}

/* ── Colour interpolation ───────────────────────────────────────────────────── */
function heatRgb(v: number, stops: ColorStop[]): [number, number, number] {
  const pos = Math.max(0, Math.min(1, v));
  let lo = stops.length - 2;
  for (let i = 0; i < stops.length - 1; i++) {
    if (pos <= stops[i + 1][0]) { lo = i; break; }
  }
  const hi = lo + 1;
  const t  = (pos - stops[lo][0]) / (stops[hi][0] - stops[lo][0]);
  const [r1,g1,b1] = stops[lo][1];
  const [r2,g2,b2] = stops[hi][1];
  return [
    Math.round(r1 + (r2 - r1) * t),
    Math.round(g1 + (g2 - g1) * t),
    Math.round(b1 + (b2 - b1) * t),
  ];
}

/* ── Gaussian blur ──────────────────────────────────────────────────────────── */
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

/* ── Heat matrix ────────────────────────────────────────────────────────────── */
function buildMatrix(candles: CandleDataPoint[], activeLevs: Lev[]) {
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

/* ── Cluster analysis ───────────────────────────────────────────────────────── */
interface ClusterInfo {
  priceLo: number; priceHi: number; priceCenter: number;
  strength: number; label: "extreme" | "high" | "moderate"; distancePct: number;
}
interface LiqAnalysis {
  longClusters: ClusterInfo[]; shortClusters: ClusterInfo[];
  dominantSide: "long" | "short" | "balanced";
  currentPrice: number; summary: string;
}

function analyseLiquidations(candles: CandleDataPoint[], activeLevs: Lev[]): LiqAnalysis | null {
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

/* ── Canvas renderer ────────────────────────────────────────────────────────── */
function renderCanvas(
  canvas: HTMLCanvasElement,
  candles: CandleDataPoint[],
  activeLevs: Lev[],
  theme: "dark" | "light",
  palette: number,
  threshold: number,
  showLiqMap: boolean,
  storeRef?: { current: RenderStore | null },
) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !candles.length) return;

  const W      = canvas.width - TOTAL_PAD_R;
  const H      = canvas.height - PAD_BOTTOM;
  const isDark = theme !== "light";
  const stops  = PALETTES[palette].stops;

  const { matrix, pMin, pMax, maxVal, cols } = buildMatrix(candles, activeLevs);
  if (maxVal === 0) return;

  if (storeRef) storeRef.current = { pMin, pMax, maxVal, matrix, visibleCandles: candles };

  // Background — near-black with purple tint, matching CoinGlass
  const BG = isDark ? "#08060f" : "#ffffff";
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  /* ── Heatmap ────────────────────────────────────────────────────────────── */
  if (showLiqMap) {
    // Pre-fill imgData with the background colour so skipped pixels aren't black
    const imgData = ctx.createImageData(W, H);
    const data    = imgData.data;
    if (isDark) {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 8; data[i + 1] = 6; data[i + 2] = 15; data[i + 3] = 255;
      }
    } else {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
      }
    }

    const minDisplay = (1 - threshold) * 0.04;

    for (let col = 0; col < cols; col++) {
      const xStart = Math.floor((col / cols) * W);
      const xEnd   = Math.floor(((col + 1) / cols) * W);
      const base   = col * PRICE_ROWS;

      for (let row = 0; row < PRICE_ROWS; row++) {
        const raw = matrix[base + row] / maxVal;
        if (raw < minDisplay) continue;

        const v         = Math.pow(raw, 0.38);
        const [r, g, b] = heatRgb(v, stops);

        const yTop    = Math.floor(H - ((row + 1) / PRICE_ROWS) * H);
        const yBottom = Math.max(yTop + 1, Math.floor(H - (row / PRICE_ROWS) * H));

        for (let y = yTop; y < yBottom; y++) {
          for (let x = xStart; x < xEnd; x++) {
            const idx = (y * W + x) * 4;
            data[idx]     = r;
            data[idx + 1] = g;
            data[idx + 2] = b;
            data[idx + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /* ── Grid lines ─────────────────────────────────────────────────────────── */
  ctx.strokeStyle = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)";
  ctx.lineWidth   = 1;
  for (let i = 1; i < 8; i++) {
    const y = Math.round((i / 8) * H);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  /* ── Candlesticks ───────────────────────────────────────────────────────── */
  const pToY = (p: number) => H - ((p - pMin) / (pMax - pMin)) * H;
  const cw   = W / cols;

  for (let i = 0; i < cols; i++) {
    const c    = candles[i];
    const cx   = (i + 0.5) * cw;
    const bull = c.close >= c.open;
    const bodyColor = bull ? "rgba(38,166,154,0.95)" : "rgba(239,83,80,0.95)";
    const wickColor = bull ? "rgba(38,166,154,0.7)"  : "rgba(239,83,80,0.7)";

    // Wick — always 1px, CoinGlass style
    ctx.strokeStyle = wickColor;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx), pToY(c.high));
    ctx.lineTo(Math.round(cx), pToY(c.low));
    ctx.stroke();

    // Body — narrow, ~35% of column width
    const bodyTop = Math.min(pToY(c.open), pToY(c.close));
    const bodyH   = Math.max(Math.abs(pToY(c.close) - pToY(c.open)), 1);
    const halfW   = Math.max(0.5, cw * 0.175);
    ctx.fillStyle = bodyColor;
    ctx.fillRect(Math.round(cx - halfW), bodyTop, Math.round(halfW * 2), bodyH);
  }

  /* ── Current price dashed line ─────────────────────────────────────────── */
  const last  = candles[candles.length - 1].close;
  const lastY = pToY(last);
  ctx.save();
  ctx.strokeStyle = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.4)";
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, lastY); ctx.lineTo(W, lastY); ctx.stroke();
  ctx.restore();

  /* ── Price axis ─────────────────────────────────────────────────────────── */
  const axisX = W;
  ctx.fillStyle = isDark ? "#08060f" : "#fff";
  ctx.fillRect(axisX, 0, PAD_RIGHT, H + PAD_BOTTOM);
  ctx.strokeStyle = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)";
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(axisX, 0); ctx.lineTo(axisX, H); ctx.stroke();

  ctx.font      = "11px -apple-system,sans-serif";
  ctx.fillStyle = isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.55)";
  for (let i = 0; i <= 7; i++) {
    const price = pMin + (pMax - pMin) * (i / 7);
    const y     = H - (i / 7) * H;
    ctx.fillText(
      price >= 1000
        ? price.toLocaleString("en-US", { maximumFractionDigits: 0 })
        : price.toLocaleString("en-US", { maximumFractionDigits: 2 }),
      axisX + 5, y + 4,
    );
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)";
    ctx.beginPath(); ctx.moveTo(axisX, y); ctx.lineTo(axisX + 4, y); ctx.stroke();
  }

  // Current price badge
  const priceStr = last >= 1000
    ? last.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : last.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const bH = 18, bX = axisX + 2, bW = PAD_RIGHT - 4, bY = lastY - bH / 2;
  ctx.fillStyle = "#4ade80";
  ctx.beginPath();
  ctx.roundRect?.(bX, bY, bW, bH, 3) ?? ctx.rect(bX, bY, bW, bH);
  ctx.fill();
  ctx.fillStyle  = "#000";
  ctx.font       = "bold 10px monospace";
  ctx.textAlign  = "center";
  ctx.fillText(priceStr, bX + bW / 2, lastY + 4);
  ctx.textAlign  = "left";

  /* ── Bottom time axis ───────────────────────────────────────────────────── */
  const candleSpan = candles.length > 1 ? candles[1].time - candles[0].time : 3600;
  const showDate   = candleSpan >= 3600;
  const pts        = [0, 0.2, 0.4, 0.6, 0.8, 1].map(f => Math.min(Math.floor(f * (cols - 1)), cols - 1));

  ctx.fillStyle = isDark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.45)";
  ctx.font      = "10px -apple-system,sans-serif";
  for (const ci of pts) {
    const x = ((ci + 0.5) / cols) * W;
    const d = new Date(candles[ci].time * 1000);
    const label = showDate
      ? `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`
      : `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    ctx.fillText(label, Math.max(0, Math.min(x - 18, W - 70)), H + 20);
  }
}

/* ── Palette bar CSS gradient ───────────────────────────────────────────────── */
function paletteCssBar(stops: ColorStop[]): string {
  const parts = [...stops].reverse().map(([t, [r,g,b]]) =>
    `rgb(${r},${g},${b}) ${((1 - t) * 100).toFixed(1)}%`
  );
  return `linear-gradient(to bottom, ${parts.join(", ")})`;
}

/* ── Component ──────────────────────────────────────────────────────────────── */
export const LiquidationHeatmap: React.FC<Props> = ({
  coin, theme = "dark", onOpenAuth = () => {}, onOpenUpgrade = () => {},
}) => {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const candlesRef    = useRef<CandleDataPoint[]>([]);
  const levsRef       = useRef<Lev[]>([10, 25, 50, 100, 125, 200]);
  const zoomRef       = useRef(1);
  const panRef        = useRef(0);
  const dragRef       = useRef<{ x: number; pan: number } | null>(null);
  const pinchRef      = useRef<number | null>(null);
  const lastRenderRef = useRef<RenderStore | null>(null);
  const rafRef        = useRef<number | null>(null);

  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");
  const [rangeIdx,   setRangeIdx]   = useState(6); // default "3M"
  const [activeLevs, setActiveLevs] = useState<Lev[]>([10, 25, 50, 100, 125, 200]);
  const [zoomLevel,  setZoomLevel]  = useState(1);
  const [analysis,   setAnalysis]   = useState<LiqAnalysis | null>(null);
  const [aiResult,   setAiResult]   = useState<LiqAIResponse | null>(null);
  const [aiLoading,  setAiLoading]  = useState(false);
  const [aiError,    setAiError]    = useState("");
  const [tooltip,    setTooltip]    = useState<TooltipData | null>(null);
  const [palette,    setPalette]    = useState(0);
  const [threshold,  setThreshold]  = useState(1);
  const [showLiqMap, setShowLiqMap] = useState(true);
  const { exceeded, used, limit, consume } = useAIQuota();

  const range = RANGES[rangeIdx];

  const barGradient = useMemo(() => paletteCssBar(PALETTES[palette].stops), [palette]);

  const cb = useRef({
    getVisible:  (): CandleDataPoint[] => [],
    clampPan:    () => {},
    redraw:      () => {},
    schedRedraw: () => {},
    applyZoom:   (_f: number, _focal?: number) => {},
    smoothZoom:  (_f: number) => {},
  });

  cb.current.getVisible = () => {
    const all     = candlesRef.current;
    const visible = Math.max(10, Math.round(all.length / zoomRef.current));
    const end     = all.length - Math.max(0, Math.min(panRef.current, all.length - visible));
    return all.slice(Math.max(0, end - visible), end);
  };
  cb.current.clampPan = () => {
    const all     = candlesRef.current;
    const visible = Math.max(10, Math.round(all.length / zoomRef.current));
    panRef.current = Math.max(0, Math.min(panRef.current, all.length - visible));
  };
  cb.current.redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !candlesRef.current.length) return;
    if (canvas.width < 10 && wrapRef.current) {
      canvas.width  = wrapRef.current.clientWidth;
      canvas.height = CANVAS_H;
    }
    renderCanvas(canvas, cb.current.getVisible(), levsRef.current, theme, palette, threshold, showLiqMap, lastRenderRef);
  };
  // Deduplicated RAF-scheduled redraw — cancels any pending frame before scheduling a new one
  cb.current.schedRedraw = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      cb.current.redraw();
    });
  };
  // Focal-point zoom: focalFraction [0,1] keeps the candle under the cursor fixed
  cb.current.applyZoom = (factor: number, focalFraction?: number) => {
    const all     = candlesRef.current;
    const oldZoom = zoomRef.current;
    const newZoom = Math.max(1, Math.min(30, oldZoom * factor));

    if (focalFraction !== undefined && all.length > 0) {
      const oldVisible = Math.max(10, Math.round(all.length / oldZoom));
      const oldEnd     = all.length - Math.max(0, panRef.current);
      const oldStart   = oldEnd - oldVisible;
      const candleIdx  = oldStart + focalFraction * oldVisible;
      const newVisible = Math.max(10, Math.round(all.length / newZoom));
      panRef.current   = all.length - candleIdx - newVisible * (1 - focalFraction);
    }

    zoomRef.current = newZoom;
    cb.current.clampPan();
    setZoomLevel(newZoom);
    cb.current.schedRedraw();
  };
  // Smooth animated zoom for button clicks (8 micro-steps over ~130 ms)
  cb.current.smoothZoom = (totalFactor: number) => {
    const steps   = 8;
    const perStep = Math.pow(totalFactor, 1 / steps);
    let step      = 0;
    const tick = () => {
      if (step >= steps) return;
      zoomRef.current = Math.max(1, Math.min(30, zoomRef.current * perStep));
      cb.current.clampPan();
      cb.current.redraw();
      step++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setZoomLevel(zoomRef.current); // will update again after animation via redraw
  };

  useEffect(() => { levsRef.current = activeLevs; cb.current.redraw(); }, [activeLevs]);
  useEffect(() => { cb.current.redraw(); }, [palette, threshold, showLiqMap]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); candlesRef.current = [];
    zoomRef.current = 1; panRef.current = 0; setZoomLevel(1);
    setAiResult(null); setAiError(""); setTooltip(null);

    coinglass.getHeatmapCandles(range.key, coin).then(data => {
      if (cancelled) return;
      if (!data.length) { setError("No data"); setLoading(false); return; }
      candlesRef.current = data;
      setLoading(false);
    }).catch(() => { if (!cancelled) { setError("Failed to load"); setLoading(false); } });

    return () => { cancelled = true; };
  }, [coin, range.key]);

  useEffect(() => {
    if (!loading && candlesRef.current.length) {
      cb.current.redraw();
      const liqAnalysis = analyseLiquidations(candlesRef.current, levsRef.current);
      setAnalysis(liqAnalysis);
      if (liqAnalysis && !exceeded) fetchAIAnalysis(liqAnalysis);
    }
  }, [loading, theme]);

  useEffect(() => {
    const wrap   = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const ro = new ResizeObserver(() => {
      canvas.width  = wrap.clientWidth;
      canvas.height = CANVAS_H;
      cb.current.redraw();
    });
    ro.observe(wrap);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect          = canvas.getBoundingClientRect();
      const chartW        = rect.width - TOTAL_PAD_R;
      const focalFraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / chartW));
      cb.current.applyZoom(e.deltaY < 0 ? 1.12 : 0.89, focalFraction);
    };

    const onMouseDown = (e: MouseEvent) => {
      canvas.style.cursor = "grabbing";
      dragRef.current = { x: e.clientX, pan: panRef.current };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const visible  = Math.max(10, Math.round(candlesRef.current.length / zoomRef.current));
        const pxPerCnd = (canvas.width - TOTAL_PAD_R) / visible;
        panRef.current = dragRef.current.pan + Math.round((dragRef.current.x - e.clientX) / pxPerCnd);
        cb.current.clampPan();
        cb.current.redraw();
        setTooltip(null);
        return;
      }

      const rd = lastRenderRef.current;
      if (!rd || !rd.visibleCandles.length) return;

      const rect   = canvas.getBoundingClientRect();
      const scaleX = canvas.width  / rect.width;
      const scaleY = canvas.height / rect.height;
      const mx     = (e.clientX - rect.left) * scaleX;
      const my     = (e.clientY - rect.top)  * scaleY;
      const W      = canvas.width - TOTAL_PAD_R;
      const H      = canvas.height - PAD_BOTTOM;

      if (mx < 0 || mx >= W || my < 0 || my >= H) { setTooltip(null); return; }

      const colIdx  = Math.min(Math.floor((mx / W) * rd.visibleCandles.length), rd.visibleCandles.length - 1);
      const rowIdx  = Math.min(Math.floor(((H - my) / H) * PRICE_ROWS), PRICE_ROWS - 1);
      const candle  = rd.visibleCandles[colIdx];
      const price   = rd.pMin + ((rowIdx + 0.5) / PRICE_ROWS) * (rd.pMax - rd.pMin);
      const rawHeat = rd.matrix[colIdx * PRICE_ROWS + rowIdx];
      const heatVal = rd.maxVal > 0 ? rawHeat / rd.maxVal : 0;
      const liqUSD  = rawHeat * 320 * 1_000_000;

      const d       = new Date(candle.time * 1000);
      const dateStr = `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;

      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, dateStr, price, heatVal, liqUSD });
    };

    const onMouseUp  = () => { dragRef.current = null; canvas.style.cursor = "grab"; };
    const onMouseOut = () => setTooltip(null);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchRef.current = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
      } else if (e.touches.length === 1) {
        dragRef.current = { x: e.touches[0].clientX, pan: panRef.current };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 2 && pinchRef.current !== null) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        const rect          = canvas.getBoundingClientRect();
        const midX          = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const chartW        = rect.width - TOTAL_PAD_R;
        const focalFraction = Math.max(0, Math.min(1, (midX - rect.left) / chartW));
        cb.current.applyZoom(dist / pinchRef.current, focalFraction);
        pinchRef.current = dist;
      } else if (e.touches.length === 1 && dragRef.current) {
        const visible  = Math.max(10, Math.round(candlesRef.current.length / zoomRef.current));
        const pxPerCnd = (canvas.width - TOTAL_PAD_R) / visible;
        panRef.current = dragRef.current.pan + Math.round((dragRef.current.x - e.touches[0].clientX) / pxPerCnd);
        cb.current.clampPan();
        cb.current.redraw();
      }
    };
    const onTouchEnd = () => { dragRef.current = null; pinchRef.current = null; };

    canvas.addEventListener("wheel",      onWheel,      { passive: false });
    canvas.addEventListener("mousedown",  onMouseDown);
    window.addEventListener("mousemove",  onMouseMove);
    window.addEventListener("mouseup",    onMouseUp);
    canvas.addEventListener("mouseleave", onMouseOut);
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove",  onTouchMove,  { passive: false });
    canvas.addEventListener("touchend",   onTouchEnd);

    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel",      onWheel);
      canvas.removeEventListener("mousedown",  onMouseDown);
      window.removeEventListener("mousemove",  onMouseMove);
      window.removeEventListener("mouseup",    onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseOut);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove",  onTouchMove);
      canvas.removeEventListener("touchend",   onTouchEnd);
    };
  }, []);

  const fetchAIAnalysis = async (liqAnalysis?: LiqAnalysis | null) => {
    const src = liqAnalysis ?? analysis;
    if (!src || exceeded) return;
    if (!consume()) return;
    setAiLoading(true); setAiError("");
    const res = await openaiLiq.getLiquidationAnalysis({
      coin, range: range.key,
      currentPrice:  src.currentPrice,
      dominantSide:  src.dominantSide,
      longClusters:  src.longClusters.map(c => ({ priceCenter: c.priceCenter, strength: c.strength, label: c.label, distancePct: c.distancePct })),
      shortClusters: src.shortClusters.map(c => ({ priceCenter: c.priceCenter, strength: c.strength, label: c.label, distancePct: c.distancePct })),
    });
    if (res.success) setAiResult(res);
    else setAiError(res.error ?? "Failed to generate analysis");
    setAiLoading(false);
  };

  const toggleLev = (lev: Lev) =>
    setActiveLevs(prev =>
      prev.includes(lev) ? (prev.length > 1 ? prev.filter(l => l !== lev) : prev) : [...prev, lev]
    );

  const canvasW      = canvasRef.current?.clientWidth ?? 800;
  const tooltipStyle = tooltip ? {
    left:      tooltip.x + 14,
    top:       Math.max(8, tooltip.y - 56),
    transform: tooltip.x > canvasW * 0.70 ? "translateX(-110%)" : undefined,
  } : {};

  return (
    <div className="lhm-card">

      {/* ── Top header row ─────────────────────────────────────────────────── */}
      <div className="lhm-top-bar">
        <h2 className="lhm-top-title">
          Binance {coin}/USDT Liquidation Heatmap
        </h2>
        <div className="lhm-top-controls">
          <div className="lhm-pair-selector">
            <span>Binance {coin}/USDT Perpetual</span>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
              <path d="M0 0l5 6 5-6z"/>
            </svg>
          </div>
          <div className="lhm-range-stepper">
            <button
              className="lhm-range-arrow"
              onClick={() => setRangeIdx(i => Math.max(0, i - 1))}
              disabled={rangeIdx === 0}
            >‹</button>
            <span className="lhm-range-label">{range.label}</span>
            <button
              className="lhm-range-arrow"
              onClick={() => setRangeIdx(i => Math.min(RANGES.length - 1, i + 1))}
              disabled={rangeIdx === RANGES.length - 1}
            >›</button>
          </div>
          <button className="lhm-icon-btn" title="Refresh" onClick={() => {
            candlesRef.current = []; setLoading(true);
            coinglass.getHeatmapCandles(range.key, coin).then(data => {
              candlesRef.current = data; setLoading(false);
            }).catch(() => setLoading(false));
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>
          <button className="lhm-icon-btn" title="Screenshot">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
              <circle cx="12" cy="13" r="4"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Controls row 2 ─────────────────────────────────────────────────── */}
      <div className="lhm-controls-bar">
        <div className="lhm-palette-row">
          {PALETTES.map((p, i) => (
            <button
              key={i}
              className={`lhm-palette-btn${palette === i ? " active" : ""}`}
              style={{ background: p.css }}
              onClick={() => setPalette(i)}
              title={`Color palette ${i + 1}`}
            />
          ))}
        </div>
        <div className="lhm-threshold-row">
          <span className="lhm-threshold-label">Liquidity Threshold = {threshold.toFixed(2)}</span>
          <input
            className="lhm-threshold-slider"
            type="range" min="0" max="1" step="0.01"
            value={threshold}
            onChange={e => setThreshold(+e.target.value)}
          />
        </div>
        <label className="lhm-liq-map-check">
          <input type="checkbox" checked={showLiqMap} onChange={e => setShowLiqMap(e.target.checked)} />
          <span>Liquidation Map</span>
        </label>
      </div>

      {/* ── Chart area ─────────────────────────────────────────────────────── */}
      <div className="lhm-chart-outer">

        {/* Left scale bar */}
        <div className="lhm-scale-bar-wrap">
          <div className="lhm-scale-max">
            {lastRenderRef.current
              ? `${(lastRenderRef.current.maxVal * 320).toFixed(2)}M`
              : "—"}
          </div>
          <div className="lhm-scale-bar" style={{ background: barGradient }} />
          <div className="lhm-scale-zero">0</div>
        </div>

        {/* Canvas wrapper */}
        <div ref={wrapRef} className="lhm-canvas-wrap">

          {/* Chart series legend */}
          <div className="lhm-series-legend">
            <span className="lhm-series-item">
              <span className="lhm-series-dot lhm-series-dot--purple" />
              Liquidation Leverage
            </span>
            <span className="lhm-series-item">
              <span className="lhm-series-dot lhm-series-dot--green" />
              Supercharts
            </span>
          </div>

          {loading && <div className="lhm-overlay">Loading heatmap…</div>}
          {error   && <div className="lhm-overlay lhm-error">⚠ {error}</div>}

          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", height: CANVAS_H, cursor: "grab" }}
          />

          {/* Hover tooltip */}
          {tooltip && (
            <div className="lhm-tooltip" style={tooltipStyle}>
              <div className="lhm-tooltip-date">{tooltip.dateStr}</div>
              <div className="lhm-tooltip-row">
                <span className="lhm-tooltip-circle" />
                <span className="lhm-tooltip-lbl">Price</span>
                <span className="lhm-tooltip-val">
                  {tooltip.price >= 1000
                    ? tooltip.price.toLocaleString("en-US", { maximumFractionDigits: 1 })
                    : tooltip.price.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                </span>
              </div>
              <div className="lhm-tooltip-row">
                <span className="lhm-tooltip-circle" />
                <span className="lhm-tooltip-lbl">Est. Liquidations</span>
                <span className="lhm-tooltip-val">
                  {tooltip.liqUSD >= 1e9
                    ? `$${(tooltip.liqUSD / 1e9).toFixed(2)}B`
                    : tooltip.liqUSD >= 1e6
                    ? `$${(tooltip.liqUSD / 1e6).toFixed(2)}M`
                    : tooltip.liqUSD >= 1e3
                    ? `$${(tooltip.liqUSD / 1e3).toFixed(1)}K`
                    : `$${tooltip.liqUSD.toFixed(0)}`}
                </span>
              </div>
            </div>
          )}

          {/* Zoom controls */}
          <div className="lhm-zoom-controls">
            <button className="lhm-zoom-btn" onClick={() => cb.current.smoothZoom(1.4)}>+</button>
            <button className="lhm-zoom-btn" onClick={() => cb.current.smoothZoom(0.72)}>−</button>
            {zoomLevel > 1.05 && (
              <button className="lhm-zoom-btn lhm-zoom-reset" onClick={() => {
                zoomRef.current = 1; panRef.current = 0; setZoomLevel(1); cb.current.redraw();
              }}>↺</button>
            )}
          </div>
        </div>
      </div>

      {/* ── Leverage filter ─────────────────────────────────────────────────── */}
      <div className="lhm-lev-row">
        <span className="lhm-lev-label">Leverage</span>
        <div className="lhm-lev-pills">
          {LEVERAGES_ALL.map(lev => (
            <button
              key={lev}
              className={`lhm-lev-pill${activeLevs.includes(lev) ? " active" : ""}`}
              onClick={() => toggleLev(lev)}
            >{lev}×</button>
          ))}
        </div>
      </div>

      <p className="lhm-disclaimer">
        Liquidation zones are estimated from price action and leverage distribution. Not real exchange data.
      </p>

      {/* ── Analysis ────────────────────────────────────────────────────────── */}
      {analysis && !loading && (<>
        <div className="lhm-bottom-row">
          <div className="lhm-analysis">
            <div className="lhm-analysis-header">
              <span className="lhm-analysis-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <rect x="2" y="12" width="4" height="10" rx="1"/>
                  <rect x="9" y="8" width="4" height="14" rx="1"/>
                  <rect x="16" y="4" width="4" height="18" rx="1"/>
                </svg>
                Liquidation Cluster Analysis
              </span>
              <span className="lhm-analysis-badge">
                {range.label} view · current ${analysis.currentPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
            </div>

            <div className="lhm-analysis-grid">
              <div className="lhm-analysis-col">
                <div className="lhm-col-header lhm-col-header--long">
                  <span className="lhm-col-dot lhm-col-dot--long" /> Long Liq Zones
                  <span className="lhm-col-sub">↓ below price</span>
                </div>
                {analysis.longClusters.length === 0
                  ? <div className="lhm-no-cluster">No significant clusters</div>
                  : analysis.longClusters.map((c, i) => (
                    <div key={i} className="lhm-cluster-row">
                      <div className="lhm-cluster-price">
                        ${c.priceLo.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        <span className="lhm-cluster-sep"> – </span>
                        ${c.priceHi.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </div>
                      <div className="lhm-cluster-meta">
                        <span className={`lhm-cluster-label lhm-cluster-label--${c.label}`}>{c.label}</span>
                        <span className="lhm-cluster-dist lhm-cluster-dist--neg">{c.distancePct.toFixed(1)}%</span>
                      </div>
                      <div className="lhm-cluster-bar-track">
                        <div className="lhm-cluster-bar-fill lhm-cluster-bar-fill--long" style={{ width: `${Math.round(c.strength * 100)}%` }} />
                      </div>
                    </div>
                  ))
                }
              </div>

              <div className="lhm-analysis-col">
                <div className="lhm-col-header lhm-col-header--short">
                  <span className="lhm-col-dot lhm-col-dot--short" /> Short Liq Zones
                  <span className="lhm-col-sub">↑ above price</span>
                </div>
                {analysis.shortClusters.length === 0
                  ? <div className="lhm-no-cluster">No significant clusters</div>
                  : analysis.shortClusters.map((c, i) => (
                    <div key={i} className="lhm-cluster-row">
                      <div className="lhm-cluster-price">
                        ${c.priceLo.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                        <span className="lhm-cluster-sep"> – </span>
                        ${c.priceHi.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                      </div>
                      <div className="lhm-cluster-meta">
                        <span className={`lhm-cluster-label lhm-cluster-label--${c.label}`}>{c.label}</span>
                        <span className="lhm-cluster-dist lhm-cluster-dist--pos">+{c.distancePct.toFixed(1)}%</span>
                      </div>
                      <div className="lhm-cluster-bar-track">
                        <div className="lhm-cluster-bar-fill lhm-cluster-bar-fill--short" style={{ width: `${Math.round(c.strength * 100)}%` }} />
                      </div>
                    </div>
                  ))
                }
              </div>
            </div>

            {analysis.summary && (
              <div className={`lhm-summary lhm-summary--${analysis.dominantSide}`}>
                💡 {analysis.summary}
              </div>
            )}
          </div>

          {exceeded ? (
            <div className="lhm-ai-section lhm-ai-section--quota">
              <AIQuotaWall used={used} limit={limit} onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth} />
            </div>
          ) : (
            <div className="lhm-ai-section">
              <div className="lhm-ai-header">
                <div className="lhm-ai-title">
                  <span className="lhm-ai-star">✦</span>
                  AI Analysis
                  <span className="lhm-ai-badge">✦ AI Powered</span>
                </div>
                {!aiLoading && (
                  <button className="lhm-ai-refresh-btn" onClick={() => fetchAIAnalysis()} title="Regenerate">↺</button>
                )}
              </div>

              {aiLoading && (
                <div className="lhm-ai-loading">
                  <span className="lhm-ai-spinner" />
                  Analyzing liquidation clusters…
                </div>
              )}
              {aiError && !aiLoading && <div className="lhm-ai-error">{aiError}</div>}
              {aiResult && !aiLoading && (
                <div className="lhm-ai-result">
                  <div className={`lhm-ai-sentiment lhm-ai-sentiment--${aiResult.sentiment ?? "neutral"}`}>
                    <span className="lhm-ai-sentiment-dot" />
                    {aiResult.sentiment?.charAt(0).toUpperCase()}{aiResult.sentiment?.slice(1)}
                  </div>
                  {aiResult.analysis && <p className="lhm-ai-analysis">{aiResult.analysis}</p>}
                  {aiResult.ourTake && (
                    <div className={`lhm-ai-our-take lhm-ai-our-take--${aiResult.ourTakeAction ?? "watch"}`}>
                      <div className="lhm-ai-our-take-label">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                          <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z"/>
                        </svg>
                        Our Take
                        {aiResult.ourTakeAction && (
                          <span className={`lhm-ai-action-badge lhm-ai-action-badge--${aiResult.ourTakeAction}`}>
                            {aiResult.ourTakeAction.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <p className="lhm-ai-our-take-text">{aiResult.ourTake}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </>)}
    </div>
  );
};
