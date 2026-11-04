// Desktop #trade: ProVision Signal Check as a small frosted card on the
// chart itself (top-left), instead of a stacked panel under the chart.
// Expanded: score + verdict, the 7 indicator rows as mini bars, order flow
// and the timeframe reads. Collapsed: one pill ("∿ 21 · Bearish").
import { useEffect, useRef, useState } from "react";
import type { PvResult } from "../services/proVision";
import "../styles/ProVisionHud.css";

type Bias = "bull" | "bear" | "neutral";

interface Props {
  result: PvResult;
  mtf: { label: string; bias: Bias | null }[];
  /** Index into the 7 rows (MA, DMI, Ichimoku, RSI, Stochastic, MACD, Volume). */
  onRow: (r: number) => void;
  /** e.g. "1d 5h" while on the free trial. */
  trialLeft?: string | null;
  onKeep?: () => void;
  onHowTo?: () => void;
  /** One short heads-up (upcoming event, sideways market, short timeframe). */
  notice?: { icon: string; text: string; hot?: boolean } | null;
  /** "bar" = the desktop strip above the chart; "card" = stacked, for the
   *  phone Consensus sheet (no minimise). */
  layout?: "bar" | "card";
}

const ROWS = ["MA", "DMI", "Ichimoku", "RSI", "Stoch", "MACD", "Volume"];
const SEG = 5;

