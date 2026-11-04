import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CoinRow, fmtBig, fmtPrice, Sparkline, cgFetch, TTL } from "./GlobalMarkets";
import { DEFAULT_IDS } from "./Watchlist";
import { technicalsLean } from "./CoinPageTabs";
import { useAuth } from "../contexts/AuthContext";
import { useProVisionGate, openProVisionPaywall } from "../hooks/useProVisionGate";
import { COINS } from "../services/coinglass";
import { fetchPortfolio } from "../services/paperTrading";
import { BottomSheet } from "./BottomSheet";
import "../styles/MarketSignalTable.css";

// Markets (home) coin table with a per-coin signal column. The signal is
// the same technicals read the coin page uses (oscillators + moving
// averages), run on each coin's 7-day hourly prices that CoinGecko already
// returns with the list — no extra requests.
//
// Desktop: toolbar (tabs left; Market Cap / Volume quick filters, Filters
// and Columns right), sortable headers, column picker. Phones: tabs plus a
// compact Coin · Price/24h · Signal list.

const TRENDING_URL = "https://api.coingecko.com/api/v3/search/trending";
const WATCH_KEY = "watchlistCoins_v1";
const COLS_KEY = "mstCols_v1";
const PAGE = 25;

type Tab = "all" | "watchlist" | "gainers" | "losers" | "trending";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "watchlist", label: "Watchlist" },
  { key: "gainers", label: "Gainers" },
  { key: "losers", label: "Losers" },
  { key: "trending", label: "Trending" },
];

export type Sig = { score: number; word: "Long" | "Short" | "Neutral"; tone: "bull" | "bear" | "neutral" };

// Stablecoins have no direction — no signal for them.
const STABLES = new Set(["usdt", "usdc", "dai", "fdusd", "tusd", "usde", "pyusd", "usds", "busd", "usdd", "frax", "usd1", "rlusd", "usdp", "gusd", "lusd", "susd", "eurc", "usdy", "usd0", "susde", "bsc-usd", "usdt0", "usdf"]);
const sigCache = new Map<string, { key: number; sig: Sig | null }>();
export function signalOf(c: CoinRow): Sig | null {
  const px = c.sparkline_in_7d?.price;
  if (!px || px.length < 30) return null;
  if (STABLES.has(c.symbol.toLowerCase())) return null;
  // Pegged assets that slip past the list: under 1% range over 7 days.
  const lo = Math.min(...px), hi = Math.max(...px);
  if (lo > 0 && (hi - lo) / lo < 0.01) return null;
  const key = px.length * 1e6 + px[px.length - 1];
  const hit = sigCache.get(c.id);
  if (hit && hit.key === key) return hit.sig;
  const candles = px.map((p, i) => ({ time: i * 3600, open: px[i - 1] ?? p, high: Math.max(p, px[i - 1] ?? p), low: Math.min(p, px[i - 1] ?? p), close: p }));
  const lean = technicalsLean(candles);
  const sig: Sig | null = lean
    ? {
        score: Math.round(((lean.score + 1) / 2) * 100),
        tone: lean.tone,
        word: lean.tone === "bull" ? "Long" : lean.tone === "bear" ? "Short" : "Neutral",
      }
    : null;
  sigCache.set(c.id, { key, sig });
  return sig;
}

function readWatchlist(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "null");
    return Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_IDS;
  } catch { return DEFAULT_IDS; }
}

