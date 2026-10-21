import { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { coinglass } from "../services/coinglass";
import { RoundedCandleOverlay } from "./DrawingOverlay";

interface Props {
  coin: string;
  coinColor: string;
  isDark: boolean;
}

export function TickerMiniChart({ coin, coinColor, isDark }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef  = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const candlesRef = useRef<{ time: number; open: number; high: number; low: number; close: number }[]>([]);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;

    const textClr  = isDark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.22)";
    const crossClr = isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.18)";

    const chart = createChart(containerRef.current, {
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: { background: { color: "transparent" }, textColor: textClr, fontSize: 10 },
      grid:   { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale:  { visible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        barSpacing: 18,
        minBarSpacing: 10,
      },
      crosshair: {
        horzLine: { visible: false },
        vertLine: { color: crossClr, width: 1, style: 1, labelVisible: false },
      },
      handleScroll: false,
      handleScale:  false,
    });

    // Transparent — RoundedCandleOverlay below paints the visible
    // rounded-corner bodies/wicks, same pattern as PriceChart.tsx. Series
    // stays mounted (just invisible) so it keeps driving scale/crosshair.
    const series = chart.addSeries(CandlestickSeries, {
      upColor:          "transparent",
      downColor:        "transparent",
      borderUpColor:    "transparent",
      borderDownColor:  "transparent",
      wickUpColor:      "transparent",
      wickDownColor:    "transparent",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chartRef.current  = chart;
    seriesRef.current = series;

    coinglass.get24hMinuteCandles(coin, 30).then(candles => {
      if (!candles.length) return;
      const points = candles.map(c => ({
        time:  c.time as UTCTimestamp,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      }));
      series.setData(points);
      candlesRef.current = points;
      setGeneration(g => g + 1);
      chart.timeScale().fitContent();
      setLoading(false);
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [coin, coinColor, isDark]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {loading && (
        <div style={{
          position: "absolute", inset: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          fontSize: "0.72rem",
          color: isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)",
        }}>
          Loading…
        </div>
      )}
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <RoundedCandleOverlay
        chartRef={chartRef}
        seriesRef={seriesRef}
        candlesRef={candlesRef}
        upColor="#22c55e"
        downColor="#ef4444"
        style="candle"
        generation={generation}
        visible={true}
      />
    </div>
  );
}
