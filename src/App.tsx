import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { coinglass, BTCData, CoinSymbol, clearCandleCache, COINS } from "./services/coinglass";
import { AIPredictionPanel } from "./components/AIPredictionPanel";
import { ChatInterface } from "./components/ChatInterface";
import { PriceChart } from "./components/PriceChart";
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
import { FearGreedGauge } from "./components/FearGreedGauge";
import { OnChainMetrics } from "./components/OnChainMetrics";
import { AlertsBuilder } from "./components/AlertsBuilder";
import { OrderBook } from "./components/OrderBook";
import { ETFInflows } from "./components/ETFInflows";
import { PositionFlows } from "./components/PositionFlows";
import { OrderFlowFramework } from "./components/OrderFlowFramework";
import { Watchlist } from "./components/Watchlist";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { FlashNewsBanner } from "./components/FlashNewsBanner";
import { WhaleAlerts } from "./components/WhaleAlerts";
import { AuthModal } from "./components/AuthModal";
import { BlurGate } from "./components/MembershipGate";
import { UpgradeModal } from "./components/UpgradeModal";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { LandingPage } from "./components/LandingPage";
import { PTickerBgChart } from "./components/PTickerBgChart";
import { PredictionEngine } from "./components/PredictionEngine";
import { ZoneResult } from "./components/PriceChart.types";
import { hasAccess, Tier } from "./services/supabase";
import "./App.css";

type SectionId = "chart" | "ai" | "heatmap" | "feargreed" | "onchain" | "alerts" | "gann" | "htf" | "chat" | "etf" | "positions" | "orderflow" | "signals";