// ── Columns (desktop) ─────────────────────────────────────────────────────
type ColKey = "h1" | "h24" | "d7" | "cap" | "vol" | "supply" | "sig" | "chart";
const COLS: { key: ColKey; label: string; w: string; info?: string }[] = [
  { key: "h1", label: "1h %", w: "72px" },
  { key: "h24", label: "24h %", w: "76px" },
  { key: "d7", label: "7d %", w: "76px" },
  { key: "cap", label: "Market Cap", w: "112px", info: "Price × circulating supply." },
  { key: "vol", label: "Volume(24h)", w: "112px", info: "Total traded value across exchanges in the last 24 hours." },
  { key: "supply", label: "Circulating Supply", w: "150px", info: "Coins in public hands right now." },
  { key: "sig", label: "Signal", w: "196px", info: "Technicals read (moving averages + oscillators) on 7 days of hourly prices. 0 = strong sell, 100 = strong buy." },
  { key: "chart", label: "Last 7 Days", w: "116px" },
];
const ALL_COLS = COLS.map((c) => c.key);
function readCols(): ColKey[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLS_KEY) ?? "null");
    if (Array.isArray(v)) return ALL_COLS.filter((k) => v.includes(k));
  } catch { /* ignore */ }
  return ALL_COLS;
}

type SortKey = "rank" | "name" | "price" | ColKey;
const sortVal = (c: CoinRow, k: SortKey): number | string | null => {
  switch (k) {
    case "rank": return c.market_cap_rank ?? null;
    case "name": return c.name.toLowerCase();
    case "price": return c.current_price;
    case "h1": return c.price_change_percentage_1h_in_currency ?? null;
    case "h24": return c.price_change_percentage_24h ?? null;
    case "d7": return c.price_change_percentage_7d_in_currency ?? null;
    case "cap": return c.market_cap;
    case "vol": return c.total_volume;
    case "supply": return c.circulating_supply ?? null;
    case "sig": return signalOf(c)?.score ?? null;
    case "chart": return c.price_change_percentage_7d_in_currency ?? null;
  }
};

// ── Quick filters ─────────────────────────────────────────────────────────
type Range = { label: string; min: number; max: number };
const CAP_RANGES: Range[] = [
  { label: "Any", min: 0, max: Infinity },
  { label: "$10B+", min: 1e10, max: Infinity },
  { label: "$1B – $10B", min: 1e9, max: 1e10 },
  { label: "$100M – $1B", min: 1e8, max: 1e9 },
  { label: "Under $100M", min: 0, max: 1e8 },
];
const VOL_RANGES: Range[] = [
  { label: "Any", min: 0, max: Infinity },
  { label: "$1B+", min: 1e9, max: Infinity },
  { label: "$100M – $1B", min: 1e8, max: 1e9 },
  { label: "$10M – $100M", min: 1e7, max: 1e8 },
  { label: "Under $10M", min: 0, max: 1e7 },
];
type SigFilter = "any" | "long" | "short" | "neutral";
type ChgFilter = "any" | "up" | "down";

const fmtSupply = (n: number | null | undefined, sym: string) => {
  if (n == null || !isFinite(n)) return "—";
  const s = n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0);
  return `${s} ${sym}`;
};
const pctCell = (v: number | null | undefined) => {
  if (v == null || !isFinite(v)) return <span className="mst-muted">—</span>;
  return <span className={v >= 0 ? "mst-up" : "mst-dn"}>{v >= 0 ? "▲" : "▼"} {Math.abs(v).toFixed(2)}%</span>;
};

const FunnelIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 3H2l8 9.46V19l4 2v-8.54z" /></svg>
);
const InfoIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
);
const SortIcon = ({ dir }: { dir: "asc" | "desc" | null }) => (
  <svg className={`mst-sort-ic${dir ? ` mst-sort-ic--${dir}` : ""}`} width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
    <path d="M4 1 7 5H1z" className="up" />
    <path d="M4 11 1 7h6z" className="down" />
  </svg>
);

