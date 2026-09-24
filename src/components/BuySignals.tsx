import { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "../services/supabase";
import { useAuth } from "../contexts/AuthContext";
import { hasAccess } from "../services/supabase";
import "../styles/BuySignals.css";

interface SignalHit { id: string; label: string; value: number }

interface BuySignalRow {
  coin: string;
  score: number;
  max_score: number;
  signals: SignalHit[];
  price: number;
  rsi: number | null;
  bb_pct: number | null;
  drawdown_pct: number | null;
  vol_ratio: number | null;
  is_active: boolean;
  scanned_at: string;
}

// Mirrors supabase/functions/buy-signal-scan/index.ts exactly — the edge
// function only stores the signals that DID trigger (in `signals`), but
// the raw values (rsi/bb_pct/drawdown_pct/vol_ratio) are stored either
// way, so the full checklist — triggered AND not-yet-triggered — is
// reconstructable client-side from those, no extra column needed.
const SIGNAL_DEFS: {
  id: string;
  label: (row: BuySignalRow) => string;
  hit: (row: BuySignalRow) => boolean | null; // null = not enough data
}[] = [
  {
    id: "rsi",
    label: (r) => r.rsi != null ? `RSI(14) oversold — ${r.rsi.toFixed(1)}` : "RSI(14) oversold",
    hit: (r) => r.rsi == null ? null : r.rsi < 30,
  },
  {
    id: "bb",
    label: () => "At/below lower Bollinger Band",
    hit: (r) => r.bb_pct == null ? null : r.bb_pct <= 0,
  },
  {
    id: "drawdown",
    label: (r) => r.drawdown_pct != null ? `Down ${Math.abs(r.drawdown_pct).toFixed(1)}% over 5 days` : "Down 8%+ over 5 days",
    hit: (r) => r.drawdown_pct == null ? null : r.drawdown_pct <= -8,
  },
  {
    id: "volume",
    label: (r) => r.vol_ratio != null ? `Volume ${r.vol_ratio.toFixed(1)}x 20d avg` : "Elevated volume vs 20d avg",
    hit: (r) => r.vol_ratio == null ? null : r.vol_ratio > 1.3,
  },
];

const COIN_COLORS: Record<string, string> = {
  BTC: "#f7931a", ETH: "#627eea", SOL: "#9945ff", BNB: "#f3ba2f", XRP: "#23292f",
  ADA: "#0033ad", DOGE: "#c2a633", SUI: "#4da2ff",
};

interface Props { onOpenUpgrade: () => void }

export function BuySignals({ onOpenUpgrade }: Props) {
  const { t } = useTranslation();
  const { tier } = useAuth();
  const isElite = hasAccess(tier, "elite");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BuySignalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);

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
  // scan itself only refreshes once daily — no need to poll while closed.
  useEffect(() => { fetchSignals(); }, []);
  useEffect(() => { if (open) fetchSignals(); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Tapping the in-app toast (useBuySignalRealtime.ts / PushToast.tsx)
  // opens this panel directly, same convention as the coin-mention/
  // strategy-alert tap routing.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("open-buy-signals", onOpen);
    return () => window.removeEventListener("open-buy-signals", onOpen);
  }, []);

  const handleClick = () => {
    if (!isElite) { onOpenUpgrade(); return; }
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={bellRef}
        className={`buysig-bell${rows.length > 0 ? " buysig-bell--active" : ""}`}
        onClick={handleClick}
        title={t("buySignals.title", "Buy Signals")}
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
                    <span className="buysig-panel-title">{t("buySignals.title", "Buy Signals")}</span>
                    <span className="buysig-panel-sub">{t("buySignals.subtitle", "Daily technical confluence scan")}</span>
                  </div>
                  <button className="buysig-panel-close" onClick={() => setOpen(false)}>✕</button>
                </div>

                <div className="buysig-list">
                  {loading && rows.length === 0 && (
                    <p className="buysig-empty">{t("buySignals.loading", "Scanning…")}</p>
                  )}
                  {!loading && rows.length === 0 && (
                    <p className="buysig-empty">{t("buySignals.empty", "No coins are currently in a buy zone. Check back after the next daily scan.")}</p>
                  )}
                  {rows.map((row) => (
                    <div key={row.coin} className="buysig-card">
                      <div className="buysig-card-head">
                        <div className="buysig-card-icon" style={{ background: COIN_COLORS[row.coin] ?? "#7c8ba8" }}>
                          {row.coin[0]}
                        </div>
                        <div className="buysig-card-name">
                          <span className="buysig-card-coin">{row.coin} / USD</span>
                          <span className="buysig-card-price">
                            ${row.price.toLocaleString(undefined, { maximumFractionDigits: row.price < 1 ? 6 : 2 })}
                          </span>
                        </div>
                        <div className="buysig-card-score">
                          {row.score}/{row.max_score}
                        </div>
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
                  ))}
                </div>

                <p className="buysig-disclaimer">
                  {t("buySignals.disclaimer", "Not a price prediction — a documented confluence of oversold/reversal-associated conditions. Actual prices can and do keep falling.")}
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
