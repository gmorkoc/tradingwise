import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  IChartApi,
  ISeriesApi,
  createSeriesMarkers,
} from "lightweight-charts";
import { coinglass, CoinSymbol, CandleDataPoint } from "../services/coinglass";
import { PredictionResponse, ScenarioItem } from "../services/openai";

interface Props {
  coin: CoinSymbol;
  currentPrice: number;
  prediction: PredictionResponse;
  theme: "dark" | "light";
}

export interface PredictionChartHandle {
  resetZoom: () => void;
}

const SCENARIO_CFG: Record<ScenarioItem["direction"], { color: string; shape: "arrowUp" | "arrowDown"; pos: "aboveBar" | "belowBar" }> = {
  up:       { color: "#22c55e", shape: "arrowUp",   pos: "aboveBar" },
  down:     { color: "#fb7185", shape: "arrowDown",  pos: "belowBar" },
  sideways: { color: "#facc15", shape: "arrowUp",    pos: "aboveBar" },
};

const TF_COLORS: Record<string, string> = {
  "8h":  "#38bdf8",
  "12h": "#a78bfa",
  "16h": "#fb923c",
  "24h": "#4ade80",
};


export const PredictionChart = forwardRef<PredictionChartHandle, Props>(({ coin, currentPrice, prediction, theme }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  useImperativeHandle(ref, () => ({
    resetZoom: () => chartRef.current?.timeScale().fitContent(),
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const isDark = theme === "dark";

    const chart = createChart(el, {
      width:  el.clientWidth || el.offsetWidth || 800,
      height: el.clientHeight || 360,
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor:  isDark ? "#94a3b8" : "#475569",
      },
      grid: {
        vertLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
        horzLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)" },
      },
      crosshair: { mode: 0 },
      rightPriceScale: {
        borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.1)",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.1)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: prediction.scenarios?.length ? 18 : 6,
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
      handleScale:  { axisPressedMouseMove: false, mouseWheel: false, pinch: false },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:         "#22c55e",
      downColor:       "#ef4444",
      borderUpColor:   "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor:     "#22c55e",
      wickDownColor:   "#ef4444",
    });

    // current price line
    candleSeries.createPriceLine({
      price:            currentPrice,
      color:            "#facc15",
      lineWidth:        1,
      lineStyle:        LineStyle.Solid,
      axisLabelVisible: true,
      title:            "Now",
    });

    // timeframe range bands (high = dashed, low = dotted)
    if (prediction.timeframes) {
      for (const [tf, range] of Object.entries(prediction.timeframes)) {
        const color = TF_COLORS[tf] ?? "#94a3b8";
        candleSeries.createPriceLine({ price: range.high, color, lineWidth: 1, lineStyle: LineStyle.Dashed,  axisLabelVisible: true, title: `${tf} ↑` });
        candleSeries.createPriceLine({ price: range.low,  color, lineWidth: 1, lineStyle: LineStyle.Dotted,  axisLabelVisible: true, title: `${tf} ↓` });
      }
    }

    // support / resistance
    prediction.supportLevels?.forEach((price, i) => {
      candleSeries.createPriceLine({ price, color: "#22c55e", lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: i === 0, title: i === 0 ? "Support" : "" });
    });
    prediction.resistanceLevels?.forEach((price, i) => {
      candleSeries.createPriceLine({ price, color: "#fb7185", lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: i === 0, title: i === 0 ? "Resistance" : "" });
    });

    // projected scenario path lines + scenario target price lines
    const projectionSeries: ISeriesApi<"Line">[] = [];

    const addProjection = (lastTime: number, target: number, dir: ScenarioItem["direction"]) => {
      const cfg    = SCENARIO_CFG[dir];
      const hours  = dir === "up" ? 20 : dir === "down" ? 20 : 16;
      const endTime = lastTime + hours * 3600;
      const s = chart.addSeries(LineSeries, {
        color:           cfg.color,
        lineWidth:       2,
        lineStyle:       LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      s.setData([
        { time: lastTime as any,  value: currentPrice },
        { time: endTime  as any,  value: target       },
      ]);
      projectionSeries.push(s);
    };

    const loadCandles = async () => {
      const candles: CandleDataPoint[] = await coinglass.getHistoricalCandles("1h", coin).catch(() => []);
      if (!candles.length) return;

      candleSeries.setData(candles as any);

      const lastTime = candles[candles.length - 1].time as number;

      // scenario arrows as markers on the last candle
      if (prediction.scenarios?.length) {
        // sort: up arrows above, down arrows below
        const sorted = [...prediction.scenarios].sort((a, b) =>
          a.direction === "up" ? -1 : b.direction === "up" ? 1 : 0
        );
        const markers = sorted.map(sc => {
          const cfg = SCENARIO_CFG[sc.direction] ?? SCENARIO_CFG.sideways;
          return {
            time:     lastTime as any,
            position: cfg.pos,
            color:    cfg.color,
            shape:    cfg.shape,
            text:     `${sc.label} ${sc.probability} → $${(sc.target / 1000).toFixed(1)}K`,
            size:     2,
          };
        });
        createSeriesMarkers(candleSeries, markers);

        // draw projected path lines for each scenario
        prediction.scenarios.forEach(sc => addProjection(lastTime, sc.target, sc.direction));
      }

      setTimeout(() => chart.timeScale().fitContent(), 50);
    };

    loadCandles();

    const ro = new ResizeObserver(() => {
      chart.timeScale().fitContent();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [coin, currentPrice, prediction, theme]);

  const scenarios = prediction.scenarios ?? [];

  return (
    <div className="aip-pred-chart-wrap">
      <div className="aip-pred-chart-header">
        <span className="aip-pred-chart-title">Price Prediction Chart</span>
        <div className="aip-pred-chart-legend">
          {scenarios.map(sc => {
            const cfg = SCENARIO_CFG[sc.direction] ?? SCENARIO_CFG.sideways;
            return (
              <span key={sc.label} className="aip-pred-chart-legend-item">
                <span className="aip-pred-chart-legend-dot" style={{ background: cfg.color }} />
                <span style={{ color: cfg.color }}>{sc.label}</span>
                <span className="aip-pred-chart-legend-prob">{sc.probability}</span>
              </span>
            );
          })}
          {Object.entries(TF_COLORS).map(([tf, c]) => (
            <span key={tf} className="aip-pred-chart-legend-item aip-pred-chart-legend-item--tf">
              <span className="aip-pred-chart-legend-line" style={{ background: c }} />
              {tf}
            </span>
          ))}
        </div>
      </div>

      {scenarios.length > 0 && (
        <div className="aip-pred-scenarios">
          {scenarios.map(sc => {
            const cfg = SCENARIO_CFG[sc.direction] ?? SCENARIO_CFG.sideways;
            const diff = sc.target - currentPrice;
            const pct  = currentPrice > 0 ? ((diff / currentPrice) * 100).toFixed(1) : "0";
            const sign = diff >= 0 ? "+" : "";
            return (
              <div key={sc.label} className="aip-pred-scenario-card" style={{ borderColor: cfg.color + "55" }}>
                <div className="aip-pred-scenario-arrow" style={{ color: cfg.color }}>
                  {sc.direction === "up" ? "↑" : sc.direction === "down" ? "↓" : "→"}
                </div>
                <div className="aip-pred-scenario-body">
                  <div className="aip-pred-scenario-label" style={{ color: cfg.color }}>{sc.label}</div>
                  <div className="aip-pred-scenario-target">${sc.target.toLocaleString()}</div>
                  <div className="aip-pred-scenario-pct">{sign}{pct}%</div>
                </div>
                <div className="aip-pred-scenario-right">
                  <div className="aip-pred-scenario-prob">{sc.probability}</div>
                  <div className="aip-pred-scenario-trigger">{sc.trigger}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div ref={containerRef} className="aip-pred-chart-canvas" />
    </div>
  );
});
