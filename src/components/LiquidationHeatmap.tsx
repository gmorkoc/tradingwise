import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { coinglass, CandleDataPoint, CoinSymbol, HeatmapRange } from "../services/coinglass";
import { openaiLiq, LiqAIResponse } from "../services/openai";
import { useAIQuota } from "../hooks/useAIQuota";
import { useAuth } from "../contexts/AuthContext";
import { AIQuotaWall } from "./AIQuotaWall";
import { BottomSheet } from "./BottomSheet";
import { PRICE_ROWS, LEVERAGES_ALL, Lev, LiqAnalysis, buildMatrix, analyseLiquidations } from "../utils/liquidationClusters";
import "../styles/LiquidationHeatmap.css";

/* ── Constants ─────────────────────────────────────────────────────────────── */
const CANVAS_H    = 480;
const PAD_RIGHT   = 90;   // price axis
const TOTAL_PAD_R = PAD_RIGHT;
const PAD_BOTTOM  = 30;

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
/** Translated short month names ("Jan,Feb,…"), falling back to English. */
const monthNames = (csv: string): string[] => {
  const m = csv.split(",").map(s => s.trim());
  return m.length === 12 ? m : MONTH_SHORT;
};

/* ── Color palettes ─────────────────────────────────────────────────────────── */
type ColorStop = [number, [number, number, number]];