// Small anchored popover: a toolbar button + its panel, closes on outside tap.
function Pop({ label, icon, active, children, align = "right", wide }: { label: ReactNode; icon?: ReactNode; active?: boolean; children: (close: () => void) => ReactNode; align?: "left" | "right"; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="mst-pop" ref={ref}>
      <button
        type="button"
        className={`mst-tool${active ? " mst-tool--on" : ""}${open ? " mst-tool--open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {label}
      </button>
      {open && (
        <div className={`mst-pop-panel mst-pop-panel--${align}${wide ? " mst-pop-panel--wide" : ""}`} role="dialog">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

interface Props {
  coins: CoinRow[];
  onSelectCoin?: (symbol: string) => void;
  onOpenAuth?: () => void;
  // Opens this coin's paper-trading ticket (#trade, paper mode).
  onTradeCoin?: (symbol: string) => void;
}

// Logged out: signals on the first few rows only, the rest invite sign-up.
const FREE_ROWS = 3;
// Signed in without a ProVision plan: a "ProVision ›" link on the top rows
// whose coin the chart supports (where ProVision actually runs).
const PV_ROWS = 10;
const PV_COINS = new Set(COINS.map((c) => c.symbol.toUpperCase()));

export function MarketSignalTable({ coins, onSelectCoin, onOpenAuth, onTradeCoin }: Props) {
  const { user } = useAuth();
  // Paper trading activated = signed in and accepted the one-time
  // disclaimer (same flag PaperTradingCard checks).
  const [paperOn, setPaperOn] = useState(false);
  useEffect(() => {
    if (!user) { setPaperOn(false); return; }
    let alive = true;
    fetchPortfolio(user.id)
      .then((p) => { if (alive) setPaperOn(!!p.consentAcceptedAt); })
      .catch(() => { if (alive) setPaperOn(false); });
    return () => { alive = false; };
  }, [user]);
  // Logged out → sign in/up. Signed in → the coin's paper ticket (not yet
  // activated users land on the one-tap activation banner there).
  const trade = (sym: string) => {
    if (!user) { onOpenAuth?.(); return; }
    onTradeCoin?.(sym);
  };
  const pv = useProVisionGate();
  const pvUpsell = !!user && pv.access.mode !== "unlimited";
  const openPv = (sym: string) => {
    onSelectCoin?.(sym);
    const reason = pv.access.lockReason(sym);
    if (reason) openProVisionPaywall({ reason, coin: sym });
    else pv.setOn(true);
  };

  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = localStorage.getItem("mstTab");
      return (TABS.some((t) => t.key === v) ? v : "all") as Tab;
    } catch { return "all"; }
  });
  const [shown, setShown] = useState(PAGE);
  const [watched, setWatched] = useState<string[]>(readWatchlist);
  const [trendingIds, setTrendingIds] = useState<string[] | null>(null);
  const [cols, setCols] = useState<ColKey[]>(readCols);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "rank", dir: "asc" });
  const [capIdx, setCapIdx] = useState(0);
  const [volIdx, setVolIdx] = useState(0);
  const [sigF, setSigF] = useState<SigFilter>("any");
  const [chgF, setChgF] = useState<ChgFilter>("any");
  const [hideStables, setHideStables] = useState(false);
  // Phones: Filters / Columns open as bottom sheets.
  const [sheet, setSheet] = useState<null | "filters" | "columns">(null);
  const setSheetOpen = (open: boolean) => setSheet(open ? "filters" : null);

  useEffect(() => {
    try { localStorage.setItem("mstTab", tab); } catch { /* ignore */ }
    setShown(PAGE);
  }, [tab]);
  useEffect(() => { setShown(PAGE); }, [capIdx, volIdx, sigF, chgF, hideStables, sort.key, sort.dir]);
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch { /* ignore */ }
  }, [cols]);
  useEffect(() => {
    const sync = () => setWatched(readWatchlist());
    window.addEventListener("watchlist-add", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("watchlist-add", sync); window.removeEventListener("storage", sync); };
  }, []);
  useEffect(() => {
    if (tab !== "trending" || trendingIds) return;
    cgFetch<{ coins: { item: { id: string } }[] }>(TRENDING_URL, TTL.trending)
      .then((r) => setTrendingIds(r.coins.map((c) => c.item.id)))
      .catch(() => setTrendingIds([]));
  }, [tab, trendingIds]);

  // Signal filter/sort would reveal locked rows' reads when logged out.
  const sigOpen = !!user;

  const list = useMemo(() => {
    let out: CoinRow[];
    if (tab === "all") out = coins;
    else if (tab === "watchlist") out = coins.filter((c) => watched.includes(c.id));
    else if (tab === "trending") {
      out = trendingIds ? trendingIds.map((id) => coins.find((c) => c.id === id)).filter((c): c is CoinRow => !!c) : [];
    } else {
      const withChg = coins.filter((c) => c.price_change_percentage_24h != null);
      out = tab === "gainers"
        ? withChg.filter((c) => c.price_change_percentage_24h! > 0).sort((a, b) => b.price_change_percentage_24h! - a.price_change_percentage_24h!)
        : withChg.filter((c) => c.price_change_percentage_24h! < 0).sort((a, b) => a.price_change_percentage_24h! - b.price_change_percentage_24h!);
    }
    const cap = CAP_RANGES[capIdx], vol = VOL_RANGES[volIdx];
    out = out.filter((c) => {
      if (c.market_cap < cap.min || c.market_cap >= cap.max) return false;
      if (c.total_volume < vol.min || c.total_volume >= vol.max) return false;
      const chg = c.price_change_percentage_24h ?? 0;
      if (chgF === "up" && chg <= 0) return false;
      if (chgF === "down" && chg >= 0) return false;
      if (hideStables && STABLES.has(c.symbol.toLowerCase())) return false;
      if (sigOpen && sigF !== "any") {
        const s = signalOf(c);
        if (!s) return false;
        if (sigF === "long" && s.tone !== "bull") return false;
        if (sigF === "short" && s.tone !== "bear") return false;
        if (sigF === "neutral" && s.tone !== "neutral") return false;
      }
      return true;
    });
    // Gainers/Losers/Trending keep their own order until a header is tapped.
    const tabOrder = tab === "gainers" || tab === "losers" || tab === "trending";
    if (tabOrder && sort.key === "rank" && sort.dir === "asc") return out;
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...out].sort((a, b) => {
      const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * mul;
    });
  }, [coins, tab, watched, trendingIds, capIdx, volIdx, chgF, hideStables, sigF, sigOpen, sort]);

  const toggleWatch = (id: string) => {
    setWatched((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try { localStorage.setItem(WATCH_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  const onSort = (key: SortKey) => {
    if (key === "sig" && !sigOpen) return;
    setSort((s) => s.key === key
      ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key, dir: key === "rank" || key === "name" ? "asc" : "desc" });
  };

  const visible = COLS.filter((c) => cols.includes(c.key));
  // Rank, name and Trade are fixed (Trade sits right beside the name); the
  // number columns share whatever width is left. Below the summed minimum
  // the table scrolls sideways instead of clipping the last column.
  // # · Name · Trade · Price · …  Name gets 1.6 shares, Trade a fixed 72px.
  const fixed = [72, 72];
  const flex = [{ w: "200px", fr: 1.6 }, { w: "100px", fr: 1 }, ...visible.map((c) => ({ w: c.w, fr: 1 }))];
  // Number columns keep fixed widths (packed close together); any spare
  // width goes to the Name column, as on CoinMarketCap.
  const gridCols = ["72px", "minmax(200px, 1fr)", "72px", ...flex.slice(1).map((c) => `${parseInt(c.w, 10) + 12}px`)].join(" ");
  const GAP = 16;
  const minW = fixed.reduce((a, n) => a + n, 0) + flex.reduce((a, c) => a + parseInt(c.w, 10), 0) + GAP * (fixed.length + flex.length - 1) + 24;
  // Phones: same table, tighter fixed columns; it scrolls sideways with
  // star · # · Name pinned on the left (CoinMarketCap's mobile table).
  const gridColsM = ["58px", "128px", "56px", "76px", ...visible.map((c) => c.w)].join(" ");
  const has = (k: ColKey) => cols.includes(k);
  const extraFilters = (sigF !== "any" ? 1 : 0) + (chgF !== "any" ? 1 : 0) + (hideStables ? 1 : 0);
  const anyFilter = capIdx > 0 || volIdx > 0 || extraFilters > 0;
  const resetFilters = () => { setCapIdx(0); setVolIdx(0); setSigF("any"); setChgF("any"); setHideStables(false); };

  const rows = list.slice(0, shown);

  // Signal / 24h change / stablecoins — shared by the desktop Filters
  // popover and the phone sheet (which also gets the ranges + sort).
  const filtersBody = (inSheet: boolean) => (
    <div className={`mst-filters${inSheet ? " mst-filters--sheet" : ""}`}>
      <div className="mst-f-row">
        <span className="mst-f-label">Signal</span>
        {sigOpen
          ? seg<SigFilter>(sigF, setSigF, [{ v: "any", label: "Any" }, { v: "long", label: "Long" }, { v: "neutral", label: "Neutral" }, { v: "short", label: "Short" }])
          : (
            <button type="button" className="mst-f-signup" onClick={() => { setSheetOpen(false); onOpenAuth?.(); }}>
              Sign up to filter by signal ›
            </button>
          )}
      </div>
      <div className="mst-f-row">
        <span className="mst-f-label">24h change</span>
        {seg<ChgFilter>(chgF, setChgF, [{ v: "any", label: "Any" }, { v: "up", label: "Up" }, { v: "down", label: "Down" }])}
      </div>
      <label className="mst-f-check">
        <input type="checkbox" checked={hideStables} onChange={(e) => setHideStables(e.target.checked)} />
        Hide stablecoins
      </label>
      {!inSheet && (
        <div className="mst-f-foot">
          <button type="button" className="mst-f-reset" onClick={resetFilters} disabled={!anyFilter}>Reset all</button>
        </div>
      )}
    </div>
  );
  const SORTS: { key: SortKey; label: string }[] = [
    { key: "rank", label: "Rank" },
    { key: "price", label: "Price" },
    { key: "h24", label: "24h change" },
    { key: "cap", label: "Market cap" },
    { key: "vol", label: "Volume" },
    ...(sigOpen ? [{ key: "sig" as SortKey, label: "Signal" }] : []),
  ];
  const chips = (ranges: Range[], idx: number, set: (i: number) => void) => (
    <div className="mst-chips">
      {ranges.map((r, i) => (
        <button key={r.label} type="button" className={`mst-chip${i === idx ? " mst-chip--on" : ""}`} onClick={() => set(i)}>
          {r.label}
        </button>
      ))}
    </div>
  );
  // A function (not a const element): it uses `seg`, defined further down.
  const phoneSheet = () => (
    <>
    <BottomSheet open={sheet === "columns"} onClose={() => setSheet(null)} title="Columns" ariaLabel="Columns">
      <div className="mst-sheet">
        <div className="mst-sheet-checks">
          {COLS.map((c) => (
            <label key={c.key} className="mst-sheet-check">
              <span>{c.label}</span>
              <input
                type="checkbox"
                checked={has(c.key)}
                onChange={() => setCols((prev) => prev.includes(c.key) ? prev.filter((k) => k !== c.key) : ALL_COLS.filter((k) => k === c.key || prev.includes(k)))}
              />
            </label>
          ))}
        </div>
        <div className="mst-sheet-foot">
          <button type="button" className="mst-sheet-reset" onClick={() => setCols(ALL_COLS)} disabled={cols.length === ALL_COLS.length}>Show all</button>
          <button type="button" className="mst-sheet-done" onClick={() => setSheet(null)}>Done</button>
        </div>
      </div>
    </BottomSheet>
    <BottomSheet open={sheet === "filters"} onClose={() => setSheet(null)} title="Filters & sort" ariaLabel="Filters and sort">
      <div className="mst-sheet">
        <div className="mst-f-row">
          <span className="mst-f-label">Sort by</span>
          <div className="mst-chips">
            {SORTS.map((s) => {
              const on = sort.key === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  className={`mst-chip${on ? " mst-chip--on" : ""}`}
                  onClick={() => onSort(s.key)}
                >
                  {s.label}{on ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mst-f-row">
          <span className="mst-f-label">Market cap</span>
          {chips(CAP_RANGES, capIdx, setCapIdx)}
        </div>
        <div className="mst-f-row">
          <span className="mst-f-label">Volume (24h)</span>
          {chips(VOL_RANGES, volIdx, setVolIdx)}
        </div>
        {filtersBody(true)}
        <div className="mst-sheet-foot">
          <button
            type="button"
            className="mst-sheet-reset"
            onClick={() => { resetFilters(); setSort({ key: "rank", dir: "asc" }); }}
            disabled={!anyFilter && sort.key === "rank" && sort.dir === "asc"}
          >
            Reset
          </button>
          <button type="button" className="mst-sheet-done" onClick={() => setSheetOpen(false)}>
            Show {list.length.toLocaleString()} coins
          </button>
        </div>
      </div>
    </BottomSheet>
    </>
  );
  const loading = coins.length === 0;

  const head = (key: SortKey, label: string, opts?: { info?: string; left?: boolean }) => {
    const dir = sort.key === key ? sort.dir : null;
    const disabled = key === "sig" && !sigOpen;
    return (
      <button
        type="button"
        className={`mst-h${opts?.left ? " mst-h--left" : ""}${dir ? " mst-h--on" : ""}`}
        onClick={() => onSort(key)}
        disabled={disabled}
        aria-label={`Sort by ${label}`}
      >
        {opts?.info && <span className="mst-info" title={opts.info}><InfoIcon /></span>}
        <span>{label}</span>
        {!disabled && <SortIcon dir={dir} />}
      </button>
    );
  };

  const rangeMenu = (ranges: Range[], idx: number, set: (i: number) => void) => (close: () => void) => (
    <div className="mst-menu" role="listbox">
      {ranges.map((r, i) => (
        <button
          key={r.label}
          type="button"
          role="option"
          aria-selected={i === idx}
          className={`mst-menu-item${i === idx ? " mst-menu-item--on" : ""}`}
          onClick={() => { set(i); close(); }}
        >
          {r.label}
          {i === idx && <span aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>
  );
  const seg = <T extends string>(value: T, set: (v: T) => void, opts: { v: T; label: string }[]) => (
    <div className="mst-seg">
      {opts.map((o) => (
        <button key={o.v} type="button" className={`mst-seg-btn${value === o.v ? " mst-seg-btn--on" : ""}`} onClick={() => set(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <section className="mst" aria-label="Markets" style={{ ["--mst-cols" as string]: gridCols, ["--mst-cols-m" as string]: gridColsM, ["--mst-min" as string]: `${minW}px` }}>
      <div className="mst-head">
        <div className="mst-title">
          <h3>Cryptocurrencies</h3>
          <span>{loading ? "Loading…" : `${list.length.toLocaleString()} coins`}</span>
        </div>
        <div className="mst-bar">
          <nav className="mst-tabs" aria-label="Market filters">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`mst-tab${tab === t.key ? " mst-tab--on" : ""}`}
                aria-pressed={tab === t.key}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="mst-tools">
            <Pop label={capIdx ? `Market Cap: ${CAP_RANGES[capIdx].label}` : "Market Cap"} icon={<FunnelIcon />} active={capIdx > 0}>
              {rangeMenu(CAP_RANGES, capIdx, setCapIdx)}
            </Pop>
            <Pop label={volIdx ? `Volume: ${VOL_RANGES[volIdx].label}` : "Volume(24h)"} icon={<FunnelIcon />} active={volIdx > 0}>
              {rangeMenu(VOL_RANGES, volIdx, setVolIdx)}
            </Pop>
            <Pop
              label={<>Filters{extraFilters > 0 && <span className="mst-badge">{extraFilters}</span>}</>}
              icon={<FunnelIcon />}
              active={extraFilters > 0}
              wide
            >
              {() => filtersBody(false)}
            </Pop>
            <Pop
              label="Columns"
              icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></svg>}
              active={cols.length < ALL_COLS.length}
            >
              {() => (
                <div className="mst-menu">
                  {COLS.map((c) => (
                    <label key={c.key} className="mst-menu-item mst-menu-check">
                      <input
                        type="checkbox"
                        checked={has(c.key)}
                        onChange={() => setCols((prev) => prev.includes(c.key) ? prev.filter((k) => k !== c.key) : ALL_COLS.filter((k) => k === c.key || prev.includes(k)))}
                      />
                      {c.label}
                    </label>
                  ))}
                  <button type="button" className="mst-menu-reset" onClick={() => setCols(ALL_COLS)}>Show all</button>
                </div>
              )}
            </Pop>
          </div>
        </div>
      </div>

      {/* Phones: two full-width buttons under the tabs (CoinMarketCap style). */}
      <div className="mst-mtools">
        <button type="button" className={`mst-mtool${anyFilter || sort.key !== "rank" ? " mst-mtool--on" : ""}`} onClick={() => setSheet("filters")}>
          <FunnelIcon />
          Filters
          {(capIdx > 0 ? 1 : 0) + (volIdx > 0 ? 1 : 0) + extraFilters > 0 && (
            <span className="mst-badge">{(capIdx > 0 ? 1 : 0) + (volIdx > 0 ? 1 : 0) + extraFilters}</span>
          )}
        </button>
        <button type="button" className={`mst-mtool${cols.length < ALL_COLS.length ? " mst-mtool--on" : ""}`} onClick={() => setSheet("columns")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /></svg>
          Columns
        </button>
      </div>

      <div className="mst-scroll">
        <div className="mst-th" role="row">
          <span className="mst-c-rank">{head("rank", "#")}</span>
          <span className="mst-c-coin">{head("name", "Name", { left: true })}</span>
          <span className="mst-c-trade"><span className="mst-h mst-h--static mst-h--center">Trade</span></span>
          <span className="mst-c-px">
            {head("price", "Price")}
          </span>
          {visible.map((c) => (
            <span key={c.key} className={`mst-c-${c.key}`}>
              {c.key === "chart" ? <span className="mst-h mst-h--static">{c.label}</span> : head(c.key, c.label, { info: c.info })}
            </span>
          ))}
        </div>

        {loading && Array.from({ length: 8 }, (_, i) => <div key={i} className="mst-skel" style={{ animationDelay: `${i * 60}ms` }} />)}
        {!loading && rows.length === 0 && (
          <div className="mst-empty">
            {tab === "watchlist" && !anyFilter ? "No coins in your watchlist yet — tap ☆ on any coin to add it." : "No coins match these filters."}
            {anyFilter && <button type="button" className="mst-f-reset" onClick={resetFilters}>Reset filters</button>}
          </div>
        )}

        {rows.map((c, i) => {
          const chg = c.price_change_percentage_24h ?? 0;
          const chg7 = c.price_change_percentage_7d_in_currency ?? 0;
          const locked = !user && i >= FREE_ROWS;
          const s = locked ? null : signalOf(c);
          const sym = c.symbol.toUpperCase();
          const pvLink = pvUpsell && i < PV_ROWS && PV_COINS.has(sym) && !!s;
          const on = watched.includes(c.id);
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              className="mst-row"
              onClick={() => onSelectCoin?.(sym)}
              onKeyDown={(e) => { if (e.key === "Enter") onSelectCoin?.(sym); }}
            >
              <span className="mst-c-rank">
                <button
                  type="button"
                  className={`mst-star${on ? " on" : ""}`}
                  aria-label={on ? `Remove ${c.name} from watchlist` : `Add ${c.name} to watchlist`}
                  onClick={(e) => { e.stopPropagation(); toggleWatch(c.id); }}
                >
                  {on ? "★" : "☆"}
                </button>
                <span className="mst-rank-n">{c.market_cap_rank ?? "—"}</span>
              </span>
              <span className="mst-c-coin">
                <img src={c.image} alt="" className="mst-logo" loading="lazy" />
                <span className="mst-names">
                  <span className="mst-name">{c.name}</span>
                  <span className="mst-sym">
                    {sym}
                    <span className="mst-sym-spark">
                      <Sparkline data={c.sparkline_in_7d?.price?.slice(-48)} color={chg >= 0 ? "#22c55e" : "#fb7185"} width={44} height={14} />
                    </span>
                  </span>
                </span>
              </span>
              <span className="mst-c-trade">
                {PV_COINS.has(sym) ? (
                  <button
                    type="button"
                    className={`mst-trade${paperOn ? " mst-trade--on" : ""}`}
                    title={!user ? "Sign in to paper trade" : paperOn ? `Paper trade ${sym}` : "Activate paper trading"}
                    onClick={(e) => { e.stopPropagation(); trade(sym); }}
                  >
                    Trade
                  </button>
                ) : (
                  <span className="mst-muted" title="Not available for paper trading yet">—</span>
                )}
              </span>
              <span className="mst-c-px">
                <b>{fmtPrice(c.current_price)}</b>
              </span>
              {has("h1") && <span className="mst-c-h1 mst-num">{pctCell(c.price_change_percentage_1h_in_currency)}</span>}
              {has("h24") && <span className="mst-c-h24 mst-num">{pctCell(c.price_change_percentage_24h)}</span>}
              {has("d7") && <span className="mst-c-d7 mst-num">{pctCell(c.price_change_percentage_7d_in_currency)}</span>}
              {has("cap") && <span className="mst-c-cap mst-num">{fmtBig(c.market_cap)}</span>}
              {has("vol") && <span className="mst-c-vol mst-num">{fmtBig(c.total_volume)}</span>}
              {has("supply") && (
                <span className="mst-c-supply mst-num">
                  {fmtSupply(c.circulating_supply, sym)}
                  {c.max_supply && c.circulating_supply ? (
                    <span className="mst-supply-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, (c.circulating_supply / c.max_supply) * 100)}%` }} /></span>
                  ) : null}
                </span>
              )}
              {has("sig") && (
                <span className={`mst-c-sig mst-sig--${s?.tone ?? "none"}`}>
                  {locked ? (
                    <button
                      type="button"
                      className="mst-lock"
                      onClick={(e) => { e.stopPropagation(); onOpenAuth?.(); }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
                      Sign up
                    </button>
                  ) : s ? (
                    <>
                      <span className="mst-sig-word">{s.word} <b>{s.score}</b></span>                      <span className="mst-sig-bar" aria-hidden="true"><i style={{ left: `${s.score}%` }} /></span>
                      {pvLink && (
                        <button
                          type="button"
                          className="mst-pv"
                          onClick={(e) => { e.stopPropagation(); openPv(sym); }}
                        >
                          ProVision ›
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="mst-sig-word">—</span>
                  )}
                </span>
              )}
              {has("chart") && (
                <span className="mst-c-chart">
                  <Sparkline data={c.sparkline_in_7d?.price} color={chg7 >= 0 ? "#16c784" : "#ea3943"} width={84} height={30} />
                </span>
              )}
            </div>
          );
        })}
      </div>

      {phoneSheet()}
      {list.length > shown && (
        <button type="button" className="mst-more" onClick={() => setShown((n) => n + PAGE)}>
          Show more
        </button>
      )}
    </section>
  );
}
