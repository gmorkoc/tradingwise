import { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { supabase, hasAccess, toggleMutedSignalCoin } from "../services/supabase";
import { useAuth } from "../contexts/AuthContext";
import "../styles/BuySignals.css";

interface SignalHit { id: string; label: string; value: number }

type Direction = "buy" | "sell";

interface BuySignalRow {
  coin: string;
  direction: Direction;
  score: number;
  max_score: number;
  signals: SignalHit[];
  price: number;
  rsi: number | null;
  bb_pct: number | null;
  move_pct: number | null;
  vol_ratio: number | null;
  macd_hist: number | null;
  sma_ratio: number | null;
  funding_rate: number | null;
  long_short_ratio: number | null;
  is_active: boolean;
  scanned_at: string;
}

function confidenceOf(row: BuySignalRow): "low" | "medium" | "high" {
  if (row.score >= 6) return "high";
  if (row.score >= 5) return "medium";
  return "low";
}

// Mirrors supabase/functions/buy-signal-scan/index.ts exactly, for both
// directions — the edge function only stores the signals that DID trigger
// (in `signals`), but the raw values are stored either way, so the full
// checklist — triggered AND not-yet-triggered — is reconstructable
// client-side from those, no extra column needed.
const SIGNAL_DEFS: {
  id: string;
  label: (row: BuySignalRow) => string;
  hit: (row: BuySignalRow) => boolean | null; // null = not enough data
}[] = [
  {
    id: "rsi",
    label: (r) => r.rsi != null ? `RSI(14) ${r.direction === "buy" ? "oversold" : "overbought"} — ${r.rsi.toFixed(1)}` : `RSI(14) ${r.direction === "buy" ? "oversold" : "overbought"}`,
    hit: (r) => r.rsi == null ? null : (r.direction === "buy" ? r.rsi < 30 : r.rsi > 70),
  },
  {
    id: "bb",
    label: (r) => `At/${r.direction === "buy" ? "below lower" : "above upper"} Bollinger Band`,
    hit: (r) => r.bb_pct == null ? null : (r.direction === "buy" ? r.bb_pct <= 0 : r.bb_pct >= 1),
  },
  {
    id: "move",
    label: (r) => r.move_pct != null ? `${r.direction === "buy" ? "Down" : "Up"} ${Math.abs(r.move_pct).toFixed(1)}% over 48h (2x+ ATR)` : `${r.direction === "buy" ? "Down" : "Up"} sharply over 48h (2x+ ATR)`,
    hit: (r) => r.move_pct == null ? null : (r.direction === "buy" ? r.move_pct < 0 : r.move_pct > 0), // sign check only — exact ATR threshold isn't stored, this reflects direction of the qualifying move
  },
  {
    id: "volume",
    label: (r) => r.vol_ratio != null ? `Volume ${r.vol_ratio.toFixed(1)}x 20-period avg` : "Elevated volume vs 20-period avg",
    hit: (r) => r.vol_ratio == null ? null : r.vol_ratio > 1.3,
  },
  {
    id: "macd",
    label: (r) => `MACD ${r.direction === "buy" ? "bullish" : "bearish"} cross`,
    hit: (r) => r.macd_hist == null ? null : (r.direction === "buy" ? r.macd_hist > 0 : r.macd_hist < 0),
  },
  {
    id: "trend",
    label: (r) => `${r.direction === "buy" ? "Above" : "Below"} 200-period trend average`,
    hit: (r) => r.sma_ratio == null ? null : (r.direction === "buy" ? r.sma_ratio > 1 : r.sma_ratio < 1),
  },
  {
    id: "positioning",
    label: (r) => r.direction === "buy" ? "Crowded short positioning" : "Crowded long positioning",
    hit: (r) => {
      if (r.funding_rate == null && r.long_short_ratio == null) return null;
      if (r.direction === "buy") {
        return (r.funding_rate != null && r.funding_rate <= -0.0005) || (r.long_short_ratio != null && r.long_short_ratio <= 0.6);
      }
      return (r.funding_rate != null && r.funding_rate >= 0.0005) || (r.long_short_ratio != null && r.long_short_ratio >= 2.5);
    },
  },
];

const COIN_COLORS: Record<string, string> = {
  BTC: "#f7931a", ETH: "#627eea", SOL: "#9945ff", BNB: "#f3ba2f", XRP: "#23292f",
  ADA: "#0033ad", DOGE: "#c2a633", SUI: "#4da2ff",
};

interface Props { onOpenUpgrade: () => void }

export function BuySignals({ onOpenUpgrade }: Props) {
  const { t } = useTranslation();
  const { tier, user, profile, refreshProfile } = useAuth();
  const isElite = hasAccess(tier, "elite");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BuySignalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlightCoin, setHighlightCoin] = useState<string | null>(null);
  const [mutingCoin, setMutingCoin] = useState<string | null>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const fetchSignals = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("buy_signals")
      .select("*")
      .eq("is_active", true)
      .order("score", { ascending: false });
    if (!error && data) setRows(data as BuySignalRow[]);
    setLoading(false);
  };

  // Fetch once on mount (so the trigger button's count badge is right even
  // before anyone opens it) and again every time it's opened, since the
  // scan itself only refreshes every 4h — no need to poll while closed.
  // Elite-only: buy_signals rows are readable by any authenticated user
  // (RLS), so without this gate a free/pro user would still see the bell's
  // count badge (a "there are N signals" teaser) despite the panel itself
  // being upgrade-walled — this keeps the feature invisible below elite.
  useEffect(() => { if (isElite) fetchSignals(); }, [isElite]);
  useEffect(() => { if (open && isElite) fetchSignals(); }, [open, isElite]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Tapping the in-app toast (useBuySignalRealtime.ts / PushToast.tsx)
  // opens this panel directly, same convention as the coin-mention/
  // strategy-alert tap routing — and now carries which coin the toast was
  // actually about, so opening from a specific alert scrolls to and
  // highlights that card instead of just landing on the top of the list.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ coin?: string }>).detail;
      setHighlightCoin(detail?.coin ?? null);
      setOpen(true);
    };
    window.addEventListener("open-buy-signals", onOpen);
    return () => window.removeEventListener("open-buy-signals", onOpen);
  }, []);

  // Scroll to + highlight the coin the toast was about, once its card has
  // actually rendered (rows load async after the panel opens). Clears
  // after a few seconds so the glow reads as "here it is," not a
  // permanent state.
  useEffect(() => {
    if (!open || !highlightCoin) return;
    const el = cardRefs.current[highlightCoin];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setHighlightCoin(null), 3000);
    return () => clearTimeout(timer);
  }, [open, rows, highlightCoin]);

  const handleClick = () => {
    if (!isElite) { onOpenUpgrade(); return; }
    setHighlightCoin(null); // opening via the bell, not a specific toast — no stale target from last time
    setOpen((v) => !v);
  };

  const handleMute = async (coin: string) => {
    if (!user || mutingCoin) return;
    setMutingCoin(coin);
    try {
      await toggleMutedSignalCoin(user.id, coin, profile?.signal_muted_coins ?? []);
      await refreshProfile();
    } catch (err) {
      console.error("Failed to update muted signal coins:", err);
    } finally {
      setMutingCoin(null);
    }
  };

  const mutedCoins = profile?.signal_muted_coins ?? [];

  return (
    <>
      <button
        ref={bellRef}
        className={`buysig-bell${rows.length > 0 ? " buysig-bell--active" : ""}`}
        onClick={handleClick}
        title={t("buySignals.title", "Buy & Sell Signals")}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M15 7h6v6" />
        </svg>
        {rows.length > 0 && <span className="buysig-bell-count">{rows.length}</span>}
      </button>

      {ReactDOM.createPortal(
        <>
          {open && (
            <>
              <div className="buysig-backdrop" onClick={() => setOpen(false)} />
              <div className="buysig-panel">
                <div className="buysig-panel-header">
                  <div>
                    <span className="buysig-panel-title">{t("buySignals.title", "Buy & Sell Signals")}</span>
                    <span className="buysig-panel-sub">{t("buySignals.subtitle", "4h technical confluence scan")}</span>
                  </div>
                  <button className="buysig-panel-close" onClick={() => setOpen(false)}>✕</button>
                </div>

                <div className="buysig-list">
                  {loading && rows.length === 0 && (
                    <p className="buysig-empty">{t("buySignals.loading", "Scanning…")}</p>
                  )}
                  {!loading && rows.length === 0 && (
                    <p className="buysig-empty">{t("buySignals.empty", "No coins are currently in a buy or sell zone. Check back after the next scan.")}</p>
                  )}
                  {rows.map((row) => {
                    const confidence = confidenceOf(row);
                    const isMuted = mutedCoins.includes(row.coin);
                    return (
                      <div
                        key={`${row.coin}-${row.direction}`}
                        ref={(el) => { cardRefs.current[row.coin] = el; }}
                        className={`buysig-card buysig-card--${row.direction}${highlightCoin === row.coin ? " buysig-card--highlight" : ""}`}
                      >
                        <div className="buysig-card-head">
                          <div className="buysig-card-icon" style={{ background: COIN_COLORS[row.coin] ?? "#7c8ba8" }}>
                            {row.coin[0]}
                          </div>
                          <div className="buysig-card-name">
                            <span className={`buysig-card-direction buysig-card-direction--${row.direction}`}>
                              {row.direction === "buy" ? t("buySignals.buy", "BUY") : t("buySignals.sell", "SELL")}
                            </span>
                            <span className="buysig-card-coin">
                              {row.coin} / USD
                              <span className="buysig-card-price">
                                ${row.price.toLocaleString(undefined, { maximumFractionDigits: row.price < 1 ? 6 : 2 })}
                              </span>
                            </span>
                          </div>
                          {/* Confidence is confluence strength, not a probability —
                              we've never backtested this, so it labels how many of
                              the 7 conditions agree, not "how likely this is right." */}
                          <div className="buysig-card-score">
                            <span className="buysig-card-score-frac">{row.score}/{row.max_score}</span>
                            <span className={`buysig-card-confidence buysig-card-confidence--${confidence}`}>
                              {confidence === "high" ? t("buySignals.high", "High") : confidence === "medium" ? t("buySignals.medium", "Medium") : t("buySignals.low", "Low")}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={`buysig-card-mute${isMuted ? " buysig-card-mute--active" : ""}`}
                            onClick={() => handleMute(row.coin)}
                            disabled={mutingCoin === row.coin}
                            title={isMuted ? t("buySignals.unmute", "Unmute {{coin}}", { coin: row.coin }) : t("buySignals.mute", "Mute {{coin}}", { coin: row.coin })}
                          >
                            {isMuted ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07" /></svg>
                            )}
                          </button>
                        </div>
                        <div className="buysig-card-checks">
                          {SIGNAL_DEFS.map((def) => {
                            const hit = def.hit(row);
                            return (
                              <div key={def.id} className={`buysig-check${hit ? " buysig-check--hit" : ""}`}>
                                {hit ? (
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                                ) : (
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="9" /></svg>
                                )}
                                <span>{def.label(row)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p className="buysig-disclaimer">
                  {t("buySignals.disclaimer", "Not a price prediction — a documented confluence of overbought/oversold/reversal-associated conditions. Actual prices can and do keep moving against the signal.")}
                </p>
              </div>
            </>
          )}
        </>,
        document.body
      )}
    </>
  );
}
