import { useRef, useEffect, useCallback } from "react";
import { IChartApi, Time } from "lightweight-charts";
import "../styles/DrawingOverlay.css";

export interface PredictionPath {
  waypoints: Array<{ time: number; price: number }>;
  direction: "bullish" | "bearish" | "neutral";
  targetPrice: number;
  stopLoss: number;
  scenario: string;
}

// ── Canvas paint ──────────────────────────────────────────────────────────────

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  size: number,
) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function paintCanvas(
  ctx: CanvasRenderingContext2D,
  logW: number, logH: number,
  prediction: PredictionPath | null,
  timeToX: (t: number) => number,
  priceToY: (p: number) => number,
) {
  ctx.clearRect(0, 0, logW, logH);

  if (!prediction || prediction.waypoints.length < 2) return;

  const color =
    prediction.direction === "bullish" ? "#22c55e" :
    prediction.direction === "bearish" ? "#ef4444" : "#94a3b8";

  const pts = prediction.waypoints.map(wp => ({
    x: timeToX(wp.time),
    y: priceToY(wp.price),
    price: wp.price,
  })).filter(pt => pt.x > -999 && pt.y > -999);

  if (pts.length < 2) return;

  ctx.save();
  ctx.globalAlpha = 0.92;

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);
  ctx.lineJoin = "round";
  ctx.beginPath();
  pts.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.fillStyle = color;
  for (const pt of pts) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  ctx.fillStyle = color;
  drawArrowhead(ctx, prev.x, prev.y, last.x, last.y, 11);

  ctx.font = "bold 11px Inter, sans-serif";
  ctx.fillStyle = color;
  const tLabel = last.price >= 1000
    ? `$${last.price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${last.price.toFixed(2)}`;
  ctx.fillText(`⊕ ${tLabel}`, last.x + 10, last.y + 4);

  const slY = priceToY(prediction.stopLoss);
  if (slY > -999 && slY < logH) {
    const startX = pts[0].x;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(startX, slY);
    ctx.lineTo(last.x, slY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ef4444";
    ctx.font = "10px Inter, sans-serif";
    const slLabel = prediction.stopLoss >= 1000
      ? prediction.stopLoss.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : prediction.stopLoss.toFixed(2);
    ctx.fillText(`SL $${slLabel}`, startX + 4, slY - 3);
  }

  ctx.restore();
}

// ── Overlay component ─────────────────────────────────────────────────────────

interface OverlayProps {
  chartRef:   React.RefObject<IChartApi | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seriesRef:  React.RefObject<any>;
  prediction: PredictionPath | null;
}

export function PredictionOverlay({ chartRef, seriesRef, prediction }: OverlayProps) {
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const predictionRef   = useRef(prediction);
  const renderRef       = useRef<(() => void) | null>(null);
  const subCleanupRef   = useRef<(() => void) | null>(null);

  useEffect(() => { predictionRef.current = prediction; }, [prediction]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const chart  = chartRef.current;
    const series = seriesRef.current;
    if (!canvas || !chart || !series) return;

    if (!subCleanupRef.current) {
      const cb = () => renderRef.current?.();
      chart.timeScale().subscribeVisibleTimeRangeChange(cb);
      subCleanupRef.current = () => chart.timeScale().unsubscribeVisibleTimeRangeChange(cb);
    }

    const dpr  = window.devicePixelRatio || 1;
    const logW = canvas.offsetWidth;
    const logH = canvas.offsetHeight;
    if (!logW || !logH || logW > 8192 || logH > 8192) return;

    if (canvas.width !== logW * dpr || canvas.height !== logH * dpr) {
      canvas.width  = logW * dpr;
      canvas.height = logH * dpr;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const timeToX  = (t: number) => (chart.timeScale().timeToCoordinate(t as Time) ?? -9999) as number;
    const priceToY = (p: number) => (series.priceToCoordinate(p) ?? -9999) as number;

    paintCanvas(ctx, logW, logH, predictionRef.current, timeToX, priceToY);
  }, [chartRef, seriesRef]);

  renderRef.current = render;

  useEffect(() => () => { subCleanupRef.current?.(); }, []);
  useEffect(() => { render(); }, [prediction, render]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      className="drawing-overlay"
    />
  );
}

