import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { createChart, ColorType, LineSeries, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { coinglass, CandleDataPoint, CoinSymbol } from "../services/coinglass";
import "../styles/CompactPriceView.css";

interface Props {
  coin: CoinSymbol;
  theme: "dark" | "light";
  onClose: () => void;
}

interface Tick {
  id: number;
  usd: number;
  isBuy: boolean;
}

const MAX_TICKS = 6;
const SEED_INTERVAL: "1min" = "1min";

// A minimal, glanceable price view — current price, a simple line (no
// indicators/overlays/drawing tools), and a live trade-size ticker along
// the edge. Modeled on the reference the user shared (a betting app's
// compact chart), but without any of the actual wager/odds UI — just the
// visual density/pacing, applied to our own real-time 1s price + trade
// data (see OrderFlowTape.tsx for the same Kraken trade-feed pattern).
export function CompactPriceView({ coin, theme, onClose }: Props) {
  const { t } = useTranslation();
  const isLight = theme === "light";

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const openPriceRef = useRef<number | null>(null);

  const [current, setCurrent] = useState<number | null>(null);
  const [openPrice, setOpenPrice] = useState<number | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const tickIdRef = useRef(0);

  // ── Chart: seed with 1min history, then tick live every second ──────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: isLight ? "rgba(15,23,42,0.45)" : "rgba(255,255,255,0.4)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: isLight ? "rgba(15,23,42,0.04)" : "rgba(255,255,255,0.05)" },
        horzLines: { color: isLight ? "rgba(15,23,42,0.04)" : "rgba(255,255,255,0.05)" },
      },
      rightPriceScale: { borderColor: isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: true },
      handleScroll: false,
      handleScale: false,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    chartRef.current = chart;

    const lineSeries = chart.addSeries(LineSeries, {
      color: "#22c55e",
      lineWidth: 2,
      crosshairMarkerVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    lineRef.current = lineSeries;

    let cancelled = false;
    coinglass.getHistoricalCandles(SEED_INTERVAL, coin).then((candles: CandleDataPoint[]) => {
      if (cancelled || !candles.length) return;
      const recent = candles.slice(-60);
      lineSeries.setData(recent.map(c => ({ time: c.time as UTCTimestamp, value: c.close })));
      const open = recent[0].close;
      openPriceRef.current = open;
      setOpenPrice(open);
      setCurrent(recent[recent.length - 1].close);
      chart.timeScale().fitContent();
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      lineRef.current = null;
    };
  }, [coin, isLight]);

  // Live tick every second — same cadence as the full chart's own 1sec
  // interval (see PriceChart.tsx's live-polling effect).
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const candle = await coinglass.getLiveSecondCandle(coin);
      if (!candle) return;
      lineRef.current?.update({ time: candle.time as UTCTimestamp, value: candle.close });
      setCurrent(candle.close);
      const series = lineRef.current;
      if (series) {
        series.applyOptions({
          color: openPriceRef.current !== null && candle.close < openPriceRef.current ? "#fb7185" : "#22c55e",
        });
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [coin]);

  // ── Live trade ticker (left edge) — same Kraken feed as OrderFlowTape,
  // just rendered as small $ ticks instead of a full tape table. ─────────
  useEffect(() => {
    const krakenSymbol = `${coin.toUpperCase()}/USD`;
    let ws: WebSocket;
    let dead = false;
    let retryTimer = 0;

    const connect = () => {
      if (dead) return;
      ws = new WebSocket("wss://ws.kraken.com/v2");
      ws.onopen = () => {
        ws.send(JSON.stringify({ method: "subscribe", params: { channel: "trade", symbol: [krakenSymbol] } }));
      };
      ws.onclose = () => { if (!dead) retryTimer = window.setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.channel !== "trade") return;
        const newTicks: Tick[] = (msg.data ?? []).map((tr: any) => ({
          id: tickIdRef.current++,
          usd: tr.price * tr.qty,
          isBuy: tr.side === "buy",
        }));
        if (newTicks.length === 0) return;
        setTicks(prev => [...newTicks, ...prev].slice(0, MAX_TICKS));
      };
    };
    connect();

    return () => { dead = true; clearTimeout(retryTimer); ws?.close(); };
  }, [coin]);

  const fmtUsd = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(0)}`;

  const change = current !== null && openPrice !== null ? current - openPrice : null;
  const changePct = change !== null && openPrice ? (change / openPrice) * 100 : null;
  const changeUp = (change ?? 0) >= 0;

  // Portaled straight to <body> — same reasoning as CoinChat's own mobile
  // sheet (see its createPortal calls): nested anywhere inside the normal
  // component tree, a position:fixed + high z-index can still get trapped
  // under whichever ancestor happens to create its own stacking context,
  // and silently lose to *other* portaled UI (Daily Brief, the CoinChat
  // dock) regardless of how high the z-index number is. Escaping to
  // <body> is what actually guarantees this renders above everything.
  return createPortal(
    <div className="cpv-overlay">
      <div className="cpv-root">
        <div className="cpv-header">
          <button type="button" className="cpv-back" onClick={onClose} aria-label={t("common.close", "Close")}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <span className="cpv-coin">{coin}/USD</span>
          <span className="cpv-live-badge">
            <span className="cpv-live-dot" />
            {t("chart.live", "LIVE")}
          </span>
        </div>

        <div className="cpv-price-row">
          <span className={`cpv-price${changeUp ? " cpv-up" : " cpv-down"}`}>
            {current !== null ? `$${current.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : "—"}
          </span>
          {change !== null && changePct !== null && (
            <span className={`cpv-change${changeUp ? " cpv-up" : " cpv-down"}`}>
              {changeUp ? "▲" : "▼"} {Math.abs(changePct).toFixed(2)}%
              <span className="cpv-change-abs">
                (${Math.abs(change).toLocaleString(undefined, { maximumFractionDigits: 6 })})
              </span>
              <span className="cpv-change-window">1H</span>
            </span>
          )}
        </div>

        <div className="cpv-chart-wrap">
          <div className="cpv-ticks">
            {ticks.map(tick => (
              <span key={tick.id} className={`cpv-tick${tick.isBuy ? " cpv-up" : " cpv-down"}`}>
                {tick.isBuy ? "↑" : "↓"} {fmtUsd(tick.usd)}
              </span>
            ))}
          </div>
          <div className="cpv-chart" ref={containerRef} />
        </div>
      </div>
    </div>,
    document.body
  );
}
