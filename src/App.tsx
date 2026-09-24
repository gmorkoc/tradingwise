import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { usePullToRefresh } from "./hooks/usePullToRefresh";
import {
  coinglass,
  BTCData,
  CoinSymbol,
  clearCandleCache,
  COINS,
  fetchCoinMarketCaps,
  fetchCoin24hTickers,
  Ticker24h,
  fetchBn,
} from "./services/coinglass";
import { CATALOG } from "./services/coinCatalog";
// Cash is an Asset Calculator-only concept — deliberately NOT added to the
// shared CATALOG, which Watchlist/price-fetching/search all iterate over
// assuming every entry is a real tradeable coin with a Binance pair.
const CASH_ID = "cash";
import { fetchBinancePrices } from "./services/binancePrices";
import { consumePendingCoinMention } from "./services/pushNotifications";
import { initWebPushMessageRouting } from "./services/webPush";
import { Drawer } from "./components/Drawer";
import { AccountMenu } from "./components/AccountMenu";
import { LearnSection } from "./components/LearnSection";
import { LeveragePopup } from "./components/LeveragePopup";
import { CoinHintzLogo } from "./components/CoinHintzLogo";
import { PriceAlerts } from "./components/PriceAlerts";
import { BuySignals } from "./components/BuySignals";
import { ProfilePage } from "./components/ProfilePage";
import { TutorialPage } from "./components/TutorialPage";
import { OrderBook } from "./components/OrderBook";
import { CoinChat } from "./components/CoinChat";
import { Avatar } from "./components/Avatar";
import { Watchlist } from "./components/Watchlist";
import { TopMoversCarousel } from "./components/TopMoversCarousel";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { DailyBrief } from "./components/DailyBrief";
import { PushToast } from "./components/PushToast";
import { WhaleAlerts } from "./components/WhaleAlerts";
import { AuthModal } from "./components/AuthModal";
import { BlurGate } from "./components/MembershipGate";
import { UpgradeModal } from "./components/UpgradeModal";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { LandingPage } from "./components/LandingPage";
import { PriceTickerFullscreen } from "./components/PriceTickerFullscreen";
import { PriceChart, formatLivePrice } from "./components/PriceChart";
import { SectionBanner } from "./components/SectionBanner";
import { HoverTip } from "./components/HoverTip";
import { GlobalSearch } from "./components/GlobalSearch";
import { BtcMoveToast } from "./components/BtcMoveToast";
import { useBtcMoveAlert } from "./hooks/useBtcMoveAlert";
import { useNotificationsEnabled } from "./hooks/useNotificationsEnabled";
import { usePictureInPictureWindow } from "./hooks/usePictureInPictureWindow";
import { ZoneResult } from "./components/PriceChart.types";
import { Tier, saveTermsAgreement } from "./services/supabase";
import { ContactForm } from "./components/ContactForm";
import { ChartAnalyzeModal } from "./components/ChartAnalyzeModal";
import { ResolutionBanner } from "./components/ResolutionBanner";
import TermsGateModal from "./components/TermsGateModal";
import UsernameGateModal from "./components/UsernameGateModal";
import { PortfolioValueChart } from "./components/PortfolioValueChart";
import "./App.css";

// Everything below is behind a section nav tab — only one is ever visible at a
// time, so each ships as its own chunk fetched on first visit instead of
// bloating the initial bundle every user pays for regardless of which
// sections they actually open. PriceChart stays a static import above
// since "chart" is the default section, needed immediately on load.
const LiquidationHeatmap = lazy(() => import("./components/LiquidationHeatmap").then(m => ({ default: m.LiquidationHeatmap })));
const HTFAnalysis = lazy(() => import("./components/HTFAnalysis").then(m => ({ default: m.HTFAnalysis })));
const OnChainMetrics = lazy(() => import("./components/OnChainMetrics").then(m => ({ default: m.OnChainMetrics })));
const PositionFlows = lazy(() => import("./components/PositionFlows").then(m => ({ default: m.PositionFlows })));
const OrderFlowFramework = lazy(() => import("./components/OrderFlowFramework").then(m => ({ default: m.OrderFlowFramework })));
const PredictionEngine = lazy(() => import("./components/PredictionEngine").then(m => ({ default: m.PredictionEngine })));
const FundingBot = lazy(() => import("./components/FundingBot").then(m => ({ default: m.FundingBot })));
const CandleWatcher = lazy(() => import("./components/CandleWatcher").then(m => ({ default: m.CandleWatcher })));
const TradeManager = lazy(() => import("./components/TradeManager").then(m => ({ default: m.TradeManager })));
const GlobalMarkets = lazy(() => import("./components/GlobalMarkets").then(m => ({ default: m.GlobalMarkets })));
const AltAnalysis = lazy(() => import("./components/AltAnalysis").then(m => ({ default: m.AltAnalysis })));
const OptionsAnalytics = lazy(() => import("./components/OptionsAnalytics").then(m => ({ default: m.OptionsAnalytics })));
const CorrelationMatrix = lazy(() => import("./components/CorrelationMatrix").then(m => ({ default: m.CorrelationMatrix })));
const StrategyAlerts = lazy(() => import("./components/StrategyAlerts").then(m => ({ default: m.StrategyAlerts })));

// Shown briefly the first time a section's chunk is fetched — negligible
// on subsequent visits since the chunk stays cached.
function SectionLoading() {
  return (
    <div className="section-loading">
      <div className="section-loading-spinner" />
    </div>
  );
}

type SectionId =
  | "chart"
  | "heatmap"
  | "onchain"
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
  | "correlation"
  | "strategyalerts";

