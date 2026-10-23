import { useState, useEffect, useRef, type CSSProperties } from "react";
import { Capacitor } from "@capacitor/core";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell, ComposedChart, Bar, Line, Brush, ReferenceArea,
} from "recharts";
import "../styles/GlobalMarkets.css";
import { SectionBanner } from "./SectionBanner";
import { deribit } from "../services/deribit";

// ── Types ──────────────────────────────────────────────────────────────────────
interface GlobalData {
  active_cryptocurrencies: number;
  markets: number;
  total_market_cap: { usd: number };
  total_volume: { usd: number };
  market_cap_percentage: { btc: number; eth: number; [k: string]: number };
  market_cap_change_percentage_24h_usd: number;
  defi_market_cap: string;
  defi_to_eth_ratio: string;
  trading_volume_24h: string;
  defi_volume_24h: string;
}

interface ChartPoint { time: string; value: number; raw: number; }
interface CoinRow {
  id: string; symbol: string; name: string; image: string;
  market_cap_rank: number; current_price: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d_in_currency: number;
  price_change_percentage_30d_in_currency?: number;
  market_cap: number; total_volume: number;
  sparkline_in_7d?: { price: number[] };
}

interface TrendingCoin {
  id: string; name: string; symbol: string; thumb: string;
  market_cap_rank: number; price_btc: number; score: number;
  // CoinGecko's trending response nests real USD price/24h change here —
  // already present in the same response we already fetch, no extra
  // request needed for the list to show real numbers instead of just
  // rank/name.
  data?: { price: number; price_change_percentage_24h?: { usd?: number } };
}

interface SentimentCoin { id: string; symbol: string; name: string; up: number; down: number; }

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

// CoinGlass's own liquidation endpoints are all currently rejecting with
// "Upgrade plan" on the live key (verified directly against the proxy), so
// the "Market Pulse" section below is an honest substitute built entirely
// from CoinGecko data actually available: daily BTC price swings (real,
// derived) standing in for the long/short liquidation histogram, and
// today's biggest real movers standing in for curated liquidation events.
const LIQ_RANGES = [
  { label: "1M", days: 30  },
  { label: "3M", days: 90  },
  { label: "1Y", days: 365 },
] as const;

