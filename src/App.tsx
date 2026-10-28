import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { CoinUnavailableSheet } from "./components/CoinUnavailableSheet";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { usePullToRefresh } from "./hooks/usePullToRefresh";
import {
  coinglass,
  BTCData,
  CoinSymbol,
  clearCandleCache,
  COINS,
  fetchCoin24hTickers,
  Ticker24h,
  fetchBn,
} from "./services/coinglass";
import { CATALOG } from "./services/coinCatalog";
// Cash is an Asset Calculator-only concept — deliberately NOT added to the
// shared CATALOG, which Watchlist/price-fetching/search all iterate over
// assuming every entry is a real tradeable coin with a Binance pair.
const CASH_ID = "cash";
// Hidden for now (not removed — may come back, or stay alongside the new
// Trading Agent as a separate feature; nothing in CoinChat.tsx/css/service
// was touched). Flip to true to bring it back.
const SHOW_COIN_CHAT = false;
import { fetchBinancePrices } from "./services/binancePrices";
import { consumePendingCoinMention } from "./services/pushNotifications";
import { initWebPushMessageRouting } from "./services/webPush";
import { Drawer } from "./components/Drawer";
import { AccountMenu } from "./components/AccountMenu";
import { LearnSection } from "./components/LearnSection";
import { LeveragePopup } from "./components/LeveragePopup";
import { CoinHintzLogo, LogoIcon } from "./components/CoinHintzLogo";
import { PriceAlerts } from "./components/PriceAlerts";
import { BuySignals } from "./components/BuySignals";
import { useBuySignalRealtime } from "./hooks/useBuySignalRealtime";
import { ProfilePage } from "./components/ProfilePage";
import { TutorialPage } from "./components/TutorialPage";
// OrderBook (full bid/ask ladder) — commented out, not deleted, along with
// its call site below; replaced there by OrderFlowPanel.
// import { OrderBook } from "./components/OrderBook";
import { OrderFlowPanel } from "./components/OrderFlowPanel";
import { PaperTradingCard } from "./components/PaperTradingCard";
import type { ChartEvent } from "./components/ChartEventAnnotations";
import { CoinChat } from "./components/CoinChat";
import { TradingAgent } from "./components/TradingAgent";
import { AgentIntroShowcase } from "./components/AgentIntroShowcase";
import { Avatar } from "./components/Avatar";
import { OnboardingWizard } from "./components/OnboardingWizard";
// import { WhatsNewModal } from "./components/WhatsNewModal"; — paused, see its commented render block below
import { DailyBrief } from "./components/DailyBrief";
import { PushToast } from "./components/PushToast";
import { OfflineBanner } from "./components/OfflineBanner";
import { FloatingNavBar } from "./components/FloatingNavBar";
import { NotificationsCenter } from "./components/NotificationsCenter";
import { WhaleAlerts } from "./components/WhaleAlerts";
import { AuthModal } from "./components/AuthModal";
import { BlurGate } from "./components/MembershipGate";
import { PaywallPromo } from "./components/PaywallPromo";
import { BottomSheet } from "./components/BottomSheet";
import { UpgradeModal } from "./components/UpgradeModal";
import { EliteUpsellModal } from "./components/EliteUpsellModal";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { useAIQuota } from "./hooks/useAIQuota";
import { PriceTickerFullscreen } from "./components/PriceTickerFullscreen";
import { PositionIntelligence } from "./components/PositionIntelligence";
import { ChartBottomPanel } from "./components/ChartBottomPanel";
import { PriceChart, formatLivePrice } from "./components/PriceChart";
import { MobileSymbolSheet } from "./components/MobileSymbolSheet";
// Static, not lazy, like PriceChart above — "markets" is the default
// landing section now, needed immediately on load, same reasoning as the
// comment on the lazy block below.
import { GlobalMarkets } from "./components/GlobalMarkets";

// Desktop Focus mode (moon) button — hidden for now; flip to bring it back.
const SHOW_FOCUS_BUTTON = false;

// No-op on web/desktop, where this plugin isn't meaningful (and may not
// be present) — same convention as PriceChart.tsx/TradingAgent.tsx's own
// hapticTap(). Medium rather than Light — Light was hard to feel
// reliably on-device.
function hapticTap() {
  if (Capacitor.isNativePlatform()) {
    Haptics.impact({ style: ImpactStyle.Medium }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[hapticTap] Haptics.impact failed:", e);
    });
  }
}

// Mobile header pill only — drops the decimal portion for prices >= $1000
// (e.g. "$83,646" instead of "$83,646.00") to keep the pill on one row.
// Desktop keeps formatLivePrice's full precision everywhere else.
function formatHeaderPriceMobile(p: number): string {
  if (p >= 1000) {
    return `$${Math.round(p).toLocaleString("en-US")}`;
  }
  return formatLivePrice(p);
}
import { HoverTip } from "./components/HoverTip";
import { GlobalSearch } from "./components/GlobalSearch";
import { BtcMoveToast } from "./components/BtcMoveToast";
import { useBtcMoveAlert } from "./hooks/useBtcMoveAlert";
import { useNotificationsEnabled } from "./hooks/useNotificationsEnabled";
import { usePictureInPictureWindow } from "./hooks/usePictureInPictureWindow";
import { ZoneResult } from "./components/PriceChart.types";
import { Tier, hasAccess, saveTermsAgreement, supabase } from "./services/supabase";
import { ContactForm } from "./components/ContactForm";
import { ChartAnalyzeModal } from "./components/ChartAnalyzeModal";
import { ResolutionBanner } from "./components/ResolutionBanner";
import TermsGateModal from "./components/TermsGateModal";
import UsernameGateModal from "./components/UsernameGateModal";
import { PortfolioValueChart } from "./components/PortfolioValueChart";
import "./App.css";

// Coins the chart has candle data for (the app's COINS roster).
const SUPPORTED_CHART_COINS = new Set<string>(COINS.map((c) => c.symbol as string));

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
const AltAnalysis = lazy(() => import("./components/AltAnalysis").then(m => ({ default: m.AltAnalysis })));
const OptionsAnalytics = lazy(() => import("./components/OptionsAnalytics").then(m => ({ default: m.OptionsAnalytics })));
const CorrelationMatrix = lazy(() => import("./components/CorrelationMatrix").then(m => ({ default: m.CorrelationMatrix })));
const StrategyAlerts = lazy(() => import("./components/StrategyAlerts").then(m => ({ default: m.StrategyAlerts })));
const MarketHeatmap = lazy(() => import("./components/MarketHeatmap").then(m => ({ default: m.MarketHeatmap })));

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
  // Standalone fullscreen chart page — reached only via the chart's own
  // Full Screen button/double-tap, not a NAV_ITEMS entry (no nav icon).
  | "advance-chart"
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
  | "strategyalerts"
  | "marketheatmap";

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

// The Trade page is section "chart" internally but lives at #trade in the
// URL. Old #chart links still open it.
function hashToSection(hash: string): SectionId {
  return (hash === "trade" ? "chart" : hash) as SectionId;
}
function sectionToHash(section: SectionId): string {
  return section === "chart" ? "trade" : section;
}

// Pages that are fully paywalled (BlurGate around the whole page). Tapping
// one of these in the menu without access shows its upgrade promo
// (PaywallPromo) instead of navigating; opening the URL directly still
// lands on the page's own full-page paywall.
const PAYWALLED_PAGES: Partial<Record<SectionId, { tier: Tier; name: string }>> = {
  candleai: { tier: "pro", name: "Inside the AI Candle" },
  altanalysis: { tier: "pro", name: "Alt Analysis" },
  options: { tier: "pro", name: "Options Analytics" },
  correlation: { tier: "pro", name: "Correlation Matrix" },
  strategyalerts: { tier: "pro", name: "Strategy Alerts" },
};

