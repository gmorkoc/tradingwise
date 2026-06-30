import { useState, useEffect, useRef, useCallback } from "react";
import { createChart, IChartApi, ISeriesApi, CandlestickData, ColorType, CandlestickSeries } from "lightweight-charts";
import { COINS, coinglass, fetchCoinMarketCaps, fetchCoin24hTickers, fetchCoinChanges24h, fetchFundingRate, CandleDataPoint, CoinSnapshot } from "../services/coinglass";
import { getAltPricePrediction, AltPricePrediction } from "../services/openai";
import { AIQuotaWall } from "./AIQuotaWall";
import { useAuth } from "../contexts/AuthContext";
import { useAIQuota } from "../hooks/useAIQuota";
import "../styles/AltAnalysis.css";

interface Props {
  onOpenUpgrade: () => void;
  onOpenAuth: () => void;
}

type Timeframe = "1W" | "1M" | "3M" | "6M" | "1Y" | "ALL";

const SECTOR_MAP: Record<string, string> = {
  BTC: "Store of Value", ETH: "Layer 1", BNB: "Layer 1", SOL: "Layer 1",
  XRP: "Payments", ADA: "Layer 1", AVAX: "Layer 1", DOT: "Layer 1",
  ATOM: "Interoperability", TRX: "Layer 1", ETC: "PoW", LTC: "PoW",
  BCH: "PoW", NEAR: "Layer 1", ICP: "Layer 1", FIL: "Storage",
  AR: "Storage", TIA: "Modular", EGLD: "Layer 1", APT: "Layer 1",
  SUI: "Layer 1", STX: "Bitcoin L2", CFX: "Layer 1", DASH: "PoW",
  ZEC: "Privacy", XLM: "Payments", LINK: "Oracle", UNI: "DeFi",
  AAVE: "DeFi", CRV: "DeFi", INJ: "DeFi", ENS: "DeFi", COMP: "DeFi",
  LDO: "DeFi", DYDX: "DeFi", SNX: "DeFi", YFI: "DeFi", UMA: "DeFi",
  TRB: "Oracle", LPT: "Media", NMR: "AI / Data", KSM: "Layer 1",
  SSV: "DeFi", OP: "Layer 2", ARB: "Layer 2", HYPE: "DEX",
  TAO: "AI", WLD: "AI", RENDER: "AI", VIRTUAL: "AI", GRASS: "AI",
  ORDI: "BTC Ecosystem", BERA: "Layer 1", ENA: "DeFi", JTO: "DeFi",
  ONDO: "RWA", DOGE: "Meme", SHIB: "Meme", PEPE: "Meme", FLOKI: "Meme",
  BONK: "Meme", WIF: "Meme", TRUMP: "Meme", MEME: "Meme", BOME: "Meme",
  NOT: "Meme", GALA: "Gaming", CHZ: "Gaming", APE: "Gaming",
  AXS: "Gaming", SAND: "Gaming", MANA: "Gaming", ENJ: "Gaming",
  AUCTION: "DeFi", ZEN: "Privacy",
};

const SECTOR_COLORS: Record<string, string> = {
  "Layer 1": "#38bdf8", "Layer 2": "#818cf8", "DeFi": "#4ade80",
  "AI": "#a78bfa", "Meme": "#fb923c", "Gaming": "#f472b6",
  "Storage": "#facc15", "Oracle": "#2dd4bf", "Payments": "#60a5fa",
  "Privacy": "#94a3b8", "PoW": "#a8a29e", "RWA": "#34d399",
  "BTC Ecosystem": "#f59e0b", "Interoperability": "#e879f9",
  "Bitcoin L2": "#fbbf24", "Modular": "#67e8f9", "Store of Value": "#f97316",
  "Media": "#c084fc", "AI / Data": "#a78bfa", "DEX": "#22d3ee",
};

const TF_INTERVAL: Record<Timeframe, string> = {
  "1W": "4hour", "1M": "1day", "3M": "1day", "6M": "1day", "1Y": "1week", "ALL": "all",
};
const TF_LIMIT: Record<Timeframe, number> = {
  "1W": 42, "1M": 30, "3M": 90, "6M": 180, "1Y": 52, "ALL": 9999,
};

function fmt(n: number, digits = 2) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
}

function fmtPrice(p: number) {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1)    return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}

