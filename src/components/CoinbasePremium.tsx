import { createChart, ColorType, HistogramSeries, LineSeries, IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPremiumAIAnalysis, PremiumAIResult } from "../services/openai";
import { AIQuotaWall } from "./AIQuotaWall";
import { useAIQuota } from "../hooks/useAIQuota";
import "../styles/CoinbasePremium.css";

const GRANULARITY = 3600;
const POLL_MS     = 5_000;
const GREEN       = "rgba(34, 197, 94, 0.85)";
const RED         = "rgba(251, 113, 133, 0.85)";

// ── Historical data ───────────────────────────────────────────────────────────

interface HistPoint { time: UTCTimestamp; premium: number; price: number; }

async function fetchCoinbaseCandles(days = 7): Promise<Array<{ time: UTCTimestamp; close: number }>> {
  try {
    const end   = new Date();
    const start = new Date(Date.now() - days * 24 * 3600 * 1000);
    const res = await fetch(
      `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${GRANULARITY}&start=${start.toISOString()}&end=${end.toISOString()}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const data: number[][] = await res.json();
    return data.reverse().map(([time, , , , close]) => ({ time: time as UTCTimestamp, close }));
  } catch { return []; }
}

async function fetchKrakenCandles(days = 7): Promise<Array<{ time: UTCTimestamp; close: number }>> {
  try {
    const since = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
    const res = await fetch(
      `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=60&since=${since}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];
    const d = await res.json();
    const candles: Array<[number, string, string, string, string]> = d.result?.XXBTZUSD ?? [];
    return candles.map(([time, , , , close]) => ({ time: time as UTCTimestamp, close: parseFloat(close) }));
  } catch { return []; }
}

async function fetchHistoricalPremium(): Promise<HistPoint[]> {
  const [cb, kr] = await Promise.all([fetchCoinbaseCandles(), fetchKrakenCandles()]);
  if (!cb.length || !kr.length) return [];
  const krMap = new Map(kr.map(c => [Math.floor(c.time / GRANULARITY), c.close]));
  return cb
    .map(c => {
      const krClose = krMap.get(Math.floor(c.time / GRANULARITY));
      if (!krClose || !c.close) return null;
      return { time: c.time, premium: ((c.close - krClose) / krClose) * 100, price: c.close };
    })
    .filter((x): x is HistPoint => x !== null);
}

// ── Live data ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryFetch(url: string, extract: (d: any) => number): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const d = await res.json();
    const p = extract(d);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

async function fetchCoinbasePrice(): Promise<number | null> {
  return tryFetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker", d => parseFloat(d.price));
}

