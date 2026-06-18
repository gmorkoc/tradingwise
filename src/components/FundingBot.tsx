import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import "../styles/FundingBot.css";

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
  fundingRate: number;
  nextFundingTime: number;
}

interface Props {
  coin: string;
  theme: string;
  onOpenAuth: () => void;
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

function timeUntil(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "Now";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ── Pure-data funding insight ───────────────────────────────────────────────── */

function FundingInsight({ row, signal, history }: { row: CoinRow; signal: Signal; history: FundingRateEntry[] }) {
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
    ? `Longs are paying shorts ${fmtRate(rate)} every 8h (${annual}% annualized).`
    : `Shorts are paying longs ${fmtRate(absRate)} every 8h (${annual}% annualized).`;

  const crowding = isPos
    ? rate >= 0.0005
      ? "Market is heavily long — longs are overcrowded and paying a high premium to stay in."
      : "More longs than shorts — mild long bias in perpetuals."
    : absRate >= 0.0005
      ? "Market is heavily short — shorts are overcrowded and paying a high premium to stay in."
      : "More shorts than longs — mild short bias in perpetuals.";

  const trendLine = trend === "rising"
    ? `Funding has been rising over the last ${rates.length} periods — pressure is building${isPos ? " on longs" : " on shorts"}.`
    : trend === "falling"
      ? `Funding has been falling — ${isPos ? "long crowding is easing" : "short pressure is easing"}.`
      : "Funding has been stable — no major positioning shift recently.";

  const implication = isPos
    ? rate >= 0.0005
      ? "High positive funding often precedes a flush — watch for a long squeeze if price drops."
      : "Mildly positive — holding shorts here earns funding; not extreme enough to call a squeeze."
    : absRate >= 0.0005
      ? "High negative funding often precedes a short squeeze — watch for a sharp move up."
      : "Mildly negative — holding longs here earns funding; positioning not extreme.";

  const rows2: { label: string; value: string; color?: string }[] = [
    { label: "Who pays",    value: whoPayWho },
    { label: "Positioning", value: crowding },
    { label: "Trend",       value: trendLine },
    { label: "Implication", value: implication },
  ];

  return (
    <div className="fb-insight">
      <div className="fb-insight-header">
        <span className="fb-insight-title">Funding Insight</span>
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
export const FundingBot: React.FC<Props> = ({ coin }) => {
  const { t } = useTranslation();
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
      const [fundingResults, markResults] = await Promise.all([
        Promise.all(
          TOP_COINS.map(sym =>
            fetch(`/okx-api/api/v5/public/funding-rate?instId=${sym}-USDT-SWAP`)
              .then(r => r.json())
              .then(d => ({ sym, data: (d.data?.[0] ?? null) as OkxFundingRate | null }))
              .catch(() => ({ sym, data: null }))
          )
        ),
        Promise.all(
          TOP_COINS.map(sym =>
            fetch(`/okx-api/api/v5/public/mark-price?instId=${sym}-USDT-SWAP`)
              .then(r => r.json())
              .then(d => ({ sym, markPx: d.data?.[0]?.markPx ?? "0" }))
              .catch(() => ({ sym, markPx: "0" }))
          )
        ),
      ]);

      const markMap = Object.fromEntries(markResults.map(m => [m.sym, m.markPx]));

      const filtered = fundingResults
        .filter(r => r.data !== null)
        .map(({ sym, data }) => ({
          symbol:          sym,
          fullSymbol:      `${sym}USDT`,
          markPrice:       parseFloat(markMap[sym] ?? "0"),
          fundingRate:     parseFloat(data!.fundingRate),
          nextFundingTime: parseInt(data!.nextFundingTime),
        } satisfies CoinRow));

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
        `/okx-api/api/v5/public/funding-rate-history?instId=${sym}-USDT-SWAP&limit=10`
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
      if (row) setCountdown(timeUntil(row.nextFundingTime));
    };
    updateCountdown();
    countdownTimerRef.current = setInterval(updateCountdown, 1000);
    return () => { if (countdownTimerRef.current) clearInterval(countdownTimerRef.current); };
  }, [rows, selectedCoin]);

  const toggleWatch = (sym: string, e: React.MouseEvent) => {
    e.stopPropagation();
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
  const visibleRows    = viewMode === "watchlist" ? rows.filter(r => watchlist.has(r.symbol)) : rows;
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
            <span className="fb-countdown" title="Next funding payment">
              {t("fundingBot.nextFunding")} <strong>{countdown}</strong>
            </span>
          )}
          <button className="fb-refresh-btn" onClick={fetchScanner} title="Refresh now">{t("fundingBot.refresh")}</button>
        </div>
      </div>

