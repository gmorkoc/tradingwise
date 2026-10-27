import { useEffect, useMemo, useRef, useState } from "react";
import { CoinRow, TABLE_PAGE_SIZE, fmtBig, fmtPrice, Sparkline, cgFetch, TTL } from "./GlobalMarkets";
import { DEFAULT_IDS } from "./Watchlist";
import "../styles/GlobalMarkets.css";
import "../styles/TopCryptoTable.css";
import { useSort, SortTh } from "./SortableTh";

// "Top Cryptocurrencies" table — shared by the Markets page (GlobalMarkets,
// which passes the coins it already fetched) and the Chart page (no
// `coins` prop: fetches the exact same CoinGecko request itself, served
// from GlobalMarkets' cgFetch cache when Markets loaded it recently).

const COINS_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&price_change_percentage=7d,30d,1y&sparkline=true";

const TRENDING_URL = "https://api.coingecko.com/api/v3/search/trending";
const WATCH_KEY = "watchlistCoins_v1";

// Filter dropdown (opt-in via `filterable`, Chart page). Watchlist reads
// the same localStorage list Watchlist.tsx keeps (CoinGecko ids).
export type Filter = "all" | "watchlist" | "gainers" | "losers" | "trending";
export const FILTERS: { key: Filter; label: string; icon: JSX.Element }[] = [
  { key: "all", label: "All coins", icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
  ) },
  { key: "watchlist", label: "Watchlist", icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6.6 7 .7-5.3 4.7 1.6 7L12 17.3 5.7 21l1.6-7L2 9.3l7-.7z" /></svg>
  ) },
  { key: "gainers", label: "Winners", icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8M15 7h6v6" /></svg>
  ) },
  { key: "losers", label: "Losers", icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7l6 6 4-4 8 8M15 17h6v-6" /></svg>
  ) },
  { key: "trending", label: "Trending", icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" /></svg>
  ) },
];

function readWatchlist(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "null");
    return Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_IDS;
  } catch { return DEFAULT_IDS; }
}

interface Props {
  coins?: CoinRow[];
  onSelectCoin?: (symbol: string) => void;
  // Shows the filter dropdown + a watchlist star per row.
  filterable?: boolean;
  // Hide the "Top Cryptocurrencies" title (a surrounding tab row names it).
  hideTitle?: boolean;
  // Controlled filter: when the parent owns the filter (and renders
  // <TopCryptoFilter> itself, e.g. in its own tab row), the table's own
  // header row is dropped entirely.
  filter?: Filter;
  onCountChange?: (n: number) => void;
}

