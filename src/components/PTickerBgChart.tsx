import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, UTCTimestamp } from "lightweight-charts";
import { coinglass } from "../services/coinglass";

interface Props {
  coin: string;
  isDark: boolean;
}

export function PTickerBgChart({ coin, isDark }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: { background: { color: "transparent" }, textColor: "transparent" },
      grid:   { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      leftPriceScale:  { visible: false },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: {
        horzLine: { visible: false },
        vertLine: { visible: false },
      },
      handleScroll: false,
      handleScale:  false,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:          isDark ? "rgba(34,197,94,0.55)"  : "rgba(22,163,74,0.45)",
      downColor:        isDark ? "rgba(239,68,68,0.55)"  : "rgba(220,38,38,0.45)",
      borderUpColor:    isDark ? "rgba(34,197,94,0.7)"   : "rgba(22,163,74,0.6)",
      borderDownColor:  isDark ? "rgba(239,68,68,0.7)"   : "rgba(220,38,38,0.6)",
      wickUpColor:      isDark ? "rgba(34,197,94,0.35)"  : "rgba(22,163,74,0.3)",
      wickDownColor:    isDark ? "rgba(239,68,68,0.35)"  : "rgba(220,38,38,0.3)",
      priceLineVisible: false,
      lastValueVisible: false,
    });

    coinglass.get24hMinuteCandles(coin, 120).then(candles => {
      if (!candles.length) return;
      series.setData(candles.map(c => ({
        time:  c.time as UTCTimestamp,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      })));
      chart.timeScale().fitContent();
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current)
        chart.applyOptions({
          width:  containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); };
  }, [coin, isDark]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        opacity: 0.7,
        pointerEvents: "none",
        zIndex: 0,
      }}
    />
  );
}
