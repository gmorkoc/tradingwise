import { useState, useEffect, useRef, type CSSProperties } from "react";
import { Capacitor } from "@capacitor/core";
import { useTranslation } from "react-i18next";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell, ComposedChart, Bar, Line, Brush, ReferenceArea,
} from "recharts";
import "../styles/GlobalMarkets.css";
import { fetchBrief, type BriefItem } from "./DailyBrief";
import { deribit } from "../services/deribit";
import { MarketSignalTable } from "./MarketSignalTable";
import {
  getGlobal, getMarkets, getTrending, getMarketChart, toDaily, requestSparklines, useSparklines, withSparklines,
  useDataSource, usePaprikaShown, type GlobalStats, type MarketCoin,
} from "../services/marketData";

// ── Types ──────────────────────────────────────────────────────────────────────
type GlobalData = GlobalStats;

interface ChartPoint { time: string; value: number; raw: number; }
// Market list row (CoinGecko's shape, whichever source answered — see
// services/marketData.ts).
export type CoinRow = MarketCoin;

interface FearGreedPoint { value: string; value_classification: string; timestamp: string; }

// ── Constants ──────────────────────────────────────────────────────────────────
const PERIODS = [
  { label: "7D",  days: 7   },
  { label: "30D", days: 30  },
  { label: "90D", days: 90  },
  { label: "1Y",  days: 365 },
] as const;

const CHART_TABS = [
  { key: "market_caps",    label: "BTC Market Cap", color: "#38bdf8" },
  { key: "total_volumes",  label: "BTC Volume",     color: "#a78bfa" },
] as const;

type ChartKey = typeof CHART_TABS[number]["key"];

// Standalone "Crypto Market Cap" card's own period tabs — separate from
// the BTC chart's own PERIODS above since this card has a different range
// set (matches CoinMarketCap's own 30d/1y/All), not shared state.
const MCAP_PERIODS = [
  { label: "30D", days: 30 },
  { label: "1Y",  days: 365 },
  { label: "All", days: "max" as const },
] as const;

// Altcoin Season's own selectable window — real price change fields from
// the market list (24h/7d/30d/1y). Was hardcoded to 30D.
const ALT_SEASON_PERIODS = [
  { label: "24H", field: (c: CoinRow) => c.price_change_percentage_24h },
  { label: "7D",  field: (c: CoinRow) => c.price_change_percentage_7d_in_currency },
  { label: "30D", field: (c: CoinRow) => c.price_change_percentage_30d_in_currency },
  { label: "1Y",  field: (c: CoinRow) => c.price_change_percentage_1y_in_currency },
] as const;

// CoinGlass's own liquidation endpoints are all currently rejecting with
// "Upgrade plan" on the live key (verified directly against the proxy), so
// the "Market Pulse" section below is an honest substitute built entirely
// from market data actually available: daily BTC price swings (real,
// derived) standing in for the long/short liquidation histogram, and
// today's biggest real movers standing in for curated liquidation events.
const LIQ_RANGES = [
  { label: "1M", days: 30  },
  { label: "3M", days: 90  },
  { label: "1Y", days: 365 },
] as const;

export const TABLE_PAGE_SIZE = 15;