      {/* ── Scanner table ────────────────────────────────────────────────────── */}
      <div className="fb-scanner-wrap">
        <div className="fb-scanner-topbar">
          <div className="fb-scanner-title">{t("fundingBot.scanner")}</div>
          <div className="fb-view-tabs">
            <button className={`fb-view-tab${viewMode === "all" ? " fb-view-tab--active" : ""}`} onClick={() => { setViewMode("all"); setPage(0); }}>All</button>
            <button className={`fb-view-tab${viewMode === "watchlist" ? " fb-view-tab--active" : ""}`} onClick={() => { setViewMode("watchlist"); setPage(0); }}>
              ★ Watchlist {watchlist.size > 0 && <span className="fb-wl-count">{watchlist.size}</span>}
            </button>
          </div>
        </div>
        {loading && <div className="fb-loading">{t("fundingBot.loading")}</div>}
        {error && <div className="fb-error">{error}</div>}
        {!loading && !error && viewMode === "watchlist" && watchlist.size === 0 && (
          <div className="fb-wl-empty">
            <span>★</span>
            <p>No coins in your watchlist yet.<br />Click the star on any row to add it.</p>
          </div>
        )}
        {!loading && !error && !(viewMode === "watchlist" && watchlist.size === 0) && (
          <div className="fb-table-scroll">
            <table className="fb-table">
              <thead>
                <tr>
                  <th className="fb-col-star"></th>
                  <th>{t("fundingBot.colCoin")}</th>
                  <th>{t("fundingBot.colRate")}</th>
                  <th className="fb-col-bar">{t("fundingBot.colBar")}</th>
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
                      onMouseEnter={e => setHoveredTip({ tip: getTip(row.fundingRate, row.symbol, t), x: e.clientX, y: e.clientY })}
                      onMouseMove={e  => setHoveredTip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : null)}
                      onMouseLeave={() => setHoveredTip(null)}
                    >
                      {/* Star */}
                      <td className="fb-td-star">
                        <button
                          className={`fb-star-btn${watchlist.has(row.symbol) ? " fb-star-btn--on" : ""}`}
                          onClick={e => toggleWatch(row.symbol, e)}
                          title={watchlist.has(row.symbol) ? "Remove from watchlist" : "Add to watchlist"}
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

                      {/* Signal */}
                      <td className="fb-td-signal">
                        <span className={`fb-signal-badge ${sig.colorClass}`}>{sig.label}</span>
                      </td>

                      {/* Next Funding */}
                      <td className="fb-td-next">{timeUntil(row.nextFundingTime)}</td>

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
            <span className="fb-page-info">{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, rows.length)} of {rows.length}</span>
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
                <span className={`fb-signal-badge fb-signal-badge--lg ${selectedSignal.colorClass}`}>
                  {selectedSignal.label}
                </span>
              </div>
            </div>
          </div>

          {/* Funding history mini chart */}
          <div className="fb-history-section">
            <div className="fb-history-title">{t("fundingBot.historyTitle")}</div>
            {histLoading && <div className="fb-history-loading">Loading history…</div>}
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
              <div className="fb-history-loading">No history data</div>
            )}
          </div>

          {/* Funding Insight — pure data, no AI */}
          <FundingInsight row={selectedRow} signal={selectedSignal} history={history} />

        </div>
      )}

    </div>
  );
};