export function ProVisionHud({ result, mtf, onRow, trialLeft, onKeep, onHowTo, notice, layout = "bar" }: Props) {
  const card = layout === "card";
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("pvHudOpen") !== "0"; } catch { return true; }
  });
  const toggle = (v: boolean) => {
    setOpen(v);
    try { localStorage.setItem("pvHudOpen", v ? "1" : "0"); } catch { /* ignore */ }
  };
  // Mouse wheel scrolls line 1 sideways (desktop mice only scroll
  // vertically) while it has more to show. Native listener: React's wheel
  // handler is passive and can't stop the page scrolling.
  const lineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = lineRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      const next = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
      if (next === el.scrollLeft) return;
      el.scrollLeft = next;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);
  const vb = result.verdict.bias as Bias;
  const word = vb === "bull" ? "Bullish" : vb === "bear" ? "Bearish" : "Mixed";
  const buy = result.volume.buyPct;
  const sell = result.volume.sellPct;

  if (!open && !card) {
    // Minimised: the same slim strip, just title + score + verdict, with a
    // chevron to expand it again.
    return (
      <div className={`pvh-shell pvh--${vb}`}>
        <button type="button" className="pvh-close pvh-close--shell" onClick={() => toggle(true)} aria-label="Show Signal Check details">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div className={`pvh pvh--bar pvh--${vb}`} role="group" aria-label="ProVision Signal Check">
          <div className="pvh-line">
            <div className="pvh-head">
              <span className="pvh-icon" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
              </span>
              <span className="pvh-title">Signal Check</span>
              <b className="pvh-score">{result.bullStrength}<span>/100</span></b>
            </div>
            <div className="pvh-verdict">
              <span className="pvh-dot" aria-hidden="true" />
              {word} · {result.verdict.agree} of {result.verdict.total}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`pvh-shell pvh--${vb}${card ? " pvh-shell--card" : ""}`}>
    {/* Minimise stays put at the right while the line scrolls. */}
    {!card && (
      <button type="button" className="pvh-close pvh-close--shell" onClick={() => toggle(false)} aria-label="Minimise Signal Check">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
    )}
    <div className={`pvh ${card ? "pvh--card" : "pvh--bar"} pvh--${vb}`} role="group" aria-label="ProVision Signal Check">
      <div className="pvh-line" ref={lineRef}>
      <div className="pvh-head">
        <span className="pvh-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
        </span>
        <span className="pvh-title">Signal Check</span>
        <b className="pvh-score">{result.bullStrength}<span>/100</span></b>
      </div>
      <div className="pvh-verdict">
        <span className="pvh-dot" aria-hidden="true" />
        {word} · {result.verdict.agree} of {result.verdict.total}
      </div>
      <div className="pvh-rows">
        {ROWS.map((name, r) => {
          const b = (result.checks[r] ?? "neutral") as Bias;
          const s = result.checkStrength[r] ?? 0.5;
          const lit = b === "neutral" ? 0 : Math.max(1, Math.round(Math.abs((s - 0.5) * 2) * SEG));
          const label = r === 3 && result.checkReadout[3]?.big ? `RSI ${result.checkReadout[3].big}` : name;
          return (
            <button key={name} type="button" className={`pvh-row pvh-row--${b}`} onClick={() => onRow(r)} title={`${label}: ${b === "bull" ? "bullish" : b === "bear" ? "bearish" : "neutral"}`}>
              <span className="pvh-row-name">{label}</span>
              <span className="pvh-bar" aria-hidden="true" style={{ ["--row" as string]: r }}>
                {Array.from({ length: SEG }, (_, i) => (
                  <i
                    key={`${i}:${lit}:${b}`}
                    className={i < lit ? (i === lit - 1 ? "on tip" : "on") : ""}
                    style={{ ["--k" as string]: i }}
                  />
                ))}
              </span>
              <span className="pvh-arrow" aria-hidden="true">{b === "bull" ? "▲" : b === "bear" ? "▼" : "–"}</span>
            </button>
          );
        })}
      </div>
      </div>
      <div className="pvh-line pvh-line--2">
      {/* Card layout only: section header, matching "Track record". */}
      <div className="pvh-sec-head">
        <span>Buyers vs sellers</span>
        <span className="pvh-track-n">last 20 candles</span>
      </div>
      <div className="pvh-flow" title="Order flow, last 20 candles">
        <span className="pvh-flow-bar" aria-hidden="true"><i style={{ width: `${buy}%` }} /></span>
        <span className="pvh-flow-txt">{buy >= sell ? `Buyers ${buy}%` : `Sellers ${sell}%`}</span>
      </div>
      {mtf.length > 0 && (
        <div className="pvh-tf" aria-label="Timeframes">
          {mtf.map((m) => (
            <span key={m.label} className={`pvh-tf-item pvh-tf--${m.bias ?? "none"}`} title={`${m.label}: ${m.bias === "bull" ? "bullish" : m.bias === "bear" ? "bearish" : m.bias ? "mixed" : "loading"}`}>
              <i aria-hidden="true" />{m.label}
            </span>
          ))}
        </div>
      )}
      </div>
      <div className="pvh-line pvh-line--2 pvh-line--3">
      {/* Track record: every past signal on this chart, scored after fees. */}
      {(() => {
        const st = result.stats;
        const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
        return (
          <div className="pvh-track" aria-label="Track record">
            <div className="pvh-track-head">
              <span>Track record</span>
              <span className="pvh-track-n">{st.total} signal{st.total === 1 ? "" : "s"}</span>
            </div>
            <div className="pvh-track-grid">
              <span><em>Hit rate</em><b>{st.winRate === null ? "—" : `${st.winRate}%`}</b></span>
              <span><em>Won / lost</em><b><i className="pvh-up">{st.worked}</i> / <i className="pvh-dn">{st.failed}</i></b></span>
              <span><em>Avg win</em><b className="pvh-up">{pct(st.avgWinPct)}</b></span>
              <span><em>Avg loss</em><b className="pvh-dn">{pct(st.avgLossPct)}</b></span>
            </div>
          </div>
        );
      })()}
      {notice && (
        <div className={`pvh-notice${notice.hot ? " pvh-notice--hot" : ""}`} role="status">
          <span aria-hidden="true">{notice.icon}</span>{notice.text}
        </div>
      )}
      {(trialLeft || onHowTo) && (
        <div className="pvh-foot">
          {onHowTo && (
            <button type="button" className="pvh-link pvh-link--how" onClick={onHowTo}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
              How it works
            </button>
          )}
          {trialLeft && onKeep && <button type="button" className="pvh-link pvh-link--keep" onClick={onKeep}>Enjoying? Keep it · {trialLeft} left ›</button>}
        </div>
      )}
      </div>
    </div>
    </div>
  );
}