export function AltAnalysis({ onOpenUpgrade, onOpenAuth }: Props) {
  const { tier } = useAuth();
  const { used, limit } = useAIQuota();
  const isPaid = tier === "elite";

  const [query, setQuery]         = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [coin, setCoin]           = useState<typeof COINS[number]>(COINS.find(c => c.symbol === "ETH") ?? COINS[1]);
  const [tf, setTf]               = useState<Timeframe>("1Y");
  const [candles, setCandles]     = useState<CandleDataPoint[]>([]);
  const [price, setPrice]         = useState(0);
  const [change24h, setChange24h] = useState(0);
  const [marketCap, setMarketCap] = useState(0);
  const [loadingChart, setLoadingChart] = useState(false);
  const [btcCloses, setBtcCloses]       = useState<number[]>([]);
  const [fundingRate, setFundingRate]   = useState<number | null>(null);
  const [analysis, setAnalysis]   = useState<AltPricePrediction | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError]     = useState("");
  const [allChanges, setAllChanges] = useState<Map<string, CoinSnapshot>>(new Map());

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<IChartApi | null>(null);
  const seriesRef         = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";

  const sector     = SECTOR_MAP[coin.symbol] ?? "Other";
  const sectorColor = SECTOR_COLORS[sector] ?? "#818cf8";

  const filtered = COINS.filter(c =>
    c.symbol !== "BTC" && (
      query.length === 0 ||
      c.symbol.toLowerCase().includes(query.toLowerCase()) ||
      c.name.toLowerCase().includes(query.toLowerCase())
    )
  ).slice(0, 20);

  // Load chart candles
  const loadCandles = useCallback(async (c: typeof coin, timeframe: Timeframe) => {
    setLoadingChart(true);
    try {
      const interval = TF_INTERVAL[timeframe];
      const data = await coinglass.getHistoricalCandles(interval as any, c.symbol);
      const limit = TF_LIMIT[timeframe];
      setCandles(data.slice(-limit));
      if (data.length) setPrice(data[data.length - 1].close);
    } finally {
      setLoadingChart(false);
    }
  }, []);

  // Load metrics
  const loadMetrics = useCallback(async (c: typeof coin) => {
    const [caps, tickers] = await Promise.allSettled([
      fetchCoinMarketCaps(),
      fetchCoin24hTickers(COINS),
    ]);
    if (caps.status === "fulfilled") {
      setMarketCap(caps.value.get(c.symbol) ?? 0);
    }
    if (tickers.status === "fulfilled") {
      const tick = tickers.value.get(c.symbol);
      if (tick) {
        setChange24h(tick.change);
      }
    }
  }, []);

  useEffect(() => {
    setAnalysis(null);
    setAiError("");
    loadCandles(coin, tf);
  }, [coin, tf, loadCandles]);

  useEffect(() => {
    loadMetrics(coin);
  }, [coin, loadMetrics]);

  // BTC trend context (fetch once on mount, refresh on coin change)
  useEffect(() => {
    coinglass.getHistoricalCandles('1day', 'BTC').then(data => {
      setBtcCloses(data.slice(-60).map(c => c.close));
    }).catch(() => {});
  }, []);

  // Funding rate (per coin)
  useEffect(() => {
    setFundingRate(null);
    fetchFundingRate(coin.symbol).then(setFundingRate).catch(() => {});
  }, [coin.symbol]);

  // All-coin 24h changes for winners/losers (CoinGecko, same call as market caps)
  useEffect(() => {
    fetchCoinChanges24h().then(setAllChanges).catch(() => {});
  }, []);

  // Build/update chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    if (!chartRef.current) {
      chartRef.current = createChart(chartContainerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: isDark ? "#94a3b8" : "#64748b",
        },
        grid: {
          vertLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
          horzLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
        },
        crosshair: { mode: 1 },
        rightPriceScale: { borderVisible: false },
        timeScale: { borderVisible: false, timeVisible: true },
        handleScroll: true,
        handleScale: true,
      });
      seriesRef.current = chartRef.current.addSeries(CandlestickSeries, {
        upColor: "#4ade80", downColor: "#f87171",
        borderUpColor: "#4ade80", borderDownColor: "#f87171",
        wickUpColor: "#4ade80", wickDownColor: "#f87171",
      });
    }

    const obs = new ResizeObserver(() => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    });
    obs.observe(chartContainerRef.current);
    return () => obs.disconnect();
  }, [isDark]);

  useEffect(() => {
    if (!seriesRef.current || !candles.length) return;
    const data: CandlestickData[] = candles.map(c => ({
      time: (c.time / 1000) as any,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  const handleSelectCoin = (c: typeof COINS[number]) => {
    setCoin(c);
    setQuery("");
    setShowDropdown(false);
  };

  const detectCandlePattern = (cs: CandleDataPoint[]): string => {
    if (cs.length < 3) return "insufficient data";
    const [c3, c2, c1] = cs.slice(-3);
    const body1 = Math.abs(c1.close - c1.open);
    const range1 = c1.high - c1.low || 0.0001;
    const upper1 = c1.high - Math.max(c1.close, c1.open);
    const lower1 = Math.min(c1.close, c1.open) - c1.low;
    const body2 = Math.abs(c2.close - c2.open);
    const range2 = c2.high - c2.low || 0.0001;
    const body3 = Math.abs(c3.close - c3.open);

    if (body1 / range1 < 0.1) return "Doji — market at equilibrium, indecision";
    if (lower1 > body1 * 2 && upper1 < body1 * 0.5 && c1.close >= c1.open)
      return "Hammer — buyers rejected lower prices, bullish reversal signal";
    if (upper1 > body1 * 2 && lower1 < body1 * 0.5 && c1.close <= c1.open)
      return "Shooting Star — sellers rejected higher prices, bearish reversal signal";
    if (c2.close < c2.open && c1.close > c1.open && c1.open <= c2.close && c1.close >= c2.open)
      return "Bullish Engulfing — buyers overwhelmed sellers, strong reversal";
    if (c2.close > c2.open && c1.close < c1.open && c1.open >= c2.close && c1.close <= c2.open)
      return "Bearish Engulfing — sellers overwhelmed buyers, strong reversal";
    if (c3.close < c3.open && body3 > range2 * 0.4 && body2 / range2 < 0.3
        && c1.close > c1.open && c1.close > (c3.open + c3.close) / 2)
      return "Morning Star — 3-candle bullish reversal, buyers took control";
    if (c3.close > c3.open && body3 > range2 * 0.4 && body2 / range2 < 0.3
        && c1.close < c1.open && c1.close < (c3.open + c3.close) / 2)
      return "Evening Star — 3-candle bearish reversal, sellers took control";
    if (c1.close > c1.open && body1 / range1 > 0.7)
      return "Strong bullish candle — full-body close, buyers fully in control";
    if (c1.close < c1.open && body1 / range1 > 0.7)
      return "Strong bearish candle — full-body close, sellers fully in control";
    return c1.close > c1.open ? "Mild bullish candle" : "Mild bearish candle";
  };

  const buildTechnicalSummary = () => {
    if (candles.length < 10) return null;

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume ?? 0);

    // Period range
    const periodHigh  = Math.max(...highs);
    const periodLow   = Math.min(...lows);
    const priceRange  = periodHigh - periodLow;
    const pctFromHigh = ((price - periodHigh) / periodHigh) * 100;
    const pctFromLow  = ((price - periodLow)  / periodLow)  * 100;
    const posInRange  = priceRange > 0 ? ((price - periodLow) / priceRange) * 100 : 50;

    // Recent momentum: last 5 vs previous 5 closes
    const recentAvg   = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const previousAvg = closes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    const momentum    = ((recentAvg - previousAvg) / previousAvg) * 100;

    // MAs
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
    const ma50 = closes.length >= 50
      ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50
      : closes.reduce((a, b) => a + b, 0) / closes.length;

    // RSI and MACD using existing coinglass implementations
    const rsi  = coinglass.calculateRSI(closes);
    const macd = coinglass.calculateMACD(closes);

    // Volatility
    const avgRange     = candles.slice(-20).reduce((a, c) => a + (c.high - c.low), 0) / 20;
    const volatilityPct = (avgRange / price) * 100;

    // Consecutive up/down streak
    let streak = 0;
    for (let i = closes.length - 1; i > 0; i--) {
      if (closes[i] > closes[i - 1]) { if (streak >= 0) streak++; else break; }
      else                            { if (streak <= 0) streak--; else break; }
    }

    // Volume trend: recent 5 vs previous 5 average volume
    const hasVolume    = volumes.some(v => v > 0);
    const recentVol    = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const previousVol  = volumes.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
    const volumeTrend  = hasVolume && previousVol > 0
      ? ((recentVol - previousVol) / previousVol) * 100
      : null;

    // Higher highs / lower lows pattern (last 10 vs prior 10)
    const recentHigh = Math.max(...highs.slice(-10));
    const prevHigh   = Math.max(...highs.slice(-20, -10));
    const recentLow  = Math.min(...lows.slice(-10));
    const prevLow    = Math.min(...lows.slice(-20, -10));
    const hhhl = recentHigh > prevHigh && recentLow > prevLow ? "higher highs + higher lows (bullish structure)"
               : recentHigh < prevHigh && recentLow < prevLow ? "lower highs + lower lows (bearish structure)"
               : "mixed structure (no clear trend)";

    // BTC trend context
    let btcTrend = "BTC data unavailable";
    if (btcCloses.length >= 20) {
      const btcMa20 = btcCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const btcMa50 = btcCloses.length >= 50
        ? btcCloses.slice(-50).reduce((a, b) => a + b, 0) / 50
        : btcCloses.reduce((a, b) => a + b, 0) / btcCloses.length;
      const btcPrice = btcCloses[btcCloses.length - 1];
      const btcRsi   = coinglass.calculateRSI(btcCloses);
      btcTrend = btcPrice > btcMa20 && btcPrice > btcMa50
        ? `BTC above MA20 (${fmtPrice(btcMa20)}) and MA50 (${fmtPrice(btcMa50)}) — bullish macro (RSI ${btcRsi})`
        : btcPrice < btcMa20 && btcPrice < btcMa50
        ? `BTC below MA20 (${fmtPrice(btcMa20)}) and MA50 (${fmtPrice(btcMa50)}) — bearish macro (RSI ${btcRsi})`
        : `BTC between MA20 (${fmtPrice(btcMa20)}) and MA50 (${fmtPrice(btcMa50)}) — neutral macro (RSI ${btcRsi})`;
    }

    // Funding rate interpretation
    let fundingContext = "Funding rate unavailable";
    if (fundingRate !== null) {
      const pct = (fundingRate * 100).toFixed(4);
      fundingContext = fundingRate > 0.0002
        ? `+${pct}% (very high positive — overleveraged longs, bearish contrarian signal)`
        : fundingRate > 0.0001
        ? `+${pct}% (elevated positive — longs dominant, slight bearish lean)`
        : fundingRate < -0.0001
        ? `${pct}% (negative — shorts dominant, potential short squeeze)`
        : `${pct}% (neutral)`;
    }

    const trend = price > ma50
      ? (price > ma20 ? "above MA20 and MA50 (uptrend)" : "below MA20 but above MA50 (weakening)")
      : (price > ma20 ? "above MA20 but below MA50 (recovery attempt)" : "below MA20 and MA50 (downtrend)");

    // ── Current price action from chart ──────────────────────────────────────
    const candlePattern = detectCandlePattern(candles);

    const last = candles[candles.length - 1];
    const lastRange = last.high - last.low || 0.0001;
    const lastUpper = last.high - Math.max(last.close, last.open);
    const lastLower = Math.min(last.close, last.open) - last.low;
    const upperPct  = (lastUpper / lastRange * 100).toFixed(0);
    const lowerPct  = (lastLower / lastRange * 100).toFixed(0);
    let wickAnalysis = "";
    if (parseInt(upperPct) > 35) wickAnalysis += `Upper wick ${upperPct}% of range (sellers rejecting highs). `;
    if (parseInt(lowerPct) > 35) wickAnalysis += `Lower wick ${lowerPct}% of range (buyers rejecting lows). `;
    if (!wickAnalysis) wickAnalysis = `Balanced candle — upper wick ${upperPct}%, lower wick ${lowerPct}% of range.`;

    const recentCandles = candles.slice(-6).map((c, i, arr) => {
      const dir = c.close >= c.open ? "▲" : "▼";
      const chg = ((c.close - c.open) / c.open * 100).toFixed(2);
      const label = i === arr.length - 1 ? " ← current" : "";
      return `  O:${fmtPrice(c.open)} H:${fmtPrice(c.high)} L:${fmtPrice(c.low)} C:${fmtPrice(c.close)} ${dir}${chg}%${label}`;
    }).join("\n");

    return {
      periodHigh:    fmtPrice(periodHigh),
      periodLow:     fmtPrice(periodLow),
      posInRange:    posInRange.toFixed(0),
      pctFromHigh:   pctFromHigh.toFixed(1),
      pctFromLow:    pctFromLow.toFixed(1),
      momentum:      momentum.toFixed(2),
      ma20:          fmtPrice(ma20),
      ma50:          fmtPrice(ma50),
      trend,
      volatilityPct: volatilityPct.toFixed(2),
      streak,
      candleCount:   candles.length,
      rsi:           rsi.toFixed(1),
      macdHistogram: macd.histogram.toFixed(4),
      macdSignal:    macd.histogram > 0 ? "bullish crossover" : "bearish crossover",
      volumeTrend:   volumeTrend !== null ? volumeTrend.toFixed(1) : null,
      hhhl,
      btcTrend,
      fundingContext,
      candlePattern,
      wickAnalysis,
      recentCandles,
    };
  };

  const handleGenerate = async () => {
    setAiLoading(true);
    setAiError("");
    const techSummary = buildTechnicalSummary();
    const res = await getAltPricePrediction(
      coin.symbol, coin.name, sector, price, change24h,
      marketCap / 1e9, tf, techSummary,
    );
    if (res.success && res.result) setAnalysis(res.result);
    else setAiError(res.error ?? "Prediction failed");
    setAiLoading(false);
  };

  const isUp = change24h >= 0;

  const sortedByChange = COINS
    .filter(c => allChanges.has(c.symbol))
    .map(c => ({ ...c, ...allChanges.get(c.symbol)! }))
    .sort((a, b) => b.change - a.change);
  const winners = sortedByChange.slice(0, 10);
  const losers  = sortedByChange.slice(-10).reverse();

  return (
    <div className="alt-root" style={{ "--sector-color": sectorColor } as React.CSSProperties}>

      {/* ── Hero header ── */}
      <div className="alt-hero" style={{ borderColor: `${sectorColor}40`, background: `linear-gradient(135deg, color-mix(in srgb, ${sectorColor} 8%, var(--color-card-bg)), var(--color-card-bg))` }}>

        <div className="alt-hero-left">
          {/* search */}
          <div className="alt-search-wrap">
            <button className="alt-search-trigger" onClick={() => setShowDropdown(v => !v)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <span>{coin.symbol}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            {showDropdown && (
              <div className="alt-dropdown">
                <div className="alt-dropdown-search">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  <input
                    className="alt-search-input"
                    placeholder="Search coin…"
                    value={query}
                    autoFocus
                    onChange={e => setQuery(e.target.value)}
                    onBlur={() => setTimeout(() => { setShowDropdown(false); setQuery(""); }, 150)}
                  />
                </div>
                {filtered.map(c => (
                  <button key={c.symbol} className="alt-dropdown-item" onMouseDown={() => handleSelectCoin(c)}>
                    <span className="alt-dd-symbol" style={{ color: SECTOR_COLORS[SECTOR_MAP[c.symbol] ?? ""] ?? "#818cf8" }}>{c.symbol}</span>
                    <span className="alt-dd-name">{c.name}</span>
                    <span className="alt-dd-sector" style={{ color: SECTOR_COLORS[SECTOR_MAP[c.symbol] ?? ""] ?? "#818cf8" }}>
                      {SECTOR_MAP[c.symbol] ?? "Other"}
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && <div className="alt-dd-empty">No coins found</div>}
              </div>
            )}
          </div>

          {/* coin identity */}
          <div className="alt-hero-identity">
            <h1 className="alt-hero-symbol" style={{ color: sectorColor }}>{coin.symbol}</h1>
            <span className="alt-hero-name">{coin.name}</span>
            <span className="alt-sector-pill" style={{ background: `${sectorColor}20`, color: sectorColor, borderColor: `${sectorColor}50` }}>
              {sector}
            </span>
          </div>
        </div>

        <div className="alt-hero-right">
          <div className="alt-hero-price-block">
            <span className="alt-hero-price">{price ? fmtPrice(price) : "—"}</span>
            <span className={`alt-hero-change ${isUp ? "alt-pos" : "alt-neg"}`}>
              <span className="alt-change-arrow">{isUp ? "▲" : "▼"}</span>
              {Math.abs(change24h).toFixed(2)}%
            </span>
          </div>
          <div className="alt-hero-stats">
            <div className="alt-hero-stat">
              <span className="alt-hero-stat-label">Market Cap</span>
              <span className="alt-hero-stat-val">{marketCap ? fmt(marketCap) : "—"}</span>
            </div>
            <div className="alt-hero-stat-divider" />
            <div className="alt-hero-stat">
              <span className="alt-hero-stat-label">Sector Rank</span>
              <span className="alt-hero-stat-val">{sector}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Long-Term Analysis (chart + AI unified) ── */}
      <div className="alt-ai-section">

        {/* section header */}
        <div className="alt-ai-header" style={{ borderBottomColor: `${sectorColor}30`, background: `linear-gradient(90deg, color-mix(in srgb, ${sectorColor} 10%, transparent), transparent)` }}>
          <span className="alt-ai-badge">AI</span>
          <div className="alt-ai-header-text">
            <span className="alt-ai-title">Long-Term Analysis</span>
            <span className="alt-ai-subtitle">{coin.name} · {{ "1W": "1 Week", "1M": "1 Month", "3M": "3 Month", "6M": "6 Month", "1Y": "12 Month", "ALL": "Long Term" }[tf]} Price Prediction</span>
          </div>
          <div className="alt-ai-header-right">
            <span className="aiqw-live-badge"><span className="aiqw-live-dot" />LIVE</span>
          </div>
        </div>

        {/* ── Chart + Signals side by side ── */}
        <div className="alt-chart-signals-row" style={{ borderBottomColor: `${sectorColor}25` }}>

          {/* 80% chart */}
          <div className="alt-chart-inner">
            <div className="alt-chart-header">
              <div className="alt-chart-pair">
                <span className="alt-chart-base" style={{ color: sectorColor }}>{coin.symbol}</span>
                <span className="alt-chart-quote">/USDT</span>
                {loadingChart && <span className="alt-loading-dot" />}
              </div>
              <div className="alt-tf-row">
                {(["1W", "1M", "3M", "6M", "1Y", "ALL"] as Timeframe[]).map(t => (
                  <button
                    key={t}
                    className={`alt-tf-btn${tf === t ? " active" : ""}`}
                    style={tf === t ? { background: sectorColor, borderColor: sectorColor, color: "#fff" } : {}}
                    onClick={() => setTf(t)}
                  >{t}</button>
                ))}
              </div>
            </div>
            <div className="alt-chart-container" ref={chartContainerRef} style={{ height: 380 }} />
          </div>

          {/* 20% signals panel */}
          <div className="alt-signal-panel">
            <div className="alt-signal-panel-title">Signals used</div>
            <div className="alt-signal-list">
              {([
                { n: 1, tag: "RSI (14)",       desc: "Overbought >70 / oversold <30",          color: "#f59e0b", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 12 Q5 4 8 12 Q11 20 14 12 Q17 4 20 12"/><line x1="2" y1="7" x2="22" y2="7" strokeDasharray="2 2" strokeWidth="1"/><line x1="2" y1="17" x2="22" y2="17" strokeDasharray="2 2" strokeWidth="1"/></svg> },
                { n: 2, tag: "MACD",            desc: "12/26/9 EMA crossover momentum",         color: "#818cf8", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 18 Q7 6 12 10 Q17 14 22 4"/><path d="M2 14 Q7 10 12 12 Q17 14 22 10" strokeDasharray="3 2"/></svg> },
                { n: 3, tag: "MA20 / MA50",     desc: "Short & mid-term averages",              color: "#38bdf8", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 16 Q6 8 12 11 Q18 14 22 7"/><path d="M2 19 Q6 14 12 15 Q18 16 22 12" strokeDasharray="3 2"/></svg> },
                { n: 4, tag: "Price Structure", desc: "Higher highs/lows, range pos",           color: "#34d399", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="3" x2="8" y2="6"/><rect x="6" y="6" width="4" height="6" rx="0.5"/><line x1="8" y1="12" x2="8" y2="15"/><line x1="16" y1="6" x2="16" y2="8"/><rect x="14" y="8" width="4" height="7" rx="0.5"/><line x1="16" y1="15" x2="16" y2="18"/></svg> },
                { n: 5, tag: "Momentum",        desc: "5-candle streak + momentum",             color: "#fb923c", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
                { n: 6, tag: "Volume",          desc: "Rising/falling confirmation",            color: "#a78bfa", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="14" width="4" height="7" rx="0.5"/><rect x="10" y="9" width="4" height="12" rx="0.5"/><rect x="17" y="5" width="4" height="16" rx="0.5"/></svg> },
                { n: 7, tag: "BTC Macro",       desc: "Bitcoin MA/RSI context",                color: "#f97316", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 8h4.5a2 2 0 0 1 0 4H9v4h5a2 2 0 0 0 0-4"/><line x1="9" y1="8" x2="9" y2="16"/><line x1="10.5" y1="6" x2="10.5" y2="8"/><line x1="13.5" y1="6" x2="13.5" y2="8"/><line x1="10.5" y1="16" x2="10.5" y2="18"/><line x1="13.5" y1="16" x2="13.5" y2="18"/></svg> },
                { n: 8, tag: "Funding Rate",    desc: "8h Binance perp signal",                color: "#f43f5e", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="19" x2="19" y2="5"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/></svg> },
                { n: 9, tag: "4Y Cycle",        desc: "Halving phase weighting",               color: "#2dd4bf", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="14"/></svg> },
              ] as { n: number; tag: string; desc: string; color: string; icon: React.ReactNode }[]).map(({ n, tag, desc, color, icon }) => (
                <div key={tag} className="alt-signal-row">
                  <span className="alt-signal-num">{n}</span>
                  <span className="alt-signal-icon" style={{ color }}>{icon}</span>
                  <div className="alt-signal-text">
                    <span className="alt-signal-name">{tag}</span>
                    <span className="alt-signal-desc">{desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* AI content */}
        {!isPaid ? (
          <AIQuotaWall
            used={used} limit={limit}
            onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth}
            planId="elite"
            featureTitle="Long-Term AI Analysis"
            featureDesc="AI-generated investment thesis, catalysts, risks & outlook for any altcoin."
          />
        ) : !analysis ? (
          <div className="alt-ai-generate">
            <div className="alt-ai-generate-icon" style={{ color: sectorColor, borderColor: `${sectorColor}40`, background: `${sectorColor}12` }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            </div>
            <p className="alt-ai-generate-hint">Get a bold price prediction for <strong>{coin.name}</strong></p>
            <p className="alt-ai-generate-sub">Target price · Direction · Entry zone · Stop loss · Key levels</p>
            {aiError && <p className="alt-ai-error">{aiError}</p>}
            <button
              className="alt-ai-generate-btn"
              style={{ background: `linear-gradient(135deg, ${sectorColor}cc, ${sectorColor})` }}
              onClick={handleGenerate}
              disabled={aiLoading || !price}
            >
              {aiLoading ? "Analyzing…" : `Analyze ${coin.symbol}`}
            </button>
          </div>
        ) : (
          <div className="alt-ai-result">

            {/* ── Hero prediction row ── */}
            <div className="alt-pred-hero" style={{ borderColor: `${sectorColor}30`, background: `color-mix(in srgb, ${sectorColor} 6%, var(--color-hover))` }}>
              <div className="alt-pred-direction">
                <span className={`alt-pred-arrow ${analysis.direction === "bullish" ? "alt-pos" : analysis.direction === "bearish" ? "alt-neg" : "alt-neutral"}`}>
                  {analysis.direction === "bullish" ? "▲" : analysis.direction === "bearish" ? "▼" : "◆"}
                </span>
                <div>
                  <div className={`alt-pred-label ${analysis.direction === "bullish" ? "alt-pos" : analysis.direction === "bearish" ? "alt-neg" : "alt-neutral"}`}>
                    {analysis.direction.toUpperCase()}
                  </div>
                  <div className="alt-pred-horizon">{{ "1W": "1 Week", "1M": "1 Month", "3M": "3 Months", "6M": "6 Months", "1Y": "12 Months", "ALL": "Long Term" }[tf]} Target</div>
                </div>
              </div>

              <div className="alt-pred-target">
                <span className="alt-pred-target-price">{fmtPrice(analysis.targetPrice)}</span>
                <span className={`alt-pred-target-pct ${analysis.targetChange >= 0 ? "alt-pos" : "alt-neg"}`}>
                  {analysis.targetChange >= 0 ? "+" : ""}{analysis.targetChange.toFixed(1)}%
                </span>
              </div>

              <div className="alt-pred-confidence">
                <span className="alt-pred-conf-label">Confidence</span>
                <span className={`alt-pred-conf-badge alt-pred-conf--${analysis.confidence}`}>
                  {analysis.confidence.toUpperCase()}
                </span>
              </div>
            </div>

            {/* ── Summary ── */}
            <p className="alt-pred-summary" style={{ borderLeftColor: sectorColor }}>{analysis.summary}</p>

            {/* ── Trade levels + reasons ── */}
            <div className="alt-pred-grid">
              <div className="alt-pred-levels">
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">Entry Zone</span>
                  <span className="alt-pred-level-val">{analysis.entryZone}</span>
                </div>
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">Stop Loss</span>
                  <span className="alt-pred-level-val alt-neg">{analysis.stopLoss}</span>
                </div>
                <div className="alt-pred-level-divider" />
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">Support</span>
                  <span className="alt-pred-level-val alt-pos">{analysis.supports.join(" / ")}</span>
                </div>
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">Resistance</span>
                  <span className="alt-pred-level-val alt-neg">{analysis.resistances.join(" / ")}</span>
                </div>
              </div>

              <div className="alt-pred-reasons">
                <div className="alt-pred-reasons-title">Why</div>
                <ul className="alt-ai-list">
                  {analysis.reasons.map((r, i) => (
                    <li key={i}>
                      <span className={analysis.direction === "bearish" ? "alt-x" : "alt-check"}>
                        {analysis.direction === "bearish" ? "▼" : "▲"}
                      </span>
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* ── Reasoning ── */}
            <div className="alt-reasoning">
              <div className="alt-reasoning-label">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                Why this prediction
              </div>
              <p className="alt-reasoning-text">{analysis.reasoning}</p>
            </div>

            <button className="alt-regenerate-btn" onClick={handleGenerate} disabled={aiLoading}>
              {aiLoading ? "Analyzing…" : "↺ Regenerate"}
            </button>

            {/* ── DYOR disclaimer ── */}
            <p className="alt-disclaimer">
              ⚠ This is AI-generated analysis based on technical indicators — not financial advice. Always do your own research (DYOR) before making any investment decisions.
            </p>
          </div>
        )}
      </div>

      {/* ── Winners & Losers ── */}
      <div className="alt-wl-section">
        <div className="alt-wl-header">
          <span className="alt-wl-title">24h Winners &amp; Losers</span>
          {sortedByChange.length > 0 && (
            <span className="alt-wl-sub">Top movers across {sortedByChange.length} alts</span>
          )}
        </div>
        {sortedByChange.length === 0 ? (
          <div className="alt-wl-loading">Loading market data…</div>
        ) : (
          <div className="alt-wl-columns">

            {/* Winners */}
            <div className="alt-wl-col">
              <div className="alt-wl-col-header alt-wl-col-header--win">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                Winners
              </div>
              {winners.map((c, i) => {
                const color = SECTOR_COLORS[SECTOR_MAP[c.symbol] ?? ""] ?? "#818cf8";
                return (
                  <button key={c.symbol} className="alt-wl-row" onClick={() => handleSelectCoin(c)}>
                    <span className="alt-wl-rank">{i + 1}</span>
                    <span className="alt-wl-dot" style={{ background: color }} />
                    <span className="alt-wl-symbol" style={{ color }}>{c.symbol}</span>
                    <span className="alt-wl-name">{c.name}</span>
                    <span className="alt-wl-price">{fmtPrice(c.price)}</span>
                    <span className="alt-wl-change alt-pos">+{c.change.toFixed(2)}%</span>
                  </button>
                );
              })}
            </div>

            {/* Losers */}
            <div className="alt-wl-col">
              <div className="alt-wl-col-header alt-wl-col-header--lose">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                Losers
              </div>
              {losers.map((c, i) => {
                const color = SECTOR_COLORS[SECTOR_MAP[c.symbol] ?? ""] ?? "#818cf8";
                return (
                  <button key={c.symbol} className="alt-wl-row" onClick={() => handleSelectCoin(c)}>
                    <span className="alt-wl-rank">{i + 1}</span>
                    <span className="alt-wl-dot" style={{ background: color }} />
                    <span className="alt-wl-symbol" style={{ color }}>{c.symbol}</span>
                    <span className="alt-wl-name">{c.name}</span>
                    <span className="alt-wl-price">{fmtPrice(c.price)}</span>
                    <span className="alt-wl-change alt-neg">{c.change.toFixed(2)}%</span>
                  </button>
                );
              })}
            </div>

          </div>
        )}
      </div>

    </div>
  );
}
