import { useEffect, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";
import "../styles/PatternHighlight.css";

interface Candle { time: number; open: number; high: number; low: number; close: number }

interface Props {
  chartRef: React.MutableRefObject<IChartApi | null>;
  seriesRef: React.MutableRefObject<ISeriesApi<"Candlestick", any> | null>;
  candlesRef: React.MutableRefObject<Candle[]>;
  /** Times of the pattern's candles (1–3), oldest first. null = hidden. */
  times: number[] | null;
  name: string;
  type: "bullish" | "bearish" | "neutral";
  desc: string;
  onClose: () => void;
}

interface Box { x: number; y: number; w: number; h: number; labelBelow: boolean }

/**
 * Candle Insights: draws a glowing box around the candles that formed the
 * detected pattern, with a label explaining it. Follows the chart while it
 * pans/zooms (re-measured every frame while shown).
 */
export function PatternHighlight({ chartRef, seriesRef, candlesRef, times, name, type, desc, onClose }: Props) {
  const [box, setBox] = useState<Box | null>(null);
  const lastRef = useRef("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!times || !times.length) { setBox(null); lastRef.current = ""; return; }
    let raf = 0;
    const measure = () => {
      const chart = chartRef.current, series = seriesRef.current;
      const set = new Set(times);
      const cs = candlesRef.current.filter(c => set.has(c.time));
      let next: Box | null = null;
      if (chart && series && cs.length) {
        const ts = chart.timeScale();
        const x1 = ts.timeToCoordinate(times[0] as Time);
        const x2 = ts.timeToCoordinate(times[times.length - 1] as Time);
        const hi = series.priceToCoordinate(Math.max(...cs.map(c => c.high)));
        const lo = series.priceToCoordinate(Math.min(...cs.map(c => c.low)));
        if (x1 !== null && x2 !== null && hi !== null && lo !== null) {
          const pad = Math.max(5, ts.options().barSpacing * 0.6);
          const y = Math.min(hi, lo) - 8;
          next = { x: x1 - pad, y, w: x2 - x1 + pad * 2, h: Math.abs(lo - hi) + 16, labelBelow: y < 70 };
        }
      }
      const key = next ? `${Math.round(next.x)},${Math.round(next.y)},${Math.round(next.w)},${Math.round(next.h)}` : "";
      if (key !== lastRef.current) { lastRef.current = key; setBox(next); }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [times, chartRef, seriesRef, candlesRef]);

  if (!times || !box) return null;
  // Keep the label inside the chart (patterns usually sit at the right edge).
  const wrapW = rootRef.current?.offsetWidth ?? 0;
  const half = Math.min(130, wrapW * 0.4);
  const cx = box.x + box.w / 2;
  const labelX = wrapW ? Math.min(Math.max(cx, half + 8), wrapW - half - 8) : cx;
  const dir = type === "bullish" ? "up" : type === "bearish" ? "down" : "flat";
  const tag = type === "bullish" ? "Bullish" : type === "bearish" ? "Bearish" : "Neutral";

  return (
    <div ref={rootRef} className={`ph ph--${dir}`} aria-live="polite">
      {/* key restarts the draw-in animation when a new pattern is shown */}
      <div key={times.join(",")} className="ph-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
      <div
        className={`ph-label${box.labelBelow ? " ph-label--below" : ""}`}
        style={{ left: labelX, top: box.labelBelow ? box.y + box.h + 8 : box.y - 8 }}
      >
        <div className="ph-label-head">
          <span className="ph-label-name">{name}</span>
          <span className="ph-label-tag">{tag}</span>
          <button type="button" className="ph-label-x" aria-label="Hide pattern" onClick={onClose}>✕</button>
        </div>
        <p className="ph-label-desc">{desc}</p>
      </div>
    </div>
  );
}
