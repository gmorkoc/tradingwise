import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi, ISeriesApi, ColorType, CandlestickSeries, HistogramSeries } from "lightweight-charts";
import { coinglass } from "../services/coinglass";
import "../styles/AgentChartModal.css";

// Full interval set, matching PriceChart.tsx's own INTERVALS exactly (not
// exported there, so duplicated locally rather than risking a change to
// that file — see this session's notes on how fragile it's been).
type ChartInterval = "1sec" | "1min" | "5min" | "15min" | "1h" | "4h" | "6h" | "1day" | "1week" | "1month" | "all";
const INTERVALS: ChartInterval[] = ["1min", "5min", "15min", "1h", "4h", "6h", "1day", "1week", "1month"];
const INTERVAL_LABELS: Record<ChartInterval, string> = {
  "1sec": "1s", "1min": "1m", "5min": "5m", "15min": "15m", "1h": "1H",
  "4h": "4H", "6h": "6H", "1day": "1D", "1week": "1W", "1month": "1M", "all": "All",
};

interface Props {
  coin: string;
  // Set when the agent itself requested a specific interval ("show me the
  // 4h chart") — falls back to the plain "1h" default when absent (e.g.
  // the manual Chart button on a snapshot card, which has no interval
  // context to pass).
  initialInterval?: ChartInterval;
  onClose: () => void;
}

// Deliberately NOT built on PriceChart.tsx's chart pattern — this mirrors
// CandleWatcher.tsx's engine instead (width-only continuous resize via
// applyOptions, the chart's own container as the direct, unwrapped touch-
// owning element with touch-action:none, handleScroll/handleScale always
// on), the one chart pattern in this app an entire earlier session never
// managed to reproduce the iOS scroll/blank-canvas bug on, despite
// extensive testing against PriceChart.tsx's version of it.
export function AgentChartModal({ coin, initialInterval, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleRef = useRef<ISeriesApi<"Candlestick"> | any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const volRef = useRef<ISeriesApi<"Histogram"> | any>(null);
  const [interval, setIntervalValue] = useState<ChartInterval>(initialInterval ?? "1h");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const isDark = document.documentElement.dataset.theme !== "light";
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: isDark ? "#0f1117" : "#ffffff" },
        textColor: isDark ? "#94a3b8" : "#475569",
      },
      grid: {
        vertLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
        horzLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
      },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: isDark ? "#1e293b" : "#e2e8f0" },
      timeScale: { borderColor: isDark ? "#1e293b" : "#e2e8f0", timeVisible: true, secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      width: el.clientWidth,
      height: el.clientHeight || 360,
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e", downColor: "#ef4444",
      borderUpColor: "#22c55e", borderDownColor: "#ef4444",
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    });
    const volSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candleSeries;
    volRef.current = volSeries;

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    coinglass.getHistoricalCandles(interval, coin)
      .then((candles) => {
        if (cancelled || !candleRef.current || !volRef.current) return;
        if (!candles.length) { setError(true); return; }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        candleRef.current.setData(candles.map((c: any) => ({
          time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
        })));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        volRef.current.setData(candles.map((c: any) => ({
          time: c.time,
          value: c.volume ?? 0,
          color: c.close >= c.open ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
        })));
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [interval, coin]);

  return (
    <div className="acm-backdrop" onClick={onClose}>
      <div className="acm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="acm-header">
          <span className="acm-coin">{coin}/USDT</span>
          <button className="acm-exit" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3" />
            </svg>
          </button>
        </div>
        <div className="acm-intervals">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              className={`acm-interval-btn${iv === interval ? " acm-interval-btn--active" : ""}`}
              onClick={() => setIntervalValue(iv)}
            >
              {INTERVAL_LABELS[iv]}
            </button>
          ))}
        </div>
        <div className="acm-chart-wrap">
          <div ref={containerRef} className="acm-chart-container" />
          {loading && <div className="acm-overlay">Loading…</div>}
          {!loading && error && <div className="acm-overlay">No data available</div>}
        </div>
      </div>
    </div>
  );
}
