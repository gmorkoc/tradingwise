import { useEffect, useRef, useState, type ReactNode } from "react";
import { CoinRow, COINS_MARKETS_URL, TTL, cgFetch, fmtBig, fmtPrice } from "./GlobalMarkets";
import { signalOf } from "./MarketSignalTable";
import { COINS, getCoinGeckoId, fetchFundingRate, getPositionData, type Ticker24h } from "../services/coinglass";
import "../styles/CoinInfoPanel.css";

// Chart page (desktop) left column — a copy of CoinMarketCap's coin
// sidebar. CMC-only items are swapped for ours: Treasury Holdings →
// Market dominance, Profile Score → Signal score, Boost → Paper trade.
// Data: the live ticker, the cached top-250 coin list (Markets), the
// cached global stats, the coin's CoinGecko details (links, tags), and on
// the Derivatives tab the funding rate + long/short ratios we already use.

type MarketRow = CoinRow & {
  fully_diluted_valuation?: number | null;
  total_supply?: number | null;
  market_cap_change_percentage_24h?: number | null;
  high_24h?: number | null;
  low_24h?: number | null;
  ath?: number | null;
  ath_date?: string | null;
  ath_change_percentage?: number | null;
  atl?: number | null;
  atl_date?: string | null;
  atl_change_percentage?: number | null;
};
interface CoinDetails {
  categories?: string[];
  links?: {
    homepage?: string[];
    whitepaper?: string;
    blockchain_site?: string[];
    subreddit_url?: string;
    twitter_screen_name?: string;
    repos_url?: { github?: string[] };
  };
}

const WATCH_KEY = "watchlistCoins_v1";
const DETAILS_TTL = 600_000;
const ext = { target: "_blank", rel: "noopener noreferrer" } as const;
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const fmtNum = (n: number | null | undefined) => {
  if (n == null || !isFinite(n)) return "—";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
const fmtUsd = (n: number | null | undefined) => (n == null || !isFinite(n) ? "—" : fmtBig(n));
const dateStr = (s?: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  const yrs = Math.floor((Date.now() - d.getTime()) / (365.25 * 864e5));
  return `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" })}${yrs > 0 ? ` (${yrs}y ago)` : ""}`;
};

const Info = ({ tip }: { tip: string }) => (
  <span className="cip-i" title={tip} aria-label={tip}>
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
  </span>
);
const Chg = ({ v }: { v: number | null | undefined }) =>
  v == null || !isFinite(v) ? null : (
    <span className={`cip-chg ${v >= 0 ? "cip-up" : "cip-dn"}`}>{v >= 0 ? "▲" : "▼"} {Math.abs(v).toFixed(2)}%</span>
  );
const Cell = ({ label, tip, children, full }: { label: string; tip?: string; children: ReactNode; full?: boolean }) => (
  <div className={`cip-cell${full ? " cip-cell--full" : ""}`}>
    <span className="cip-label">{label}{tip && <Info tip={tip} />}</span>
    <span className="cip-val">{children}</span>
  </div>
);
const Down = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
);

