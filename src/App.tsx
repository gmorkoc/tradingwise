import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import {
  coinglass,
  BTCData,
  CoinSymbol,
  clearCandleCache,
  COINS,
  fetchCoinMarketCaps,
  fetchCoin24hTickers,
  Ticker24h,
} from "./services/coinglass";
import { CATALOG } from "./services/coinCatalog";
import { fetchBinancePrices } from "./services/binancePrices";
import { ChatInterface } from "./components/ChatInterface";
import { Drawer } from "./components/Drawer";
import { AccountMenu } from "./components/AccountMenu";
import { LiquidationHeatmap } from "./components/LiquidationHeatmap";
import { LearnSection } from "./components/LearnSection";
import { NewsTicker } from "./components/NewsTicker";
import { LeveragePopup } from "./components/LeveragePopup";
import { CoinHintzLogo } from "./components/CoinHintzLogo";
import { PriceAlerts } from "./components/PriceAlerts";
import { ProfilePage } from "./components/ProfilePage";
import { TutorialPage } from "./components/TutorialPage";
import { GannAnalysis } from "./components/GannAnalysis";
import { HTFAnalysis } from "./components/HTFAnalysis";
import { OnChainMetrics } from "./components/OnChainMetrics";
import { OrderBook } from "./components/OrderBook";
import { PositionFlows } from "./components/PositionFlows";
import { OrderFlowFramework } from "./components/OrderFlowFramework";
import { Watchlist } from "./components/Watchlist";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { FlashNewsBanner } from "./components/FlashNewsBanner";
import { DailyBrief } from "./components/DailyBrief";
import { WhaleAlerts } from "./components/WhaleAlerts";
import { AuthModal } from "./components/AuthModal";
import { BlurGate } from "./components/MembershipGate";
import { UpgradeModal } from "./components/UpgradeModal";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { LandingPage } from "./components/LandingPage";
import { PriceTickerFullscreen } from "./components/PriceTickerFullscreen";
import { PredictionEngine } from "./components/PredictionEngine";
import { FundingBot } from "./components/FundingBot";
import { CandleWatcher } from "./components/CandleWatcher";
import { TradeManager } from "./components/TradeManager";
import { PriceChart } from "./components/PriceChart";
import { SectionBanner } from "./components/SectionBanner";
import { HoverTip } from "./components/HoverTip";
import { GlobalSearch } from "./components/GlobalSearch";
import { GlobalMarkets } from "./components/GlobalMarkets";
import { StocksHome } from "./components/StocksHome";
import { AltAnalysis } from "./components/AltAnalysis";
import { OptionsAnalytics } from "./components/OptionsAnalytics";
import { CorrelationMatrix } from "./components/CorrelationMatrix";
import { BtcMoveToast } from "./components/BtcMoveToast";
import { useBtcMoveAlert } from "./hooks/useBtcMoveAlert";
import { useNotificationsEnabled } from "./hooks/useNotificationsEnabled";
import { usePictureInPictureWindow } from "./hooks/usePictureInPictureWindow";
import { ZoneResult } from "./components/PriceChart.types";
import { Tier, saveTermsAgreement } from "./services/supabase";
import { ContactForm } from "./components/ContactForm";
import { ResolutionBanner } from "./components/ResolutionBanner";
import TermsGateModal from "./components/TermsGateModal";
import { PWAInstallButton } from "./components/PWAInstallGuide";
import "./App.css";

type SectionId =
  | "chart"
  | "heatmap"
  | "onchain"
  | "gann"
  | "htf"
  | "chat"
  | "positions"
  | "orderflow"
  | "signals"
  | "fundingbot"
  | "candleai"
  | "markets"
  | "altanalysis"
  | "riskcalc"
  | "options"
  | "correlation";

interface Position { id: string; catalogId: string; amount: string; cost: string }

let positionIdSeq = 0;
const makePositionId = () => `pos-${Date.now()}-${positionIdSeq++}`;