interface Position { id: string; catalogId: string; amount: string; cost: string }

let positionIdSeq = 0;
const makePositionId = () => `pos-${Date.now()}-${positionIdSeq++}`;

type NavCategoryId = "market" | "technical" | "trading";

// Order here is also render order — Chart/Candle AI stay flat above all
// three (used constantly, don't bury them behind a click), everything
// else groups into one of these three collapsible sections.
const NAV_CATEGORIES: { id: NavCategoryId; labelKey: string; d: string | string[] }[] = [
  {
    id: "market",
    labelKey: "nav.catMarketData",
    // Bar chart — market data at a glance.
    d: ["M5 21V13", "M12 21V7", "M19 21V11"],
  },
  {
    id: "technical",
    labelKey: "nav.catTechnical",
    // Activity/pulse line — technical analysis of price action.
    d: "M3 12h4l3 8 4-16 3 8h4",
  },
  {
    id: "trading",
    labelKey: "nav.catTradingTools",
    // Wrench — tools.
    d: "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z",
  },
];

const NAV_ITEMS: {
  id: SectionId;
  labelKey: string;
  d: string | string[];
  requiredTier?: Tier;
  hidden?: boolean;
  category?: NavCategoryId;
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
    category: "market",
    d: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"],
  },
  {
    id: "onchain",
    labelKey: "nav.onchain",
    requiredTier: "pro",
    category: "market",
    d: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
  },
  {
    id: "positions",
    labelKey: "nav.positions",
    category: "trading",
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
    category: "technical",
    d: ["M3 3v18h18", "M7 7l5 5 5-5", "M7 12l5 5 5-5"],
  },
  { id: "orderflow", labelKey: "nav.orderflow", category: "technical", d: ["M2 12h4l3-9 4 18 3-9h6"] },
  {
    id: "signals",
    labelKey: "nav.signals",
    category: "technical",
    d: ["M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 3.9 2.4-7.4L2 9.4h7.6z"],
  },
  {
    id: "fundingbot",
    labelKey: "nav.fundingbot",
    category: "trading",
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
    category: "trading",
    d: ["M21 4H8", "M3 4h.01", "M21 12H11", "M3 12h.01", "M21 20H8", "M3 20h.01", "M8 2v4", "M11 10v4", "M8 18v4"],
  },
  {
    id: "markets",
    labelKey: "nav.markets",
    category: "market",
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
    category: "market",
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
    category: "market",
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
    category: "market",
    d: [
      "M9 18a6 6 0 1 0 0 -12 6 6 0 0 0 0 12",
      "M15 18a6 6 0 1 0 0 -12 6 6 0 0 0 0 12",
    ],
  },
  {
    id: "strategyalerts",
    labelKey: "nav.strategyalerts",
    requiredTier: "pro",
    category: "trading",
    d: [
      "M4 15s1 -1 4 -1 5 2 8 2 4 -1 4 -1V3s-1 1 -4 1 -5 -2 -8 -2 -4 1 -4 1z",
      "M4 22V15",
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

const RECENT_COINS_KEY = "recentCoinSearches";
const MAX_RECENT_COINS = 6;

function loadRecentCoins(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_COINS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function addRecentCoin(symbol: string): string[] {
  try {
    const next = [symbol, ...loadRecentCoins().filter((s) => s !== symbol)].slice(0, MAX_RECENT_COINS);
    localStorage.setItem(RECENT_COINS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadRecentCoins();
  }
}

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
  // CandleWatcher stays mounted (display:none, not unmounted) once first
  // opened so its chart state/zoom/drawings survive switching away and
  // back — but deferring that first mount until actually visited (instead
  // of unconditionally, as before) means its ~4000-line chunk isn't
  // fetched on every app load for users who never open this section.
  const [candleAIVisited, setCandleAIVisited] = useState(() => activeSection === "candleai");
  useEffect(() => {
    if (activeSection === "candleai") setCandleAIVisited(true);
  }, [activeSection]);
  // Nav accordion — which of the three collapsible categories is open.
  // Defaults to whichever one contains the current section (so landing on
  // e.g. #correlation opens Market Data automatically); all closed
  // otherwise (e.g. landing on Chart/Candle AI) — manually toggling a
  // category (see the nav item's onClick below) still behaves as a
  // single-category accordion regardless of this default.
  const [openNavCategory, setOpenNavCategory] = useState<NavCategoryId | null>(
    () => NAV_ITEMS.find((n) => n.id === activeSection)?.category ?? null,
  );
  // Same convention as CoinChat.tsx's own useIsDesktop — desktop web
  // relocates the account menu into .top-nav-bar instead of the nav drawer.
  const [isDesktopWidth, setIsDesktopWidth] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 641px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktopWidth(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  // Wider than the tablet tier (641-960px, still the two-panel stacked
  // chart+order-book layout) — full desktop gets Chart/Order Book tabs
  // just like phones, freeing up the right side for an always-visible
  // Daily Brief sidebar (.db-page, DailyBrief.css) instead of a floating
  // sheet. See the matching `min-width: 961px` block in App.css.
  const [isWideDesktop, setIsWideDesktop] = useState(() => window.matchMedia("(min-width: 961px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 961px)");
    const handler = (e: MediaQueryListEvent) => setIsWideDesktop(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  const [notificationsEnabled, setNotificationsEnabled] = useNotificationsEnabled();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingCheckedRef = useRef(false);
  const [showCoinChat, setShowCoinChat] = useState(
    () => localStorage.getItem("coinchat-visible") !== "false",
  );
  useEffect(() => {
    localStorage.setItem("coinchat-visible", String(showCoinChat));
  }, [showCoinChat]);
  // Coinbase-style rail toggle (desktop only, see icon-strip-focus below) —
  // hides Watchlist/Top Movers/Daily Brief so the chart is the only thing
  // on screen. Persisted the same way as every other rail preference here.
  const [distractionFree, setDistractionFree] = useState(
    () => localStorage.getItem("distraction-free") === "true",
  );
  useEffect(() => {
    localStorage.setItem("distraction-free", String(distractionFree));
  }, [distractionFree]);
  // Desktop-only: stretches the floating dock to near full viewport height
  // instead of its usual capped 640px. Not persisted — always starts
  // collapsed, same as every other transient UI toggle in this file.
  const [chatExpanded, setChatExpanded] = useState(false);

  const [coin, setCoin] = useState<CoinSymbol>(
    () => (localStorage.getItem("coin") as CoinSymbol) || "BTC",
  );

  useEffect(() => {
    localStorage.setItem("coin", coin);
  }, [coin]);

  // Follows the selected coin (not hardcoded to BTC) so the toast is
  // relevant to whatever chart is actually open.
  const { alert: btcMoveAlert, dismiss: dismissBtcAlert } = useBtcMoveAlert(coin);

  // Tapping a coin-mention push (pushNotifications.ts) jumps straight to
  // that comment: switch to its coin, open the chart + chat dock, and
  // hand the comment id down to CoinChat so it can scroll to/flash it.
  // Cleared via CoinChat's onHighlightDone callback once it's actually
  // been shown (or definitively can't be) rather than a fixed timer — the
  // target comment can need an extra network round-trip that a guessed
  // timeout would race against, especially on a cold app launch.
  const [highlightCommentId, setHighlightCommentId] = useState<number | null>(null);
  useEffect(() => {
    const applyCoinMention = (detail: { coin: string; commentId: number }) => {
      setCoin(detail.coin as CoinSymbol);
      clearCandleCache();
      setActiveSection("chart");
      setShowCoinChat(true);
      setHighlightCommentId(detail.commentId);
    };
    // A notification tap on a fully-killed app fires pushNotifications.ts's
    // listener (and thus this event) as soon as auth resolves — which is
    // before AppGate's boot screen (auth resolve + a hard-coded minimum 1s
    // delay, see AppGate below) finishes and mounts this component. A plain
    // dispatchEvent with nobody listening yet is just lost, so check for
    // one that already arrived before this listener existed too.
    const pending = consumePendingCoinMention();
    if (pending) applyCoinMention(pending);
    const onOpenCoinMention = (e: Event) => {
      const detail = (e as CustomEvent<{ coin: string; commentId: number }>).detail;
      if (detail) applyCoinMention(detail);
    };
    window.addEventListener("open-coin-mention", onOpenCoinMention);
    return () => window.removeEventListener("open-coin-mention", onOpenCoinMention);
  }, []);
  useEffect(() => {
    // StrategyAlerts.tsx has its own listener for the same event to switch
    // to its "My Strategies" tab — this one just navigates to the section.
    const onOpenStrategyAlert = () => setActiveSection("strategyalerts");
    window.addEventListener("open-strategy-alert", onOpenStrategyAlert);
    return () => window.removeEventListener("open-strategy-alert", onOpenStrategyAlert);
  }, []);
  useEffect(() => {
    // No-op on native (isWebPushAvailable() gates the actual subscription),
    // but safe/cheap to register unconditionally — just a message listener.
    initWebPushMessageRouting();
  }, []);
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
        const d = await fetchBn(`/api/v3/ticker/price?symbol=${sym}`);
        const parsed = parseFloat(d.price);
        // Never store NaN — {livePrice && <JSX/>} below treats NaN as
        // falsy like any other falsy value, but unlike null/false/undefined,
        // React renders a bare NaN as the literal text "NaN" instead of
        // skipping it, so a malformed response would show broken text
        // instead of just leaving the last good price on screen.
        if (!cancelled && Number.isFinite(parsed)) setLivePrice(parsed);
      } catch {
        /* ignore — includes an active Binance ban, handled by the circuit
           breaker in fetchBn, which skips the network call entirely */
      }
    };
    poll();
    // Dev runs this same effect through hot-reloads/StrictMode remounts on
    // top of every other chart/watchlist poll hitting the same rate limit —
    // a slower cadence locally meaningfully cuts total request volume
    // without changing the real-time feel users get in production.
    const id = setInterval(poll, import.meta.env.DEV ? 5000 : 1000);
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
      // Cash isn't in the shared CATALOG (that array backs Watchlist/price
      // fetching/search too — a "coin" with no real market would break all
      // of those) — it's a local sentinel just for this calculator, always
      // worth $1/unit, no price fetch needed.
      const isCash = p.catalogId === CASH_ID;
      const symbol = isCash ? "USD" : CATALOG.find(c => c.id === p.catalogId)?.symbol;
      const price = isCash ? 1 : (symbol ? positionPrices.get(symbol) : undefined);
      const amount = Number(p.amount) || 0;
      const cost = isCash ? 0 : (Number(p.cost) || 0);
      totalAssetValue += price ? amount * price : 0;
      totalCostBasis += isCash ? amount : amount * cost;
    }
    return { totalAssetValue, totalCostBasis, profitLoss: totalAssetValue - totalCostBasis };
  }, [positions, positionPrices]);
  const { totalAssetValue, totalCostBasis, profitLoss } = portfolioTotals;

  const portfolioHoldings = useMemo(
    () => positions.map(p => ({
      symbol: CATALOG.find(c => c.id === p.catalogId)?.symbol ?? "",
      amount: Number(p.amount) || 0,
    })).filter(h => h.symbol),
    [positions],
  );
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
  const [chartAnalyzeOpen, setChartAnalyzeOpen] = useState(false);
  const [coinPickerOpen, setCoinPickerOpen] = useState(false);
  const [coinSearch, setCoinSearch] = useState("");
  const [recentCoins, setRecentCoins] = useState<string[]>(loadRecentCoins);
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
  // Segmented Chart/Order Book tabs — real phones only (see App.css's own
  // max-width:640px block); desktop/tablet widths ignore this entirely and
  // keep showing both side by side, resizable.
  const [mobileChartTab, setMobileChartTab] = useState<"chart" | "orderbook">("chart");
  // Which way the tab switch is "moving" — Order Book is to the right, so
  // switching to it plays a bullish (green) swipe; back to Chart plays a
  // bearish (red) one. Purely cosmetic, replayed via the flash span's
  // `key` (see the JSX) — doesn't affect which tab actually shows.
  const [tabSwipeDir, setTabSwipeDir] = useState<"bull" | "bear">("bull");
  const [obSize, setObSize] = useState({ h: 380, w: 135 });
  const [obResizeIntro, setObResizeIntro] = useState(false);
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
  const mainContentRef = useRef<HTMLDivElement>(null);

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

  // Resize-affordance hint — mobile/tablet only (desktop's order book is a
  // fixed width, not resizable, so there's nothing to hint at there). Opens
  // at a 70/30 chart/order-book split, then eases to 85/15 shortly after, so
  // the order book visibly shrinks and draws the eye to the drag handle.
  useEffect(() => {
    if (activeSection !== "chart") return;
    const wrap = chartWrapRef.current;
    if (!wrap) return;
    if (window.innerWidth > 960) return; // desktop — order book isn't resizable there

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      const wrap2 = chartWrapRef.current;
      if (!wrap2) return;
      const axis = getComputedStyle(wrap2).flexDirection === "row" ? "row" : "col";
      const handlePx = axis === "row" ? 24 : 32;
      const total = (axis === "row" ? wrap2.clientWidth : wrap2.clientHeight) - handlePx;
      if (total <= 0) return;

      const startSize = Math.round(total * 0.30); // 70/30 split
      const endSize   = Math.round(total * 0.15); // 85/15 split
      setObSize(prev => (axis === "row" ? { ...prev, w: startSize } : { ...prev, h: startSize }));

      const t1 = setTimeout(() => {
        if (cancelled) return;
        setObResizeIntro(true);
        setObSize(prev => (axis === "row" ? { ...prev, w: endSize } : { ...prev, h: endSize }));
        const t2 = setTimeout(() => { if (!cancelled) setObResizeIntro(false); }, 700);
        return () => clearTimeout(t2);
      }, 500);
      return () => clearTimeout(t1);
    });

    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [activeSection]);

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
    // The search input has autoFocus, which pops the iOS keyboard. In the
    // native WKWebView app, dismissing it doesn't always fully revert the
    // viewport shift the keyboard caused, leaving the page stuck scrolled
    // down with a blank gap at the top. Blurring before the input unmounts
    // gives iOS a cleaner dismiss, and the scroll reset (after the keyboard
    // dismiss animation finishes) corrects it if that alone isn't enough.
    (document.activeElement as HTMLElement | null)?.blur?.();
    setCoinPickerOpen(false);
    setCoinSearch("");
    setTimeout(() => {
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
    }, 300);
  };

  const [leverageOpen, setLeverageOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [chartZone, setChartZone] = useState<ZoneResult | null>(null);
  const [chartPrice, setChartPrice] = useState(0);
  const [chartFullscreen, setChartFullscreen] = useState(false);

  // Value intentionally unread — the bullish/bearish banner render is
  // disabled below, but the computation stays wired up so it's a one-line
  // re-add (destructure priceAlert back in + restore the JSX) to bring back.
  const [, setPriceAlert] = useState<{
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

  // Sync URL hash to the active section.
  useEffect(() => {
    window.history.replaceState(null, "", `${window.location.search}#${activeSection}`);
  }, [activeSection]);

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

  // Native-only: iOS has no built-in pull-to-refresh for a WKWebView the
  // way a browser tab does, so this reimplements the gesture — reuses the
  // same refresh path as the header logo's manual refresh button.
  const {
    pullDistance: ptrPullDistance,
    progress: ptrProgress,
    refreshing: ptrRefreshing,
    dragging: ptrDragging,
  } = usePullToRefresh(mainContentRef, fetchBTCData, { enabled: Capacitor.isNativePlatform() });

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

  const renderNavItem = (item: (typeof NAV_ITEMS)[number]) => (
    <button
      key={item.id}
      className={`icon-strip-btn${activeSection === item.id ? " active" : ""}`}
      onClick={() => {
        setActiveSection(item.id);
        // Desktop-only: a flat item (never true for a category's own
        // sub-items) closes an open flyout panel instead of leaving it
        // open over a section it no longer matches. Guarded to desktop so
        // mobile's inline accordion state (which this same item.category
        // check would otherwise also touch) is never affected.
        if (isDesktopWidth && !item.category) setOpenNavCategory(null);
      }}
      title={t(item.labelKey)}
    >
      <span className="nav-icon-wrap">
        <NavIcon d={item.d} />
      </span>
      <span className="icon-strip-label">{t(item.labelKey)}</span>
    </button>
  );

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
        <ChartAnalyzeModal
          isOpen={chartAnalyzeOpen}
          onClose={() => setChartAnalyzeOpen(false)}
          onOpenUpgrade={onOpenUpgrade}
          onOpenAuth={onOpenAuth}
          coin={coin}
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
          <button
            type="button"
            className="mob-nav-profile mob-nav-profile--clickable"
            onClick={() => {
              setMobileNavOpen(false);
              if (user) setProfileOpen(true);
              else onOpenAuth();
            }}
          >
            <Avatar
              url={profile?.avatar_url}
              fallback={
                profile?.full_name
                  ? profile.full_name
                      .trim()
                      .split(/\s+/)
                      .map((w) => w[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()
                  : (user?.email?.[0] ?? "?").toUpperCase()
              }
              className="mob-nav-avatar"
            />
            <div className="mob-nav-userinfo">
              <span className="mob-nav-name">
                {profile?.full_name || user?.email?.split("@")[0] || "Account"}
              </span>
              <span className={`mob-nav-tier mob-nav-tier--${tier}`}>{tier.toUpperCase()}</span>
            </div>
            <span className="mob-nav-profile-arrow">›</span>
          </button>

          <div className="icon-strip-nav">
            {NAV_ITEMS.filter((item) => !item.hidden && !item.category).map(renderNavItem)}

            {NAV_CATEGORIES.map((cat) => {
              const items = NAV_ITEMS.filter((item) => !item.hidden && item.category === cat.id);
              const isOpen = openNavCategory === cat.id;
              // Desktop-only: highlight the category itself when the
              // current section is one of its items, even once its flyout
              // is closed again — separate from `isOpen` (which mobile's
              // own inline accordion still keys off unchanged) via its own
              // "current" class.
              const isCurrent = items.some((item) => item.id === activeSection);
              return (
                <div className="icon-strip-cat" key={cat.id}>
                  <button
                    type="button"
                    className={`icon-strip-cat-head${isOpen ? " open" : ""}${isCurrent ? " current" : ""}`}
                    onClick={() => setOpenNavCategory((prev) => (prev === cat.id ? null : cat.id))}
                  >
                    <span className="icon-strip-cat-icon nav-icon-wrap">
                      <NavIcon d={cat.d} />
                    </span>
                    <span className="icon-strip-cat-label">{t(cat.labelKey)}</span>
                    <svg className="icon-strip-cat-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                  </button>
                  <div className={`icon-strip-cat-items${isOpen ? "" : " collapsed"}`}>
                    {items.map(renderNavItem)}
                  </div>
                </div>
              );
            })}

            {/* Opens ChartAnalyzeModal directly rather than switching
                activeSection like every other item here — placed last,
                after every section/category, rather than among them.
                Every other item closes the mobile nav via the
                activeSection-change effect above; this one doesn't touch
                activeSection at all, so it has to close it explicitly. */}
            <button
              className="icon-strip-btn"
              onClick={() => {
                setChartAnalyzeOpen(true);
                setMobileNavOpen(false);
                if (isDesktopWidth) setOpenNavCategory(null);
              }}
              title={t("nav.analyzeChart")}
            >
              <span className="nav-icon-wrap">
                <NavIcon
                  d={[
                    "M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z",
                    "M16 13a4 4 0 11-8 0 4 4 0 018 0z",
                  ]}
                />
              </span>
              <span className="icon-strip-label">{t("nav.analyzeChart")}</span>
            </button>
          </div>

          {/* Desktop web relocates this whole block into .top-nav-bar
              (below, .main-panel) instead — mobile web and native iOS have
              no top bar, so they keep it here in the nav drawer as their
              only path to settings/sign-out. */}
          {!(!Capacitor.isNativePlatform() && isDesktopWidth) && (
            <div className="icon-strip-bottom">
              <div className="icon-strip-acct">
                <AccountMenu
                  onOpenAuth={onOpenAuth}
                  onOpenUpgrade={onOpenUpgrade}
                  onOpenProfile={() => setProfileOpen(true)}
                />
              </div>

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
            </div>
          )}

          {/* Coinbase-style rail toggle — desktop only, always the rail's
              last item regardless of whether icon-strip-bottom above it
              rendered (it doesn't on desktop web, see that block's own
              condition). */}
          {isDesktopWidth && (
            <button
              type="button"
              role="switch"
              aria-checked={distractionFree}
              aria-label={t("nav.focusMode", "Focus")}
              className={`icon-strip-btn icon-strip-focus${distractionFree ? " active" : ""}`}
              onClick={() => setDistractionFree((v) => !v)}
              title={t("nav.focusMode", "Focus")}
            >
              <span className="nav-icon-wrap">
                <NavIcon
                  d={[
                    "M4 21L4 14", "M4 10L4 3",
                    "M12 21L12 12", "M12 8L12 3",
                    "M20 21L20 16", "M20 12L20 3",
                    "M1 14L7 14", "M9 8L15 8", "M17 16L23 16",
                  ]}
                />
              </span>
              <span className="icon-strip-label">{t("nav.focusMode", "Focus")}</span>
              <span className={`icon-strip-focus-switch${distractionFree ? " on" : ""}`}>
                <span className="icon-strip-focus-knob" />
              </span>
            </button>
          )}
        </nav>

        {/* Desktop-only Coinbase-style flyout — replaces the inline
            accordion for min-width:641px (see .icon-strip-cat-items,
            forced display:none at that width in App.css); mobile keeps
            the original inline accordion untouched. */}
        {openNavCategory && (() => {
          const cat = NAV_CATEGORIES.find((c) => c.id === openNavCategory)!;
          const items = NAV_ITEMS.filter((item) => !item.hidden && item.category === cat.id);
          return (
            <>
              <div className="nav-cat-backdrop" onClick={() => setOpenNavCategory(null)} />
              <div className="nav-cat-panel">
                <div className="nav-cat-panel-header">
                  <button
                    type="button"
                    className="nav-cat-panel-close"
                    onClick={() => setOpenNavCategory(null)}
                    aria-label={t("common.close", "Close")}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="nav-cat-panel-title">{t(cat.labelKey)}</div>
                <div className="nav-cat-panel-items">
                  {items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`nav-cat-panel-item${activeSection === item.id ? " active" : ""}`}
                      onClick={() => {
                        setActiveSection(item.id);
                        setOpenNavCategory(null);
                      }}
                    >
                      <span className="nav-icon-wrap">
                        <NavIcon d={item.d} />
                      </span>
                      <span className="nav-cat-panel-item-label">{t(item.labelKey)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          );
        })()}

        <div className="main-panel">
          {!Capacitor.isNativePlatform() && isDesktopWidth && (
            <div className="top-nav-bar">
              <div className="top-nav-logo">
                coinhint<span className="top-nav-logo-accent">z</span>
              </div>
              <button
                className="top-nav-search"
                onClick={() => setGlobalSearch(true)}
                title="Search (⌘K)"
              >
                <span className="top-nav-search-text">
                  {t("search.placeholder", "Search coins, sections, features…")}
                </span>
                <span className="top-nav-search-btn">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
              </button>
              <div className="top-nav-icons">
                <AccountMenu
                  onOpenAuth={onOpenAuth}
                  onOpenUpgrade={onOpenUpgrade}
                  onOpenProfile={() => setProfileOpen(true)}
                  iconFallback
                />
                <button
                  className="top-nav-icon-btn"
                  onClick={() => setDrawerOpen(true)}
                  title={t("drawer.settings")}
                >
                  <NavIcon
                    d={[
                      "M12 15a3 3 0 100-6 3 3 0 000 6z",
                      "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
                    ]}
                  />
                </button>
                <button
                  className="top-nav-icon-btn"
                  onClick={() => signOut()}
                  title={t("nav.signOut")}
                >
                  <NavIcon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
                </button>
              </div>
            </div>
          )}
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
                className={`mch-coin-btn${
                  coinTickers.get(coin)?.change !== undefined
                    ? (coinTickers.get(coin)!.change >= 0 ? " mch-coin-btn--up" : " mch-coin-btn--down")
                    : " mch-coin-btn--pending"
                }`}
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
                  {Number.isFinite(livePrice ?? btcData?.price) && (
                    <span className="mch-coin-price">
                      {formatLivePrice(livePrice ?? btcData!.price!)}
                    </span>
                  )}
                  <span className="price-source">
                    via Binance{" "}
                    <span className="price-source-fs-hint">
                      ⛶ Double-click chart for fullscreen
                    </span>
                  </span>
                </div>
                {/* Mobile-only badge (see .mch-coin-chg in App.css) — desktop
                    keeps the full .mch-stats ticker row instead, so this
                    stays hidden there to avoid saying the same thing twice. */}
                {coinTickers.get(coin)?.change !== undefined && (
                  <span className={`mch-coin-chg${coinTickers.get(coin)!.change >= 0 ? " mch-coin-chg--up" : " mch-coin-chg--down"}`}>
                    {coinTickers.get(coin)!.change >= 0 ? "▲" : "▼"} {Math.abs(coinTickers.get(coin)!.change).toFixed(1)}%
                  </span>
                )}
                <span className="mch-coin-chevron">▾</span>
              </button>
            </div>

            <div className="mch-stats">
              {btcData &&
                (() => {
                  // ?? only falls back on null/undefined — NaN slips through
                  // and, unlike other falsy values, React renders a bare NaN
                  // as the literal text "NaN" instead of just being falsy.
                  const fr = Number.isFinite(btcData.fundingRate) ? btcData.fundingRate! : 0;
                  const rsi = Number.isFinite(btcData.rsi) ? btcData.rsi! : 50;
                  const macd = Number.isFinite(btcData.macd) ? btcData.macd! : 0;
                  const ls = Number.isFinite(btcData.longShortRatio) ? btcData.longShortRatio! : 1;
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
                      {Number.isFinite(livePrice ?? btcData.price) && (
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
              <PriceAlerts coin={coin} currentPrice={btcData?.price ?? 0} coinChatOpen={activeSection === "chart" && showCoinChat} />
              <BuySignals onOpenUpgrade={onOpenUpgrade} />
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
            ref={mainContentRef}
            className={`main-content${activeSection === "chart" ? " chart-active" : ""}`}
          >
            <div
              className={`ptr-indicator${!ptrDragging ? " ptr-indicator--settling" : ""}`}
              style={{ height: ptrPullDistance }}
            >
              {(ptrPullDistance > 0 || ptrRefreshing) && (
                <div
                  className={`ptr-spinner${ptrRefreshing ? " ptr-spinner--spinning" : ""}`}
                  style={!ptrRefreshing ? { transform: `rotate(${ptrProgress * 360}deg)` } : undefined}
                />
              )}
            </div>
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
                {!distractionFree && (
                  <Watchlist
                    onSelectCoin={(symbol) => {
                      setCoin(symbol as CoinSymbol);
                      clearCandleCache();
                    }}
                  />
                )}
                <div className="chart-page-row">
                  <div className="chart-column">
                    {!distractionFree && (
                      <TopMoversCarousel
                        onSelectCoin={(symbol) => {
                          setCoin(symbol as CoinSymbol);
                          clearCandleCache();
                        }}
                      />
                    )}
                    <div className="chart-mobile-tabs">
                      <div className={`chart-mobile-tab-indicator chart-mobile-tab-indicator--${mobileChartTab}`} />
                      <span key={mobileChartTab} className={`chart-mobile-tab-flash chart-mobile-tab-flash--${mobileChartTab} chart-mobile-tab-flash--${tabSwipeDir}`} />
                      <button
                        type="button"
                        className={`chart-mobile-tab${mobileChartTab === "chart" ? " active" : ""}`}
                        onClick={() => {
                          if (mobileChartTab !== "chart") setTabSwipeDir("bear");
                          setMobileChartTab("chart");
                        }}
                      >
                        {t("chart.tabLabel", "Chart")}
                      </button>
                      <button
                        type="button"
                        className={`chart-mobile-tab${mobileChartTab === "orderbook" ? " active" : ""}`}
                        onClick={() => {
                          if (mobileChartTab !== "orderbook") setTabSwipeDir("bull");
                          setMobileChartTab("orderbook");
                        }}
                      >
                        {t("orderBook.title")}
                      </button>
                    </div>
                    <div
                      className={`chart-section-wrap${obResizeIntro ? " chart-section-wrap--resize-intro" : ""} chart-section-wrap--tab-${mobileChartTab}`}
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
                        onFullscreenChange={setChartFullscreen}
                        coinChatOpen={showCoinChat}
                        onToggleCoinChat={() => setShowCoinChat((v) => !v)}
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
                  </div>
                  {isWideDesktop && !distractionFree && (
                    <DailyBrief coinTickers={coinTickers} variant="page" />
                  )}
                </div>
              </>
            )}
            {activeSection !== "chart" && (
              <SectionBanner section={activeSection} />
            )}
            <Suspense fallback={<SectionLoading />}>
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
              {activeSection === "strategyalerts" && (
                <BlurGate
                  requiredTier="pro"
                  featureName="Strategy Alerts"
                  onOpenAuth={onOpenAuth}
                  onOpenUpgrade={onOpenUpgrade}
                  className="bg-root--top"
                >
                  <StrategyAlerts />
                </BlurGate>
              )}
            </Suspense>
            {candleAIVisited && (
              <div style={{ display: activeSection === "candleai" ? "contents" : "none" }}>
                <Suspense fallback={activeSection === "candleai" ? <SectionLoading /> : null}>
                  <CandleWatcher
                    coin={coin}
                    theme={theme}
                    visible={activeSection === "candleai"}
                    onOpenAuth={onOpenAuth}
                    onOpenUpgrade={onOpenUpgrade}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </div>

        {activeSection === "chart" && (
          <aside
            className={`coin-chat-dock${showCoinChat ? " coin-chat-dock--open" : ""}${chatExpanded ? " coin-chat-dock--expanded" : ""}`}
          >
            <CoinChat
              coin={coin}
              onOpenAuth={onOpenAuth}
              onOpenUpgrade={onOpenUpgrade}
              onCloseDesktop={() => { setShowCoinChat(false); setChatExpanded(false); }}
              expanded={chatExpanded}
              onToggleExpand={() => setChatExpanded((v) => !v)}
              isOpen={showCoinChat}
              highlightCommentId={highlightCommentId}
              onHighlightDone={() => setHighlightCommentId(null)}
            />
            <button
              type="button"
              className="coin-chat-dock-bar"
              onClick={() => {
                // Also drop expanded mode when hiding — .coin-chat-card
                // switches to height:auto while expanded (CoinChat.css),
                // and collapsing straight from an auto-computed height to
                // 0 doesn't animate reliably (some engines just snap, some
                // visibly glitch mid-transition instead of collapsing),
                // which read as the panel "freezing" open on a long thread
                // tall enough for the difference to be obvious. Collapsing
                // from expanded's fixed 588px first avoids that entirely.
                setShowCoinChat((v) => !v);
                setChatExpanded(false);
              }}
              aria-label={showCoinChat ? t("coinChat.hide") : t("coinChat.triggerLabel")}
            >
              <span className="coin-chat-dock-bar-dot" />
              <span className="coin-chat-dock-bar-label">{t("coinChat.triggerLabel")}</span>
              <span className="coin-chat-dock-bar-right">
                {showCoinChat && (
                  <span className="coin-chat-dock-bar-action">{t("coinChat.hide")}</span>
                )}
                <span className={`coin-chat-dock-bar-chev${showCoinChat ? " coin-chat-dock-bar-chev--up" : ""}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </span>
              </span>
            </button>
          </aside>
        )}

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
                  }).sort((a, b) => {
                    // Recently-picked coins float to the top, most recent
                    // first — everything else keeps its original order
                    // (Array.sort is stable) below them.
                    const ai = recentCoins.indexOf(a.symbol);
                    const bi = recentCoins.indexOf(b.symbol);
                    if (ai === -1 && bi === -1) return 0;
                    if (ai === -1) return 1;
                    if (bi === -1) return -1;
                    return ai - bi;
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
                          setRecentCoins(addRecentCoin(c.symbol));
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
                <PortfolioValueChart holdings={portfolioHoldings} formatCurrency={formatCurrency} />

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

                <div className="asset-positions-list">
                  {positions.map((pos) => {
                    const isCash = pos.catalogId === CASH_ID;
                    const meta = CATALOG.find((c) => c.id === pos.catalogId);
                    const symbol = isCash ? "USD" : (meta?.symbol ?? "");
                    const price = isCash ? 1 : positionPrices.get(symbol);
                    const amount = Number(pos.amount) || 0;
                    const cost = isCash ? 0 : (Number(pos.cost) || 0);
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
                          <option value={CASH_ID}>💵 Cash (USD)</option>
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
                          placeholder={isCash ? t("assetCalc.cashLabel") : t("assetCalc.amountLabel", { coin: symbol })}
                        />

                        {/* Cost basis doesn't mean anything for cash — a dollar
                            is always worth a dollar, no P&L to track. Kept as
                            a real (disabled) <input>, not a swapped-out <div>
                            — the mobile grid layout positions these fields by
                            :nth-of-type(input), which a differently-tagged
                            element would silently fall out of. */}
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          className="asset-position-input"
                          disabled={isCash}
                          value={isCash ? "" : pos.cost}
                          onFocus={() =>
                            pos.cost === "0" && updatePosition(pos.id, { cost: "" })
                          }
                          onChange={(e) =>
                            updatePosition(pos.id, { cost: e.target.value })
                          }
                          placeholder={isCash ? "—" : t("assetCalc.costLabel", { coin: symbol })}
                        />

                        <div className="asset-position-result">
                          {isCash ? (
                            <span className="asset-position-live-price">{t("assetCalc.cashNote")}</span>
                          ) : (
                            <>
                              <span className="asset-position-live-price">
                                {price ? t("assetCalc.priceAt", { price: formatCurrency(price) }) : "—"}
                              </span>
                              <span
                                className={`asset-position-pnl${pnl >= 0 ? " positive" : " negative"}`}
                              >
                                {amount > 0 ? `${pnl >= 0 ? "+" : ""}${formatCurrency(pnl)}` : "—"}
                              </span>
                            </>
                          )}
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
              </div>
            </div>
          </div>
        )}

        {/* Price signal banner (bullish/bearish) hidden for now — see
            priceAlert state above, logic left intact to re-enable easily. */}

        <WhaleAlerts btcPrice={btcData?.price} coinChatOpen={activeSection === "chart" && showCoinChat} />

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

      {!isWideDesktop && !distractionFree && <DailyBrief coinTickers={coinTickers} />}
      <PushToast />

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
    <BtcMoveToast alert={notificationsEnabled && !chartFullscreen ? btcMoveAlert : null} onDismiss={dismissBtcAlert} />
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

  // Only the *first* profile fetch after sign-in should blank the screen to
  // the boot splash. refreshProfile() (e.g. saving an alert sound, the
  // post-Stripe-checkout poll) also flips profileLoading, but that's a
  // background refresh — showing the boot screen for it unmounts the whole
  // app tree and wipes any open modal's local state (profileOpen etc).
  const initialLoadDoneFor = useRef<string | null>(null);
  const isInitialLoad = user ? initialLoadDoneFor.current !== user.id : false;
  useEffect(() => {
    if (user && !profileLoading) initialLoadDoneFor.current = user.id;
    if (!user) initialLoadDoneFor.current = null;
  }, [user, profileLoading]);
  const [showAuth, setShowAuth] = useState(false);
  const [authView, setAuthView] = useState<"login" | "signup">("login");
  const [showUpgrade, setShowUpgrade] = useState(false);

  // Native Google sign-in opens an in-app browser and returns immediately —
  // the real session lands later, asynchronously, via a deep-link listener
  // (see AuthContext's appUrlOpen handler), decoupled from AuthModal itself.
  // AuthModal has no way to close on that completion, so close it here
  // instead: once authenticated, the sign-in modal should never still be up.
  useEffect(() => {
    if (user) setShowAuth(false);
  }, [user]);

  // Tapping an upgrade-reminder-push notification (pushNotifications.ts)
  // dispatches this instead of calling setShowUpgrade directly — that
  // service module sits well below App.tsx and has no access to this state.
  useEffect(() => {
    const onOpenUpgradeEvent = () => setShowUpgrade(true);
    window.addEventListener("open-upgrade-modal", onOpenUpgradeEvent);
    return () => window.removeEventListener("open-upgrade-modal", onOpenUpgradeEvent);
  }, []);

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
    saveTermsAgreement(user.id, pending).then(({ error }) => {
      // Keep the pending flag on failure — the fallback TermsGateModal gate
      // still requires real agreement, and clearing this would silently
      // lose it. This effect retries next time `user` changes identity.
      if (error) return;
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
  if (authLoading || (user && profileLoading && isInitialLoad) || (user && !minTimeElapsed)) {
    return (
      <div className="app-boot-screen">
        <CoinHintzLogo loading={true} />
      </div>
    );
  }

  // Gate: signed in but hasn't agreed to terms yet (covers first-time OAuth users).
  // Skip if a pending local agreement is still being flushed to the DB (the
  // effect above) — otherwise anyone who just checked the box in AuthModal
  // right before signing in briefly sees this same prompt again.
  const pendingTermsFlush = !!localStorage.getItem("terms_agreed_at");
  if (user && profile && !profile.terms_agreed_at && !pendingTermsFlush) {
    return <TermsGateModal userId={user.id} onAgreed={refreshProfile} />;
  }

  // Gate: signed in but has no username — the only way to land here is
  // Google/Apple sign-in (a redirect straight to the provider, with no
  // form of ours to add a username field to) or a pre-existing account
  // from before this field existed. AuthModal's own signup form already
  // makes it mandatory for anyone who goes through that.
  if (user && profile && !profile.username) {
    return <UsernameGateModal userId={user.id} onSaved={refreshProfile} />;
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