// ── Line-style dot fill (compact view only) ───────────────────────────────────
// Halftone dot pattern under the close-price line, like a stock app's
// sparkline — only ever mounted for the non-interactive compact card (see
// PriceChart's `visible` prop here), never the pannable/zoomable fullscreen
// view. Deliberately NOT calling timeToCoordinate/priceToCoordinate per
// candle — tried that first, and for a large dataset (e.g. "all" history)
// lightweight-charts only resolves a real coordinate for a subset of
// points, silently returning null for the rest, which left only a small
// cluster of points surviving and the dot fill covering just that patch
// instead of the whole line. Four anchor conversions (first/last time,
// min/max close) plus plain linear interpolation for every other point is
// both more reliable and far cheaper — correct as long as both scales are
// linear, which is this chart's default (no log price scale is enabled
// anywhere in this file).
function paintDotFill(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  allCloses: Array<{ time: number; value: number }>,
  visibleFrom: number,
  visibleTo: number,
  timeToX: (t: number) => number,
  priceToY: (p: number) => number,
  color: string,
) {
  ctx.clearRect(0, 0, width, height);
  // Only the candles actually on screen — both for the time-axis anchors
  // below and for the min/max used to scale the price axis, so a long
  // fetched history outside the visible window never skews either.
  const closes = allCloses.filter((c) => c.time >= visibleFrom && c.time <= visibleTo);
  if (closes.length < 2) return;

  const values = closes.map((c) => c.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);

  const x0 = timeToX(visibleFrom);
  const x1 = timeToX(visibleTo);
  const yAtMin = priceToY(minValue);
  const yAtMax = priceToY(maxValue);
  if (x0 <= -9000 || x1 <= -9000 || yAtMin <= -9000 || yAtMax <= -9000 || x1 === x0) return;

  const timeSpan = visibleTo - visibleFrom || 1;
  const valueSpan = maxValue - minValue || 1;
  const xAt = (t: number) => x0 + ((t - visibleFrom) / timeSpan) * (x1 - x0);
  const yAt = (v: number) => yAtMin + ((v - minValue) / valueSpan) * (yAtMax - yAtMin);

  const pts = closes.map((c) => ({ x: xAt(c.time), y: yAt(c.value) }));
  if (pts.length < 2) return;

  const lineYAt = (x: number) => {
    if (x <= pts[0].x) return pts[0].y;
    if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i].x) {
        const a = pts[i - 1];
        const b = pts[i];
        const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
        return a.y + (b.y - a.y) * t;
      }
    }
    return pts[pts.length - 1].y;
  };

  const SPACING = 5;
  ctx.fillStyle = color;
  const minX = Math.max(0, pts[0].x);
  const maxX = Math.min(width, pts[pts.length - 1].x);
  for (let x = minX; x <= maxX; x += SPACING) {
    const lineY = lineYAt(x);
    const firstRow = Math.ceil(lineY / SPACING) * SPACING;
    for (let y = firstRow; y <= height; y += SPACING) {
      const depth = (y - lineY) / (height - lineY || 1);
      const opacity = Math.max(0, 1 - depth) * 0.5;
      if (opacity <= 0.01) continue;
      ctx.globalAlpha = opacity;
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

interface DotFillOverlayProps {
  chartRef: React.RefObject<IChartApi | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seriesRef: React.RefObject<any>;
  // A ref, not reactive state/props — read fresh on each repaint the same
  // way ChartDrawingTools' own candlesRef prop already does elsewhere in
  // this file, so a data reload needs no extra reactive plumbing here.
  candlesRef: React.RefObject<Array<{ time: number; close: number }>>;
  color: string;
  // Bumped by PriceChart every time the chart instance is recreated — see
  // the note on subscribedChartRef below for why color/visible alone
  // can't be trusted to always signal that.
  generation: number;
  visible: boolean;
}

export function LineDotFillOverlay({ chartRef, seriesRef, candlesRef, color, generation, visible }: DotFillOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorRef = useRef(color);
  const renderRef = useRef<(() => void) | null>(null);
  const subCleanupRef = useRef<(() => void) | null>(null);
  // Which chart instance subCleanupRef's subscription actually belongs to —
  // a theme/grid/fullscreen change recreates the whole chart (new
  // createChart() call), so chartRef.current silently becomes a different
  // object while the ref itself never changes identity. Without tracking
  // this, the "already subscribed" guard below stayed true forever,
  // leaving the subscription pointed at a destroyed chart and this overlay
  // deaf to anything happening on the real one.
  const subscribedChartRef = useRef<IChartApi | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!canvas || !chart || !series) return;

    if (subscribedChartRef.current !== chart) {
      subCleanupRef.current?.();
      const cb = () => renderRef.current?.();
      chart.timeScale().subscribeVisibleTimeRangeChange(cb);
      subCleanupRef.current = () => chart.timeScale().unsubscribeVisibleTimeRangeChange(cb);
      subscribedChartRef.current = chart;
    }

    const dpr = window.devicePixelRatio || 1;
    const logW = canvas.offsetWidth;
    const logH = canvas.offsetHeight;
    if (!logW || !logH || logW > 8192 || logH > 8192) return;

    if (canvas.width !== logW * dpr || canvas.height !== logH * dpr) {
      canvas.width = logW * dpr;
      canvas.height = logH * dpr;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const closes = (candlesRef.current ?? []).map((c) => ({ time: c.time, value: c.close }));
    if (!closes.length) { ctx.clearRect(0, 0, logW, logH); return; }

    // The fetched array can hold far more history than is actually on
    // screen (e.g. the "1h" interval loads weeks of candles but only pans
    // to the most recent 14 days via setVisibleRange) — anchoring off the
    // full array's first/last candle, instead of the chart's own visible
    // range, squeezed the real on-screen window into a small fraction of
    // the mapped x-axis, which is exactly the "only a small patch" bug.
    const visibleRange = chart.timeScale().getVisibleRange();
    if (!visibleRange) { ctx.clearRect(0, 0, logW, logH); return; }

    const timeToX = (t: number) => (chart.timeScale().timeToCoordinate(t as Time) ?? -9999) as number;
    const priceToY = (p: number) => (series.priceToCoordinate(p) ?? -9999) as number;

    paintDotFill(ctx, logW, logH, closes, visibleRange.from as number, visibleRange.to as number, timeToX, priceToY, colorRef.current);
  }, [chartRef, seriesRef, candlesRef]);

  renderRef.current = render;

  useEffect(() => {
    colorRef.current = color;
    if (visible) render();
  }, [color, generation, visible, render]);

  useEffect(() => () => { subCleanupRef.current?.(); }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => { if (visible) render(); });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [render, visible]);

  if (!visible) return null;
  return <canvas ref={canvasRef} className="drawing-overlay" />;
}