// ── Helpers ────────────────────────────────────────────────────────────────────
export function fmtBig(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

export function fmtPrice(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1)    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 3 })}`;
  return `$${n.toPrecision(4)}`;
}

function fmtDate(ts: number, days: number): string {
  const d = new Date(ts);
  if (days <= 7)  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  if (days <= 90) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

// ── Cache ──────────────────────────────────────────────────────────────────────
// Market data (coin list, global stats, history) goes through
// services/marketData.ts (CoinGecko → CoinPaprika → CoinLore, with its own
// cache); this one is for the other public
// APIs below (alternative.me, Coinalyze).
const cache: Record<string, { data: unknown; ts: number }> = {};
export const TTL ={ global: 60_000, chart: 120_000, coins: 90_000, trending: 300_000, fng: 300_000, oi: 60_000, fngHistory: 600_000 };
// alternative.me's full Fear & Greed history (back to Feb 2018) in one
// request — limit=0 means "no limit", not "zero rows". Small per-row
// (value/classification/timestamp only), so fetching everything once and
// slicing client-side for the 30D/1Y/All tabs is simpler and more honest
// than guessing a cutoff that might not actually cover "All".
const FNG_PERIODS = [
  { label: "30D", days: 30 },
  { label: "1Y",  days: 365 },
  { label: "All", days: Infinity },
] as const;
// Same gap BN_BASE (coinglass.ts) and API_BASE (openai.ts) already work
// around: the native app loads its bundled web content from a local
// capacitor:// origin, not https://www.coinhintz.io, so a relative
// /coinalyze-api/* fetch resolves to nothing on-device — there's no
// server there to proxy it. Unlike the market-data APIs (open CORS, called
// directly by services/marketData.ts), Coinalyze's key is only added server-side by
// middleware.ts, so native has to reach that middleware via the real
// production domain instead of calling Coinalyze directly.
const COINALYZE_BASE = Capacitor.isNativePlatform() ? "https://www.coinhintz.io/coinalyze-api" : "/coinalyze-api";

// Plain cached fetch for the other public APIs — alternative.me's Fear &
// Greed index, Coinalyze open interest.
async function plainFetch<T>(url: string, ttl: number): Promise<T> {
  const now = Date.now();
  if (cache[url] && now - cache[url].ts < ttl) return cache[url].data as T;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cache[url] = { data, ts: now };
  return data as T;
}

// Pool of 10 each for the Gainers/Losers banner.
const topGainers = (coins: CoinRow[]) =>
  [...coins].sort((a, b) => (b.price_change_percentage_24h ?? -999) - (a.price_change_percentage_24h ?? -999)).slice(0, 10);
const topLosers = (coins: CoinRow[]) =>
  [...coins].sort((a, b) => (a.price_change_percentage_24h ?? 999) - (b.price_change_percentage_24h ?? 999)).slice(0, 10);

// ── Sparkline ──────────────────────────────────────────────────────────────────
export function Sparkline({ data, color, width = 90, height = 28 }: { data?: number[]; color: string; width?: number; height?: number }) {
  if (!data || data.length < 2) return <span className="gm-spark-empty" style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`).join(" ");
  const areaPts = `0,${height} ${pts} ${width},${height}`;
  const id = `gmspark-${color.replace("#", "")}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="gm-spark" preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={areaPts} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Fear & Greed gauge ───────────────────────────────────────────────────────────
function fngColor(value: number): string {
  if (value <= 24) return "#ef4444";
  if (value <= 44) return "#f97316";
  if (value <= 55) return "#eab308";
  if (value <= 75) return "#84cc16";
  return "#22c55e";
}
function FearGreedGauge({ value, label, compact }: { value: number; label: string; compact?: boolean }) {
  const targetAngle = -90 + Math.max(0, Math.min(100, value)) / 100 * 180;
  const [angle, setAngle] = useState(-90);
  useEffect(() => {
    const t = setTimeout(() => setAngle(targetAngle), 120);
    return () => clearTimeout(t);
  }, [targetAngle]);
  const color = fngColor(value);
  return (
    <div
      className={`gm-fng${compact ? " gm-fng--compact" : ""}`}
      // CSS custom property, not read anywhere on desktop today — exists so
      // the mobile-only glow behind this gauge (GlobalMarkets.css) can
      // match the gauge's own live sentiment color without duplicating the
      // fngColor() logic in CSS.
      style={{ "--fng-color": color } as CSSProperties}
    >
      <svg viewBox="0 0 200 118" className="gm-fng-svg">
        <defs>
          <linearGradient id="gmFngGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="25%" stopColor="#f97316" />
            <stop offset="50%" stopColor="#eab308" />
            <stop offset="75%" stopColor="#84cc16" />
            <stop offset="100%" stopColor="#22c55e" />
          </linearGradient>
        </defs>
        <path d="M 12 100 A 88 88 0 0 1 188 100" fill="none" stroke="url(#gmFngGrad)" strokeWidth="13" strokeLinecap="round" opacity="0.9" />
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: "100px 100px", transition: "transform 1.1s cubic-bezier(0.22,1,0.36,1)" }}>
          <line x1="100" y1="100" x2="100" y2="28" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="gm-fng-needle" />
        </g>
        <circle cx="100" cy="100" r="7" fill="currentColor" className="gm-fng-pivot" />
      </svg>
      <div className="gm-fng-readout">
        <span className="gm-fng-value" style={{ color }}>{Math.round(value)}</span>
        <span className="gm-fng-label">{label}</span>
      </div>
    </div>
  );
}

// ── Donut dominance chart ────────────────────────────────────────────────────────
const DOM_COLORS = ["#f7931a", "#627eea", "#9945ff", "#00bcd4", "#f3ba2f", "#94a3b8", "#64748b"];
function DomTooltip({ active, payload }: { active?: boolean; payload?: { name: string; value: number }[] }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="gm-tooltip">
      <div className="gm-tooltip-label">{payload[0].name}</div>
      <div className="gm-tooltip-value">{payload[0].value.toFixed(1)}%</div>
    </div>
  );
}

// Labels drawn directly on the donut so the side legend isn't needed at
// all — every slice gets one. Recharts calls this per slice with the
// actual rendered geometry (cx/cy/midAngle/radii), not just the raw data,
// so each label can be positioned at that slice's own midpoint. Slices
// >=5% share get a two-line label (name + %) centered inside their own
// wedge; thinner ones (BNB/XRP/USDC-sized) have no room for that without
// spilling into a neighbor, so they get one compact line positioned just
// outside the ring instead, anchored outward (away from the ring) based
// on which side of the circle they fall on.
function renderDonutSliceLabel(props: any) {
  const { cx, cy, midAngle, innerRadius, outerRadius, percent, name } = props;
  const RADIAN = Math.PI / 180;
  const pct = `${(percent * 100).toFixed(1)}%`;
  if (percent >= 0.05) {
    const r = innerRadius + (outerRadius - innerRadius) / 2;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    return (
      <text x={x} y={y} textAnchor="middle" dominantBaseline="central" className="gm-dom-pie-label">
        <tspan x={x} dy="-0.35em" fontSize={12} fontWeight={800}>{name}</tspan>
        <tspan x={x} dy="1.15em" fontSize={10.5} fontWeight={600}>{pct}</tspan>
      </text>
    );
  }
  const r = outerRadius + 14;
  const x = cx + r * Math.cos(-midAngle * RADIAN);
  const y = cy + r * Math.sin(-midAngle * RADIAN);
  const cos = Math.cos(-midAngle * RADIAN);
  return (
    <text x={x} y={y} textAnchor={cos >= 0 ? "start" : "end"} dominantBaseline="central"
      className="gm-dom-pie-label gm-dom-pie-label--outside" fontSize={9.5} fontWeight={700}>
      {name} {pct}
    </text>
  );
}

// ── Skeleton loader ──────────────────────────────────────────────────────────────
function GmSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="gm-wrap">
      <div className="gm-skel gm-skel-hero" />
      <div className="gm-stats-grid">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="gm-skel gm-skel-stat" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="gm-skel gm-skel-section" />
      <div className="gm-skel gm-skel-section" />
      <div className="gm-loading-row">
        <span className="gm-spinner" />
        {t("globalMarkets.loadingGlobal")}
      </div>
    </div>
  );
}

// ── Icons (plain inline SVGs, no icon package) ───────────────────────────────────
const IC = {
  cap: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9 9.5a3 3 0 0 1 3-1.5h.5a2.5 2.5 0 0 1 0 5H11a2.5 2.5 0 0 0 0 5h.5a3 3 0 0 0 3-1.5" /></svg>,
  vol: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l5-6 4 3 5-8 4 5" /></svg>,
  btc: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M9.5 8h3a2 2 0 0 1 0 4h-3m0 0h3.5a2 2 0 0 1 0 4h-3.5m0-8v8m0-8V6m0 10v2M13 6v2M13 16v2" /></svg>,
  eth: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l6 10-6 4-6-4z" /><path d="M6 13l6 9 6-9-6 4z" /></svg>,
  coins: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18H4v-3.34" /></svg>,
  markets: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  fire: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2s-6 6.5-6 11a6 6 0 0 0 12 0c0-1.5-.5-2.5-1-3.5.5 2-1 3-1 3 .3-2-1.5-4-2-6.5-.5 1.5-2 2.5-2 4.5 0 1 .5 1.5 1 2" /></svg>,
};

// ── Main Component ─────────────────────────────────────────────────────────────
interface Props {
  // Jumps straight to the Chart page for this coin (App.tsx wires this to
  // setCoin/clearCandleCache/setActiveSection("chart"), same pattern
  // Watchlist/TopMoversCarousel/PriceChart's own hero stack already use).
  // Any listed coin can be clicked, not just ones the app's own COINS
  // roster recognizes — App.tsx's openChartCoin shows the "coming soon"
  // sheet (CoinUnavailableSheet) for coins the chart has no data for.
  onSelectCoin?: (symbol: string) => void;
  // Logged-out "Sign up" taps in the coin table's signal column.
  onOpenAuth?: () => void;
  // Coin table's Trade button → that coin's paper-trading ticket.
  onTradeCoin?: (symbol: string) => void;
}

export function GlobalMarkets({ onSelectCoin, onOpenAuth, onTradeCoin }: Props = {}) {
  const { t } = useTranslation();
  // alternative.me's English classification → translated label.
  const fngLabel = (cls: string) => {
    const key = ({ "Extreme Fear": "extremeFear", "Fear": "fear", "Neutral": "neutral", "Greed": "greed", "Extreme Greed": "extremeGreed" } as Record<string, string>)[cls];
    return key ? t(`globalMarkets.fng.${key}`) : cls;
  };
  // "All" period tab → translated; other period labels (7D, 1Y…) stay as-is.
  const periodLabel = (label: string) => (label === "All" ? t("globalMarkets.periodAll") : label);
  // Desktop gets a bigger dominance donut (taller chart here + a wider
  // .gm-dom-donut box in GlobalMarkets.css); mobile keeps 300px.
  const [isDesktopDonut, setIsDesktopDonut] = useState(() => window.matchMedia("(min-width: 641px)").matches);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 641px)");
    const on = (e: MediaQueryListEvent) => setIsDesktopDonut(e.matches);
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  const [global, setGlobal]       = useState<GlobalData | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [coins, setCoins]         = useState<CoinRow[]>([]);
  // Table pagination — 250 rows (each with its own sparkline SVG) is too
  // much to mount/animate at once, same reasoning any large data table
  // paginates instead of rendering everything up front.
  // Gainers/Losers banner — page 1 (index 0) is Gainers, page 2 (index 1)
  // is Losers, with an auto-advancing progress bar (gm-mover-banner-
  // progress-fill below) between them, same "1/2 pager + arrows" pattern
  // as a reference screenshot of a trending-stocks widget.
  const [moverPage, setMoverPage] = useState<0 | 1>(0);
  const [fng, setFng]             = useState<FearGreedPoint | null>(null);
  // Full history for the mobile-only "Fear & Greed Index Chart" section
  // (Historical Values / Yearly High-Low / the chart itself) — kept
  // separate from `fng` above (which stays the cheap single-value fetch
  // the existing hero gauge uses) so that gauge doesn't wait on this much
  // bigger request.
  const [fngHistory, setFngHistory] = useState<FearGreedPoint[]>([]);
  const [fngPeriod, setFngPeriod] = useState<typeof FNG_PERIODS[number]>(FNG_PERIODS[0]);
  const [period, setPeriod]       = useState<{ label: string; days: number }>(PERIODS[1]);
  const [chartKey, setChartKey]   = useState<ChartKey>("market_caps");
  const [loading, setLoading]     = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError]         = useState("");
  // "Market Pulse" (Liquidations-style widget substitute, see LIQ_RANGES comment)
  const [liqRange, setLiqRange]   = useState<{ label: string; days: number }>(LIQ_RANGES[1]);
  // ── Desktop hero (gmh-*): trending list (getTrending) + live news ──
  // Shown on every width now (phones: a swipeable card carousel).
  const isHeroDesktop = true;
  // Phones: which carousel card is in view (for the dots).
  const [heroIdx, setHeroIdx] = useState(0);
  const [trending, setTrending] = useState<{ id: string; symbol: string; name: string; thumb: string; chg: number | null }[]>([]);
  const [trendPage, setTrendPage] = useState(0);
  const [news, setNews] = useState<BriefItem[]>([]);
  const [aiAlertPillHidden, setAiAlertPillHidden] = useState(() => {
    try { return localStorage.getItem("gmhAiAlertPillHidden") === "1"; } catch { return false; }
  });
  useEffect(() => {
    if (!isHeroDesktop) return;
    getTrending()
      .then((rows) => setTrending(rows.slice(0, 10).map((c) => ({
        id: c.id, symbol: c.symbol, name: c.name, thumb: c.image, chg: c.change24h,
      }))))
      .catch(() => {});
    fetchBrief().then((items) => setNews(items.filter((i) => i.category === "crypto").slice(0, 6))).catch(() => {});
  }, [isHeroDesktop]);
  // Trending pages 1/2 every 6s.
  useEffect(() => {
    if (!isHeroDesktop || trending.length <= 5) return;
    const id = window.setInterval(() => setTrendPage((p) => (p === 0 ? 1 : 0)), 6000);
    return () => window.clearInterval(id);
  }, [isHeroDesktop, trending.length, trendPage]);
  const [liqData, setLiqData]     = useState<{ time: string; ret: number; price: number }[]>([]);
  const [liqLoading, setLiqLoading] = useState(true);
  // BTC/ETH open interest, in base-asset units (BTC/ETH), Binance perps via
  // Coinalyze — see fetch effect below. Converted to USD at render time
  // using the real spot prices already fetched into `coins`. Deliberately
  // NOT a global/aggregate-across-the-whole-market OI total: CoinGlass's
  // own OI endpoints (which could potentially give one) are all currently
  // rejecting with "Upgrade plan" on the live key (re-verified directly
  // against the proxy), so this sticks to the one real figure confirmed
  // reachable — Binance's own BTC/ETH perpetual OI — labeled as such, not
  // relabeled as "the market total".
  const [oi, setOi] = useState<{ btcAmt: number; ethAmt: number } | null>(null);
  // Deribit DVOL — real implied-volatility index, but Deribit's own brand,
  // not CoinMarketCap's "Volmex" widget (different data provider). Labeled
  // honestly in the UI as "DVOL (Deribit)".
  const [dvol, setDvol] = useState<{ btc: number; eth: number } | null>(null);
  // Standalone "Crypto Market Cap" card state — own period, own series
  // (mcap + volume together, for the line+volume-bars combo chart), not
  // reusing the BTC chart's chartData/period above.
  const [mcapPeriod, setMcapPeriod] = useState<typeof MCAP_PERIODS[number]>(MCAP_PERIODS[0]);
  const [altSeasonPeriod, setAltSeasonPeriod] = useState<typeof ALT_SEASON_PERIODS[number]>(ALT_SEASON_PERIODS[2]);
  const [mcapSeries, setMcapSeries] = useState<{ time: string; mcap: number; vol: number | null }[]>([]);
  const [mcapLoading, setMcapLoading] = useState(true);
  const mountedRef = useRef(true);
  // Current BTC dominance fraction — needed by the mcap-card effect below
  // to derive its estimated total-market-cap series (see its own comment).
  const btcDomPct = global?.market_cap_percentage?.btc ?? 0;

  // Auto-advance the Gainers/Losers pager every 5s — restarts whenever
  // the page changes, including a manual arrow click, so a user who just
  // navigated isn't immediately bounced to the other page.
  useEffect(() => {
    const t = setTimeout(() => setMoverPage(p => (p === 0 ? 1 : 0)), 5000);
    return () => clearTimeout(t);
  }, [moverPage]);

  // Fetch global stats + top coins (sparkline enabled) on mount
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    Promise.all([getGlobal(), getMarkets()])
      .then(([g, c]) => {
        if (!mountedRef.current) return;
        setGlobal(g);
        setCoins(c);
        setLoading(false);
      })
      .catch(e => {
        if (!mountedRef.current) return;
        // Friendly, translated text instead of a raw "HTTP 429".
        setError(e?.message === "rate-limited" || e?.message === "HTTP 429"
          ? t("globalMarkets.busy") : t("globalMarkets.loadFailed"));
        setLoading(false);
      });
    return () => { mountedRef.current = false; };
  }, []);

  // 7-day sparklines for the Gainers/Losers banner's coins (Binance, loaded
  // only for the coins shown — see requestSparklines).
  useSparklines();
  useEffect(() => {
    if (coins.length) requestSparklines([...topGainers(coins), ...topLosers(coins)]);
  }, [coins]);
  // Which source answered (Market Pulse label; CoinPaprika credit line).
  const liqSource = useDataSource(`chart:BTC:${liqRange.days}`);
  const paprikaShown = usePaprikaShown(["markets", "global", "trending", "chart:BTC:"]);

  // Fear & Greed index — alternative.me's free public endpoint, no key.
  useEffect(() => {
    plainFetch<{ data: FearGreedPoint[] }>("https://api.alternative.me/fng/?limit=1&format=json", TTL.fng)
      .then(d => { if (mountedRef.current) setFng(d.data[0] ?? null); })
      .catch(() => {});
  }, []);

  // Full Fear & Greed history — newest-first, same shape as the single-
  // value fetch above. Independent fetch/failure, never blocks the rest
  // of the page.
  useEffect(() => {
    plainFetch<{ data: FearGreedPoint[] }>("https://api.alternative.me/fng/?limit=0&format=json", TTL.fngHistory)
      .then(d => { if (mountedRef.current) setFngHistory(d.data ?? []); })
      .catch(() => {});
  }, []);

  // BTC/ETH open interest — Coinalyze's free API, Binance perps specifically
  // (the ".A" exchange-code suffix is Binance's own Coinalyze code, verified
  // against Coinalyze's /v1/exchanges list — not an "aggregated" marker).
  // Same proxy (/coinalyze-api, mirrored in prod by middleware.ts) and
  // base-units-to-USD convention src/services/coinglass.ts already uses for
  // its own OI fallback. Independent fetch/failure — never blocks the rest
  // of the page.
  useEffect(() => {
    plainFetch<{ symbol: string; value: number }[]>(
      `${COINALYZE_BASE}/v1/open-interest?symbols=BTCUSDT_PERP.A,ETHUSDT_PERP.A`,
      TTL.oi
    )
      .then(rows => {
        if (!mountedRef.current) return;
        const btcAmt = rows.find(r => r.symbol === "BTCUSDT_PERP.A")?.value;
        const ethAmt = rows.find(r => r.symbol === "ETHUSDT_PERP.A")?.value;
        if (btcAmt != null && ethAmt != null) setOi({ btcAmt, ethAmt });
      })
      .catch(() => {});
  }, []);

  // DVOL (Deribit's own implied-volatility index) — real, free, no-key
  // public endpoint; see src/services/deribit.ts's getVolatilityIndex for
  // why this is labeled "DVOL (Deribit)", not "Volmex" (different
  // provider). Independent fetch/failure, same reasoning as the others.
  useEffect(() => {
    Promise.all([deribit.getVolatilityIndex("BTC"), deribit.getVolatilityIndex("ETH")])
      .then(([btc, eth]) => {
        if (!mountedRef.current) return;
        if (btc != null && eth != null) setDvol({ btc, eth });
      })
      .catch(() => {});
  }, []);

  // Fetch chart data when period or chartKey changes (BTC market cap /
  // volume history — services/marketData.ts getMarketChart).
  useEffect(() => {
    setChartLoading(true);
    getMarketChart("BTC", period.days)
      .then(d => {
        const raw = d[chartKey as keyof typeof d] ?? d.market_caps;
        const pts: ChartPoint[] = (raw as [number, number][]).map(([ts, val]) => ({
          time:  fmtDate(ts, period.days),
          value: val / 1e9,
          raw:   val,
        }));
        setChartData(pts);
        setChartLoading(false);
      })
      .catch(() => setChartLoading(false));
  }, [period, chartKey]);

  // Standalone "Crypto Market Cap" card's own series — no free source has
  // a historical TOTAL-market-cap series, so this derives it from the real
  // BTC market-cap/volume series ÷ the CURRENT BTC dominance fraction. An
  // approximation, not exact (dominance drifts day to day across the
  // window), disclosed via .gm-chart-est-note below rather than presented
  // as a literal historical total — same house rule as
  // altcoinStrengthPct/marketActivity elsewhere in this file. One point per
  // day; volume history only covers the last year (older bars are empty).
  useEffect(() => {
    setMcapLoading(true);
    getMarketChart("BTC", mcapPeriod.days)
      .then(d => {
        const divisor = btcDomPct > 0 ? btcDomPct / 100 : 1;
        const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
        const volByDay = new Map(toDaily(d.total_volumes ?? []).map(([ts, v]) => [dayKey(ts), v]));
        const pts = toDaily(d.market_caps ?? []).map(([ts, mcapVal]) => {
          const v = volByDay.get(dayKey(ts));
          return {
            time: fmtDate(ts, typeof mcapPeriod.days === "number" ? mcapPeriod.days : 365),
            mcap: mcapVal / divisor / 1e9,
            vol: v != null ? v / divisor / 1e9 : null,
          };
        });
        setMcapSeries(pts);
        setMcapLoading(false);
      })
      .catch(() => setMcapLoading(false));
  }, [mcapPeriod, btcDomPct]);

  // "Market Pulse" chart data — resample the BTC price series down to one
  // point per day, then derive each day's % swing from consecutive daily
  // closes. Real, computed data, not CoinGlass's actual long/short
  // liquidation volume (unavailable).
  useEffect(() => {
    setLiqLoading(true);
    getMarketChart("BTC", liqRange.days)
      .then(d => {
        const daily = toDaily(d.prices ?? []);
        const pts: { time: string; ret: number; price: number }[] = [];
        for (let i = 1; i < daily.length; i++) {
          const prev = daily[i - 1][1];
          const [ts, price] = daily[i];
          pts.push({ time: fmtDate(ts, liqRange.days), ret: prev ? ((price - prev) / prev) * 100 : 0, price });
        }
        setLiqData(pts);
        setLiqLoading(false);
      })
      .catch(() => setLiqLoading(false));
  }, [liqRange]);

  const activeTab = CHART_TABS.find(t => t.key === chartKey)!;

  const mcap   = global?.total_market_cap?.usd ?? 0;

  if (loading) return <GmSkeleton />;
  if (error) return (
    <div className="gm-wrap"><div className="gm-error">{error}</div></div>
  );

  const g = global!;
  const vol    = g.total_volume?.usd ?? 0;
  const btcDom = g.market_cap_percentage?.btc ?? 0;
  const chg24h = g.market_cap_change_percentage_24h_usd ?? 0;
  const ethDom = g.market_cap_percentage?.eth ?? 0;

  // Dominance — top 6 coins, donut chart
  const domEntries = Object.entries(g.market_cap_percentage ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const othersPct = Math.max(0, 100 - domEntries.reduce((s, [, p]) => s + p, 0));
  const pieData = [
    ...domEntries.map(([sym, pct], i) => ({ name: sym.toUpperCase(), value: pct, fill: DOM_COLORS[i] })),
    { name: t("globalMarkets.others"), value: othersPct, fill: DOM_COLORS[6] },
  ];
  // Simple 3-segment version of the same real dominance data for the
  // horizontal-bar widget (BTC / ETH / Others), matching the screenshot's
  // layout — no new fetch, same g.market_cap_percentage already used above.
  const othersDomPct = Math.max(0, 100 - btcDom - ethDom);

  // Pool of 10 each for the rotating banner to cycle through — no more
  // expand/collapse control now that the old full lists are gone.
  const gainers = withSparklines(topGainers(coins));
  const losers = withSparklines(topLosers(coins));

  // "Market Pulse" stat card + movers list (see LIQ_RANGES comment above)
  const gainersCount = coins.filter(c => (c.price_change_percentage_24h ?? 0) >= 0).length;
  const losersCount = coins.length - gainersCount;
  const topMovers = [...coins]
    .sort((a, b) => Math.abs(b.price_change_percentage_24h ?? 0) - Math.abs(a.price_change_percentage_24h ?? 0))
    .slice(0, 3);

  const fngValue = fng ? Number(fng.value) : null;

  // Mobile-only "Fear & Greed Index Chart" section — fngHistory[0] is
  // today, so index N is N days ago (alternative.me updates once/day).
  const fngYesterday = fngHistory[1] ?? null;
  const fngLastWeek = fngHistory[7] ?? null;
  const fngLastMonth = fngHistory[30] ?? null;
  const fngLastYear = fngHistory.slice(0, 365);
  const fngYearHigh = fngLastYear.length
    ? fngLastYear.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a))
    : null;
  const fngYearLow = fngLastYear.length
    ? fngLastYear.reduce((a, b) => (Number(b.value) < Number(a.value) ? b : a))
    : null;
  const fngChartData = (() => {
    const n = fngPeriod.days === Infinity ? fngHistory.length : fngPeriod.days;
    // Oldest-first for the chart (fngHistory itself is newest-first).
    return fngHistory.slice(0, n).slice().reverse().map(h => ({
      time: fmtDate(Number(h.timestamp) * 1000, Number.isFinite(fngPeriod.days) ? fngPeriod.days : 1825),
      value: Number(h.value),
    }));
  })();


  // "Altcoin Strength" — this app's own honest equivalent of
  // blockchaincenter.net's "Altcoin Season Index": there's no free public
  // JSON API for that exact index (checked), and the real methodology
  // uses a 90-day window the market list doesn't offer (only
  // 1h/24h/7d/30d/1y) — so this is a genuinely real, from-real-
  // data computation over a user-selectable window instead (see
  // ALT_SEASON_PERIODS), labeled as such rather than claiming parity with
  // the original index's name/window.
  // First (best-ranked) row per symbol — the same lookup works whichever
  // data source answered.
  const btcRow = coins.find(c => c.symbol === "btc");
  const ethRow = coins.find(c => c.symbol === "eth");
  const btcAltPct = btcRow ? (altSeasonPeriod.field(btcRow) ?? 0) : 0;
  const altcoinBasket = coins.filter(c => c !== btcRow && c.symbol !== "usdt" && c.symbol !== "usdc").slice(0, 50);
  const altcoinsBeatingBtc = altcoinBasket.filter(c => (altSeasonPeriod.field(c) ?? -999) > btcAltPct).length;
  const altcoinStrengthPct = altcoinBasket.length > 0 ? Math.round((altcoinsBeatingBtc / altcoinBasket.length) * 100) : null;

  // Open interest in USD — Coinalyze's base-asset-unit figures (see the `oi`
  // fetch effect above) × the real current spot price already in `coins`.
  // Per-coin (Binance perps), not a market-wide total — see the comment on
  // the `oi` state declaration for why.
  const oiStats = oi && btcRow && ethRow
    ? { btcUsd: oi.btcAmt * btcRow.current_price, ethUsd: oi.ethAmt * ethRow.current_price }
    : null;

  // Rendered twice (inline in the side-by-side grid, and again inside its
  // own portaled modal when expanded) — kept as one JSX value each so the
  // two copies can't drift apart from editing only one of them.
  const domSectionBody = (
    <>
      <div className="gm-dom-layout">
        <div className="gm-dom-donut">
          <ResponsiveContainer width="100%" height={isDesktopDonut ? 420 : 300}>
            <PieChart margin={{ top: 24, right: 50, bottom: 24, left: 50 }}>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="92%"
                paddingAngle={2} startAngle={90} endAngle={-270} isAnimationActive={false} stroke="none"
                label={renderDonutSliceLabel} labelLine={false}>
                {pieData.map(d => <Cell key={d.name} fill={d.fill} />)}
              </Pie>
              <Tooltip content={<DomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="gm-dom-center">
            <span className="gm-dom-center-value">{btcDom.toFixed(1)}%</span>
            <span className="gm-dom-center-label">BTC</span>
          </div>
        </div>
        <div className="gm-dom-legend">
          {pieData.map((d, i) => (
            <div key={d.name} className="gm-dom-legend-item" style={{ animationDelay: `${i * 50}ms` }}>
              <span className="gm-dom-dot" style={{ background: d.fill }} />
              <span className="gm-dom-sym">{d.name}</span>
              <span className="gm-dom-pct">{d.value.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Bitcoin Dominance — same real market_cap_percentage data as the
          donut above, just re-rendered as a horizontal segmented bar
          (BTC / ETH / Others) to match the screenshot's layout. No new
          fetch — see othersDomPct comment above. */}
      <div className="gm-dom-hbar-wrap">
        <div className="gm-dom-hbar-head">
          <span className="gm-dom-hbar-title">{t("globalMarkets.bitcoinDominance")}</span>
          <span className="gm-dom-hbar-value">{btcDom.toFixed(1)}%</span>
        </div>
        <div className="gm-dom-hbar">
          <span className="gm-dom-hbar-seg" style={{ width: `${btcDom}%`, background: DOM_COLORS[0] }} />
          <span className="gm-dom-hbar-seg" style={{ width: `${ethDom}%`, background: DOM_COLORS[1] }} />
          <span className="gm-dom-hbar-seg" style={{ width: `${othersDomPct}%`, background: DOM_COLORS[5] }} />
        </div>
        <div className="gm-dom-hbar-legend">
          <span className="gm-dom-hbar-legend-item"><span className="gm-dom-dot" style={{ background: DOM_COLORS[0] }} />BTC {btcDom.toFixed(1)}%</span>
          <span className="gm-dom-hbar-legend-item"><span className="gm-dom-dot" style={{ background: DOM_COLORS[1] }} />ETH {ethDom.toFixed(1)}%</span>
          <span className="gm-dom-hbar-legend-item"><span className="gm-dom-dot" style={{ background: DOM_COLORS[5] }} />{t("globalMarkets.others")} {othersDomPct.toFixed(1)}%</span>
        </div>
      </div>
    </>
  );

  const chartSectionBody = (
    <>
      <div className="gm-section-header">
        <div className="gm-chart-tabs">
          {CHART_TABS.map(ct => (
            <button key={ct.key}
              className={`gm-chart-tab${chartKey === ct.key ? " gm-chart-tab--active" : ""}`}
              style={chartKey === ct.key ? { color: ct.color, borderColor: ct.color } : {}}
              onClick={() => setChartKey(ct.key)}>
              {t(`globalMarkets.chartTabs.${ct.key}`, ct.label)}
            </button>
          ))}
        </div>
        <div className="gm-period-tabs">
          {PERIODS.map(p => (
            <button key={p.label}
              className={`gm-period-tab${period.label === p.label ? " gm-period-tab--active" : ""}`}
              onClick={() => setPeriod(p)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="gm-chart-wrap">
        {chartLoading && (
          <div className="gm-chart-loading">
            <div className="gm-chart-skel-bars">
              {Array.from({ length: 14 }).map((_, i) => (
                <span key={i} className="gm-chart-skel-bar" style={{ animationDelay: `${i * 70}ms`, height: `${30 + (i * 37) % 60}%` }} />
              ))}
            </div>
          </div>
        )}
        {!chartLoading && chartData.length > 0 && (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gmGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={activeTab.color} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={activeTab.color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="time" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                tickLine={false} axisLine={false}
                interval={Math.floor(chartData.length / 6)} />
              <YAxis tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                tickLine={false} axisLine={false} width={52}
                tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(0)}T` : `${v.toFixed(0)}B`}`} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="value" stroke={activeTab.color} strokeWidth={2}
                fill="url(#gmGrad)" dot={false} activeDot={{ r: 4, fill: activeTab.color }}
                isAnimationActive animationDuration={700} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  );

  return (
    <div className="gm-wrap">
      {/* ── Hero: one glowing card (the original gm-hero treatment) now
          carrying the Market Status / Trending / Market Activity /
          Community columns instead of just the market-cap figure — real
          data only (no fabricated metrics — see the comments on
          altcoinStrengthPct/marketActivity above for what's genuinely
          available right now vs. what isn't). ─────────────────────────── */}
      {/* ── Desktop hero: Market Status · Trending · Derivatives · Community,
          then a row of quick pills — real data only (ETF Flows / CMC20 /
          liquidations aren't available to us, so honest stand-ins fill
          those slots). Phones keep the .gm-hero below. ─────────────────── */}
      {isHeroDesktop && (() => {
        const ago = (ts: number) => {
          const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
          return m < 60 ? t("globalMarkets.ago.m", { n: m }) : m < 1440 ? t("globalMarkets.ago.h", { n: Math.round(m / 60) }) : t("globalMarkets.ago.d", { n: Math.round(m / 1440) });
        };
        const days = liqData.slice(-30);
        const upDays = days.filter((d) => d.ret >= 0).length;
        const downDays = days.length - upDays;
        const avgMove = days.length ? days.reduce((a, d) => a + Math.abs(d.ret), 0) / days.length : 0;
        const oiTotal = oiStats ? oiStats.btcUsd + oiStats.ethUsd : null;
        const trendRows = trending.slice(trendPage * 5, trendPage * 5 + 5);
        const askAI = (prompt: string) => window.dispatchEvent(new CustomEvent("open-trading-agent-with-prompt", { detail: { prompt } }));
        const openLink = (url?: string) => { if (url) window.open(url, "_blank", "noopener,noreferrer"); };
        const SRC_COLORS: Record<string, string> = { CoinTelegraph: "#f5b700", CoinDesk: "#1a56db", Decrypt: "#111827" };
        const hero = (
          <div className="gmh-block">
            <div
              className="gmh"
              onScroll={(e) => {
                const el = e.currentTarget;
                const card = el.firstElementChild as HTMLElement | null;
                if (!card) return;
                setHeroIdx(Math.round(el.scrollLeft / (card.offsetWidth + 12)));
              }}
            >
              {/* Market Status */}
              <section className="gmh-card">
                <div className="gmh-head">{t("globalMarkets.marketStatus")} <span className="gmh-chev">›</span></div>
                <div className="gmh-ms">
                  <div className="gmh-ms-col">
                    <div className="gmh-tile gmh-tile--fng">
                      <span className="gmh-label">{t("globalMarkets.fearGreed")}</span>
                      {fngValue !== null ? <FearGreedGauge value={fngValue} label={fngLabel(fng!.value_classification)} compact /> : <span className="gm-skel gm-skel-stat" />}
                    </div>
                    <div className="gmh-tile">
                      <span className="gmh-label">{t("globalMarkets.altcoinSeason")}</span>
                      {altcoinStrengthPct !== null ? (
                        <div className="gmh-alt">
                          <strong>{altcoinStrengthPct}</strong>
                          <span className="gmh-alt-track"><i style={{ left: `${altcoinStrengthPct}%` }} /></span>
                        </div>
                      ) : <span className="gm-skel gm-skel-stat" />}
                    </div>
                  </div>
                  <div className="gmh-ms-col">
                    <div className="gmh-tile">
                      <span className="gmh-label">{t("globalMarkets.marketCap")}</span>
                      <div className="gmh-val"><strong>{fmtBig(mcap)}</strong>
                        <em className={chg24h >= 0 ? "up" : "down"}>{chg24h >= 0 ? "▲" : "▼"} {Math.abs(chg24h).toFixed(2)}%</em></div>
                    </div>
                    <div className="gmh-tile">
                      <span className="gmh-label">{t("globalMarkets.volume24h")}</span>
                      <div className="gmh-val"><strong>{fmtBig(vol)}</strong></div>
                    </div>
                    <div className="gmh-tile">
                      <span className="gmh-label">{t("globalMarkets.btcDominance")}</span>
                      <div className="gmh-val"><strong>{btcDom.toFixed(1)}%</strong></div>
                    </div>
                  </div>
                </div>
              </section>

              {/* Trending (getTrending) */}
              <section className="gmh-card">
                <div className="gmh-head">
                  {t("globalMarkets.trending")} <span className="gmh-chev">›</span>
                  {trending.length > 5 && (
                    <span className="gmh-pager">
                      <button type="button" onClick={() => setTrendPage((p) => (p === 0 ? 1 : 0))} aria-label={t("globalMarkets.previous")}>‹</button>
                      <span>{trendPage + 1}/2</span>
                      <button type="button" onClick={() => setTrendPage((p) => (p === 0 ? 1 : 0))} aria-label={t("globalMarkets.next")}>›</button>
                      <span key={trendPage} className="gmh-pager-ring" aria-hidden="true" />
                    </span>
                  )}
                </div>
                <div className="gmh-trend">
                  {trendRows.length === 0 && Array.from({ length: 5 }).map((_, i) => <span key={i} className="gm-skel gmh-trend-skel" />)}
                  {trendRows.map((c, i) => (
                    <button key={c.id} type="button" className="gmh-trend-row" onClick={() => onSelectCoin?.(c.symbol.toUpperCase())}>
                      <span className="gmh-trend-rank">{trendPage * 5 + i + 1}</span>
                      <img src={c.thumb} alt="" loading="lazy" />
                      <span className="gmh-trend-sym">{c.symbol.toUpperCase()}</span>
                      <span className="gmh-trend-name">{c.name}</span>
                      {c.chg !== null && (
                        <span className={`gmh-trend-chg ${c.chg >= 0 ? "up" : "down"}`}>{c.chg >= 0 ? "+" : ""}{c.chg.toFixed(1)}%</span>
                      )}
                    </button>
                  ))}
                </div>
              </section>

              {/* Derivatives */}
              <section className="gmh-card">
                <div className="gmh-head">{t("globalMarkets.derivatives")} <span className="gmh-chev">›</span></div>
                <div className="gmh-tile gmh-deriv">
                  <div className="gmh-deriv-stats">
                    <div><span className="gmh-label">{t("globalMarkets.btcDailyMoves")}</span><strong>{t("globalMarkets.avgMove", { value: avgMove.toFixed(2) })}</strong></div>
                    <div><span className="gmh-label">{t("globalMarkets.upDays")}</span><strong className="up">{upDays}</strong></div>
                    <div><span className="gmh-label">{t("globalMarkets.downDays")}</span><strong className="down">{downDays}</strong></div>
                  </div>
                  <div className="gmh-bars">
                    {days.map((d, i) => (
                      <span key={i} className={d.ret >= 0 ? "up" : "down"} style={{ height: `${Math.max(8, Math.min(100, Math.abs(d.ret) * 18))}%` }} title={`${d.time}: ${d.ret >= 0 ? "+" : ""}${d.ret.toFixed(2)}%`} />
                    ))}
                  </div>
                </div>
                <div className="gmh-row2">
                  <div className="gmh-tile" title={t("globalMarkets.oiTitle")}>
                    <span className="gmh-label">{t("globalMarkets.openInterest")}</span>
                    <div className="gmh-val"><strong>{oiTotal !== null ? fmtBig(oiTotal) : "—"}</strong></div>
                  </div>
                  <div className="gmh-tile">
                    <span className="gmh-label">{t("globalMarkets.volumeParen24h")}</span>
                    <div className="gmh-val"><strong>{fmtBig(vol)}</strong></div>
                  </div>
                </div>
              </section>

              {/* Community → latest crypto headlines */}
              <section className="gmh-card">
                <div className="gmh-head">{t("globalMarkets.community")} <span className="gmh-chev">›</span></div>
                <div className="gmh-posts">
                  {news.length === 0 && [0, 1].map((i) => <span key={i} className="gm-skel gmh-post-skel" />)}
                  {news.slice(0, 2).map((n) => (
                    <button key={n.url} type="button" className="gmh-post" onClick={() => openLink(n.url)}>
                      <span className="gmh-post-head">
                        <span className="gmh-post-avatar" style={{ background: SRC_COLORS[n.source] ?? "#6366f1" }}>{n.source.slice(0, 1)}</span>
                        <strong>{n.source}</strong>
                        <span className="gmh-post-time">· {ago(n.pubDate)}</span>
                      </span>
                      <span className="gmh-post-text">{n.title}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>

            {/* Phones: which card is showing. */}
            <div className="gmh-dots" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => <span key={i} className={i === heroIdx ? "on" : ""} />)}
            </div>

            {/* Quick pills */}
            <div className="gmh-pills">
              {news[0] && (
                <button type="button" className="gmh-pill gmh-pill--topic" onClick={() => openLink(news[0].url)}>
                  <span className="gmh-pill-tag">{t("globalMarkets.topic")}</span><span className="gmh-pill-text">{news[0].title}</span>
                </button>
              )}
              <button type="button" className="gmh-pill gmh-pill--new" onClick={() => window.dispatchEvent(new CustomEvent("open-trading-agent"))}>
                <span className="gmh-pill-new">{t("globalMarkets.new")}</span>{t("globalMarkets.tryAgent")}
              </button>
              <button type="button" className="gmh-pill gmh-pill--new" onClick={() => window.dispatchEvent(new CustomEvent("open-daily-brief"))}>
                <span className="gmh-pill-new">{t("globalMarkets.new")}</span>{t("globalMarkets.topNews")}
              </button>
              {!aiAlertPillHidden && (
                <span className="gmh-pill gmh-pill--alert">
                  <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("open-strategy-alert"))}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
                    {t("globalMarkets.addAiAlert")}
                  </button>
                  <button type="button" className="gmh-pill-x" aria-label={t("globalMarkets.hide")} onClick={() => { setAiAlertPillHidden(true); try { localStorage.setItem("gmhAiAlertPillHidden", "1"); } catch { /* ignore */ } }}>×</button>
                </span>
              )}
              {news[1] && (
                <button type="button" className="gmh-pill gmh-pill--hot" onClick={() => openLink(news[1].url)}>
                  <span aria-hidden="true">🔥</span><span className="gmh-pill-text">{news[1].title}</span>
                </button>
              )}
              <button type="button" className="gmh-pill gmh-pill--ask" onClick={() => askAI(chg24h >= 0 ? t("globalMarkets.askWhyUp") : t("globalMarkets.askWhyDown"))}>
                <span aria-hidden="true">{chg24h >= 0 ? "↗" : "↘"}</span>{chg24h >= 0 ? t("globalMarkets.whyUp") : t("globalMarkets.whyDown")}
              </button>
              <button type="button" className="gmh-pill gmh-pill--ask" onClick={() => askAI(t("globalMarkets.askAltsVsBtc"))}>
                <span aria-hidden="true">⇄</span>{t("globalMarkets.altsVsBtc")}
              </button>
              <button type="button" className="gmh-pill gmh-pill--ask" onClick={() => askAI(t("globalMarkets.askKeyLevels"))}>
                <span aria-hidden="true">◎</span>{t("globalMarkets.keyLevels")}
              </button>
            </div>
          </div>
        );
        return hero;
      })()}

      {/* Coin table with a signal column, right under the hero row. */}
      <MarketSignalTable coins={coins} onSelectCoin={onSelectCoin} onOpenAuth={onOpenAuth} onTradeCoin={onTradeCoin} />

      <div className="gm-hero">
        <span className="gm-hero-glow" />
        <div className="gm-status-grid">
        {/* Market Status — two sub-columns of mini tiles, matching a
            reference screenshot exactly: left = Fear & Greed gauge +
            Altcoin Season slider (stacked), right = Market Cap + 24h
            Volume + BTC Dominance (stacked). The reference's own right
            column is Market Cap/CMC20/ETF Flows — CMC20 (CoinMarketCap's
            own proprietary index) and ETF Flows (no free data source)
            aren't things we can show honestly, so Volume/BTC Dominance
            (both real, already computed) fill those two slots instead. */}
        <div className="gm-status-col">
          <div className="gm-status-col-head"><span className="gm-status-col-icon gm-status-col-icon--fng">{IC.cap}</span>{t("globalMarkets.marketStatus")}</div>
          <div className="gm-marketstatus-grid">
            <div className="gm-marketstatus-col">
              <div className="gm-marketstatus-tile gm-marketstatus-tile--fng">
                <span className="gm-marketstatus-tile-label">{t("globalMarkets.fearGreed")}</span>
                {fngValue !== null ? (
                  <FearGreedGauge value={fngValue} label={fngLabel(fng!.value_classification)} compact />
                ) : (
                  <div className="gm-fng-skel">
                    <span className="gm-skel gm-fng-skel-arc" />
                    <span className="gm-skel gm-fng-skel-value" />
                  </div>
                )}
              </div>
              {altcoinStrengthPct !== null && (
                <div className="gm-marketstatus-tile">
                  <span className="gm-marketstatus-tile-label">{t("globalMarkets.altcoinSeason")} <em>({altSeasonPeriod.label})</em></span>
                  <div className="gm-marketstatus-altseason-value">{altcoinStrengthPct}</div>
                  <div className="gm-altseason-track gm-marketstatus-altseason-track">
                    <span className="gm-altseason-dot" style={{ left: `${altcoinStrengthPct}%` }} />
                  </div>
                </div>
              )}
            </div>
            <div className="gm-marketstatus-col">
              <div className="gm-marketstatus-tile">
                <span className="gm-marketstatus-tile-label">{t("globalMarkets.marketCap")}</span>
                <div className="gm-marketstatus-stat">
                  <strong>{fmtBig(mcap)}</strong>
                  <span className={chg24h >= 0 ? "gm-pct--pos" : "gm-pct--neg"}>
                    {chg24h >= 0 ? "▲" : "▼"} {Math.abs(chg24h).toFixed(2)}%
                  </span>
                </div>
              </div>
              <div className="gm-marketstatus-tile">
                <span className="gm-marketstatus-tile-label">{t("globalMarkets.volume24h")}</span>
                <div className="gm-marketstatus-stat"><strong>{fmtBig(vol)}</strong></div>
              </div>
              <div className="gm-marketstatus-tile">
                <span className="gm-marketstatus-tile-label">{t("globalMarkets.btcDominance")}</span>
                <div className="gm-marketstatus-stat"><strong>{btcDom.toFixed(1)}%</strong></div>
              </div>
            </div>
          </div>
        </div>

        {/* Top Gainers/Losers (compact) — same gainers/losers/moverPage
            state and 1/2 pager pattern the full banner next to the Top
            Cryptocurrencies table uses, just 5 rows at a time in the
            hero's own compact list style (matches Trending Coins' old
            row treatment here). */}
        <div className="gm-status-col">
          <div className="gm-status-col-head gm-status-col-head--trending">
            <span><span className="gm-status-col-icon">{moverPage === 0 ? "▲" : "▼"}</span>{moverPage === 0 ? t("globalMarkets.topGainers") : t("globalMarkets.topLosers")}</span>
            <div className="gm-trending-pager">
              <button type="button" className="gm-mover-banner-pager-arrow" aria-label={t("globalMarkets.previous")}
                onClick={() => setMoverPage(p => (p === 0 ? 1 : 0))}>‹</button>
              <span className="gm-mover-banner-pager-label">{moverPage + 1}/2</span>
              <button type="button" className="gm-mover-banner-pager-arrow" aria-label={t("globalMarkets.next")}
                onClick={() => setMoverPage(p => (p === 0 ? 1 : 0))}>›</button>
              {/* Progress ring mirrors the 5s auto-advance timer above —
                  key={moverPage} remounts (restarts) it on every page
                  change, manual or automatic, so it's always in sync. */}
              <span key={moverPage} className="gm-trending-pager-ring" aria-hidden="true">
                <span className="gm-trending-pager-ring-dot" />
              </span>
            </div>
          </div>
          <div className="gm-status-list">
            {(moverPage === 0 ? gainers : losers).slice(0, 5).map((c) => {
              const pct = Math.abs(c.price_change_percentage_24h ?? 0);
              return (
                <button key={c.id} type="button" className="gm-status-list-row" onClick={() => onSelectCoin?.(c.symbol.toUpperCase())}>
                  <span className="gm-status-list-main">
                    <img src={c.image} alt="" className="gm-status-list-img" loading="lazy" />
                    <span className="gm-status-list-info">
                      <span className="gm-status-list-sym">{c.symbol.toUpperCase()}</span>
                      <span className="gm-status-list-price">{fmtPrice(c.current_price)}</span>
                      <span className={`gm-status-list-chg${moverPage === 0 ? " gm-pct--pos" : " gm-pct--neg"}`}>
                        {moverPage === 0 ? "▲" : "▼"} {pct.toFixed(1)}%
                      </span>
                    </span>
                  </span>
                  <Sparkline data={c.sparkline_in_7d?.price} color={moverPage === 0 ? "#22c55e" : "#fb7185"} width={56} height={32} />
                </button>
              );
            })}
          </div>
        </div>

        {/* Market Activity — real volume figures (services/marketData.ts). */}
        <div className="gm-status-col">
          <div className="gm-status-col-head"><span className="gm-status-col-icon">{IC.vol}</span>{t("globalMarkets.marketActivity")}</div>
          <div className="gm-activity-grid">
            <div className="gm-activity-tile">
              <span className="gm-activity-tile-icon">{IC.vol}</span>
              <span className="gm-activity-tile-value">{fmtBig(vol)}</span>
              <span className="gm-activity-tile-label">{t("globalMarkets.totalVolume24h")}</span>
            </div>
            <div className="gm-activity-tile">
              <span className="gm-activity-tile-icon">{IC.btc}</span>
              <span className="gm-activity-tile-value">{btcRow ? fmtBig(btcRow.total_volume) : "—"}</span>
              <span className="gm-activity-tile-label">{t("globalMarkets.btcVolume24h")}</span>
            </div>
            <div className="gm-activity-tile">
              <span className="gm-activity-tile-icon">{IC.markets}</span>
              <span className="gm-activity-tile-value">{g.markets?.toLocaleString() ?? "—"}</span>
              <span className="gm-activity-tile-label">{t("globalMarkets.activeMarkets")}</span>
            </div>
            <div className="gm-activity-tile">
              <span className="gm-activity-tile-icon">{IC.coins}</span>
              <span className="gm-activity-tile-value">{g.active_cryptocurrencies?.toLocaleString() ?? "—"}</span>
              <span className="gm-activity-tile-label">{t("globalMarkets.activeCryptos")}</span>
            </div>
          </div>
        </div>

        {/* Derivatives — same nested-tile style as Market Status (one big
            tile with a mini chart, then a row of smaller stat tiles), but
            a reference screenshot's "All Liquidations" figure isn't real
            data we have (CoinGlass's own liquidation endpoints still
            reject with "Upgrade plan" — same reason Market Pulse below
            exists as a substitute in the first place): the big tile here
            reuses that same real BTC daily-swing series (liqData) instead
            of fabricating liquidation numbers, with real Gainers/Losers
            counts standing in for Long/Short. Open Interest/DVOL below
            are the same real oi/dvol figures the old standalone section
            used to show. */}
        <div className="gm-status-col">
          <div className="gm-status-col-head"><span className="gm-status-col-icon">{IC.vol}</span>{t("globalMarkets.derivatives")}</div>
          <div className="gm-marketstatus-tile gm-derivatives-chart-tile">
            <div className="gm-derivatives-chart-stats">
              <div className="gm-derivatives-chart-stat">
                <span className="gm-marketstatus-tile-label">{t("globalMarkets.volume24h")}</span>
                <strong>{fmtBig(vol)}</strong>
              </div>
              <div className="gm-derivatives-chart-stat">
                <span className="gm-marketstatus-tile-label">{t("globalMarkets.gainers")}</span>
                <strong className="gm-pct--pos">{gainersCount}</strong>
              </div>
              <div className="gm-derivatives-chart-stat">
                <span className="gm-marketstatus-tile-label">{t("globalMarkets.losers")}</span>
                <strong className="gm-pct--neg">{losersCount}</strong>
              </div>
            </div>
            {liqData.length > 0 && (
              <div className="gm-derivatives-mini-chart">
                {liqData.slice(-24).map((d, i) => {
                  const h = Math.max(14, Math.min(100, Math.abs(d.ret) * 14));
                  return <span key={i} className={d.ret >= 0 ? "gm-derivatives-bar--up" : "gm-derivatives-bar--down"} style={{ height: `${h}%` }} />;
                })}
              </div>
            )}
          </div>
          <div className="gm-marketstatus-grid">
            <div className="gm-marketstatus-tile">
              <span className="gm-marketstatus-tile-label">{t("globalMarkets.openInterest")}</span>
              {oiStats ? (
                <>
                  <div className="gm-marketstatus-stat"><strong>{fmtBig(oiStats.btcUsd)}</strong><span>BTC</span></div>
                  <div className="gm-marketstatus-stat"><strong>{fmtBig(oiStats.ethUsd)}</strong><span>ETH</span></div>
                </>
              ) : (
                <span className="gm-skel gm-skel-stat" />
              )}
            </div>
            <div className="gm-marketstatus-tile">
              <span className="gm-marketstatus-tile-label">{t("globalMarkets.impliedVol")}</span>
              {dvol ? (
                <>
                  <div className="gm-marketstatus-stat"><strong>{dvol.btc.toFixed(1)}%</strong><span>BTC</span></div>
                  <div className="gm-marketstatus-stat"><strong>{dvol.eth.toFixed(1)}%</strong><span>ETH</span></div>
                </>
              ) : (
                <span className="gm-skel gm-skel-stat" />
              )}
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* ── Fear & Greed Index Chart — a fuller treatment of the same index
          the hero's own compact gauge used to show (now hidden, see
          .gm-status-fng in GlobalMarkets.css): historical values, yearly
          high/low, and a real history chart, all from alternative.me's
          free full-history endpoint (fngHistory, fetched once above). */}
      {fngValue !== null && (
        <div className="gm-fnghist-section">
          <div className="gm-section gm-fnghist-card">
            <div className="gm-section-header">
              <span className="gm-section-title">{t("globalMarkets.fngIndex")}</span>
            </div>
            <div className="gm-fnghist-gauge-wrap">
              <FearGreedGauge value={fngValue} label={fngLabel(fng!.value_classification)} />
            </div>
            {(fngYesterday || fngLastWeek || fngLastMonth) && (
              <div className="gm-fnghist-block">
                <div className="gm-fnghist-block-title">{t("globalMarkets.historicalValues")}</div>
                {fngYesterday && (
                  <div className="gm-fnghist-row">
                    <span>{t("globalMarkets.yesterday")}</span>
                    <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngYesterday.value)) }}>
                      {fngLabel(fngYesterday.value_classification)} · {fngYesterday.value}
                    </span>
                  </div>
                )}
                {fngLastWeek && (
                  <div className="gm-fnghist-row">
                    <span>{t("globalMarkets.lastWeek")}</span>
                    <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngLastWeek.value)) }}>
                      {fngLabel(fngLastWeek.value_classification)} · {fngLastWeek.value}
                    </span>
                  </div>
                )}
                {fngLastMonth && (
                  <div className="gm-fnghist-row">
                    <span>{t("globalMarkets.lastMonth")}</span>
                    <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngLastMonth.value)) }}>
                      {fngLabel(fngLastMonth.value_classification)} · {fngLastMonth.value}
                    </span>
                  </div>
                )}
              </div>
            )}
            {fngYearHigh && fngYearLow && (
              <div className="gm-fnghist-block">
                <div className="gm-fnghist-block-title">{t("globalMarkets.yearlyHighLow")}</div>
                <div className="gm-fnghist-row">
                  <span>{t("globalMarkets.highOn", { date: new Date(Number(fngYearHigh.timestamp) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }) })}</span>
                  <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngYearHigh.value)) }}>
                    {fngLabel(fngYearHigh.value_classification)} · {fngYearHigh.value}
                  </span>
                </div>
                <div className="gm-fnghist-row">
                  <span>{t("globalMarkets.lowOn", { date: new Date(Number(fngYearLow.timestamp) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }) })}</span>
                  <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngYearLow.value)) }}>
                    {fngLabel(fngYearLow.value_classification)} · {fngYearLow.value}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="gm-section gm-fnghist-chart-card">
            <div className="gm-section-header">
              <span className="gm-section-title">{t("globalMarkets.fngChart")}</span>
              <div className="gm-period-tabs">
                {FNG_PERIODS.map(p => (
                  <button key={p.label}
                    className={`gm-period-tab${fngPeriod.label === p.label ? " gm-period-tab--active" : ""}`}
                    onClick={() => setFngPeriod(p)}>
                    {periodLabel(p.label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="gm-chart-wrap">
              {fngChartData.length === 0 ? (
                <div className="gm-chart-loading">
                  <div className="gm-chart-skel-bars">
                    {Array.from({ length: 14 }).map((_, i) => (
                      <span key={i} className="gm-chart-skel-bar" style={{ animationDelay: `${i * 70}ms`, height: `${30 + (i * 37) % 60}%` }} />
                    ))}
                  </div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={fngChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gmFngLineGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" />
                        <stop offset="25%" stopColor="#84cc16" />
                        <stop offset="50%" stopColor="#eab308" />
                        <stop offset="75%" stopColor="#f97316" />
                        <stop offset="100%" stopColor="#ef4444" />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                    <ReferenceArea y1={75} y2={100} fill="#22c55e" fillOpacity={0.07} />
                    <ReferenceArea y1={0} y2={25} fill="#ef4444" fillOpacity={0.07} />
                    <XAxis dataKey="time" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                      tickLine={false} axisLine={false} interval={Math.floor(fngChartData.length / 6)} />
                    <YAxis domain={[0, 100]} tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                      tickLine={false} axisLine={false} width={28} />
                    <Tooltip content={<FngHistTooltip />} />
                    <Line type="monotone" dataKey="value" stroke="url(#gmFngLineGrad)" strokeWidth={2}
                      dot={false} isAnimationActive animationDuration={700} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Altcoin Season + Crypto Market Cap — pulled out as their own
          standalone cards (not a bar tucked inside the hero, not a tab
          buried in another chart) so they read the same way
          CoinMarketCap's own dashboard presents them. ─────────────────── */}
      <div className="gm-topcards-grid">
        {altcoinStrengthPct !== null && (
          <div className="gm-section gm-altseason-card">
            <div className="gm-section-header">
              <span className="gm-section-title">{t("globalMarkets.altcoinSeason")}</span>
              <div className="gm-period-tabs">
                {ALT_SEASON_PERIODS.map(p => (
                  <button key={p.label}
                    className={`gm-period-tab${altSeasonPeriod.label === p.label ? " gm-period-tab--active" : ""}`}
                    onClick={() => setAltSeasonPeriod(p)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="gm-altseason-value">{altcoinStrengthPct}<span className="gm-altseason-value-max">/100</span></div>
            <div className="gm-altseason-track">
              <span className="gm-altseason-dot" style={{ left: `${altcoinStrengthPct}%` }} />
            </div>
            <div className="gm-altseason-labels">
              <span>{t("globalMarkets.bitcoinSeason")}</span>
              <span>{t("globalMarkets.altcoinSeason")}</span>
            </div>
          </div>
        )}

        <div className="gm-section gm-mcap-card">
          <div className="gm-section-header">
            <span className="gm-section-title">{t("globalMarkets.cryptoMarketCap")}</span>
            <div className="gm-period-tabs">
              {MCAP_PERIODS.map(p => (
                <button key={p.label}
                  className={`gm-period-tab${mcapPeriod.label === p.label ? " gm-period-tab--active" : ""}`}
                  onClick={() => setMcapPeriod(p)}>
                  {periodLabel(p.label)}
                </button>
              ))}
            </div>
          </div>
          <div className="gm-mcap-stats">
            <div className="gm-mcap-stat">
              <span className="gm-mcap-stat-label">{t("globalMarkets.marketCap")}</span>
              <span className="gm-mcap-stat-value">{fmtBig(mcap)}</span>
            </div>
            <div className="gm-mcap-stat">
              <span className="gm-mcap-stat-label">{t("globalMarkets.volume")}</span>
              <span className="gm-mcap-stat-value">{fmtBig(vol)}</span>
            </div>
          </div>
          <div className="gm-chart-est-note">{t("globalMarkets.estNote")}</div>
          <div className="gm-chart-wrap">
            {mcapLoading && (
              <div className="gm-chart-loading">
                <div className="gm-chart-skel-bars">
                  {Array.from({ length: 14 }).map((_, i) => (
                    <span key={i} className="gm-chart-skel-bar" style={{ animationDelay: `${i * 70}ms`, height: `${30 + (i * 37) % 60}%` }} />
                  ))}
                </div>
              </div>
            )}
            {!mcapLoading && mcapSeries.length > 0 && (
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={mcapSeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gmMcapGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                    tickLine={false} axisLine={false} interval={Math.floor(mcapSeries.length / 6)} />
                  <YAxis yAxisId="mcap" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                    tickLine={false} axisLine={false} width={52}
                    tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}T` : `${v.toFixed(0)}B`}`} />
                  <YAxis yAxisId="vol" orientation="right" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                    tickLine={false} axisLine={false} width={48}
                    tickFormatter={v => `$${v.toFixed(0)}B`} />
                  <Tooltip content={<McapTooltip />} />
                  <Bar yAxisId="vol" dataKey="vol" fill="var(--color-border)" radius={[2, 2, 0, 0]} isAnimationActive animationDuration={600} />
                  <Area yAxisId="mcap" type="monotone" dataKey="mcap" stroke="#22c55e" strokeWidth={2}
                    fill="url(#gmMcapGrad)" dot={false} activeDot={{ r: 4, fill: "#22c55e" }}
                    isAnimationActive animationDuration={700} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* ── Market Pulse (Liquidations-style layout, honest substitute data —
          see LIQ_RANGES comment above: CoinGlass's own liquidation endpoints
          are all currently rejecting with "Upgrade plan") ─────────────────── */}
      <div className="gm-section gm-liq">
        <div className="gm-section-header">
          <span className="gm-section-title">{IC.vol} {t("globalMarkets.marketPulse")}</span>
          <span className="gm-section-sub">{t(liqSource === "pp" ? "globalMarkets.liveCoinPaprika" : liqSource === "cl" ? "globalMarkets.liveCoinLore" : "globalMarkets.liveCoinGecko")}</span>
        </div>

        <div className="gm-liq-grid">
          <div className="gm-liq-side">
            <div className="gm-liq-stat-card">
              <div className="gm-liq-stat-label">{t("globalMarkets.tradingVolume24h")}</div>
              <div className="gm-liq-stat-value">{fmtBig(vol)}</div>
              <div className="gm-liq-stat-row">
                <span className="gm-liq-stat-row-label">{t("globalMarkets.gainers")}</span>
                <span className="gm-liq-stat-row-value gm-pct--pos">{gainersCount}</span>
              </div>
              <div className="gm-liq-stat-row">
                <span className="gm-liq-stat-row-label">{t("globalMarkets.losers")}</span>
                <span className="gm-liq-stat-row-value gm-pct--neg">{losersCount}</span>
              </div>
            </div>

            <div className="gm-liq-events-card">
              <div className="gm-liq-events-title">{t("globalMarkets.biggestMovers")}</div>
              {topMovers.map((c, i) => {
                const chg = c.price_change_percentage_24h ?? 0;
                return (
                  <button key={c.id} type="button" className="gm-liq-event-row" onClick={() => onSelectCoin?.(c.symbol.toUpperCase())}>
                    <span className="gm-liq-event-medal">{["🥇", "🥈", "🥉"][i]}</span>
                    <span className="gm-liq-event-sym">{c.symbol.toUpperCase()}</span>
                    <span className="gm-liq-event-name">{c.name}</span>
                    <span className={`gm-liq-event-chg${chg >= 0 ? " gm-pct--pos" : " gm-pct--neg"}`}>
                      {chg >= 0 ? "+" : ""}
                      {chg.toFixed(1)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="gm-liq-chart-card">
            <div className="gm-liq-chart-head">
              <span className="gm-liq-chart-title">{t("globalMarkets.btcPriceSwings")}</span>
              <div className="gm-period-tabs">
                {LIQ_RANGES.map(r => (
                  <button key={r.label}
                    className={`gm-period-tab${liqRange.label === r.label ? " gm-period-tab--active" : ""}`}
                    onClick={() => setLiqRange(r)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="gm-liq-legend">
              <span className="gm-liq-legend-item"><span className="gm-liq-dot gm-liq-dot--up" />{t("globalMarkets.upDay")}</span>
              <span className="gm-liq-legend-item"><span className="gm-liq-dot gm-liq-dot--down" />{t("globalMarkets.downDay")}</span>
              <span className="gm-liq-legend-item"><span className="gm-liq-dot gm-liq-dot--price" />{t("globalMarkets.bitcoinPrice")}</span>
            </div>

            {liqLoading && (
              <div className="gm-chart-loading">
                <div className="gm-chart-skel-bars">
                  {Array.from({ length: 14 }).map((_, i) => (
                    <span key={i} className="gm-skel gm-chart-skel-bar" style={{ animationDelay: `${i * 70}ms`, height: `${30 + (i * 37) % 60}%` }} />
                  ))}
                </div>
              </div>
            )}
            {!liqLoading && liqData.length > 0 && (
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={liqData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                  <XAxis dataKey="time" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                    tickLine={false} axisLine={false} interval={Math.floor(liqData.length / 6)} />
                  <YAxis yAxisId="ret" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                    tickLine={false} axisLine={false} width={40} tickFormatter={v => `${v}%`} />
                  <YAxis yAxisId="price" orientation="right" tick={{ fill: "var(--color-text-secondary)", fontSize: 10 }}
                    tickLine={false} axisLine={false} width={56} tickFormatter={v => fmtPrice(v)} />
                  <Tooltip content={<LiqTooltip />} />
                  <Bar yAxisId="ret" dataKey="ret" radius={[2, 2, 2, 2]} isAnimationActive animationDuration={600}>
                    {liqData.map((d, i) => <Cell key={i} fill={d.ret >= 0 ? "#22c55e" : "#ef4444"} />)}
                  </Bar>
                  <Line yAxisId="price" type="monotone" dataKey="price" stroke="#f59e0b" strokeWidth={2}
                    dot={false} isAnimationActive animationDuration={700} />
                  <Brush dataKey="time" height={24} stroke="var(--color-border)" fill="var(--color-input-bg)" travellerWidth={8} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>


      {/* ── Dominance donut + Chart, side by side ───────────────────────────── */}
      <div className="gm-dom-chart-grid">
        <div className="gm-section">
          <div className="gm-section-header">
            <span className="gm-section-title">{t("globalMarkets.mcapDominance")}</span>
          </div>
          {domSectionBody}
        </div>

        {/* ── Chart ────────────────────────────────────────────────────────── */}
        <div className="gm-section gm-bigchart-card">
          {chartSectionBody}
        </div>
      </div>

      {/* Top Cryptocurrencies table moved to the Trade (#chart) page's
          bottom panel (ChartBottomPanel). */}

      {/* CoinPaprika's free tier requires a credit — shown only while some
          of this page's data came from it (CoinGecko fallback). */}
      {paprikaShown && <div className="gm-source-note">{t("globalMarkets.dataCoinPaprika")}</div>}
    </div>
  );
}

// ── Tooltip ────────────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number; payload: ChartPoint }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="gm-tooltip">
      <div className="gm-tooltip-label">{label}</div>
      <div className="gm-tooltip-value">{fmtBig(payload[0].payload.raw)}</div>
    </div>
  );
}

function FngHistTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const value = payload[0].value;
  return (
    <div className="gm-tooltip">
      <div className="gm-tooltip-label">{label}</div>
      <div className="gm-tooltip-value" style={{ color: fngColor(value) }}>{Math.round(value)}</div>
    </div>
  );
}

function McapTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: { mcap: number; vol: number | null } }[]; label?: string }) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="gm-tooltip">
      <div className="gm-tooltip-label">{label}</div>
      <div className="gm-tooltip-value">${d.mcap.toFixed(0)}B</div>
      <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>{t("globalMarkets.tooltipVol", { value: d.vol != null ? `$${d.vol.toFixed(1)}B` : "—" })}</div>
    </div>
  );
}

function LiqTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: { ret: number; price: number } }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="gm-tooltip">
      <div className="gm-tooltip-label">{label}</div>
      <div className="gm-tooltip-value">{fmtPrice(d.price)}</div>
      <div className={d.ret >= 0 ? "gm-pct--pos" : "gm-pct--neg"} style={{ fontSize: "0.72rem", fontWeight: 700 }}>
        {d.ret >= 0 ? "+" : ""}
        {d.ret.toFixed(2)}%
      </div>
    </div>
  );
}