const PALETTES: { stops: ColorStop[]; css: string }[] = [
  {
    // Viridis: purple background → blue → teal → green → yellow (hot levels).
    css: "linear-gradient(135deg,#440154 0%,#3b528b 25%,#21918c 50%,#5ec962 75%,#fde725 100%)",
    stops: [
      [0.00, [ 68,   1,  84]],
      [0.13, [ 72,  36, 117]],
      [0.25, [ 59,  82, 139]],
      [0.38, [ 44, 114, 142]],
      [0.50, [ 33, 145, 140]],
      [0.63, [ 40, 174, 128]],
      [0.75, [ 94, 201,  98]],
      [0.88, [170, 220,  50]],
      [1.00, [253, 231,  37]],
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
// `long` is the English name; the UI shows t(`heatmapPro.ranges.${key}`).
const RANGES: { key: HeatmapRange; label: string; long: string }[] = [
  { key: "12h", label: "12H", long: "12 hour"  },
  { key: "1d",  label: "1D",  long: "24 hour"  },
  { key: "2d",  label: "2D",  long: "48 hour"  },
  { key: "3d",  label: "3D",  long: "3 day"    },
  { key: "1w",  label: "1W",  long: "1 week"   },
  { key: "1m",  label: "1M",  long: "1 month"  },
  { key: "3m",  label: "3M",  long: "3 month"  },
];

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
  /** Total heat of the latest column = all still-open levels (≙ open interest). */
  lastSum: number;
  matrix: Float32Array;
  visibleCandles: CandleDataPoint[];
}

/* ── Heatmap settings ───────────────────────────────────────────────────────── */
interface Sensitivity { lo: number; hi: number }
const SENS_DEFAULT: Sensitivity = { lo: 0, hi: 1 };
// `label` is the English name; the UI shows t(`heatmapPro.presets.${key}`).
const SENS_PRESETS: { key: string; label: string; value: Sensitivity }[] = [
  { key: "high",   label: "High",   value: { lo: 0,    hi: 0.35 } },
  { key: "medium", label: "Medium", value: { lo: 0,    hi: 0.6  } },
  { key: "low",    label: "Low",    value: { lo: 0.05, hi: 1    } },
];
const HIST_BINS = 48;
const MERGE_MAX = 20;

/** Sum every `n` neighbouring price rows so nearby levels read as one band. */
function mergeMatrixRows(matrix: Float32Array, cols: number, n: number) {
  const out = new Float32Array(matrix.length);
  let maxVal = 0;
  for (let c = 0; c < cols; c++) {
    const b = c * PRICE_ROWS;
    for (let r0 = 0; r0 < PRICE_ROWS; r0 += n) {
      const r1 = Math.min(PRICE_ROWS, r0 + n);
      let s = 0;
      for (let r = r0; r < r1; r++) s += matrix[b + r];
      for (let r = r0; r < r1; r++) out[b + r] = s;
      if (s > maxVal) maxVal = s;
    }
  }
  return { matrix: out, maxVal };
}

/** How many cells sit at each strength (0…1 of the strongest), empty cells skipped. */
function intensityHistogram(matrix: Float32Array, maxVal: number): number[] {
  const h = new Array<number>(HIST_BINS).fill(0);
  if (!maxVal) return h;
  for (let i = 0; i < matrix.length; i++) {
    const v = matrix[i];
    if (v <= 0) continue;
    h[Math.min(HIST_BINS - 1, Math.floor((v / maxVal) * HIST_BINS))]++;
  }
  return h;
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
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

/* ── Canvas renderer ────────────────────────────────────────────────────────── */
function renderCanvas(
  canvas: HTMLCanvasElement,
  candles: CandleDataPoint[],
  activeLevs: Lev[],
  theme: "dark" | "light",
  palette: number,
  sens: Sensitivity,
  mergeRows: number,
  showLiqMap: boolean,
  storeRef?: { current: RenderStore | null },
  months: string[] = MONTH_SHORT,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !candles.length) return;

  const W      = canvas.width - TOTAL_PAD_R;
  const H      = canvas.height - PAD_BOTTOM;
  const isDark = theme !== "light";
  const stops  = PALETTES[palette].stops;

  const built = buildMatrix(candles, activeLevs);
  const { pMin, pMax, cols } = built;
  let { matrix, maxVal } = built;
  if (mergeRows > 1) ({ matrix, maxVal } = mergeMatrixRows(matrix, cols, mergeRows));
  if (maxVal === 0) return;
  // Scale to the 99.5th percentile of non-empty cells, not the one hottest
  // cell — otherwise a single spike makes every real band look dim.
  {
    const nz: number[] = [];
    for (let i = 0; i < matrix.length; i++) if (matrix[i] > 0) nz.push(matrix[i]);
    if (nz.length > 20) {
      nz.sort((a, b) => a - b);
      maxVal = Math.max(nz[Math.floor(nz.length * 0.995)], maxVal * 0.05);
    }
  }

  let lastSum = 0;
  for (let r = 0, b = (cols - 1) * PRICE_ROWS; r < PRICE_ROWS; r++) lastSum += built.matrix[b + r];
  if (storeRef) storeRef.current = { pMin, pMax, maxVal, lastSum, matrix, visibleCandles: candles };

  // Background — dark purple matching CoinGlass
  const BG = isDark ? "#0d0221" : "#ffffff";
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  /* ── Heatmap ────────────────────────────────────────────────────────────── */
  if (showLiqMap) {
    // Empty area = the palette's base colour (e.g. viridis purple) in both
    // themes, so quiet prices read as "no liquidations" on one continuous
    // field and only real levels light up.
    const imgData = ctx.createImageData(W, H);
    const data    = imgData.data;
    const [br, bgc, bb] = stops[0][1];
    for (let i = 0; i < data.length; i += 4) {
      data[i] = br; data[i + 1] = bgc; data[i + 2] = bb; data[i + 3] = 255;
    }

    // Sensitivity: levels below `lo` stay hidden, anything at or above `hi`
    // is drawn at full brightness, and the range in between is stretched.
    const span = Math.max(0.01, sens.hi - sens.lo);

    for (let col = 0; col < cols; col++) {
      const xStart = Math.floor((col / cols) * W);
      const xEnd   = Math.floor(((col + 1) / cols) * W);
      const base   = col * PRICE_ROWS;

      for (let row = 0; row < PRICE_ROWS; row++) {
        const raw = matrix[base + row] / maxVal;
        if (raw <= 0 || raw < sens.lo) continue;

        // Gentle curve so mid levels don't wash the whole field green —
        // quiet stays purple, strong levels go yellow.
        const v         = Math.pow(Math.min(1, (raw - sens.lo) / span), 0.7);
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
    const halfW   = Math.min(3, Math.max(0.75, cw * 0.3));
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
  ctx.fillStyle = isDark ? "#0d0221" : "#fff";
  ctx.fillRect(axisX, 0, PAD_RIGHT, H + PAD_BOTTOM);
  ctx.strokeStyle = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)";
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(axisX, 0); ctx.lineTo(axisX, H); ctx.stroke();

  ctx.font      = "11px -apple-system,sans-serif";
  // Price-axis labels — brighter in dark so they read on pure black.
  ctx.fillStyle = isDark ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.62)";
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

  ctx.fillStyle = isDark ? "rgba(255,255,255,0.66)" : "rgba(0,0,0,0.58)"; // date labels, brighter for contrast
  ctx.font      = "10px -apple-system,sans-serif";
  for (const ci of pts) {
    const x = ((ci + 0.5) / cols) * W;
    const d = new Date(candles[ci].time * 1000);
    const label = showDate
      ? `${d.getDate()} ${months[d.getMonth()]}`
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
  const { t } = useTranslation();
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
  const months        = monthNames(t("heatmapPro.months"));
  const monthsRef     = useRef(months);
  monthsRef.current   = months;

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
  const [sens,       setSens]       = useState<Sensitivity>(SENS_DEFAULT);
  const [mergeRows,  setMergeRows]  = useState(1);
  const [showLiqMap, setShowLiqMap] = useState(true);
  const [hist,       setHist]       = useState<number[]>([]);
  const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
  const [phone,        setPhone]        = useState(isPhone);
  const [settingsOpen, setSettingsOpen] = useState(() => !isPhone());
  const { exceeded, used, limit, consume } = useAIQuota();
  const { user } = useAuth();
  const [oiUsd, setOiUsd] = useState(NaN);
  const [oiFailed, setOiFailed] = useState(false);
  const [oiRetry, setOiRetry] = useState(0);
  const oiRef = useRef(NaN);
  useEffect(() => { oiRef.current = oiUsd; }, [oiUsd]);
  // All open levels ≙ 2 × OI (each contract has a long and a short side).
  const usd = (share: number) => (user && isFinite(oiUsd) && share > 0 ? fmtUsd(share * 2 * oiUsd) : null);

  const range = RANGES[rangeIdx];
  const rangeName = (r: typeof RANGES[number]) => t(`heatmapPro.ranges.${r.key}`);

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
      canvas.height = Math.max(CANVAS_H, wrapRef.current.clientHeight);
    }
    // The chart + settings panel is always one dark card, in both themes.
    renderCanvas(canvas, cb.current.getVisible(), levsRef.current, "dark", palette, sens, mergeRows, showLiqMap, lastRenderRef, monthsRef.current);
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
  useEffect(() => { cb.current.redraw(); }, [palette, sens, showLiqMap]);
  // Canvas date labels follow the UI language.
  const monthsKey = months.join(",");
  useEffect(() => { cb.current.redraw(); }, [monthsKey]);
  // Histogram follows the data (range, leverage, merge, zoom) — not the
  // sensitivity handles themselves, so dragging them stays smooth.
  useEffect(() => {
    cb.current.redraw();
    const rd = lastRenderRef.current;
    setHist(rd && !loading ? intensityHistogram(rd.matrix, rd.maxVal) : []);
  }, [mergeRows, activeLevs, loading, zoomLevel]);

  // Open interest anchors the $ estimates — only needed for signed-in users.
  useEffect(() => {
    const all = candlesRef.current;
    if (!user || loading || !all.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setOiUsd(NaN); setOiFailed(false);
    // Retry a few times (rate limits / flaky networks) before giving up.
    const attempt = (n: number) => {
      coinglass.getOpenInterestUSD(coin, all[all.length - 1].close).then(v => {
        if (cancelled) return;
        if (isFinite(v)) setOiUsd(v);
        else if (n < 4) timer = setTimeout(() => attempt(n + 1), 2500 * (n + 1));
        else setOiFailed(true);
      });
    };
    attempt(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [coin, loading, user?.id, oiRetry]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); candlesRef.current = [];
    zoomRef.current = 1; panRef.current = 0; setZoomLevel(1);
    setAiResult(null); setAiError(""); setTooltip(null);

    coinglass.getHeatmapCandles(range.key, coin).then(data => {
      if (cancelled) return;
      if (!data.length) { setError(t("heatmap.noData")); setLoading(false); return; }
      candlesRef.current = data;
      setLoading(false);
    }).catch(() => { if (!cancelled) { setError(t("heatmap.loadError")); setLoading(false); } });

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
      canvas.height = Math.max(CANVAS_H, wrap.clientHeight);
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
      const heatVal = rd.maxVal > 0 ? Math.min(1, rawHeat / rd.maxVal) : 0;
      // Calibrated so all still-open levels add up to today's open interest.
      const liqUSD  = rd.lastSum > 0 ? rawHeat * (2 * oiRef.current / rd.lastSum) : NaN;

      const d       = new Date(candle.time * 1000);
      const dateStr = `${d.getDate()} ${monthsRef.current[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;

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
    else setAiError(res.error ?? t("heatmap.loadError"));
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

  // ── Page helpers ─────────────────────────────────────────────────────────
  const fmtP = (p: number) => "$" + p.toLocaleString("en-US", { maximumFractionDigits: p >= 1000 ? 0 : 4 });
  // Same number format the util's English summary uses ("$" is in the sentence).
  const fmtSummary = (p: number) => p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  // A zone whose ends round to the same price is just one price.
  const zoneText = (c: { priceLo: number; priceHi: number; priceCenter: number }) =>
    fmtP(c.priceLo) === fmtP(c.priceHi) ? fmtP(c.priceCenter) : `${fmtP(c.priceLo)} – ${fmtP(c.priceHi)}`;
  const refresh = () => {
    candlesRef.current = []; setLoading(true);
    coinglass.getHeatmapCandles(range.key, coin).then(data => {
      candlesRef.current = data; setLoading(false);
    }).catch(() => setLoading(false));
  };
  // Camera button: download the heatmap as a PNG (it used to do nothing).
  const downloadPng = () => {
    if (!user) { onOpenAuth(); return; } // download needs a free account
    const cv = canvasRef.current;
    if (!cv) return;
    try {
      const a = document.createElement("a");
      a.href = cv.toDataURL("image/png");
      a.download = `liquidation-heatmap-${coin}-${range.label}.png`;
      a.click();
    } catch { /* tainted canvas / blocked — nothing to save */ }
  };

  // Estimated $ at a zone: signed-in users see the amount, guests a sign-in lock.
  const usdTag = (share: number, plain = false) => {
    if (user && plain && isFinite(oiUsd)) return <span className="lhx-usd-plain">{usd(Math.max(share, 0)) ?? fmtUsd(0)}</span>;
    if (!user) return (
      <button type="button" className="lhx-usd lhx-usd--lock" onClick={() => onOpenAuth()} title={t("heatmapPro.usd.lockTitle")}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
        </svg>
        {t("heatmapPro.usd.est")}
      </button>
    );
    if (oiFailed) return (
      <button type="button" className="lhx-usd lhx-usd--lock" onClick={() => setOiRetry(n => n + 1)} title={t("heatmapPro.usd.retryTitle")}>
        {t("heatmapPro.usd.retry")}
      </button>
    );
    if (!isFinite(oiUsd)) return (
      <span className="lhx-usd lhx-usd--loading"><i className="lhx-usd-spin" aria-hidden="true" />{t("heatmapPro.usd.calculating")}</span>
    );
    return <span className="lhx-usd" title={t("heatmapPro.usd.estTitle")}>{t("heatmapPro.usd.approx", { usd: usd(Math.max(share, 0)) ?? fmtUsd(0) })}</span>;
  };

  // ── Key numbers (under the chart) ─────────────────────────────────────────
  // ── Ladder: shorts above (far → near), mark price, longs below (near → far)
  type Zone = NonNullable<LiqAnalysis["nearLong"]>;
  const uniqZones = (xs: (Zone | null | undefined)[]) => {
    const seen = new Set<number>();
    return xs.filter((z): z is Zone => !!z && !seen.has(z.priceCenter) && !!seen.add(z.priceCenter));
  };
  const ladder = analysis ? {
    shorts: uniqZones([...analysis.shortClusters, analysis.nearShort]).sort((a, b) => b.priceCenter - a.priceCenter),
    longs:  uniqZones([...analysis.longClusters,  analysis.nearLong]).sort((a, b) => b.priceCenter - a.priceCenter),
  } : { shorts: [], longs: [] };
  const ladderMax = Math.max(0.0001, ...[...ladder.shorts, ...ladder.longs].map(z => z.share));
  const sumShare = (xs: Zone[]) => xs.reduce((s, z) => s + z.share, 0);
  const shortSum = sumShare(ladder.shorts), longSum = sumShare(ladder.longs);
  const shortPct = shortSum + longSum > 0 ? Math.round((shortSum / (shortSum + longSum)) * 100) : 50;
  // Mirrored book: both sides nearest-to-price first; depth bars grow out
  // from the centre (shorts leftwards, longs rightwards).
  const book = {
    shorts: [...ladder.shorts].sort((a, b) => a.priceCenter - b.priceCenter),
    longs:  [...ladder.longs].sort((a, b) => b.priceCenter - a.priceCenter),
  };
  const bookCell = (c: Zone | undefined, side: "long" | "short") => (
    <div className={`lhx-book-cell lhx-book-cell--${side}`}>
      {c && <>
        <i className="lhx-book-depth" style={{ width: `${Math.max(3, Math.round((c.share / ladderMax) * 100))}%` }} />
        {/* Guests get one sign-in prompt in the header, not a lock per row. */}
        <span className="lhx-book-usd">{user ? usdTag(c.share, true) : null}</span>
        <span className="lhx-book-zone">
          {zoneText(c)}
          <em>{side === "short" ? "+" : "−"}{Math.abs(c.distancePct).toFixed(2)}%</em>
        </span>
      </>}
    </div>
  );


  // ── Heatmap settings (side panel on desktop, bottom sheet on phones) ─────
  const histMax = Math.max(1, ...hist.map(n => Math.log1p(n)));
  const activePreset = SENS_PRESETS.find(p => p.value.lo === sens.lo && p.value.hi === sens.hi)?.key;
  const setLo = (v: number) => setSens(s => ({ ...s, lo: Math.min(v, s.hi - 0.02) }));
  const setHi = (v: number) => setSens(s => ({ ...s, hi: Math.max(v, s.lo + 0.02) }));
  const stepMerge = (d: number) => setMergeRows(m => Math.max(1, Math.min(MERGE_MAX, m + d)));
  const settingsBody = (
    <div className="lhs-body">
      <section className="lhs-sec">
        <h4 className="lhs-h">{t("heatmapPro.settings.colors")}</h4>
        <div className="lhs-pal">
          {PALETTES.map((p, i) => (
            <button key={i} type="button" className={`lhs-pal-btn${palette === i ? " on" : ""}`}
              onClick={() => setPalette(i)} aria-label={t("heatmapPro.settings.palette", { n: i + 1 })} aria-pressed={palette === i}>
              <i style={{ background: p.css.replace("135deg", "90deg") }} />
            </button>
          ))}
        </div>
      </section>

      <section className="lhs-sec">
        <div className="lhs-sec-head">
          <h4 className="lhs-h">{t("heatmapPro.settings.sensitivity")}</h4>
          <button type="button" className="lhs-reset" onClick={() => setSens(SENS_DEFAULT)}
            disabled={sens.lo === SENS_DEFAULT.lo && sens.hi === SENS_DEFAULT.hi}>{t("heatmapPro.settings.reset")}</button>
        </div>
        <div className="lhs-hist">
          <div className="lhs-bars" aria-hidden="true">
            {(hist.length ? hist : new Array<number>(HIST_BINS).fill(0)).map((n, i) => {
              const pos = (i + 0.5) / HIST_BINS;
              const inside = pos >= sens.lo && pos <= sens.hi;
              const v = Math.pow(Math.min(1, Math.max(0, (pos - sens.lo) / Math.max(0.01, sens.hi - sens.lo))), 0.55);
              const [r, g, b] = heatRgb(Math.max(0.12, v), PALETTES[palette].stops);
              return (
                <i key={i} style={{
                  height: `${n ? Math.max(6, (Math.log1p(n) / histMax) * 100) : 2}%`,
                  background: inside ? `rgb(${r},${g},${b})` : undefined,
                }} />
              );
            })}
          </div>
          <div className="lhs-shade" style={{ left: 0, width: `${sens.lo * 100}%` }} />
          <div className="lhs-shade" style={{ left: `${sens.hi * 100}%`, right: 0 }} />
          <input className="lhs-range" type="range" min="0" max="1" step="0.01" value={sens.lo}
            onChange={e => setLo(+e.target.value)} aria-label={t("heatmapPro.settings.hideBelow")} />
          <input className="lhs-range" type="range" min="0" max="1" step="0.01" value={sens.hi}
            onChange={e => setHi(+e.target.value)} aria-label={t("heatmapPro.settings.fullFrom")} />
        </div>
        <div className="lhs-axis"><span>{t("heatmapPro.settings.weak")}</span><span>{Math.round(sens.lo * 100)}% – {Math.round(sens.hi * 100)}%</span><span>{t("heatmapPro.settings.strong")}</span></div>
        <div className="lhs-presets" role="group" aria-label={t("heatmapPro.settings.presetsLabel")}>
          {SENS_PRESETS.map(p => (
            <button key={p.key} type="button" className={`lhs-preset${activePreset === p.key ? " on" : ""}`}
              onClick={() => setSens(p.value)}>{t(`heatmapPro.presets.${p.key}`)}</button>
          ))}
        </div>
        <p className="lhs-note">{t("heatmapPro.settings.sensNote")}</p>
      </section>

      <section className="lhs-sec">
        <h4 className="lhs-h">{t("heatmapPro.settings.merge")}</h4>
        <div className="lhs-num">
          <button type="button" onClick={() => stepMerge(-1)} disabled={mergeRows <= 1} aria-label={t("heatmapPro.settings.fewer")}>−</button>
          <input type="number" min={1} max={MERGE_MAX} value={mergeRows} inputMode="numeric"
            onChange={e => { const n = Math.round(+e.target.value); if (n >= 1) setMergeRows(Math.min(MERGE_MAX, n)); }}
            aria-label={t("heatmapPro.settings.mergeRows")} />
          <button type="button" onClick={() => stepMerge(1)} disabled={mergeRows >= MERGE_MAX} aria-label={t("heatmapPro.settings.more")}>+</button>
        </div>
        <p className="lhs-note">{t("heatmapPro.settings.mergeNote", { n: mergeRows > 1 ? mergeRows : "N" })}</p>
      </section>

      <section className="lhs-sec">
        <h4 className="lhs-h">{t("heatmap.leverageLabel")}</h4>
        <div className="lhs-chips">
          {LEVERAGES_ALL.map(lev => (
            <button key={lev} type="button" className={`lhs-chip${activeLevs.includes(lev) ? " on" : ""}`}
              aria-pressed={activeLevs.includes(lev)} onClick={() => toggleLev(lev)}>{lev}×</button>
          ))}
        </div>
      </section>

      <section className="lhs-sec lhs-sec--row">
        <h4 className="lhs-h">{t("heatmapPro.settings.show")}</h4>
        <label className="lhx-switch">
          <input type="checkbox" checked={showLiqMap} onChange={e => setShowLiqMap(e.target.checked)} aria-label={t("heatmapPro.settings.show")} />
          <span className="lhx-switch-track" aria-hidden="true"><i /></span>
        </label>
      </section>
    </div>
  );

  return (
    <div className="lhm-card lhx">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="lhx-head lhx-bar">
        <div className="lhx-bar-id">
          <h2 className="lhx-title">{t("heatmapPro.title")}</h2>
          <span className="lhx-pair">{t("heatmapPro.pair", { coin })}</span>
        </div>

        {/* Live ticker strip — the numbers a trader checks first. */}
        <div className="lhx-ticker" aria-live="polite">
          <div className="lhx-tk">
            <span>{t("heatmapPro.ticker.mark")}</span>
            <b>{analysis && !loading ? fmtP(analysis.currentPrice) : "—"}</b>
          </div>
          <div className="lhx-tk">
            <span>{t("heatmapPro.ticker.nearestLong")}</span>
            {analysis?.nearLong && !loading
              ? <b className="lhx-tk-long">{zoneText(analysis.nearLong)} <em>−{Math.abs(analysis.nearLong.distancePct).toFixed(2)}%</em></b>
              : <b className="lhx-tk-muted">—</b>}
          </div>
          <div className="lhx-tk">
            <span>{t("heatmapPro.ticker.nearestShort")}</span>
            {analysis?.nearShort && !loading
              ? <b className="lhx-tk-short">{zoneText(analysis.nearShort)} <em>+{analysis.nearShort.distancePct.toFixed(2)}%</em></b>
              : <b className="lhx-tk-muted">—</b>}
          </div>
          <div className="lhx-tk">
            <span>{t("heatmapPro.ticker.bias")}</span>
            {analysis && !loading
              ? <b className={shortPct > 55 ? "lhx-tk-short" : shortPct < 45 ? "lhx-tk-long" : ""}>
                  {shortPct > 55 ? t("heatmapPro.ticker.biasShorts", { pct: shortPct })
                    : shortPct < 45 ? t("heatmapPro.ticker.biasLongs", { pct: 100 - shortPct })
                    : t("heatmapPro.ticker.balanced")}
                </b>
              : <b className="lhx-tk-muted">—</b>}
          </div>
        </div>

        <div className="lhx-head-actions">
          <label className="lhx-select-wrap">
            <select className="lhx-select" value={rangeIdx} onChange={e => setRangeIdx(+e.target.value)} aria-label={t("heatmapPro.timeRange")}>
              {RANGES.map((r, i) => <option key={r.key} value={i}>{rangeName(r)}</option>)}
            </select>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </label>
          <button type="button" className="lhx-icon" title={t("heatmapPro.refresh")} aria-label={t("heatmapPro.refresh")} onClick={refresh}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
            </svg>
          </button>
          <button type="button" className={`lhx-icon${user ? "" : " lhx-icon--locked"}`}
            title={user ? t("heatmapPro.downloadPng") : t("heatmapPro.signInDownloadPng")}
            aria-label={user ? t("heatmapPro.downloadPng") : t("heatmapPro.signInDownloadPng")} onClick={downloadPng}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>
            </svg>
          </button>
          <button type="button" className={`lhx-settings-btn${settingsOpen ? " on" : ""}`} aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(o => !o)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>
            </svg>
            {t("heatmapPro.settings.title")}
          </button>
        </div>
      </header>

      {/* ── Chart + settings panel ─────────────────────────────────────────── */}
      <div className={`lhx-stage${settingsOpen && !phone ? " lhx-stage--panel" : ""}`}>
      <section className="lhx-chart-card">

      <div className="lhm-chart-outer">

        {/* Left scale bar: relative intensity (the old "$xxxxM" top label
            was an internal number ×320, not real dollars). */}
        <div className="lhm-scale-bar-wrap">
          <div className="lhm-scale-max">{t("heatmap.high")}</div>
          <div className="lhm-scale-bar" style={{ background: barGradient }} />
          <div className="lhm-scale-zero">{t("heatmap.low")}</div>
        </div>

        {/* Canvas wrapper */}
        <div ref={wrapRef} className="lhm-canvas-wrap">

          {loading && <div className="lhm-overlay">{t("heatmap.loading")}</div>}
          {error   && <div className="lhm-overlay lhm-error">⚠ {error}</div>}

          <canvas
            ref={canvasRef}
            style={{ position: "absolute", inset: 0, display: "block", width: "100%", height: "100%", cursor: "grab" }}
          />

          {/* Hover tooltip */}
          {tooltip && (
            <div className="lhm-tooltip" style={tooltipStyle}>
              <div className="lhm-tooltip-date">{tooltip.dateStr}</div>
              <div className="lhm-tooltip-row">
                <span className="lhm-tooltip-circle" />
                <span className="lhm-tooltip-lbl">{t("heatmap.tooltipPrice")}</span>
                <span className="lhm-tooltip-val">
                  {tooltip.price >= 1000
                    ? tooltip.price.toLocaleString("en-US", { maximumFractionDigits: 1 })
                    : tooltip.price.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                </span>
              </div>
              <div className="lhm-tooltip-row">
                <span className="lhm-tooltip-circle" />
                <span className="lhm-tooltip-lbl">{t("heatmapPro.tooltip.intensity")}</span>
                <span className="lhm-tooltip-val">{Math.round(tooltip.heatVal * 100)}%</span>
              </div>
              <div className="lhm-tooltip-row">
                <span className="lhm-tooltip-circle" />
                <span className="lhm-tooltip-lbl">{t("heatmapPro.tooltip.estLiq")}</span>
                <span className="lhm-tooltip-val">
                  {!user ? t("heatmapPro.tooltip.signIn") : isFinite(tooltip.liqUSD) && isFinite(oiUsd) ? fmtUsd(tooltip.liqUSD) : "—"}
                </span>
              </div>
            </div>
          )}
          {tooltip && (<>
            <div className="lhx-cross lhx-cross--x" style={{ top: tooltip.y }} />
            <div className="lhx-cross lhx-cross--y" style={{ left: tooltip.x }} />
          </>)}

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
      </section>

      {settingsOpen && !phone && (
        <aside className="lhs-panel" aria-label={t("heatmapPro.settings.title")}>
          <div className="lhs-head">
            <h3>{t("heatmapPro.settings.title")}</h3>
            <button type="button" className="lhs-close" aria-label={t("heatmapPro.settings.close")} onClick={() => setSettingsOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          {settingsBody}
        </aside>
      )}
      </div>

      {phone && (
        <BottomSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title={t("heatmapPro.settings.title")}>
          {settingsBody}
        </BottomSheet>
      )}

      {/* ── Liquidation book + AI ───────────────────────────────────────────── */}
      {analysis && !loading && (<>
        <div className="lhm-bottom-row lhx-grid">
          <section className="lhx-term lhx-book" aria-label={t("heatmapPro.book.label")}>
            <div className="lhx-book-head">
              <span className="lhx-short">{t("heatmapPro.book.shorts")} <em>{t("heatmapPro.book.above")}</em></span>
              <span className="lhx-book-mark">
                <b>{fmtP(analysis.currentPrice)}</b>
                <em>{rangeName(range)}</em>
                {!user && (
                  <button type="button" className="lhx-book-unlock" onClick={() => onOpenAuth()}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                    </svg>
                    {t("heatmapPro.book.signIn")}
                  </button>
                )}
              </span>
              <span className="lhx-long"><em>{t("heatmapPro.book.below")}</em> {t("heatmapPro.book.longs")}</span>
            </div>

            <div className="lhx-book-body">
              {Array.from({ length: Math.max(book.shorts.length, book.longs.length, 1) }).map((_, i) => (
                <div key={i} className="lhx-book-row">
                  {bookCell(book.shorts[i], "short")}
                  {bookCell(book.longs[i], "long")}
                </div>
              ))}
            </div>

            <div className="lhx-book-foot">
              <span className="lhx-short">{shortPct}%</span>
              <div className="lhx-imb" role="img" aria-label={t("heatmapPro.book.imbalance", { short: shortPct, long: 100 - shortPct })}>
                <i className="lhx-imb-short" style={{ width: `${shortPct}%` }} />
                <i className="lhx-imb-long" style={{ width: `${100 - shortPct}%` }} />
              </div>
              <span className="lhx-long">{100 - shortPct}%</span>
            </div>
            {analysis.summaryKey && (
              <p className="lhx-book-note">
                {t(`heatmapPro.summary.${analysis.summaryKey}`, {
                  above: analysis.summaryAbove != null ? fmtSummary(analysis.summaryAbove) : "",
                  below: analysis.summaryBelow != null ? fmtSummary(analysis.summaryBelow) : "",
                })}
              </p>
            )}
          </section>

          {exceeded ? (
            <div className="lhm-ai-section lhm-ai-section--quota lhx-card lhx-card--ai">
              <AIQuotaWall used={used} limit={limit} onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth} />
            </div>
          ) : (
            <div className="lhm-ai-section lhx-card lhx-card--ai">
              <div className="lhm-ai-header">
                <div className="lhm-ai-title">
                  <span className="lhm-ai-star">✦</span>
                  {t("heatmap.aiAnalysis")}
                  <span className="lhm-ai-badge">{t("heatmap.aiPowered")}</span>
                </div>
                {!aiLoading && (
                  <button className="lhm-ai-refresh-btn" onClick={() => fetchAIAnalysis()} title={t("heatmapPro.regenerate")}>↺</button>
                )}
              </div>

              {aiLoading && (
                <div className="lhm-ai-loading">
                  <span className="lhm-ai-spinner" />
                  {t("heatmap.aiAnalyzing")}
                </div>
              )}
              {aiError && !aiLoading && <div className="lhm-ai-error">{aiError}</div>}
              {aiResult && !aiLoading && (
                <div className="lhm-ai-result">
                  <div className={`lhm-ai-sentiment lhm-ai-sentiment--${aiResult.sentiment ?? "neutral"}`}>
                    <span className="lhm-ai-sentiment-dot" />
                    {aiResult.sentiment && t(`heatmapPro.sentiment.${aiResult.sentiment}`, {
                      defaultValue: aiResult.sentiment.charAt(0).toUpperCase() + aiResult.sentiment.slice(1),
                    })}
                  </div>
                  {aiResult.analysis && <p className="lhm-ai-analysis">{aiResult.analysis}</p>}
                  {aiResult.ourTake && (
                    <div className={`lhm-ai-our-take lhm-ai-our-take--${aiResult.ourTakeAction ?? "watch"}`}>
                      <div className="lhm-ai-our-take-label">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                          <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z"/>
                        </svg>
                        {t("heatmap.aiOurTake")}
                        {aiResult.ourTakeAction && (
                          <span className={`lhm-ai-action-badge lhm-ai-action-badge--${aiResult.ourTakeAction}`}>
                            {t(`heatmapPro.action.${aiResult.ourTakeAction}`, { defaultValue: aiResult.ourTakeAction.toUpperCase() })}
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

      <p className="lhx-foot">{t("heatmap.disclaimer")}</p>
    </div>
  );
};