const NAV_ITEMS: { id: SectionId; labelKey: string; d: string | string[]; requiredTier?: Tier; hidden?: boolean }[] = [
  { id: "chart",     labelKey: "nav.chart",     d: ["M3 3v18h18", "M7 16l4-4 4 4 5-5"] },
  {
    id: "ai",        labelKey: "nav.ai",
    d: [
      "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
      "M20 3v4M22 5h-4",
      "M4 17v2M5 18H3",
    ],
  },
  {
    id: "feargreed", labelKey: "nav.feargreed",
    d: ["M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z", "M12 6v6l4 2"],
  },
  { id: "heatmap",   labelKey: "nav.heatmap",   d: ["M3 3h7v7H3z", "M14 3h7v7h-7z", "M3 14h7v7H3z", "M14 14h7v7h-7z"] },
  { id: "onchain",   labelKey: "nav.onchain",   d: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" },
  { id: "gann",      labelKey: "nav.gann",      d: "M22 12h-4l-3 9L9 3l-3 9H2", requiredTier: "elite", hidden: true },
  { id: "alerts",    labelKey: "nav.alerts",    d: ["M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9", "M13.73 21a2 2 0 01-3.46 0"] },
  { id: "etf",       labelKey: "nav.etf",       d: ["M12 2v20", "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"] },
  { id: "positions", labelKey: "nav.positions", d: ["M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2", "M23 21v-2a4 4 0 00-3-3.87", "M16 3.13a4 4 0 010 7.75", "M9 7a4 4 0 100 8 4 4 0 000-8z"] },
  { id: "htf",       labelKey: "nav.htf",       d: ["M3 3v18h18", "M7 7l5 5 5-5", "M7 12l5 5 5-5"] },
  { id: "orderflow", labelKey: "nav.orderflow", d: ["M2 12h4l3-9 4 18 3-9h6"] },
  { id: "signals",   labelKey: "nav.signals",   d: ["M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 3.9 2.4-7.4L2 9.4h7.6z"] },
];

function NavIcon({ d }: { d: string | string[] }) {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">
      {paths.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

const COIN_ICONS: Record<string, string> = {
  BTC: "₿", ETH: "Ξ", XRP: "◈", SOL: "◎", BNB: "⬡", SUI: "⬟", DOGE: "Ð", ADA: "₳",
  NEAR: "Ⓝ", RENDER: "⬡", ZEC: "ⓩ",
};
const COIN_COLORS: Record<string, string> = {
  BTC: "#f7931a", ETH: "#627eea", XRP: "#346aa9", SOL: "#9945ff",
  BNB: "#f3ba2f", SUI: "#4da2ff", DOGE: "#c2a633", ADA: "#0033ad",
  NEAR: "#00c08b", RENDER: "#ff3c6e", ZEC: "#f4b728",
};

/* ── Authenticated dashboard — only mounts when user is logged in ── */
interface DashboardProps {
  onOpenAuth: () => void;
  onOpenUpgrade: () => void;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
}

function AppDashboard({ onOpenAuth, onOpenUpgrade, theme, setTheme }: DashboardProps) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const hash = window.location.hash.slice(1) as SectionId;
    return NAV_ITEMS.some(n => n.id === hash) ? hash : "chart";
  });
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingCheckedRef = useRef(false);
  const [showWatchlist, setShowWatchlist] = useState(() => localStorage.getItem("watchlist-visible") !== "false");
  useEffect(() => { localStorage.setItem("watchlist-visible", String(showWatchlist)); }, [showWatchlist]);

  const [coin, setCoin] = useState<CoinSymbol>(() =>
    (localStorage.getItem("coin") as CoinSymbol) || "BTC"
  );

  useEffect(() => { localStorage.setItem("coin", coin); }, [coin]);
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const [btcData, setBtcData] = useState<Partial<BTCData> | null>(() => {
    try {
      const storedCoin = (localStorage.getItem("coin") as CoinSymbol) || "BTC";
      const raw = localStorage.getItem(`btcData_${storedCoin}`);
      return raw ? (JSON.parse(raw) as Partial<BTCData>) : null;
    } catch { return null; }
  });
  const [loading, setLoading] = useState(() => {
    try {
      const storedCoin = (localStorage.getItem("coin") as CoinSymbol) || "BTC";
      return !localStorage.getItem(`btcData_${storedCoin}`);
    } catch { return true; }
  });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [btcAmount, setBtcAmount] = useState(() => localStorage.getItem("btcAmount") || "0");
  const [btcCost, setBtcCost] = useState(() => localStorage.getItem("btcCost") || "0");
  const btcDataRef = useRef<Partial<BTCData> | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceTicker, setPriceTicker] = useState(false);
  const [tickerFlash, setTickerFlash] = useState<"up" | "down" | null>(null);
  const [tickerMuted, setTickerMuted] = useState(true);
  const [rockets, setRockets] = useState<{ id: number; dir: "up" | "down"; x: number }[]>([]);
  const prevTickerPrice = useRef<number | null>(null);
  const coinBtnClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickerOpenPrice = useRef<number | null>(null);
  const tickerLastMilestone = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => { btcDataRef.current = btcData; }, [btcData]);

  // 1-second live price from Binance public ticker
  useEffect(() => {
    const BINANCE_SYM: Record<string, string> = {
      BTC: "BTCUSDT", ETH: "ETHUSDT", XRP: "XRPUSDT", SOL: "SOLUSDT",
      DOGE: "DOGEUSDT", ADA: "ADAUSDT", SUI: "SUIUSDT", BNB: "BNBUSDT",
      NEAR: "NEARUSDT", RENDER: "RENDERUSDT", ZEC: "ZECUSDT",
    };
    const sym = BINANCE_SYM[coin] ?? `${coin}USDT`;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${sym}`);
        if (!res.ok || cancelled) return;
        const d = await res.json();
        if (!cancelled) setLivePrice(parseFloat(d.price));
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(id); };
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
    if (last10 === null) { tickerLastMilestone.current = milestone10; return; }
    if (milestone10 !== last10) {
      const up10 = milestone10 > last10;
      tickerLastMilestone.current = milestone10;
      const id = Date.now();
      const x = 10 + Math.random() * 80;
      setRockets(prev => [...prev, { id, dir: up10 ? "up" : "down", x }]);
      setTimeout(() => setRockets(prev => prev.filter(r => r.id !== id)), 1400);
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
      const play = (freq: number, type: OscillatorType, start: number, dur: number, gainVal: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type; osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(gainVal, ctx.currentTime + start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + dur);
      };
      if (up) {
        play(523, "sine",     0,    0.18, 0.18);
        play(659, "sine",     0.1,  0.18, 0.18);
        play(784, "sine",     0.2,  0.25, 0.22);
      } else {
        play(523, "sine",     0,    0.18, 0.18);
        play(415, "sine",     0.1,  0.18, 0.18);
        play(311, "triangle", 0.2,  0.3,  0.2);
      }
    } catch { /* AudioContext blocked — ignore */ }
  }, [livePrice, priceTicker, tickerMuted]);

  useEffect(() => { localStorage.setItem("btcAmount", btcAmount); }, [btcAmount]);
  useEffect(() => { localStorage.setItem("btcCost", btcCost); }, [btcCost]);

  const btcAmountValue = Number(btcAmount) || 0;
  const btcCostValue   = Number(btcCost)   || 0;
  const [totalAssetValue, setTotalAssetValue] = useState(0);
  const [totalCostBasis,  setTotalCostBasis]  = useState(0);
  const [profitLoss,      setProfitLoss]      = useState(0);

  const { tier, user, profile, signOut } = useAuth();
  useEffect(() => {
    if (profile && !onboardingCheckedRef.current) {
      onboardingCheckedRef.current = true;
      if (!profile.trader_level) setShowOnboarding(true);
    }
  }, [profile]);

  const [assetPanelOpen,  setAssetPanelOpen]  = useState(false);
  const [drawerOpen,      setDrawerOpen]      = useState(false);
  const [profileOpen,     setProfileOpen]     = useState(false);
  const [coinPickerOpen,  setCoinPickerOpen]  = useState(false);
  const [mobileNavOpen,   setMobileNavOpen]   = useState(false);
  const [obSize,          setObSize]          = useState({ h: 380, w: 135 });
  const chartWrapRef  = useRef<HTMLDivElement>(null);
  const dragState     = useRef({ active: false, axis: "col" as "col" | "row", startPos: 0, startSize: 0 });
  const [swipeHint,       setSwipeHint]       = useState(false);
  const mobileNavOpenRef  = useRef(false);
  mobileNavOpenRef.current = mobileNavOpen;
  const coinPickerBtnRef = useRef<HTMLButtonElement>(null);
  const [coinPickerPos, setCoinPickerPos]   = useState({ top: 0, right: 0 });

  const onResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const wrap = chartWrapRef.current;
    const axis = wrap && getComputedStyle(wrap).flexDirection === "row" ? "row" : "col";
    dragState.current = {
      active: true,
      axis,
      startPos:  axis === "row" ? e.clientX : e.clientY,
      startSize: axis === "row" ? obSize.w   : obSize.h,
    };
  }, [obSize]);

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.active) return;
    const { axis, startPos, startSize } = dragState.current;
    const delta   = (axis === "row" ? e.clientX : e.clientY) - startPos;
    const minSize = axis === "row" ? 4 : 80;
    const newSize = Math.max(minSize, Math.min(600, startSize - delta));
    setObSize(prev => axis === "row" ? { ...prev, w: newSize } : { ...prev, h: newSize });
  }, []);

  const onResizePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragState.current.active = false;
  }, []);

  const openCoinPicker = () => {
    if (coinPickerBtnRef.current) {
      const rect = coinPickerBtnRef.current.getBoundingClientRect();
      setCoinPickerPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    }
    setCoinPickerOpen(v => !v);
  };

  const [leverageOpen, setLeverageOpen] = useState(false);
  const [learnOpen,      setLearnOpen]      = useState(false);
  const [tutorialOpen,   setTutorialOpen]   = useState(false);
  const [chartZone,    setChartZone]    = useState<ZoneResult | null>(null);
  const [chartPrice,   setChartPrice]   = useState(0);

  const [priceAlert, setPriceAlert] = useState<{
    message: string; type: "bullish" | "bearish"; key: number;
  } | null>(null);
  const prevPriceStatusRef = useRef<"bullish" | "bearish" | null>(null);

  const zoneStatus = (zone: typeof chartZone): "bullish" | "bearish" | null => {
    if (!zone) return null;
    const s = zone.signal;
    if (s === "strong-buy" || s === "buy" || s === "oversold")    return "bullish";
    if (s === "strong-sell" || s === "sell" || s === "overbought") return "bearish";
    return null;
  };

  useEffect(() => { if (btcData) setError(""); }, [btcData]);

  // Sync URL hash with active section
  useEffect(() => {
    window.history.replaceState(null, "", `#${activeSection}`);
  }, [activeSection]);

  // Handle browser back/forward
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.slice(1) as SectionId;
      if (NAV_ITEMS.some(n => n.id === hash)) setActiveSection(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Close mobile nav when section changes
  useEffect(() => { setMobileNavOpen(false); }, [activeSection]);

  // First-visit swipe intro
  useEffect(() => {
    if (window.innerWidth > 640) return;
    if (localStorage.getItem("swipe-hint-seen")) return;
    const t1 = setTimeout(() => { setMobileNavOpen(true);  setSwipeHint(true);  }, 800);
    const t2 = setTimeout(() => { setMobileNavOpen(false); }, 2200);
    const t3 = setTimeout(() => { setSwipeHint(false); localStorage.setItem("swipe-hint-seen", "1"); }, 2800);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  // Swipe gesture — open on right-swipe from left edge, close on left-swipe
  useEffect(() => {
    const EDGE = 40;
    const THRESHOLD = 50;
    let startX = 0, startY = 0;
    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = Math.abs(e.changedTouches[0].clientY - startY);
      if (dy > 80) return; // vertical scroll, ignore
      if (!mobileNavOpenRef.current && startX < EDGE && dx > THRESHOLD) setMobileNavOpen(true);
      else if (mobileNavOpenRef.current && dx < -THRESHOLD) setMobileNavOpen(false);
    };
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend",   onTouchEnd,   { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend",   onTouchEnd);
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
            ? current === "bullish" ? t("alert.currentlyBullish") : t("alert.currentlyBearish")
            : current === "bullish" ? t("alert.turnedBullish")    : t("alert.turnedBearish"),
        type: current,
        key: Date.now(),
      });
      prevPriceStatusRef.current = current;
    }
  }, [chartZone]);

  useEffect(() => {
    const assetValue = btcData?.price ? btcAmountValue * btcData.price : 0;
    const costBasis  = btcAmountValue * btcCostValue;
    setTotalAssetValue(assetValue);
    setTotalCostBasis(costBasis);
    setProfitLoss(assetValue - costBasis);
  }, [btcAmountValue, btcCostValue, btcData?.price]);

  const formatCurrency = (value: number) =>
    value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fetchBTCData = async () => {
    const isInitialLoad = !btcDataRef.current;
    if (isInitialLoad) { setLoading(true); } else { clearCandleCache(); setRefreshing(true); }
    setError("");
    const data = await coinglass.getAllBTCData(coin);
    if (data) {
      setBtcData(data);
      try { localStorage.setItem(`btcData_${coin}`, JSON.stringify(data)); } catch { /* quota */ }
      setRefreshTrigger(prev => prev + 1);
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
    } catch { /* ignore */ }
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
    <div className="app-shell">
      {showOnboarding && (
        <OnboardingWizard onComplete={() => setShowOnboarding(false)} />
      )}
      <ProfilePage isOpen={profileOpen} onClose={() => setProfileOpen(false)} onOpenUpgrade={() => { setProfileOpen(false); onOpenUpgrade(); }} />
      <div className="app-shell-news"><NewsTicker /></div>

      <div className={`app-shell-body${mobileNavOpen ? " mobile-nav-open" : ""}`}>

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
        onOpenProfile={() => { setDrawerOpen(false); setProfileOpen(true); }}
        onOpenWizard={() => setShowOnboarding(true)}
        traderLevel={profile?.trader_level ?? null}
      />
      <LearnSection isOpen={learnOpen} onClose={() => setLearnOpen(false)} />
      {tutorialOpen && <TutorialPage onClose={() => setTutorialOpen(false)} />}
      <LeveragePopup
        isOpen={leverageOpen}
        onClose={() => setLeverageOpen(false)}
        zone={chartZone}
        currentPrice={chartPrice}
        coin={coin}
      />

      {mobileNavOpen && (
        <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} />
      )}
      <nav className={`icon-strip${mobileNavOpen ? " mobile-open" : ""}`}>
        <button className="icon-strip-logo" onClick={fetchBTCData} title={t("header.clickToRefresh")}>
          <CoinHintzLogo loading={loading || refreshing} />
        </button>

        {/* Mobile-only profile header */}
        <div className="mob-nav-profile">
          <div className="mob-nav-avatar">
            {profile?.full_name
              ? profile.full_name.trim().split(/\s+/).map(w => w[0]).slice(0,2).join("").toUpperCase()
              : (user?.email?.[0] ?? "?").toUpperCase()
            }
          </div>
          <div className="mob-nav-userinfo">
            <span className="mob-nav-name">{profile?.full_name || user?.email?.split("@")[0] || "Account"}</span>
            {user?.email && <span className="mob-nav-email">{user.email}</span>}
          </div>
        </div>

        <div className="icon-strip-nav">
          {NAV_ITEMS.filter(item => !item.hidden).map(item => {
            const locked = !!item.requiredTier && !hasAccess(tier, item.requiredTier);
            return (
              <button
                key={item.id}
                className={`icon-strip-btn${activeSection === item.id ? " active" : ""}`}
                onClick={() => setActiveSection(item.id)}
                title={t(item.labelKey)}
              >
                <NavIcon d={item.d} />
                {locked && (
                  <span className="icon-strip-lock">
                    <svg width="7" height="7" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z"/>
                    </svg>
                  </span>
                )}
                <span className="icon-strip-label">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </div>

        <div className="icon-strip-bottom">
          <div className="icon-strip-acct">
            <AccountMenu onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} onOpenProfile={() => setProfileOpen(true)} />
          </div>

          <button className="icon-strip-btn" onClick={() => { setDrawerOpen(true); setMobileNavOpen(false); }} title={t("drawer.settings")}>
            <NavIcon d={[
              "M12 15a3 3 0 100-6 3 3 0 000 6z",
              "M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z",
            ]} />
            <span className="icon-strip-label">{t("nav.settings")}</span>
          </button>

          <button className="icon-strip-btn" onClick={() => { signOut(); setMobileNavOpen(false); }} title={t("nav.signOut")}>
            <NavIcon d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
            <span className="icon-strip-label">{t("nav.signOut")}</span>
          </button>

          <button
            className={`icon-strip-theme-pill${theme === "light" ? " light" : ""}`}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle theme"
          >
            <div className="theme-pill-track">
              <div className="theme-pill-knob">
                {theme === "dark"
                  ? <NavIcon d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                  : <NavIcon d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 5a7 7 0 100 14A7 7 0 0012 5z" />
                }
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
              onClick={() => setMobileNavOpen(v => !v)}
              aria-label="Open menu"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6"  x2="21" y2="6"  />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <button className="mch-coin-btn" ref={coinPickerBtnRef}
              onClick={() => {
                if (coinBtnClickTimer.current) {
                  clearTimeout(coinBtnClickTimer.current);
                  coinBtnClickTimer.current = null;
                  prevTickerPrice.current = livePrice;
                  tickerOpenPrice.current = livePrice;
                  tickerLastMilestone.current = livePrice !== null ? Math.floor(livePrice / 100) * 100 : null;
                  setPriceTicker(true);
                } else {
                  coinBtnClickTimer.current = setTimeout(() => {
                    coinBtnClickTimer.current = null;
                    openCoinPicker();
                  }, 250);
                }
              }}>
              <span className="mch-coin-icon">{COIN_ICONS[coin] ?? coin[0]}</span>
              <div className="mch-coin-info">
                <span className="mch-coin-pair">
                  {coin}<span className="mch-coin-quote">/USD</span>
                </span>
                {(livePrice ?? btcData?.price) && (
                  <span className="mch-coin-price">${(livePrice ?? btcData!.price!).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                )}
                <span className="price-source">via Binance</span>
              </div>
              <span className="mch-coin-chevron">▾</span>
            </button>
          </div>

          <div className="mch-stats">
            {btcData && (() => {
              const fr   = btcData.fundingRate ?? 0;
              const rsi  = btcData.rsi ?? 50;
              const macd = btcData.macd ?? 0;
              const ls   = btcData.longShortRatio ?? 1;
              const frSignal   = fr > 0.0005 ? "bear" : fr < -0.0001 ? "bull" : "neutral";
              const rsiSignal  = rsi > 70 ? "bear" : rsi < 30 ? "bull" : rsi < 50 ? "bear" : "bull";
              const macdSignal = macd > 0 ? "bull" : "bear";
              const lsSignal   = ls >= 1 ? "bull" : "bear";
              return (
                <>
                  <div className="mch-stat">
                    <span className="mch-stat-label">{t("stats.liqAbove")}</span>
                    <span className="mch-stat-value negative">
                      {btcData.liquidationAbove ? `$${btcData.liquidationAbove.toLocaleString()}` : "—"}
                    </span>
                    <span className="mch-stat-signal mch-stat-signal--bear">{t("stats.sigRisk")}</span>
                  </div>
                  <div className="mch-stat">
                    <span className="mch-stat-label">{t("stats.liqBelow")}</span>
                    <span className="mch-stat-value positive">
                      {btcData.liquidationBelow ? `$${btcData.liquidationBelow.toLocaleString()}` : "—"}
                    </span>
                    <span className="mch-stat-signal mch-stat-signal--bull">{t("stats.sigSupport")}</span>
                  </div>
                  <div className="mch-stat">
                    <span className="mch-stat-label">{t("stats.openInterest")}</span>
                    <span className="mch-stat-value">
                      {btcData.openInterest ? `$${(btcData.openInterest / 1e9).toFixed(2)}B` : "—"}
                    </span>
                    <span className="mch-stat-signal mch-stat-signal--neutral">{t("stats.sigNeutral")}</span>
                  </div>
                  <div className="mch-stat">
                    <span className="mch-stat-label">{t("stats.fundingRate")}</span>
                    <span className={`mch-stat-value${fr < 0 ? " negative" : ""}`}>
                      {`${fr >= 0 ? "+" : ""}${(fr * 100).toFixed(4)}%`}
                    </span>
                    <span className={`mch-stat-signal mch-stat-signal--${frSignal}`}>
                      {frSignal === "bull" ? t("stats.sigBullish") : frSignal === "bear" ? t("stats.sigCrowded") : t("stats.sigNeutral")}
                    </span>
                  </div>
                  <div className="mch-stat">
                    <span className="mch-stat-label">{t("stats.rsi14")}</span>
                    <span className={`mch-stat-value${rsi > 70 ? " negative" : rsi < 30 ? " positive" : ""}`}>
                      {rsi.toFixed(1)}
                    </span>
                    <span className={`mch-stat-signal mch-stat-signal--${rsiSignal}`}>
                      {rsi > 70 ? t("stats.sigOverbought") : rsi < 30 ? t("stats.sigOversold") : rsi < 50 ? t("stats.sigWeak") : t("stats.sigNeutral")}
                    </span>
                  </div>
                  <div className="mch-stat">
                    <span className="mch-stat-label">{t("stats.macd")}</span>
                    <span className={`mch-stat-value${macd < 0 ? " negative" : ""}`}>
                      {macd.toFixed(2)}
                    </span>
                    <span className={`mch-stat-signal mch-stat-signal--${macdSignal}`}>
                      {macd > 0 ? t("stats.sigBullish") : t("stats.sigBearish")}
                    </span>
                  </div>
                  <div className="mch-stat">
                    <span className="mch-stat-label">{t("stats.lsRatio")}</span>
                    <span className={`mch-stat-value${ls >= 1 ? " positive" : " negative"}`}>
                      {ls.toFixed(2)}
                    </span>
                    <span className={`mch-stat-signal mch-stat-signal--${lsSignal}`}>
                      {ls >= 1 ? t("stats.sigLongsLead") : t("stats.sigShortsLead")}
                    </span>
                  </div>
                  {(() => {
                    const g = btcData.cmeGap;
                    const fmt = (v: number) => `$${(v/1000).toFixed(1)}K`;
                    return (
                      <>
                        <div className="mch-stat">
                          <span className="mch-stat-label">{t("stats.cmeAbove")}</span>
                          <span className="mch-stat-value" style={{ fontSize: "0.7rem" }}>
                            {g?.above ? `${fmt(g.above.low)}–${fmt(g.above.high)}` : "—"}
                          </span>
                          <span className="mch-stat-signal mch-stat-signal--bull">
                            {g?.above ? t("stats.sigAbove") : t("stats.sigNone")}
                          </span>
                        </div>
                        <div className="mch-stat">
                          <span className="mch-stat-label">{t("stats.cmeBelow")}</span>
                          <span className="mch-stat-value" style={{ fontSize: "0.7rem" }}>
                            {g?.below ? `${fmt(g.below.low)}–${fmt(g.below.high)}` : "—"}
                          </span>
                          <span className="mch-stat-signal mch-stat-signal--bear">
                            {g?.below ? t("stats.sigBelow") : t("stats.sigNone")}
                          </span>
                        </div>
                      </>
                    );
                  })()}
                </>
              );
            })()}
          </div>

          {btcData && <span className="price-source-badge">via CoinGlass</span>}

          <div className="mch-right">
            <PriceAlerts coin={coin} currentPrice={btcData?.price ?? 0} />
            <div className="mch-portfolio" onClick={() => setAssetPanelOpen(v => !v)} title={t("header.openCalculator")}>
              <span className="mch-portfolio-label">{t("header.pnl")}</span>
              <span className={`mch-portfolio-value${profitLoss >= 0 ? " positive" : " negative"}`}>
                {btcAmountValue > 0 ? `${profitLoss >= 0 ? "+" : ""}${formatCurrency(profitLoss)}` : "—"}
              </span>
            </div>
          </div>
        </div>

        <div className={`main-content${activeSection === "chart" ? " chart-active" : ""}`}>
          {error && (
            <div className="error-banner">
              <strong>⚠️ {t("main.error")}:</strong> {error}
            </div>
          )}

          {activeSection === "chart" && (
            <>
              <FlashNewsBanner />
              <div
                className="chart-section-wrap"
                ref={chartWrapRef}
                style={{ "--ob-h": `${obSize.h}px`, "--ob-w": `${obSize.w}px` } as React.CSSProperties}
              >
                <PriceChart
                  refreshTrigger={refreshTrigger}
                  theme={theme}
                  coin={coin}
                  onZoneChange={(zone, price) => { setChartZone(zone); setChartPrice(price); }}
                  onOpenAuth={onOpenAuth}
                  onOpenUpgrade={onOpenUpgrade}
                />
                <div
                  className="chart-resize-handle"
                  onPointerDown={onResizePointerDown}
                  onPointerMove={onResizePointerMove}
                  onPointerUp={onResizePointerUp}
                >
                  <svg className="chart-resize-icon" width="42" height="42" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {/* Hand / pointer finger */}
                    <path d="M28 30V14a3 3 0 0 1 6 0v16"/>
                    <path d="M34 20a3 3 0 0 1 6 0v10"/>
                    <path d="M40 23a3 3 0 0 1 6 0v10"/>
                    <path d="M22 32a3 3 0 0 1 6 0v-2"/>
                    <path d="M22 32v6c0 6.627 4.477 12 10 12h4c5.523 0 10-5.373 10-12v-9"/>
                    {/* Left arrow */}
                    <line x1="12" y1="24" x2="2" y2="24"/>
                    <polyline points="6,20 2,24 6,28"/>
                    {/* Right arrow */}
                    <line x1="52" y1="24" x2="62" y2="24"/>
                    <polyline points="58,20 62,24 58,28"/>
                  </svg>
                </div>
                <OrderBook coin={coin} />
              </div>
            </>
          )}
          {activeSection === "ai" && (
            <AIPredictionPanel btcData={btcData} coin={coin} theme={theme} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />
          )}
          {activeSection === "heatmap"   && <LiquidationHeatmap coin={coin} theme={theme} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />}
          {activeSection === "feargreed" && <FearGreedGauge />}
          {activeSection === "onchain"   && <OnChainMetrics onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />}
          {activeSection === "alerts"    && <AlertsBuilder btcData={btcData} />}
          {activeSection === "gann"      && (
            <BlurGate requiredTier="elite" featureName="Gann Analysis" onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade}>
              <GannAnalysis coin={coin} currentPrice={btcData?.price} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />
            </BlurGate>
          )}
          {activeSection === "htf" && (
            <HTFAnalysis coin={coin} currentPrice={btcData?.price} onOpenAuth={onOpenAuth} onOpenUpgrade={onOpenUpgrade} />
          )}
          {activeSection === "etf" && <ETFInflows />}
          {activeSection === "positions" && <PositionFlows coin={coin} />}
          {activeSection === "orderflow" && <OrderFlowFramework coin={coin} />}
          {activeSection === "signals"   && <PredictionEngine btcData={btcData} coin={coin} livePrice={livePrice} />}
        </div>

      </div>

      <button
        className={`watchlist-reveal-btn${showWatchlist ? " watchlist-reveal-btn--open" : ""}`}
        onClick={() => setShowWatchlist(v => !v)}
        title={showWatchlist ? "Hide watchlist" : "Show watchlist"}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          {showWatchlist ? (
            <polyline points="15 18 9 12 15 6" />
          ) : (
            <polyline points="9 18 15 12 9 6" />
          )}
        </svg>
      </button>
      <aside className={`side-panel${showWatchlist ? "" : " side-panel--hidden"}`}>
        <Watchlist />
      </aside>

      <ChatInterface btcData={btcData} />

      {coinPickerOpen && ReactDOM.createPortal(
        <>
          <div className="coin-picker-backdrop" onClick={() => setCoinPickerOpen(false)} />
          <ul className="coin-picker-menu" style={{ top: coinPickerPos.top, right: coinPickerPos.right }}>
            {COINS.map(c => (
              <li
                key={c.symbol}
                className={`coin-picker-item${c.symbol === coin ? " active" : ""}`}
                onClick={() => { setCoin(c.symbol); clearCandleCache(); setCoinPickerOpen(false); }}
              >
                <span className="coin-picker-item-icon">{COIN_ICONS[c.symbol] ?? c.symbol}</span>
                <span className="coin-picker-item-name">{c.name}</span>
                <span className="coin-picker-item-sym">{c.symbol}</span>
              </li>
            ))}
          </ul>
        </>,
        document.body
      )}

      {assetPanelOpen && (
        <div className="asset-modal-overlay" onClick={() => setAssetPanelOpen(false)}>
          <div className="asset-modal-panel" onClick={e => e.stopPropagation()}>
            <div className="asset-panel-header">
              <h2>{t("assetCalc.title")}</h2>
              <button className="asset-close-btn" onClick={() => setAssetPanelOpen(false)} title="Close">✕</button>
            </div>
            <div className="asset-modal-content">
              <div className="asset-summary">
                <div className="asset-input-group">
                  <label htmlFor="btc-amount">{t("assetCalc.amountLabel", { coin })}</label>
                  <input id="btc-amount" type="number" min="0" step="0.0001"
                    value={btcAmount}
                    onFocus={() => btcAmount === "0" && setBtcAmount("")}
                    onChange={e => setBtcAmount(e.target.value)}
                    placeholder="0.00" />
                </div>
                <div className="asset-input-group">
                  <label htmlFor="btc-cost">{t("assetCalc.costLabel", { coin })}</label>
                  <input id="btc-cost" type="number" min="0" step="0.01"
                    value={btcCost}
                    onFocus={() => btcCost === "0" && setBtcCost("")}
                    onChange={e => setBtcCost(e.target.value)}
                    placeholder="0.00" />
                </div>
                <div className="asset-value-card">
                  <span>{t("assetCalc.totalLabel")}</span>
                  <strong>{formatCurrency(totalAssetValue)}</strong>
                  <p>{t("assetCalc.basedOn", { coin, price: btcData?.price ? formatCurrency(btcData.price) : "-" })}</p>
                  <p className="asset-cost">{t("assetCalc.costBasis", { amount: formatCurrency(totalCostBasis) })}</p>
                  <p className={`asset-pnl ${profitLoss >= 0 ? "positive" : "negative"}`}>
                    {profitLoss >= 0 ? "+" : ""}{formatCurrency(profitLoss)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {priceAlert && (
        <div key={priceAlert.key} className={`price-alert price-alert--${priceAlert.type}`}>
          <div className="price-alert-label">{t("alert.signalLabel")}</div>
          <div className="price-alert-message">{priceAlert.message}</div>
        </div>
      )}

      <WhaleAlerts btcPrice={btcData?.price} />

      {swipeHint && (
        <div className="swipe-hint">
          <div className="swipe-hint-hand">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
          <span>{t("nav.swipeHint")}</span>
        </div>
      )}

      </div>{/* end app-shell-body */}

      {priceTicker && (() => {
        const coinColor = COIN_COLORS[coin] ?? "#38bdf8";
        const price = livePrice ?? btcData?.price ?? 0;
        const openP = tickerOpenPrice.current ?? price;
        const delta = openP > 0 ? ((price - openP) / openP) * 100 : 0;
        const deltaAbs = Math.abs(delta);
        const up = delta >= 0;

        const insight = delta === 0
          ? t("priceTicker.insightSteady", { coin })
          : up
            ? t("priceTicker.insightUp",   { coin, pct: deltaAbs.toFixed(3) })
            : t("priceTicker.insightDown",  { coin, pct: deltaAbs.toFixed(3) });

        return (
          <div className="pticker-overlay"
            style={{ "--pticker-color": coinColor } as React.CSSProperties}
            onKeyDown={e => e.key === "Escape" && setPriceTicker(false)} tabIndex={-1}>
            <div className="pticker-bg-symbol">{COIN_ICONS[coin] ?? coin[0]}</div>
            <PTickerBgChart coin={coin} isDark={theme === "dark"} />
            {rockets.map(r => (
              <span key={r.id} className={`pticker-rocket pticker-rocket--${r.dir}`} style={{ left: `${r.x}%` }}>
                🚀
              </span>
            ))}
            <div className="pticker-top-actions">
              <button className={`pticker-sound-btn${tickerMuted ? "" : " pticker-sound-btn--on"}`} onClick={() => setTickerMuted(v => !v)} aria-label="Toggle sound">
                {tickerMuted ? (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                  </svg>
                ) : (
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14"/>
                  </svg>
                )}
                <span className="pticker-close-label">{tickerMuted ? t("priceTicker.muted") : t("priceTicker.sound")}</span>
              </button>
              <button className="pticker-close" onClick={() => setPriceTicker(false)} aria-label="Exit">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3"/>
                </svg>
                <span className="pticker-close-label">{t("priceTicker.exit")}</span>
              </button>
            </div>
            <div className="pticker-inner">
              <span className="pticker-price-source">via Binance</span>
              <div className="pticker-coin-name">
                <span className="pticker-coin-sym">{COIN_ICONS[coin] ?? coin[0]}</span>
                {coin}<span className="pticker-coin-quote">/USD</span>
              </div>
              <div className={`pticker-price${tickerFlash === "up" ? " pticker-flash-up" : tickerFlash === "down" ? " pticker-flash-down" : ""}`}>
                ${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              {openP > 0 && (
                <div className={`pticker-delta ${up ? "pticker-delta--up" : "pticker-delta--down"}`}>
                  {up ? "▲" : "▼"} {deltaAbs.toFixed(3)}{t("priceTicker.sinceOpen")}
                </div>
              )}
              <div className="pticker-live-dot"><span /><span className="pticker-live-label">{t("nav.live")}</span></div>

              <div className={`pticker-insight-wrap ${delta === 0 ? "pticker-insight-wrap--neutral" : up ? "pticker-insight-wrap--up" : "pticker-insight-wrap--down"}`}>
                <div className="pticker-insight-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    {delta === 0
                      ? <path d="M5 12h14" />
                      : up
                        ? <><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></>
                        : <><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></>}
                  </svg>
                </div>
                <div className="pticker-insight-body">
                  <span className="pticker-insight-label">{delta === 0 ? t("priceTicker.neutral") : up ? t("priceTicker.bullishSignal") : t("priceTicker.bearishSignal")}</span>
                  <div className="pticker-insight pticker-insight--visible">{insight}</div>
                </div>
              </div>

            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ── Auth gate — decides what to render based on auth state ── */
function AppGate() {
  const { user, loading: authLoading, refreshProfile } = useAuth();
  const [showAuth,    setShowAuth]    = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);

  const [theme, setTheme] = useState<"dark" | "light">(() =>
    (localStorage.getItem("theme") as "dark" | "light") || "dark"
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

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
  if (authLoading) return (
    <div className="app-boot-screen">
      <CoinHintzLogo loading={true} />
    </div>
  );

  if (!user) {
    return (
      <>
        <LandingPage
          onSignIn={() => setShowAuth(true)}
          onSignUp={() => setShowAuth(true)}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
        />
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
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
      {showAuth    && <AuthModal    onClose={() => setShowAuth(false)} />}
      {showUpgrade && <UpgradeModal onClose={() => setShowUpgrade(false)} onOpenAuth={() => { setShowUpgrade(false); setShowAuth(true); }} />}
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