const NAV_ITEMS: {
  id: SectionId;
  labelKey: string;
  d: string | string[];
  requiredTier?: Tier;
  hidden?: boolean;
  category?: NavCategoryId;
}[] = [
  {
    // Shown as "Trade" (nav.chart) — first item, candlestick icon.
    id: "chart",
    labelKey: "nav.chart",
    requiredTier: "pro",
    d: [
      "M8 3v4", "M6 7h4v9H6z", "M8 16v5",
      "M16 4v5", "M14 9h4v6h-4z", "M16 15v4",
    ],
  },
  {
    id: "candleai",
    labelKey: "nav.candleai",
    requiredTier: "elite",
    d: ["M3 3v18h18", "M7 7h2v10H7z", "M13 11h2v6h-2z", "M10 13h2v4h-2z"],
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
    category: "trading",
    d: ["M21 4H8", "M3 4h.01", "M21 12H11", "M3 12h.01", "M21 20H8", "M3 20h.01", "M8 2v4", "M11 10v4", "M8 18v4"],
  },
  {
    id: "marketheatmap",
    labelKey: "nav.marketheatmap",
    requiredTier: "pro",
    category: "market",
    // Uneven rectangles suggesting a treemap — distinct from the equal-
    // quadrant liquidation heatmap icon above.
    d: ["M3 3h10v10H3z", "M15 3h6v5h-6z", "M15 10h6v10h-6z", "M3 15h6v6H3z", "M11 15h4v6h-4z"],
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

function NavIcon({ d, size = 22 }: { d: string | string[]; size?: number }) {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg
      width={size}
      height={size}
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

// Real brand colors for the coins most people would actually recognize by
// color (BTC's orange, ETH's slate-blue, etc.) — curating all 257 COINS by
// hand isn't practical, so everything else falls through to a deterministic
// hash-to-hue color below instead of the flat single-color circle every
// coin previously shared. Same color every render for a given symbol
// either way, just not necessarily brand-accurate for the long tail.
const COIN_BRAND_COLORS: Record<string, string> = {
  BTC: "#f7931a", ETH: "#627eea", BNB: "#f3ba2f", XRP: "#23292f", SOL: "#14f195",
  ADA: "#0033ad", DOGE: "#c2a633", TRX: "#ff0013", LTC: "#345d9d", BCH: "#8dc351",
  LINK: "#2a5ada", AVAX: "#e84142", DOT: "#e6007a", ATOM: "#2e3148", UNI: "#ff007a",
  XLM: "#000000", SUI: "#4da2ff", NEAR: "#00ec97", SHIB: "#ffa409", PEPE: "#3fa03f",
  AAVE: "#b6509e", ETC: "#328332", TON: "#0098ea", HBAR: "#000000", ICP: "#f15a24",
};
function coinAvatarColor(symbol: string): string {
  if (COIN_BRAND_COLORS[symbol]) return COIN_BRAND_COLORS[symbol];
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 45%)`;
}

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

// Desktop coin-picker's star column (coinPickerTableContent below) — no
// cap on count, unlike recentCoins' MAX_RECENT_COINS, since this is a
// deliberate user choice to pin a coin, not an auto-tracked history.
const STARRED_COINS_KEY = "starredCoinPicks";

function loadStarredCoins(): string[] {
  try {
    const raw = localStorage.getItem(STARRED_COINS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function toggleStarredCoin(symbol: string): string[] {
  try {
    const cur = loadStarredCoins();
    const next = cur.includes(symbol) ? cur.filter((s) => s !== symbol) : [symbol, ...cur];
    localStorage.setItem(STARRED_COINS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadStarredCoins();
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
    const hash = hashToSection(window.location.hash.slice(1));
    // "advance-chart" has no NAV_ITEMS entry (no nav icon) but is still a
    // valid section reachable via hash — accept it explicitly.
    // Default landing is the Trade page (section "chart", URL #trade).
    return NAV_ITEMS.some((n) => n.id === hash) || hash === "advance-chart" ? hash : "chart";
  });
  // Tapping Agent Ready while locked (non-elite) opens this instead of the
  // generic onOpenUpgrade — see the render block below, near TradingAgent.
  const [showEliteUpsell, setShowEliteUpsell] = useState(false);
  // Agent Ready gate (floating trigger, mobile nav button, any
  // "open-trading-agent" dispatch): signed out → sign in / sign up;
  // signed in without Elite → Elite upsell. Elite users never hit this.
  const agentGate = () => {
    if (!user) onOpenAuth();
    else setShowEliteUpsell(true);
  };
  // Badge count shown on FloatingNavBar's Notifications icon — kept in
  // sync by NotificationsCenter itself (mount-time fetch, and again
  // whenever something there changes it) via onUnreadCountChange, rather
  // than this component owning its own fetch too.
  const [notificationsCenterOpen, setNotificationsCenterOpen] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  // Mirrors TradingAgent's own internal `unread` state (dispatched via a
  // plain event, same convention as the rest of this cross-component
  // signaling) so FloatingNavBar's raised Agent button can show the same
  // dot its desktop trigger does, without lifting that state up here.
  const [agentUnread, setAgentUnread] = useState(false);
  useEffect(() => {
    const onUnreadChange = (e: Event) => {
      setAgentUnread(!!(e as CustomEvent<{ unread: boolean }>).detail?.unread);
    };
    window.addEventListener("trading-agent-unread-change", onUnreadChange);
    return () => window.removeEventListener("trading-agent-unread-change", onUnreadChange);
  }, []);
  // Mirrors BuySignals' own internal `open` state, same reason/convention
  // as agentUnread above — lets FloatingNavBar's Signals icon drop its
  // active state the moment the panel actually closes.
  const [signalsOpen, setSignalsOpen] = useState(false);
  useEffect(() => {
    const onOpenChange = (e: Event) => {
      setSignalsOpen(!!(e as CustomEvent<{ open: boolean }>).detail?.open);
    };
    window.addEventListener("buy-signals-open-change", onOpenChange);
    return () => window.removeEventListener("buy-signals-open-change", onOpenChange);
  }, []);
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
  // That initializer only ever ran once, on mount — a LATER activeSection
  // change (e.g. the trading agent's navigateTo jumping straight to
  // "heatmap") left whichever category was open at mount untouched, so
  // the newly-active item's highlight landed inside a still-collapsed
  // accordion panel the user couldn't see at all. Re-applies the same
  // "open the category this section lives in" rule on every real section
  // change instead of just the first one; a manual category toggle click
  // doesn't go through this (it sets openNavCategory directly, not
  // activeSection), so it isn't fought by this effect.
  useEffect(() => {
    const category = NAV_ITEMS.find((n) => n.id === activeSection)?.category;
    if (category) setOpenNavCategory(category);
  }, [activeSection]);
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
  // showWhatsNew (the read) dropped — only its setter is still called below
  // (the 3s-delay trigger), since the card itself is commented out/paused.
  const [, setShowWhatsNew] = useState(false);
  const onboardingCheckedRef = useRef(false);
  // Defaults closed — a brand-new visitor with no stored preference yet
  // was getting the chat panel open on their very first load, since this
  // used to default to open unless explicitly told "false".
  const [showCoinChat, setShowCoinChat] = useState(
    () => localStorage.getItem("coinchat-visible") === "true",
  );
  useEffect(() => {
    localStorage.setItem("coinchat-visible", String(showCoinChat));
  }, [showCoinChat]);
  // Hides Watchlist/Top Movers/Daily Brief so the chart is the only thing
  // on screen. Persisted the same way as every other rail preference here.
  // Controlled by the header's own Focus button (mch-focus-btn below) —
  // the old separate sidebar rail button for this was removed as a
  // redundant second entry point once that button did everything it did.
  // Focus button is hidden for now (SHOW_FOCUS_BUTTON) — while it is,
  // Focus mode always starts off so nobody gets stuck with alerts muted
  // and no way to turn it back on.
  const [distractionFree, setDistractionFree] = useState(
    () => SHOW_FOCUS_BUTTON && localStorage.getItem("distraction-free") === "true",
  );
  useEffect(() => {
    localStorage.setItem("distraction-free", String(distractionFree));
  }, [distractionFree]);
  // Self-dismissing confirmation — the button itself has no label
  // anymore (icon-only), so turning Focus ON needs some other feedback
  // that it actually did something, same as any mute toggle with no
  // persistent visible state nearby. Only shown turning ON, not off —
  // off is "back to normal," nothing worth announcing.
  const [focusToast, setFocusToast] = useState(false);
  const focusToastTimerRef = useRef<number | null>(null);
  // Single combined control — mutes all alerts AND hides the
  // distraction-free panels together, not just one or the other.
  const toggleFocusMode = useCallback(() => {
    setDistractionFree((v) => {
      const next = !v;
      setNotificationsEnabled(!next);
      if (next) {
        setFocusToast(true);
        if (focusToastTimerRef.current) window.clearTimeout(focusToastTimerRef.current);
        focusToastTimerRef.current = window.setTimeout(() => setFocusToast(false), 2500);
      } else {
        setFocusToast(false);
      }
      return next;
    });
  }, []);
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

  // Every coin tap in the app (Markets, movers, search, notifications…)
  // goes through here. Coins the chart has no data for show the "coming
  // soon" sheet instead of opening an empty chart. Returns true if opened.
  const [unavailableCoin, setUnavailableCoin] = useState<string | null>(null);
  const openChartCoin = (symbol: string, opts: { recent?: boolean; navigate?: boolean } = {}): boolean => {
    const sym = String(symbol || "").toUpperCase();
    if (!SUPPORTED_CHART_COINS.has(sym)) {
      setUnavailableCoin(sym || "This coin");
      return false;
    }
    setCoin(sym as CoinSymbol);
    clearCandleCache();
    if (opts.recent) setRecentCoins(addRecentCoin(sym));
    if (opts.navigate) setActiveSection("chart");
    return true;
  };

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
      if (!openChartCoin(detail.coin, { navigate: true })) return;
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
    // Tapping a price-alert push/notification jumps to that coin's chart —
    // there's no dedicated price-alert page, the chart itself is "the
    // subject." Dispatched by routeNotificationTap (src/utils/
    // notificationRouting.ts) for type "price_alert".
    const onOpenPriceAlert = (e: Event) => {
      const detail = (e as CustomEvent<{ coin?: string }>).detail;
      if (!detail?.coin) return;
      openChartCoin(detail.coin, { navigate: true });
    };
    window.addEventListener("open-price-alert", onOpenPriceAlert);
    return () => window.removeEventListener("open-price-alert", onOpenPriceAlert);
  }, []);
  useEffect(() => {
    // No-op on native (isWebPushAvailable() gates the actual subscription),
    // but safe/cheap to register unconditionally — just a message listener.
    initWebPushMessageRouting();
  }, []);
  useEffect(() => {
    // Optimistic +1 the instant a push lands in the foreground (same event
    // PushToast.tsx reacts to) — the edge function logs the real row around
    // the same time, so this just avoids the badge lagging a full refetch.
    // NotificationsCenter resyncs to the true count whenever it's opened.
    const onPushToast = () => setUnreadNotifCount((n) => n + 1);
    window.addEventListener("push-toast", onPushToast);
    return () => window.removeEventListener("push-toast", onPushToast);
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
  const { used: aiUsed, limit: aiLimit } = useAIQuota();
  // AI Usage card — same used/limit useAIQuota computes for ProfilePage's
  // own AI Usage section, so they never drift. Desktop sidebar only.
  const aiUsageCardEl = (
    <div className="icon-strip-usage-card">
      <div className="icon-strip-usage-head">
        <span className={`icon-strip-usage-icon${tier === "elite" ? " icon-strip-usage-icon--elite" : tier === "pro" ? " icon-strip-usage-icon--pro" : ""}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
          </svg>
        </span>
        <span className="icon-strip-usage-title">{t("nav.aiUsage", "AI Usage")}</span>
        {tier !== "elite" && (
          <button type="button" className="icon-strip-usage-upgrade" onClick={onOpenUpgrade}>
            {t("nav.upgrade", "Upgrade")}
          </button>
        )}
      </div>
      {/* Always the bar, whatever the tier; amber/red near the limit. */}
      <div className="icon-strip-usage-track">
        <div
          className={`icon-strip-usage-fill${tier === "elite" ? " icon-strip-usage-fill--elite" : tier === "pro" ? " icon-strip-usage-fill--pro" : ""}${tier === "elite" ? "" : aiLimit > 0 && aiUsed / aiLimit >= 0.9 ? " icon-strip-usage-fill--red" : aiLimit > 0 && aiUsed / aiLimit >= 0.6 ? " icon-strip-usage-fill--amber" : ""}`}
          style={{ width: tier === "elite" ? "100%" : aiLimit > 0 ? `${Math.min(100, (aiUsed / aiLimit) * 100)}%` : "100%" }}
        />
      </div>
      <div className="icon-strip-usage-caption">
        {tier === "elite"
          ? t("profile.aiUsage.unlimited", "Unlimited")
          : aiLimit > 0
            ? t("nav.usageOfLimit", "{{used}} of {{limit}} used", { used: aiUsed, limit: aiLimit })
            : t("nav.usageLocked", "Upgrade to unlock AI requests")}
      </div>
    </div>
  );
  // Shows the in-app buy-signal toast anywhere in the app, the instant it
  // fires — independent of whether a push notification actually made it
  // through (browser push subscriptions can go stale; this doesn't rely
  // on one at all).
  useBuySignalRealtime(tier, profile);
  useEffect(() => {
    if (profile && !onboardingCheckedRef.current) {
      onboardingCheckedRef.current = true;
      if (!profile.trader_level && !localStorage.getItem("onb_never_show")) {
        setShowOnboarding(true);
      } else if (
        !localStorage.getItem("whats_new_seen_v1") &&
        isWideDesktop &&
        !Capacitor.isNativePlatform()
      ) {
        // Desktop web only — corner-docked feature announcements don't
        // translate to iOS/mobile web's narrower layout. Skipped when the
        // onboarding wizard is about to show instead — stacking two
        // full-screen intro modals on the same load is a lot to dump on
        // someone; a brand-new user sees this on their next visit once
        // onboarding's own flag is set. Delayed so it doesn't fight for
        // attention the instant the page finishes loading.
        window.setTimeout(() => setShowWhatsNew(true), 3000);
      }
    }
  }, [profile]);

  const [assetPanelOpen, setAssetPanelOpen] = useState(false);
  // One-time flashy "try Agent Ready" showcase, anchored to whichever
  // trigger is actually on screen (TradingAgent's own .ta-trigger on wide
  // desktop, FloatingNavBar's .fnb-agent-item on mobile) — both receive
  // this prop and no-op if their own trigger isn't rendered. Marked seen
  // here (the single owner of the flag) the moment it's scheduled, not on
  // dismissal, so it can never re-fire from an interrupted animation.
  const [showAgentShowcase, setShowAgentShowcase] = useState(false);
  useEffect(() => {
    if (activeSection !== "chart") return;
    if (localStorage.getItem("agentReadyShowcaseSeen")) return;
    // No ref-based "already scheduled" guard — StrictMode's dev-only
    // double-invoke (effect → cleanup → effect again) was setting a ref
    // true on the first pass, which persisted through the synthetic
    // cleanup (which cancelled that pass's timer) and then blocked the
    // second pass from ever scheduling a replacement, so the timer never
    // actually survived to fire. A plain per-invocation `cancelled` flag
    // lets each pass clean up after only itself; the final (real) pass's
    // timer is the one left standing.
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (cancelled) return;
      localStorage.setItem("agentReadyShowcaseSeen", "true");
      setShowAgentShowcase(true);
    }, 1800);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [activeSection]);
  // Daily Brief's mobile floating-nav slot (replacing Calculator there,
  // which moved into the mobile side menu instead) — icon-triggered full
  // screen, same mutual-exclusion treatment as the other floating panels
  // below.
  const [dailyBriefPanelOpen, setDailyBriefPanelOpen] = useState(false);
  // Markets page "Top News" pill opens the News panel.
  useEffect(() => {
    const onOpenBrief = () => setDailyBriefPanelOpen(true);
    window.addEventListener("open-daily-brief", onOpenBrief);
    return () => window.removeEventListener("open-daily-brief", onOpenBrief);
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [chartAnalyzeOpen, setChartAnalyzeOpen] = useState(false);
  // Locked page whose upgrade promo is showing (menu tap without access).
  const [promoSection, setPromoSection] = useState<SectionId | null>(null);
  const [coinPickerOpen, setCoinPickerOpen] = useState(false);
  const [coinSearch, setCoinSearch] = useState("");
  const [recentCoins, setRecentCoins] = useState<string[]>(loadRecentCoins);
  const [starredCoins, setStarredCoins] = useState<string[]>(loadStarredCoins);
  // Desktop coin-picker table's column sort (coinPickerTableContent below)
  // — defaults to Volume desc, the same "most-liquid-first" ordering a
  // real exchange's own market list defaults to.
  const [coinSort, setCoinSort] = useState<{ key: "market" | "price" | "change" | "volume"; dir: "asc" | "desc" }>(
    { key: "volume", dir: "desc" },
  );
  const [globalSearch, setGlobalSearch] = useState(false);

  // Buy/Sell Signals, the Asset Calculator, Search, and Profile are all
  // independent floating panels (FloatingNavBar's raised-z-index fix made
  // all four visible above the nav bar at once) — mutually exclusive, so
  // opening one closes whichever of the other three happened to be open,
  // instead of letting them stack. One effect per panel (reacting to ITS
  // OWN flag turning true) rather than a single combined effect, so this
  // works no matter which entry point opened it (FloatingNavBar, the
  // desktop header, a push notification, etc.) — not just taps routed
  // through one shared handler. signalsOpen itself is only ever SET by
  // BuySignals' own broadcast (see the listener below it), so closing it
  // from here has to go back through the same event channel rather than
  // a setter.
  // Desktop web's access point for Paper Trading / Order Flow Pressure on
  // every page except Chart (which already shows chartRightColEl inline,
  // as part of its own layout). Renders as a real column
  // (activatedPanelsRailEl, declared further down near where it's used)
  // instead of a dropdown anchored to the icon — added when activated,
  // removed when toggled off, joining the same mutually-exclusive group
  // as signalsOpen/assetPanelOpen/profileOpen/globalSearch/
  // dailyBriefPanelOpen right below (only one of the five ever showing
  // at once — Paper Trading and Buy Signals included). Declared up here,
  // not next to activatedPanelsRailEl further down, specifically so
  // those effects (which reference it) aren't reading a variable that
  // hasn't been declared yet in this component's hook order.
  // Persisted (same localStorage pattern as chartLayoutMode/rightColTab
  // elsewhere in this file) — once enabled it should survive a browser
  // refresh too, not just in-app navigation.
  const [paperTradingFlyoutOpen, setPaperTradingFlyoutOpen] = useState(() => {
    return localStorage.getItem("paperTradingFlyoutOpen") === "true";
  });
  useEffect(() => {
    localStorage.setItem("paperTradingFlyoutOpen", String(paperTradingFlyoutOpen));
  }, [paperTradingFlyoutOpen]);
  useEffect(() => {
    if (!signalsOpen) return;
    if (assetPanelOpen) setAssetPanelOpen(false);
    if (profileOpen) setProfileOpen(false);
    if (globalSearch) setGlobalSearch(false);
    if (dailyBriefPanelOpen) setDailyBriefPanelOpen(false);
    if (paperTradingFlyoutOpen) setPaperTradingFlyoutOpen(false);
  }, [signalsOpen]);
  useEffect(() => {
    if (!assetPanelOpen) return;
    if (signalsOpen) window.dispatchEvent(new CustomEvent("close-buy-signals"));
    if (profileOpen) setProfileOpen(false);
    if (globalSearch) setGlobalSearch(false);
    if (dailyBriefPanelOpen) setDailyBriefPanelOpen(false);
    if (paperTradingFlyoutOpen) setPaperTradingFlyoutOpen(false);
  }, [assetPanelOpen]);
  useEffect(() => {
    if (!profileOpen) return;
    if (signalsOpen) window.dispatchEvent(new CustomEvent("close-buy-signals"));
    if (assetPanelOpen) setAssetPanelOpen(false);
    if (globalSearch) setGlobalSearch(false);
    if (dailyBriefPanelOpen) setDailyBriefPanelOpen(false);
    if (paperTradingFlyoutOpen) setPaperTradingFlyoutOpen(false);
  }, [profileOpen]);
  useEffect(() => {
    if (!globalSearch) return;
    if (signalsOpen) window.dispatchEvent(new CustomEvent("close-buy-signals"));
    if (assetPanelOpen) setAssetPanelOpen(false);
    if (profileOpen) setProfileOpen(false);
    if (dailyBriefPanelOpen) setDailyBriefPanelOpen(false);
    if (paperTradingFlyoutOpen) setPaperTradingFlyoutOpen(false);
  }, [globalSearch]);
  useEffect(() => {
    if (!dailyBriefPanelOpen) return;
    if (signalsOpen) window.dispatchEvent(new CustomEvent("close-buy-signals"));
    if (assetPanelOpen) setAssetPanelOpen(false);
    if (profileOpen) setProfileOpen(false);
    if (globalSearch) setGlobalSearch(false);
    if (paperTradingFlyoutOpen) setPaperTradingFlyoutOpen(false);
  }, [dailyBriefPanelOpen]);
  useEffect(() => {
    if (!paperTradingFlyoutOpen) return;
    if (signalsOpen) window.dispatchEvent(new CustomEvent("close-buy-signals"));
    if (assetPanelOpen) setAssetPanelOpen(false);
    if (profileOpen) setProfileOpen(false);
    if (globalSearch) setGlobalSearch(false);
    if (dailyBriefPanelOpen) setDailyBriefPanelOpen(false);
  }, [paperTradingFlyoutOpen]);

  // Desktop's search opens as a dropdown attached directly under
  // .top-nav-search (YouTube's own search-bar-with-suggestions pattern),
  // not a centered modal — this is that button's measured position/width,
  // fed to GlobalSearch's "anchored" variant below.
  const topNavSearchRef = useRef<HTMLButtonElement>(null);
  const [searchAnchor, setSearchAnchor] = useState<{ top: number; left: number; width: number } | null>(null);
  const openGlobalSearch = () => {
    const rect = topNavSearchRef.current?.getBoundingClientRect();
    if (rect) setSearchAnchor({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    setGlobalSearch(true);
  };
  const [coinTickers, setCoinTickers] = useState<Map<string, Ticker24h>>(
    new Map(),
  );
  // Was a single fetch-on-mount only, refreshed again just incidentally
  // whenever the coin picker happened to reopen — every consumer that
  // reads live price off this map (Agent Ready's position P&L and its
  // LiquidationGauge, DailyBrief's ticker chips, the mobile coin-chip
  // change indicators) was actually showing a stale, one-time snapshot in
  // between those reopens, not a real live feed. Polling on an interval
  // matching the same cadence already used for position prices elsewhere
  // in this file (see positionPrices below) makes it genuinely live.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetchCoin24hTickers(COINS)
        .then((m) => { if (!cancelled) setCoinTickers(m); })
        .catch(() => {});
    };
    // fetchCoin24hTickers has its own 60s in-memory cache/TTL (see
    // coinglass.ts), so a real network fetch only ever happens roughly
    // once a minute regardless of how often this fires — 15s just means a
    // freshly-expired cache gets picked up within 15s of becoming
    // available instead of waiting on some other, unrelated trigger
    // (reopening the coin picker) to happen to refetch it.
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The phone "Analyze a Chart" paywall is a full page (BlurGate) rather
  // than a dismissable popup, so leave it whenever the user moves on:
  // opening the menu or switching page closes it.
  useEffect(() => {
    if (mobileNavOpen) setChartAnalyzeOpen(false);
  }, [mobileNavOpen]);
  useEffect(() => {
    setChartAnalyzeOpen(false);
  }, [activeSection]);
  // Desktop-only collapse to a narrow icon-only rail (persisted — a
  // layout choice, not per-session state). Collapsed mode drops labels/
  // category grouping entirely and falls back to the flyout panel for a
  // category's items (same mechanism already in place for the 641-960px
  // tablet range), rather than trying to show an inline indented list
  // with no room for it.
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem("navCollapsed") === "1");
  const [navPeek, setNavPeek] = useState(false);
  const navPeekTimer = useRef<number | undefined>(undefined);
  useEffect(() => { if (!navCollapsed) setNavPeek(false); }, [navCollapsed]);
  useEffect(() => {
    localStorage.setItem("navCollapsed", navCollapsed ? "1" : "0");
  }, [navCollapsed]);
  // Drag-to-collapse handle on the rail's own right edge instead of a
  // dedicated button — the rail only ever has the two built widths
  // (88px/280px, CSS above), so this is a snap, not a continuous
  // resize: dragging left past the threshold collapses it, dragging
  // back right past the threshold re-expands it. startX resets after
  // each snap so the next toggle needs a fresh drag, not flapping back
  // immediately from the same pointer position.
  const navResizeDragState = useRef({ active: false, startX: 0, wasCollapsed: false, snapped: false });
  const onNavResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      navResizeDragState.current = { active: true, startX: e.clientX, wasCollapsed: navCollapsed, snapped: false };
    },
    [navCollapsed],
  );
  const onNavResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = navResizeDragState.current;
    if (!d.active) return;
    const delta = e.clientX - d.startX;
    const threshold = 60;
    if (!d.wasCollapsed && delta < -threshold) {
      setNavCollapsed(true);
      navResizeDragState.current = { active: true, startX: e.clientX, wasCollapsed: true, snapped: true };
    } else if (d.wasCollapsed && delta > threshold) {
      setNavCollapsed(false);
      navResizeDragState.current = { active: true, startX: e.clientX, wasCollapsed: false, snapped: true };
    }
  }, []);
  const onNavResizeUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const d = navResizeDragState.current;
    // A plain click (barely any movement, no drag threshold crossed) also
    // toggles — the handle doubles as a click target, not drag-only.
    if (d.active && !d.snapped && Math.abs(e.clientX - d.startX) < 4) {
      setNavCollapsed((v) => !v);
    }
    d.active = false;
  }, []);
  // Desktop-web-only bottom section (Settings/Support/Invite/Profile) —
  // dismissible invite card, not persisted (reappears each session, same
  // as most promo-card conventions). Sent server-side (send-invite edge
  // function, Resend — same provider/pattern notify-admin already uses),
  // not a mailto: link — the whole point was not needing the user's own
  // mail client to open at all.
  const [inviteCardOpen, setInviteCardOpen] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteStatus, setInviteStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const sendInvite = async () => {
    const email = inviteEmail.trim();
    if (!email || !email.includes("@") || inviteStatus === "sending") return;
    setInviteStatus("sending");
    try {
      const { error } = await supabase.functions.invoke("send-invite", {
        body: { email, inviterName: profile?.full_name || user?.email || "" },
      });
      if (error) throw error;
      setInviteStatus("sent");
      setInviteEmail("");
      window.setTimeout(() => setInviteStatus("idle"), 2500);
    } catch {
      setInviteStatus("error");
      window.setTimeout(() => setInviteStatus("idle"), 2500);
    }
  };
  // Segmented "current page" / Paper Trading+Order Flow tabs — real
  // phones (<=640px) and full desktop (>=961px, see App.css); the
  // in-between tablet range ignores this entirely and keeps showing both
  // side by side, resizable. Originally chart-page-only (hence the
  // "chart"/"orderbook" naming and the legacy "Order Book" title/icon —
  // it actually always toggled the WHOLE chart-right-col, Paper Trading
  // Card + Order Flow Panel together, never a literal order book), now
  // reused as-is for every page: "chart" means "show this page's own
  // content", "orderbook" means "show chart-right-col instead", entirely
  // in place — no navigation, on every page including Chart/Markets.
  const [mobileChartTab, setMobileChartTab] = useState<"chart" | "orderbook">("chart");
  // Green "new" dot on the header's Paper Trade icon until it's opened once.
  const [paperTabSeen, setPaperTabSeen] = useState(() => {
    try { return localStorage.getItem("paperTabSeen") === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (mobileChartTab !== "orderbook" || paperTabSeen) return;
    setPaperTabSeen(true);
    try { localStorage.setItem("paperTabSeen", "1"); } catch { /* ignore */ }
  }, [mobileChartTab, paperTabSeen]);
  // Any real navigation (menu, coin button, etc.) backs out of a
  // mid-page chart-right-col swap, same as it would reset any other
  // page-local UI state.
  useEffect(() => {
    setMobileChartTab("chart");
  }, [activeSection]);
  // Bumped on every tap of the first icon while it's showing the chart
  // logo — used as a `key` so the spin keyframe (.chart-tab-logo-spin)
  // remounts and replays each time, instead of only firing once on mount.
  const [chartTabSpinKey, setChartTabSpinKey] = useState(0);
  const [paperTabSpinKey, setPaperTabSpinKey] = useState(0);
  // Simple two-icon segmented switch, mounted once in the top bar
  // (.mch-right) at every width. First icon always represents — and
  // returns to — whatever page is actually active (its own NAV_ITEMS
  // icon; the branded logo + spin only for "chart" itself, same special
  // treatment it always had).
  const onChartPage = activeSection === "chart";
  const chartModeToggle = (
    <div className="chart-mobile-tabs" data-active={mobileChartTab}>
      <span className="chart-mobile-indicator" aria-hidden="true" />
      <button
        type="button"
        className={`chart-mobile-tab${mobileChartTab === "chart" ? " active" : ""}`}
        title={onChartPage ? t("chart.tabLabel", "Chart") : t(NAV_ITEMS.find((n) => n.id === activeSection)?.labelKey ?? "chart.tabLabel", activeSection)}
        onClick={() => {
          setMobileChartTab("chart");
          setChartTabSpinKey((k) => k + 1);
        }}
      >
        {/* The round "C" logo on every page. While the page loads / data
            refreshes it spins like desktop's sidebar logo (ring + the
            "C" drawing itself in); a tap spins it once. */}
        {loading || refreshing ? (
          <span className="ptr-logo-wrap chart-tab-logo-loading">
            <span className="ptr-logo-glow" />
            <span className="ptr-logo-ring" />
            <LogoIcon size={18} animated />
          </span>
        ) : (
          <span key={chartTabSpinKey} className={chartTabSpinKey > 0 ? "chart-tab-logo-spin" : "chart-tab-logo-static"}>
            <LogoIcon size={18} />
          </span>
        )}
      </button>
      <button
        type="button"
        className={`chart-mobile-tab${mobileChartTab === "orderbook" ? " active" : ""}`}
        title={t("orderBook.title")}
        onClick={() => {
          setMobileChartTab("orderbook");
          setPaperTabSpinKey((k) => k + 1);
        }}
      >
        {/* "P" — plain when not selected; selected gets the C's black
            circle + white letter and the same spin on tap. */}
        <span
          key={paperTabSpinKey}
          className={`${paperTabSpinKey > 0 ? "chart-tab-logo-spin " : ""}chart-mobile-tab-p`}
          aria-hidden="true"
        >
          P
        </span>
        {!paperTabSeen && <span className="chart-mobile-tab-dot" aria-hidden="true" />}
      </button>
    </div>
  );
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

  const openCoinPicker = (anchor?: HTMLElement | null) => {
    const anchorEl = anchor ?? coinPickerBtnRef.current;
    if (anchorEl) {
      const rect = anchorEl.getBoundingClientRect();
      setCoinPickerPos({ top: rect.bottom + 8, left: rect.left });
    }
    setCoinPickerOpen((v) => {
      if (v) setCoinSearch("");
      return !v;
    });
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

  // Keyboard-aware sizing for the mobile/iOS bottom sheet variant — the
  // search input autoFocuses, so the keyboard pops immediately. The sheet
  // is `bottom: 0` (pinned to the screen's actual bottom edge), so
  // shrinking `height` ALONE only moved its top edge down — the bottom
  // portion stayed exactly where it was, still sitting underneath the
  // keyboard the whole time. Setting `bottom` to the keyboard's height
  // lifts the sheet's bottom edge to sit right above the keyboard instead,
  // and shrinking `height` by that same amount keeps the top edge fixed
  // in place rather than drifting as bottom moves. KEYBOARD_OVERLAP_PX
  // intentionally undershoots that by a bit — landing the sheet's bottom
  // edge/rounded corner exactly flush against the keyboard showed as a
  // visible seam; tucking it slightly behind instead hides that edge
  // under the keyboard's own opaque surface.
  const KEYBOARD_OVERLAP_PX = 32;
  // The sheet is the shared BottomSheet (position:relative inside its
  // bottom-aligned backdrop, so `bottom` lifts it), found by its class.
  const coinPickerSheetRef = {
    get current() { return document.querySelector<HTMLElement>(".bs-sheet.coin-picker-bs"); },
  };
  useEffect(() => {
    if (!coinPickerOpen) return;
    const showSub = Keyboard.addListener("keyboardWillShow", (info) => {
      if (coinPickerSheetRef.current) {
        coinPickerSheetRef.current.style.bottom = `${info.keyboardHeight - KEYBOARD_OVERLAP_PX}px`;
        // max(...) floors it at 300px — on a device/situation where
        // keyboardHeight ever comes back unexpectedly large relative to
        // the screen (a small phone, a floating/split iPad keyboard,
        // etc.), 88vh minus that could otherwise shrink the sheet to
        // something unusably small instead of just a shorter list. The
        // +KEYBOARD_OVERLAP_PX here balances the -KEYBOARD_OVERLAP_PX
        // above so the sheet's TOP edge doesn't also shift when the
        // bottom tucks in behind the keyboard.
        coinPickerSheetRef.current.style.height = `max(300px, calc(88vh - ${info.keyboardHeight}px + ${KEYBOARD_OVERLAP_PX}px))`;
      }
    });
    const hideSub = Keyboard.addListener("keyboardWillHide", () => {
      if (coinPickerSheetRef.current) {
        coinPickerSheetRef.current.style.bottom = "";
        coinPickerSheetRef.current.style.height = "";
      }
    });
    return () => {
      showSub.then((s) => s.remove());
      hideSub.then((s) => s.remove());
    };
  }, [coinPickerOpen]);

  const [leverageOpen, setLeverageOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [chartZone, setChartZone] = useState<ZoneResult | null>(null);
  const [chartPrice, setChartPrice] = useState(0);
  // OrderFlowPanel's "Today's Story" feed — same events PriceChart.tsx's
  // own ChartEventAnnotations already computes for its on-chart dots.
  const [chartEvents, setChartEvents] = useState<ChartEvent[]>([]);
  // Lifted out of the chart/markets-only layout block below so it's the
  // exact same element (never remounted, never double-mounted) whichever
  // page renders it — Paper Trading/Order Flow Pressure now also show on
  // every OTHER page's mobile view (see the post-Suspense block further
  // down), not just Chart/Markets.
  const chartRightColEl = (
    <div className="chart-right-col">
      <PaperTradingCard coin={coin} onOpen={() => setActiveSection("riskcalc")} onOpenAuth={onOpenAuth} />
      {/* <OrderBook coin={coin} onOpenUpgrade={onOpenUpgrade} /> */}
      <OrderFlowPanel coin={coin} events={chartEvents} />
    </div>
  );
  // Chart-page layout picker (wide desktop only, >=961px — same threshold
  // Daily Brief itself already requires). Three user-selectable arrangements
  // of the same three blocks (chart / chart-right-col / Daily Brief), see
  // the top-nav-bar's .top-nav-layout-* dropdown and .chart-layout-- rules in App.css:
  //   "2col" — col1 chart, col2 stacks chart-right-col above Daily Brief.
  //   "3col" — three side-by-side columns, one block each.
  //   "2row" — row1 chart (full width), row2 chart-right-col + Daily Brief
  //            side by side.
  // Persisted so the choice survives a reload.
  const [chartLayoutMode, setChartLayoutMode] = useState<"2col" | "3col" | "2row">(() => {
    const saved = localStorage.getItem("chartLayoutMode");
    return saved === "3col" || saved === "2row" ? saved : "2col";
  });
  useEffect(() => {
    localStorage.setItem("chartLayoutMode", chartLayoutMode);
  }, [chartLayoutMode]);
  // Top-nav dropdown version of the layout picker (desktop web only) —
  // the trigger always shows the 2-col glyph regardless of which mode is
  // actually active (per explicit "main icon should be the two col
  // icon"), not the current selection's own icon.
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  // Markets desktop only has the one fixed chart+Daily Brief arrangement
  // (no 2row/3col/2col picker — see chartColumnEl's markets branch), but
  // still wants a way to go full width and close Daily Brief entirely,
  // same spirit as Chart's own layout picker just without the choice of
  // three arrangements.
  const [marketsSingleColumn, setMarketsSingleColumn] = useState(false);
  const layoutMenuWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!layoutMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (layoutMenuWrapRef.current && !layoutMenuWrapRef.current.contains(e.target as Node)) {
        setLayoutMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [layoutMenuOpen]);
  // Shared mount point for both Paper Trading's column (rendered directly
  // below) and Buy Signals' own portaled column (BuySignals.tsx's
  // columnTarget prop) — :empty in CSS collapses this to nothing when
  // neither is active, so nothing has to separately track "is anything
  // in here" for layout purposes. State, not a plain ref — passing
  // columnTarget={someRef.current} as a prop would hand BuySignals
  // whatever that ref held during the PREVIOUS commit (refs update after
  // commit, not during render), so the very first render always sees
  // null/stale regardless of whether the node already exists; a callback
  // ref into state re-renders once the real node is there instead.
  const [activatedPanelsRailEl, setActivatedPanelsRailEl] = useState<HTMLElement | null>(null);
  // "2col" mode only: Paper Trading / Order Flow Pressure / Order Book
  // shown one at a time as tabs instead of stacked (3col/2row keep the
  // original stacked chartRightColEl, unaffected — scoped to this one
  // layout per explicit request). Persisted (same localStorage pattern as
  // chartLayoutMode just above) so whichever tab was selected survives a
  // refresh or navigating away and back instead of resetting every time.
  const [rightColTab, setRightColTab] = useState<"paper" | "flow" | "orderbook" | "posintel">(() => {
    const saved = localStorage.getItem("rightColTab");
    return saved === "flow" || saved === "orderbook" || saved === "posintel" ? saved : "paper";
  });
  // Mobile tabs: Paper Trading / Position Intelligence / Order Flow
  // Pressure (Order Book has its own tab above the chart there). Desktop
  // keeps Paper Trading / Order Flow Pressure / Order Book. A saved tab
  // the current set doesn't have falls back to Paper Trading.
  const rightColTabEff = !isWideDesktop
    ? (rightColTab === "orderbook" ? "paper" : rightColTab)
    : (rightColTab === "posintel" ? "paper" : rightColTab);
  useEffect(() => {
    localStorage.setItem("rightColTab", rightColTab);
  }, [rightColTab]);
  // Measured sliding glow-underline position (fancy-tabs sketch option A)
  // — same measure-and-position approach as CandleWatcher's interval
  // pills, since the three labels are different widths.
  const crcTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [crcHighlight, setCrcHighlight] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = crcTabRefs.current[rightColTabEff];
    if (el) setCrcHighlight({ left: el.offsetLeft, width: el.offsetWidth });
  }, [rightColTabEff]);
  // Hoisted to component scope (same reasoning as chartRightColEl just
  // above) so every other page's desktop "Paper Trading" flyout
  // (.activated-panels-rail further down) can reuse the exact same
  // tabbed Paper Trading / Order Flow Pressure / Order Book interface
  // the Chart page's own 2col layout uses, instead of a bare stacked
  // column with no tabs at all.
  const chartRightColTabbedEl = (
    <div className="chart-right-col chart-right-col--tabbed">
      {/* Glow underline (fancy-tabs sketch option A) — a thin
          gradient bar that shimmers continuously and glows
          under the active tab, sliding/resizing between them;
          the icon pops with a little overshoot on switch. */}
      <div className="crc-tabs" role="tablist" aria-label="Paper Trading / Order Flow / Order Book">
        {([
          {
            key: "paper" as const,
            label: "Paper Trading",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="13" rx="3" />
                <path d="M2 10.5h20" />
                <circle cx="16.5" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            ),
          },
          {
            key: "flow" as const,
            label: "Order Flow Pressure",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 17l5-6 4 3 5-8 4 5" />
              </svg>
            ),
          },
          {
            key: "orderbook" as const,
            label: "Order Book",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="14" y2="17" />
              </svg>
            ),
          },
          {
            key: "posintel" as const,
            label: "Position Intelligence",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="5" />
                <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
              </svg>
            ),
          },
        ] as const)
          .filter((tb) => (!isWideDesktop ? tb.key !== "orderbook" : tb.key !== "posintel"))
          .sort((a, b) => {
            const order = !isWideDesktop ? ["paper", "posintel", "flow"] : ["paper", "flow", "orderbook"];
            return order.indexOf(a.key) - order.indexOf(b.key);
          })
          .map(({ key, label, icon }) => (
          <button
            key={key}
            ref={(el) => { crcTabRefs.current[key] = el; }}
            type="button"
            role="tab"
            aria-selected={rightColTabEff === key}
            className={`crc-tab${rightColTabEff === key ? " active" : ""}`}
            onClick={() => setRightColTab(key)}
          >
            <span className="crc-tab-icon">{icon}</span>
            {label}
          </button>
        ))}
        {crcHighlight && (
          <div
            className="crc-tab-highlight"
            style={{ transform: `translateX(${crcHighlight.left}px)`, width: crcHighlight.width }}
          />
        )}
      </div>
      {/* No `key` on either panel — both PaperTradingCard and
          OrderFlowPanel must stay the exact same mounted
          instance across tab switches (live polling/state),
          so the per-switch entrance animation below comes
          from .crc-tab-panel-enter's CSS animation
          restarting on its own whenever a display:none panel
          toggles back to display:flex — no remount needed. */}
      <div className="crc-tab-panel crc-tab-panel-enter" style={{ display: rightColTabEff === "paper" ? "flex" : "none" }}>
        <PaperTradingCard coin={coin} onOpen={() => setActiveSection("riskcalc")} onOpenAuth={onOpenAuth} />
      </div>
      <div className="crc-tab-panel crc-tab-panel-enter" style={{ display: rightColTabEff === "flow" || rightColTabEff === "orderbook" ? "flex" : "none" }}>
        <OrderFlowPanel coin={coin} events={chartEvents} view={rightColTabEff === "orderbook" ? "orderbook" : "flow"} />
      </div>
      {!isWideDesktop && (
        <div className="crc-tab-panel crc-tab-panel-enter" style={{ display: rightColTabEff === "posintel" ? "flex" : "none" }}>
          <PositionIntelligence coin={coin} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} showHeader={false} />
        </div>
      )}
    </div>
  );
  // Chart page "2col" layout (wide desktop): Order Flow Pressure / Order
  // Book get their own tabbed column between the chart and Paper Trading,
  // and Paper Trading gets a column to itself. Own tab state + highlight
  // refs, separate from rightColTab above, since that one still drives
  // the 3-tab version used by mobile and the other pages' flyout.
  // Order Book is the default (and first) tab. Storage key bumped from
  // "flowColTab" so everyone starts on Order Book once, instead of keeping
  // a previously saved "flow".
  const [flowColTab, setFlowColTab] = useState<"flow" | "orderbook">(() => {
    return localStorage.getItem("flowColTabV2") === "flow" ? "flow" : "orderbook";
  });
  useEffect(() => {
    localStorage.setItem("flowColTabV2", flowColTab);
  }, [flowColTab]);
  const flowTabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [flowHighlight, setFlowHighlight] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = flowTabRefs.current[flowColTab];
    if (el) setFlowHighlight({ left: el.offsetLeft, width: el.offsetWidth });
  }, [flowColTab, activeSection, chartLayoutMode, isWideDesktop]);
  const chartFlowColEl = (
    <div className="chart-right-col chart-right-col--tabbed">
      <div className="crc-tabs" role="tablist" aria-label="Order Book / Order Flow">
        {([
          {
            key: "orderbook" as const,
            label: "Order Book",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="14" y2="17" />
              </svg>
            ),
          },
          {
            key: "flow" as const,
            label: "Order Flow Pressure",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 17l5-6 4 3 5-8 4 5" />
              </svg>
            ),
          },
        ]).map(({ key, label, icon }) => (
          <button
            key={key}
            ref={(el) => { flowTabRefs.current[key] = el; }}
            type="button"
            role="tab"
            aria-selected={flowColTab === key}
            className={`crc-tab${flowColTab === key ? " active" : ""}`}
            onClick={() => setFlowColTab(key)}
          >
            <span className="crc-tab-icon">{icon}</span>
            {label}
          </button>
        ))}
        {flowHighlight && (
          <div
            className="crc-tab-highlight"
            style={{ transform: `translateX(${flowHighlight.left}px)`, width: flowHighlight.width }}
          />
        )}
        <span className="ptc-live-badge crc-tabs-live"><span className="ptc-pulse-dot" />LIVE</span>
      </div>
      <div className="crc-tab-panel" style={{ display: "flex" }}>
        <OrderFlowPanel coin={coin} events={chartEvents} view={flowColTab} hideLiveBadge />
      </div>
    </div>
  );
  // Paper Trading column: same tab-row header as chartFlowColEl above —
  // Paper Trading / Position Intelligence, LIVE on the right. Both panels
  // stay mounted (display toggle, not conditional render) so Paper
  // Trading keeps its live state across tab switches.
  const [paperColTab, setPaperColTab] = useState<"paper" | "posintel">(() => {
    return localStorage.getItem("paperColTab") === "posintel" ? "posintel" : "paper";
  });
  useEffect(() => {
    localStorage.setItem("paperColTab", paperColTab);
  }, [paperColTab]);
  const chartPaperColEl = (
    <div className="chart-right-col chart-right-col--tabbed chart-right-col--paper">
      <div className="crc-tabs" role="tablist" aria-label="Paper Trading / Position Intelligence">
        {([
          {
            key: "paper" as const,
            label: "Paper Trading",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="20" height="13" rx="3" />
                <path d="M2 10.5h20" />
                <circle cx="16.5" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            ),
          },
          {
            key: "posintel" as const,
            label: "Position Intelligence",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="5" />
                <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
              </svg>
            ),
          },
        ]).map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={paperColTab === key}
            className={`crc-tab${paperColTab === key ? " active" : ""}`}
            onClick={() => setPaperColTab(key)}
          >
            <span className="crc-tab-icon">{icon}</span>
            {label}
            {paperColTab === key && <span className="crc-tab-underline" />}
          </button>
        ))}
        <span className="ptc-live-badge crc-tabs-live"><span className="ptc-pulse-dot" />LIVE</span>
      </div>
      <div className="crc-tab-panel crc-tab-panel-enter" style={{ display: paperColTab === "paper" ? "flex" : "none" }}>
        <PaperTradingCard
          coin={coin}
          onOpen={() => setActiveSection("riskcalc")}
          onOpenAuth={onOpenAuth}
          inTabRow
          // Chart page's own bottom panel has the full trade History tab;
          // everywhere else (this same column is the desktop flyout on
          // other pages) it falls back to the Trade Manager page.
          // From other pages (desktop): go to the Trade (#chart) page and
          // open History there — the panel picks the request up on mount
          // (ChartBottomPanel: chartBottomTab + chartBottomScroll).
          onViewClosed={!isWideDesktop ? undefined : activeSection === "chart"
            ? () => window.dispatchEvent(new CustomEvent("chart-bottom-tab", { detail: { tab: "history" } }))
            : () => {
                try {
                  localStorage.setItem("chartBottomTab", "history");
                  sessionStorage.setItem("chartBottomScroll", "1");
                } catch { /* ignore */ }
                setActiveSection("chart");
              }}
        />
      </div>
      <div className="crc-tab-panel crc-tab-panel-enter" style={{ display: paperColTab === "posintel" ? "flex" : "none" }}>
        <PositionIntelligence coin={coin} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} showHeader={false} />
      </div>
    </div>
  );
  const [chartFullscreen, setChartFullscreen] = useState(false);
  // true once we've pushed a history entry for the Advance Price Chart
  // page this session — guards onNavigateBack below from calling
  // history.back() into whatever was open before the app loaded if the
  // user somehow lands directly on #advance-chart without having
  // navigated there via the chart's own Full Screen button.
  const advanceChartPushedRef = useRef(false);
  // Mobile only — tapping Full Screen on the compact chart opens the real
  // Advance Chart page (<PriceChart pageMode>) as a draggable bottom sheet
  // over the current screen instead of a hard section navigation (which is
  // what still happens on desktop, unchanged, via advanceChartPushedRef
  // above). No history/hash wiring on purpose — this is a local overlay,
  // not a real route change, so back/forward navigation is untouched.
  const [mobileAdvanceChartOpen, setMobileAdvanceChartOpen] = useState(false);

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

  // Sync URL hash to the active section — pushState, not replaceState.
  // replaceState overwrites the *current* entry instead of adding a new
  // one, so the browser's history stack never actually accumulated a
  // step per section visited: Back would skip straight past every page
  // you'd navigated through and leave the app entirely. Two guards keep
  // this from also breaking Back/Forward itself:
  //   - skip the very first run (mount) — otherwise the initial section
  //     pushes a duplicate entry on top of the one already at that same
  //     hash from the page's own initial load, and Back would need two
  //     presses to actually go anywhere.
  //   - skip when the change came FROM the hashchange handler below (a
  //     real Back/Forward) — otherwise handling that event by calling
  //     setActiveSection would loop back through this effect and push
  //     yet another entry, turning one Back press into "go back, then
  //     silently get a new Forward entry appended right after it".
  const isFirstHistorySyncRef = useRef(true);
  const skipNextHistoryPushRef = useRef(false);
  // Position in the app's own page history (0 = the page the app opened
  // on) — lets the edge swipe know whether there's anything to go back to.
  const historyIdxRef = useRef(0);
  useEffect(() => {
    if (isFirstHistorySyncRef.current) {
      isFirstHistorySyncRef.current = false;
      // Normalize the landing URL in place (no extra history entry): a bare
      // URL or an old #chart link shows as #trade.
      const want = `#${sectionToHash(activeSection)}`;
      historyIdxRef.current = 0;
      window.history.replaceState({ appIdx: 0 }, "", `${window.location.search}${want}`);
      return;
    }
    if (skipNextHistoryPushRef.current) {
      skipNextHistoryPushRef.current = false;
      return;
    }
    // Same page as the current entry (e.g. a section alias settling on
    // load) — don't stack a duplicate, or Back/swipe-back would need an
    // extra press to actually go anywhere.
    if (window.location.hash === `#${sectionToHash(activeSection)}`) return;
    historyIdxRef.current += 1;
    window.history.pushState({ appIdx: historyIdxRef.current }, "", `${window.location.search}#${sectionToHash(activeSection)}`);
  }, [activeSection]);

  // Handle browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const idx = (window.history.state as { appIdx?: number } | null)?.appIdx;
      historyIdxRef.current = typeof idx === "number" ? idx : 0;
      const hash = hashToSection(window.location.hash.slice(1));
      // Same "advance-chart" allowance as the initial-state reader above —
      // without it, pressing Forward back into the page after Back would
      // silently fail (hash changes but activeSection doesn't follow).
      if (NAV_ITEMS.some((n) => n.id === hash) || hash === "advance-chart") {
        skipNextHistoryPushRef.current = true;
        setActiveSection(hash);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Global search keyboard shortcut (Cmd+K / Ctrl+K) — routed through the
  // same openGlobalSearch() the nav button uses (not a bare setGlobalSearch
  // toggle) so the anchored dropdown still knows where .top-nav-search
  // actually sits even when opened from the keyboard, not a click on it.
  // globalSearch is a real dependency here (not read via a functional
  // updater) specifically so openGlobalSearch — itself a plain top-level
  // call, not nested inside setState — only ever runs once per real
  // keypress, not twice under StrictMode's dev double-invoke of updaters.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (globalSearch) setGlobalSearch(false);
        else openGlobalSearch();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [globalSearch]);

  // Close mobile nav when section changes
  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeSection]);

  // Close the other top-bar flyout panels on page navigation — none of
  // them were wired to activeSection at all (only to each other, to stay
  // mutually exclusive). Paper Trading is deliberately excluded: once
  // enabled it should stay visible on every page until the user closes
  // it themselves, not reset on every navigation like these transient
  // overlays do.
  useEffect(() => {
    // Same "tell it to clean up" dispatch the mutual-exclusion effects
    // above already use for this one specifically, not a direct
    // setSignalsOpen(false) — its own listener owns closing it.
    if (signalsOpen) window.dispatchEvent(new CustomEvent("close-buy-signals"));
    setAssetPanelOpen(false);
    setProfileOpen(false);
    setGlobalSearch(false);
    setDailyBriefPanelOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Left-edge swipe right = Back (like a browser / iOS), with a round ←
  // indicator that follows the finger. On the first page (nothing to go
  // back to) it opens the side menu instead. Swipe left closes the menu.
  const backSwipeRef = useRef<HTMLDivElement>(null);
  // Publishes where the mobile header ends (--mch-bottom) so full-screen
  // paywalls (BlurGate's .bg-overlay on mobile) start below it — the
  // header, and its menu button, stay visible and tappable on every gated
  // page instead of being covered with no way out but a swipe.
  const mchCleanupRef = useRef<(() => void) | null>(null);
  const mchRef = useCallback((el: HTMLDivElement | null) => {
    mchCleanupRef.current?.();
    mchCleanupRef.current = null;
    const root = document.documentElement;
    if (!el) { root.style.setProperty("--mch-bottom", "0px"); return; }
    const update = () => {
      root.style.setProperty("--mch-bottom", `${Math.max(0, Math.round(el.getBoundingClientRect().bottom))}px`);    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, { passive: true, capture: true });
    mchCleanupRef.current = () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
    };
  }, []);
  const inHorizontalScroller = (el: Element | null) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 2) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
    }
    return false;
  };
  useEffect(() => {
    const EDGE = 30;
    const THRESHOLD = 70;
    let startX = 0,
      startY = 0,
      fromEdge = false,
      tracking = false;
    // Any overlay with its own horizontal swipe gesture (currently just
    // Agent Ready's .ta-panel — its history rows swipe left/right for
    // delete/pin) needs to opt out of this one entirely, not just win on
    // preventDefault — this is a SEPARATE document-level listener, so it
    // fires regardless of what the touch target's own handlers already did
    // with the same gesture. A touch starting anywhere inside such an
    // overlay is ignored for its whole start-to-end sequence.
    let ignoreThisGesture = false;
    const canGoBack = () => historyIdxRef.current > 0;
    const setIndicator = (dx: number | null) => {
      const el = backSwipeRef.current;
      if (!el) return;
      if (dx == null) { el.style.opacity = "0"; el.style.transform = "translate(-60px, -50%)"; el.classList.remove("back-swipe--ready"); return; }
      const d = Math.min(dx, 110);
      el.style.opacity = String(Math.min(1, d / 40));
      el.style.transform = `translate(${-60 + d * 0.75}px, -50%)`;
      el.classList.toggle("back-swipe--ready", dx > THRESHOLD);
    };
    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      fromEdge = startX < EDGE;
      tracking = false;
      ignoreThisGesture = !!(e.target as Element)?.closest?.(".ta-panel")
        // Advance chart page: it handles its own left-edge "back".
        || !!document.querySelector(".price-chart-container--page")
        // A sheet/modal is open — its own gestures win.
        || !!document.querySelector(".bs-backdrop, .mss-backdrop")
        // Started on something that scrolls sideways (carousels, chip
        // rows) — that swipe belongs to it, not to Back.
        || inHorizontalScroller(e.target as Element | null);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (ignoreThisGesture || !fromEdge || mobileNavOpenRef.current || !canGoBack()) return;
      const dx = e.touches[0].clientX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (!tracking && dy > 24 && dy > dx) { fromEdge = false; setIndicator(null); return; }
      if (dx > 8) { tracking = true; setIndicator(dx); }
    };
    const onTouchEnd = (e: TouchEvent) => {
      const wasTracking = tracking;
      tracking = false;
      setIndicator(null);
      if (ignoreThisGesture) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = Math.abs(e.changedTouches[0].clientY - startY);
      if (dy > 80) return; // vertical scroll, ignore
      if (!mobileNavOpenRef.current && fromEdge && dx > THRESHOLD) {
        if (canGoBack()) window.history.back();
        else if (!wasTracking) setMobileNavOpen(true);
      } else if (mobileNavOpenRef.current && dx < -50) {
        setMobileNavOpen(false);
      }
    };
    const onTouchCancel = () => { tracking = false; setIndicator(null); };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchCancel);
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

  // In-app navigation to a page (menu, search). A paywalled page the user
  // can't open shows its upgrade promo where they are instead of
  // navigating; returns whether it actually navigated.
  const openSection = (id: SectionId): boolean => {
    const gate = PAYWALLED_PAGES[id];
    if (gate && !(user && hasAccess(tier, gate.tier))) {
      setPromoSection(id);
      setMobileNavOpen(false);
      return false;
    }
    setActiveSection(id);
    return true;
  };
  const renderNavItem = (item: (typeof NAV_ITEMS)[number]) => (
    <button
      key={item.id}
      className={`icon-strip-btn${activeSection === item.id ? " active" : ""}`}
      onClick={() => {
        if (!openSection(item.id)) return;
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

  // Market-table layout for the coin picker — sortable Market/Last price/
  // 24h %/Volume columns plus a star-to-pin column, matching a real
  // exchange's own market-selector table. Shared between the desktop
  // positioned-dropdown and the mobile/iOS bottom sheet (coinPickerOpen
  // below) — same content either way, just a different wrapper around it
  // (the old card-list-style version this replaced, coinPickerListContent,
  // is gone — both platforms get the same table now).
  const toggleCoinSort = (key: typeof coinSort.key) => {
    setCoinSort((prev) => prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  };
  const coinSortIndicator = (key: typeof coinSort.key) =>
    coinSort.key !== key ? "⇅" : coinSort.dir === "desc" ? "▾" : "▴";
  const fmtTablePrice = (n: number) =>
    n >= 1 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${n.toFixed(6)}`;
  const fmtTableVolume = (n: number) =>
    n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;

  const coinPickerTableContent = (
    <>
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
          // Not on iOS native — autoFocus pops the keyboard the instant
          // the sheet opens, before the user's even looked at the list,
          // which ate screen space and felt like it hijacked the sheet on
          // first load. Desktop/web keep it (no on-screen keyboard to pop,
          // so it's just a normal "ready to type" convenience there).
          autoFocus={!Capacitor.isNativePlatform()}
          value={coinSearch}
          onChange={(e) => setCoinSearch(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        {coinSearch && (
          <button className="coin-picker-search-clear" onClick={() => setCoinSearch("")}>✕</button>
        )}
      </div>
      <div className="coin-picker-table">
        <div className="coin-picker-table-row coin-picker-table-header">
          <span className="coin-picker-table-star" aria-hidden="true" />
          <button type="button" className="coin-picker-table-th coin-picker-table-th--market" onClick={() => toggleCoinSort("market")}>
            Market <span className="coin-picker-table-sort">{coinSortIndicator("market")}</span>
          </button>
          <button type="button" className="coin-picker-table-th" onClick={() => toggleCoinSort("price")}>
            Last price <span className="coin-picker-table-sort">{coinSortIndicator("price")}</span>
          </button>
          <button type="button" className="coin-picker-table-th" onClick={() => toggleCoinSort("change")}>
            24h % <span className="coin-picker-table-sort">{coinSortIndicator("change")}</span>
          </button>
          <button type="button" className="coin-picker-table-th" onClick={() => toggleCoinSort("volume")}>
            Volume <span className="coin-picker-table-sort">{coinSortIndicator("volume")}</span>
          </button>
        </div>
        <div className="coin-picker-table-body">
          {COINS.filter((c) => {
            if (!coinSearch) return true;
            const q = coinSearch.toLowerCase();
            return c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
          }).sort((a, b) => {
            // Three tiers, in this exact order: starred, then recently
            // searched/picked (not starred), then everything else — but
            // the ACTIVE COLUMN SORT applies consistently within every
            // tier (including starred/recent), not just the third one.
            // An earlier version sorted the recent tier by raw recency
            // instead, which made clicking "Volume" look broken for any
            // coin that happened to also be recent — the tier boundary is
            // the only thing that's fixed; "which sort order" is still a
            // single answer for the whole table.
            const tierOf = (symbol: string): 0 | 1 | 2 =>
              starredCoins.includes(symbol) ? 0 : recentCoins.includes(symbol) ? 1 : 2;
            const aTier = tierOf(a.symbol);
            const bTier = tierOf(b.symbol);
            if (aTier !== bTier) return aTier - bTier;
            const ta = coinTickers.get(a.symbol);
            const tb = coinTickers.get(b.symbol);
            const dir = coinSort.dir === "desc" ? -1 : 1;
            if (coinSort.key === "market") return dir * a.symbol.localeCompare(b.symbol);
            // A FINITE sentinel, not -Infinity — when both coins are
            // missing ticker data (common before the async fetch resolves,
            // or for any coin a chunk failed to return), -Infinity - -Infinity
            // is NaN, and Array.sort's behavior on a NaN comparator result
            // is implementation-defined. V8 (desktop Chrome) tends to leave
            // things in a still-reasonable order despite this; JavaScriptCore
            // (Safari/iOS WKWebView) visibly does not, which is exactly why
            // this read as "ordering doesn't work" specifically on Frans.
            const MISSING = -1e18;
            const av = coinSort.key === "price" ? ta?.price ?? MISSING : coinSort.key === "change" ? ta?.change ?? MISSING : ta?.quoteVolume ?? MISSING;
            const bv = coinSort.key === "price" ? tb?.price ?? MISSING : coinSort.key === "change" ? tb?.change ?? MISSING : tb?.quoteVolume ?? MISSING;
            return dir * (av - bv);
          }).map((c) => {
            const tk = coinTickers.get(c.symbol);
            const starred = starredCoins.includes(c.symbol);
            return (
              <div
                key={c.symbol}
                className={`coin-picker-table-row coin-picker-table-data${c.symbol === coin ? " active" : ""}`}
                onClick={() => {
                  setCoin(c.symbol);
                  clearCandleCache();
                  setRecentCoins(addRecentCoin(c.symbol));
                  closeCoinPicker();
                }}
              >
                <button
                  type="button"
                  className={`coin-picker-table-star${starred ? " coin-picker-table-star--active" : ""}`}
                  onClick={(e) => { e.stopPropagation(); setStarredCoins(toggleStarredCoin(c.symbol)); }}
                  aria-label={starred ? `Unstar ${c.symbol}` : `Star ${c.symbol}`}
                >
                  {starred ? "★" : "☆"}
                </button>
                <span className="coin-picker-table-market">
                  <span className="coin-picker-table-icon" style={{ background: coinAvatarColor(c.symbol) }}>
                    {COIN_ICONS[c.symbol] ?? c.symbol[0]}
                  </span>
                  {c.symbol}-USD
                </span>
                <span className="coin-picker-table-price">{tk ? fmtTablePrice(tk.price) : "—"}</span>
                <span className={`coin-picker-table-change${tk ? (tk.change >= 0 ? " up" : " down") : ""}`}>
                  {tk ? `${tk.change >= 0 ? "+" : ""}${tk.change.toFixed(2)}%` : "—"}
                </span>
                <span className="coin-picker-table-volume">{tk?.quoteVolume != null ? fmtTableVolume(tk.quoteVolume) : "—"}</span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );

  const mchBodyEl = (
            <div className="mch-body">
            {/* The old .mch-mobile-summary card (coin/zone-signal/price/
                change/high-low/vol) lived here, mobile-only — fully
                redundant now that PriceChart.tsx's own compact-view
                header shows the exact same data, mobile and desktop
                both (chart-hero-id-row/cpv-price-row/chart-fs-stat-row),
                and removed so mobile stops showing information desktop
                never did. .mch-stats below (liquidation/OI/funding/RSI/
                MACD/long-short — genuinely different, market-wide data)
                is unrelated and still shown on both as before. */}
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
            </div>
  );

  return (
    <>
    <div className={`app-shell${navCollapsed ? " nav-collapsed" : ""}`}>
      {showOnboarding && (
        <OnboardingWizard
          onComplete={() => setShowOnboarding(false)}
          onSkip={() => setShowOnboarding(false)}
        />
      )}
      {/* What's New card paused/hidden for now (user request) — component
          and its trigger logic (showWhatsNew etc.) left intact below,
          just not rendered. Re-enable by uncommenting this block. */}
      {/* {showWhatsNew && isWideDesktop && !Capacitor.isNativePlatform() && activeSection === "chart" && (
        <WhatsNewModal
          onClose={() => setShowWhatsNew(false)}
          onNavigate={(section) => {
            if (section === "analyze-chart") setChartAnalyzeOpen(true);
            else setActiveSection(section as SectionId);
          }}
        />
      )} */}
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
          onOpenAssetCalc={() => setAssetPanelOpen(true)}
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
        {(() => {
          const gate = promoSection ? PAYWALLED_PAGES[promoSection] : undefined;
          return (
            <PaywallPromo
              open={!!gate}
              onClose={() => setPromoSection(null)}
              requiredTier={gate?.tier ?? "pro"}
              featureName={gate?.name ?? ""}
              onOpenAuth={onOpenAuth}
              onOpenUpgrade={onOpenUpgrade ?? (() => {})}
            />
          );
        })()}
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
        <nav
          className={`icon-strip${mobileNavOpen ? " mobile-open" : ""}${navCollapsed && !navPeek ? " nav-collapsed" : ""}${navCollapsed && navPeek ? " nav-peek" : ""}`}
          // Mobile: closed menu is out of the tap/focus order entirely.
          {...(!isDesktopWidth && !mobileNavOpen ? { inert: "" } : {})}
          // Collapsed (icon-only) rail: hovering opens the full labeled
          // sidebar over the page (nav-peek), leaving collapses it again.
          onMouseEnter={() => {
            if (!navCollapsed || !isDesktopWidth) return;
            window.clearTimeout(navPeekTimer.current);
            navPeekTimer.current = window.setTimeout(() => setNavPeek(true), 120);
          }}
          onMouseLeave={() => {
            window.clearTimeout(navPeekTimer.current);
            navPeekTimer.current = window.setTimeout(() => setNavPeek(false), 150);
          }}
        >
          <button
            className="icon-strip-logo"
            onClick={fetchBTCData}
            title={t("header.clickToRefresh")}
          >
            <CoinHintzLogo loading={loading || refreshing} />
          </button>

          {/* Desktop only (>=961px, App.css) — drag to snap the wide
              labeled rail to a narrow icon-only one and back. */}
          <div
            className="icon-strip-resize-handle"
            onPointerDown={onNavResizeDown}
            onPointerMove={onNavResizeMove}
            onPointerUp={onNavResizeUp}
            title={navCollapsed ? "Drag to expand sidebar" : "Drag to collapse sidebar"}
          />

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
                type="button"
                className="icon-strip-btn icon-strip-support"
                onClick={() => {
                  setContactOpen(true);
                  setMobileNavOpen(false);
                }}
                title={t("nav.support", "Support")}
              >
                <span className="nav-icon-wrap">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </span>
                <span className="icon-strip-label">{t("nav.support", "Support")}</span>
                <span className="icon-strip-support-badge">
                  <span className="icon-strip-support-dot" />
                  {t("nav.online", "Online")}
                </span>
              </button>

              {/* Signed in: Sign out. Signed out: Sign in / Register
                  (opens the auth sheet) — never "Sign out" without an
                  account. */}
              {user ? (
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
              ) : (
                <button
                  className="icon-strip-btn"
                  onClick={() => {
                    setMobileNavOpen(false);
                    onOpenAuth();
                  }}
                  title={t("nav.signIn", "Sign In")}
                >
                  <span className="nav-icon-wrap">
                    <NavIcon d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" />
                  </span>
                  <span className="icon-strip-label">{t("nav.signIn", "Sign In")}</span>
                </button>
              )}
            </div>
          )}

          {/* Desktop web only — the wide labeled sidebar (>=961px,
              App.css) has room for this; the narrow rail/tablet flyout
              doesn't. Settings/sign-out above still cover mobile+native;
              this isn't a duplicate of those, it's the desktop-web
              equivalent that was missing entirely before (that platform
              had no bottom section at all). */}
          {!Capacitor.isNativePlatform() && isWideDesktop && (
            <div className="icon-strip-bottom-web">
              <button type="button" className="icon-strip-btn" onClick={() => setDrawerOpen(true)} title={t("drawer.settings")}>
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

              <button type="button" className="icon-strip-btn icon-strip-support" onClick={() => setContactOpen(true)}>
                <span className="nav-icon-wrap">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </span>
                <span className="icon-strip-label">{t("nav.support", "Support")}</span>
                <span className="icon-strip-support-badge">
                  <span className="icon-strip-support-dot" />
                  {t("nav.online", "Online")}
                </span>
              </button>

              {inviteCardOpen && (
                <div className="icon-strip-invite-card">
                  <button type="button" className="icon-strip-invite-close" onClick={() => setInviteCardOpen(false)} aria-label="Dismiss">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                  <div className="icon-strip-invite-title">{t("nav.inviteTitle", "Invite a friend")}</div>
                  <p className="icon-strip-invite-sub">
                    {t("nav.inviteSub", "Invite a friend — when they sign up, you get $10,000 in free paper trading cash.")}
                  </p>
                  <input
                    type="email"
                    className="icon-strip-invite-input"
                    placeholder="friend@email.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") sendInvite(); }}
                    disabled={inviteStatus === "sending"}
                  />
                  <button
                    type="button"
                    className={`icon-strip-invite-send${inviteStatus === "sent" ? " icon-strip-invite-send--sent" : ""}${inviteStatus === "error" ? " icon-strip-invite-send--error" : ""}`}
                    onClick={sendInvite}
                    disabled={!inviteEmail.trim() || inviteStatus === "sending"}
                  >
                    {inviteStatus === "sending"
                      ? t("nav.inviteSending", "Sending…")
                      : inviteStatus === "sent"
                        ? t("nav.inviteSent", "Invite sent ✓")
                        : inviteStatus === "error"
                          ? t("nav.inviteError", "Couldn't send — try again")
                          : t("nav.inviteSend", "Send invite")}
                  </button>
                </div>
              )}

              {/* Right above the account row, not after Support. Shared
                  with the phone menu (aiUsageCardEl). */}
              {aiUsageCardEl}

              <button
                type="button"
                className="icon-strip-profile-row"
                onClick={() => { if (user) setProfileOpen(true); else onOpenAuth(); }}
              >
                <Avatar
                  url={profile?.avatar_url}
                  fallback={
                    !user ? (
                      // Signed out: account icon instead of a "?".
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="8" r="4" />
                        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
                      </svg>
                    ) : profile?.full_name
                      ? profile.full_name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()
                      : (user?.email?.[0] ?? "?").toUpperCase()
                  }
                  className="icon-strip-profile-avatar"
                />
                <span className="icon-strip-profile-info">
                  <span className="icon-strip-profile-name">{profile?.full_name || t("nav.guest", "Guest")}</span>
                  <span className="icon-strip-profile-email">{user?.email ?? t("nav.signInPrompt", "Sign in")}</span>
                </span>
              </button>

              {/* Expand / collapse the sidebar (desktop). Collapsed: icon
                  only; it also expands on hover (nav-peek). */}
              <button
                type="button"
                className="icon-strip-btn icon-strip-expand-btn"
                onClick={() => { setNavPeek(false); setNavCollapsed((v) => !v); }}
                title={navCollapsed ? "Expand menu" : "Collapse menu"}
                aria-label={navCollapsed ? "Expand menu" : "Collapse menu"}
              >
                <span className="nav-icon-wrap">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M9 4v16" />
                    {navCollapsed ? <path d="M13 10l2 2-2 2" /> : <path d="M15 10l-2 2 2 2" />}
                  </svg>
                </span>
                <span className="icon-strip-label">{navCollapsed ? "Expand menu" : "Collapse menu"}</span>
              </button>
            </div>
          )}

        </nav>


        <div className="main-panel">
          {!Capacitor.isNativePlatform() && isDesktopWidth && (
            <div className="top-nav-bar">
              <button
                ref={topNavSearchRef}
                className="top-nav-search"
                onClick={openGlobalSearch}
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
                {/* Every icon-button moved up here from .mch-right (the
                    ticker-strip row below) — this row (.top-nav-bar) only
                    ever renders on desktop web (!Capacitor.isNativePlatform()
                    && isDesktopWidth), so that's already an implicit guard;
                    .mch-right's own copies of these same four are only
                    rendered in the opposite case (mobile/native), so
                    PriceAlerts/BuySignals (which need to stay mounted
                    somewhere at every width for their own background price-
                    watching/toast effects) are never mounted twice at once. */}
                {SHOW_FOCUS_BUTTON && isWideDesktop && (
                  <HoverTip
                    className="top-nav-icon-tip"
                    placement="left"
                    text={distractionFree ? "Focus on — alerts muted, distractions hidden. Click to turn off" : "Focus off — click to hide distractions and mute all alerts"}
                  >
                    <button
                      type="button"
                      className={`mch-search-btn mch-focus-btn${distractionFree ? " mch-focus-btn--on" : ""}`}
                      onClick={toggleFocusMode}
                      role="switch"
                      aria-checked={distractionFree}
                      aria-label="Focus mode"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                      </svg>
                    </button>
                  </HoverTip>
                )}
                {(activeSection === "chart" || activeSection === "advance-chart") && isWideDesktop && !distractionFree && (
                  <div className="top-nav-layout-wrap" ref={layoutMenuWrapRef}>
                    <HoverTip className="top-nav-icon-tip" placement="left" text="Chart layout">
                    <button
                      type="button"
                      className={`mch-search-btn top-nav-layout-btn${layoutMenuOpen ? " top-nav-layout-btn--open" : ""}`}
                      onClick={() => setLayoutMenuOpen((v) => !v)}
                      aria-haspopup="true"
                      aria-expanded={layoutMenuOpen}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                        <rect x="1.5" y="2" width="7" height="12" rx="1" />
                        <rect x="10" y="2" width="4.5" height="5.3" rx="1" />
                        <rect x="10" y="8.7" width="4.5" height="5.3" rx="1" />
                      </svg>
                    </button>
                    </HoverTip>
                    {layoutMenuOpen && (
                      <div className="top-nav-layout-menu" role="radiogroup" aria-label="Chart page layout">
                        {([
                          { mode: "2col" as const, title: "2 columns" },
                          { mode: "3col" as const, title: "3 columns" },
                          { mode: "2row" as const, title: "2 rows" },
                        ]).map(({ mode, title }) => (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={chartLayoutMode === mode}
                            className={`top-nav-layout-option${chartLayoutMode === mode ? " active" : ""}`}
                            onClick={() => {
                              setChartLayoutMode(mode);
                              setLayoutMenuOpen(false);
                            }}
                          >
                            <span className="top-nav-layout-option-icon">
                              {mode === "2col" && (
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                                  <rect x="1.5" y="2" width="7" height="12" rx="1" />
                                  <rect x="10" y="2" width="4.5" height="5.3" rx="1" />
                                  <rect x="10" y="8.7" width="4.5" height="5.3" rx="1" />
                                </svg>
                              )}
                              {mode === "3col" && (
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                                  <rect x="1.5" y="2" width="4" height="12" rx="1" />
                                  <rect x="6" y="2" width="4" height="12" rx="1" />
                                  <rect x="10.5" y="2" width="4" height="12" rx="1" />
                                </svg>
                              )}
                              {mode === "2row" && (
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                                  <rect x="1.5" y="2" width="13" height="5.3" rx="1" />
                                  <rect x="1.5" y="8.7" width="6" height="5.3" rx="1" />
                                  <rect x="8.5" y="8.7" width="6" height="5.3" rx="1" />
                                </svg>
                              )}
                            </span>
                            {title}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {activeSection === "markets" && isWideDesktop && !distractionFree && (
                  <HoverTip
                    className="top-nav-icon-tip"
                    placement="left"
                    text={marketsSingleColumn ? "Show Daily Brief" : "Full width (close Daily Brief)"}
                  >
                    <button
                      type="button"
                      className={`mch-search-btn top-nav-layout-btn${marketsSingleColumn ? " top-nav-layout-btn--open" : ""}`}
                      onClick={() => setMarketsSingleColumn((v) => !v)}
                      aria-pressed={marketsSingleColumn}
                    >
                      {marketsSingleColumn ? (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                          <rect x="1.5" y="2" width="13" height="12" rx="1" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                          <rect x="1.5" y="2" width="7" height="12" rx="1" />
                          <rect x="10" y="2" width="4.5" height="12" rx="1" />
                        </svg>
                      )}
                    </button>
                  </HoverTip>
                )}
                {activeSection === "chart" && chartModeToggle}
                {activeSection !== "chart" && activeSection !== "advance-chart" && (
                  <HoverTip className="top-nav-icon-tip" placement="left" text={t("paperTrading.title", "Paper Trading")}>
                    <button
                      type="button"
                      className={`mch-search-btn top-nav-layout-btn${paperTradingFlyoutOpen ? " top-nav-layout-btn--open" : ""}`}
                      onClick={() => setPaperTradingFlyoutOpen((v) => !v)}
                      aria-pressed={paperTradingFlyoutOpen}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                      </svg>
                    </button>
                  </HoverTip>
                )}
                <PriceAlerts coin={coin} currentPrice={btcData?.price ?? 0} coinChatOpen={activeSection === "chart" && showCoinChat} />
                <BuySignals onOpenUpgrade={onOpenUpgrade} hideTrigger={!isWideDesktop} columnTarget={activatedPanelsRailEl} />
                <HoverTip className="top-nav-icon-tip" placement="left" text="Notifications">
                  <button
                    className="mch-search-btn mch-notif-feed-btn"
                    onClick={() => (user ? setNotificationsCenterOpen(true) : onOpenAuth())}
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
                    </svg>
                    {unreadNotifCount > 0 && (
                      <span className="mch-notif-feed-count">{unreadNotifCount > 9 ? "9+" : unreadNotifCount}</span>
                    )}
                  </button>
                </HoverTip>
                {/* Sign out lives inside the avatar's own dropdown now
                    (AccountMenu's `dropdown` prop) — Settings stays its own
                    visible icon here too, restyled as a filled dark square
                    (3x3 grid glyph) to match the reference look. */}
                <HoverTip className="top-nav-icon-tip" placement="left" text={t("drawer.settings")}>
                  <button
                    className="top-nav-icon-btn top-nav-icon-btn--settings"
                    onClick={() => setDrawerOpen(true)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="5" cy="5" r="2" />
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="19" cy="5" r="2" />
                      <circle cx="5" cy="12" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="19" cy="12" r="2" />
                      <circle cx="5" cy="19" r="2" />
                      <circle cx="12" cy="19" r="2" />
                      <circle cx="19" cy="19" r="2" />
                    </svg>
                  </button>
                </HoverTip>
                <AccountMenu
                  onOpenAuth={onOpenAuth}
                  onOpenUpgrade={onOpenUpgrade}
                  onOpenProfile={() => setProfileOpen(true)}
                  onOpenSettings={() => setDrawerOpen(true)}
                  iconFallback
                  dropdown
                />
              </div>
            </div>
          )}
          {/* Skipped entirely on desktop web, for every page, not just
              Chart/Advance Chart — everything it would show there is
              already gone or moved: the hamburger (desktop has the
              persistent .icon-strip sidebar, never needs a mobile-nav
              toggle), the logo (already isDesktopWidth-hidden), the coin
              button (chart-hero-id-row is the selector on chart pages;
              other pages never had one worth duplicating here), and
              mch-right (already moved up into .top-nav-bar's own
              .top-nav-icons for desktop web). Mobile/native still get the
              real thing: the hamburger, mch-right's fallback icons, and
              the coin button are all still needed there. */}
          {!(isDesktopWidth && !Capacitor.isNativePlatform()) && (
          <div ref={mchRef} className="main-coin-header">
            <div className="mch-left">
              <button
                className="mch-menu-btn"
                onClick={() => {
                  if (!mobileNavOpen) hapticTap();
                  setMobileNavOpen((v) => !v);
                }}
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
              {/* Chart/Advance Chart pages: PriceChart.tsx's own
                  chart-hero-id-row is now the coin selector there too
                  (desktop included, not just mobile) — this button would
                  just be a second, redundant coin switcher right next to
                  it. Every other page still has no such hero, so this
                  stays the only one there. */}
              {activeSection !== "chart" && activeSection !== "advance-chart" && (
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
                    <>
                      <span className="mch-coin-price mch-coin-price--full">
                        {formatLivePrice(livePrice ?? btcData!.price!)}
                      </span>
                      <span className="mch-coin-price mch-coin-price--short">
                        {formatHeaderPriceMobile(livePrice ?? btcData!.price!)}
                      </span>
                    </>
                  )}
                  <span className="price-source">
                    <span className="price-source-fs-hint">
                      ⛶ Double-click chart for fullscreen
                    </span>
                  </span>
                </div>
                {coinTickers.get(coin)?.change !== undefined && (
                  <span className={`mch-coin-chg${coinTickers.get(coin)!.change >= 0 ? " mch-coin-chg--up" : " mch-coin-chg--down"}`}>
                    {coinTickers.get(coin)!.change >= 0 ? "▲" : "▼"} {Math.abs(coinTickers.get(coin)!.change).toFixed(1)}%
                  </span>
                )}
                <span className="mch-coin-chevron">▾</span>
              </button>
              )}
            </div>

            <div className="mch-right">
              {/* Only rendered on real phones/native now — the desktop-web
                  copy of this exact same set of controls lives in
                  .top-nav-icons instead (moved up there per instruction).
                  Never both at once: this is the mobile/native fallback for
                  PriceAlerts/BuySignals, which still need to stay mounted
                  somewhere at every width for their own background price-
                  watching/toast effects, and for the notifications bell,
                  which is still the only way to reach the feed on mobile
                  (FloatingNavBar's own Notifications icon was removed as a
                  duplicate entry point). */}
              {!(isDesktopWidth && !Capacitor.isNativePlatform()) && (
                <>
                  {chartModeToggle}
                  <PriceAlerts coin={coin} currentPrice={btcData?.price ?? 0} coinChatOpen={activeSection === "chart" && showCoinChat} />
                  <BuySignals onOpenUpgrade={onOpenUpgrade} hideTrigger={!isWideDesktop} />
                  <button
                    className="mch-search-btn mch-notif-feed-btn"
                    onClick={() => (user ? setNotificationsCenterOpen(true) : onOpenAuth())}
                    title="Notifications"
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
                    </svg>
                    <span className="mch-btn-label">Notifications</span>
                    {unreadNotifCount > 0 && (
                      <span className="mch-notif-feed-count">{unreadNotifCount > 9 ? "9+" : unreadNotifCount}</span>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>
          )}

          <div className="main-content-row">
          <div
            ref={mainContentRef}
            className={`main-content${activeSection === "chart" || activeSection === "advance-chart" || activeSection === "markets" ? " chart-active" : ""}`}
          >
            <div
              className={`ptr-indicator${!ptrDragging ? " ptr-indicator--settling" : ""}`}
              style={{ height: ptrPullDistance }}
            >
              {(ptrPullDistance > 0 || ptrRefreshing) && (
                <span
                  className="ptr-logo-wrap"
                  style={!ptrRefreshing ? { transform: `rotate(${ptrProgress * 360}deg)` } : undefined}
                >
                  {ptrRefreshing && <span className="ptr-logo-glow" />}
                  {ptrRefreshing && <span className="ptr-logo-ring" />}
                  <LogoIcon size={26} animated={ptrRefreshing} />
                </span>
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

            {(activeSection === "chart" || activeSection === "markets") && (() => {
              // chartRightColEl itself is now declared once at component
              // scope (see its own comment above) so it's shared with the
              // every-other-page mobile block further down — rendered in
              // exactly ONE spot at a time regardless of which page, so
              // PaperTradingCard/OrderFlowPanel (which poll live data in
              // the background) are never double-mounted. At every width
              // narrower than 961px this renders exactly where it always
              // has (beside the chart, inside .chart-section-wrap,
              // preserving the existing tablet/mobile tab-switching
              // behavior untouched); only >=961px moves it into the new
              // experimental second column below.
              // chartRightColTabbedEl (Paper Trading / Order Flow Pressure /
              // Order Book as one flat tab row, "2col" layout only) is now
              // ALSO hoisted to component scope, same place/reasoning as
              // chartRightColEl right above it — reused here unchanged.
              const dailyBriefEl = <DailyBrief coinTickers={coinTickers} variant="page" />;
              // Markets keeps the exact same right-column sidebar (Paper
              // Trading/Order Flow/Daily Brief) and layout-mode machinery
              // below as the Chart page — just a much simpler left column
              // (GlobalMarkets itself has no order-book/resize-handle/
              // mobile-tab concept to wire up, unlike PriceChart's own). At
              // narrow widths chartRightColEl moves inside this column
              // (same fallback PriceChart's own chart-section-wrap does
              // via `{!isWideDesktop && chartRightColEl}` below) since the
              // page-row fallback further down only ever renders this one
              // column on its own.
              const chartColumnEl = activeSection === "markets" ? (
                <div className={`chart-column${isWideDesktop ? " chart-two-col-left" : ""}`}>
                  {/* Hidden (not unmounted), same display:none/contents
                      swap as every other page uses below for the same
                      mobileChartTab state — keeps GlobalMarkets' own
                      scroll position/live polling intact across toggles
                      instead of refetching every time. */}
                  <div style={!isWideDesktop ? { display: mobileChartTab === "orderbook" ? "none" : "contents" } : undefined}>
                    <GlobalMarkets
                      onSelectCoin={(symbol) => { openChartCoin(symbol, { recent: true, navigate: true }); }}
                    />
                  </div>
                  {/* Mobile Paper Trading/Order Flow for "orderbook" no
                      longer mounts here — moved to the same generic slot
                      every other non-chart page uses (further down,
                      activeSection !== "chart"), since this nested-inside
                      -.chart-column mount point gave Markets different
                      spacing/layout than every other page's identical
                      chartRightColEl despite being the exact same
                      component. One mount point, one layout context. */}
                </div>
              ) : (
                    <div className={`chart-column${isWideDesktop ? " chart-two-col-left" : ""}`}>
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
                        // Chart page "2col" (wide desktop): the Order Book /
                        // Order Flow column lives inside the price chart's
                        // own container, beside the chart, instead of as a
                        // separate page column.
                        sideColumn={isWideDesktop && !distractionFree && chartLayoutMode === "2col" ? chartFlowColEl : undefined}
                        quoteVolume24h={coinTickers.get(coin)?.quoteVolume}
                        onZoneChange={(zone, price) => {
                          setChartZone(zone);
                          setChartPrice(price);
                        }}
                        onChartEventsChange={setChartEvents}
                        onOpenAuth={onOpenAuth}
                        onOpenUpgrade={onOpenUpgrade}
                        onOpenCoinPicker={openCoinPicker}
                        onSelectCoin={(symbol) => { openChartCoin(symbol, { recent: true }); }}
                        onFullscreenChange={setChartFullscreen}
                        coinChatOpen={SHOW_COIN_CHAT && showCoinChat}
                        onToggleCoinChat={SHOW_COIN_CHAT ? () => setShowCoinChat((v) => !v) : undefined}
                        headerStats={mchBodyEl}
                        onOpenDrawingTools={() => {
                          advanceChartPushedRef.current = true;
                          setActiveSection("advance-chart");
                        }}
                        onOpenPaperTrade={() => {
                          setMobileChartTab("orderbook");
                          mainContentRef.current?.scrollTo({ top: 0 });
                          window.scrollTo({ top: 0 });
                        }}
                        onNavigateToPage={() => {
                          if (!isDesktopWidth) {
                            setMobileAdvanceChartOpen(true);
                            return;
                          }
                          advanceChartPushedRef.current = true;
                          setActiveSection("advance-chart");
                        }}
                      >
                        {/* Rendered inside .price-chart-container itself
                            (PriceChart.tsx's own `children` slot), below
                            the chart, instead of as separate full-width
                            blocks after .chart-page-row. */}
                        {/* Wide desktop: Top Cryptocurrencies (same table as
                            the Markets page) full width, with a filter
                            dropdown (All / Watchlist / Winners / Losers /
                            Trending). Narrower widths keep the plain stacked
                            Watchlist + Trending as before. */}
                        {/* Every screen size now (mobile included) — the
                            old Watchlist + Trending lists are replaced by the
                            same panel; Watchlist lives in its filter. */}
                        {!distractionFree ? (
                          <div className="chart-below-full">
                            <ChartBottomPanel
                              coin={coin}
                              onSelectCoin={(symbol) => { openChartCoin(symbol); }}
                              onOpenAuth={onOpenAuth}
                              onOpenPaperTrading={() => setActiveSection("riskcalc")}
                            />
                          </div>
                        ) : null}
                      </PriceChart>
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
                      {!isWideDesktop && chartRightColTabbedEl}
                    </div>
                  </div>
              );
              return (
              <>
                {isWideDesktop && !distractionFree ? (
                  activeSection === "markets" ? (
                    // Markets desktop: always just chart + Daily Brief (no
                    // Paper Trading/Order Flow column, no expand toggle —
                    // the three chartLayoutMode choices below are a Chart-
                    // page-specific preference between three blocks;
                    // Markets only ever has two, so it ignores that picker
                    // entirely), or Daily Brief closed outright via the
                    // single-column toggle (marketsSingleColumn, its own
                    // icon next to where that picker would be).
                    marketsSingleColumn ? (
                      <div className="chart-page-row">{chartColumnEl}</div>
                    ) : (
                      <div className="chart-layout chart-layout--3col">
                        {chartColumnEl}
                        <div className="chart-three-col-right">{dailyBriefEl}</div>
                      </div>
                    )
                  ) : chartLayoutMode === "2row" ? (
                    <div className="chart-layout chart-layout--2row">
                      <div className="chart-row-top">{chartColumnEl}</div>
                      <div className="chart-row-bottom">
                        <div className="chart-row-bottom-col">{chartRightColEl}</div>
                      </div>
                    </div>
                  ) : chartLayoutMode === "3col" ? (
                    <div className="chart-layout chart-layout--3col">
                      {chartColumnEl}
                      <div className="chart-three-col-mid">{chartRightColEl}</div>
                    </div>
                  ) : (
                    <div className="chart-layout chart-layout--2col">
                      {chartColumnEl}
                      <div className="chart-two-col-right chart-two-col-right--paper">
                        {chartPaperColEl}
                      </div>
                    </div>
                  )
                ) : (
                  <div className="chart-page-row">{chartColumnEl}</div>
                )}
              </>
              );
            })()}
            {activeSection === "advance-chart" && (
              <PriceChart
                refreshTrigger={refreshTrigger}
                theme={theme}
                coin={coin}
                quoteVolume24h={coinTickers.get(coin)?.quoteVolume}
                onZoneChange={(zone, price) => {
                  setChartZone(zone);
                  setChartPrice(price);
                }}
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                onOpenCoinPicker={openCoinPicker}
                onSelectCoin={(symbol) => { openChartCoin(symbol, { recent: true }); }}
                onFullscreenChange={setChartFullscreen}
                pageMode
                onNavigateBack={() => {
                  if (advanceChartPushedRef.current) {
                    advanceChartPushedRef.current = false;
                    window.history.back();
                  } else {
                    setActiveSection("chart");
                  }
                }}
              />
            )}
            {mobileAdvanceChartOpen && !isDesktopWidth && (
              <MobileSymbolSheet
                coin={coin}
                theme={theme}
                quoteVolume24h={coinTickers.get(coin)?.quoteVolume}
                ticker={coinTickers.get(coin)}
                onOpenAuth={onOpenAuth}
                onOpenUpgrade={onOpenUpgrade}
                onOpenCoinPicker={openCoinPicker}
                onClose={() => setMobileAdvanceChartOpen(false)}
                onOpenFullChart={() => {
                  setMobileAdvanceChartOpen(false);
                  advanceChartPushedRef.current = true;
                  setActiveSection("advance-chart");
                }}
              />
            )}
            {/* Hidden (not unmounted) rather than swapped out entirely
                while mobileChartTab is "orderbook" — same reasoning as
                candleAIVisited's own display:none/contents toggle just
                inside here: the page underneath (incl. CandleWatcher's
                already-persisted instance) keeps its scroll position/
                live polling/local state instead of refetching every time
                chart-right-col is flipped on and back off. */}
            <div style={{ display: mobileChartTab === "orderbook" ? "none" : "contents" }}>
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
                <TradeManager onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />
              )}
              {activeSection === "marketheatmap" && <MarketHeatmap />}
              {activeSection === "altanalysis" && (
                <BlurGate
                  requiredTier="pro"
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
                    ticker={coinTickers.get(coin)}
                    onOpenCoinPicker={openCoinPicker}
                  />
                </Suspense>
              </div>
            )}
            </div>
            {/* Paper Trading / Order Flow Pressure / Order Book — shown
                only while mobileChartTab is "orderbook", replacing the
                page above instead of stacking below it. Tabbed
                (chartRightColTabbedEl), same component the desktop
                top-bar flyout uses, not the plain stacked chartRightColEl
                — mobile had no tab switcher here at all before, unlike
                every desktop entry point into Paper Trading. Chart never
                hits this (it already renders the exact same
                chartRightColTabbedEl as part of its own layout, driven by
                the same mobileChartTab state — never both at once).
                Markets used to have its own separate nested mount point
                too, giving it different spacing from every other page
                despite being the identical component — now uses this
                same one, like everything else does. Advance Chart has no
                equivalent slot at all, so it's excluded rather than
                silently broken. Hidden via CSS (not unmounted) once
                activeSection allows it at all — mounting
                PaperTradingCard/OrderFlowPanel fresh on every tap was
                doing real synchronous work on the main thread right as the
                tap fired, which is why taps sometimes needed repeating. */}
            {!isWideDesktop && activeSection !== "chart" && activeSection !== "advance-chart" && (
              <div style={{ display: mobileChartTab === "orderbook" ? "contents" : "none" }}>
                {chartRightColTabbedEl}
              </div>
            )}
          </div>
          {/* Paper Trading / Buy Signals, added as a real column here
              when activated from their top-bar icons (desktop only —
              nothing ever renders into this on mobile/native, so it
              stays :empty/collapsed there), removed again the moment
              they're toggled off. BuySignals portals its own column
              content into this same element via columnTarget; Paper
              Trading's is simple enough to just render directly. */}
          <aside className="activated-panels-rail" ref={setActivatedPanelsRailEl}>
            {/* Chart (only — Markets never embeds one, "always just chart
                + Daily Brief" per chartColumnEl's own comment above)
                already embeds its own Paper Trading column directly in
                its "2col"/"2row"/"3col" layouts — showing the flyout too
                on that page would duplicate it side by side. */}
            {paperTradingFlyoutOpen && activeSection !== "chart" && (
              <div className="activated-panel">
                <div className="activated-panel-head">
                  <button
                    type="button"
                    className="activated-panel-close"
                    onClick={() => setPaperTradingFlyoutOpen(false)}
                    aria-label={t("common.close", "Close")}
                  >
                    ✕
                  </button>
                </div>
                {/* Same column as the #chart page (Paper Trading /
                    Position Intelligence tabs). */}
                {chartPaperColEl}
              </div>
            )}
          </aside>
          </div>
        </div>

        {SHOW_COIN_CHAT && activeSection === "chart" && (
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

        {coinPickerOpen && isDesktopWidth &&
          ReactDOM.createPortal(
            <>
              <div className="coin-picker-backdrop" onClick={closeCoinPicker} />
              <div
                className="coin-picker-menu coin-picker-menu--table"
                style={{ top: coinPickerPos.top, left: coinPickerPos.left }}
              >
                {coinPickerTableContent}
              </div>
            </>,
            document.body,
          )}
        {/* Phones / iOS: the shared BottomSheet. */}
        {!isDesktopWidth && (
          <BottomSheet
            open={coinPickerOpen}
            onClose={closeCoinPicker}
            title="Select a Crypto"
            className="coin-picker-sheet coin-picker-bs"
            bodyClassName="coin-picker-bs-body"
            ariaLabel="Select a Crypto"
          >
            {coinPickerTableContent}
          </BottomSheet>
        )}

        <CoinUnavailableSheet
          symbol={unavailableCoin}
          onClose={() => setUnavailableCoin(null)}
          onBrowse={() => openCoinPicker()}
        />
        <GlobalSearch
          open={globalSearch}
          onClose={() => setGlobalSearch(false)}
          onCoinSelect={(c) => { openChartCoin(c, { navigate: true }); }}
          onSectionSelect={(s) => { openSection(s as SectionId); }}
          // Mobile's only remaining path to this is FloatingNavBar's
          // Search icon (the old mobile header search button was moved
          // there) — "docked" attaches it directly above the nav bar.
          // Desktop used to be a centered ⌘K-style modal; now "anchored"
          // drops it directly under .top-nav-search instead (YouTube's own
          // search-bar-with-suggestions layout, not a page-dimming modal).
          variant={isWideDesktop ? "anchored" : "docked"}
          anchorRect={searchAnchor}
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

        {/* Mobile: whale alerts only on the Trade page (#trade). Desktop unchanged. */}
        {(isWideDesktop || activeSection === "chart") && (
          <WhaleAlerts btcPrice={btcData?.price} coinChatOpen={activeSection === "chart" && showCoinChat} />
        )}

        <div ref={backSwipeRef} className="back-swipe" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
        </div>
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

      <PushToast />
      <TradingAgent
        selectedCoin={coin}
        hideTrigger={!isWideDesktop}
        isMobile={!isWideDesktop}
        coinTickers={coinTickers}
        onNavigateToSection={(section) => setActiveSection(section as SectionId)}
        onAgentLocked={agentGate}
        onReportIssue={() => setContactOpen(true)}
        showIntroShowcase={showAgentShowcase}
        // Advance Chart page — the floating trigger asks for (and
        // attaches) a chart screenshot instead of opening blank; see
        // TradingAgent.tsx's own Props comments for the event handoff.
        triggerLabel={activeSection === "advance-chart" ? "Ask Agent ready" : undefined}
        triggerCapturesChart={activeSection === "advance-chart"}
      />
      {showAgentShowcase && <AgentIntroShowcase />}
      <NotificationsCenter
        open={notificationsCenterOpen}
        onClose={() => setNotificationsCenterOpen(false)}
        onUnreadCountChange={setUnreadNotifCount}
      />
      {/* News (Daily Brief) — the original draggable bottom sheet, same as
          before, but mounted fresh on each tap starting at "expanded"
          (not the small docked pill) since there's no more auto-open
          instance keeping it around collapsed in the background. Its own
          "full"/"expanded" states already render their own .db-backdrop
          (DailyBrief.tsx), and dragging down to "minimized" fires
          onDismiss, which unmounts this the same way the old auto-open
          instance did. Explicit !isWideDesktop guard here too, not just
          reliance on dailyBriefPanelOpen never being set true on desktop
          (its only trigger, FloatingNavBar's News icon, is itself
          desktop-gated) — belt and suspenders against any future code
          path, or a stale true value surviving a mobile→desktop resize,
          ever showing this bottom-sheet UI on desktop. */}
      {dailyBriefPanelOpen && !isWideDesktop && (
        <DailyBrief
          coinTickers={coinTickers}
          initialState="expanded"
          onDismiss={() => setDailyBriefPanelOpen(false)}
        />
      )}
      {/* Mobile/iOS only by design, not just CSS — FloatingNavBar.css also
          hides it at desktop widths, but gating the mount itself here too
          means none of its click handlers or active-pill state exist on
          desktop at all. */}
      {!isWideDesktop && !distractionFree && !chartFullscreen && (
        <FloatingNavBar
          signalsOpen={signalsOpen}
          onSearch={() => setGlobalSearch(true)}
          searchOpen={globalSearch}
          profileOpen={profileOpen}
          agentUnread={agentUnread}
          onOpenDailyBrief={() => setDailyBriefPanelOpen((v) => !v)}
          dailyBriefOpen={dailyBriefPanelOpen}
          agentLocked={!hasAccess(tier, "elite")}
          onAgentLocked={agentGate}
          onGoHome={() => {
            // Closes whichever of the four mutually-exclusive panels is
            // currently open (each a no-op if it's already closed) and
            // drops back to the Trade page (#trade) — Home's own "you're at
            // rest" state, not a fifth panel of its own. Matches the app's
            // default landing section (see activeSection's initializer).
            if (signalsOpen) window.dispatchEvent(new CustomEvent("close-buy-signals"));
            setAssetPanelOpen(false);
            setProfileOpen(false);
            setGlobalSearch(false);
            setDailyBriefPanelOpen(false);
            setChartAnalyzeOpen(false);
            setActiveSection("chart");
          }}
          homeActive={activeSection === "chart" && !signalsOpen && !assetPanelOpen && !globalSearch && !profileOpen && !dailyBriefPanelOpen}
          showAgentShowcase={showAgentShowcase}
        />
      )}
      {/* Agent Ready is elite-only (see hasAccess(tier, "elite") above) —
          tapping it while locked shows this dedicated single-plan Elite
          card instead of the generic 3-tier UpgradeModal, so the promo
          stays scoped to the one tier that's actually relevant. */}
      {showEliteUpsell && (
        <EliteUpsellModal
          onClose={() => setShowEliteUpsell(false)}
          onOpenAuth={onOpenAuth}
        />
      )}

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
    {focusToast && ReactDOM.createPortal(
      <div className="focus-toast" role="status">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        Focus mode activated
      </div>,
      document.body,
    )}
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
  const [showUpgrade, setShowUpgrade] = useState(false);
  // The plan picker ("Choose your plan") is only for signed-in users —
  // anyone not signed in gets the sign in / sign up screen instead, from
  // every entry point (buttons, upgrade-reminder push taps, etc.).
  const userRef = useRef(user);
  userRef.current = user;
  const openUpgrade = useCallback(() => {
    if (userRef.current) setShowUpgrade(true);
    else setShowAuth(true);
  }, []);

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
    const onOpenUpgradeEvent = () => openUpgrade();
    window.addEventListener("open-upgrade-modal", onOpenUpgradeEvent);
    return () => window.removeEventListener("open-upgrade-modal", onOpenUpgradeEvent);
  }, [openUpgrade]);

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

  // No more blanket "signed out = LandingPage instead of the whole app"
  // wall — none of the real pages require signing in to view/use anymore
  // (pro/elite tier gates are unaffected, and Paper Trading's own sign-up
  // requirement is enforced inside PaperTradingCard itself, not here).
  // AuthModal is still reachable via onOpenAuth wherever something
  // actually needs an account.
  return (
    <>
      <AppDashboard
        onOpenAuth={() => setShowAuth(true)}
        onOpenUpgrade={openUpgrade}
        theme={theme}
        setTheme={setTheme}
      />
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showUpgrade && user && (
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
    <>
      {/* Outside AuthProvider/AppGate entirely, deliberately — AppGate has
          several early returns (boot screen, auth gate, terms gate) before
          it ever reaches the dashboard; mounting this inside any one of
          those branches would miss the others. This way it's guaranteed
          to show regardless of auth/loading state — a connectivity notice
          is exactly the kind of thing you still need to see while stuck
          on, say, the boot screen because the network request behind it
          never came back. */}
      <OfflineBanner />
      <AuthProvider>
        <AppGate />
      </AuthProvider>
    </>
  );
}

export default App;