// The filter dropdown on its own, for parents that place it elsewhere.
export function TopCryptoFilter({ filter, onChange, count }: { filter: Filter; onChange: (f: Filter) => void; count?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  return (
    <div className="tct-filter" ref={ref}>
      <button type="button" className="tct-filter-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="tct-filter-icon">{active.icon}</span>
        <span className="tct-filter-label">{active.label}</span>
        {count !== undefined && <span className="tct-filter-count">{count}</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="tct-filter-menu" role="listbox">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              role="option"
              aria-selected={filter === f.key}
              className={`tct-filter-item tct-filter-item--${f.key}${filter === f.key ? " active" : ""}`}
              onClick={() => { onChange(f.key); setOpen(false); }}
            >
              <span className="tct-filter-icon">{f.icon}</span>
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopCryptoTable({ coins: coinsProp, onSelectCoin, filterable = false, hideTitle = false, filter: filterProp, onCountChange }: Props) {
  const [ownCoins, setOwnCoins] = useState<CoinRow[]>([]);
  const [tablePage, setTablePage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [ownFilter, setFilter] = useState<Filter>(() => {
    try {
      const v = localStorage.getItem("topCryptoFilter");
      return (FILTERS.some((f) => f.key === v) ? v : "all") as Filter;
    } catch { return "all"; }
  });
  const filter = filterProp ?? ownFilter;
  const controlled = filterProp !== undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [watched, setWatched] = useState<string[]>(readWatchlist);
  const [trendingIds, setTrendingIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (controlled) return;
    try { localStorage.setItem("topCryptoFilter", filter); } catch { /* ignore */ }
  }, [filter, controlled]);

  // Stay in sync with Watchlist.tsx / the signal toasts' "+ Watchlist".
  useEffect(() => {
    const sync = () => setWatched(readWatchlist());
    window.addEventListener("watchlist-add", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("watchlist-add", sync); window.removeEventListener("storage", sync); };
  }, []);

  const toggleWatch = (id: string) => {
    setWatched((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      try { localStorage.setItem(WATCH_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // Trending ids, fetched only once that filter is picked.
  useEffect(() => {
    if (filter !== "trending" || trendingIds) return;
    cgFetch<{ coins: { item: { id: string } }[] }>(TRENDING_URL, TTL.trending)
      .then((r) => setTrendingIds(r.coins.map((c) => c.item.id)))
      .catch(() => setTrendingIds([]));
  }, [filter, trendingIds]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (coinsProp) return;
    let alive = true;
    cgFetch<CoinRow[]>(COINS_URL, TTL.coins)
      .then((c) => { if (alive) setOwnCoins(c); })
      .catch((e) => { if (alive) setError(e?.message ?? "Failed to load"); });
    return () => { alive = false; };
  }, [coinsProp]);

  const allCoins = coinsProp ?? ownCoins;
  const coins = useMemo(() => {
    if (!filterable || filter === "all") return allCoins;
    if (filter === "watchlist") return allCoins.filter((c) => watched.includes(c.id));
    if (filter === "trending") {
      if (!trendingIds) return [];
      return trendingIds.map((id) => allCoins.find((c) => c.id === id)).filter((c): c is CoinRow => !!c);
    }
    const withChg = allCoins.filter((c) => c.price_change_percentage_24h != null);
    return filter === "gainers"
      ? withChg.filter((c) => c.price_change_percentage_24h! > 0).sort((a, b) => b.price_change_percentage_24h! - a.price_change_percentage_24h!)
      : withChg.filter((c) => c.price_change_percentage_24h! < 0).sort((a, b) => a.price_change_percentage_24h! - b.price_change_percentage_24h!);
  }, [allCoins, filterable, filter, watched, trendingIds]);
  useEffect(() => { setTablePage(1); }, [coins.length, filter]);
  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  useEffect(() => { onCountChange?.(coins.length); }, [coins.length, onCountChange]);

  // Click-to-sort headers (whole filtered list, before paging).
  const { sorted: sortedCoins, sort } = useSort(coins, {
    rank: (c) => c.market_cap_rank,
    name: (c) => c.name,
    price: (c) => c.current_price,
    chg24: (c) => c.price_change_percentage_24h,
    chg7d: (c) => c.price_change_percentage_7d_in_currency,
    mcap: (c) => c.market_cap,
    vol: (c) => c.total_volume,
  });
  useEffect(() => { setTablePage(1); }, [sort.key, sort.dir]);
  const tableTotalPages = Math.max(1, Math.ceil(sortedCoins.length / TABLE_PAGE_SIZE));
  const pagedCoins = sortedCoins.slice((tablePage - 1) * TABLE_PAGE_SIZE, tablePage * TABLE_PAGE_SIZE);

  return (
    <div className={`gm-section gm-table-section${filterable ? " tct--filterable" : ""}`}>
      {!controlled && <div className="gm-section-header">
        {hideTitle ? <span /> : <span className="gm-section-title">Top Cryptocurrencies</span>}
        {filterable ? (
          <div className="tct-filter" ref={menuRef}>
            <button type="button" className="tct-filter-btn" onClick={() => setMenuOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={menuOpen}>
              <span className="tct-filter-icon">{activeFilter.icon}</span>
              {activeFilter.label}
              <span className="tct-filter-count">{coins.length}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {menuOpen && (
              <div className="tct-filter-menu" role="listbox">
                {FILTERS.map((f) => (
                  <button
                    type="button"
                    key={f.key}
                    role="option"
                    aria-selected={filter === f.key}
                    className={`tct-filter-item tct-filter-item--${f.key}${filter === f.key ? " active" : ""}`}
                    onClick={() => { setFilter(f.key); setMenuOpen(false); }}
                  >
                    <span className="tct-filter-icon">{f.icon}</span>
                    {f.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="gm-section-sub">{coins.length.toLocaleString()} coins by market capitalization</span>
        )}
      </div>}
      {filterable && filter === "watchlist" && coins.length === 0 && allCoins.length > 0 && (
        <div className="tct-empty">No coins in your watchlist yet — tap ☆ on any coin to add it.</div>
      )}
      {error && coins.length === 0 && <div className="gm-error">{error}</div>}
      <div className="gm-table-wrap">
        <table className="gm-table">
          {/* Fixed column widths (with filterable's table-layout:fixed) so
              switching filters never re-flows the columns. */}
          {filterable && (
            <colgroup>
              <col style={{ width: 56 }} />
              <col />
              <col style={{ width: "11%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: 120 }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "12%" }} />
            </colgroup>
          )}
          <thead>
            <tr>
              <SortTh className="gm-th gm-th--rank" label="Rank" k="rank" sort={sort} />
              <SortTh label="Name" k="name" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="Price" k="price" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="24h %" k="chg24" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="7d %" k="chg7d" sort={sort} />
              <th className="gm-th gm-th--c">Last 7 Days</th>
              <SortTh className="gm-th gm-th--r" label="Market Cap" k="mcap" sort={sort} />
              <SortTh className="gm-th gm-th--r" label="Volume (24h)" k="vol" sort={sort} />
            </tr>
          </thead>
          <tbody>
            {pagedCoins.map((c, i) => {
              const chg24 = c.price_change_percentage_24h ?? 0;
              const chg7d = c.price_change_percentage_7d_in_currency ?? 0;
              return (
                <tr key={c.id} className="gm-tr" style={{ animationDelay: `${Math.min(i, 20) * 20}ms` }}
                  onClick={() => onSelectCoin?.(c.symbol.toUpperCase())}>
                  <td className="gm-td gm-td--rank">{c.market_cap_rank}</td>
                  <td className="gm-td gm-td--name">
                    <img src={c.image} alt={c.name} className="gm-coin-img" loading="lazy" />
                    <span className="gm-coin-name">{c.name}</span>
                    <span className="gm-coin-sym">{c.symbol.toUpperCase()}</span>
                    {/* Watchlist star, right after the coin. */}
                    {filterable && (
                      <button
                        type="button"
                        className={`tct-star${watched.includes(c.id) ? " on" : ""}`}
                        aria-label={watched.includes(c.id) ? `Remove ${c.name} from watchlist` : `Add ${c.name} to watchlist`}
                        onClick={(e) => { e.stopPropagation(); toggleWatch(c.id); }}
                      >
                        {watched.includes(c.id) ? "★" : "☆"}
                      </button>
                    )}
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
          {coins.length ? (tablePage - 1) * TABLE_PAGE_SIZE + 1 : 0}–{Math.min(tablePage * TABLE_PAGE_SIZE, coins.length)} of {coins.length}
        </span>
        <div className="gm-pagination-controls">
          <button type="button" className="gm-page-btn" disabled={tablePage <= 1}
            onClick={() => setTablePage((p) => Math.max(1, p - 1))} aria-label="Previous page">
            ‹
          </button>
          {/* First, last, current ±1 — never the full page list. */}
          {Array.from({ length: tableTotalPages }, (_, idx) => idx + 1)
            .filter((p) => p === 1 || p === tableTotalPages || Math.abs(p - tablePage) <= 1)
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
            onClick={() => setTablePage((p) => Math.min(tableTotalPages, p + 1))} aria-label="Next page">
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