const NAV_ITEMS: {
  id: SectionId;
  labelKey: string;
  d: string | string[];
  requiredTier?: Tier;
  hidden?: boolean;
}[] = [
  {
    id: "chart",
    labelKey: "nav.chart",
    requiredTier: "pro",
    d: ["M3 3v18h18", "M7 16l4-4 4 4 5-5"],
  },
  {
    id: "candleai",
    labelKey: "nav.candleai",
    requiredTier: "elite",
    d: ["M3 3v18h18", "M7 7h2v10H7z", "M13 11h2v6h-2z", "M10 13h2v4h-2z"],
  },
  {
    id: "heatmap",
    labelKey: "nav.heatmap",
    requiredTier: "pro",
    d: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  },
  {
    id: "onchain",
    labelKey: "nav.onchain",
    requiredTier: "pro",
    d: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
  },
  {
    id: "gann",
    labelKey: "nav.gann",
    requiredTier: "pro",
    hidden: true,
    d: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  {
    id: "positions",
    labelKey: "nav.positions",
    d: [
      "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2",
      "M23 21v-2a4 4 0 00-3-3.87",
      "M16 3.13a4 4 0 010 7.75",
      "M9 7a4 4 0 100 8 4 4 0 000-8z",
    ],
  },
  {
    id: "htf",
    labelKey: "nav.htf",
    requiredTier: "pro",
    d: ["M3 3v18h18", "M7 7l5 5 5-5", "M7 12l5 5 5-5"],
  },
  { id: "orderflow", labelKey: "nav.orderflow", d: ["M2 12h4l3-9 4 18 3-9h6"] },
  {
    id: "signals",
    labelKey: "nav.signals",
    d: ["M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 3.9 2.4-7.4L2 9.4h7.6z"],
  },
  {
    id: "fundingbot",
    labelKey: "nav.fundingbot",
    d: [
      "M19 5L5 19",
      "M6.5 6.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
      "M17.5 17.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
    ],
  },
  {
    id: "riskcalc",
    labelKey: "nav.riskcalc",
    requiredTier: "pro",
    d: ["M21 4H8", "M3 4h.01", "M21 12H11", "M3 12h.01", "M21 20H8", "M3 20h.01", "M8 2v4", "M11 10v4", "M8 18v4"],
  },
  {
    id: "markets",
    labelKey: "nav.markets",
    d: [
      "M3 12a9 9 0 1 0 18 0 9 9 0 0 0 -18 0",
      "M3.6 9h16.8",
      "M3.6 15h16.8",
      "M11.5 3a17 17 0 0 0 0 18",
      "M12.5 3a17 17 0 0 1 0 18",
    ],
  },
  {
    id: "altanalysis",
    labelKey: "nav.altanalysis",
    requiredTier: "elite",
    d: [
      "M8 3v3",
      "M6 6h4v6H6z",
      "M8 12v3",
      "M16 5v2",
      "M14 7h4v7h-4z",
      "M16 14v4",
    ],
  },
  {
    id: "options",
    labelKey: "nav.options",
    requiredTier: "pro",
    d: [
      "M12 21a9 9 0 1 0 0 -18 9 9 0 0 0 0 18",
      "M12 17a5 5 0 1 0 0 -10 5 5 0 0 0 0 10",
      "M12 13a1 1 0 1 0 0 -2 1 1 0 0 0 0 2",
    ],
  },
  {
    id: "correlation",
    labelKey: "nav.correlation",
    requiredTier: "pro",
    d: [
      "M9 18a6 6 0 1 0 0 -12 6 6 0 0 0 0 12",
      "M15 18a6 6 0 1 0 0 -12 6 6 0 0 0 0 12",
    ],
  },
];

function NavIcon({ d }: { d: string | string[] }) {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

const COIN_ICONS: Record<string, string> = {
  BTC: "₿",
  ETH: "Ξ",
  XRP: "◈",
  SOL: "◎",
  BNB: "⬡",
  SUI: "⬟",
  DOGE: "Ð",
  ADA: "₳",
  NEAR: "Ⓝ",
  RENDER: "⬡",
  ZEC: "ⓩ",
};

/* ── Authenticated dashboard — only mounts when user is logged in ── */
interface DashboardProps {
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
}

function AppDashboard({
  onOpenAuth,
  onOpenUpgrade,
  theme,
  setTheme,
}: DashboardProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const hash = window.location.hash.slice(1) as SectionId;
    return NAV_ITEMS.some((n) => n.id === hash) ? hash : "chart";
  });
  const { alert: btcMoveAlert, dismiss: dismissBtcAlert } = useBtcMoveAlert();
  const [notificationsEnabled, setNotificationsEnabled] = useNotificationsEnabled();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingCheckedRef = useRef(false);
  const [showWatchlist, setShowWatchlist] = useState(
    () => localStorage.getItem("watchlist-visible") !== "false",
  );
  useEffect(() => {
    localStorage.setItem("watchlist-visible", String(showWatchlist));
  }, [showWatchlist]);

  const [coin, setCoin] = useState<CoinSymbol>(
    () => (localStorage.getItem("coin") as CoinSymbol) || "BTC",
  );

  useEffect(() => {
    localStorage.setItem("coin", coin);
  }, [coin]);

  const [chartAssetClass, setChartAssetClass] = useState<"crypto" | "stocks">(
    () => (new URLSearchParams(window.location.search).get("asset") === "stocks" ? "stocks" : "crypto"),
  );
  const [chartNavExpanded, setChartNavExpanded] = useState(false);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const [btcData, setBtcData] = useState<Partial<BTCData> | null>(() => {
    try {
      const storedCoin = (localStorage.getItem("coin") as CoinSymbol) || "BTC";
      const raw = localStorage.getItem(`btcData_${storedCoin}`);
      return raw ? (JSON.parse(raw) as Partial<BTCData>) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(() => {
    try {
      const storedCoin = (localStorage.getItem("coin") as CoinSymbol) || "BTC";
      return !localStorage.getItem(`btcData_${storedCoin}`);
    } catch {
      return true;
    }
  });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [positions, setPositions] = useState<Position[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("portfolioPositions_v1") ?? "null");
      if (Array.isArray(saved) && saved.length > 0) return saved;
    } catch { /* ignore malformed data */ }

    // Migrate the old single-coin (BTC-only) amount/cost fields, if present.
    const legacyAmount = localStorage.getItem("btcAmount");
    if (legacyAmount && Number(legacyAmount) > 0) {
      const legacySymbol = localStorage.getItem("coin") || "BTC";
      const meta = CATALOG.find(c => c.symbol === legacySymbol);
      return [{
        id: makePositionId(),
        catalogId: meta?.id ?? "bitcoin",
        amount: legacyAmount,
        cost: localStorage.getItem("btcCost") || "0",
      }];
    }
    return [{ id: makePositionId(), catalogId: "bitcoin", amount: "0", cost: "0" }];
  });
  const btcDataRef = useRef<Partial<BTCData> | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceTicker, setPriceTicker] = useState(false);
  const [tickerFlash, setTickerFlash] = useState<"up" | "down" | null>(null);
  const [tickerMuted, setTickerMuted] = useState(true);
  const [rockets, setRockets] = useState<
    { id: number; dir: "up" | "down"; x: number }[]
  >([]);
  const prevTickerPrice = useRef<number | null>(null);
  const coinBtnClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickerOpenPrice = useRef<number | null>(null);
  const tickerLastMilestone = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const { pipWindow, isSupported: pipSupported, requestPip, closePip } = usePictureInPictureWindow();

  useEffect(() => {
    btcDataRef.current = btcData;
  }, [btcData]);

  // 1-second live price from Binance public ticker
  useEffect(() => {
    const BINANCE_SYM: Record<string, string> = {
      BTC: "BTCUSDT",
      ETH: "ETHUSDT",
      XRP: "XRPUSDT",
      SOL: "SOLUSDT",
      DOGE: "DOGEUSDT",
      ADA: "ADAUSDT",
      SUI: "SUIUSDT",
      BNB: "BNBUSDT",
      NEAR: "NEARUSDT",
      RENDER: "RENDERUSDT",
      ZEC: "ZECUSDT",
    };
    const sym = BINANCE_SYM[coin] ?? `${coin}USDT`;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `https://data-api.binance.vision/api/v3/ticker/price?symbol=${sym}`,
        );
        if (!res.ok || cancelled) return;
        const d = await res.json();
        if (!cancelled) setLivePrice(parseFloat(d.price));
      } catch {
        /* ignore */
      }
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coin]);
  useEffect(() => {
    if (!priceTicker || livePrice === null) return;
    const prev = prevTickerPrice.current;
    if (prev !== null && prev !== livePrice) {
      setTickerFlash(livePrice > prev ? "up" : "down");
      const t = setTimeout(() => setTickerFlash(null), 600);
      return () => clearTimeout(t);
    }
    prevTickerPrice.current = livePrice;
  }, [livePrice, priceTicker]);

  useEffect(() => {
    if (!priceTicker || livePrice === null) return;

    // Rockets every $10
    const milestone10 = Math.floor(livePrice / 10) * 10;
    const last10 = tickerLastMilestone.current;
    if (last10 === null) {
      tickerLastMilestone.current = milestone10;
      return;
    }
    if (milestone10 !== last10) {
      const up10 = milestone10 > last10;
      tickerLastMilestone.current = milestone10;
      const id = Date.now();
      const x = 10 + Math.random() * 80;
      setRockets((prev) => [...prev, { id, dir: up10 ? "up" : "down", x }]);
      setTimeout(
        () => setRockets((prev) => prev.filter((r) => r.id !== id)),
        1400,
      );
    }

    // Sound every $100
    const milestone100 = Math.floor(livePrice / 100) * 100;
    const last100 = Math.floor((last10 ?? livePrice) / 100) * 100;
    const up = milestone100 > last100;
    if (milestone100 === last100) return;

    if (tickerMuted) return;
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      const play = (
        freq: number,
        type: OscillatorType,
        start: number,
        dur: number,
        gainVal: number,
      ) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(
          gainVal,
          ctx.currentTime + start + 0.02,
        );
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + start + dur,
        );
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur);
      };
      if (up) {
        play(523, "sine", 0, 0.18, 0.18);
        play(659, "sine", 0.1, 0.18, 0.18);
        play(784, "sine", 0.2, 0.25, 0.22);
      } else {
        play(523, "sine", 0, 0.18, 0.18);
        play(415, "sine", 0.1, 0.18, 0.18);
        play(311, "triangle", 0.2, 0.3, 0.2);
      }
    } catch {
      /* AudioContext blocked — ignore */
    }
  }, [livePrice, priceTicker, tickerMuted]);

  useEffect(() => {
    localStorage.setItem("portfolioPositions_v1", JSON.stringify(positions));
  }, [positions]);

  const positionSymbols = useMemo(
    () => Array.from(new Set(
      positions.map(p => CATALOG.find(c => c.id === p.catalogId)?.symbol).filter(Boolean),
    )) as string[],
    [positions],
  );
  const positionSymbolsKey = positionSymbols.join(",");

  const [positionPrices, setPositionPrices] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (positionSymbols.length === 0) { setPositionPrices(new Map()); return; }
    let cancelled = false;
    const refresh = async () => {
      const data = await fetchBinancePrices(positionSymbols);
      if (!cancelled) setPositionPrices(new Map(Array.from(data, ([sym, e]) => [sym, e.price])));
    };
    refresh();
    const id = setInterval(refresh, 5_000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionSymbolsKey]);

  const portfolioTotals = useMemo(() => {
    let totalAssetValue = 0;
    let totalCostBasis = 0;
    for (const p of positions) {
      const symbol = CATALOG.find(c => c.id === p.catalogId)?.symbol;
      const price = symbol ? positionPrices.get(symbol) : undefined;
      const amount = Number(p.amount) || 0;
      const cost = Number(p.cost) || 0;
      totalAssetValue += price ? amount * price : 0;
      totalCostBasis += amount * cost;
    }
    return { totalAssetValue, totalCostBasis, profitLoss: totalAssetValue - totalCostBasis };
  }, [positions, positionPrices]);
  const { totalAssetValue, totalCostBasis, profitLoss } = portfolioTotals;
  const hasAnyPosition = positions.some(p => (Number(p.amount) || 0) > 0);

  // Track tick-to-tick direction so the header badge can flash green/red on change
  const [portfolioDirection, setPortfolioDirection] = useState<"up" | "down" | null>(null);
  const prevPortfolioValueRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevPortfolioValueRef.current;
    if (prev !== null && totalAssetValue !== prev) {
      setPortfolioDirection(totalAssetValue > prev ? "up" : "down");
    }
    prevPortfolioValueRef.current = totalAssetValue;
  }, [totalAssetValue]);

  const updatePosition = useCallback((id: string, patch: Partial<Position>) => {
    setPositions(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)));
  }, []);
  const addPosition = useCallback(() => {
    const usedIds = new Set(positions.map(p => p.catalogId));
    const nextCoin = CATALOG.find(c => !usedIds.has(c.id)) ?? CATALOG[0];
    setPositions(prev => [...prev, { id: makePositionId(), catalogId: nextCoin.id, amount: "0", cost: "0" }]);
  }, [positions]);
  const removePosition = useCallback((id: string) => {
    setPositions(prev => (prev.length > 1 ? prev.filter(p => p.id !== id) : prev));
  }, []);

  const [exportStatus, setExportStatus] = useState<"idle" | "done" | "error">("idle");
  const [importStatus, setImportStatus] = useState<"idle" | "done" | "error">("idle");
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const exportPositions = useCallback(() => {
    try {
      const payload = positions.map(p => ({
        symbol: CATALOG.find(c => c.id === p.catalogId)?.symbol ?? "",
        amount: p.amount,
        cost: p.cost,
      }));
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "coinhintz-portfolio.json";
      a.click();
      URL.revokeObjectURL(url);
      setExportStatus("done");
    } catch {
      setExportStatus("error");
    }
    setTimeout(() => setExportStatus("idle"), 1800);
  }, [positions]);

  const importPositionsFromFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("not an array");

      const next: Position[] = [];
      for (const item of parsed as Array<{ symbol?: unknown; amount?: unknown; cost?: unknown }>) {
        const symbol = typeof item?.symbol === "string" ? item.symbol.toUpperCase() : "";
        const meta = CATALOG.find(c => c.symbol === symbol);
        if (!meta) continue;
        next.push({
          id: makePositionId(),
          catalogId: meta.id,
          amount: String(item.amount ?? "0"),
          cost: String(item.cost ?? "0"),
        });
      }
      if (next.length === 0) throw new Error("nothing recognizable in file");

      setPositions(next);
      setImportStatus("done");
    } catch {
      setImportStatus("error");
    }
    setTimeout(() => setImportStatus("idle"), 1800);
  }, []);

  const { tier, user, profile, signOut } = useAuth();
  useEffect(() => {
    if (profile && !onboardingCheckedRef.current) {
      onboardingCheckedRef.current = true;
      if (!profile.trader_level && !localStorage.getItem("onb_never_show"))
        setShowOnboarding(true);
    }
  }, [profile]);

  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [coinPickerOpen, setCoinPickerOpen] = useState(false);
  const [coinSearch, setCoinSearch] = useState("");
  const [globalSearch, setGlobalSearch] = useState(false);
  const [coinMarketCaps, setCoinMarketCaps] = useState<Map<string, number>>(
    new Map(),
  );
  const [coinTickers, setCoinTickers] = useState<Map<string, Ticker24h>>(
    new Map(),
  );
  useEffect(() => {
    fetchCoinMarketCaps()
      .then(setCoinMarketCaps)
      .catch(() => {});
    fetchCoin24hTickers(COINS)
      .then(setCoinTickers)
      .catch(() => {});
  }, []);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [obSize, setObSize] = useState({ h: 380, w: 135 });
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({
    active: false,
    axis: "col" as "col" | "row",
    startPos: 0,
    startSize: 0,
  });
  const [swipeHint, setSwipeHint] = useState(false);
  const mobileNavOpenRef = useRef(false);
  mobileNavOpenRef.current = mobileNavOpen;
  const coinPickerBtnRef = useRef<HTMLButtonElement>(null);
  const [coinPickerPos, setCoinPickerPos] = useState({ top: 0, left: 0 });

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      const wrap = chartWrapRef.current;
      const axis =
        wrap && getComputedStyle(wrap).flexDirection === "row" ? "row" : "col";
      dragState.current = {
        active: true,
        axis,
        startPos: axis === "row" ? e.clientX : e.clientY,
        startSize: axis === "row" ? obSize.w : obSize.h,
      };
    },
    [obSize],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragState.current.active) return;
      const { axis, startPos, startSize } = dragState.current;
      const delta = (axis === "row" ? e.clientX : e.clientY) - startPos;
      const minSize = axis === "row" ? 4 : 80;
      const newSize = Math.max(minSize, Math.min(600, startSize - delta));
      setObSize((prev) =>
        axis === "row" ? { ...prev, w: newSize } : { ...prev, h: newSize },
      );
    },
    [],
  );

  const onResizePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragState.current.active = false;
    },
    [],
  );

  const openCoinPicker = () => {
    if (coinPickerBtnRef.current) {
      const rect = coinPickerBtnRef.current.getBoundingClientRect();
      setCoinPickerPos({ top: rect.bottom + 8, left: rect.left });
    }
    setCoinPickerOpen((v) => {
      if (v) setCoinSearch("");
      return !v;
    });
    fetchCoinMarketCaps()
      .then(setCoinMarketCaps)
      .catch(() => {});
    fetchCoin24hTickers(COINS)
      .then(setCoinTickers)
      .catch(() => {});
  };

  const closeCoinPicker = () => {
    setCoinPickerOpen(false);
    setCoinSearch("");
  };

  const [leverageOpen, setLeverageOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [chartZone, setChartZone] = useState<ZoneResult | null>(null);
  const [chartPrice, setChartPrice] = useState(0);

  const [priceAlert, setPriceAlert] = useState<{
    message: string;
    type: "bullish" | "bearish";
    key: number;
  } | null>(null);
  const prevPriceStatusRef = useRef<"bullish" | "bearish" | null>(null);

  const zoneStatus = (zone: typeof chartZone): "bullish" | "bearish" | null => {
    if (!zone) return null;
    const s = zone.signal;
    if (s === "strong-buy" || s === "buy" || s === "oversold") return "bullish";
    if (s === "strong-sell" || s === "sell" || s === "overbought")
      return "bearish";
    return null;
  };

  useEffect(() => {
    if (btcData) setError("");
  }, [btcData]);

  // Sync URL hash (active section) and asset query param (crypto/stocks) together.
  // Always write an explicit value while on the chart section so both directions
  // (crypto<->stocks) visibly update the URL, not just the stocks->crypto delete.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (activeSection === "chart") {
      params.set("asset", chartAssetClass);
    } else {
      params.delete("asset");
    }
    const search = params.toString();
    window.history.replaceState(null, "", `${search ? `?${search}` : ""}#${activeSection}`);
  }, [activeSection, chartAssetClass]);

  // Handle browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.slice(1) as SectionId;
      if (NAV_ITEMS.some((n) => n.id === hash)) setActiveSection(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Global search keyboard shortcut (Cmd+K / Ctrl+K)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setGlobalSearch((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Close mobile nav when section changes
  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeSection]);

  // First-visit swipe intro
  useEffect(() => {
    if (window.innerWidth > 640) return;
    if (localStorage.getItem("swipe-hint-seen")) return;
    const t1 = setTimeout(() => {
      setMobileNavOpen(true);
      setSwipeHint(true);
    }, 800);
    const t2 = setTimeout(() => {
      setMobileNavOpen(false);
    }, 2200);
    const t3 = setTimeout(() => {
      setSwipeHint(false);
      localStorage.setItem("swipe-hint-seen", "1");
    }, 2800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  // Swipe gesture — open on right-swipe from left edge, close on left-swipe
  useEffect(() => {
    const EDGE = 40;
    const THRESHOLD = 50;
    let startX = 0,
      startY = 0;
    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = Math.abs(e.changedTouches[0].clientY - startY);
      if (dy > 80) return; // vertical scroll, ignore
      if (!mobileNavOpenRef.current && startX < EDGE && dx > THRESHOLD)
        setMobileNavOpen(true);
      else if (mobileNavOpenRef.current && dx < -THRESHOLD)
        setMobileNavOpen(false);
    };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  useEffect(() => {
    const current = zoneStatus(chartZone);
    if (current === null) return;
    const prev = prevPriceStatusRef.current;
    if (prev !== current) {
      setPriceAlert({
        message:
          prev === null
            ? current === "bullish"
              ? t("alert.currentlyBullish")
              : t("alert.currentlyBearish")
            : current === "bullish"
              ? t("alert.turnedBullish")
              : t("alert.turnedBearish"),
        type: current,
        key: Date.now(),
      });
      prevPriceStatusRef.current = current;
    }
  }, [chartZone]);

  const formatCurrency = (value: number) =>
    value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const fetchBTCData = async () => {
    const isInitialLoad = !btcDataRef.current;
    if (isInitialLoad) {
      setLoading(true);
    } else {
      clearCandleCache();
      setRefreshing(true);
    }
    setError("");
    const data = await coinglass.getAllBTCData(coin);
    if (data) {
      setBtcData(data);
      try {
        localStorage.setItem(`btcData_${coin}`, JSON.stringify(data));
      } catch {
        /* quota */
      }
      setRefreshTrigger((prev) => prev + 1);
      setError("");
    } else if (!btcDataRef.current) {
      setError("Failed to fetch data. Please check your API connection.");
    }
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => {
    let cached: Partial<BTCData> | null = null;
    try {
      const raw = localStorage.getItem(`btcData_${coin}`);
      if (raw) cached = JSON.parse(raw) as Partial<BTCData>;
    } catch {
      /* ignore */
    }
    btcDataRef.current = cached;
    setBtcData(cached);
    setLoading(!cached);
    fetchBTCData();
    if (autoRefresh) {
      const interval = setInterval(fetchBTCData, 30000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, coin]);

  return (
    <>
    <div className="app-shell">
      {showOnboarding && (
        <OnboardingWizard
          onComplete={() => setShowOnboarding(false)}
          onSkip={() => setShowOnboarding(false)}
        />
      )}
      <ProfilePage
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        onOpenUpgrade={() => {
          setProfileOpen(false);
          onOpenUpgrade();
        }}
      />
      <div className="app-shell-news">
        <NewsTicker />
      </div>

      <div
        className={`app-shell-body${mobileNavOpen ? " mobile-nav-open" : ""}`}
      >
        <Drawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          theme={theme}
          setTheme={setTheme}
          autoRefresh={autoRefresh}
          setAutoRefresh={setAutoRefresh}
          onOpenLeverage={() => setLeverageOpen(true)}
          onOpenLearn={() => setLearnOpen(true)}
          onOpenTutorials={() => setTutorialOpen(true)}
          onOpenProfile={() => {
            setDrawerOpen(false);
            setProfileOpen(true);
          }}
          onOpenWizard={() => setShowOnboarding(true)}
          onOpenContact={() => {
            setDrawerOpen(false);
            setContactOpen(true);
          }}
          traderLevel={profile?.trader_level ?? null}
        />
        <ContactForm
          isOpen={contactOpen}
          onClose={() => setContactOpen(false)}
        />
        <LearnSection isOpen={learnOpen} onClose={() => setLearnOpen(false)} />
        {tutorialOpen && (
          <TutorialPage onClose={() => setTutorialOpen(false)} />
        )}
        <LeveragePopup
          isOpen={leverageOpen}
          onClose={() => setLeverageOpen(false)}
          zone={chartZone}
          currentPrice={chartPrice}
          coin={coin}
        />

        {mobileNavOpen && (
          <div
            className="mobile-nav-backdrop"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <nav className={`icon-strip${mobileNavOpen ? " mobile-open" : ""}`}>
          <button
            className="icon-strip-logo"
            onClick={fetchBTCData}
            title={t("header.clickToRefresh")}
          >
            <CoinHintzLogo loading={loading || refreshing} />
          </button>

          {/* Mobile-only profile header */}
          <div className="mob-nav-profile">
            <div className="mob-nav-avatar">
              {profile?.full_name
                ? profile.full_name
                    .trim()
                    .split(/\s+/)
                    .map((w) => w[0])
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()
                : (user?.email?.[0] ?? "?").toUpperCase()}
            </div>
            <div className="mob-nav-userinfo">
              <span className="mob-nav-name">
                {profile?.full_name || user?.email?.split("@")[0] || "Account"}
              </span>
              <span className={`mob-nav-tier mob-nav-tier--${tier}`}>{tier.toUpperCase()}</span>
            </div>
          </div>

          <div className="icon-strip-nav">
            {NAV_ITEMS.filter((item) => !item.hidden).map((item) => {
              const isChart = item.id === "chart";
              const navButton = (
                <button
                  className={`icon-strip-btn${activeSection === item.id ? " active" : ""}`}
                  onClick={() => {
                    setActiveSection(item.id);
                    if (isChart) setChartNavExpanded((v) => !v);
                  }}
                  title={t(item.labelKey)}
                >
                  {/* Mobile badge — left of icon */}
                  {item.requiredTier && (
                    <span className={`nav-badge--mobile nav-badge--${item.requiredTier}`}>
                      {item.requiredTier === "elite" ? "E" : "P"}
                    </span>
                  )}
                  <span className="nav-icon-wrap">
                    <NavIcon d={item.d} />
                  </span>
                  <span className="icon-strip-label">{t(item.labelKey)}</span>
                  {isChart && (
                    <span className={`icon-strip-label chart-nav-chevron${chartNavExpanded ? " chart-nav-chevron--open" : ""}`}>▾</span>
                  )}
                  {/* Desktop badge — after label */}
                  {item.requiredTier && (
                    <span className={`icon-strip-elite-badge nav-badge--desktop nav-badge--${item.requiredTier}`}>
                      {item.requiredTier === "elite" ? "E" : "P"}
                    </span>
                  )}
                </button>
              );

              if (!isChart) return <Fragment key={item.id}>{navButton}</Fragment>;

              return (
                <Fragment key={item.id}>
                  {navButton}
                  {chartNavExpanded && (
                    <div className="chart-nav-subitems">
                      <button
                        className={`chart-nav-subitem${chartAssetClass === "crypto" ? " chart-nav-subitem--active" : ""}`}
                        onClick={() => {
                          setChartAssetClass("crypto");
                          setActiveSection("chart");
                          setChartNavExpanded(false);
                        }}
                      >
                        <span className="chart-asset-tab-icon">₿</span>
                        <span className="icon-strip-label">{t("nav.crypto")}</span>
                      </button>
                      <button
                        className={`chart-nav-subitem${chartAssetClass === "stocks" ? " chart-nav-subitem--active" : ""}`}
                        onClick={() => {
                          setChartAssetClass("stocks");
                          setActiveSection("chart");
                          setChartNavExpanded(false);
                        }}
                      >
                        <span className="chart-asset-tab-icon">📈</span>
                        <span className="icon-strip-label">{t("nav.stocks")}</span>
                      </button>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>

          <div className="icon-strip-bottom">
            <div className="icon-strip-acct">
              <AccountMenu
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                onOpenProfile={() => setProfileOpen(true)}
              />
            </div>

            <PWAInstallButton
              onCloseMobileNav={() => setMobileNavOpen(false)}
            />

            <button
              className="icon-strip-btn"
              onClick={() => {
                setDrawerOpen(true);
                setMobileNavOpen(false);
              }}
              title={t("drawer.settings")}
            >
              <span className="nav-icon-wrap">
                <NavIcon
                  d={[
                    "M12 15a3 3 0 100-6 3 3 0 000 6z",
                    "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
                  ]}
                />
              </span>
              <span className="icon-strip-label">{t("nav.settings")}</span>
            </button>

            <button
              className="icon-strip-btn"
              onClick={() => {
                signOut();
                setMobileNavOpen(false);
              }}
              title={t("nav.signOut")}
            >
              <span className="nav-icon-wrap">
                <NavIcon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
              </span>
              <span className="icon-strip-label">{t("nav.signOut")}</span>
            </button>

            <button
              className={`icon-strip-theme-pill${theme === "light" ? " light" : ""}`}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={
                theme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
              aria-label="Toggle theme"
            >
              <div className="theme-pill-track">
                <div className="theme-pill-knob">
                  {theme === "dark" ? (
                    <NavIcon d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                  ) : (
                    <NavIcon d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 5a7 7 0 100 14A7 7 0 0012 5z" />
                  )}
                </div>
              </div>
            </button>
          </div>
        </nav>

        <div className="main-panel">
          <div className="main-coin-header">
            <div className="mch-left">
              <button
                className="mch-menu-btn"
                onClick={() => setMobileNavOpen((v) => !v)}
                aria-label="Open menu"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <button
                className="mch-coin-btn"
                ref={coinPickerBtnRef}
                onClick={() => {
                  if (coinBtnClickTimer.current) {
                    clearTimeout(coinBtnClickTimer.current);
                    coinBtnClickTimer.current = null;
                    prevTickerPrice.current = livePrice;
                    tickerOpenPrice.current = livePrice;
                    tickerLastMilestone.current =
                      livePrice !== null
                        ? Math.floor(livePrice / 100) * 100
                        : null;
                    setPriceTicker(true);
                  } else {
                    coinBtnClickTimer.current = setTimeout(() => {
                      coinBtnClickTimer.current = null;
                      openCoinPicker();
                    }, 250);
                  }
                }}
              >
                <span className="mch-coin-icon">
                  {COIN_ICONS[coin] ?? coin[0]}
                </span>
                <div className="mch-coin-info">
                  <span className="mch-coin-pair">
                    {coin}
                    <span className="mch-coin-quote">/USD</span>
                  </span>
                  {(livePrice ?? btcData?.price) && (
                    <span className="mch-coin-price">
                      $
                      {(livePrice ?? btcData!.price!).toLocaleString("en-US", {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}
                    </span>
                  )}
                  <span className="price-source">
                    via Binance{" "}
                    <span className="price-source-fs-hint">
                      ⛶ Double-click chart for fullscreen
                    </span>
                  </span>
                </div>
                <span className="mch-coin-chevron">▾</span>
              </button>
            </div>

            <div className="mch-stats">
              {btcData &&
                (() => {
                  const fr = btcData.fundingRate ?? 0;
                  const rsi = btcData.rsi ?? 50;
                  const macd = btcData.macd ?? 0;
                  const ls = btcData.longShortRatio ?? 1;
                  const frSignal =
                    fr > 0.0005 ? "bear" : fr < -0.0001 ? "bull" : "neutral";
                  const rsiSignal =
                    rsi > 70
                      ? "bear"
                      : rsi < 30
                        ? "bull"
                        : rsi < 50
                          ? "bear"
                          : "bull";
                  const macdSignal = macd > 0 ? "bull" : "bear";
                  const lsSignal = ls >= 1 ? "bull" : "bear";
                  return (
                    <>
                      {(livePrice ?? btcData.price) && (
                        <div className="mch-stat mch-stat--price-mobile">
                          <span className="mch-stat-label">{coin}/USD</span>
                          <span className="mch-stat-value">
                            $
                            {(livePrice ?? btcData.price!).toLocaleString(
                              "en-US",
                              {
                                minimumFractionDigits: 1,
                                maximumFractionDigits: 1,
                              },
                            )}
                          </span>
                          <span className="mch-stat-signal mch-stat-signal--neutral">
                            Binance
                          </span>
                        </div>
                      )}
                      <HoverTip className="mch-stat" text={t("stats.liqAboveDesc")}>
                        <span className="mch-stat-label">
                          {t("stats.liqAbove")}
                        </span>
                        <span className="mch-stat-value negative">
                          {btcData.liquidationAbove
                            ? `$${btcData.liquidationAbove.toLocaleString()}`
                            : "—"}
                        </span>
                        <span className="mch-stat-signal mch-stat-signal--bear">
                          {t("stats.sigRisk")}
                        </span>
                      </HoverTip>
                      <HoverTip className="mch-stat" text={t("stats.liqBelowDesc")}>
                        <span className="mch-stat-label">
                          {t("stats.liqBelow")}
                        </span>
                        <span className="mch-stat-value positive">
                          {btcData.liquidationBelow
                            ? `$${btcData.liquidationBelow.toLocaleString()}`
                            : "—"}
                        </span>
                        <span className="mch-stat-signal mch-stat-signal--bull">
                          {t("stats.sigSupport")}
                        </span>
                      </HoverTip>
                      <HoverTip className="mch-stat" text={t("stats.openInterestDesc")}>
                        <span className="mch-stat-label">
                          {t("stats.openInterest")}
                        </span>
                        <span className="mch-stat-value">
                          {btcData.openInterest
                            ? `$${(btcData.openInterest / 1e9).toFixed(2)}B`
                            : "—"}
                        </span>
                        <span className="mch-stat-signal mch-stat-signal--neutral">
                          {t("stats.sigNeutral")}
                        </span>
                      </HoverTip>
                      <HoverTip className="mch-stat" text={t("stats.fundingRateDesc")}>
                        <span className="mch-stat-label">
                          {t("stats.fundingRate")}
                        </span>
                        <span
                          className={`mch-stat-value${fr < 0 ? " negative" : ""}`}
                        >
                          {`${fr >= 0 ? "+" : ""}${(fr * 100).toFixed(4)}%`}
                        </span>
                        <span
                          className={`mch-stat-signal mch-stat-signal--${frSignal}`}
                        >
                          {frSignal === "bull"
                            ? t("stats.sigBullish")
                            : frSignal === "bear"
                              ? t("stats.sigCrowded")
                              : t("stats.sigNeutral")}
                        </span>
                      </HoverTip>
                      <HoverTip className="mch-stat" text={t("stats.rsi14Desc")}>
                        <span className="mch-stat-label">
                          {t("stats.rsi14")}
                        </span>
                        <span
                          className={`mch-stat-value${rsi > 70 ? " negative" : rsi < 30 ? " positive" : ""}`}
                        >
                          {rsi.toFixed(1)}
                        </span>
                        <span
                          className={`mch-stat-signal mch-stat-signal--${rsiSignal}`}
                        >
                          {rsi > 70
                            ? t("stats.sigOverbought")
                            : rsi < 30
                              ? t("stats.sigOversold")
                              : rsi < 50
                                ? t("stats.sigWeak")
                                : t("stats.sigNeutral")}
                        </span>
                      </HoverTip>
                      <HoverTip className="mch-stat" text={t("stats.macdDesc")}>
                        <span className="mch-stat-label">
                          {t("stats.macd")}
                        </span>
                        <span
                          className={`mch-stat-value${macd < 0 ? " negative" : ""}`}
                        >
                          {macd.toFixed(2)}
                        </span>
                        <span
                          className={`mch-stat-signal mch-stat-signal--${macdSignal}`}
                        >
                          {macd > 0
                            ? t("stats.sigBullish")
                            : t("stats.sigBearish")}
                        </span>
                      </HoverTip>
                      <HoverTip className="mch-stat" text={t("stats.lsRatioDesc")}>
                        <span className="mch-stat-label">
                          {t("stats.lsRatio")}
                        </span>
                        <span
                          className={`mch-stat-value${ls >= 1 ? " positive" : " negative"}`}
                        >
                          {ls.toFixed(2)}
                        </span>
                        <span
                          className={`mch-stat-signal mch-stat-signal--${lsSignal}`}
                        >
                          {ls >= 1
                            ? t("stats.sigLongsLead")
                            : t("stats.sigShortsLead")}
                        </span>
                      </HoverTip>
                      {(() => {
                        const g = btcData.cmeGap;
                        const fmt = (v: number) => `$${(v / 1000).toFixed(1)}K`;
                        return (
                          <>
                            <HoverTip className="mch-stat" text={t("stats.cmeAboveDesc")}>
                              <span className="mch-stat-label">
                                {t("stats.cmeAbove")}
                              </span>
                              <span
                                className="mch-stat-value"
                                style={{ fontSize: "0.7rem" }}
                              >
                                {g?.above
                                  ? `${fmt(g.above.low)}–${fmt(g.above.high)}`
                                  : "—"}
                              </span>
                              <span className="mch-stat-signal mch-stat-signal--bull">
                                {g?.above
                                  ? t("stats.sigAbove")
                                  : t("stats.sigNone")}
                              </span>
                            </HoverTip>
                            <HoverTip className="mch-stat" text={t("stats.cmeBelowDesc")}>
                              <span className="mch-stat-label">
                                {t("stats.cmeBelow")}
                              </span>
                              <span
                                className="mch-stat-value"
                                style={{ fontSize: "0.7rem" }}
                              >
                                {g?.below
                                  ? `${fmt(g.below.low)}–${fmt(g.below.high)}`
                                  : "—"}
                              </span>
                              <span className="mch-stat-signal mch-stat-signal--bear">
                                {g?.below
                                  ? t("stats.sigBelow")
                                  : t("stats.sigNone")}
                              </span>
                            </HoverTip>
                          </>
                        );
                      })()}
                    </>
                  );
                })()}
            </div>


            <div className="mch-right">
              <button
                className="mch-search-btn"
                onClick={() => setGlobalSearch(true)}
                title="Search (⌘K)"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </button>
              <PriceAlerts coin={coin} currentPrice={btcData?.price ?? 0} />
              <button
                className={`mch-search-btn${notificationsEnabled ? "" : " mch-notif-btn--off"}`}
                onClick={() => setNotificationsEnabled(!notificationsEnabled)}
                role="switch"
                aria-checked={notificationsEnabled}
                aria-label="Notifications"
                title={notificationsEnabled ? "Notifications on — click to disable all alerts" : "Notifications off — click to enable"}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  {!notificationsEnabled && <line x1="3" y1="3" x2="21" y2="21" />}
                </svg>
              </button>
              <div
                className="mch-portfolio"
                onClick={() => setAssetPanelOpen((v) => !v)}
                title={t("header.openCalculator")}
              >
                <svg
                  className="mch-portfolio-icon"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="18" y1="20" x2="18" y2="10" />
                  <line x1="12" y1="20" x2="12" y2="4" />
                  <line x1="6" y1="20" x2="6" y2="14" />
                </svg>
                <span className="mch-portfolio-label">{t("header.portfolioValue")}</span>
                <span
                  className={`mch-portfolio-value${hasAnyPosition && portfolioDirection ? ` ${portfolioDirection}` : ""}`}
                >
                  {hasAnyPosition ? formatCurrency(totalAssetValue) : "—"}
                </span>
              </div>
            </div>
          </div>

          <div
            className={`main-content${activeSection === "chart" ? " chart-active" : ""}`}
          >
            {profile?.subscription_status === "past_due" && (
              <div className="pastdue-banner">
                <span>⚠️ {t("billing.pastDue.message")}</span>
                <button className="pastdue-banner-btn" onClick={onOpenUpgrade}>
                  {t("billing.pastDue.cta")}
                </button>
              </div>
            )}
            {error && (
              <div className="error-banner">
                <strong>⚠️ {t("main.error")}:</strong> {error}
              </div>
            )}

            {activeSection === "chart" && (
              <>
                {chartAssetClass === "crypto" && <FlashNewsBanner />}
                {chartAssetClass === "crypto" ? (
                  <div
                    className="chart-section-wrap"
                    ref={chartWrapRef}
                    style={
                      {
                        "--ob-h": `${obSize.h}px`,
                        "--ob-w": `${obSize.w}px`,
                      } as React.CSSProperties
                    }
                  >
                    <PriceChart
                      refreshTrigger={refreshTrigger}
                      theme={theme}
                      coin={coin}
                      onZoneChange={(zone, price) => {
                        setChartZone(zone);
                        setChartPrice(price);
                      }}
                      onOpenAuth={onOpenAuth}
                      onOpenUpgrade={onOpenUpgrade}
                    />
                    <div
                      className="chart-resize-handle"
                      onPointerDown={onResizePointerDown}
                      onPointerMove={onResizePointerMove}
                      onPointerUp={onResizePointerUp}
                    >
                      <svg
                        className="chart-resize-icon"
                        width="42"
                        height="42"
                        viewBox="0 0 64 64"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        {/* Hand / pointer finger */}
                        <path d="M28 30V14a3 3 0 0 1 6 0v16" />
                        <path d="M34 20a3 3 0 0 1 6 0v10" />
                        <path d="M40 23a3 3 0 0 1 6 0v10" />
                        <path d="M22 32a3 3 0 0 1 6 0v-2" />
                        <path d="M22 32v6c0 6.627 4.477 12 10 12h4c5.523 0 10-5.373 10-12v-9" />
                        {/* Left arrow */}
                        <line x1="12" y1="24" x2="2" y2="24" />
                        <polyline points="6,20 2,24 6,28" />
                        {/* Right arrow */}
                        <line x1="52" y1="24" x2="62" y2="24" />
                        <polyline points="58,20 62,24 58,28" />
                      </svg>
                    </div>
                    <OrderBook coin={coin} onOpenUpgrade={onOpenUpgrade} />
                  </div>
                ) : (
                  <StocksHome theme={theme} />
                )}
              </>
            )}
            {activeSection !== "chart" && (
              <SectionBanner section={activeSection} />
            )}
            {activeSection === "heatmap" && (
              <LiquidationHeatmap
                coin={coin}
                theme={theme}
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
              />
            )}
            {activeSection === "onchain" && (
              <OnChainMetrics
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
              />
            )}
            {activeSection === "gann" && (
              <BlurGate
                requiredTier="pro"
                featureName="Gann Analysis"
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                className="bg-root--top"
              >
                <GannAnalysis
                  coin={coin}
                  currentPrice={btcData?.price}
                  onOpenAuth={onOpenAuth}
                  onOpenUpgrade={onOpenUpgrade}
                />
              </BlurGate>
            )}
            {activeSection === "htf" && (
              <HTFAnalysis
                coin={coin}
                currentPrice={btcData?.price}
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
              />
            )}
            {activeSection === "positions" && <PositionFlows coin={coin} />}
            {activeSection === "orderflow" && (
              <OrderFlowFramework coin={coin} />
            )}
            {activeSection === "signals" && (
              <PredictionEngine
                btcData={btcData}
                coin={coin}
                livePrice={livePrice}
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
              />
            )}
            {activeSection === "fundingbot" && (
              <FundingBot
                coin={coin}
                theme={theme}
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
              />
            )}
            {activeSection === "riskcalc" && (
              <BlurGate
                requiredTier="pro"
                featureName="Position Size Calculator"
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                className="bg-root--top"
              >
                <TradeManager onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />
              </BlurGate>
            )}
            <div style={{ display: activeSection === "candleai" ? "contents" : "none" }}>
              <CandleWatcher
                coin={coin}
                theme={theme}
                visible={activeSection === "candleai"}
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
              />
            </div>
            {activeSection === "markets" && <GlobalMarkets />}
            {activeSection === "altanalysis" && (
              <BlurGate
                requiredTier="elite"
                featureName="Alt Analysis"
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                className="bg-root--top"
              >
                <AltAnalysis
                  onOpenUpgrade={onOpenUpgrade ?? (() => {})}
                  onOpenAuth={onOpenAuth ?? (() => {})}
                />
              </BlurGate>
            )}
            {activeSection === "options" && (
              <BlurGate
                requiredTier="pro"
                featureName="Options Analytics"
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                className="bg-root--top"
              >
                <OptionsAnalytics />
              </BlurGate>
            )}
            {activeSection === "correlation" && (
              <BlurGate
                requiredTier="pro"
                featureName="Correlation Matrix"
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                className="bg-root--top"
              >
                <CorrelationMatrix />
              </BlurGate>
            )}
          </div>
        </div>

        <aside
          className={`side-panel${showWatchlist ? "" : " side-panel--hidden"}`}
        >
          <button
            className="side-panel-edge"
            onClick={() => setShowWatchlist((v) => !v)}
            aria-label={showWatchlist ? "Hide watchlist" : "Show watchlist"}
          />
          <Watchlist
            onSelectCoin={(symbol) => {
              setCoin(symbol as CoinSymbol);
              clearCandleCache();
              setActiveSection("chart");
            }}
          />
        </aside>

        <ChatInterface btcData={btcData} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />

        {coinPickerOpen &&
          ReactDOM.createPortal(
            <>
              <div className="coin-picker-backdrop" onClick={closeCoinPicker} />
              <div
                className="coin-picker-menu"
                style={{ top: coinPickerPos.top, left: coinPickerPos.left }}
              >
                <div className="coin-picker-search-wrap">
                  <svg
                    className="coin-picker-search-icon"
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    className="coin-picker-search-input"
                    placeholder="Search…"
                    autoFocus
                    value={coinSearch}
                    onChange={(e) => setCoinSearch(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {coinSearch && (
                    <button
                      className="coin-picker-search-clear"
                      onClick={() => setCoinSearch("")}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <ul className="coin-picker-list">
                  {COINS.filter((c) => {
                    if (!coinSearch) return true;
                    const q = coinSearch.toLowerCase();
                    return (
                      c.symbol.toLowerCase().includes(q) ||
                      c.name.toLowerCase().includes(q)
                    );
                  }).map((c) => {
                    const mc = coinMarketCaps.get(c.symbol);
                    const mcLabel =
                      mc == null
                        ? null
                        : mc >= 1e12
                          ? `$${(mc / 1e12).toFixed(2)}T`
                          : mc >= 1e9
                            ? `$${(mc / 1e9).toFixed(1)}B`
                            : mc >= 1e6
                              ? `$${(mc / 1e6).toFixed(0)}M`
                              : null;
                    const tk = coinTickers.get(c.symbol);
                    const fmtP = (n: number) =>
                      n >= 10000
                        ? `$${(n / 1000).toFixed(1)}K`
                        : n >= 1
                          ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                          : `$${n.toFixed(4)}`;
                    return (
                      <li
                        key={c.symbol}
                        className={`coin-picker-item${c.symbol === coin ? " active" : ""}`}
                        onClick={() => {
                          setCoin(c.symbol);
                          clearCandleCache();
                          closeCoinPicker();
                        }}
                      >
                        <span className="coin-picker-item-icon">
                          {COIN_ICONS[c.symbol] ?? c.symbol[0]}
                        </span>
                        <span className="coin-picker-item-name">{c.name}</span>
                        <span className="coin-picker-item-right">
                          <span className="coin-picker-item-row1">
                            <span className="coin-picker-item-sym">
                              {c.symbol}
                            </span>
                            {mcLabel && (
                              <span className="coin-picker-item-mc">
                                {mcLabel}
                              </span>
                            )}
                          </span>
                          <span className="coin-picker-item-hl">
                            {tk ? (
                              <>
                                <span className="coin-picker-hl-high">
                                  {fmtP(tk.high)}
                                </span>
                                <span className="coin-picker-hl-sep">/</span>
                                <span className="coin-picker-hl-low">
                                  {fmtP(tk.low)}
                                </span>
                              </>
                            ) : (
                              <span className="coin-picker-hl-na">N/A</span>
                            )}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>,
            document.body,
          )}

        <GlobalSearch
          open={globalSearch}
          onClose={() => setGlobalSearch(false)}
          onCoinSelect={(c) => {
            setCoin(c);
            clearCandleCache();
            setActiveSection("chart");
          }}
          onSectionSelect={(s) => setActiveSection(s as SectionId)}
        />

        {assetPanelOpen && (
          <div
            className="asset-modal-overlay"
            onClick={() => setAssetPanelOpen(false)}
          >
            <div
              className="asset-modal-panel"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="asset-panel-header">
                <h2>{t("assetCalc.title")}</h2>
                <div className="asset-panel-header-actions">
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) importPositionsFromFile(file);
                      e.target.value = "";
                    }}
                  />
                  <button
                    className={`asset-icon-btn${importStatus === "done" ? " success" : importStatus === "error" ? " error" : ""}`}
                    onClick={() => importFileInputRef.current?.click()}
                    title={t("assetCalc.importHint")}
                  >
                    <span className="asset-icon-btn-glyph">↑</span> {t("assetCalc.import")}
                  </button>
                  <button
                    className={`asset-icon-btn${exportStatus === "done" ? " success" : exportStatus === "error" ? " error" : ""}`}
                    onClick={exportPositions}
                    title={t("assetCalc.exportHint")}
                  >
                    <span className="asset-icon-btn-glyph">↓</span> {t("assetCalc.export")}
                  </button>
                  <button
                    className="asset-close-btn"
                    onClick={() => setAssetPanelOpen(false)}
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="asset-modal-content">
                <div className="asset-positions-list">
                  {positions.map((pos) => {
                    const meta = CATALOG.find((c) => c.id === pos.catalogId);
                    const symbol = meta?.symbol ?? "";
                    const price = positionPrices.get(symbol);
                    const amount = Number(pos.amount) || 0;
                    const cost = Number(pos.cost) || 0;
                    const value = price ? amount * price : 0;
                    const pnl = value - amount * cost;
                    return (
                      <div className="asset-position-row" key={pos.id}>
                        <select
                          className="coin-select asset-position-coin"
                          value={pos.catalogId}
                          onChange={(e) =>
                            updatePosition(pos.id, { catalogId: e.target.value })
                          }
                        >
                          {CATALOG.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.symbol} — {c.name}
                            </option>
                          ))}
                        </select>

                        <input
                          type="number"
                          min="0"
                          step="0.0001"
                          className="asset-position-input"
                          value={pos.amount}
                          onFocus={() =>
                            pos.amount === "0" && updatePosition(pos.id, { amount: "" })
                          }
                          onChange={(e) =>
                            updatePosition(pos.id, { amount: e.target.value })
                          }
                          placeholder={t("assetCalc.amountLabel", { coin: symbol })}
                        />

                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="asset-position-input"
                          value={pos.cost}
                          onFocus={() =>
                            pos.cost === "0" && updatePosition(pos.id, { cost: "" })
                          }
                          onChange={(e) =>
                            updatePosition(pos.id, { cost: e.target.value })
                          }
                          placeholder={t("assetCalc.costLabel", { coin: symbol })}
                        />

                        <div className="asset-position-result">
                          <span className="asset-position-live-price">
                            {price ? t("assetCalc.priceAt", { price: formatCurrency(price) }) : "—"}
                          </span>
                          <span
                            className={`asset-position-pnl${pnl >= 0 ? " positive" : " negative"}`}
                          >
                            {amount > 0 ? `${pnl >= 0 ? "+" : ""}${formatCurrency(pnl)}` : "—"}
                          </span>
                        </div>

                        <button
                          className="asset-position-remove"
                          onClick={() => removePosition(pos.id)}
                          disabled={positions.length === 1}
                          title={t("assetCalc.removePosition")}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>

                <button className="asset-add-btn" onClick={addPosition}>
                  {t("assetCalc.addPosition")}
                </button>

                <div className="asset-value-card">
                  <span>{t("assetCalc.totalLabel")}</span>
                  <strong>{formatCurrency(totalAssetValue)}</strong>
                  <p className="asset-cost">
                    {t("assetCalc.costBasis", {
                      amount: formatCurrency(totalCostBasis),
                    })}
                  </p>
                  <p
                    className={`asset-pnl ${profitLoss >= 0 ? "positive" : "negative"}`}
                  >
                    {profitLoss >= 0 ? "+" : ""}
                    {formatCurrency(profitLoss)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {priceAlert && (
          <div
            key={priceAlert.key}
            className={`price-alert price-alert--${priceAlert.type}`}
          >
            <div className="price-alert-label">{t("alert.signalLabel")}</div>
            <div className="price-alert-message">{priceAlert.message}</div>
          </div>
        )}

        <WhaleAlerts btcPrice={btcData?.price} />

        {swipeHint && (
          <div className="swipe-hint">
            <div className="swipe-hint-hand">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </div>
            <span>{t("nav.swipeHint")}</span>
          </div>
        )}
      </div>
      {/* end app-shell-body */}

      <DailyBrief />

      {priceTicker &&
        (pipWindow
          ? ReactDOM.createPortal(
              <PriceTickerFullscreen
                coin={coin}
                theme={theme}
                livePrice={livePrice}
                btcPrice={btcData?.price}
                openPrice={tickerOpenPrice.current}
                tickerFlash={tickerFlash}
                tickerMuted={tickerMuted}
                onToggleMute={() => setTickerMuted((v) => !v)}
                rockets={rockets}
                onExit={() => {
                  closePip();
                  setPriceTicker(false);
                }}
                isPopped
              />,
              pipWindow.document.body,
            )
          : (
            <PriceTickerFullscreen
              coin={coin}
              theme={theme}
              livePrice={livePrice}
              btcPrice={btcData?.price}
              openPrice={tickerOpenPrice.current}
              tickerFlash={tickerFlash}
              tickerMuted={tickerMuted}
              onToggleMute={() => setTickerMuted((v) => !v)}
              rockets={rockets}
              onExit={() => setPriceTicker(false)}
              onPopOut={pipSupported ? () => requestPip() : undefined}
            />
          ))}
    </div>
    <BtcMoveToast alert={notificationsEnabled ? btcMoveAlert : null} onDismiss={dismissBtcAlert} />
    </>
  );
}

/* ── Auth gate — decides what to render based on auth state ── */
function AppGate() {
  const { user, profile, profileLoading, loading: authLoading, refreshProfile } = useAuth();
  const [minTimeElapsed, setMinTimeElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinTimeElapsed(true), 1000);
    return () => clearTimeout(t);
  }, []);
  const [showAuth, setShowAuth] = useState(false);
  const [authView, setAuthView] = useState<"login" | "signup">("login");
  const [showUpgrade, setShowUpgrade] = useState(false);

  const [theme, setThemeState] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Follow the OS theme live until the user makes an explicit choice
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem("theme")) setThemeState(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  const setTheme = (t: "dark" | "light") => {
    localStorage.setItem("theme", t);
    setThemeState(t);
  };

  // Sync pending terms agreement to DB once user is authenticated
  useEffect(() => {
    if (!user) return;
    const pending = localStorage.getItem("terms_agreed_at");
    if (!pending) return;
    saveTermsAgreement(user.id, pending).then(() => {
      localStorage.removeItem("terms_agreed_at");
      refreshProfile();
    });
  }, [user]);

  // Handle Stripe return — poll until tier changes (webhook is async)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") === "cancelled") {
      window.history.replaceState({}, "", "/");
      return;
    }
    if (params.get("payment") !== "success" || !user) return;
    window.history.replaceState({}, "", "/");

    let attempts = 0;
    const poll = async () => {
      await refreshProfile();
      attempts++;
      if (attempts < 10) setTimeout(poll, 2000); // retry every 2s for up to 20s
    };
    poll();
  }, [user]);

  // Blank screen while Supabase resolves the session — prevents any flicker
  if (authLoading || (user && profileLoading) || (user && !minTimeElapsed))
    return (
      <div className="app-boot-screen">
        <CoinHintzLogo loading={true} />
      </div>
    );

  // Gate: signed in but hasn't agreed to terms yet (covers first-time OAuth users)
  if (user && profile && !profile.terms_agreed_at) {
    return <TermsGateModal userId={user.id} onAgreed={refreshProfile} />;
  }

  if (!user) {
    return (
      <>
        <LandingPage
          onSignIn={() => {
            setAuthView("login");
            setShowAuth(true);
          }}
          onSignUp={() => {
            setAuthView("signup");
            setShowAuth(true);
          }}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        />
        {showAuth && (
          <AuthModal
            onClose={() => setShowAuth(false)}
            initialView={authView}
          />
        )}
      </>
    );
  }

  return (
    <>
      <AppDashboard
        onOpenAuth={() => setShowAuth(true)}
        onOpenUpgrade={() => setShowUpgrade(true)}
        theme={theme}
        setTheme={setTheme}
      />
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showUpgrade && (
        <UpgradeModal
          onClose={() => setShowUpgrade(false)}
          onOpenAuth={() => {
            setShowUpgrade(false);
            setShowAuth(true);
          }}
        />
      )}
      <ResolutionBanner />
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppGate />
    </AuthProvider>
  );
}

export default App;
