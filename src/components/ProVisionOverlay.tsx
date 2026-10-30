import { useCallback, useEffect, useRef } from "react";
import type { IChartApi, Time } from "lightweight-charts";
import type { PvResult } from "../services/proVision";

// Pro Vision's on-chart layer: the live invalidation zone (soft glow band +
// dashed line + "Δ Volume" tag), SELL/BUY labels on recent signals, and a
// ✓ over each past signal that worked. Canvas, redrawn on scroll/zoom.

const RED = "251, 113, 133";
const GREEN = "74, 222, 128";

interface Props {
  chartRef: React.RefObject<IChartApi | null>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seriesRef: React.RefObject<any>;
  candlesRef: React.RefObject<{ time: number; high: number; low: number }[]>;
  result: PvResult | null;
  visible: boolean;
  generation: number;
  /** "under" = the painted ribbon (drawn below the candles); "over" = labels, zones, markers. */
  layer?: "under" | "over";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export function ProVisionOverlay({ chartRef, seriesRef, candlesRef, result, visible, generation, layer = "over" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resultRef = useRef(result);
  const renderRef = useRef<(() => void) | null>(null);
  const subRef = useRef<{ chart: IChartApi; off: () => void } | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!canvas || !chart || !series) return;

    if (subRef.current?.chart !== chart) {
      subRef.current?.off();
      const cb = () => renderRef.current?.();
      chart.timeScale().subscribeVisibleLogicalRangeChange(cb);
      subRef.current = { chart, off: () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(cb) };
    }

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (!W || !H || W > 8192 || H > 8192) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const res = resultRef.current;
    if (!res) return;
    const ts = chart.timeScale();
    const xOf = (t: number) => ts.timeToCoordinate(t as Time);
    // Non-finite = no value for that candle (older bars outside the slice the
    // server computed) — skip instead of drawing to NaN.
    const yOf = (p: number) => (Number.isFinite(p) ? (series.priceToCoordinate(p) as number | null) : null);
    // Right edge of the plotting area (left of the price axis).
    const plotRight = ts.width();
    const candles = candlesRef.current ?? [];
    const byTime = new Map(candles.map((c) => [c.time, c]));

    // ══ UNDER layer: the painted trend ribbon (below the candles) ══
    // A fan of EMAs; the whole band between the fastest and slowest is
    // filled green while the fast EMA is above the slow one, red below —
    // so the chart reads as painted buy / sell zones, with the individual
    // lines drawn on top.
    if (layer === "under") {
      const lines = res.ribbon.lines;
      const bullArr = res.ribbon.bull;
      if (!lines.length || !candles.length) return;
      const lr = ts.getVisibleLogicalRange();
      if (!lr) return;
      const from = Math.max(1, Math.floor(lr.from) - 1);
      const to = Math.min(candles.length - 1, Math.ceil(lr.to) + 1);
      const X: (number | null)[] = [];
      for (let i = from; i <= to; i++) X[i] = xOf(candles[i].time);
      const envTop = (i: number) => { let m = Infinity; for (const L of lines) { const y = yOf(L[i]); if (y !== null && y < m) m = y; } return m; };
      const envBot = (i: number) => { let m = -Infinity; for (const L of lines) { const y = yOf(L[i]); if (y !== null && y > m) m = y; } return m; };
      // Fill: one quad per candle step, colored by that step's trend.
      for (let i = from; i <= to; i++) {
        const x0 = X[i - 1] ?? xOf(candles[i - 1].time), x1 = X[i];
        if (x0 === null || x1 === null) continue;
        const t0 = envTop(i - 1), b0 = envBot(i - 1), t1 = envTop(i), b1 = envBot(i);
        if (![t0, b0, t1, b1].every(Number.isFinite)) continue;
        const rgb = bullArr[i] ? GREEN : RED;
        ctx.fillStyle = `rgba(${rgb}, 0.26)`;
        ctx.beginPath();
        ctx.moveTo(x0, t0); ctx.lineTo(x1, t1); ctx.lineTo(x1, b1); ctx.lineTo(x0, b0);
        ctx.closePath();
        ctx.fill();
      }
      // Lines: each EMA, segment by segment in its candle's color.
      ctx.lineWidth = 1;
      lines.forEach((L, li) => {
        const alpha = 0.75 - (li / lines.length) * 0.35;
        for (let i = from; i <= to; i++) {
          const x0 = X[i - 1] ?? xOf(candles[i - 1].time), x1 = X[i];
          const y0 = yOf(L[i - 1]), y1 = yOf(L[i]);
          if (x0 === null || x1 === null || y0 === null || y1 === null) continue;
          ctx.strokeStyle = `rgba(${bullArr[i] ? GREEN : RED}, ${alpha})`;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      });
      return;
    }

    // ── Live invalidation zone: band to the right edge + line + tag ──
    const z = res.zone;
    if (z) {
      const x0 = xOf(z.from);
      const yInv = yOf(z.invalidation), yEnt = yOf(z.entry);
      if (x0 !== null && yInv !== null && yEnt !== null) {
        const rgb = z.side === "sell" ? RED : GREEN;
        const top = Math.min(yInv, yEnt), bot = Math.max(yInv, yEnt);
        const h = Math.max(bot - top, 10);
        const x = Math.max(0, x0);
        const w = Math.max(0, plotRight - x);
        // Soft band, strongest at the invalidation edge.
        const grad = ctx.createLinearGradient(0, yInv, 0, yInv === top ? top + h : top);
        grad.addColorStop(0, `rgba(${rgb}, 0.22)`);
        grad.addColorStop(1, `rgba(${rgb}, 0.02)`);
        ctx.save();
        ctx.fillStyle = grad;
        ctx.fillRect(x, top, w, h);
        ctx.restore();
        // Dashed invalidation line.
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = `rgba(${rgb}, 0.8)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, Math.round(yInv) + 0.5);
        ctx.lineTo(plotRight, Math.round(yInv) + 0.5);
        ctx.stroke();
        ctx.restore();
        // Tag at the right end.
        const label = "INVALIDATION";
        const sub = `Δ Volume ${z.deltaVolPct >= 0 ? "+" : "−"}${Math.abs(z.deltaVolPct).toFixed(1)}%${z.real ? "" : " (est.)"}`;
        ctx.font = "700 9px Inter, system-ui, sans-serif";
        const lw = ctx.measureText(label).width;
        ctx.font = "600 11px Inter, system-ui, sans-serif";
        const sw = ctx.measureText(sub).width;
        const tw = Math.max(lw, sw) + 16, th = 34;
        const tx = Math.max(x + 4, plotRight - tw - 10);
        const ty = z.side === "sell" ? yInv - th - 6 : yInv + 6;
        ctx.fillStyle = "rgba(10, 10, 11, 0.92)";
        roundRect(ctx, tx, ty, tw, th, 8);
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb}, 0.5)`;
        ctx.lineWidth = 1;
        roundRect(ctx, tx + 0.5, ty + 0.5, tw - 1, th - 1, 8);
        ctx.stroke();
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.font = "700 9px Inter, system-ui, sans-serif";
        ctx.fillText(label, tx + 8, ty + 13);
        ctx.fillStyle = "#f5f5f7";
        ctx.font = "600 11px Inter, system-ui, sans-serif";
        ctx.fillText(sub, tx + 8, ty + 27);
      }
    }

    // ── Range box: while sideways, the ceiling/floor price is bouncing between ──
    const rb = res.rangeBox;
    if (rb) {
      const xb = xOf(rb.from);
      const yT = yOf(rb.top), yB = yOf(rb.bottom);
      if (yT !== null && yB !== null) {
        const x = Math.max(0, xb ?? 0);
        const w = Math.max(0, plotRight - x);
        ctx.fillStyle = "rgba(142, 142, 147, 0.08)";
        ctx.fillRect(x, yT, w, yB - yT);
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = "rgba(174, 174, 178, 0.7)";
        ctx.lineWidth = 1;
        for (const yy of [yT, yB]) {
          ctx.beginPath();
          ctx.moveTo(x, Math.round(yy) + 0.5);
          ctx.lineTo(plotRight, Math.round(yy) + 0.5);
          ctx.stroke();
        }
        ctx.restore();
        ctx.font = "700 9px Inter, system-ui, sans-serif";
        ctx.fillStyle = "rgba(174, 174, 178, 0.95)";
        ctx.fillText("RANGE CEILING", x + 6, yT - 5);
        ctx.fillText("RANGE FLOOR", x + 6, yB + 12);
      }
    }

    // ── Range signals: outlined BUY/SELL pills (fade the box edges) ──
    for (const s of res.rangeSignals) {
      const x = xOf(s.time);
      const cdl = byTime.get(s.time);
      if (x === null || !cdl || x < -20 || x > plotRight + 20) continue;
      const isSell = s.side === "sell";
      const anchor = yOf(isSell ? cdl.high : cdl.low);
      if (anchor === null) continue;
      const rgb = isSell ? RED : GREEN;
      const text = isSell ? "R·SELL" : "R·BUY";
      ctx.font = "800 9px Inter, system-ui, sans-serif";
      const pw = ctx.measureText(text).width + 12, ph = 16;
      const py = isSell ? anchor - ph - 9 : anchor + 9;
      ctx.fillStyle = "rgba(10, 10, 11, 0.85)";
      roundRect(ctx, x - pw / 2, py, pw, ph, 6);
      ctx.fill();
      ctx.strokeStyle = `rgb(${rgb})`;
      ctx.lineWidth = 1.2;
      roundRect(ctx, x - pw / 2 + 0.5, py + 0.5, pw - 1, ph - 1, 6);
      ctx.stroke();
      ctx.fillStyle = `rgb(${rgb})`;
      ctx.fillText(text, x - pw / 2 + 6, py + 11.5);
    }

    // ── Spike markers: an amber lightning bolt over/under each shock candle ──
    for (const s of res.spikes) {
      const x = xOf(s.time);
      const c = byTime.get(s.time);
      if (x === null || !c || x < -10 || x > plotRight + 10) continue;
      const a = yOf(s.up ? c.high : c.low);
      if (a === null) continue;
      const cy = s.up ? a - 14 : a + 14;
      ctx.save();
      ctx.fillStyle = "#ffd60a";
      ctx.shadowColor = "rgba(255, 214, 10, 0.6)";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(x + 1.5, cy - 7);
      ctx.lineTo(x - 3.5, cy + 1);
      ctx.lineTo(x - 0.2, cy + 1);
      ctx.lineTo(x - 1.5, cy + 7);
      ctx.lineTo(x + 3.5, cy - 1);
      ctx.lineTo(x + 0.2, cy - 1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // ── Labels: Buy / Sell at each signal, TP where a trade closed in profit ──
    // Pill with a pointer toward the candle (Buy below the low, Sell above
    // the high; TP above a long's exit high / below a short's exit low).
    // Large, bold labels (Buy / Sell bigger than TP) with a soft glow.
    const pill = (x: number, anchor: number, below: boolean, text: string, bg: string, fg: string, big: boolean) => {
      const fs = big ? 16 : 13;
      ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
      const padX = big ? 14 : 10;
      const pw = ctx.measureText(text).width + padX * 2, ph = big ? 32 : 26, gap = big ? 14 : 12, tip = big ? 8 : 6;
      const py = below ? anchor + gap : anchor - gap - ph;
      ctx.save();
      ctx.shadowColor = bg;
      ctx.shadowBlur = big ? 16 : 8;
      ctx.fillStyle = bg;
      roundRect(ctx, x - pw / 2, py, pw, ph, 8);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = bg;
      ctx.beginPath();
      if (below) { ctx.moveTo(x - tip, py + 1); ctx.lineTo(x + tip, py + 1); ctx.lineTo(x, py - tip); }
      else { ctx.moveTo(x - tip, py + ph - 1); ctx.lineTo(x + tip, py + ph - 1); ctx.lineTo(x, py + ph + tip); }
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.textBaseline = "middle";
      ctx.fillText(text, x - pw / 2 + padX, py + ph / 2 + 1);
      ctx.textBaseline = "alphabetic";
    };
    // Buy / Sell at every ribbon flip — skipped when a STRONG signal sits
    // within 3 candles (that one gets the label instead).
    const strongIdx = new Set<number>();
    const idxOf = new Map(candles.map((cd, i) => [cd.time, i]));
    for (const s of res.signals) { const k = idxOf.get(s.time); if (k !== undefined) strongIdx.add(k); }
    const nearStrong = (k: number) => [...strongIdx].some((j) => Math.abs(j - k) <= 3);
    for (const f of res.flips) {
      const k = idxOf.get(f.time);
      const x = xOf(f.time);
      const c = byTime.get(f.time);
      if (k === undefined || x === null || !c || x < -30 || x > plotRight + 30 || nearStrong(k)) continue;
      const isSell = f.side === "sell";
      const anchor = yOf(isSell ? c.high : c.low);
      if (anchor !== null) pill(x, anchor, !isSell, isSell ? "Sell" : "Buy", isSell ? "#e5484d" : "#30a46c", "#ffffff", true);
    }
    for (const s of res.signals) {
      const x = xOf(s.time);
      const c = byTime.get(s.time);
      if (x !== null && c && x > -30 && x < plotRight + 30) {
        const isSell = s.side === "sell";
        const anchor = yOf(isSell ? c.high : c.low);
        if (anchor !== null) {
          pill(x, anchor, !isSell, isSell ? "STRONG SELL" : "STRONG BUY", isSell ? "#e5484d" : "#30a46c", "#ffffff", true);
        }
      }
      // TP marker where the trade closed in profit.
      if (s.worked && s.exitTime !== undefined) {
        const xe = xOf(s.exitTime);
        const ce = byTime.get(s.exitTime);
        if (xe !== null && ce && xe > -30 && xe < plotRight + 30) {
          const isSell = s.side === "sell";
          const anchor = yOf(isSell ? ce.low : ce.high);
          if (anchor !== null) pill(xe, anchor, isSell, "TP", "#facc15", "#1a1400", false);
        }
      }
    }
  }, [chartRef, seriesRef, candlesRef]);

  renderRef.current = render;

  useEffect(() => {
    resultRef.current = result;
    if (visible) render();
  }, [result, visible, generation, render]);

  useEffect(() => () => { subRef.current?.off(); }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => { if (visible) render(); });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [render, visible]);

  if (!visible) return null;
  return <canvas ref={canvasRef} className={`drawing-overlay ${layer === "under" ? "pv-overlay-under" : "pv-overlay"}`} />;
}
