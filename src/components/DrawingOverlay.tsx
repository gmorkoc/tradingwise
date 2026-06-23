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