function readWatch(): string[] {
  try { const v = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "null"); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function CoinInfoPanel({ coin, ticker, onTrade, stats, onPickCoin }: {
  coin: string;
  ticker?: Ticker24h;
  onTrade?: () => void;
  /** Coin name block → the coin picker (anchored to it). */
  onPickCoin?: (anchor: HTMLElement) => void;
  /** Market stats (liquidations, OI, funding, RSI, MACD, L/S) — shown in the
   *  chart header's exact compact row style, scrolling sideways. */
  stats?: ReactNode;
}) {
  const name = COINS.find((c) => c.symbol === coin)?.name ?? coin;

  // Top-250 list (shared cache with Markets) + global stats (dominance).
  const [rows, setRows] = useState<MarketRow[] | null>(null);
  const [globalCap, setGlobalCap] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      cgFetch<MarketRow[]>(COINS_MARKETS_URL, TTL.coins).then((r) => { if (alive) setRows(r); }).catch(() => {});
      cgFetch<{ data: { total_market_cap?: { usd?: number } } }>("https://api.coingecko.com/api/v3/global", TTL.global)
        .then((g) => { if (alive) setGlobalCap(g.data.total_market_cap?.usd ?? null); }).catch(() => {});
    };
    load();
    const id = window.setInterval(load, TTL.coins);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // Links + tags.
  const [details, setDetails] = useState<CoinDetails | null>(null);
  const [allTags, setAllTags] = useState(false);
  const [explorersOpen, setExplorersOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    setDetails(null); setAllTags(false); setExplorersOpen(false);
    (async () => {
      const id = await getCoinGeckoId(coin);
      if (!id) return;
      const d = await cgFetch<CoinDetails>(
        `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
        DETAILS_TTL,
      );
      if (alive) setDetails(d);
    })().catch(() => {});
    return () => { alive = false; };
  }, [coin]);

  // Spot | Derivatives.
  const [mode, setMode] = useState<"spot" | "deriv">("spot");
  const [deriv, setDeriv] = useState<{ funding: number | null; retail: number | null; top: number | null } | null>(null);
  useEffect(() => {
    if (mode !== "deriv") return;
    let alive = true;
    setDeriv(null);
    Promise.all([
      fetchFundingRate(coin).catch(() => null),
      getPositionData(coin, "1h", 2).catch(() => null),
    ]).then(([funding, pos]) => {
      if (!alive) return;
      const last = <T,>(a?: T[]) => (a && a.length ? a[a.length - 1] : undefined);
      const r = last(pos?.retail), t = last(pos?.smartMoney);
      setDeriv({
        funding,
        retail: r ? r.longRatio * 100 : null,
        top: t ? t.longRatio * 100 : null,
      });
    });
    return () => { alive = false; };
  }, [mode, coin]);

  // Price performance range: 24h (ticker) or 7d (the list's hourly prices).
  const [perf, setPerf] = useState<"24h" | "7d">("24h");
  const [perfOpen, setPerfOpen] = useState(false);
  const perfRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!perfOpen) return;
    const off = (e: MouseEvent) => { if (perfRef.current && !perfRef.current.contains(e.target as Node)) setPerfOpen(false); };
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [perfOpen]);

  // Watchlist star + share.
  const [watch, setWatch] = useState<string[]>(readWatch);
  const [shared, setShared] = useState(false);

  // Converter.
  const [amt, setAmt] = useState("1");
  const [usd, setUsd] = useState("");

  const r = rows?.find((x) => x.symbol.toUpperCase() === coin) ?? null;
  const price = ticker?.price ?? r?.current_price ?? null;
  const chg = ticker?.change ?? r?.price_change_percentage_24h ?? null;
  const spark = r?.sparkline_in_7d?.price ?? [];
  const lo = perf === "24h" ? ticker?.low ?? r?.low_24h ?? null : spark.length ? Math.min(...spark) : null;
  const hi = perf === "24h" ? ticker?.high ?? r?.high_24h ?? null : spark.length ? Math.max(...spark) : null;
  const rangePos = price != null && lo != null && hi != null && hi > lo ? Math.min(100, Math.max(0, ((price - lo) / (hi - lo)) * 100)) : null;
  const volMcap = r?.total_volume && r?.market_cap ? (r.total_volume / r.market_cap) * 100 : null;
  const circPct = r?.circulating_supply && r?.max_supply ? Math.min(100, (r.circulating_supply / r.max_supply) * 100) : null;
  const dominance = r?.market_cap && globalCap ? (r.market_cap / globalCap) * 100 : null;
  const sig = r ? signalOf(r) : null;
  const watched = !!r && watch.includes(r.id);

  useEffect(() => { setAmt("1"); }, [coin]);
  useEffect(() => {
    const a = parseFloat(amt);
    if (price != null && isFinite(a)) setUsd(String(+(a * price).toFixed(2)));
    // Re-derive on price/coin changes only, not while the USD box is typed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price, coin]);

  const toggleWatch = () => {
    if (!r) return;
    const next = watched ? watch.filter((x) => x !== r.id) : [...watch, r.id];
    setWatch(next);
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    window.dispatchEvent(new Event("watchlist-add"));
  };
  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: `${name} (${coin}) on coinhintz`, url });
      else { await navigator.clipboard.writeText(url); setShared(true); window.setTimeout(() => setShared(false), 1600); }
    } catch { /* cancelled */ }
  };

  const L = details?.links;
  const site = L?.homepage?.find(Boolean);
  const explorers = (L?.blockchain_site ?? []).filter(Boolean);
  const github = L?.repos_url?.github?.find(Boolean);
  const tags = (details?.categories ?? []).filter(Boolean);

  return (
    <aside className="cip" aria-label={`${name} overview`}>
      {/* Name row + star / share */}
      <div className="cip-top">
        {/* Coin name block: opens the coin picker. */}
        <button
          type="button"
          className="cip-head"
          onClick={(e) => onPickCoin?.(e.currentTarget)}
          disabled={!onPickCoin}
          aria-label={`${name} — switch coin`}
          title="Switch coin"
        >
          <img
            className="cip-logo"
            src={r?.image ?? `https://assets.coincap.io/assets/icons/${coin.toLowerCase()}@2x.png`}
            alt=""
            onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
          />
          <h1 className="cip-name">{name}</h1>
          <span className="cip-sym">{coin}</span>
          {r?.market_cap_rank ? <span className="cip-rank">#{r.market_cap_rank}</span> : null}
          {onPickCoin && <span className="cip-head-chev" aria-hidden="true"><Down /></span>}
        </button>
        <div className="cip-actions">
          <button type="button" className={`cip-act${watched ? " cip-act--on" : ""}`} onClick={toggleWatch} aria-pressed={watched} title={watched ? "Remove from watchlist" : "Add to watchlist"}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill={watched ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M12 2l3 6.6 7 .7-5.3 4.7 1.6 7L12 17.3 5.7 21l1.6-7L2 9.3l7-.7z" /></svg>
          </button>
          <button type="button" className="cip-act" onClick={share} title={shared ? "Link copied" : "Share"}>
            {shared ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></svg>
            )}
          </button>
        </div>
      </div>

      <div className="cip-price">
        <strong>{price != null ? fmtPrice(price) : "—"}</strong>
        {chg != null && <span className={`cip-chg ${chg >= 0 ? "cip-up" : "cip-dn"}`}>{chg >= 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(2)}% (24h)</span>}
      </div>

      {/* Market stats: the chart header's own row (.chart-bar-stats), so
          size and spacing match it exactly; scrolls sideways. */}
      {stats && (
        <div className="cip-xstats">
          <div className="chart-bar-stats">
            {stats}
            {/* One exchange's spot volume (the live ticker) — the stats card
                below has the all-exchange total. */}
            {ticker?.quoteVolume != null && (
              <div className="chart-bar-stat" title={`24h spot volume on Binance (${coin}/USDT). The stats card below shows all exchanges combined.`}>
                <span className="chart-bar-stat-label">Binance 24h Vol</span>
                <span className="chart-bar-stat-value">{fmtUsd(ticker.quoteVolume)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stats card: Spot | Derivatives */}
      <div className="cip-card">
        <div className="cip-seg" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "spot"} className={`cip-seg-btn${mode === "spot" ? " cip-seg-btn--on" : ""}`} onClick={() => setMode("spot")}>Spot</button>
          <button type="button" role="tab" aria-selected={mode === "deriv"} className={`cip-seg-btn${mode === "deriv" ? " cip-seg-btn--on" : ""}`} onClick={() => setMode("deriv")}>Derivatives</button>
        </div>
        {mode === "spot" ? (
          <div className="cip-grid">
            <Cell full label="Market cap" tip="Price × circulating supply.">
              {fmtUsd(r?.market_cap)} <Chg v={r?.market_cap_change_percentage_24h} />
            </Cell>
            <Cell label="Volume (24h)" tip="Total traded value across exchanges in the last 24 hours.">
              {fmtUsd(r?.total_volume ?? ticker?.quoteVolume)}
            </Cell>
            <Cell label="Vol/Mkt Cap (24h)" tip="24h volume as a share of market cap — a liquidity gauge.">
              {volMcap != null ? `${volMcap.toFixed(2)}%` : "—"}
            </Cell>
            <Cell full label="FDV" tip="Fully diluted valuation: price × max (or total) supply.">
              {fmtUsd(r?.fully_diluted_valuation)}
            </Cell>
            <Cell label="Total supply" tip="Coins created so far, minus any burned.">
              {r?.total_supply ? `${fmtNum(r.total_supply)} ${coin}` : "—"}
            </Cell>
            <Cell label="Max. supply" tip="The most coins that will ever exist.">
              {r?.max_supply ? `${fmtNum(r.max_supply)} ${coin}` : "∞"}
            </Cell>
            <Cell label="Circulating supply" tip="Coins in public hands right now.">
              {r?.circulating_supply ? `${fmtNum(r.circulating_supply)} ${coin}` : "—"}
              {circPct != null && (
                <svg className="cip-ring" width="14" height="14" viewBox="0 0 16 16" aria-label={`${circPct.toFixed(1)}% of max supply`}>
                  <circle cx="8" cy="8" r="6" className="cip-ring-t" />
                  <circle cx="8" cy="8" r="6" className="cip-ring-f" strokeDasharray={`${((circPct / 100) * 37.7).toFixed(1)} 37.7`} transform="rotate(-90 8 8)" />
                </svg>
              )}
            </Cell>
            <Cell label="Market dominance" tip="Share of the total crypto market cap.">
              {dominance != null ? `${dominance.toFixed(2)}%` : "—"}
            </Cell>
          </div>
        ) : (
          <div className="cip-grid">
            <Cell full label="Funding rate" tip="Binance perpetual funding (8h). Positive = longs pay shorts.">
              {deriv ? (deriv.funding != null ? <span className={deriv.funding >= 0 ? "cip-up" : "cip-dn"}>{deriv.funding.toFixed(4)}%</span> : "—") : <span className="cip-skel" />}
            </Cell>
            <Cell label="Accounts long" tip="Share of all Binance futures accounts that are long.">
              {deriv ? (deriv.retail != null ? `${deriv.retail.toFixed(1)}%` : "—") : <span className="cip-skel" />}
            </Cell>
            <Cell label="Top traders long" tip="Share of Binance's top trader accounts that are long.">
              {deriv ? (deriv.top != null ? `${deriv.top.toFixed(1)}%` : "—") : <span className="cip-skel" />}
            </Cell>
            <Cell full label="Volume (24h)" tip="Spot volume across exchanges.">
              {fmtUsd(r?.total_volume ?? ticker?.quoteVolume)}
            </Cell>
          </div>
        )}
      </div>

      {/* Signal score (in place of CMC's Profile Score) */}
      <div className={`cip-score cip-score--${sig?.tone ?? "none"}`}>
        <span className="cip-score-k">Signal score <Info tip="Technicals read (moving averages + oscillators) on 7 days of hourly prices. 0 = strong sell, 100 = strong buy." /></span>
        <span className="cip-score-v">
          <span className="cip-score-bar" aria-hidden="true"><i style={{ width: `${sig?.score ?? 0}%` }} /></span>
          <b>{sig ? `${sig.word} ${sig.score}` : "—"}</b>
        </span>
      </div>

      {/* Paper trade (in place of CMC's Boost) */}
      {onTrade && (
        <button type="button" className="cip-cta" onClick={onTrade}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
          Paper trade {coin}
        </button>
      )}

      {/* Links */}
      {(site || L?.whitepaper || L?.twitter_screen_name || L?.subreddit_url || github || explorers.length > 0) && (
        <div className="cip-rows">
          {(site || L?.whitepaper) && (
            <div className="cip-row">
              <span className="cip-row-k">Website</span>
              <span className="cip-row-v">
                {site && (
                  <a className="cip-chip" href={site} {...ext}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></svg>
                    Website
                  </a>
                )}
                {L?.whitepaper && (
                  <a className="cip-chip" href={L.whitepaper} {...ext}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></svg>
                    Whitepaper
                  </a>
                )}
              </span>
            </div>
          )}
          {(L?.twitter_screen_name || L?.subreddit_url || github) && (
            <div className="cip-row">
              <span className="cip-row-k">Socials</span>
              <span className="cip-row-v">
                {L?.twitter_screen_name && (
                  <a className="cip-soc" href={`https://x.com/${L.twitter_screen_name}`} {...ext} aria-label="X">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-7.6 8.7L23 22h-6.8l-5.3-6.9L4.8 22H1.7l8.1-9.3L1 2h7l4.8 6.3zm-1.2 18h1.9L6.4 3.9h-2z" /></svg>
                  </a>
                )}
                {L?.subreddit_url && /reddit\.com\/r\//.test(L.subreddit_url) && (
                  <a className="cip-soc cip-soc--reddit" href={L.subreddit_url} {...ext} aria-label="Reddit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 12.1a2.2 2.2 0 0 0-3.7-1.6 10.8 10.8 0 0 0-5.8-1.8l1-4.6 3.2.7a1.6 1.6 0 1 0 .2-1l-3.6-.8a.5.5 0 0 0-.6.4l-1.1 5.3a10.8 10.8 0 0 0-5.9 1.8 2.2 2.2 0 1 0-2.4 3.6 4.3 4.3 0 0 0 0 .7c0 3.6 4.2 6.6 9.3 6.6s9.3-3 9.3-6.6a4.3 4.3 0 0 0 0-.7 2.2 2.2 0 0 0 1.1-2zM7.5 13.6a1.6 1.6 0 1 1 1.6 1.6 1.6 1.6 0 0 1-1.6-1.6zm9 4.3a5.9 5.9 0 0 1-4.5 1.4 5.9 5.9 0 0 1-4.5-1.4.4.4 0 0 1 .6-.6 5 5 0 0 0 3.9 1.1 5 5 0 0 0 3.9-1.1.4.4 0 1 1 .6.6zm-.3-2.7a1.6 1.6 0 1 1 1.6-1.6 1.6 1.6 0 0 1-1.6 1.6z" /></svg>
                  </a>
                )}
                {github && (
                  <a className="cip-soc" href={github} {...ext} aria-label="GitHub">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6a4.7 4.7 0 0 1 1.3-3.2 4.3 4.3 0 0 1 .1-3.2s1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2a4.3 4.3 0 0 1 .1 3.2 4.7 4.7 0 0 1 1.3 3.2c0 4.6-2.8 5.6-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z" /></svg>
                  </a>
                )}
              </span>
            </div>
          )}
          {explorers.length > 0 && (
            <div className="cip-row cip-row--top">
              <span className="cip-row-k">Explorers</span>
              <span className="cip-row-v cip-row-v--col">
                <span className="cip-row-v">
                  <a className="cip-chip" href={explorers[0]} {...ext}>{host(explorers[0])}</a>
                  {explorers.length > 1 && (
                    <button type="button" className={`cip-more-btn${explorersOpen ? " cip-more-btn--open" : ""}`} onClick={() => setExplorersOpen((v) => !v)} aria-expanded={explorersOpen} aria-label="More explorers">
                      <Down />
                    </button>
                  )}
                </span>
                {explorersOpen && explorers.slice(1, 8).map((u) => (
                  <a key={u} className="cip-chip" href={u} {...ext}>{host(u)}</a>
                ))}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Converter */}
      <section className="cip-sec">
        <h3>{coin} to USD converter</h3>
        <div className="cip-conv">
          <label className="cip-conv-row">
            <span>{coin}</span>
            <input
              inputMode="decimal"
              value={amt}
              onChange={(e) => {
                setAmt(e.target.value);
                const a = parseFloat(e.target.value);
                setUsd(price != null && isFinite(a) ? String(+(a * price).toFixed(2)) : "");
              }}
              aria-label={`${coin} amount`}
            />
          </label>
          <label className="cip-conv-row">
            <span>USD</span>
            <input
              inputMode="decimal"
              value={usd}
              onChange={(e) => {
                setUsd(e.target.value);
                const u = parseFloat(e.target.value);
                setAmt(price && isFinite(u) ? String(+(u / price).toPrecision(8)) : "");
              }}
              aria-label="USD amount"
            />
          </label>
        </div>
      </section>

      {/* Price performance */}
      <section className="cip-sec">
        <h3>
          Price performance
          <div className="cip-dd" ref={perfRef}>
            <button type="button" className="cip-dd-btn" onClick={() => setPerfOpen((v) => !v)} aria-expanded={perfOpen}>
              {perf} <Down />
            </button>
            {perfOpen && (
              <div className="cip-dd-menu" role="listbox">
                {(["24h", "7d"] as const).map((p) => (
                  <button key={p} type="button" role="option" aria-selected={perf === p} className={`cip-dd-item${perf === p ? " cip-dd-item--on" : ""}`} onClick={() => { setPerf(p); setPerfOpen(false); }}>
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
        </h3>
        <div className="cip-range">
          <div><span className="cip-k">Low</span><strong>{lo != null ? fmtPrice(lo) : "—"}</strong></div>
          <div className="cip-range-r"><span className="cip-k">High</span><strong>{hi != null ? fmtPrice(hi) : "—"}</strong></div>
        </div>
        <span className="cip-range-bar" aria-hidden="true">{rangePos != null && <i style={{ left: `${rangePos}%` }} />}</span>
        <div className="cip-rec">
          <div>
            <span className="cip-rec-t">All-time high</span>
            <span className="cip-rec-d">{dateStr(r?.ath_date)}</span>
          </div>
          <div className="cip-rec-r">
            <strong>{r?.ath ? fmtPrice(r.ath) : "—"}</strong>
            {r?.ath_change_percentage != null && <span className="cip-dn">{r.ath_change_percentage.toFixed(2)}%</span>}
          </div>
        </div>
        <div className="cip-rec">
          <div>
            <span className="cip-rec-t">All-time low</span>
            <span className="cip-rec-d">{dateStr(r?.atl_date)}</span>
          </div>
          <div className="cip-rec-r">
            <strong>{r?.atl ? fmtPrice(r.atl) : "—"}</strong>
            {r?.atl_change_percentage != null && <span className="cip-up">+{r.atl_change_percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</span>}
          </div>
        </div>
      </section>

      {/* Tags */}
      {tags.length > 0 && (
        <section className="cip-sec">
          <h3>Tags</h3>
          <div className="cip-tags">
            {(allTags ? tags : tags.slice(0, 3)).map((t) => <span key={t} className="cip-tag">{t}</span>)}
          </div>
          {tags.length > 3 && (
            <button type="button" className="cip-link" onClick={() => setAllTags((v) => !v)}>
              {allTags ? "Show less" : "Show all"}
            </button>
          )}
        </section>
      )}
    </aside>
  );
}
