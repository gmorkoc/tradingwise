import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  createChart, IChartApi, ISeriesApi, ColorType, CandlestickSeries, HistogramSeries,
} from "lightweight-charts";
import {
  searchStocks, fetchStockCandles, hasStockApiKey,
  type StockSearchResult, type StockCandle, type StockInterval,
} from "../services/twelvedata";
import "../styles/StockChart.css";

interface Props {
  theme: "dark" | "light";
}

const INTERVALS: { label: string; value: StockInterval }[] = [
  { label: "5m", value: "5min" },
  { label: "15m", value: "15min" },
  { label: "1H", value: "1h" },
  { label: "4H", value: "4h" },
  { label: "1D", value: "1day" },
  { label: "1W", value: "1week" },
];

const DEFAULT_SYMBOL = { symbol: "AAPL", name: "Apple Inc." };

function fmtPrice(p: number): string {
  return p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function StockChart({ theme }: Props) {
  const { t } = useTranslation();
  const [symbol, setSymbol] = useState<string>(() => localStorage.getItem("stockSymbol") ?? DEFAULT_SYMBOL.symbol);
  const [symbolName, setSymbolName] = useState<string>(() => localStorage.getItem("stockSymbolName") ?? DEFAULT_SYMBOL.name);
  const [interval, setInterval_] = useState<StockInterval>("1day");
  const [candles, setCandles] = useState<StockCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const isDark = theme === "dark";

  useEffect(() => {
    localStorage.setItem("stockSymbol", symbol);
    localStorage.setItem("stockSymbolName", symbolName);
  }, [symbol, symbolName]);

  // ── Symbol search ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (search.trim().length < 1) { setSearchResults([]); return; }
    let cancelled = false;
    const id = window.setTimeout(async () => {
      const results = await searchStocks(search);
      if (!cancelled) setSearchResults(results);
    }, 300);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [search]);

  useEffect(() => {
    if (!searchOpen) return;
    const handle = (e: MouseEvent) => {
      if (!searchRef.current?.contains(e.target as Node)) {
        setSearchOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [searchOpen]);

  const selectSymbol = (r: StockSearchResult) => {
    setSymbol(r.symbol);
    setSymbolName(r.name);
    setSearchOpen(false);
    setSearch("");
  };

  // ── Fetch candles ──────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    const { candles: data, error: err } = await fetchStockCandles(symbol, interval);
    setCandles(data);
    setError(err);
    setLoading(false);
  }, [symbol, interval]);

  useEffect(() => { load(); }, [load]);

  // ── Build chart (once) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
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
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
      width: chartContainerRef.current.clientWidth,
      height: 460,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e", downColor: "#ef4444",
      borderUpColor: "#22c55e", borderDownColor: "#ef4444",
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    });

    const volSeries = chart.addSeries(HistogramSeries, {
      color: "#38bdf840",
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volSeriesRef.current = volSeries;

    const onResize = () => {
      if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark]);

  // ── Push candle data into the chart ──────────────────────────────────────────
  useEffect(() => {
    if (!candleSeriesRef.current || !volSeriesRef.current || candles.length === 0) return;
    candleSeriesRef.current.setData(
      candles.map(c => ({ time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    volSeriesRef.current.setData(
      candles.map(c => ({
        time: c.time as never,
        value: c.volume,
        color: c.close >= c.open ? "#22c55e40" : "#ef444440",
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const pct = last && prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const up = pct >= 0;

  if (!hasStockApiKey) {
    return (
      <div className="price-chart-container">
        <div className="stock-setup-notice">
          <div className="stock-setup-icon">📈</div>
          <h3>{t("stocks.setupTitle")}</h3>
          <p>{t("stocks.setupBody")}</p>
          <code>VITE_TWELVEDATA_API_KEY</code>
        </div>
      </div>
    );
  }

  return (
    <div className="price-chart-container">
      <div className="chart-header">
        <div className="chart-header-left">
          <div className="chart-title-row">
            <div className="stock-search-wrap" ref={searchRef}>
              <button className="stock-symbol-btn" onClick={() => setSearchOpen(v => !v)}>
                <h3 className="stock-symbol">{symbol}</h3>
                <span className="stock-symbol-name">{symbolName}</span>
                <span className="stock-symbol-chevron">▾</span>
              </button>
              {searchOpen && (
                <div className="stock-dropdown">
                  <input
                    className="stock-search-input"
                    placeholder={t("stocks.searchPlaceholder")}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    autoFocus
                  />
                  <div className="stock-dropdown-list">
                    {searchResults.map(r => (
                      <button key={r.symbol} className="stock-dropdown-item" onClick={() => selectSymbol(r)}>
                        <span className="stock-dropdown-sym">{r.symbol}</span>
                        <span className="stock-dropdown-name">{r.name}</span>
                        <span className="stock-dropdown-exchange">{r.exchange}</span>
                      </button>
                    ))}
                    {search.trim().length > 0 && searchResults.length === 0 && (
                      <div className="stock-dropdown-empty">{t("stocks.noResults")}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {last && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span className="day-hl-badge">
                <span className="stock-price">${fmtPrice(last.close)}</span>
                <span className="day-hl-sep"> · </span>
                <span className={`stock-pct${up ? " up" : " down"}`}>
                  {up ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
                </span>
              </span>
            </div>
          )}
        </div>

        <div className="chart-header-right">
          <div className="interval-pills">
            {INTERVALS.map(iv => (
              <button
                key={iv.value}
                className={`interval-pill${interval === iv.value ? " interval-pill--active" : ""}`}
                onClick={() => setInterval_(iv.value)}
              >
                {iv.label}
              </button>
            ))}
          </div>
          <button className="chart-fullscreen-btn" onClick={load} title={t("stocks.refresh")}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            <span className="chart-icon-label">{t("stocks.refresh")}</span>
          </button>
        </div>
      </div>

      <div className="stock-chart-wrap">
        {loading && <div className="stock-overlay">{t("stocks.loading")}</div>}
        {!loading && error && <div className="stock-overlay stock-overlay--error">{error}</div>}
        <div ref={chartContainerRef} className="stock-chart" />
      </div>
    </div>
  );
}