async function fetchRefPrice(): Promise<{ price: number; source: string } | null> {
  const candidates = [
    { source: "Binance",  url: "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT", extract: (d: any) => parseFloat(d.price) },
    { source: "Bybit",    url: "https://api.bybit.com/v5/market/ticker?category=spot&symbol=BTCUSDT", extract: (d: any) => parseFloat(d.result?.list?.[0]?.lastPrice) },
    { source: "Kraken",   url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",                 extract: (d: any) => parseFloat(d.result?.XXBTZUSD?.c?.[0]) },
    { source: "Bitstamp", url: "https://www.bitstamp.net/api/v2/ticker/btcusd/",                     extract: (d: any) => parseFloat(d.last) },
  ];
  for (const c of candidates) {
    const price = await tryFetch(c.url, c.extract);
    if (price) return { price, source: c.source };
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcTrend(premiums: number[]): "rising" | "falling" | "flat" {
  if (premiums.length < 6) return "flat";
  const recent = premiums.slice(-6);
  const first  = recent.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const last   = recent.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const delta  = last - first;
  if (delta >  0.005) return "rising";
  if (delta < -0.005) return "falling";
  return "flat";
}

const SENTIMENT_CFG = {
  bullish: { color: "#22c55e", bg: "rgba(34,197,94,0.12)",   tKey: "common.bullish" },
  neutral: { color: "#38bdf8", bg: "rgba(56,189,248,0.12)",  tKey: "common.neutral" },
  bearish: { color: "#fb7185", bg: "rgba(251,113,133,0.12)", tKey: "common.bearish" },
};

// ── Component ─────────────────────────────────────────────────────────────────

interface OnChainMetricsProps {
  onOpenAuth?: () => void;
  onOpenUpgrade?: () => void;
}

export function CoinbasePremium({ onOpenAuth = () => {}, onOpenUpgrade = () => {} }: OnChainMetricsProps) {
  const { t } = useTranslation();
  const { exceeded, used, limit, consume } = useAIQuota();

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const histRef      = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lineRef      = useRef<ISeriesApi<"Line"> | null>(null);
  const lastTimeRef  = useRef<number>(0);
  const histPointsRef = useRef<HistPoint[]>([]);

  const [refSource,   setRefSource]   = useState("…");
  const [current,     setCurrent]     = useState<number | null>(null);
  const [cbPrice,     setCbPrice]     = useState<number | null>(null);
  const [histLoading, setHistLoading] = useState(true);
  const [liveError,   setLiveError]   = useState(false);

  const [ai,        setAI]        = useState<PremiumAIResult | null>(null);
  const [aiLoading, setAILoading] = useState(false);
  const [aiError,   setAIError]   = useState(false);

  // Create chart once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.4)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      leftPriceScale:  { visible: true, borderColor: "rgba(255,255,255,0.08)", scaleMargins: { top: 0.1, bottom: 0.1 } },
      rightPriceScale: { visible: true, borderColor: "rgba(255,255,255,0.08)", scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: "rgba(255,255,255,0.15)", labelBackgroundColor: "#1e293b" },
        horzLine: { color: "rgba(255,255,255,0.15)", labelBackgroundColor: "#1e293b" },
      },
      handleScroll: false,
      handleScale: false,
      width: containerRef.current.clientWidth,
      height: 260,
    });
    chartRef.current = chart;

    const histSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: "left",
      color: GREEN,
      base: 0,
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });
    histRef.current = histSeries;

    const lineSeries = chart.addSeries(LineSeries, {
      priceScaleId: "right",
      color: "rgba(255,255,255,0.75)",
      lineWidth: 1,
      crosshairMarkerVisible: false,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });
    lineRef.current = lineSeries;

    fetchHistoricalPremium().then(hist => {
      setHistLoading(false);
      if (!hist.length) return;
      histPointsRef.current = hist;
      histSeries.setData(hist.map(p => ({ time: p.time, value: p.premium, color: p.premium >= 0 ? GREEN : RED })));
      lineSeries.setData(hist.map(p => ({ time: p.time, value: p.price })));
      lastTimeRef.current = hist[hist.length - 1].time;
      chart.timeScale().fitContent();
    });

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; histRef.current = null; lineRef.current = null; };
  }, []);

  // Live polling
  useEffect(() => {
    async function poll() {
      const [cbPx, ref] = await Promise.all([fetchCoinbasePrice(), fetchRefPrice()]);
      if (!cbPx || !ref) { setLiveError(true); return; }
      setLiveError(false);
      setRefSource(ref.source);
      setCbPrice(cbPx);
      const premium = ((cbPx - ref.price) / ref.price) * 100;
      setCurrent(premium);

      const nowSec     = Math.floor(Date.now() / 1000);
      const roundedMin = Math.floor(nowSec / 60) * 60 as UTCTimestamp;

      if (roundedMin > lastTimeRef.current && histRef.current && lineRef.current) {
        lastTimeRef.current = roundedMin;
        histRef.current.update({ time: roundedMin, value: premium, color: premium >= 0 ? GREEN : RED });
        lineRef.current.update({ time: roundedMin, value: cbPx });
        histPointsRef.current = [...histPointsRef.current, { time: roundedMin, premium, price: cbPx }];
      }
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Trigger AI once historical + live data are ready
  useEffect(() => {
    if (histLoading || current === null || cbPrice === null || ai || aiLoading || exceeded) return;
    if (!consume()) return;

    const pts      = histPointsRef.current;
    const premiums = pts.map(p => p.premium);
    if (premiums.length < 5) return;

    const avg7d  = premiums.reduce((a, b) => a + b, 0) / premiums.length;
    const high7d = Math.max(...premiums);
    const low7d  = Math.min(...premiums);
    const trend  = calcTrend(premiums);

    setAILoading(true);
    setAIError(false);
    getPremiumAIAnalysis({ current, avg7d, high7d, low7d, trend, refSource, btcPrice: cbPrice })
      .then(result => {
        if (result) setAI(result);
        else setAIError(true);
        setAILoading(false);
      });
  }, [histLoading, current]);   // eslint-disable-line react-hooks/exhaustive-deps

  const pctColor = current === null ? "#888" : current >= 0 ? "#22c55e" : "#fb7185";

  return (
    <div className="cbp-card">
      {/* ── Header ── */}
      <div className="cbp-header">
        <div>
          <div className="cbp-title">Coinbase Premium Index</div>
          <div className="cbp-sub">
            — Price USD &nbsp;·&nbsp;
            <span style={{ color: "#22c55e" }}>■</span>/<span style={{ color: "#fb7185" }}>■</span>
            {" "}Premium (Coinbase vs {refSource})
          </div>
        </div>
        <div className="cbp-current" style={{ color: pctColor }}>
          {current === null
            ? (liveError ? "N/A" : "—")
            : `${current >= 0 ? "+" : ""}${current.toFixed(4)}%`}
        </div>
      </div>

      {/* ── Chart ── */}
      {histLoading && <div className="cbp-placeholder">{t("coinbase.loading")}</div>}
      <div
        ref={containerRef}
        className="cbp-chart-container"
        style={{ opacity: histLoading ? 0 : 1, height: histLoading ? 0 : undefined }}
      />

      {/* ── Static explanation ── */}
      {!histLoading && (
        <div className="cbp-explainer">
          <div className="cbp-explainer-title">{t("coinbase.explainer.title")}</div>
          <p className="cbp-explainer-text">{t("coinbase.explainer.body")}</p>
        </div>
      )}

      {/* ── AI Analysis ── */}
      {!histLoading && (
        <div className="cbp-ai">
          <div className="cbp-ai-title-row">
            <span className="cbp-ai-logo">✦</span>
            <span className="cbp-ai-title">AI Analysis</span>
            <span className="pattern-insight-ai-badge">✦ AI Powered</span>
            {ai && (() => {
              const s = SENTIMENT_CFG[ai.sentiment];
              return <span className="cbp-ai-badge" style={{ color: s.color, background: s.bg }}>{t(s.tKey)}</span>;
            })()}
          </div>

          {exceeded && (
            <AIQuotaWall used={used} limit={limit} onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth} />
          )}

          {!exceeded && aiLoading && (
            <div className="cbp-ai-loading">
              <span className="cbp-ai-spinner" />
              Analysing premium data…
            </div>
          )}

          {!exceeded && aiError && !aiLoading && (
            <div className="cbp-ai-error">Unable to generate AI analysis</div>
          )}

          {!exceeded && ai && !aiLoading && (
            <>
              <p className="cbp-ai-summary">{ai.summary}</p>

              <div className="cbp-ai-signals">
                {ai.signals.map(sig => (
                  <div key={sig.label} className="cbp-ai-signal">
                    <div className="cbp-ai-signal-top">
                      <span className={`cbp-ai-signal-indicator ${sig.bullish ? "bull" : "bear"}`}>
                        {sig.bullish ? "↑" : "↓"}
                      </span>
                      <span className="cbp-ai-signal-label">{sig.label}</span>
                      <span className="cbp-ai-signal-value">{sig.value}</span>
                    </div>
                    <p className="cbp-ai-signal-text">{sig.interpretation}</p>
                  </div>
                ))}
              </div>

              <div className="cbp-ai-outlook">
                <span className="cbp-ai-outlook-label">Outlook</span>
                <p className="cbp-ai-outlook-text">{ai.outlook}</p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
