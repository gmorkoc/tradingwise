import { useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { createChart, CandlestickSeries, IChartApi, Time, createSeriesMarkers } from "lightweight-charts";
import { CandleDataPoint } from "../services/coinglass";
import { PredictionPath } from "./DrawingOverlay";
import { ChartPrediction } from "../services/openai";
import "../styles/PredictionModal.css";

// ── Helpers ───────────────────────────────────────────────────────────────────

const INTERVAL_SEC: Record<string, number> = {
  "1sec": 1, "1min": 60, "5min": 300, "15min": 900,
  "1h": 3600, "4h": 14400, "6h": 21600, "1day": 86400, "1week": 604800,
};

function seededRand(seed: number): number {
  const x = Math.sin(seed + 1) * 43758.5453;
  return x - Math.floor(x);
}

function buildFutureCandles(
  waypoints: { time: number; price: number }[],
  intervalSec: number,
  historical: { open: number; high: number; low: number; close: number }[],
): { time: number; open: number; high: number; low: number; close: number }[] {
  if (waypoints.length < 2) return [];

  // Compute ATR from recent historical candles for realistic sizing
  const recent = historical.slice(-20);
  let atr = 0;
  if (recent.length >= 2) {
    let trSum = 0;
    for (let i = 1; i < recent.length; i++) {
      const hl  = recent[i].high - recent[i].low;
      const hpc = Math.abs(recent[i].high - recent[i - 1].close);
      const lpc = Math.abs(recent[i].low  - recent[i - 1].close);
      trSum += Math.max(hl, hpc, lpc);
    }
    atr = trSum / (recent.length - 1);
  }
  // Fallback: 0.3% of anchor price
  if (!atr || atr <= 0) atr = waypoints[0].price * 0.003;

  // Interpolate the trend midpoint price at any absolute time
  const trendAt = (t: number): number => {
    if (t <= waypoints[0].time) return waypoints[0].price;
    if (t >= waypoints[waypoints.length - 1].time) return waypoints[waypoints.length - 1].price;
    for (let i = 0; i + 1 < waypoints.length; i++) {
      if (t >= waypoints[i].time && t <= waypoints[i + 1].time) {
        const progress = (t - waypoints[i].time) / (waypoints[i + 1].time - waypoints[i].time);
        return waypoints[i].price + (waypoints[i + 1].price - waypoints[i].price) * progress;
      }
    }
    return waypoints[waypoints.length - 1].price;
  };

  const startTime = waypoints[0].time + intervalSec;
  const endTime   = waypoints[waypoints.length - 1].time;
  const result: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let prevClose   = waypoints[0].price;
  let idx         = 0;

  for (let t = startTime; t <= endTime + intervalSec * 0.5; t += intervalSec) {
    const seed     = idx++;
    const r1       = seededRand(seed * 7 + 1);
    const r2       = seededRand(seed * 7 + 2);
    const r3       = seededRand(seed * 7 + 3);
    const r4       = seededRand(seed * 7 + 4);

    const trendMid = trendAt(t);
    // Allow each candle's close to vary around the trend line by up to ±40% ATR,
    // but stay anchored so cumulative drift follows the trend
    const noise    = (r1 - 0.5) * atr * 0.8;
    const close    = trendMid + noise;

    // ~25% of candles are counter-trend (pullbacks), rest follow the trend slope
    const trendSlope = trendAt(t) - trendAt(t - intervalSec);
    const isPullback = r2 < 0.25;
    const bodySize   = atr * (0.35 + r3 * 0.55);  // body = 35-90% of ATR

    let open: number;
    if (isPullback) {
      open = close + bodySize * Math.sign(trendSlope);   // close goes opposite trend
    } else {
      open = close - bodySize * Math.sign(trendSlope || close - prevClose || 1);
    }
    // Blend with prevClose so candles connect naturally
    open = open * 0.6 + prevClose * 0.4;

    const hi  = Math.max(open, close) + atr * (0.15 + r4 * 0.45);
    const lo  = Math.min(open, close) - atr * (0.15 + seededRand(seed * 7 + 5) * 0.45);

    result.push({ time: t, open, high: hi, low: lo, close });
    prevClose = close;
  }

  return result;
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number, x2: number, y2: number, size: number,
) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

const fmt = (p: number) =>
  p >= 1000
    ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${p.toFixed(2)}`;

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  candles:        CandleDataPoint[];
  prediction:     PredictionPath;
  chartPrediction: ChartPrediction;
  coin:           string;
  interval:       string;
  theme?:         "dark" | "light";
  divergence?:    { type: "bullish" | "bearish"; pivots: { time: number; price: number }[] } | null;
  onClose:        () => void;
}

export function PredictionModal({
  candles, prediction, chartPrediction, coin, interval, theme = "dark", divergence, onClose,
}: Props) {
  const { t } = useTranslation();

  // ESC key close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Body scroll lock (prevents background scroll on iOS while allowing modal scroll)
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const containerRef  = useRef<HTMLDivElement>(null);
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const chartRef      = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef     = useRef<any>(null);
  const divergenceRef = useRef(divergence);
  divergenceRef.current = divergence;

  useEffect(() => {
    if (!containerRef.current) return;

    const isLight = theme === "light";
    const bg      = isLight ? "#ffffff" : "#060d1a";
    const fg      = isLight ? "#475569" : "#8899aa";
    const grid    = isLight ? "#e2e8f0" : "#0b1929";

    const chart = createChart(containerRef.current, {
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 300,
      layout: { background: { color: bg }, textColor: fg, fontSize: 11 },
      grid:   { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    });

    // Real candles (last 100 so divergence pivots are in range)
    const real = candles.slice(-100).map(c => ({ ...c, time: c.time as Time }));
    const realSeries = chart.addSeries(CandlestickSeries, {
      upColor:         "#22c55e",
      downColor:       "#ef4444",
      borderUpColor:   "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor:     "#22c55e",
      wickDownColor:   "#ef4444",
    });
    realSeries.setData(real);
    seriesRef.current = realSeries;

    // Projected candles
    const intervalSec   = INTERVAL_SEC[interval] ?? 3600;
    const futureCandles = buildFutureCandles(prediction.waypoints, intervalSec, candles);
    const dirColor =
      prediction.direction === "bullish" ? "#22c55e" :
      prediction.direction === "bearish" ? "#ef4444" : "#94a3b8";

    if (futureCandles.length > 0) {
      const ft = futureCandles.map(c => ({ ...c, time: c.time as Time }));
      const futureSeries = chart.addSeries(CandlestickSeries, {
        upColor:         "#ffffff",
        downColor:       "#1a1a1a",
        borderUpColor:   "#cccccc",
        borderDownColor: "#888888",
        wickUpColor:     "#bbbbbb",
        wickDownColor:   "#777777",
      });
      futureSeries.setData(ft);
    }

    // Key levels from AI
    for (const kl of chartPrediction.keyLevels ?? []) {
      realSeries.createPriceLine({
        price: kl.price,
        color: kl.style === "solid" ? "#94a3b8bb" : "#4b6280bb",
        lineWidth: 1,
        lineStyle: kl.style === "dashed" ? 2 : 4,
        axisLabelVisible: true,
        title: kl.label,
      });
    }

    realSeries.createPriceLine({ price: prediction.targetPrice, color: `${dirColor}cc`, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Target" });
    realSeries.createPriceLine({ price: prediction.stopLoss,    color: "#ef4444bb",     lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "SL"     });

    // Divergence markers
    if (divergence && divergence.pivots.length >= 2) {
      const isBull = divergence.type === "bullish";
      createSeriesMarkers(realSeries, divergence.pivots.map((p) => ({
        time: p.time as Time,
        position: isBull ? ("belowBar" as const) : ("aboveBar" as const),
        shape: isBull ? ("arrowUp" as const) : ("arrowDown" as const),
        color: isBull ? "#22c55e" : "#ef4444",
        size: 2,
        text: isBull ? "Bull Div" : "Bear Div",
      })));
    }

    chartRef.current = chart;

    const drawCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas || !seriesRef.current || !chartRef.current) return;

      const dpr  = window.devicePixelRatio || 1;
      const logW = canvas.offsetWidth;
      const logH = canvas.offsetHeight;
      if (!logW || !logH) return;

      if (canvas.width !== logW * dpr || canvas.height !== logH * dpr) {
        canvas.width  = logW * dpr;
        canvas.height = logH * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, logW, logH);

      const timeToX  = (t: number) => (chartRef.current!.timeScale().timeToCoordinate(t as Time) ?? -9999) as number;
      const priceToY = (p: number) => (seriesRef.current!.priceToCoordinate(p) ?? -9999) as number;

      // Fib zone
      if (chartPrediction.fibZone) {
        const { high, low, label } = chartPrediction.fibZone;
        const fy1 = priceToY(high);
        const fy2 = priceToY(low);
        if (fy1 > -999 && fy2 > -999) {
          const top = Math.min(fy1, fy2);
          const bot = Math.max(fy1, fy2);
          ctx.save();
          ctx.fillStyle   = "rgba(148,163,184,0.07)";
          ctx.strokeStyle = "rgba(148,163,184,0.22)";
          ctx.lineWidth   = 1;
          ctx.setLineDash([4, 4]);
          ctx.fillRect(0, top, logW, bot - top);
          ctx.strokeRect(0, top, logW, bot - top);
          ctx.setLineDash([]);
          ctx.font      = "10px Inter, sans-serif";
          ctx.fillStyle = "#64748b";
          ctx.fillText(label, 6, top + 13);
          ctx.restore();
        }
      }

      // Waypoint path
      const pts = prediction.waypoints
        .map(wp => ({ x: timeToX(wp.time), y: priceToY(wp.price), price: wp.price }))
        .filter(pt => pt.x > -999 && pt.y > -999);

      if (pts.length < 2) return;

      ctx.save();
      ctx.globalAlpha = 0.92;

      // Dashed line
      ctx.strokeStyle = dirColor;
      ctx.lineWidth   = 2;
      ctx.setLineDash([9, 5]);
      ctx.lineJoin    = "round";
      ctx.lineCap     = "round";
      ctx.beginPath();
      pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
      ctx.stroke();
      ctx.setLineDash([]);

      // Mid-segment directional arrows
      ctx.fillStyle = dirColor;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        drawArrowhead(ctx, p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2, 6);
      }

      // Dots at waypoints
      for (const pt of pts) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Final arrowhead
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      drawArrowhead(ctx, prev.x, prev.y, last.x, last.y, 13);

      // Target label
      ctx.font      = "bold 11px Inter, sans-serif";
      ctx.fillStyle = dirColor;
      ctx.fillText(`⊕ ${fmt(last.price)}`, last.x + 13, last.y + 4);

      // ── Divergence line ──────────────────────────────────────────────────
      const div = divergenceRef.current;
      if (div && div.pivots.length >= 2) {
        const isBull  = div.type === "bullish";
        const divClr  = isBull ? "#22c55e" : "#ef4444";
        const [pa, pb] = div.pivots;
        const dx1 = timeToX(pa.time), dy1 = priceToY(pa.price);
        const dx2 = timeToX(pb.time), dy2 = priceToY(pb.price);

        if (dx1 > -999 && dy1 > -999 && dx2 > -999 && dy2 > -999) {
          ctx.save();
          ctx.strokeStyle = divClr;
          ctx.fillStyle   = divClr;
          ctx.globalAlpha = 0.9;
          ctx.lineWidth   = 2;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(dx1, dy1);
          ctx.lineTo(dx2, dy2);
          ctx.stroke();
          ctx.setLineDash([]);

          // Circles at each pivot
          for (const [cx, cy] of [[dx1, dy1], [dx2, dy2]] as [number, number][]) {
            ctx.beginPath();
            ctx.arc(cx, cy, 5, 0, Math.PI * 2);
            ctx.fill();
          }

          // Label
          ctx.font = "bold 11px Inter, sans-serif";
          const labelY = dy2 + (isBull ? 16 : -8);
          ctx.fillText(isBull ? "↑ Bull Div" : "↓ Bear Div", dx2 - 28, labelY);
          ctx.restore();
        }
      }

      ctx.restore();
    };

    // Extend time range
    const lastWp    = prediction.waypoints[prediction.waypoints.length - 1];
    const firstTime = (real[0]?.time ?? prediction.waypoints[0].time) as number;
    try {
      chart.timeScale().setVisibleRange({
        from: firstTime as Time,
        to:   (lastWp.time + intervalSec * 3) as Time,
      });
    } catch {}

    chart.timeScale().subscribeVisibleTimeRangeChange(drawCanvas);

    const ro = new ResizeObserver(() => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
      setTimeout(drawCanvas, 20);
    });
    ro.observe(containerRef.current);
    setTimeout(drawCanvas, 80);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = seriesRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveChart = useCallback(() => {
    const chart   = chartRef.current;
    const overlay = canvasRef.current;
    if (!chart || !overlay) return;

    // LWC's official API — captures the full chart (candles, axes, price lines, labels)
    const chartCanvas = chart.takeScreenshot();

    const out = document.createElement("canvas");
    out.width  = chartCanvas.width;
    out.height = chartCanvas.height;
    const ctx  = out.getContext("2d");
    if (!ctx) return;

    // 1. Full chart from lightweight-charts
    ctx.drawImage(chartCanvas, 0, 0);

    // 2. Prediction overlay (fib zone, dashed path, arrows, divergence lines)
    //    Overlay canvas is at logical size * DPR — scale it to match chartCanvas
    ctx.drawImage(overlay, 0, 0, out.width, out.height);

    const a = document.createElement("a");
    a.download = `${coin}-${interval}-prediction-${new Date().toISOString().slice(0, 10)}.png`;
    a.href = out.toDataURL("image/png", 1.0);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [coin, interval]);

  const dir  = chartPrediction.direction;
  const conf = chartPrediction.confidence;

  // ── Trading metrics (all computed client-side) ──────────────────────────
  const entry     = prediction.waypoints[0]?.price ?? 0;
  const target    = chartPrediction.targetPrice;
  const sl        = chartPrediction.stopLoss;
  const riskPct   = entry > 0 ? Math.abs((sl - entry) / entry * 100) : 0;
  const rewardPct = entry > 0 ? Math.abs((target - entry) / entry * 100) : 0;
  const rr        = riskPct > 0 ? rewardPct / riskPct : 0;
  const safeLev   = chartPrediction.suggestedLeverage
    ?? Math.min(20, Math.max(2, Math.floor(0.8 / (riskPct / 100))));
  const liqLevels = [5, 10, 20].map(lev => ({
    lev,
    long:  entry * (1 - 1 / lev),
    short: entry * (1 + 1 / lev),
  }));

  return createPortal(
    <div
      className="pred-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className={`pm-border-glow pm-border-glow--${dir}`}>
      <div className={`pred-modal pred-modal--${dir}`} data-theme={theme}>

        {/* ── Header ── */}
        <div className="pred-modal-header">
          <div className="pred-modal-header-row">
            <span className="pred-modal-title-text">{t("predModal.title", { coin, interval })}</span>
            <button className="pred-modal-close" onClick={onClose} aria-label="Close">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M1 1l9 9M10 1L1 10"/>
              </svg>
            </button>
          </div>
          <div className="pred-modal-header-row pred-modal-header-row--start">
            <span className={`pred-modal-dir-badge pred-modal-dir-badge--${dir}`}>
              {dir === "bullish" ? (
                <>{t("predModal.bullish")} <span className="pm-live-dot" /></>
              ) : dir === "bearish" ? (
                <>{t("predModal.bearish")} <span className="pm-live-dot pm-live-dot--bearish" /></>
              ) : t("predModal.neutral")}
            </span>
            <span className={`pred-modal-conf pred-modal-conf--${conf}`}>
              {conf === "high" ? t("predModal.confHigh") : conf === "medium" ? t("predModal.confMed") : t("predModal.confLow")} {t("predModal.confidence")}
            </span>
          </div>
        </div>

        {/* ── Chart ── */}
        <div className="pred-modal-chart-wrap">
          <div ref={containerRef} />
          <canvas ref={canvasRef} className="pred-modal-canvas" />
          <button className="pred-modal-save-btn" onClick={saveChart} title="Save chart as PNG">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            {t("predModal.save")}
          </button>
        </div>

        {/* ── Info ── */}
        <div className="pred-modal-info">

          {/* Scenario */}
          <div className="pred-modal-scenario-row">
            <span className="pred-modal-scenario-label">{t("predModal.scenario")}</span>
            <span className="pred-modal-scenario-text">{chartPrediction.scenario}</span>
          </div>

          {/* ── Metrics strip ── */}
          <div className="pm-stats-strip">
            <div className="pm-stat">
              <span className="pm-stat-label">{t("predModal.entry")}</span>
              <span className="pm-stat-value">{fmt(entry)}</span>
            </div>
            <div className="pm-stat-sep" />
            <div className="pm-stat">
              <span className="pm-stat-label">{t("predModal.target")}</span>
              <div className="pm-stat-right">
                <span className={`pm-stat-value pm-stat-value--${dir}`}>{fmt(target)}</span>
                <span className={`pm-stat-pct pm-stat-pct--${dir}`}>{dir === "bearish" ? "−" : "+"}{rewardPct.toFixed(2)}%</span>
              </div>
            </div>
            <div className="pm-stat-sep" />
            <div className="pm-stat">
              <span className="pm-stat-label">{t("predModal.stopLoss")}</span>
              <div className="pm-stat-right">
                <span className="pm-stat-value pm-stat-value--sl">{fmt(sl)}</span>
                <span className="pm-stat-pct pm-stat-pct--sl">−{riskPct.toFixed(2)}%</span>
              </div>
            </div>
            <div className="pm-stat-sep" />
            <div className="pm-stat">
              <span className="pm-stat-label">{t("predModal.rr")}</span>
              <div className="pm-stat-right">
                <span className={`pm-stat-rr-val pm-stat-rr-val--${rr >= 2 ? "good" : rr >= 1 ? "ok" : "bad"}`}>
                  {rr >= 1 ? `1 : ${rr.toFixed(1)}` : `${(1 / rr).toFixed(1)} : 1`}
                </span>
              </div>
            </div>
          </div>

          {/* ── Body ── */}
          <div className="pm-body">

            {/* Left: Analysis */}
            <div className="pm-body-left">
              {divergence && (
                <div className={`pm-divergence pm-divergence--${divergence.type}`}>
                  <span className="pm-divergence-icon">{divergence.type === "bullish" ? "↑" : "↓"}</span>
                  <div>
                    <span className="pm-divergence-label">
                      {divergence.type === "bullish" ? t("predModal.bullDiv") : t("predModal.bearDiv")}
                    </span>
                    <p className="pm-divergence-desc">
                      {divergence.type === "bullish" ? t("predModal.bullDivDesc") : t("predModal.bearDivDesc")}
                    </p>
                  </div>
                </div>
              )}

              {chartPrediction.analysis && (
                <div>
                  <span className="pred-modal-section-label">{t("predModal.analysis")}</span>
                  <p className="pred-modal-analysis">{chartPrediction.analysis}</p>
                </div>
              )}

              {chartPrediction.keyFactors?.length > 0 && (
                <div>
                  <span className="pred-modal-section-label">{t("predModal.keyFactors")}</span>
                  <ul className="pred-modal-factors">
                    {chartPrediction.keyFactors.map((f, i) => (
                      <li key={i} className="pred-modal-factor">
                        <span className={`pred-modal-factor-dot pred-modal-factor-dot--${dir}`} />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {chartPrediction.annotation && (
                <p className="pred-modal-annotation">"{chartPrediction.annotation}"</p>
              )}
            </div>

            {/* Right: Leverage + Liquidation */}
            <div className="pm-body-right">

              <div className="pm-lev-block">
                <div className="pm-block-header">
                  <span className="pm-block-label">{t("predModal.safeLeverage")}</span>
                  <span className="pm-block-value">{t("predModal.upTo", { lev: safeLev })}</span>
                </div>
                <div className="pm-lev-track">
                  {[2, 5, 10, 20].map(lev => (
                    <div key={lev} className={`pm-lev-step ${lev <= safeLev ? "pm-lev-step--on" : "pm-lev-step--off"}`}>
                      <span className="pm-lev-step-label">{lev}x</span>
                      <div className="pm-lev-step-bar" />
                    </div>
                  ))}
                </div>
              </div>

              <div className="pm-liq-block">
                <div className="pm-block-header">
                  <span className="pm-block-label">{t("predModal.liqPrices")}</span>
                </div>
                <div className="pm-liq-grid-head">
                  <span />
                  <span className="pm-liq-col-label">{t("predModal.long")}</span>
                  <span className="pm-liq-col-label">{t("predModal.short")}</span>
                </div>
                {liqLevels.map(({ lev, long, short }) => (
                  <div key={lev} className="pm-liq-grid-row">
                    <span className="pm-liq-lev">{lev}x</span>
                    <span className="pm-liq-long">{fmt(long)}</span>
                    <span className="pm-liq-short">{fmt(short)}</span>
                  </div>
                ))}
              </div>

            </div>

          </div>
        </div>
      </div>
      </div>
    </div>
  , document.body);
}
