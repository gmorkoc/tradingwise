import { useState, useEffect, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid
} from "recharts";
import "../styles/GlobalMarkets.css";

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
  market_cap: number; total_volume: number;
}

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
const TTL = { global: 60_000, chart: 120_000, coins: 90_000 };

async function cgFetch<T>(url: string, ttl: number): Promise<T> {
  const now = Date.now();
  if (cache[url] && now - cache[url].ts < ttl) return cache[url].data as T;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cache[url] = { data, ts: now };
  return data as T;
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

// ── Stat Card ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div className="gm-stat-card">
      <div className="gm-stat-label">{label}</div>
      <div className="gm-stat-value">{value}</div>
      {sub && <div className="gm-stat-sub" style={{ color: subColor }}>{sub}</div>}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export function GlobalMarkets() {
  const [global, setGlobal]       = useState<GlobalData | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [coins, setCoins]         = useState<CoinRow[]>([]);
  const [period, setPeriod]       = useState<{ label: string; days: number }>(PERIODS[1]);
  const [chartKey, setChartKey]   = useState<ChartKey>("market_caps");
  const [loading, setLoading]     = useState(true);
  const [chartLoading, setChartLoading] = useState(false);
  const [error, setError]         = useState("");
  const mountedRef = useRef(true);

  // Fetch global stats + top coins on mount
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    Promise.all([
      cgFetch<{ data: GlobalData }>("https://api.coingecko.com/api/v3/global", TTL.global),
      cgFetch<CoinRow[]>(
        "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&price_change_percentage=7d",
        TTL.coins
      ),
    ])
      .then(([g, c]) => {
        if (!mountedRef.current) return;
        setGlobal(g.data);
        setCoins(c);
        setLoading(false);
      })
      .catch(e => {
        if (!mountedRef.current) return;
        setError(e.message ?? "Failed to load");
        setLoading(false);
      });
    return () => { mountedRef.current = false; };
  }, []);

  // Fetch chart data when period or chartKey changes (free-tier BTC market chart)
  useEffect(() => {
    setChartLoading(true);
    const url = `/gecko-api/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${period.days}`;
    cgFetch<{ prices: [number, number][]; market_caps: [number, number][]; total_volumes: [number, number][] }>(url, TTL.chart)
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

  const activeTab = CHART_TABS.find(t => t.key === chartKey)!;

  if (loading) return (
    <div className="gm-wrap">
      <div className="gm-loading"><div className="gm-spinner" /> Loading global market data…</div>
    </div>
  );
  if (error) return (
    <div className="gm-wrap"><div className="gm-error">{error}</div></div>
  );

  const g = global!;
  const mcap   = g.total_market_cap?.usd ?? 0;
  const vol    = g.total_volume?.usd ?? 0;
  const btcDom = g.market_cap_percentage?.btc ?? 0;
  const ethDom = g.market_cap_percentage?.eth ?? 0;
  const chg24h = g.market_cap_change_percentage_24h_usd ?? 0;

  // Dominance bar — top 5 coins
  const domEntries = Object.entries(g.market_cap_percentage ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const domColors = ["#f7931a","#627eea","#9945ff","#00bcd4","#f3ba2f","#94a3b8"];

  return (
    <div className="gm-wrap">
      <div className="gm-header">
        <h2 className="gm-title">Global Crypto Market</h2>
        <p className="gm-subtitle">Real-time global market data · Updated every minute</p>
      </div>

      {/* ── Stat cards ──────────────────────────────────────────────────────── */}
      <div className="gm-stats-grid">
        <StatCard
          label="Total Market Cap"
          value={fmtBig(mcap)}
          sub={`${chg24h >= 0 ? "▲" : "▼"} ${Math.abs(chg24h).toFixed(2)}% (24h)`}
          subColor={chg24h >= 0 ? "#22c55e" : "#fb7185"}
        />
        <StatCard label="24h Volume"              value={fmtBig(vol)} />
        <StatCard label="BTC Dominance"           value={`${btcDom.toFixed(1)}%`} />
        <StatCard label="ETH Dominance"           value={`${ethDom.toFixed(1)}%`} />
        <StatCard label="Active Cryptocurrencies" value={g.active_cryptocurrencies?.toLocaleString() ?? "—"} />
        <StatCard label="Active Markets"          value={g.markets?.toLocaleString() ?? "—"} />
      </div>

      {/* ── Dominance bar ──────────────────────────────────────────────────── */}
      <div className="gm-section">
        <div className="gm-section-header">
          <span className="gm-section-title">Market Cap Dominance</span>
        </div>
        <div className="gm-dom-bar">
          {domEntries.map(([sym, pct], i) => (
            <div key={sym} className="gm-dom-seg"
              style={{ width: `${pct}%`, background: domColors[i] ?? "#94a3b8" }}
              title={`${sym.toUpperCase()}: ${pct.toFixed(1)}%`} />
          ))}
          <div className="gm-dom-seg gm-dom-seg--other"
            style={{ flex: 1 }}
            title="Others" />
        </div>
        <div className="gm-dom-legend">
          {domEntries.map(([sym, pct], i) => (
            <div key={sym} className="gm-dom-legend-item">
              <span className="gm-dom-dot" style={{ background: domColors[i] }} />
              <span className="gm-dom-sym">{sym.toUpperCase()}</span>
              <span className="gm-dom-pct">{pct.toFixed(1)}%</span>
            </div>
          ))}
          <div className="gm-dom-legend-item">
            <span className="gm-dom-dot" style={{ background: "#94a3b8" }} />
            <span className="gm-dom-sym">Others</span>
            <span className="gm-dom-pct">
              {(100 - domEntries.reduce((s, [, p]) => s + p, 0)).toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      {/* ── Chart ──────────────────────────────────────────────────────────── */}
      <div className="gm-section">
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
          {chartLoading && <div className="gm-chart-loading"><div className="gm-spinner" /></div>}
          {!chartLoading && chartData.length > 0 && (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gmGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={activeTab.color} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={activeTab.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
                  tickLine={false} axisLine={false}
                  interval={Math.floor(chartData.length / 6)} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
                  tickLine={false} axisLine={false} width={52}
                  tickFormatter={v => `$${v >= 1000 ? `${(v/1000).toFixed(0)}T` : `${v.toFixed(0)}B`}`} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="value" stroke={activeTab.color} strokeWidth={1.8}
                  fill="url(#gmGrad)" dot={false} activeDot={{ r: 4, fill: activeTab.color }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Top 50 coins table ─────────────────────────────────────────────── */}
      <div className="gm-section">
        <div className="gm-section-header">
          <span className="gm-section-title">Top Cryptocurrencies</span>
          <span className="gm-section-sub">by market capitalization</span>
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
                <th className="gm-th gm-th--r">Market Cap</th>
                <th className="gm-th gm-th--r">Volume (24h)</th>
              </tr>
            </thead>
            <tbody>
              {coins.map(c => {
                const chg24  = c.price_change_percentage_24h ?? 0;
                const chg7d  = c.price_change_percentage_7d_in_currency ?? 0;
                return (
                  <tr key={c.id} className="gm-tr">
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
                    <td className="gm-td gm-td--r gm-td--muted">{fmtBig(c.market_cap)}</td>
                    <td className="gm-td gm-td--r gm-td--muted">{fmtBig(c.total_volume)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="gm-disclaimer">Data from CoinGecko · Updated every 60s · Not financial advice</p>
    </div>
  );
}
