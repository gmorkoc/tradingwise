import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../contexts/AuthContext";
import { LockCard } from "./MembershipGate";
import { Capacitor } from "@capacitor/core";
import { getAllExchangeFunding, FUNDING_EXCHANGES, type FundingExchange } from "../services/coinglass";
import "../styles/FundingBot.css";

// Website: the /okx-api proxy. iOS app: there is no proxy (the app's origin
// is capacitor://localhost), so call OKX directly — its public API allows it.
const OKX_BASE = Capacitor.isNativePlatform() ? "https://www.okx.com" : "/okx-api";

/** Small lock pill shown to guests in place of a signal badge. */
function SignalLock({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="fb-lock-pill" onClick={onClick} title={t("fundingBot2.signInSignal")} aria-label={t("fundingBot2.signInSignal")}>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
      </svg>
      {t("fundingBot2.signIn")}
    </button>
  );
}

/* ── Types ──────────────────────────────────────────────────────────────────── */
interface OkxFundingRate {
  instId: string;
  fundingRate: string;
  nextFundingTime: string;
  markPrice?: string;
}

interface FundingRateEntry {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

interface CoinRow {
  symbol: string;    // e.g. "BTC"
  fullSymbol: string; // e.g. "BTCUSDT"
  markPrice: number;
  /** Average funding rate across the exchanges that list this coin. */
  fundingRate: number;
  nextFundingTime: number;
  /** Each exchange's own current rate (missing = not listed / no answer). */
  rates: Partial<Record<FundingExchange, number>>;
  /** Highest − lowest rate across exchanges (null with < 2 exchanges). */
  spread: number | null;
}

/** Next standard 8h funding time (00/08/16 UTC) — used when OKX has no row. */
function nextFundingSlot(): number {
  const now = Date.now();
  const step = 8 * 3600_000;
  return Math.ceil(now / step) * step;
}

interface Props {
  coin: string;
  theme: string;
  onOpenAuth: (view?: "login" | "signup") => void;
  onOpenUpgrade: () => void;
}

/* ── Constants ──────────────────────────────────────────────────────────────── */
const TOP_COINS = [
  // Major L1s
  "BTC","ETH","BNB","SOL","XRP","ADA","AVAX","DOT","ATOM","TRX","ETC","LTC","BCH",
  // Smart contract / infra
  "NEAR","ICP","FIL","AR","TIA","EGLD","APT","SUI","STX","CFX","DASH","ZEC","XLM",
  // DeFi
  "LINK","UNI","AAVE","CRV","INJ","ENS","COMP","LDO","DYDX","SNX","YFI","UMA","TRB","LPT","NMR","AUCTION","KSM","ZEN","SSV",
  // L2 / scaling
  "OP","ARB",
  // Newer narratives
  "HYPE","TAO","WLD","ORDI","BERA","ENA","JTO","VIRTUAL","GRASS","RENDER","ONDO",
  // Memes / culture
  "DOGE","SHIB","PEPE","FLOKI","BONK","WIF","TRUMP","MEME","BOME","NOT",
  // Gaming / metaverse
  "GALA","CHZ","APE","AXS","SAND","MANA","ENJ",
];

/* ── Signal logic ───────────────────────────────────────────────────────────── */
interface Signal {
  label: string;
  colorClass: string;
}

type TFunction = (key: string, opts?: Record<string, unknown>) => string;

function getSignal(rate: number, t: TFunction): Signal {
  if (rate >= 0.0005)  return { label: t("fundingBot.sigOverheated"),    colorClass: "fb-signal--red"    };
  if (rate >= 0.0002)  return { label: t("fundingBot.sigElevatedLong"),  colorClass: "fb-signal--orange"  };
  if (rate <= -0.0005) return { label: t("fundingBot.sigTrapped"),       colorClass: "fb-signal--green"   };
  if (rate <= -0.0002) return { label: t("fundingBot.sigElevatedShort"), colorClass: "fb-signal--yellow"  };
  return                      { label: t("fundingBot.sigNeutral"),       colorClass: "fb-signal--gray"    };
}

/* ── Hover tip ──────────────────────────────────────────────────────────────── */
interface Tip { title: string; body: string; action: string }

function getTip(rate: number, sym: string, t: TFunction): Tip {
  const abs     = Math.abs(rate);
  const rateStr = (abs * 100).toFixed(4) + "%";
  const annual  = (abs * 3 * 365 * 100).toFixed(1);

  if (rate >= 0.0005) return {
    title:  t("fundingBot.tipOverheatedTitle"),
    body:   t("fundingBot.tipOverheatedBody",   { sym, rate: rateStr, annual }),
    action: t("fundingBot.tipOverheatedAction"),
  };
  if (rate >= 0.0002) return {
    title:  t("fundingBot.tipElevatedLongTitle"),
    body:   t("fundingBot.tipElevatedLongBody", { sym, rate: rateStr }),
    action: t("fundingBot.tipElevatedLongAction"),
  };
  if (rate <= -0.0005) return {
    title:  t("fundingBot.tipTrappedTitle"),
    body:   t("fundingBot.tipTrappedBody",      { sym, rate: rateStr, annual }),
    action: t("fundingBot.tipTrappedAction"),
  };
  if (rate <= -0.0002) return {
    title:  t("fundingBot.tipElevatedShortTitle"),
    body:   t("fundingBot.tipElevatedShortBody", { sym, rate: rateStr }),
    action: t("fundingBot.tipElevatedShortAction"),
  };
  return {
    title:  t("fundingBot.tipNeutralTitle"),
    body:   t("fundingBot.tipNeutralBody",   { sym, rate: (rate * 100).toFixed(4) }),
    action: t("fundingBot.tipNeutralAction"),
  };
}

/* ── Helpers ────────────────────────────────────────────────────────────────── */
function fmtRate(r: number): string {
  return (r * 100).toFixed(4) + "%";
}

function fmtPrice(p: number): string {
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function timeUntil(ms: number, nowLabel: string): string {
  const diff = ms - Date.now();
  if (diff <= 0) return nowLabel;
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ── Pure-data funding insight ───────────────────────────────────────────────── */

function FundingInsight({ row, signal, history }: { row: CoinRow; signal: Signal; history: FundingRateEntry[] }) {
  const { t } = useTranslation();
  const rate    = row.fundingRate;
  const absRate = Math.abs(rate);
  const annual  = (absRate * 3 * 365 * 100).toFixed(1);
  const isPos   = rate >= 0;

  // Trend from history (last 10 periods)
  const rates = history.slice(-10).map(h => parseFloat(h.fundingRate));
  const trend: "rising" | "falling" | "stable" = (() => {
    if (rates.length < 3) return "stable";
    const first = rates.slice(0, Math.floor(rates.length / 2)).reduce((s, v) => s + v, 0) / Math.floor(rates.length / 2);
    const last  = rates.slice(Math.ceil(rates.length / 2)).reduce((s, v) => s + v, 0) / Math.ceil(rates.length / 2);
    const diff  = last - first;
    if (Math.abs(diff) < 0.00005) return "stable";
    return diff > 0 ? "rising" : "falling";
  })();

  // Derived plain-English lines
  const whoPayWho = isPos
    ? t("fundingBot2.whoPaysLongs", { rate: fmtRate(rate), annual })
    : t("fundingBot2.whoPaysShorts", { rate: fmtRate(absRate), annual });

  const crowding = isPos
    ? rate >= 0.0005
      ? t("fundingBot2.crowdHeavyLong")
      : t("fundingBot2.crowdMildLong")
    : absRate >= 0.0005
      ? t("fundingBot2.crowdHeavyShort")
      : t("fundingBot2.crowdMildShort");

  const trendLine = trend === "rising"
    ? t(isPos ? "fundingBot2.trendRisingLongs" : "fundingBot2.trendRisingShorts", { n: rates.length })
    : trend === "falling"
      ? t(isPos ? "fundingBot2.trendFallingLongs" : "fundingBot2.trendFallingShorts")
      : t("fundingBot2.trendStable");

  const implication = isPos
    ? rate >= 0.0005
      ? t("fundingBot2.implHighPos")
      : t("fundingBot2.implMildPos")
    : absRate >= 0.0005
      ? t("fundingBot2.implHighNeg")
      : t("fundingBot2.implMildNeg");

  const rows2: { label: string; value: string; color?: string }[] = [
    { label: t("fundingBot2.whoPays"),     value: whoPayWho },
    { label: t("fundingBot2.positioning"), value: crowding },
    { label: t("fundingBot2.trend"),       value: trendLine },
    { label: t("fundingBot2.implication"), value: implication },
  ];

  return (
    <div className="fb-insight">
      <div className="fb-insight-header">
        <span className="fb-insight-title">{t("fundingBot2.insightTitle")}</span>
        <span className={`fb-signal-badge ${signal.colorClass}`}>{signal.label}</span>
      </div>
      <div className="fb-insight-rows">
        {rows2.map(r => (
          <div key={r.label} className="fb-insight-row">
            <span className="fb-insight-label">{r.label}</span>
            <span className="fb-insight-value">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Component ──────────────────────────────────────────────────────────────── */
export const FundingBot: React.FC<Props> = ({ coin, onOpenAuth }) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Signals, tips, insight and the watchlist need a free account.
  const askSignIn = (e?: React.MouseEvent) => { e?.stopPropagation(); onOpenAuth(); };
  const PAGE_SIZE = 10;
  const [rows, setRows]           = useState<CoinRow[]>([]);
  const [page, setPage]           = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [selectedCoin, setSelectedCoin] = useState<string>(() => {
    const upper = coin?.toUpperCase();
    return TOP_COINS.includes(upper) ? upper : "BTC";
  });
  const [history, setHistory]     = useState<FundingRateEntry[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [countdown, setCountdown] = useState("");
  const [hoveredTip, setHoveredTip] = useState<{ tip: Tip; x: number; y: number } | null>(null);
  const [watchlist, setWatchlist]   = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("fb_watchlist") ?? "[]")); }
    catch { return new Set(); }
  });
  const [viewMode, setViewMode]     = useState<"all" | "watchlist">("all");
  const refreshTimerRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimerRef         = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Fetch scanner data ──────────────────────────────────────────────────── */
  const fetchScanner = useCallback(async () => {
    try {
      // Three requests in all: OKX's bulk funding + mark prices (direct, works
      // in the iOS app too) and Binance/Bybit/Bitget/Coinbase via our
      // exchange-funding function (bulk, cached 30s server-side).
      const getJson = (url: string) => fetch(url).then(r => r.json()).catch(() => null);
      const [okxFunding, okxMarks, others] = await Promise.all([
        getJson(`${OKX_BASE}/api/v5/public/funding-rate?instId=ANY`),
        getJson(`${OKX_BASE}/api/v5/public/mark-price?instType=SWAP`),
        getAllExchangeFunding(),
      ]);
      const okxBy = new Map<string, OkxFundingRate>();
      for (const d of (okxFunding?.data ?? []) as (OkxFundingRate & { instId: string })[]) {
        if (d.instId?.endsWith("-USDT-SWAP")) okxBy.set(d.instId.replace("-USDT-SWAP", ""), d);
      }
      const markBy = new Map<string, number>();
      for (const d of (okxMarks?.data ?? []) as { instId: string; markPx: string }[]) {
        if (d.instId?.endsWith("-USDT-SWAP")) markBy.set(d.instId.replace("-USDT-SWAP", ""), parseFloat(d.markPx));
      }

      const filtered = TOP_COINS.flatMap((sym) => {
        const okx = okxBy.get(sym);
        const rates: Partial<Record<FundingExchange, number>> = { ...(others[sym] ?? {}) };
        if (okx) rates.OKX = parseFloat(okx.fundingRate);
        const vals = FUNDING_EXCHANGES.map(e => rates[e]).filter((v): v is number => typeof v === "number" && isFinite(v));
        if (!vals.length) return [];
        // Main number = average across the exchanges that list it; spread =
        // highest − lowest (a funding-arbitrage gap).
        const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
        return [{
          symbol:          sym,
          fullSymbol:      `${sym}USDT`,
          markPrice:       markBy.get(sym) ?? 0,
          fundingRate:     avg,
          nextFundingTime: okx ? parseInt(okx.nextFundingTime) : nextFundingSlot(),
          rates,
          spread:          vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : null,
        } satisfies CoinRow];
      });

      if (filtered.length === 0) throw new Error("No data returned");
      setRows(filtered);
      setError("");
    } catch (e) {
      setError(t("fundingBot.errorLoad"));
      console.error("FundingBot fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, [t]);

  /* ── Fetch history ───────────────────────────────────────────────────────── */
  const fetchHistory = useCallback(async (sym: string) => {
    setHistLoading(true);
    setHistory([]);
    try {
      const res = await fetch(
        `${OKX_BASE}/api/v5/public/funding-rate-history?instId=${sym}-USDT-SWAP&limit=10`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list: { fundingRate: string; fundingTime: string }[] = json?.data ?? [];
      const mapped: FundingRateEntry[] = list.map(e => ({
        symbol:      `${sym}USDT`,
        fundingTime: parseInt(e.fundingTime),
        fundingRate: e.fundingRate,
      }));
      setHistory(mapped.reverse());
    } catch {
      setHistory([]);
    } finally {
      setHistLoading(false);
    }
  }, []);

  /* ── Auto-refresh every 30 s ─────────────────────────────────────────────── */
  useEffect(() => {
    fetchScanner();
    refreshTimerRef.current = setInterval(fetchScanner, 30_000);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [fetchScanner]);

  /* ── Fetch history when coin changes ────────────────────────────────────── */
  useEffect(() => {
    fetchHistory(selectedCoin);
  }, [selectedCoin, fetchHistory]);

  /* ── Countdown to next funding ───────────────────────────────────────────── */
  useEffect(() => {
    const updateCountdown = () => {
      const row = rows.find(r => r.symbol === selectedCoin);
      if (row) setCountdown(timeUntil(row.nextFundingTime, t("fundingBot2.now")));
    };
    updateCountdown();
    countdownTimerRef.current = setInterval(updateCountdown, 1000);
    return () => { if (countdownTimerRef.current) clearInterval(countdownTimerRef.current); };
  }, [rows, selectedCoin, t]);

  const toggleWatch = (sym: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) { onOpenAuth(); return; }
    setWatchlist(prev => {
      const next = new Set(prev);
      next.has(sym) ? next.delete(sym) : next.add(sym);
      localStorage.setItem("fb_watchlist", JSON.stringify([...next]));
      return next;
    });
  };

  /* ── Derived ─────────────────────────────────────────────────────────────── */
  const selectedRow    = rows.find(r => r.symbol === selectedCoin);
  const selectedSignal = selectedRow ? getSignal(selectedRow.fundingRate, t) : null;
  const maxAbsRate     = Math.max(...rows.map(r => Math.abs(r.fundingRate)), 0.0001);
  const visibleRows    = viewMode === "watchlist" && user ? rows.filter(r => watchlist.has(r.symbol)) : rows;
  const totalPages     = Math.ceil(visibleRows.length / PAGE_SIZE);
  const pageRows       = visibleRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return (
    <div className="fb-page">
      {hoveredTip && (
        <div
          className="fb-row-tip"
          style={{ left: hoveredTip.x + 16, top: hoveredTip.y - 8 }}
        >
          <div className="fb-row-tip-title">{hoveredTip.tip.title}</div>
          <div className="fb-row-tip-body">{hoveredTip.tip.body}</div>
          <div className="fb-row-tip-action">{hoveredTip.tip.action}</div>
        </div>
      )}

      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div className="fb-header">
        <div className="fb-header-left">
          <h2 className="fb-title">
            <svg className="fb-title-icon" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 5L5 19"/>
              <circle cx="6.5" cy="6.5" r="2.5"/>
              <circle cx="17.5" cy="17.5" r="2.5"/>
            </svg>
            {t("fundingBot.title")}
          </h2>
          <p className="fb-subtitle">{t("fundingBot.subtitle")}</p>
        </div>
        <div className="fb-header-right">
          <div className="fb-live-dot" />
          <span className="fb-live-label">{t("fundingBot.live")}</span>
          {selectedRow && (
            <span className="fb-countdown" title={t("fundingBot2.nextFundingTitle")}>
              {t("fundingBot.nextFunding")} <strong>{countdown}</strong>
            </span>
          )}
          <button className="fb-refresh-btn" onClick={fetchScanner} title={t("fundingBot2.refreshTitle")}>{t("fundingBot.refresh")}</button>
        </div>
      </div>

      {/* ── Scanner table ────────────────────────────────────────────────────── */}
      <div className="fb-scanner-wrap">
        <div className="fb-scanner-topbar">
          <div className="fb-scanner-title">{t("fundingBot.scanner")}</div>
          <div className="fb-view-tabs">
            <button className={`fb-view-tab${viewMode === "all" ? " fb-view-tab--active" : ""}`} onClick={() => { setViewMode("all"); setPage(0); }}>{t("fundingBot2.all")}</button>
            <button className={`fb-view-tab${viewMode === "watchlist" && user ? " fb-view-tab--active" : ""}`}
              onClick={() => { if (!user) { onOpenAuth(); return; } setViewMode("watchlist"); setPage(0); }}
              title={user ? undefined : t("fundingBot2.watchlistSignIn")}>
              {user ? "★" : "🔒"} {t("fundingBot2.watchlist")} {user && watchlist.size > 0 && <span className="fb-wl-count">{watchlist.size}</span>}
            </button>
          </div>
        </div>
        {loading && <div className="fb-loading">{t("fundingBot.loading")}</div>}
        {error && <div className="fb-error">{error}</div>}
        {!loading && !error && user && viewMode === "watchlist" && watchlist.size === 0 && (
          <div className="fb-wl-empty">
            <span>★</span>
            <p>{t("fundingBot2.wlEmpty")}<br />{t("fundingBot2.wlEmptyHint")}</p>
          </div>
        )}
        {!loading && !error && !(user && viewMode === "watchlist" && watchlist.size === 0) && (
          <div className="fb-table-scroll">
            <table className="fb-table">
              <thead>
                <tr>
                  <th className="fb-col-star"></th>
                  <th>{t("fundingBot.colCoin")}</th>
                  <th title={t("fundingBot2.avgRateTip")}>{t("fundingBot2.avgRate")}</th>
                  <th className="fb-col-bar">{t("fundingBot.colBar")}</th>
                  {FUNDING_EXCHANGES.map(ex => <th key={ex} className="fb-col-ex">{ex}</th>)}
                  <th className="fb-col-ex" title={t("fundingBot2.spreadTip")}>{t("fundingBot2.spread")}</th>
                  <th>{t("fundingBot.colSignal")}</th>
                  <th>{t("fundingBot.colNext")}</th>
                  <th>{t("fundingBot.colPrice")}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(row => {
                  const sig        = getSignal(row.fundingRate, t);
                  const isSelected = row.symbol === selectedCoin;
                  const barPct     = Math.min(Math.abs(row.fundingRate) / maxAbsRate, 1) * 100;
                  const positive   = row.fundingRate >= 0;

                  return (
                    <tr
                      key={row.symbol}
                      className={`fb-row${isSelected ? " fb-row--selected" : ""}`}
                      onClick={() => setSelectedCoin(row.symbol)}
                      onMouseEnter={e => { if (user) setHoveredTip({ tip: getTip(row.fundingRate, row.symbol, t), x: e.clientX, y: e.clientY }); }}
                      onMouseMove={e  => setHoveredTip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null)}
                      onMouseLeave={() => setHoveredTip(null)}
                    >
                      {/* Star */}
                      <td className="fb-td-star">
                        <button
                          className={`fb-star-btn${user && watchlist.has(row.symbol) ? " fb-star-btn--on" : ""}`}
                          onClick={e => toggleWatch(row.symbol, e)}
                          title={!user ? t("fundingBot2.starSignIn") : watchlist.has(row.symbol) ? t("fundingBot2.removeWatch") : t("fundingBot2.addWatch")}
                        >★</button>
                      </td>

                      {/* Coin */}
                      <td className="fb-td-coin">
                        <span className="fb-coin-sym">{row.symbol}</span>
                        <span className="fb-coin-pair">{t("fundingBot.usdtPerp")}</span>
                      </td>

                      {/* Funding Rate */}
                      <td className={`fb-td-rate ${positive ? "fb-rate--pos" : "fb-rate--neg"}`}>
                        {positive ? "+" : ""}{fmtRate(row.fundingRate)}
                      </td>

                      {/* Rate Bar */}
                      <td className="fb-td-bar">
                        <div className="fb-bar-track">
                          <div className="fb-bar-center" />
                          <div
                            className={`fb-bar-fill ${positive ? "fb-bar--pos" : "fb-bar--neg"}`}
                            style={{
                              width:  `${barPct / 2}%`,
                              left:   positive ? "50%" : `${50 - barPct / 2}%`,
                            }}
                          />
                        </div>
                      </td>

                      {/* Each exchange's own rate ("—" = not listed there). */}
                      {FUNDING_EXCHANGES.map(ex => {
                        const r = row.rates[ex];
                        return (
                          <td key={ex} className={`fb-td-ex${r == null ? "" : r >= 0 ? " fb-rate--pos" : " fb-rate--neg"}`}>
                            {r == null ? "—" : `${r >= 0 ? "+" : ""}${fmtRate(r)}`}
                          </td>
                        );
                      })}

                      {/* Spread: highest − lowest rate; ≥ 0.01% stands out. */}
                      <td className={`fb-td-ex fb-td-spread${row.spread != null && row.spread >= 0.0001 ? " fb-td-spread--hot" : ""}`}>
                        {row.spread == null ? "—" : fmtRate(row.spread)}
                      </td>

                      {/* Signal */}
                      <td className="fb-td-signal">
                        {user
                          ? <span className={`fb-signal-badge ${sig.colorClass}`}>{sig.label}</span>
                          : <SignalLock onClick={askSignIn} />}
                      </td>

                      {/* Next Funding */}
                      <td className="fb-td-next">{timeUntil(row.nextFundingTime, t("fundingBot2.now"))}</td>

                      {/* Mark Price */}
                      <td className="fb-td-price">{fmtPrice(row.markPrice)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Pagination ───────────────────────────────────────────────────────── */}
        {totalPages > 1 && (
          <div className="fb-pagination">
            <button className="fb-page-btn" onClick={() => setPage(0)} disabled={page === 0}>«</button>
            <button className="fb-page-btn" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>‹</button>
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                className={`fb-page-btn${page === i ? " fb-page-btn--active" : ""}`}
                onClick={() => setPage(i)}
              >
                {i + 1}
              </button>
            ))}
            <button className="fb-page-btn" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page === totalPages - 1}>›</button>
            <button className="fb-page-btn" onClick={() => setPage(totalPages - 1)} disabled={page === totalPages - 1}>»</button>
            <span className="fb-page-info">{t("fundingBot2.pageInfo", { from: page * PAGE_SIZE + 1, to: Math.min((page + 1) * PAGE_SIZE, rows.length), total: rows.length })}</span>
          </div>
        )}
      </div>

      {/* ── Selected coin detail ─────────────────────────────────────────────── */}
      {selectedRow && selectedSignal && (
        <div className="fb-detail">

          {/* Detail header */}
          <div className="fb-detail-header">
            <div className="fb-detail-coin">
              <span className="fb-detail-sym">{selectedRow.symbol}</span>
              <span className="fb-detail-pair">{t("fundingBot.usdtPerpetual")}</span>
            </div>
            <div className="fb-detail-stats">
              <div className="fb-detail-stat">
                <span className="fb-stat-label">{t("fundingBot.currentRate")}</span>
                <span className={`fb-stat-value ${selectedRow.fundingRate >= 0 ? "fb-rate--pos" : "fb-rate--neg"}`}>
                  {selectedRow.fundingRate >= 0 ? "+" : ""}{fmtRate(selectedRow.fundingRate)}
                </span>
              </div>
              <div className="fb-detail-stat">
                <span className="fb-stat-label">{t("fundingBot.markPrice")}</span>
                <span className="fb-stat-value">{fmtPrice(selectedRow.markPrice)}</span>
              </div>
              <div className="fb-detail-stat">
                <span className="fb-stat-label">{t("fundingBot.signal")}</span>
                {user
                  ? <span className={`fb-signal-badge fb-signal-badge--lg ${selectedSignal.colorClass}`}>{selectedSignal.label}</span>
                  : <SignalLock onClick={askSignIn} />}
              </div>
            </div>
          </div>

          {/* Funding history mini chart */}
          <div className="fb-history-section">
            <div className="fb-history-title">{t("fundingBot.historyTitle")}</div>
            {histLoading && <div className="fb-history-loading">{t("fundingBot2.loadingHistory")}</div>}
            {!histLoading && history.length > 0 && (() => {
              const rates    = history.map(h => parseFloat(h.fundingRate));
              const maxAbs   = Math.max(...rates.map(Math.abs), 0.0001);
              const BAR_MAX  = 48; // max px height for bars

              return (
                <div className="fb-hist-chart">
                  {rates.map((r, i) => {
                    const pct     = Math.abs(r) / maxAbs;
                    const barH    = Math.max(2, Math.round(pct * BAR_MAX));
                    const pos     = r >= 0;
                    const d       = new Date(history[i].fundingTime);
                    const label   = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:00`;

                    return (
                      <div key={i} className="fb-hist-col" title={`${label}\n${fmtRate(r)}`}>
                        <div className="fb-hist-bar-wrap">
                          <div
                            className={`fb-hist-bar ${pos ? "fb-hist-bar--pos" : "fb-hist-bar--neg"}`}
                            style={{ height: `${barH}px` }}
                          />
                        </div>
                        <div className="fb-hist-label">{String(d.getHours()).padStart(2, "0")}h</div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {!histLoading && history.length === 0 && (
              <div className="fb-history-loading">{t("fundingBot2.noHistory")}</div>
            )}
          </div>

          {/* Funding Insight — pure data, no AI */}
          {user
            ? <FundingInsight row={selectedRow} signal={selectedSignal} history={history} />
            : <LockCard plan="free" featureName={t("fundingBot2.insightLockName")}
                description={t("fundingBot2.insightLockDesc")}
                onOpenAuth={onOpenAuth} className="fb-insight-lock" />}

        </div>
      )}

    </div>
  );
};