const TABLE_PAGE_SIZE = 15;

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtBig(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

function fmtPrice(n: number): string {
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
const cache: Record<string, { data: unknown; ts: number }> = {};
const TTL = { global: 60_000, chart: 120_000, coins: 90_000, trending: 300_000, fng: 300_000, oi: 60_000, fngHistory: 600_000 };
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
const CG_API_KEY = import.meta.env.VITE_COINGECKO_API_KEY as string | undefined;
// Same gap BN_BASE (coinglass.ts) and API_BASE (openai.ts) already work
// around: the native app loads its bundled web content from a local
// capacitor:// origin, not https://www.coinhintz.io, so a relative
// /coinalyze-api/* fetch resolves to nothing on-device — there's no
// server there to proxy it. Unlike CoinGecko (open CORS, called directly
// elsewhere in this file), Coinalyze's key is only added server-side by
// middleware.ts, so native has to reach that middleware via the real
// production domain instead of calling Coinalyze directly.
const COINALYZE_BASE = Capacitor.isNativePlatform() ? "https://www.coinhintz.io/coinalyze-api" : "/coinalyze-api";

// timeoutMs is opt-in (existing callers are unaffected) — added for the
// market_chart calls specifically, which have been observed hanging
// forever on-device (native fetch() never resolving OR rejecting, so
// .then/.catch never fire and the loading skeleton is stuck permanently)
// even though the identical request succeeds instantly from curl and from
// this file's other CoinGecko calls (global/coins/markets/trending/
// sentiment). Root cause unconfirmed (couldn't get live device console
// access to see the actual native networking error) — this bounds the
// damage regardless of cause: a hang becomes a clean, retriable failure
// instead of an infinite stuck skeleton.
async function cgFetch<T>(url: string, ttl: number, timeoutMs?: number): Promise<T> {
  const now = Date.now();
  if (cache[url] && now - cache[url].ts < ttl) return cache[url].data as T;
  // Key goes in the query string, not an x-cg-demo-api-key header — a
  // custom header triggers a CORS preflight that CoinGecko's own
  // Access-Control-Allow-Headers doesn't list, so the browser blocks the
  // real request before it goes out. The query param needs no preflight.
  const fetchUrl = CG_API_KEY ? `${url}${url.includes("?") ? "&" : "?"}x_cg_demo_api_key=${CG_API_KEY}` : url;
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(fetchUrl, { headers: { accept: "application/json" }, signal: controller?.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache[url] = { data, ts: now };
    return data as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Plain fetch (no CoinGecko key appended) for other public APIs sharing
// the same in-memory TTL cache — alternative.me's Fear & Greed index.
async function plainFetch<T>(url: string, ttl: number): Promise<T> {
  const now = Date.now();
  if (cache[url] && now - cache[url].ts < ttl) return cache[url].data as T;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cache[url] = { data, ts: now };
  return data as T;
}

// ── Sparkline ──────────────────────────────────────────────────────────────────
function Sparkline({ data, color, width = 90, height = 28 }: { data?: number[]; color: string; width?: number; height?: number }) {
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

// ── Sentiment gauge (Community column) — a small radial ring, same
// "gauge" treatment as the Fear & Greed meter above, instead of a flat
// bar: sweeps in from 0 on mount/value-change. ──────────────────────────
function SentimentGauge({ symbol, up, delay }: { symbol: string; up: number; delay: number }) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setPct(up), 150 + delay);
    return () => clearTimeout(t);
  }, [up, delay]);
  const color = pct >= 50 ? "var(--color-success)" : "var(--color-danger)";
  return (
    <div className="gm-sentiment-gauge">
      <svg viewBox="0 0 64 64" className="gm-sentiment-gauge-svg">
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--color-border)" strokeWidth="6" />
        <circle
          cx="32" cy="32" r={R} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C - (pct / 100) * C}
          transform="rotate(-90 32 32)"
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1), stroke 0.3s" }}
        />
      </svg>
      <div className="gm-sentiment-gauge-center">
        <span className="gm-sentiment-gauge-pct" style={{ color }}>{Math.round(up)}%</span>
      </div>
      <span className="gm-sentiment-gauge-sym">{symbol}</span>
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

// ── Skeleton loader ──────────────────────────────────────────────────────────────
function GmSkeleton() {
  return (
    <div className="gm-wrap">
      <SectionBanner section="markets" />
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
        Loading global market data…
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
  // Any CoinGecko coin can be clicked, not just ones the app's own COINS
  // roster recognizes — an unsupported symbol just lands on the chart's
  // existing "No chart data available" empty state instead of a crash.
  onSelectCoin?: (symbol: string) => void;
}

export function GlobalMarkets({ onSelectCoin }: Props = {}) {
  const [global, setGlobal]       = useState<GlobalData | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [coins, setCoins]         = useState<CoinRow[]>([]);
  // Table pagination — 250 rows (each with its own sparkline SVG) is too
  // much to mount/animate at once, same reasoning any large data table
  // paginates instead of rendering everything up front.
  const [tablePage, setTablePage] = useState(1);
  // Gainers/Losers banner — page 1 (index 0) is Gainers, page 2 (index 1)
  // is Losers, with an auto-advancing progress bar (gm-mover-banner-
  // progress-fill below) between them, same "1/2 pager + arrows" pattern
  // as a reference screenshot of a trending-stocks widget.
  const [moverPage, setMoverPage] = useState<0 | 1>(0);
  const [trending, setTrending]   = useState<TrendingCoin[]>([]);
  // Trending Coins pager — 5 per page, matching a reference screenshot of
  // a trending-coins widget (pager arrows + "x/2" + an auto-advance dot).
  const [trendingPage, setTrendingPage] = useState(0);
  const [fng, setFng]             = useState<FearGreedPoint | null>(null);
  // Full history for the mobile-only "Fear & Greed Index Chart" section
  // (Historical Values / Yearly High-Low / the chart itself) — kept
  // separate from `fng` above (which stays the cheap single-value fetch
  // the existing hero gauge uses) so that gauge doesn't wait on this much
  // bigger request.
  const [fngHistory, setFngHistory] = useState<FearGreedPoint[]>([]);
  const [fngPeriod, setFngPeriod] = useState<typeof FNG_PERIODS[number]>(FNG_PERIODS[0]);
  const [sentiment, setSentiment] = useState<SentimentCoin[]>([]);
  const [period, setPeriod]       = useState<{ label: string; days: number }>(PERIODS[1]);
  const [chartKey, setChartKey]   = useState<ChartKey>("market_caps");
  const [loading, setLoading]     = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError]         = useState("");
  // "Market Pulse" (Liquidations-style widget substitute, see LIQ_RANGES comment)
  const [liqRange, setLiqRange]   = useState<{ label: string; days: number }>(LIQ_RANGES[1]);
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
  const [mcapSeries, setMcapSeries] = useState<{ time: string; mcap: number; vol: number }[]>([]);
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

  // Same auto-advance pattern for the Trending Coins pager (5/page).
  const trendingPageCount = Math.max(1, Math.ceil(Math.min(trending.length, 10) / 5));
  useEffect(() => {
    if (trendingPageCount <= 1) return;
    const t = setTimeout(() => setTrendingPage(p => (p + 1) % trendingPageCount), 5000);
    return () => clearTimeout(t);
  }, [trendingPage, trendingPageCount]);

  // Fetch global stats + top coins (sparkline enabled) on mount
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    Promise.all([
      cgFetch<{ data: GlobalData }>("https://api.coingecko.com/api/v3/global", TTL.global),
      // 250 is CoinGecko's own hard per_page cap on this endpoint (asking
      // for more just gets silently clamped back to it) — the real "all
      // of them" within a single request.
      cgFetch<CoinRow[]>(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&price_change_percentage=7d,30d&sparkline=true",
        TTL.coins
      ),
    ])
      .then(([g, c]) => {
        if (!mountedRef.current) return;
        setGlobal(g.data);
        setCoins(c);
        setTablePage(1);
        setLoading(false);
      })
      .catch(e => {
        if (!mountedRef.current) return;
        setError(e.message ?? "Failed to load");
        setLoading(false);
      });
    return () => { mountedRef.current = false; };
  }, []);

  // Trending searched coins — its own independent fetch/failure, never
  // blocks the rest of the page (a dead trending widget shouldn't take
  // down everything else that already loaded fine).
  useEffect(() => {
    cgFetch<{ coins: { item: TrendingCoin }[] }>("https://api.coingecko.com/api/v3/search/trending", TTL.trending)
      .then(d => { if (mountedRef.current) setTrending(d.coins.map(c => c.item)); })
      .catch(() => {});
  }, []);

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

  // Community sentiment — real CoinGecko field (sentiment_votes_up/down_
  // percentage, the up/down vote widget shown on each coin's own CoinGecko
  // page), for a couple of major coins. Independent fetch/failure, same
  // reasoning as trending — never blocks the rest of the page.
  useEffect(() => {
    Promise.all(
      ["bitcoin", "ethereum", "solana"].map(id =>
        cgFetch<{
          id: string; symbol: string; name: string;
          sentiment_votes_up_percentage: number | null;
          sentiment_votes_down_percentage: number | null;
        }>(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, TTL.global)
      )
    )
      .then(rows => {
        if (!mountedRef.current) return;
        setSentiment(rows
          .filter(r => r.sentiment_votes_up_percentage != null)
          .map(r => ({ id: r.id, symbol: r.symbol, name: r.name, up: r.sentiment_votes_up_percentage!, down: r.sentiment_votes_down_percentage ?? (100 - r.sentiment_votes_up_percentage!) })));
      })
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

  // Fetch chart data when period or chartKey changes (free-tier BTC market chart)
  // Straight to CoinGecko, not through /gecko-api — same reasoning
  // coinMeta.ts/MarketHeatmap.tsx already documented: CoinGecko 403s some
  // endpoints when hit through Vercel's outbound IP but allows the
  // identical request from a real browser/device origin. Also sidesteps
  // the native-app issue the rest of this file's direct CoinGecko calls
  // (global/coins/markets/trending/sentiment) already avoid by not going
  // through a relative proxy path at all (BN_BASE in coinglass.ts documents
  // why a relative path resolves to nothing on native).
  useEffect(() => {
    setChartLoading(true);
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${period.days}`;
    cgFetch<{ prices: [number, number][]; market_caps: [number, number][]; total_volumes: [number, number][] }>(url, TTL.chart, 12_000)
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

  // Standalone "Crypto Market Cap" card's own series — CoinGecko's free
  // tier has no historical TOTAL-market-cap endpoint (/global/market_cap_
  // chart is Pro-only — verified live against the proxy, returns
  // error_code 10005 "limited to PRO API subscribers"), so this derives it
  // from the real BTC market-cap/volume series ÷ the CURRENT BTC dominance
  // fraction. An approximation, not exact (dominance drifts day to day
  // across the window), disclosed via .gm-chart-est-note below rather than
  // presented as a literal historical total — same house rule as
  // altcoinStrengthPct/marketActivity elsewhere in this file.
  useEffect(() => {
    setMcapLoading(true);
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${mcapPeriod.days}`;
    cgFetch<{ market_caps: [number, number][]; total_volumes: [number, number][] }>(url, TTL.chart, 12_000)
      .then(d => {
        const divisor = btcDomPct > 0 ? btcDomPct / 100 : 1;
        const vols = d.total_volumes ?? [];
        const pts = (d.market_caps ?? []).map(([ts, mcapVal], i) => ({
          time: fmtDate(ts, typeof mcapPeriod.days === "number" ? mcapPeriod.days : 365),
          mcap: mcapVal / divisor / 1e9,
          vol: (vols[i]?.[1] ?? 0) / divisor / 1e9,
        }));
        setMcapSeries(pts);
        setMcapLoading(false);
      })
      .catch(() => setMcapLoading(false));
  }, [mcapPeriod, btcDomPct]);

  // "Market Pulse" chart data — resample CoinGecko's raw (hourly-for-short-
  // range) BTC price series down to one point per day, then derive each
  // day's % swing from consecutive daily closes. Real, computed data, not
  // CoinGlass's actual long/short liquidation volume (unavailable).
  useEffect(() => {
    setLiqLoading(true);
    const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${liqRange.days}`;
    cgFetch<{ prices: [number, number][] }>(url, TTL.chart, 12_000)
      .then(d => {
        const raw = d.prices ?? [];
        const isHourly = liqRange.days <= 90;
        const step = isHourly ? 24 : 1;
        const daily = step > 1 ? raw.filter((_, i) => i % step === 0) : raw;
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
    <div className="gm-wrap"><SectionBanner section="markets" /><div className="gm-error">{error}</div></div>
  );

  const g = global!;
  const vol    = g.total_volume?.usd ?? 0;
  const btcDom = g.market_cap_percentage?.btc ?? 0;
  const ethDom = g.market_cap_percentage?.eth ?? 0;

  // Dominance — top 6 coins, donut chart
  const domEntries = Object.entries(g.market_cap_percentage ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const othersPct = Math.max(0, 100 - domEntries.reduce((s, [, p]) => s + p, 0));
  const pieData = [
    ...domEntries.map(([sym, pct], i) => ({ name: sym.toUpperCase(), value: pct, fill: DOM_COLORS[i] })),
    { name: "Others", value: othersPct, fill: DOM_COLORS[6] },
  ];
  // Simple 3-segment version of the same real dominance data for the
  // horizontal-bar widget (BTC / ETH / Others), matching the screenshot's
  // layout — no new fetch, same g.market_cap_percentage already used above.
  const othersDomPct = Math.max(0, 100 - btcDom - ethDom);

  // Pool of 10 each for the rotating banner to cycle through — no more
  // expand/collapse control now that the old full lists are gone.
  const gainers = [...coins].sort((a, b) => (b.price_change_percentage_24h ?? -999) - (a.price_change_percentage_24h ?? -999)).slice(0, 10);
  const losers = [...coins].sort((a, b) => (a.price_change_percentage_24h ?? 999) - (b.price_change_percentage_24h ?? 999)).slice(0, 10);

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

  const tableTotalPages = Math.max(1, Math.ceil(coins.length / TABLE_PAGE_SIZE));
  const pagedCoins = coins.slice((tablePage - 1) * TABLE_PAGE_SIZE, tablePage * TABLE_PAGE_SIZE);

  // "Altcoin Strength" — this app's own honest equivalent of
  // blockchaincenter.net's "Altcoin Season Index": there's no free public
  // JSON API for that exact index (checked), and the real methodology
  // uses a 90-day window CoinGecko's free tier doesn't offer (only
  // 1h/24h/7d/14d/30d/200d/1y) — so this is a genuinely real, from-real-
  // data computation over a 30-day window instead, labeled as such rather
  // than claiming parity with the original index's name/window.
  const btcRow = coins.find(c => c.id === "bitcoin");
  const ethRow = coins.find(c => c.id === "ethereum");
  const btc30d = btcRow?.price_change_percentage_30d_in_currency ?? 0;
  const altcoinBasket = coins.filter(c => c.id !== "bitcoin" && c.id !== "tether" && c.id !== "usd-coin").slice(0, 50);
  const altcoinsBeatingBtc = altcoinBasket.filter(c => (c.price_change_percentage_30d_in_currency ?? -999) > btc30d).length;
  const altcoinStrengthPct = altcoinBasket.length > 0 ? Math.round((altcoinsBeatingBtc / altcoinBasket.length) * 100) : null;

  // Open interest in USD — Coinalyze's base-asset-unit figures (see the `oi`
  // fetch effect above) × the real current spot price already in `coins`.
  // Per-coin (Binance perps), not a market-wide total — see the comment on
  // the `oi` state declaration for why.
  const oiStats = oi && btcRow && ethRow
    ? { btcUsd: oi.btcAmt * btcRow.current_price, ethUsd: oi.ethAmt * ethRow.current_price }
    : null;

  // "Market Activity" — real CoinGecko-sourced volume figures, standing
  // in for a Derivatives panel: CoinGlass's own derivatives endpoints
  // (open interest, liquidations) are all currently rejecting every
  // request with "Upgrade plan" (verified directly against the live
  // proxy), so this uses only sources confirmed actually working instead
  // of fabricating numbers for metrics that aren't reachable right now.
  const marketActivity = [
    { label: "Total 24h Volume", value: fmtBig(vol), icon: IC.vol },
    { label: "BTC 24h Volume", value: btcRow ? fmtBig(btcRow.total_volume) : "—", icon: IC.btc },
    { label: "Active Markets", value: g.markets?.toLocaleString() ?? "—", icon: IC.markets },
    { label: "Active Cryptocurrencies", value: g.active_cryptocurrencies?.toLocaleString() ?? "—", icon: IC.coins },
  ];

  // New 4th hero column — real CoinGecko `global` fields that were already
  // being fetched (part of the GlobalData type since this file's own
  // GlobalData interface) but never actually rendered anywhere: DeFi
  // market cap, 24h volume, and the defi_to_eth_ratio field CoinGecko
  // itself publishes. DeFi Dominance is the one derived figure here (%
  // of total market cap), same "real data, simple derivation" standard
  // as altcoinStrengthPct/othersDomPct elsewhere in this file.
  const defiMcap = Number(g.defi_market_cap) || 0;
  const defiStats = [
    { label: "DeFi Market Cap", value: fmtBig(defiMcap), icon: IC.cap },
    { label: "DeFi 24h Volume", value: fmtBig(Number(g.defi_volume_24h) || 0), icon: IC.vol },
    { label: "DeFi Dominance", value: mcap > 0 ? `${((defiMcap / mcap) * 100).toFixed(2)}%` : "—", icon: IC.markets },
    { label: "DeFi / ETH Ratio", value: g.defi_to_eth_ratio ? `${Number(g.defi_to_eth_ratio).toFixed(2)}%` : "—", icon: IC.eth },
  ];

  // Rendered twice (inline in the side-by-side grid, and again inside its
  // own portaled modal when expanded) — kept as one JSX value each so the
  // two copies can't drift apart from editing only one of them.
  const domSectionBody = (
    <>
      <div className="gm-dom-layout">
        <div className="gm-dom-donut">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={62} outerRadius={88}
                paddingAngle={2} startAngle={90} endAngle={-270} animationDuration={900} animationBegin={100} stroke="none">
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
          <span className="gm-dom-hbar-title">Bitcoin Dominance</span>
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
          <span className="gm-dom-hbar-legend-item"><span className="gm-dom-dot" style={{ background: DOM_COLORS[5] }} />Others {othersDomPct.toFixed(1)}%</span>
        </div>
      </div>
    </>
  );

  const chartSectionBody = (
    <>
      <div className="gm-section-header">
        <div className="gm-chart-tabs">
          {CHART_TABS.map(t => (
            <button key={t.key}
              className={`gm-chart-tab${chartKey === t.key ? " gm-chart-tab--active" : ""}`}
              style={chartKey === t.key ? { color: t.color, borderColor: t.color } : {}}
              onClick={() => setChartKey(t.key)}>
              {t.label}
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
      <SectionBanner section="markets" />

      {/* ── Hero: one glowing card (the original gm-hero treatment) now
          carrying the Market Status / Trending / Market Activity /
          Community columns instead of just the market-cap figure — real
          data only (no fabricated metrics — see the comments on
          altcoinStrengthPct/marketActivity above for what's genuinely
          available right now vs. what isn't). ─────────────────────────── */}
      <div className="gm-hero">
        <span className="gm-hero-glow" />
        <div className="gm-status-grid">
        {/* Trending Coins (compact) — paged 5/page, matching a reference
            screenshot's trending-widget pager (arrows + "x/N" + an
            auto-advance dot), same pattern as the Gainers/Losers banner's
            own pager below. */}
        <div className="gm-status-col">
          <div className="gm-status-col-head gm-status-col-head--trending">
            <span><span className="gm-status-col-icon">{IC.fire}</span>Trending Coins</span>
            {trendingPageCount > 1 && (
              <div className="gm-trending-pager">
                <button type="button" className="gm-mover-banner-pager-arrow" aria-label="Previous"
                  onClick={() => setTrendingPage(p => (p - 1 + trendingPageCount) % trendingPageCount)}>‹</button>
                <span className="gm-mover-banner-pager-label">{trendingPage + 1}/{trendingPageCount}</span>
                <button type="button" className="gm-mover-banner-pager-arrow" aria-label="Next"
                  onClick={() => setTrendingPage(p => (p + 1) % trendingPageCount)}>›</button>
                <span className="gm-trending-pager-dot" />
              </div>
            )}
          </div>
          <div className="gm-status-list">
            {trending.length === 0
              ? Array.from({ length: 5 }).map((_, i) => (
                  <span key={i} className="gm-skel gm-status-skel-row" style={{ animationDelay: `${i * 60}ms` }} />
                ))
              : trending.slice(0, 10).slice(trendingPage * 5, trendingPage * 5 + 5).map((t, i) => {
                  const rank = trendingPage * 5 + i + 1;
                  const tchg = t.data?.price_change_percentage_24h?.usd;
                  return (
                    <button key={t.id} type="button" className="gm-status-list-row" onClick={() => onSelectCoin?.(t.symbol.toUpperCase())}>
                      <span className={`gm-status-list-rank${rank <= 3 ? ` gm-status-list-rank--${["gold", "silver", "bronze"][rank - 1]}` : ""}`}>{rank}</span>
                      <img src={t.thumb} alt="" className="gm-status-list-img" loading="lazy" />
                      <span className="gm-status-list-sym">{t.symbol.toUpperCase()}</span>
                      <span className="gm-status-list-price">{t.data?.price != null ? fmtPrice(t.data.price) : "—"}</span>
                      {tchg != null && (
                        <span className={`gm-status-list-chg${tchg >= 0 ? " gm-pct--pos" : " gm-pct--neg"}`}>
                          {tchg >= 0 ? "▲" : "▼"} {Math.abs(tchg).toFixed(1)}%
                        </span>
                      )}
                    </button>
                  );
                })}
          </div>
        </div>

        {/* Market Activity (stands in for Derivatives — see comment above
            marketActivity: CoinGlass's own OI/liquidation endpoints are
            all currently rejecting with "Upgrade plan" on the live key,
            so this sticks to sources confirmed working instead). */}
        <div className="gm-status-col">
          <div className="gm-status-col-head"><span className="gm-status-col-icon">{IC.vol}</span>Market Activity</div>
          <div className="gm-activity-grid">
            {marketActivity.map((m, i) => (
              <div key={m.label} className="gm-activity-tile" style={{ animationDelay: `${i * 70}ms` }}>
                <span className="gm-activity-tile-icon">{m.icon}</span>
                <span className="gm-activity-tile-value">{m.value}</span>
                <span className="gm-activity-tile-label">{m.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Community (CoinGecko's own real up/down sentiment-vote field) —
            radial gauges, not flat bars, same "gauge" treatment the Fear &
            Greed meter above already uses. */}
        <div className="gm-status-col">
          <div className="gm-status-col-head"><span className="gm-status-col-icon">{IC.coins}</span>Community</div>
          <div className="gm-sentiment-grid">
            {sentiment.length === 0
              ? Array.from({ length: 3 }).map((_, i) => (
                  <span key={i} className="gm-skel gm-sentiment-skel" style={{ animationDelay: `${i * 60}ms` }} />
                ))
              : sentiment.map((s, i) => (
                  <SentimentGauge key={s.id} symbol={s.symbol.toUpperCase()} up={s.up} delay={i * 80} />
                ))}
          </div>
        </div>

        {/* DeFi — real CoinGecko `global` fields (defiStats above) that
            were already fetched but never rendered anywhere on this page. */}
        <div className="gm-status-col">
          <div className="gm-status-col-head"><span className="gm-status-col-icon">{IC.cap}</span>DeFi</div>
          <div className="gm-activity-grid">
            {defiStats.map((m, i) => (
              <div key={m.label} className="gm-activity-tile" style={{ animationDelay: `${i * 70}ms` }}>
                <span className="gm-activity-tile-icon">{m.icon}</span>
                <span className="gm-activity-tile-value">{m.value}</span>
                <span className="gm-activity-tile-label">{m.label}</span>
              </div>
            ))}
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
              <span className="gm-section-title">Fear &amp; Greed Index</span>
            </div>
            <div className="gm-fnghist-gauge-wrap">
              <FearGreedGauge value={fngValue} label={fng!.value_classification} />
            </div>
            {(fngYesterday || fngLastWeek || fngLastMonth) && (
              <div className="gm-fnghist-block">
                <div className="gm-fnghist-block-title">Historical Values</div>
                {fngYesterday && (
                  <div className="gm-fnghist-row">
                    <span>Yesterday</span>
                    <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngYesterday.value)) }}>
                      {fngYesterday.value_classification} · {fngYesterday.value}
                    </span>
                  </div>
                )}
                {fngLastWeek && (
                  <div className="gm-fnghist-row">
                    <span>Last Week</span>
                    <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngLastWeek.value)) }}>
                      {fngLastWeek.value_classification} · {fngLastWeek.value}
                    </span>
                  </div>
                )}
                {fngLastMonth && (
                  <div className="gm-fnghist-row">
                    <span>Last Month</span>
                    <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngLastMonth.value)) }}>
                      {fngLastMonth.value_classification} · {fngLastMonth.value}
                    </span>
                  </div>
                )}
              </div>
            )}
            {fngYearHigh && fngYearLow && (
              <div className="gm-fnghist-block">
                <div className="gm-fnghist-block-title">Yearly High &amp; Low</div>
                <div className="gm-fnghist-row">
                  <span>High ({new Date(Number(fngYearHigh.timestamp) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })})</span>
                  <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngYearHigh.value)) }}>
                    {fngYearHigh.value_classification} · {fngYearHigh.value}
                  </span>
                </div>
                <div className="gm-fnghist-row">
                  <span>Low ({new Date(Number(fngYearLow.timestamp) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })})</span>
                  <span className="gm-fnghist-pill" style={{ color: fngColor(Number(fngYearLow.value)) }}>
                    {fngYearLow.value_classification} · {fngYearLow.value}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="gm-section gm-fnghist-chart-card">
            <div className="gm-section-header">
              <span className="gm-section-title">Fear &amp; Greed Chart</span>
              <div className="gm-period-tabs">
                {FNG_PERIODS.map(p => (
                  <button key={p.label}
                    className={`gm-period-tab${fngPeriod.label === p.label ? " gm-period-tab--active" : ""}`}
                    onClick={() => setFngPeriod(p)}>
                    {p.label}
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
              <span className="gm-section-title">Altcoin Season <em>(30D)</em></span>
            </div>
            <div className="gm-altseason-value">{altcoinStrengthPct}<span className="gm-altseason-value-max">/100</span></div>
            <div className="gm-altseason-track">
              <span className="gm-altseason-dot" style={{ left: `${altcoinStrengthPct}%` }} />
            </div>
            <div className="gm-altseason-labels">
              <span>Bitcoin Season</span>
              <span>Altcoin Season</span>
            </div>
          </div>
        )}

        <div className="gm-section gm-mcap-card">
          <div className="gm-section-header">
            <span className="gm-section-title">Crypto Market Cap</span>
            <div className="gm-period-tabs">
              {MCAP_PERIODS.map(p => (
                <button key={p.label}
                  className={`gm-period-tab${mcapPeriod.label === p.label ? " gm-period-tab--active" : ""}`}
                  onClick={() => setMcapPeriod(p)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="gm-mcap-stats">
            <div className="gm-mcap-stat">
              <span className="gm-mcap-stat-label">Market Cap</span>
              <span className="gm-mcap-stat-value">{fmtBig(mcap)}</span>
            </div>
            <div className="gm-mcap-stat">
              <span className="gm-mcap-stat-label">Volume</span>
              <span className="gm-mcap-stat-value">{fmtBig(vol)}</span>
            </div>
          </div>
          <div className="gm-chart-est-note">Line estimated from BTC market cap ÷ current BTC dominance — not an exact historical series</div>
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
          <span className="gm-section-title">{IC.vol} Market Pulse</span>
          <span className="gm-section-sub">live CoinGecko data</span>
        </div>

        <div className="gm-liq-grid">
          <div className="gm-liq-side">
            <div className="gm-liq-stat-card">
              <div className="gm-liq-stat-label">24h Trading Volume</div>
              <div className="gm-liq-stat-value">{fmtBig(vol)}</div>
              <div className="gm-liq-stat-row">
                <span className="gm-liq-stat-row-label">Gainers</span>
                <span className="gm-liq-stat-row-value gm-pct--pos">{gainersCount}</span>
              </div>
              <div className="gm-liq-stat-row">
                <span className="gm-liq-stat-row-label">Losers</span>
                <span className="gm-liq-stat-row-value gm-pct--neg">{losersCount}</span>
              </div>
            </div>

            <div className="gm-liq-events-card">
              <div className="gm-liq-events-title">Today's Biggest Movers</div>
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
              <span className="gm-liq-chart-title">BTC Price &amp; Daily Swings</span>
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
              <span className="gm-liq-legend-item"><span className="gm-liq-dot gm-liq-dot--up" />Up day</span>
              <span className="gm-liq-legend-item"><span className="gm-liq-dot gm-liq-dot--down" />Down day</span>
              <span className="gm-liq-legend-item"><span className="gm-liq-dot gm-liq-dot--price" />Bitcoin Price</span>
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

      {/* ── Open Interest + Implied Volatility — the two screenshot widgets
          backed by a real, verified-working, free data source. See the
          `oi`/`dvol` state comments above: OI is Binance's own BTC/ETH
          perpetual OI via Coinalyze (explicitly NOT a market-wide total —
          CoinGlass's own OI endpoints still reject with "Upgrade plan" on
          the live key, re-verified), and DVOL is Deribit's own implied-
          volatility index (a real substitute for "Volmex", different
          provider, labeled as such). ─────────────────────────────────────── */}
      <div className="gm-oivol-grid">
        <div className="gm-section">
          <div className="gm-section-header">
            <span className="gm-section-title">{IC.vol} Open Interest</span>
            <span className="gm-section-sub">Binance perps, via Coinalyze — not total market</span>
          </div>
          <div className="gm-activity-grid">
            {oiStats ? (
              <>
                <div className="gm-activity-tile">
                  <span className="gm-activity-tile-icon">{IC.btc}</span>
                  <span className="gm-activity-tile-value">{fmtBig(oiStats.btcUsd)}</span>
                  <span className="gm-activity-tile-label">BTC Open Interest</span>
                </div>
                <div className="gm-activity-tile">
                  <span className="gm-activity-tile-icon">{IC.eth}</span>
                  <span className="gm-activity-tile-value">{fmtBig(oiStats.ethUsd)}</span>
                  <span className="gm-activity-tile-label">ETH Open Interest</span>
                </div>
              </>
            ) : (
              Array.from({ length: 2 }).map((_, i) => (
                <span key={i} className="gm-skel gm-skel-stat" style={{ animationDelay: `${i * 60}ms` }} />
              ))
            )}
          </div>
        </div>

        <div className="gm-section">
          <div className="gm-section-header">
            <span className="gm-section-title">{IC.cap} Implied Volatility</span>
            <span className="gm-section-sub">DVOL (Deribit)</span>
          </div>
          <div className="gm-activity-grid">
            {dvol ? (
              <>
                <div className="gm-activity-tile">
                  <span className="gm-activity-tile-icon">{IC.btc}</span>
                  <span className="gm-activity-tile-value">{dvol.btc.toFixed(1)}%</span>
                  <span className="gm-activity-tile-label">BTC DVOL</span>
                </div>
                <div className="gm-activity-tile">
                  <span className="gm-activity-tile-icon">{IC.eth}</span>
                  <span className="gm-activity-tile-value">{dvol.eth.toFixed(1)}%</span>
                  <span className="gm-activity-tile-label">ETH DVOL</span>
                </div>
              </>
            ) : (
              Array.from({ length: 2 }).map((_, i) => (
                <span key={i} className="gm-skel gm-skel-stat" style={{ animationDelay: `${i * 60}ms` }} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── Dominance donut + Chart, side by side ───────────────────────────── */}
      <div className="gm-dom-chart-grid">
        <div className="gm-section">
          <div className="gm-section-header">
            <span className="gm-section-title">Market Cap Dominance</span>
          </div>
          {domSectionBody}
        </div>

        {/* ── Chart ────────────────────────────────────────────────────────── */}
        <div className="gm-section">
          {chartSectionBody}
        </div>
      </div>

      {/* ── Top Cryptocurrencies table + Gainers/Losers banner, side by
          side: table is the wide primary column, banner a narrower
          second column next to it (vertical list now, not a horizontal
          scroll row — collapses to stacked below 900px). ──────────────── */}
      <div className="gm-table-movers-grid">
      <div className="gm-section gm-table-section">
        <div className="gm-section-header">
          <span className="gm-section-title">Top Cryptocurrencies</span>
          <span className="gm-section-sub">{coins.length.toLocaleString()} coins by market capitalization</span>
        </div>
        <div className="gm-table-wrap">
          <table className="gm-table">
            <thead>
              <tr>
                <th className="gm-th gm-th--rank">#</th>
                <th className="gm-th">Name</th>
                <th className="gm-th gm-th--r">Price</th>
                <th className="gm-th gm-th--r">24h %</th>
                <th className="gm-th gm-th--r">7d %</th>
                <th className="gm-th gm-th--c">Last 7 Days</th>
                <th className="gm-th gm-th--r">Market Cap</th>
                <th className="gm-th gm-th--r">Volume (24h)</th>
              </tr>
            </thead>
            <tbody>
              {pagedCoins.map((c, i) => {
                const chg24  = c.price_change_percentage_24h ?? 0;
                const chg7d  = c.price_change_percentage_7d_in_currency ?? 0;
                return (
                  <tr key={c.id} className="gm-tr" style={{ animationDelay: `${Math.min(i, 20) * 20}ms` }}
                    onClick={() => onSelectCoin?.(c.symbol.toUpperCase())}>
                    <td className="gm-td gm-td--rank">{c.market_cap_rank}</td>
                    <td className="gm-td gm-td--name">
                      <img src={c.image} alt={c.name} className="gm-coin-img" loading="lazy" />
                      <span className="gm-coin-name">{c.name}</span>
                      <span className="gm-coin-sym">{c.symbol.toUpperCase()}</span>
                    </td>
                    <td className="gm-td gm-td--r">{fmtPrice(c.current_price)}</td>
                    <td className={`gm-td gm-td--r gm-pct${chg24 >= 0 ? "--pos" : "--neg"}`}>
                      {chg24 >= 0 ? "▲" : "▼"} {Math.abs(chg24).toFixed(2)}%
                    </td>
                    <td className={`gm-td gm-td--r gm-pct${chg7d >= 0 ? "--pos" : "--neg"}`}>
                      {chg7d >= 0 ? "▲" : "▼"} {Math.abs(chg7d).toFixed(2)}%
                    </td>
                    <td className="gm-td gm-td--c">
                      <Sparkline data={c.sparkline_in_7d?.price} color={chg7d >= 0 ? "#22c55e" : "#fb7185"} width={80} height={24} />
                    </td>
                    <td className="gm-td gm-td--r gm-td--muted">{fmtBig(c.market_cap)}</td>
                    <td className="gm-td gm-td--r gm-td--muted">{fmtBig(c.total_volume)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="gm-pagination">
          <span className="gm-pagination-info">
            {(tablePage - 1) * TABLE_PAGE_SIZE + 1}–{Math.min(tablePage * TABLE_PAGE_SIZE, coins.length)} of {coins.length}
          </span>
          <div className="gm-pagination-controls">
            <button type="button" className="gm-page-btn" disabled={tablePage <= 1}
              onClick={() => setTablePage(p => Math.max(1, p - 1))} aria-label="Previous page">
              ‹
            </button>
            {/* First, last, current ±1 — never the full page list (could
                be 10 pages at 25/page), same "don't render 250 rows at
                once" reasoning this pagination exists for in the first
                place. Gaps show as a plain "…", not a clickable control. */}
            {Array.from({ length: tableTotalPages }, (_, idx) => idx + 1)
              .filter(p => p === 1 || p === tableTotalPages || Math.abs(p - tablePage) <= 1)
              .map((p, idx, arr) => (
                <span key={p} style={{ display: "contents" }}>
                  {idx > 0 && arr[idx - 1] !== p - 1 && <span className="gm-page-ellipsis">…</span>}
                  <button type="button" className={`gm-page-btn${p === tablePage ? " gm-page-btn--active" : ""}`}
                    onClick={() => setTablePage(p)}>
                    {p}
                  </button>
                </span>
              ))}
            <button type="button" className="gm-page-btn" disabled={tablePage >= tableTotalPages}
              onClick={() => setTablePage(p => Math.min(tableTotalPages, p + 1))} aria-label="Next page">
              ›
            </button>
          </div>
        </div>
      </div>

      {(gainers.length > 0 || losers.length > 0) && (() => {
        const list = moverPage === 0 ? gainers : losers;
        const label = moverPage === 0 ? "▲ Top Gainers" : "▼ Top Losers";
        return (
          <div className={`gm-section gm-mover-banner gm-mover-banner--${moverPage === 0 ? "gainers" : "losers"}`}>
            <div className="gm-mover-banner-top">
              <span className={`gm-section-title${moverPage === 0 ? " gm-mover-banner-title--up" : " gm-mover-banner-title--down"}`}>{label}</span>
              <div className="gm-mover-banner-pager">
                <button type="button" className="gm-mover-banner-pager-arrow" aria-label="Previous"
                  onClick={() => setMoverPage(p => (p === 0 ? 1 : 0))}>‹</button>
                <span className="gm-mover-banner-pager-label">{moverPage + 1}/2</span>
                <button type="button" className="gm-mover-banner-pager-arrow" aria-label="Next"
                  onClick={() => setMoverPage(p => (p === 0 ? 1 : 0))}>›</button>
              </div>
            </div>
            <div className="gm-mover-banner-list">
              {list.map((c, i) => (
                <button type="button" key={c.id} className="gm-mover-banner-card"
                  style={{ animationDelay: `${i * 45}ms` }}
                  onClick={() => onSelectCoin?.(c.symbol.toUpperCase())}>
                  <div className="gm-mover-banner-id">
                    <span className="gm-mover-banner-sym">{c.symbol.toUpperCase()}</span>
                    <span className="gm-mover-banner-price">{fmtPrice(c.current_price)}</span>
                    <span className="gm-mover-banner-pct">
                      {moverPage === 0 ? "▲" : "▼"} {Math.abs(c.price_change_percentage_24h ?? 0).toFixed(1)}%
                    </span>
                  </div>
                  <Sparkline data={c.sparkline_in_7d?.price} color={moverPage === 0 ? "#22c55e" : "#fb7185"} width={40} height={28} />
                </button>
              ))}
            </div>
            <div className="gm-mover-banner-progress-track">
              <span key={moverPage} className="gm-mover-banner-progress-fill" />
            </div>
          </div>
        );
      })()}
      </div>
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

function McapTooltip({ active, payload, label }: { active?: boolean; payload?: { payload: { mcap: number; vol: number } }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="gm-tooltip">
      <div className="gm-tooltip-label">{label}</div>
      <div className="gm-tooltip-value">${d.mcap.toFixed(0)}B</div>
      <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted)" }}>Vol ${d.vol.toFixed(1)}B</div>
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
