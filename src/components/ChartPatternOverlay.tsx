import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import type { ChartPattern } from "../utils/chartPatterns";
import "../styles/ChartPatternOverlay.css";

interface Props {
  chartRef: React.MutableRefObject<IChartApi | null>;
  seriesRef: React.MutableRefObject<ISeriesApi<"Candlestick", any> | null>;
  pattern: ChartPattern | null;
  onClose: () => void;
}

type XY = { x: number; y: number };
interface Frame {
  lines: Array<{ role: string; pts: XY[] }>;
  labels: Array<XY & { text: string; above: boolean }>;
  endX: number;
  paneW: number;
  levels: Array<{ y: number; text: string; kind: "target" | "cancel" | "trigger" }>;
}

const fmt = (p: number) => "$" + p.toLocaleString("en-US", { maximumFractionDigits: Math.abs(p) < 10 ? 4 : Math.abs(p) < 1000 ? 2 : 0 });

/**
 * Candle Insights: draws a classic chart pattern (lines, swing labels,
 * trigger / target / cancel levels) over the chart. Re-measured every frame
 * while shown so it follows panning and zooming.
 */
export function ChartPatternOverlay({ chartRef, seriesRef, pattern, onClose }: Props) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const lastKey = useRef("");

  useEffect(() => {
    if (!pattern) { setFrame(null); lastKey.current = ""; return; }
    let raf = 0;
    const measure = () => {
      const chart = chartRef.current, series = seriesRef.current;
      let next: Frame | null = null;
      if (chart && series) {
        const ts = chart.timeScale();
        const X = (t: number) => ts.timeToCoordinate(t as Time);
        const Y = (p: number) => series.priceToCoordinate(p);
        const toXY = (t: number, p: number): XY | null => {
          const x = X(t), y = Y(p);
          return x === null || y === null ? null : { x, y };
        };
        const lines = pattern.lines.map(l => ({ role: l.role, pts: l.points.map(p => toXY(p.time, p.price)).filter((v): v is XY => !!v) }));
        const labels = pattern.labels.map(l => { const v = toXY(l.time, l.price); return v ? { ...v, text: l.text, above: l.above } : null; })
          .filter((v): v is XY & { text: string; above: boolean } => !!v);
        const ends = lines.flatMap(l => l.pts.map(p => p.x));
        const lv = (price: number, text: string, kind: "target" | "cancel" | "trigger") => {
          const y = Y(price);
          return y === null ? null : { y, text: `${text} ${fmt(price)}`, kind };
        };
        next = {
          lines, labels,
          endX: ends.length ? Math.max(...ends) : 0,
          paneW: ts.width(),
          levels: [
            lv(pattern.trigger, pattern.status === "breakout" ? "Broke" : "Signal", "trigger"),
            lv(pattern.target, "Target", "target"),
            lv(pattern.invalidation, "Cancel", "cancel"),
          ].filter((v): v is NonNullable<typeof v> => !!v),
        };
      }
      const key = next ? JSON.stringify([next.lines, next.labels.map(l => [l.x, l.y]), next.levels.map(l => l.y), next.paneW]) : "";
      if (key !== lastKey.current) { lastKey.current = key; setFrame(next); }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [pattern, chartRef, seriesRef]);

  if (!pattern || !frame) return null;
  const dir = pattern.bias === "bullish" ? "up" : "down";
  const path = (pts: XY[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const levelX = Math.min(frame.endX, frame.paneW - 40);

  return (
    <div className={`cpo cpo--${dir}`}>
      <svg className="cpo-svg" width="100%" height="100%">
        {/* Shaded area between the two boundary lines (triangles, wedges, flags). */}
        {(() => {
          const edges = frame.lines.filter(l => (l.role === "trigger" || l.role === "boundary") && l.pts.length === 2);
          if (edges.length !== 2) return null;
          const [a, b] = edges;
          return <path className="cpo-fill" d={`${path(a.pts)} L${b.pts[1].x},${b.pts[1].y} L${b.pts[0].x},${b.pts[0].y} Z`} />;
        })()}
        {frame.lines.map((l, i) => l.pts.length >= 2 && (
          <path key={i} className={`cpo-line cpo-line--${l.role}`} d={path(l.pts)} />
        ))}
        {frame.levels.map((l, i) => (
          <line key={i} className={`cpo-level cpo-level--${l.kind}`} x1={levelX} x2={frame.paneW} y1={l.y} y2={l.y} />
        ))}
      </svg>
      {frame.labels.map((l, i) => (
        <span key={i} className={`cpo-tag${l.above ? "" : " cpo-tag--below"}`} style={{ left: l.x, top: l.y }}>{l.text}</span>
      ))}
      {frame.levels.map((l, i) => (
        <span key={i} className={`cpo-lvl cpo-lvl--${l.kind}`} style={{ left: levelX + 4, top: l.y }}>{l.text}</span>
      ))}
      <div className="cpo-head">
        <span className="cpo-head-name">{pattern.name}</span>
        <span className="cpo-head-tag">{pattern.bias === "bullish" ? "Bullish" : "Bearish"} · {pattern.status === "breakout" ? "confirmed" : "forming"}</span>
        <button type="button" className="cpo-head-x" aria-label="Hide pattern" onClick={onClose}>✕</button>
      </div>
    </div>
  );
}
