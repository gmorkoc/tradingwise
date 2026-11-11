import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { createChart, IChartApi, ISeriesApi, CandlestickData, ColorType, CandlestickSeries } from "lightweight-charts";
import { COINS, coinglass, fetchCoinMarketCaps, fetchCoin24hTickers, fetchCoinChanges24h, fetchFundingRate, fetchOkxPositioning, getAllExchangeFunding, CandleDataPoint, CoinSnapshot } from "../services/coinglass";
import { getAltNarrative, AltNarrative } from "../services/openai";
import { computeAltForecast, fmtUsd, type AltForecast, type SignalKey, type Timeframe } from "../utils/altForecast";
import { AIQuotaWall } from "./AIQuotaWall";
import { RoundedCandleOverlay } from "./DrawingOverlay";
import { useAuth } from "../contexts/AuthContext";
import { useAIQuota } from "../hooks/useAIQuota";
import { BottomSheet } from "./BottomSheet";
import "../styles/AltAnalysis.css";

interface Props {
  onOpenUpgrade: () => void;
  onOpenAuth: () => void;
}

const HORIZON_EN: Record<Timeframe, string> = {
  "1W": "1 week", "1M": "1 month", "3M": "3 months", "6M": "6 months", "1Y": "12 months", "ALL": "2+ years",
};
const LANG_NAME: Record<string, string> = { en: "English", es: "Spanish", it: "Italian", tr: "Turkish" };

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

// Translation key for each (English) sector name above — the English name
// itself still goes to the AI prompt; only the on-screen label is translated.
const SECTOR_KEY: Record<string, string> = {
  "Store of Value": "storeOfValue", "Layer 1": "layer1", "Layer 2": "layer2",
  "Payments": "payments", "Interoperability": "interoperability", "PoW": "pow",
  "Storage": "storage", "Modular": "modular", "Bitcoin L2": "bitcoinL2",
  "Privacy": "privacy", "Oracle": "oracle", "DeFi": "defi", "Media": "media",
  "AI / Data": "aiData", "DEX": "dex", "AI": "ai", "BTC Ecosystem": "btcEcosystem",
  "RWA": "rwa", "Meme": "meme", "Gaming": "gaming", "Other": "other",
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
  const { t, i18n } = useTranslation();
  const sectorLabel = (s: string) => SECTOR_KEY[s] ? t(`altAnalysis2.sectors.${SECTOR_KEY[s]}`) : s;
  const { tier } = useAuth();
  const { used, limit } = useAIQuota();
  const isPaid = tier === "elite";

  const [query, setQuery]         = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  // Phones get the coin picker as a bottom sheet instead of a dropdown.
  const [isPhone, setIsPhone] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const onChange = () => setIsPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [coin, setCoin]           = useState<typeof COINS[number]>(COINS.find(c => c.symbol === "ETH") ?? COINS[1]);
  const [tf, setTf]               = useState<Timeframe>("1Y");
  const [candles, setCandles]     = useState<CandleDataPoint[]>([]);
  const [price, setPrice]         = useState(0);
  const [change24h, setChange24h] = useState(0);
  const [marketCap, setMarketCap] = useState(0);
  const [loadingChart, setLoadingChart] = useState(false);
  const [btcCloses, setBtcCloses]       = useState<number[]>([]);
  const [daily, setDaily]               = useState<CandleDataPoint[]>([]);
  const [fundingAll, setFundingAll]     = useState<Record<string, Partial<Record<string, number>>>>({});
  const [fundingSingle, setFundingSingle] = useState<number | null>(null);
  const [positioning, setPositioning]   = useState<{ oiChange7d: number | null; longShort: number | null; longShortAvg30: number | null }>({ oiChange7d: null, longShort: null, longShortAvg30: null });
  // Frozen at generate time so the shown call doesn't drift as data ticks.
  const [analysis, setAnalysis]   = useState<{ forecast: AltForecast; narrative: AltNarrative; at: Date } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError]     = useState("");
  const [allChanges, setAllChanges] = useState<Map<string, CoinSnapshot>>(new Map());

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef          = useRef<IChartApi | null>(null);
  const seriesRef         = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlayCandlesRef = useRef<{ time: number; open: number; high: number; low: number; close: number }[]>([]);
  const [chartGeneration, setChartGeneration] = useState(0);
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

  // BTC: 1 year of daily closes (macro trend + relative strength).
  useEffect(() => {
    coinglass.getHistoricalCandles('1day', 'BTC', 365 * 86400).then(data => {
      setBtcCloses(data.map(c => c.close));
    }).catch(() => {});
  }, []);

  // Funding across Binance / Bybit / OKX / Bitget / Coinbase (one bulk call).
  useEffect(() => {
    getAllExchangeFunding().then(setFundingAll).catch(() => {});
  }, []);

  // Per coin: 1 year of daily candles, OKX positioning, single-venue funding fallback.
  useEffect(() => {
    setDaily([]);
    setFundingSingle(null);
    setPositioning({ oiChange7d: null, longShort: null, longShortAvg30: null });
    coinglass.getHistoricalCandles('1day', coin.symbol, 365 * 86400).then(setDaily).catch(() => {});
    fetchOkxPositioning(coin.symbol).then(setPositioning).catch(() => {});
    fetchFundingRate(coin.symbol).then(setFundingSingle).catch(() => {});
  }, [coin.symbol]);

  const funding = useMemo(() => {
    const rates = Object.values(fundingAll[coin.symbol] ?? {}).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (rates.length) return { rate: rates.reduce((a, b) => a + b, 0) / rates.length, venues: rates.length };
    return fundingSingle !== null ? { rate: fundingSingle, venues: 1 } : { rate: null, venues: 0 };
  }, [fundingAll, coin.symbol, fundingSingle]);

  const forecast = useMemo(() => computeAltForecast({
    price, tf, tfCandles: candles, daily, btcDailyCloses: btcCloses,
    funding: funding.rate, fundingVenues: funding.venues,
    oiChange7d: positioning.oiChange7d, longShort: positioning.longShort, longShortAvg30: positioning.longShortAvg30,
    marketCapB: marketCap / 1e9,
  }), [price, tf, candles, daily, btcCloses, funding, positioning, marketCap]);

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
      // Transparent — RoundedCandleOverlay below paints the visible
      // rounded-corner bodies/wicks, same pattern as PriceChart.tsx. Series
      // stays mounted (just invisible) so it keeps driving scale/crosshair.
      seriesRef.current = chartRef.current.addSeries(CandlestickSeries, {
        upColor: "transparent", downColor: "transparent",
        borderUpColor: "transparent", borderDownColor: "transparent",
        wickUpColor: "transparent", wickDownColor: "transparent",
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
      // Candle times are already in seconds (fetchBinanceKlines).
      time: c.time as any,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    seriesRef.current.setData(data);
    overlayCandlesRef.current = data.map(d => ({
      time: d.time as number, open: d.open, high: d.high, low: d.low, close: d.close,
    }));
    setChartGeneration(g => g + 1);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  const handleSelectCoin = (c: typeof COINS[number]) => {
    setCoin(c);
    setQuery("");
    setShowDropdown(false);
  };

  const sigName = (k: SignalKey) => t(`altAnalysis2.sig.${k}Name`);
  const sigValue = (s: AltForecast["signals"][number]) =>
    s.stateKey ? `${t(`altAnalysis2.st.${s.stateKey}`)}${s.value ? ` · ${s.value}` : ""}` : s.value;

  const handleGenerate = async () => {
    const fc = forecast;
    if (!fc) return;
    setAiLoading(true);
    setAiError("");
    const range = (x: number, c: number) => `${fmtUsd(x)} (${c >= 0 ? "+" : ""}${c.toFixed(1)}%)`;
    const lang = LANG_NAME[(i18n.language || "en").slice(0, 2)] ?? "English";
    const res = await getAltNarrative({
      symbol: coin.symbol, name: coin.name, sector, price, horizon: HORIZON_EN[tf],
      direction: fc.direction, confidence: fc.confidence, score: fc.score,
      agree: fc.agree, against: fc.against,
      range: { bear: range(fc.bear, fc.bearChg), base: range(fc.base, fc.baseChg), bull: range(fc.bull, fc.bullChg) },
      levels: {
        entry: `${fmtUsd(fc.entryLo)} – ${fmtUsd(fc.entryHi)}`, stop: fmtUsd(fc.stop),
        supports: fc.supports.map(fmtUsd).join(" / "), resistances: fc.resistances.map(fmtUsd).join(" / "),
      },
      signals: fc.signals.map(s => ({ name: s.key, verdict: s.verdict, detail: s.detail, weight: s.weight })),
      language: lang,
    });
    if (res.success && res.result) setAnalysis({ forecast: fc, narrative: res.result, at: new Date() });
    else setAiError(res.error ?? t("altAnalysis2.predictionFailed"));
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
            {isPhone && (
              <BottomSheet
                open={showDropdown}
                onClose={() => { setShowDropdown(false); setQuery(""); }}
                title={<>{t("altAnalysis2.selectCoin")}</>}
                className="alt-coin-sheet"
                ariaLabel={t("altAnalysis2.selectCoin")}
                headerExtra={
                  <div className="alt-sheet-search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                    <input
                      className="alt-sheet-search-input"
                      placeholder={t("altAnalysis2.searchCoin")}
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                    />
                  </div>
                }
              >
                <div className="alt-sheet-list">
                  {filtered.map(c => {
                    const col = SECTOR_COLORS[SECTOR_MAP[c.symbol] ?? ""] ?? "#818cf8";
                    return (
                      <button
                        key={c.symbol}
                        type="button"
                        className={`alt-sheet-item${c.symbol === coin.symbol ? " alt-sheet-item--active" : ""}`}
                        onClick={() => handleSelectCoin(c)}
                      >
                        <span className="alt-dd-symbol" style={{ color: col }}>{c.symbol}</span>
                        <span className="alt-dd-name">{c.name}</span>
                        <span className="alt-dd-sector" style={{ color: col }}>{sectorLabel(SECTOR_MAP[c.symbol] ?? "Other")}</span>
                      </button>
                    );
                  })}
                  {filtered.length === 0 && <div className="alt-dd-empty">{t("altAnalysis2.noCoins")}</div>}
                </div>
              </BottomSheet>
            )}
            {showDropdown && !isPhone && (
              <div className="alt-dropdown">
                <div className="alt-dropdown-search">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                  <input
                    className="alt-search-input"
                    placeholder={t("altAnalysis2.searchCoin")}
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
                      {sectorLabel(SECTOR_MAP[c.symbol] ?? "Other")}
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && <div className="alt-dd-empty">{t("altAnalysis2.noCoins")}</div>}
              </div>
            )}
          </div>

          {/* coin identity */}
          <div className="alt-hero-identity">
            <h1 className="alt-hero-symbol" style={{ color: sectorColor }}>{coin.symbol}</h1>
            <span className="alt-hero-name">{coin.name}</span>
            <span className="alt-sector-pill" style={{ background: `${sectorColor}20`, color: sectorColor, borderColor: `${sectorColor}50` }}>
              {sectorLabel(sector)}
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
              <span className="alt-hero-stat-label">{t("altAnalysis2.marketCap")}</span>
              <span className="alt-hero-stat-val">{marketCap ? fmt(marketCap) : "—"}</span>
            </div>
            <div className="alt-hero-stat-divider" />
            <div className="alt-hero-stat">
              <span className="alt-hero-stat-label">{t("altAnalysis2.sectorRank")}</span>
              <span className="alt-hero-stat-val">{sectorLabel(sector)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Long-Term Analysis (chart + AI unified) ── */}
      <div className="alt-ai-section">

        {/* section header */}
        <div className="alt-ai-header" style={{ borderBottomColor: `${sectorColor}30`, background: `linear-gradient(90deg, color-mix(in srgb, ${sectorColor} 10%, transparent), transparent)` }}>
          <span className="alt-ai-badge">{t("altAnalysis2.aiBadge")}</span>
          <div className="alt-ai-header-text">
            <span className="alt-ai-title">{t("altAnalysis2.longTermTitle")}</span>
            <span className="alt-ai-subtitle">{coin.name} · {t(`altAnalysis2.prediction_${tf}`)}</span>
          </div>
          <div className="alt-ai-header-right">
            <span className="aiqw-live-badge"><span className="aiqw-live-dot" />{t("altAnalysis2.live")}</span>
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
                {(["1W", "1M", "3M", "6M", "1Y", "ALL"] as Timeframe[]).map(x => (
                  <button
                    key={x}
                    className={`alt-tf-btn${tf === x ? " active" : ""}`}
                    style={tf === x ? { background: sectorColor, borderColor: sectorColor, color: "#fff" } : {}}
                    onClick={() => setTf(x)}
                  >{x === "ALL" ? t("altAnalysis2.tfAll") : x}</button>
                ))}
              </div>
            </div>
            <div style={{ position: "relative", height: 380 }}>
              <div className="alt-chart-container" ref={chartContainerRef} style={{ height: 380 }} />
              <RoundedCandleOverlay
                chartRef={chartRef}
                seriesRef={seriesRef}
                candlesRef={overlayCandlesRef}
                upColor="#4ade80"
                downColor="#f87171"
                style="candle"
                generation={chartGeneration}
                visible={true}
              />
            </div>
          </div>

          {/* 20% signals panel */}
          <div className="alt-signal-panel">
            <div className="alt-signal-panel-title">{t("altAnalysis2.signalsUsed")}</div>
            <div className="alt-signal-list">
              {(() => {
                const ICON: Record<SignalKey, { color: string; icon: React.ReactNode }> = {
                  rsi: { color: "#f59e0b", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 12 Q5 4 8 12 Q11 20 14 12 Q17 4 20 12"/><line x1="2" y1="7" x2="22" y2="7" strokeDasharray="2 2" strokeWidth="1"/><line x1="2" y1="17" x2="22" y2="17" strokeDasharray="2 2" strokeWidth="1"/></svg> },
                  macd: { color: "#818cf8", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 18 Q7 6 12 10 Q17 14 22 4"/><path d="M2 14 Q7 10 12 12 Q17 14 22 10" strokeDasharray="3 2"/></svg> },
                  ma: { color: "#38bdf8", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 16 Q6 8 12 11 Q18 14 22 7"/><path d="M2 19 Q6 14 12 15 Q18 16 22 12" strokeDasharray="3 2"/></svg> },
                  structure: { color: "#34d399", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="8" y1="3" x2="8" y2="6"/><rect x="6" y="6" width="4" height="6" rx="0.5"/><line x1="8" y1="12" x2="8" y2="15"/><line x1="16" y1="6" x2="16" y2="8"/><rect x="14" y="8" width="4" height="7" rx="0.5"/><line x1="16" y1="15" x2="16" y2="18"/></svg> },
                  momentum: { color: "#fb923c", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
                  volume: { color: "#a78bfa", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="14" width="4" height="7" rx="0.5"/><rect x="10" y="9" width="4" height="12" rx="0.5"/><rect x="17" y="5" width="4" height="16" rx="0.5"/></svg> },
                  btc: { color: "#f97316", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 8h4.5a2 2 0 0 1 0 4H9v4h5a2 2 0 0 0 0-4"/><line x1="9" y1="8" x2="9" y2="16"/><line x1="10.5" y1="6" x2="10.5" y2="8"/><line x1="13.5" y1="6" x2="13.5" y2="8"/><line x1="10.5" y1="16" x2="10.5" y2="18"/><line x1="13.5" y1="16" x2="13.5" y2="18"/></svg> },
                  funding: { color: "#f43f5e", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="19" x2="19" y2="5"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/></svg> },
                  cycle: { color: "#2dd4bf", icon:<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15" y2="14"/></svg> },
                  oi: { color: "#22d3ee", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg> },
                  longShort: { color: "#e879f9", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17V7"/><path d="m4 10 3-3 3 3"/><path d="M17 7v10"/><path d="m14 14 3 3 3-3"/></svg> },
                  vsBtc: { color: "#fbbf24", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg> },
                  drawdown: { color: "#f87171", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h18"/><path d="M12 4v14"/><path d="m7 13 5 5 5-5"/></svg> },
                };
                const ORDER: SignalKey[] = ["rsi", "macd", "ma", "structure", "momentum", "volume", "btc", "funding", "oi", "longShort", "vsBtc", "drawdown", "cycle"];
                return ORDER.map((k, i) => {
                  const s = forecast?.signals.find(x => x.key === k);
                  const { color, icon } = ICON[k];
                  return (
                    <div key={k} className={`alt-signal-row${s ? "" : " alt-signal-row--na"}`}>
                      <span className="alt-signal-num">{i + 1}</span>
                      <span className="alt-signal-icon" style={{ color }}>{icon}</span>
                      <div className="alt-signal-text">
                        <span className="alt-signal-name">{sigName(k)}</span>
                        <span className="alt-signal-desc">{t(`altAnalysis2.sig.${k}Info`)}</span>
                      </div>
                      <div className="alt-signal-live">
                        <span className="alt-signal-val">{s ? sigValue(s) : "—"}</span>
                        {s && (
                          <span className={`alt-signal-verdict alt-signal-verdict--${s.verdict}`}>
                            {t(`altAnalysis2.dir_${s.verdict === "bull" ? "bullish" : s.verdict === "bear" ? "bearish" : "neutral"}`)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

        </div>

        {/* AI content */}
        {!isPaid ? (
          <AIQuotaWall
            used={used} limit={limit}
            onOpenUpgrade={onOpenUpgrade} onOpenAuth={onOpenAuth}
            planId="elite"
            featureTitle={t("altAnalysis2.wallTitle")}
            featureDesc={t("altAnalysis2.wallDesc")}
          />
        ) : !analysis ? (
          <div className="alt-ai-generate">
            <div className="alt-ai-generate-icon" style={{ color: sectorColor, borderColor: `${sectorColor}40`, background: `${sectorColor}12` }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            </div>
            <p className="alt-ai-generate-hint">{t("altAnalysis2.generateHint")} <strong>{coin.name}</strong></p>
            <p className="alt-ai-generate-sub">{t("altAnalysis2.generateSub")}</p>
            {aiError && <p className="alt-ai-error">{aiError}</p>}
            <button
              className="alt-ai-generate-btn"
              style={{ background: `linear-gradient(135deg, ${sectorColor}cc, ${sectorColor})` }}
              onClick={handleGenerate}
              disabled={aiLoading || !price}
            >
              {aiLoading ? t("altAnalysis2.analyzing") : t("altAnalysis2.analyzeCoin", { symbol: coin.symbol })}
            </button>
          </div>
        ) : (
          <div className="alt-ai-result">

            {(() => {
              const fc = analysis.forecast;
              const nv = analysis.narrative;
              const dirCls = fc.direction === "bullish" ? "alt-pos" : fc.direction === "bearish" ? "alt-neg" : "alt-neutral";
              const chg = (c: number) => `${c >= 0 ? "+" : ""}${c.toFixed(1)}%`;
              return (<>
            {/* ── Hero: call + base case + confidence ── */}
            <div className="alt-pred-hero" style={{ borderColor: `${sectorColor}30`, background: `color-mix(in srgb, ${sectorColor} 6%, var(--color-hover))` }}>
              <div className="alt-pred-direction">
                <span className={`alt-pred-arrow ${dirCls}`}>
                  {fc.direction === "bullish" ? "▲" : fc.direction === "bearish" ? "▼" : "◆"}
                </span>
                <div>
                  <div className={`alt-pred-label ${dirCls}`}>
                    {t(`altAnalysis2.dir_${fc.direction}`).toUpperCase()}
                  </div>
                  <div className="alt-pred-horizon">{t(`altAnalysis2.target_${tf}`)}</div>
                </div>
              </div>

              <div className="alt-pred-target">
                <span className="alt-pred-target-price">{fmtUsd(fc.base)}</span>
                <span className={`alt-pred-target-pct ${fc.baseChg >= 0 ? "alt-pos" : "alt-neg"}`}>{chg(fc.baseChg)}</span>
              </div>

              <div className="alt-pred-confidence">
                <span className="alt-pred-conf-label">{t("altAnalysis2.confidence")}</span>
                <span className={`alt-pred-conf-badge alt-pred-conf--${fc.confidence}`}>
                  {t(`altAnalysis2.conf_${fc.confidence}`).toUpperCase()}
                </span>
                <span className="alt-pred-agree">
                  {fc.direction === "neutral"
                    ? t("altAnalysis2.neutralCount", { n: fc.agree, total: fc.signals.length })
                    : t("altAnalysis2.agreeCount", { n: fc.agree, total: fc.signals.length })}
                </span>
              </div>
            </div>

            {/* ── Likely range ── */}
            <div className="alt-range">
              <div className="alt-range-head">
                <span className="alt-range-title">{t("altAnalysis2.likelyRange")}</span>
                <span className="alt-range-asof">{t("altAnalysis2.asOf", { time: analysis.at.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }) })}</span>
              </div>
              <div className="alt-range-cells">
                <div className="alt-range-cell alt-range-cell--bear">
                  <span className="alt-range-label">{t("altAnalysis2.bearCase")}</span>
                  <span className="alt-range-price">{fmtUsd(fc.bear)}</span>
                  <span className="alt-range-chg alt-neg">{chg(fc.bearChg)}</span>
                </div>
                <div className="alt-range-cell alt-range-cell--base">
                  <span className="alt-range-label">{t("altAnalysis2.baseCase")}</span>
                  <span className="alt-range-price">{fmtUsd(fc.base)}</span>
                  <span className={`alt-range-chg ${fc.baseChg >= 0 ? "alt-pos" : "alt-neg"}`}>{chg(fc.baseChg)}</span>
                </div>
                <div className="alt-range-cell alt-range-cell--bull">
                  <span className="alt-range-label">{t("altAnalysis2.bullCase")}</span>
                  <span className="alt-range-price">{fmtUsd(fc.bull)}</span>
                  <span className="alt-range-chg alt-pos">{chg(fc.bullChg)}</span>
                </div>
              </div>
              <p className="alt-range-note">{t("altAnalysis2.rangeNote")}</p>
            </div>

            {/* ── Summary ── */}
            <p className="alt-pred-summary" style={{ borderLeftColor: sectorColor }}>{nv.summary}</p>

            {/* ── Trade levels + reasons ── */}
            <div className="alt-pred-grid">
              <div className="alt-pred-levels">
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">{t("altAnalysis2.entryZone")}</span>
                  <span className="alt-pred-level-val">{fmtUsd(fc.entryLo)} – {fmtUsd(fc.entryHi)}</span>
                </div>
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">{t("altAnalysis2.stopLoss")}</span>
                  <span className="alt-pred-level-val alt-neg">{fmtUsd(fc.stop)}</span>
                </div>
                <div className="alt-pred-level-divider" />
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">{t("altAnalysis2.support")}</span>
                  <span className="alt-pred-level-val alt-pos">{fc.supports.map(fmtUsd).join(" / ")}</span>
                </div>
                <div className="alt-pred-level-row">
                  <span className="alt-pred-level-label">{t("altAnalysis2.resistance")}</span>
                  <span className="alt-pred-level-val alt-neg">{fc.resistances.map(fmtUsd).join(" / ")}</span>
                </div>
              </div>

              <div className="alt-pred-reasons">
                <div className="alt-pred-reasons-title">{t("altAnalysis2.why")}</div>
                <ul className="alt-ai-list">
                  {nv.reasons.map((r, i) => (
                    <li key={i}>
                      <span className={fc.direction === "bearish" ? "alt-x" : "alt-check"}>
                        {fc.direction === "bearish" ? "▼" : "▲"}
                      </span>
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* ── Reasoning ── */}
            {nv.reasoning && (
              <div className="alt-reasoning">
                <div className="alt-reasoning-label">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                  {t("altAnalysis2.whyThisPrediction")}
                </div>
                <p className="alt-reasoning-text">{nv.reasoning}</p>
              </div>
            )}
              </>);
            })()}

            <button className="alt-regenerate-btn" onClick={handleGenerate} disabled={aiLoading}>
              {aiLoading ? t("altAnalysis2.analyzing") : t("altAnalysis2.regenerate")}
            </button>

            {/* ── DYOR disclaimer ── */}
            <p className="alt-disclaimer">
              {t("altAnalysis2.disclaimer")}
            </p>
          </div>
        )}
      </div>

      {/* ── Winners & Losers ── */}
      <div className="alt-wl-section">
        <div className="alt-wl-header">
          <span className="alt-wl-title">{t("altAnalysis2.wlTitle")}</span>
          {sortedByChange.length > 0 && (
            <span className="alt-wl-sub">{t("altAnalysis2.wlSub", { count: sortedByChange.length })}</span>
          )}
        </div>
        {sortedByChange.length === 0 ? (
          <div className="alt-wl-loading">{t("altAnalysis2.loadingMarket")}</div>
        ) : (
          <div className="alt-wl-columns">

            {/* Winners */}
            <div className="alt-wl-col">
              <div className="alt-wl-col-header alt-wl-col-header--win">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
                {t("altAnalysis2.winners")}
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
                {t("altAnalysis2.losers")}
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
